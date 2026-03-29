// Swayambhu — Reflection Policy
// Session reflect, deep reflect (recursive, depth-aware), scheduling, default prompts.
// Mutable — the agent can propose changes to this file via the proposal system.
//
// Receives K (kernel interface) for all kernel interactions.
// getMaxSteps and getReflectModel live on K (kernel utility methods).

// Proposal system methods are on K (kernel interface):
// K.createProposal, K.loadProposals, K.processProposalVerdicts

// ── Wisdom manifest ─────────────────────────────────────────

async function loadWisdomManifest(K) {
  const prajnaList = await K.kvList({ prefix: "prajna:", limit: 100 });
  const upayaList = await K.kvList({ prefix: "upaya:", limit: 100 });
  return {
    prajna: prajnaList.keys.map(k => ({ key: k.name, summary: k.metadata?.summary || k.name })),
    upaya: upayaList.keys.map(k => ({ key: k.name, summary: k.metadata?.summary || k.name })),
  };
}

// ── Session reflect ─────────────────────────────────────────

export async function executeReflect(K, state, step) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const reflectPrompt = await K.kvGet("prompt:reflect");
  const proposals = await K.loadProposals('proposed');

  const systemKeyPatterns = await K.getSystemKeyPatterns();
  const wisdom_manifest = await loadWisdomManifest(K);

  const sessionCounter = await K.getSessionCount();
  const systemPrompt = await K.buildPrompt(
    reflectPrompt || defaultReflectPrompt(),
    { systemKeyPatterns, wisdom_manifest, session_counter: sessionCounter }
  );

  const rawKarma = await K.getKarma();
  const sessionCost = await K.getSessionCost();

  // Strip bulky fields that repeat across turns — reflect needs events,
  // responses, and tool calls, not the full LLM request payloads.
  const karma = rawKarma.map(e => {
    if (e.event !== 'llm_call') return e;
    const { request, tools_available, ...rest } = e;
    return rest;
  });

  const initialContext = JSON.stringify({
    karma,
    sessionCost,
    proposals,
  });

  const model = await K.resolveModel(
    step.model || defaults?.reflect?.model
  );

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools: [],
    model,
    effort: step.effort || defaults?.reflect?.effort,
    maxTokens: step.max_output_tokens || defaults?.reflect?.max_output_tokens,
    maxSteps: 1,
    step: "reflect",
  });

  // Detect parse failure — preserve previous last_reflect state
  if (output.raw !== undefined) {
    const prevLastReflect = await K.kvGet("last_reflect");
    await K.kvWriteSafe("last_reflect", {
      ...prevLastReflect,
      _parse_error: {
        session_id: sessionId,
        depth: 0,
        raw_length: output.raw?.length,
      },
    });
    await K.kvWriteSafe(`reflect:0:${sessionId}`, {
      raw: output.raw,
      parse_error: true,
      depth: 0,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
    await K.karmaRecord({ event: "reflect_parse_error", depth: 0, raw_length: output.raw?.length });
    return;
  }

  // Carry forward vikalpas from previous deep reflect, apply any updates
  const prevLastReflect = await K.kvGet("last_reflect");
  let vikalpas = prevLastReflect?.vikalpas || [];
  if (output.vikalpa_updates) {
    const missed = [];
    for (const update of output.vikalpa_updates) {
      const existing = vikalpas.find(a => a.id === update.id);
      if (!existing) {
        missed.push(update);
        continue;
      }
      if (update.status === "resolved") {
        existing.status = "resolved";
        if (update.evidence) existing.evidence = update.evidence;
        existing.resolved_session = sessionId;
      } else if (update.status === "confirmed") {
        existing.revisit_by_session = update.revisit_by_session;
      }
    }
    if (missed.length) {
      await K.karmaRecord({ event: "vikalpa_updates_missed", missed });
    }
  }

  // Carry forward tasks, apply updates, append new tasks
  let tasks = prevLastReflect?.tasks || [];
  if (output.task_updates) {
    const missedTasks = [];
    for (const update of output.task_updates) {
      const existing = tasks.find(t => t.id === update.id);
      if (!existing) {
        missedTasks.push(update);
        continue;
      }
      if (update.status === "done") {
        existing.status = "done";
        if (update.result) existing.result = update.result;
        existing.done_session = sessionId;
      } else if (update.status === "dropped") {
        existing.status = "dropped";
        if (update.reason) existing.reason = update.reason;
      }
    }
    if (missedTasks.length) {
      await K.karmaRecord({ event: "task_updates_missed", missed: missedTasks });
    }
  }
  if (output.new_tasks) {
    for (const task of output.new_tasks) {
      tasks.push({ ...task, status: "pending" });
    }
  }

  await K.kvWriteSafe("last_reflect", {
    ...output,
    vikalpas,
    tasks,
    session_id: sessionId,
  });

  const sessionReflectRecord = {
    reflection: output.session_summary || output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 0,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  };
  if (output.proposal_observations) sessionReflectRecord.proposal_observations = output.proposal_observations;
  await K.kvWriteSafe(`reflect:0:${sessionId}`, sessionReflectRecord);

  if (output.kv_operations) {
    const blocked = [];
    for (const op of output.kv_operations) {
      const result = await K.kvWriteGated(op, "reflect");
      if (!result.ok) blocked.push({ key: op.key, error: result.error });
    }
    if (blocked.length) {
      await K.karmaRecord({ event: "kv_writes_blocked", blocked });
    }
  }

  if (output.proposal_verdicts) {
    await K.processProposalVerdicts(output.proposal_verdicts, 0);
  }

  if (output.proposal_requests) {
    for (const req of output.proposal_requests) {
      await K.createProposal(req, sessionId, 0);
    }
  }

  if (output.next_session_config) {
    const scheduleConf = { ...output.next_session_config };
    if (scheduleConf.interval_seconds) {
      scheduleConf.next_session_after = new Date(
        Date.now() + scheduleConf.interval_seconds * 1000
      ).toISOString();
    }
    await K.kvWriteSafe("session_schedule", scheduleConf);
  }
}

// ── Deep reflection (recursive, depth-aware) ────────────────

export async function runReflect(K, state, depth, context) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
  const belowPrompt = await loadBelowPrompt(K, depth);

  const systemPrompt = await K.buildPrompt(prompt, {
    depth,
    belowPrompt,
    ...initialCtx.templateVars,
  });

  // Reflect uses tools for investigation but NOT spawn_subplan
  const allTools = await K.buildToolDefinitions();
  const tools = allTools.filter(t => t.function.name !== 'spawn_subplan');

  const model = await K.resolveModel(await K.getReflectModel(state, depth));
  const maxSteps = await K.getMaxSteps(state, 'reflect', depth);

  // Deep reflect gets its own budget: max_cost * budget_multiplier
  const budget = defaults?.session_budget;
  const multiplier = defaults?.deep_reflect?.budget_multiplier || 1;
  const deepBudgetCap = (budget?.max_cost && multiplier > 1)
    ? budget.max_cost * multiplier
    : undefined;

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext: initialCtx.userMessage,
    tools,
    model,
    effort: defaults?.deep_reflect?.effort || 'high',
    maxTokens: defaults?.deep_reflect?.max_output_tokens || 4000,
    maxSteps,
    step: `reflect_depth_${depth}`,
    budgetCap: deepBudgetCap,
  });

  await applyReflectOutput(K, state, depth, output, context);

  // Cascade — run next depth down
  if (depth > 1) {
    await runReflect(K, state, depth - 1, context);
  }
}

export async function gatherReflectContext(K, state, depth, context) {
  const { defaults, modelsConfig } = state;

  const actPrompt = await K.kvGet("prompt:act");
  const proposals = await K.loadProposals();
  const systemKeyPatterns = await K.getSystemKeyPatterns();

  const recentSessionIds = await getRelevantSessionIds(K, depth);

  const patronId = await K.getPatronId();
  const patronContact = await K.getPatronContact();
  const patronIdentityDisputed = patronId ? await K.isPatronIdentityDisputed() : false;

  // Communication health — delivery failures and patterns
  const deadEvents = await K.kvList({ prefix: "event_dead:" });
  const communicationHealth = {
    delivery_failures: deadEvents.keys.length,
    dead_events: deadEvents.keys.map(k => k.name).slice(0, 10),
  };

  const templateVars = {
    actPrompt,
    currentDefaults: defaults,
    models: modelsConfig,
    proposals,
    patron_contact: patronContact ? JSON.stringify(patronContact, null, 2) : '(no patron configured)',
    patron_id: patronId || null,
    patron_identity_disputed: patronIdentityDisputed,
    systemKeyPatterns,
    recentSessionIds,
    communicationHealth: JSON.stringify(communicationHealth, null, 2),
    context: {
      orBalance: context?.balances?.providers?.openrouter?.balance ?? "unknown",
      walletBalance: context?.balances?.wallets?.base_usdc?.balance ?? 0,
      effort: context?.effort || defaults?.deep_reflect?.effort || "high",
      crashData: context?.crashData || "none",
    },
  };

  if (depth >= 1) {
    templateVars.belowOutputs = await loadReflectHistory(K, depth - 1, 10);

    // Session health summaries — surfaces problems DR would otherwise miss
    const healthKeys = recentSessionIds.map(id => `session_health:${id}`);
    const healthData = await K.loadKeys(healthKeys);
    // Enrich empty reflect records with health data
    if (templateVars.belowOutputs) {
      for (const [key, record] of Object.entries(templateVars.belowOutputs)) {
        if (record && !record.reflection && record.session_id) {
          const health = healthData[`session_health:${record.session_id}`];
          if (health) record._health = health;
        }
      }
    }
    // Filter to only sessions with problems (non-empty budget_exceeded, truncations, etc.)
    const problemSessions = {};
    for (const [key, health] of Object.entries(healthData)) {
      if (!health || health._truncated) continue;
      if (health.budget_exceeded || health.truncations || health.provider_fallbacks
          || health.tool_failures || health.parse_errors || !health.reflect_ran) {
        problemSessions[key] = health;
      }
    }
    if (Object.keys(problemSessions).length > 0) {
      templateVars.sessionHealth = problemSessions;
    }

    // Same-depth history — continuity for deep reflect
    const historyCount = state.defaults?.reflect_levels?.[depth]?.prior_reflections ?? 3;
    templateVars.priorReflections = await loadReflectHistory(K, depth, historyCount);
  }

  // Wisdom manifest — lazy loading for all depths
  templateVars.wisdom_manifest = await loadWisdomManifest(K);

  // Events — session requests and other signals since last session
  if (depth >= 1 && context?.events?.length) {
    templateVars.chatDigest = context.events.filter(i => i.type === 'session_request');
  }

  // Reflect schedule — so deep reflect knows when it last ran and when next is due
  if (depth >= 1) {
    const maxReflectDepth = defaults?.execution?.max_reflect_depth || 1;
    const sessionCount = await K.getSessionCount();
    const scheduleInfo = {};
    for (let d = 1; d <= maxReflectDepth; d++) {
      const sched = await K.kvGet(`reflect:schedule:${d}`);
      if (sched) {
        const interval = sched.after_sessions
          || defaults?.deep_reflect?.default_interval_sessions || 20;
        scheduleInfo[d] = {
          last_ran: sched.last_reflect_session || 0,
          next_due: (sched.last_reflect_session || 0) + interval,
        };
      }
    }
    if (Object.keys(scheduleInfo).length > 0) {
      templateVars.reflectSchedule = scheduleInfo;
    }
  }

  return { userMessage: "Begin.", templateVars };
}

export async function applyReflectOutput(K, state, depth, output, context) {
  const sessionId = await K.getSessionId();

  // 0. Detect parse failure — preserve previous last_reflect state
  if (output.raw !== undefined) {
    if (depth === 1) {
      const prevLastReflect = await K.kvGet("last_reflect");
      await K.kvWriteSafe("last_reflect", {
        ...prevLastReflect,
        _parse_error: {
          session_id: sessionId,
          depth,
          raw_length: output.raw?.length,
        },
      });
    }
    await K.kvWriteSafe(`reflect:${depth}:${sessionId}`, {
      raw: output.raw,
      parse_error: true,
      depth,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
    await K.karmaRecord({ event: "reflect_parse_error", depth, raw_length: output.raw?.length });
    // Still update the schedule so a failed DR doesn't immediately re-trigger
    if (depth >= 1) {
      const sessionCount = await K.getSessionCount();
      const prevSchedule = await K.kvGet(`reflect:schedule:${depth}`) || {};
      await K.kvWriteSafe(`reflect:schedule:${depth}`, {
        ...prevSchedule,
        last_reflect: new Date().toISOString(),
        last_reflect_session: sessionCount,
        last_reflect_session_id: sessionId,
      });
    }
    return;
  }

  // 1. KV operations (context-based gating — deep-reflect can write system keys)
  if (output.kv_operations?.length) {
    const blocked = [];
    for (const op of output.kv_operations) {
      const result = await K.kvWriteGated(op, "deep-reflect");
      if (!result.ok) blocked.push({ key: op.key, error: result.error });
    }
    if (blocked.length) {
      await K.karmaRecord({ event: "kv_writes_blocked", blocked });
    }
  }

  // 2. Verdicts BEFORE new requests — clears conflicts first
  if (output.proposal_verdicts) {
    await K.processProposalVerdicts(output.proposal_verdicts, depth);
  }

  // 3. Code proposals — proposal_requests is for code changes only
  if (output.proposal_requests) {
    for (const req of output.proposal_requests) {
      // createProposal validates all ops target code keys; rejects mixed ops
      const id = await K.createProposal(req, sessionId, depth);
      if (id && depth >= 1) {
        await K.updateProposalStatus(id, "accepted", { accepted_by_depth: depth });
      }
    }
  }

  // 4. Schedule
  const schedule = output.next_reflect || output.next_deep_reflect;
  if (schedule) {
    const sessionCount = await K.getSessionCount();
    await K.kvWriteSafe(`reflect:schedule:${depth}`, {
      ...schedule,
      last_reflect: new Date().toISOString(),
      last_reflect_session: sessionCount,
      last_reflect_session_id: sessionId,
    });
  }

  // 5. Store output as reflect:{depth}:{sessionId}
  const reflectRecord = {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  };
  if (output.sankalpas) reflectRecord.sankalpas = output.sankalpas;
  if (output.proposal_observations) reflectRecord.proposal_observations = output.proposal_observations;
  if (output.vikalpas) reflectRecord.vikalpas = output.vikalpas;
  if (output.tasks) reflectRecord.tasks = output.tasks;
  await K.kvWriteSafe(`reflect:${depth}:${sessionId}`, reflectRecord);

  // 6. Only depth 1: write last_reflect and session_schedule
  if (depth === 1) {
    // Track vikalpas/tasks dropped by deep reflect
    const prevLastReflect = await K.kvGet("last_reflect");
    const prevVikalpas = prevLastReflect?.vikalpas || [];
    const prevTasks = prevLastReflect?.tasks || [];
    const newVikalpaIds = new Set((output.vikalpas || []).map(v => v.id));
    const newTaskIds = new Set((output.tasks || []).map(t => t.id));
    const droppedVikalpas = prevVikalpas.filter(v => v.id && !newVikalpaIds.has(v.id));
    const droppedTasks = prevTasks.filter(t => t.id && !newTaskIds.has(t.id));
    if (droppedVikalpas.length) {
      await K.karmaRecord({ event: "vikalpas_dropped", dropped: droppedVikalpas.map(v => ({ id: v.id, vikalpa: v.vikalpa })) });
    }
    if (droppedTasks.length) {
      await K.karmaRecord({ event: "tasks_dropped", dropped: droppedTasks.map(t => ({ id: t.id, task: t.task, status: t.status })) });
    }

    await K.kvWriteSafe("last_reflect", {
      session_summary: output.reflection,
      vikalpas: output.vikalpas || [],
      tasks: output.tasks || [],
      was_deep_reflect: true,
      depth,
      session_id: sessionId,
    });

    const scheduleConf = output.next_session_config || {};
    if (scheduleConf.interval_seconds) {
      scheduleConf.next_session_after = new Date(
        Date.now() + scheduleConf.interval_seconds * 1000
      ).toISOString();
    }
    await K.kvWriteSafe("session_schedule", scheduleConf);
  }

  // 7. Refresh defaults after every depth (cascade visibility)
  await state.refreshDefaults();

}

// ── Reflect hierarchy helpers ──────────────────────────────

export async function loadReflectPrompt(K, state, depth) {
  const specific = await K.kvGet(`prompt:reflect:${depth}`);
  if (specific) return specific;
  return defaultDeepReflectPrompt(depth);
}

export async function loadBelowPrompt(K, depth) {
  if (depth === 1) return K.kvGet("prompt:act");
  return K.kvGet(`prompt:reflect:${depth - 1}`);
}

export async function getRelevantSessionIds(K, depth, cap = 50) {
  const schedule = await K.kvGet(`reflect:schedule:${depth}`);
  const cutoffId = schedule?.last_reflect_session_id || null;

  if (depth === 1) {
    // Depth 1 reviews act sessions
    const allIds = await K.kvGet("cache:session_ids") || [];
    let filtered = cutoffId ? allIds.filter(id => id > cutoffId) : allIds;
    return filtered.length > cap ? filtered.slice(-cap) : filtered;
  }

  // Depth 2+: review depth-(N-1) reflect session IDs
  const result = await K.kvList({ prefix: `reflect:${depth - 1}:`, limit: 1000 });
  let ids = result.keys.map(k => k.name.replace(`reflect:${depth - 1}:`, '')).sort();
  if (cutoffId) ids = ids.filter(id => id > cutoffId);
  return ids.length > cap ? ids.slice(-cap) : ids;
}

export async function loadReflectHistory(K, depth, count = 10) {
  const result = await K.kvList({ prefix: `reflect:${depth}:`, limit: count + 10 });
  const keys = result.keys
    .map(k => k.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, count);
  return K.loadKeys(keys);
}

// ── Reflect scheduling ───────────────────────────────────

export async function isReflectDue(K, state, depth) {
  const { defaults } = state;

  const schedule = await K.kvGet(`reflect:schedule:${depth}`);

  const sessionCount = await K.getSessionCount();

  if (schedule) {
    const sessionsSince = sessionCount - (schedule.last_reflect_session || 0);
    const daysSince = schedule.last_reflect
      ? (Date.now() - new Date(schedule.last_reflect).getTime()) / 86400000
      : Infinity;
    const maxSessions = schedule.after_sessions
      || defaults?.deep_reflect?.default_interval_sessions || 20;
    const maxDays = schedule.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    return sessionsSince >= maxSessions || daysSince >= maxDays;
  }

  // Cold-start fallback — exponential interval
  const baseInterval = defaults?.deep_reflect?.default_interval_sessions || 20;
  const multiplier = defaults?.execution?.reflect_interval_multiplier || 5;
  const threshold = baseInterval * Math.pow(multiplier, depth - 1);
  return sessionCount >= threshold;
}

export async function highestReflectDepthDue(K, state) {
  const maxDepth = state.defaults?.execution?.max_reflect_depth || 1;
  for (let d = maxDepth; d >= 1; d--) {
    if (await isReflectDue(K, state, d)) return d;
  }
  return 0;
}

// ── Default prompts ────────────────────────────────────────

export function defaultReflectPrompt() {
  return `You are reflecting on a session that just completed.

Review the session karma log and cost provided in the user message.

Produce a JSON object with: session_summary, note_to_future_self,
next_act_context (with load_keys array), and optionally
next_session_config, kv_operations, proposal_verdicts, and proposal_requests.`;
}

export function defaultDeepReflectPrompt(depth) {
  if (depth === 1) {
    return `You are performing a depth-1 reflection. This is a deep examination of your recent operations.

You have tools available for investigation \u2014 use kv_query, web_fetch, etc. to gather data before drawing conclusions.

Your output is stored at reflect:1:{sessionId} and read by higher-depth reflections.

## Chat system

Between sessions, contacts may message you via chat (e.g. Slack DM). Chat
is a separate real-time pipeline — conversations are stored at chat:{channel}:{id}
and do not appear in session karma. Use kv_query to read chat history if relevant.

{{chatDigest}}

## Temporal awareness

Session timing: each session_start event includes a scheduled_at field
showing when this session was scheduled. Actual start time may differ due
to chat-triggered advancement (contacts messaging you brings the next session
forward) or patron manual intervention. Don't assume irregular intervals
indicate broken scheduling.

## Your prior reflections at this depth

{{priorReflections}}

Read these for continuity. If you set sankalpas, honor or explicitly revise them.

## Available wisdom

{{wisdom_manifest}}

Use kv_query to load specific entries relevant to your examination.

Examine your karma, your act prompt, your patterns. Produce a JSON object:
{
  "reflection": "What you see when you look at yourself as a system",
  "note_to_future_self": "Orientation, not action items",
  "sankalpas": [{"sankalpa": "...", "status": "active", "observation": "..."}],
  "proposal_observations": {"m_123": "What you observe about this proposal"},
  "kv_operations": [],
  "proposal_requests": [],
  "proposal_verdicts": [],
  "next_reflect": { "after_sessions": 20, "after_days": 7, "reason": "..." },
  "next_session_config": { "interval_seconds": 21600, "effort": "low" }
}

kv_operations: write to any key including system keys (config, prompts, wisdom). Yama/niyama require deliberation field.
proposal_requests: code changes ONLY — become proposals (governor deploys).
proposal_verdicts: accept/reject/modify/withdraw proposals.
Required: reflection, note_to_future_self. Everything else optional.`;
  }

  return `You are performing a depth-${depth} reflection. You examine the outputs of depth-${depth - 1} reflections.

You have tools available for investigation \u2014 use kv_query, web_fetch, etc. to gather data.

Your output is stored at reflect:${depth}:{sessionId}.

## Your prior reflections at this depth

{{priorReflections}}

Read these for continuity. If you set sankalpas, honor or explicitly revise them.

## Available wisdom

{{wisdom_manifest}}

Use kv_query to load specific entries relevant to your examination.

## One-level-below write discipline
You can only propose changes targeting prompt:reflect:${depth - 1} (the prompt for the level below you).

Below-level prompt: {{belowPrompt}}

Examine the depth-${depth - 1} outputs for patterns, drift, and alignment. Produce a JSON object:
{
  "reflection": "What you see in the level-below patterns",
  "note_to_future_self": "Orientation for next depth-${depth} reflection",
  "sankalpas": [{"sankalpa": "...", "status": "active", "observation": "..."}],
  "proposal_observations": {"m_123": "What you observe about this proposal"},
  "kv_operations": [],
  "proposal_requests": [],
  "proposal_verdicts": [],
  "next_reflect": { "after_sessions": 100, "after_days": 30, "reason": "..." }
}

Required: reflection, note_to_future_self. Everything else optional.`;
}

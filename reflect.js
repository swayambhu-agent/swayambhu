// Swayambhu — Reflection Policy
// Session reflect, deep reflect (recursive, depth-aware), scheduling, default prompts.
// Mutable — the agent can stage changes to this file via K.stageCode().
//
// Receives K (kernel interface) for all kernel interactions.
// getMaxSteps and getReflectModel logic inlined (cognitive policy, not kernel).

import { selectExperiences } from './memory.js';

// ── Pattern manifest ────────────────────────────────────────

async function loadPatternManifest(K) {
  const list = await K.kvList({ prefix: "pattern:", limit: 200 });
  return list.keys.map(k => ({
    key: k.name,
    summary: k.metadata?.summary || k.name,
  }));
}

function isBootstrapNoActionSession({ sessionCounter, desires, karma }) {
  const noDesires = !desires || Object.keys(desires).length === 0;
  const plannedNoAction = karma.some((event) => event.event === "plan_no_action");
  const wroteBootstrapExperience = karma.some((event) => event.event === "experience_written");
  const actComplete = karma.find((event) => event.event === "act_complete");
  const cyclesRun = typeof actComplete?.cycles_run === "number" ? actComplete.cycles_run : null;

  return sessionCounter === 1
    && noDesires
    && plannedNoAction
    && wroteBootstrapExperience
    && cyclesRun === 0;
}

function buildBootstrapReflectOutput(sessionCounter) {
  return {
    session_summary: `Session ${sessionCounter} had no active desires. No action was taken. A bootstrap experience was written.`,
    note_to_future_self: "No action until desire exists.",
    next_act_context: {
      load_keys: [],
      reason: "No active desires or live context.",
    },
    carry_forward_updates: [],
    new_carry_forward: [],
    kv_operations: [],
  };
}

// ── Session reflect ─────────────────────────────────────────

export async function executeReflect(K, state, step) {
  const { defaults } = state;
  const sessionId = await K.getExecutionId();

  const reflectPrompt = await K.kvGet("prompt:reflect");
  const systemKeyPatterns = await K.getSystemKeyPatterns();
  const pattern_manifest = await loadPatternManifest(K);

  const sessionCounter = (await K.kvGet("session_counter")) || 0;
  const systemPrompt = await K.buildPrompt(
    reflectPrompt || defaultReflectPrompt(),
    { systemKeyPatterns, pattern_manifest, session_counter: sessionCounter }
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

  const lastReflect = await K.kvGet("last_reflect");
  const initialContext = JSON.stringify({
    karma,
    sessionCost,
    carry_forward: lastReflect?.carry_forward || [],
  });

  const output = isBootstrapNoActionSession({
    sessionCounter,
    desires: state.desires,
    karma,
  })
    ? buildBootstrapReflectOutput(sessionCounter)
    : await (async () => {
        const model = await K.resolveModel(
          step.model || defaults?.reflect?.model
        );

        return K.runAgentLoop({
          systemPrompt,
          initialContext,
          tools: [],
          model,
          effort: step.effort || defaults?.reflect?.effort,
          maxTokens: step.max_output_tokens || defaults?.reflect?.max_output_tokens,
          maxSteps: 1,
          step: "reflect",
        });
      })();

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

  // Detect truncation — valid JSON but missing expected fields
  const hasContent = !!(output.session_summary || output.reflection);
  if (hasContent && !output.next_session_config && !output.carry_forward_updates && !output.new_carry_forward) {
    await K.karmaRecord({
      event: "reflect_incomplete",
      depth: 0,
      missing: ["next_session_config", "carry_forward_updates", "new_carry_forward"],
      session_id: sessionId,
    });
  }

  // Strip stale fields the LLM might still emit
  const {
    vikalpa_updates,
    vikalpas: _v,
    task_updates: _taskUpdates,
    new_tasks: _newTasks,
    carry_forward_updates: _carryForwardUpdates,
    new_carry_forward: _newCarryForward,
    ...cleanOutput
  } = output;
  const prevLastReflect = await K.kvGet("last_reflect");

  const nowIso = new Date().toISOString();
  const defaultExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

  let carry_forward = (prevLastReflect?.carry_forward || []).map(item => ({ ...item }));
  if (output.carry_forward_updates) {
    const missedCarryForward = [];
    for (const update of output.carry_forward_updates) {
      const existing = carry_forward.find(item => item.id === update.id);
      if (!existing) {
        missedCarryForward.push(update);
        continue;
      }
      Object.assign(existing, {
        ...("item" in update ? { item: update.item } : {}),
        ...("why" in update ? { why: update.why } : {}),
        ...("priority" in update ? { priority: update.priority } : {}),
        ...("status" in update ? { status: update.status } : {}),
        ...("updated_at" in update ? { updated_at: update.updated_at } : { updated_at: nowIso }),
        ...("expires_at" in update ? { expires_at: update.expires_at } : {}),
        ...("desire_key" in update ? { desire_key: update.desire_key } : {}),
        ...("result" in update ? { result: update.result } : {}),
        ...("reason" in update ? { reason: update.reason } : {}),
      });
      if (update.status === "done") existing.done_session = sessionId;
    }
    if (missedCarryForward.length) {
      await K.karmaRecord({ event: "carry_forward_updates_missed", missed: missedCarryForward });
    }
  }
  if (output.new_carry_forward) {
    for (const item of output.new_carry_forward) {
      carry_forward.push({
        ...item,
        status: item.status || "active",
        created_at: item.created_at || nowIso,
        updated_at: item.updated_at || nowIso,
        expires_at: item.expires_at || defaultExpiresAt,
      });
    }
  }

  carry_forward = carry_forward.map(item => {
    if (item.status === "active" && item.expires_at && new Date(item.expires_at).getTime() < Date.now()) {
      return { ...item, status: "expired", updated_at: nowIso };
    }
    return item;
  });

  const activeCount = carry_forward.filter(item => item.status === "active").length;
  if (activeCount > 5) {
    await K.karmaRecord({ event: "carry_forward_active_cap_exceeded", active: activeCount });
  }

  await K.kvWriteSafe("last_reflect", {
    ...cleanOutput,
    carry_forward,
    session_id: sessionId,
  });

  const sessionReflectRecord = {
    reflection: output.session_summary || output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 0,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  };
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

  if (output.next_session_config) {
    const scheduleConf = { ...output.next_session_config };
    if (scheduleConf.interval_seconds) {
      // When plan was no_action, don't let reflect shorten below the system default.
      // Tactics (e.g. backoff-in-waiting) set the default as the floor for waiting states.
      const wasNoAction = karma.some(e => e.event === 'plan_no_action');
      if (wasNoAction) {
        const defaults = await K.getDefaults();
        const floor = defaults?.schedule?.interval_seconds || 21600;
        scheduleConf.interval_seconds = Math.max(scheduleConf.interval_seconds, floor);
      }
      scheduleConf.next_session_after = new Date(
        Date.now() + scheduleConf.interval_seconds * 1000
      ).toISOString();
    }
    await K.kvWriteSafe("session_schedule", scheduleConf);
  }
}

// ── Deep reflection (recursive, depth-aware) ────────────────

export async function runReflectInWorker(K, state, depth, context) {
  const { defaults } = state;
  const sessionId = await K.getExecutionId();

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

  const perLevel = defaults?.reflect_levels?.[depth];
  const reflectModelId = perLevel?.model || defaults?.deep_reflect?.model || defaults?.act?.model;
  const model = await K.resolveModel(reflectModelId);
  const maxSteps = perLevel?.max_steps || (depth === 1
    ? (defaults?.execution?.max_steps?.reflect || 5)
    : (defaults?.execution?.max_steps?.deep_reflect || 10));

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
    await runReflectInWorker(K, state, depth - 1, context);
  }
}


export async function gatherReflectContext(K, state, depth, context) {
  const { defaults, modelsConfig } = state;

  const actPrompt = await K.kvGet("prompt:act");
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
    const healthKeys = recentSessionIds.map(id => `execution_health:${id}`);
    const healthData = await K.loadKeys(healthKeys);
    // Enrich empty reflect records with health data
    if (templateVars.belowOutputs) {
      for (const [key, record] of Object.entries(templateVars.belowOutputs)) {
        if (record && !record.reflection && record.session_id) {
          const health = healthData[`execution_health:${record.session_id}`];
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

  // Pattern manifest — lazy loading for all depths
  templateVars.pattern_manifest = await loadPatternManifest(K);

  // Events — session requests and other signals since last session
  if (depth >= 1 && context?.events?.length) {
    templateVars.chatDigest = context.events.filter(i => i.type === 'session_request');
  }

  // Reflect schedule — so deep reflect knows when it last ran and when next is due
  if (depth >= 1) {
    const maxReflectDepth = defaults?.execution?.max_reflect_depth || 1;
    const sessionCount = (await K.kvGet("session_counter")) || 0;
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

  // Load experiences for deep-reflect
  const experienceList = await K.kvList({ prefix: "experience:" });
  const experiences = [];
  for (const key of experienceList.keys) {
    const exp = await K.kvGet(key.name);
    if (exp) experiences.push(exp);
  }

  // Load desire embeddings for similarity-based experience selection
  const desireList = await K.kvList({ prefix: "desire:" });
  const desireEmbeddings = [];
  for (const key of desireList.keys) {
    const d = await K.kvGet(key.name);
    if (d?._embedding) desireEmbeddings.push(d._embedding);
  }

  // Select relevant experiences
  const lastReflectSchedule = await K.kvGet(`reflect:schedule:${depth}`);
  const selectedExperiences = selectExperiences(experiences, desireEmbeddings, {
    maxEpisodes: defaults?.memory?.max_episodes_for_reflect || 20,
    lastReflectTimestamp: lastReflectSchedule?.last_reflect,
    salienceWeight: defaults?.memory?.salience_weight || 0.7,
    similarityWeight: defaults?.memory?.similarity_weight || 0.3,
  });

  // Add to template vars
  templateVars.experiences = selectedExperiences;

  return { userMessage: "Begin.", templateVars };
}

export async function applyReflectOutput(K, state, depth, output, context) {
  const sessionId = await K.getExecutionId();

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
      const sessionCount = (await K.kvGet("session_counter")) || 0;
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

  // 2. Schedule
  const schedule = output.next_reflect || output.next_deep_reflect;
  if (schedule) {
    const sessionCount = (await K.kvGet("session_counter")) || 0;
    await K.kvWriteSafe(`reflect:schedule:${depth}`, {
      ...schedule,
      last_reflect: new Date().toISOString(),
      last_reflect_session: sessionCount,
      last_reflect_session_id: sessionId,
    });
  }

  // 3. Store output as reflect:{depth}:{sessionId}
  const reflectRecord = {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  };
  if (output.sankalpas) reflectRecord.sankalpas = output.sankalpas;
  if (output.carry_forward) reflectRecord.carry_forward = output.carry_forward;
  await K.kvWriteSafe(`reflect:${depth}:${sessionId}`, reflectRecord);

  // 4. Only depth 1: write last_reflect and session_schedule
  if (depth === 1) {
    // Track carry-forward items dropped by deep reflect
    const prevLastReflect = await K.kvGet("last_reflect");
    const prevCarryForward = prevLastReflect?.carry_forward || [];
    const newCarryForwardIds = new Set((output.carry_forward || []).map(item => item.id));
    const droppedCarryForward = prevCarryForward.filter(item => item.id && !newCarryForwardIds.has(item.id));
    if (droppedCarryForward.length) {
      await K.karmaRecord({
        event: "carry_forward_dropped",
        dropped: droppedCarryForward.map(item => ({ id: item.id, item: item.item, status: item.status })),
      });
    }

    await K.kvWriteSafe("last_reflect", {
      session_summary: output.reflection,
      carry_forward: output.carry_forward || [],
      was_deep_reflect: true,
      depth,
      session_id: sessionId,
    });

    // session_schedule is now owned by session.js
    // Reflect output can suggest schedule preferences but doesn't write directly
    if (output.next_session_config) {
      await K.karmaRecord({
        event: "reflect_schedule_suggestion",
        config: output.next_session_config,
      });
    }
  }

  // 5. Refresh defaults after every depth (cascade visibility)
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

// ── Default prompts ────────────────────────────────────────

export function defaultReflectPrompt() {
  return `You are reflecting on a session that just completed.

Review the session karma log and cost provided in the user message.

Produce a JSON object with: session_summary, note_to_future_self,
next_act_context (with load_keys array), and optionally
next_session_config and kv_operations.`;
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

Session timing: each act_start event includes a scheduled_at field
showing when this session was scheduled. Actual start time may differ due
to chat-triggered advancement (contacts messaging you brings the next session
forward) or patron manual intervention. Don't assume irregular intervals
indicate broken scheduling.

## Your prior reflections at this depth

{{priorReflections}}

Read these for continuity. If you set sankalpas, honor or explicitly revise them.

## Available patterns

{{pattern_manifest}}

Use kv_query to load specific pattern:* or desire:* entries relevant to your examination.

Examine your karma, your act prompt, your patterns. Produce a JSON object:
{
  "reflection": "What you see when you look at yourself as a system",
  "note_to_future_self": "Orientation, not action items",
  "sankalpas": [{"sankalpa": "...", "status": "active", "observation": "..."}],
  "kv_operations": [],
  "next_reflect": { "after_sessions": 20, "after_days": 7, "reason": "..." },
  "next_session_config": { "interval_seconds": 21600, "effort": "low" }
}

kv_operations: write to any key including system keys (config, prompts, pattern:*, desire:*). Principle keys are immutable — cannot be written.
Code changes: use K.stageCode() + K.signalDeploy() — not kv_operations.
Required: reflection, note_to_future_self. Everything else optional.`;
  }

  return `You are performing a depth-${depth} reflection. You examine the outputs of depth-${depth - 1} reflections.

You have tools available for investigation \u2014 use kv_query, web_fetch, etc. to gather data.

Your output is stored at reflect:${depth}:{sessionId}.

## Your prior reflections at this depth

{{priorReflections}}

Read these for continuity. If you set sankalpas, honor or explicitly revise them.

## Available patterns

{{pattern_manifest}}

Use kv_query to load specific pattern:* or desire:* entries relevant to your examination.

## One-level-below write discipline
You can only propose changes targeting prompt:reflect:${depth - 1} (the prompt for the level below you).

Below-level prompt: {{belowPrompt}}

Examine the depth-${depth - 1} outputs for patterns, drift, and alignment. Produce a JSON object:
{
  "reflection": "What you see in the level-below patterns",
  "note_to_future_self": "Orientation for next depth-${depth} reflection",
  "sankalpas": [{"sankalpa": "...", "status": "active", "observation": "..."}],
  "kv_operations": [],
  "next_reflect": { "after_sessions": 100, "after_days": 30, "reason": "..." }
}

Required: reflection, note_to_future_self. Everything else optional.`;
}

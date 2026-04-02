// Swayambhu — Userspace (cognitive policy)
// Entry point for all scheduled cognitive work: act cycle + DR lifecycle.
// Called by kernel via HOOKS.session.run(K, { crashData, balances, events, schedule }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { evaluateAction } from './eval.js';
import { updateSamskaraStrength, callInference, embeddingCacheKey } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatSamskaras, formatCircumstances } from './act.js';

// ── Snapshot loaders ────────────────────────────────────────

async function loadDesires(K) {
  const list = await K.kvList({ prefix: "desire:" });
  const desires = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (val) desires[entry.name] = val;
  }
  return desires;
}

async function loadSamskaras(K) {
  const list = await K.kvList({ prefix: "samskara:" });
  const samskaras = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (val) samskaras[entry.name] = val;
  }
  return samskaras;
}

// ── Circumstances builder ───────────────────────────────────

function buildCircumstances(events, balances, crashData) {
  const circumstances = {};
  if (events?.length) circumstances.events = events;
  if (balances) circumstances.balances = balances;
  if (crashData) circumstances.crash = crashData;
  return circumstances;
}

// ── Embedding cache helper ───────────────────────────────────

async function cacheEmbeddings(K, entities, textField, model, config) {
  const textsToEmbed = [];
  const pendingKeys = [];

  for (const [key, entity] of Object.entries(entities)) {
    const text = entity[textField];
    if (!text) continue;
    const cacheKey = embeddingCacheKey(text, model);
    const cached = await K.kvGet(cacheKey);
    if (cached) {
      entity._embedding = cached;
    } else {
      textsToEmbed.push(text);
      pendingKeys.push({ entityKey: key, cacheKey });
    }
  }

  if (textsToEmbed.length > 0) {
    try {
      const resp = await callInference(config.url, config.secret, '/embed', { texts: textsToEmbed });
      for (let i = 0; i < pendingKeys.length; i++) {
        const emb = resp.embeddings?.[i];
        if (emb) {
          entities[pendingKeys[i].entityKey]._embedding = emb;
          await K.kvWriteSafe(pendingKeys[i].cacheKey, emb);
        }
      }
    } catch {
      await K.karmaRecord({ event: "embedding_cache_failed" });
    }
  }
}

// ── Plan phase ──────────────────────────────────────────────

async function planPhase(K, { desires, samskaras, circumstances, defaults, modelsConfig }) {
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const planPrompt = await K.kvGet("prompt:plan");
  const systemPrompt = planPrompt
    ? await K.buildPrompt(planPrompt, { config: defaults })
    : "You are a planning agent. Given desires, samskaras, and circumstances, output a JSON action plan.";

  const userContent = [
    "[DESIRES]", formatDesires(desires), "",
    "[SAMSKARAS]", formatSamskaras(samskaras), "",
    "[CIRCUMSTANCES]", formatCircumstances(circumstances),
    "",
    "Respond with a JSON plan object: { action, success, relies_on, defer_if, no_action }",
    "If no action is warranted, respond: { no_action: true, reason: \"...\" }",
  ].join("\n");

  const response = await K.callLLM({
    model,
    effort: defaults?.act?.effort || "low",
    maxTokens: defaults?.act?.max_output_tokens || 2000,
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    json: true,
  });

  let plan = response.parsed;
  if (!plan) {
    // One retry on parse failure
    const retry = await K.callLLM({
      model,
      effort: defaults?.act?.effort || "low",
      maxTokens: defaults?.act?.max_output_tokens || 2000,
      systemPrompt,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: response.content },
        { role: "user", content: "Respond with ONLY a valid JSON plan object." },
      ],
      tools: [],
      json: true,
    });
    if (!retry.parsed) {
      await K.karmaRecord({ event: "plan_parse_failure", raw: response.content?.slice(0, 500) });
      return null;
    }
    plan = retry.parsed;
  }

  if (plan.no_action) return plan;

  // Validate relies_on keys against samskara snapshot
  if (plan.relies_on?.length) {
    const knownKeys = new Set(Object.keys(samskaras));
    const unknown = plan.relies_on.filter(k => !knownKeys.has(k));
    if (unknown.length) {
      await K.karmaRecord({ event: "plan_unknown_relies_on", unknown_keys: unknown, stripped: true });
      plan.relies_on = plan.relies_on.filter(k => knownKeys.has(k));
    }
  }

  return plan;
}

// ── Act phase ───────────────────────────────────────────────

async function actPhase(K, { plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults }) {
  const maxActSteps = defaults?.execution?.max_steps?.act || 12;
  const budget = defaults?.session_budget || {};
  const maxCost = budget.max_cost || 0.50;
  const minReviewCost = defaults?.session?.min_review_cost || 0.05;

  const ledger = {
    action_id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    plan,
    tool_calls: [],
    final_text: null,
  };

  // Initial user message with the plan
  messages.push({
    role: "user",
    content: `Execute this plan:\n${JSON.stringify(plan, null, 2)}`,
  });

  for (let step = 0; step < maxActSteps; step++) {
    // Budget check: reserve room for review
    const spent = await K.getSessionCost();
    if (spent + minReviewCost >= maxCost) {
      await K.karmaRecord({ event: "act_budget_break", spent, maxCost });
      break;
    }

    const turn = await K.runAgentTurn({
      systemPrompt,
      messages,
      tools,
      model,
      effort,
      maxTokens,
      step,
      budgetCap: maxCost - minReviewCost,
    });

    // Record tool calls
    if (turn.toolResults?.length) {
      for (let i = 0; i < turn.response.toolCalls.length; i++) {
        const tc = turn.response.toolCalls[i];
        const result = turn.toolResults[i];
        ledger.tool_calls.push({
          tool: tc.function?.name || tc.name || "unknown",
          input: tc.function?.arguments || tc.arguments || {},
          output: result,
          ok: !result?.error,
        });
      }
    }

    if (turn.done) {
      ledger.final_text = turn.response.content;
      break;
    }
  }

  return ledger;
}

// ── Review phase ────────────────────────────────────────────

async function reviewPhase(K, { ledger, evalResult, defaults }) {
  const model = await K.resolveModel(defaults?.reflect?.model || defaults?.act?.model || "sonnet");
  const reviewPrompt = await K.kvGet("prompt:review");

  const evalBlock = [
    "[KERNEL EVALUATION]",
    `sigma (alignment signal): ${evalResult.sigma}`,
    `salience: ${evalResult.salience}`,
    `eval_method: ${evalResult.eval_method}`,
    `tool_outcomes: ${JSON.stringify(evalResult.tool_outcomes)}`,
    `plan_success_criteria: ${evalResult.plan_success_criteria || "none"}`,
    `samskaras_relied_on: ${JSON.stringify(evalResult.samskaras_relied_on)}`,
  ].join("\n");

  const systemPrompt = reviewPrompt
    ? await K.buildPrompt(reviewPrompt, { config: defaults })
    : `You are a review agent. Assess the action outcome.\n\n${evalBlock}`;

  // If using template, append eval block
  const finalSystem = reviewPrompt
    ? `${systemPrompt}\n\n${evalBlock}`
    : systemPrompt;

  const userContent = [
    "Action ledger:",
    JSON.stringify({
      action_id: ledger.action_id,
      plan: ledger.plan,
      tool_calls: ledger.tool_calls.map(tc => ({
        tool: tc.tool, ok: tc.ok, output_preview: JSON.stringify(tc.output)?.slice(0, 200),
      })),
      final_text: ledger.final_text?.slice(0, 500),
    }, null, 2),
    "",
    "Respond with JSON: { assessment, narrative, salience_estimate }",
  ].join("\n");

  const response = await K.callLLM({
    model,
    effort: defaults?.reflect?.effort || "medium",
    maxTokens: defaults?.reflect?.max_output_tokens || 1000,
    systemPrompt: finalSystem,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    json: true,
  });

  if (!response.parsed) {
    await K.karmaRecord({ event: "review_parse_failure", raw: response.content?.slice(0, 500) });
    return null;
  }

  return response.parsed;
}

// ── Memory writes ───────────────────────────────────────────

async function writeMemory(K, { ledger, evalResult, review, desires, samskaras, inferenceConfig }) {
  const now = new Date().toISOString();

  // Samskara strength updates — from eval's per-samskara surprise scores
  if (evalResult.samskara_scores) {
    for (const [key, score] of Object.entries(evalResult.samskara_scores)) {
      const existing = samskaras[key];
      if (!existing) continue;
      const newStrength = updateSamskaraStrength(existing.strength, score.surprise);
      await K.kvWriteGated({ op: "put", key, value: { ...existing, strength: newStrength } }, "act");
    }
  }

  // Experience writes — if salience exceeds threshold
  const salienceThreshold = 0.5;
  const salience = evalResult.salience > 0
    ? evalResult.salience
    : (review?.salience_estimate || 0);

  if (salience > salienceThreshold) {
    let embedding = null;
    if (inferenceConfig) {
      try {
        const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
          texts: [review?.narrative || review?.assessment || ledger.final_text || '']
        });
        embedding = resp.embeddings?.[0] || null;
      } catch {
        await K.karmaRecord({ event: "experience_embedding_failed" });
      }
    }

    const experienceKey = `experience:${Date.now()}`;
    await K.kvWriteSafe(experienceKey, {
      timestamp: now,
      action_taken: ledger.plan?.action || "no_action",
      outcome: ledger.final_text || review?.assessment || "",
      surprise_score: evalResult.sigma,
      salience,
      narrative: review?.narrative || review?.assessment || ledger.plan?.reason || "",
      embedding,
    });
  }
}

// ── Act cycle ─────────────────────────────────────────────

async function actCycle(K, { crashData, balances, events, schedule }) {
  // 1. Load config
  const defaults = await K.getDefaults();
  const modelsConfig = await K.getModelsConfig();

  // 1b. Load inference config for embedding pipeline
  const inferenceUrl = defaults?.inference?.url || null;
  const inferenceSecret = await K.kvGet("secret:inference");
  const inferenceConfig = inferenceUrl ? {
    url: inferenceUrl,
    secret: inferenceSecret,
    relevance_threshold: defaults?.inference?.relevance_threshold || 0.3,
    ambiguity_threshold: defaults?.inference?.ambiguity_threshold || 0.6,
  } : null;

  // 2. Snapshot desires and samskaras
  let desires = await loadDesires(K);
  let samskaras = await loadSamskaras(K);

  // 2b. Cache embeddings for Tier 1 relevance filtering
  if (inferenceConfig) {
    const embedModel = defaults?.inference?.embed_model || 'bge-small-en-v1.5';
    await cacheEmbeddings(K, desires, 'description', embedModel, inferenceConfig);
    await cacheEmbeddings(K, samskaras, 'pattern', embedModel, inferenceConfig);
  }

  // 3. Build initial circumstances
  let circumstances = buildCircumstances(events, balances, crashData);

  // 4. Build system prompt, tools, model
  const systemPrompt = await renderActPrompt(K, { defaults });
  const tools = await buildToolSet(K);
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const effort = defaults?.act?.effort || "low";
  const maxTokens = defaults?.act?.max_output_tokens || 4000;

  // 5. Shared messages array
  const messages = [];

  // 6. Main loop
  const maxCycles = 10;
  const budget = defaults?.session_budget || {};
  const maxCost = budget.max_cost || 0.50;
  const minReviewCost = defaults?.session?.min_review_cost || 0.05;
  let cyclesRun = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // 6a. Budget preflight
    const spent = await K.getSessionCost();
    if (spent + minReviewCost >= maxCost) {
      await K.karmaRecord({ event: "session_budget_exhausted", spent, cycle });
      break;
    }

    // 6b. Plan phase
    const plan = await planPhase(K, { desires, samskaras, circumstances, defaults, modelsConfig });
    if (!plan) break; // parse failure
    if (plan.no_action) {
      await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });

      // Still run eval + memory so the experience gets recorded. When
      // samskaras are empty, eval returns σ=1 (max surprise) — this is
      // what bootstraps the agent by making "no desires" a high-salience
      // experience that reflect can act on.
      const noActionLedger = {
        action_id: `a_${Date.now()}_noaction`,
        plan,
        tool_calls: [],
        final_text: plan.reason,
      };
      const evalResult = await evaluateAction(K, noActionLedger, desires, samskaras, inferenceConfig || {});
      await writeMemory(K, { ledger: noActionLedger, evalResult, review: null, desires, samskaras, inferenceConfig });

      break;
    }

    // 6c. Act phase
    const ledger = await actPhase(K, {
      plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults,
    });

    // 6d. Eval phase
    const evalResult = await evaluateAction(K, ledger, desires, samskaras, inferenceConfig || {});

    // 6e. Review phase
    const review = await reviewPhase(K, { ledger, evalResult, defaults });

    // 6f. Memory writes
    await writeMemory(K, { ledger, evalResult, review, desires, samskaras, inferenceConfig });

    cyclesRun++;

    // 6g. Refresh circumstances
    const freshBalances = await K.checkBalance();
    circumstances = buildCircumstances(
      null, // events only on first cycle
      freshBalances,
      null, // crashData only on first cycle
    );
    // Add recent tool outcomes
    if (ledger.tool_calls.length) {
      circumstances.recent_outcomes = ledger.tool_calls.map(tc => ({
        tool: tc.tool, ok: tc.ok,
      }));
    }
  }

  return { defaults, modelsConfig, desires, cyclesRun };
}

// ── DR Lifecycle (independent state machine) ──────────────

async function drCycle(K) {
  const defaults = await K.getDefaults();
  const state = await K.kvGet("dr:state:1") || {
    status: "idle", generation: 0, consecutive_failures: 0,
  };

  if (state.status === "dispatched") {
    const ttl = defaults?.deep_reflect?.ttl_minutes || 120;
    const age = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
    if (age > ttl) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = `TTL expired after ${Math.round(age)} minutes`;
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await updateJobRecord(K, state.job_id, "expired");
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return;
    }

    const result = await pollJobResult(K, state, defaults);

    if (result.status === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      await K.kvWriteSafe(`dr:result:${state.generation}`, result.output);
      await updateJobRecord(K, state.job_id, "completed");
      await K.kvWriteSafe("dr:state:1", state);
    } else if (result.status === "failed") {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = result.error || "non-zero exit code";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await updateJobRecord(K, state.job_id, "failed");
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_failed", job_id: state.job_id, error: result.error });
    }
    return;
  }

  if (state.status === "completed") {
    const output = await K.kvGet(`dr:result:${state.generation}`);
    if (!output) {
      state.status = "failed";
      state.failure_reason = "result missing from KV";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    await applyDrResults(K, state, output);

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = await K.getSessionCount();
    state.last_session_id = await K.getSessionId();
    state.consecutive_failures = 0;
    state.last_failure_session = null;

    const interval = output.next_reflect?.after_sessions
      || defaults?.deep_reflect?.default_interval_sessions || 20;
    const intervalDays = output.next_reflect?.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    state.next_due_session = state.last_applied_session + interval;
    state.next_due_date = new Date(Date.now() + intervalDays * 86400000).toISOString();

    await K.kvDeleteSafe(`dr:result:${state.generation}`);
    await K.kvWriteSafe("dr:state:1", state);
    return;
  }

  if (state.status === "failed") {
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    const sessionCount = await K.getSessionCount();
    if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) return;

    state.status = "idle";
    state.next_due_session = sessionCount;
    await K.kvWriteSafe("dr:state:1", state);
  }

  if (state.status === "idle") {
    if (!await isDrDue(K, state)) return;

    const dispatch = await dispatchDr(K, defaults);
    if (!dispatch) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = "dispatch failed";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_dispatch_failed" });
      return;
    }

    state.status = "dispatched";
    state.generation = (state.generation || 0) + 1;
    state.job_id = dispatch.job_id;
    state.workdir = dispatch.workdir;
    state.dispatched_at = new Date().toISOString();
    state.completed_at = null;
    state.applied_at = null;
    state.failed_at = null;
    state.failure_reason = null;
    await K.kvWriteSafe("dr:state:1", state);
    await K.karmaRecord({ event: "dr_dispatched", job_id: dispatch.job_id, generation: state.generation });
  }
}

async function isDrDue(K, state) {
  if (!state.generation) return true;
  const sessionCount = await K.getSessionCount();
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;
  return false;
}

async function dispatchDr(K, defaults) {
  const prompt = await K.kvGet("prompt:deep_reflect");
  if (!prompt) return null;

  const result = await K.executeToolCall({
    id: `dr_dispatch_${Date.now()}`,
    function: {
      name: "start_job",
      arguments: JSON.stringify({
        type: "cc_analysis",
        prompt,
        context_keys: [
          "samskara:*", "experience:*", "desire:*",
          "principle:*", "config:defaults",
          "reflect:1:*", "last_reflect",
        ],
      }),
    },
  });

  if (!result?.ok) return null;
  return { job_id: result.job_id, workdir: result.workdir };
}

async function pollJobResult(K, state, defaults) {
  const jobs = defaults?.jobs || {};

  let checkResult;
  try {
    checkResult = await K.executeAdapter("provider:compute", {
      command: `test -f ${state.workdir}/exit_code && cat ${state.workdir}/exit_code || echo RUNNING`,
      baseUrl: jobs.base_url, timeout: 5,
    });
  } catch {
    return { status: "running" };
  }

  if (!checkResult?.ok) return { status: "running" };

  const exitText = Array.isArray(checkResult.output)
    ? checkResult.output.map(o => o.data || '').join('').trim()
    : String(checkResult.output || '').trim();

  if (exitText === "RUNNING") return { status: "running" };

  const exitCode = parseInt(exitText, 10);
  if (exitCode !== 0) return { status: "failed", error: `exit code ${exitCode}` };

  let outputResult;
  try {
    outputResult = await K.executeAdapter("provider:compute", {
      command: `cat ${state.workdir}/output.json 2>/dev/null || echo '{}'`,
      baseUrl: jobs.base_url, timeout: 10,
    });
  } catch {
    return { status: "failed", error: "could not read output" };
  }

  if (!outputResult?.ok) return { status: "failed", error: "could not read output" };

  const raw = Array.isArray(outputResult.output)
    ? outputResult.output.map(o => o.data || '').join('')
    : String(outputResult.output || '');

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.reflection && !parsed.kv_operations?.length) {
      return { status: "failed", error: "output.json has no reflection or kv_operations" };
    }
    return { status: "completed", output: parsed };
  } catch {
    return { status: "failed", error: "invalid JSON in output.json" };
  }
}

async function applyDrResults(K, state, output) {
  const sessionId = await K.getSessionId();

  const ops = (output.kv_operations || []).filter(op =>
    op.key?.startsWith("samskara:") || op.key?.startsWith("desire:")
  );

  const blocked = [];
  for (const op of ops) {
    const result = await K.kvWriteGated(op, "deep-reflect");
    if (!result.ok) blocked.push({ key: op.key, error: result.error });
  }

  if (blocked.length > 0) {
    await K.karmaRecord({ event: "dr_apply_blocked", blocked, applied: ops.length - blocked.length });
  }

  await K.kvWriteSafe(`reflect:1:${sessionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
  });

  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    was_deep_reflect: true,
    depth: 1,
    session_id: sessionId,
  });
}

async function updateJobRecord(K, jobId, status) {
  const record = await K.kvGet(`job:${jobId}`);
  if (record) {
    record.status = status;
    record.completed_at = new Date().toISOString();
    await K.kvWriteSafe(`job:${jobId}`, record);
  }
}

// ── Main session hook ───────────────────────────────────────

export async function run(K, { crashData, balances, events, schedule }) {
  let actResult = {};

  // Independent concern 1: act cycle
  try {
    actResult = await actCycle(K, { crashData, balances, events, schedule });
  } catch (e) {
    await K.karmaRecord({ event: "act_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Independent concern 2: DR lifecycle
  try {
    await drCycle(K);
  } catch (e) {
    await K.karmaRecord({ event: "dr_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Schedule next (always runs, even if above failed)
  try {
    const defaults = actResult.defaults || await K.getDefaults();
    const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
      interval_seconds: scheduleInterval,
    });
  } catch (e) {
    await K.karmaRecord({ event: "schedule_update_error", error: e.message });
  }

  // Session complete (always fires)
  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "session_complete",
    cycles_run: actResult.cyclesRun || 0,
    total_cost: finalCost,
  });
}

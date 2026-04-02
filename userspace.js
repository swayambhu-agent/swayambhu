// Swayambhu — Userspace (cognitive policy)
// Entry point for all scheduled cognitive work: act cycle + DR dispatch.
// Called by kernel via HOOKS.session.run(K, { crashData, balances, events, schedule }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { runReflect, highestReflectDepthDue, isReflectDue, applyReflectOutput } from './reflect.js';
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
      await K.kvWriteSafe(key, { ...existing, strength: newStrength });
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

// ── Main session hook ───────────────────────────────────────

export async function run(K, { crashData, balances, events, schedule }) {
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

  // 2c. Process deep-reflect job completions from events
  for (const event of (events || [])) {
    if (event.type === "job_complete" && event.source?.job_id) {
      const job = await K.kvGet(`job:${event.source.job_id}`);
      if (job?.config?.deep_reflect) {
        // Check staleness
        const maxStale = defaults?.deep_reflect?.max_stale_sessions || 5;
        const sessionCount = await K.getSessionCount();
        const dispatchSession = job.config?.dispatch_session || 0;
        if (sessionCount - dispatchSession > maxStale) {
          await K.karmaRecord({ event: "deep_reflect_stale", job_id: job.id, age_sessions: sessionCount - dispatchSession });
          continue;
        }

        // Read result
        const resultKey = `job_result:${job.id}`;
        const jobResult = await K.kvGet(resultKey);
        if (jobResult?.result) {
          // Filter kv_operations to only desire:*/samskara:*
          const output = { ...jobResult.result };
          if (output.kv_operations) {
            output.kv_operations = output.kv_operations.filter(op =>
              op.key?.startsWith("desire:") || op.key?.startsWith("samskara:")
            );
          }

          // Apply via existing applyReflectOutput
          const state = { defaults, modelsConfig };
          await applyReflectOutput(K, state, job.config.depth || 1, output, { fromJob: job.id });

          await K.karmaRecord({
            event: "deep_reflect_applied",
            job_id: job.id,
            operations: output.kv_operations?.length || 0,
          });

          // Re-snapshot (desires/samskaras may have changed)
          desires = await loadDesires(K);
          samskaras = await loadSamskaras(K);
        }
      }
    }
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

  // 7. Per-depth reflect dispatch
  const state = { defaults, modelsConfig, desires };
  const maxDepth = defaults?.execution?.max_reflect_depth || 1;
  for (let d = maxDepth; d >= 1; d--) {
    if (await isReflectDue(K, state, d)) {
      await runReflect(K, state, d, {});
    }
  }

  // 8. Update session schedule
  const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
    interval_seconds: scheduleInterval,
  });

  // 9. Karma log session complete
  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "session_complete",
    cycles_run: cyclesRun,
    total_cost: finalCost,
  });
}

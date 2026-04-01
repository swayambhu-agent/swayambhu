// Swayambhu — Session Hook (Module 3)
// Main session entry point: plan → act → eval → review cycle.
// Called by kernel via HOOKS.session.run(K, { crashData, balances, events, schedule }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { runReflect, highestReflectDepthDue } from './reflect.js';
import { evaluateAction } from './eval.js';
import { updateMu, callInference, embeddingCacheKey } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatAssumptions, formatCircumstances } from './act.js';

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

async function loadAssumptions(K) {
  const list = await K.kvList({ prefix: "assumption:" });
  const now = Date.now();
  const assumptions = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (!val) continue;
    // Filter expired TTLs
    if (val.ttl_expires && new Date(val.ttl_expires).getTime() < now) continue;
    assumptions[entry.name] = val;
  }
  return assumptions;
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

async function planPhase(K, { desires, assumptions, circumstances, defaults, modelsConfig }) {
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const planPrompt = await K.kvGet("prompt:plan");
  const systemPrompt = planPrompt
    ? await K.buildPrompt(planPrompt, { config: defaults })
    : "You are a planning agent. Given desires, assumptions, and circumstances, output a JSON action plan.";

  const userContent = [
    "[DESIRES]", formatDesires(desires), "",
    "[ASSUMPTIONS]", formatAssumptions(assumptions), "",
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
  });

  let plan;
  try {
    plan = JSON.parse(response.content);
  } catch {
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
    });
    try {
      plan = JSON.parse(retry.content);
    } catch {
      await K.karmaRecord({ event: "plan_parse_failure", raw: response.content?.slice(0, 500) });
      return null;
    }
  }

  if (plan.no_action) return plan;

  // Validate relies_on slugs against assumption snapshot
  if (plan.relies_on?.length) {
    const knownSlugs = new Set(Object.values(assumptions).map(a => a.slug));
    const unknown = plan.relies_on.filter(s => !knownSlugs.has(s));
    if (unknown.length) {
      await K.karmaRecord({
        event: "plan_unknown_relies_on",
        unknown_slugs: unknown,
        stripped: true,
      });
      plan.relies_on = plan.relies_on.filter(s => knownSlugs.has(s));
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
    `assumptions_relied_on: ${JSON.stringify(evalResult.assumptions_relied_on)}`,
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
  });

  let review;
  try {
    review = JSON.parse(response.content);
  } catch {
    await K.karmaRecord({ event: "review_parse_failure", raw: response.content?.slice(0, 500) });
    return null;
  }

  return review;
}

// ── Memory writes ───────────────────────────────────────────

async function writeMemory(K, { ledger, evalResult, review, desires, assumptions, inferenceConfig }) {
  const now = new Date().toISOString();

  // μ writes — from eval's mechanical assumption_scores (not review's LLM output)
  if (evalResult.assumption_scores) {
    for (const [checkId, score] of Object.entries(evalResult.assumption_scores)) {
      const muKey = `mu:${checkId}`;
      const existing = await K.kvGet(muKey);
      const updated = updateMu(existing, checkId, score);
      await K.kvWriteSafe(muKey, updated);
    }
  }

  // ε writes — if salience exceeds threshold
  const salienceThreshold = 0.5;
  const salience = evalResult.salience > 0
    ? evalResult.salience
    : (review?.salience_estimate || 0);

  if (salience > salienceThreshold) {
    let embedding = null;
    if (inferenceConfig) {
      try {
        const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
          texts: [review?.narrative || review?.assessment || '']
        });
        embedding = resp.embeddings?.[0] || null;
      } catch {
        await K.karmaRecord({ event: "experience_embedding_failed" });
      }
    }

    const experienceKey = `experience:${Date.now()}`;
    await K.kvWriteSafe(experienceKey, {
      timestamp: now,
      action_taken: ledger.plan.action,
      outcome: ledger.final_text || review?.assessment,
      active_assumptions: ledger.plan.relies_on || [],
      active_desires: Object.keys(desires),
      surprise_score: evalResult.sigma,
      affinity_vector: evalResult.alpha,
      narrative: review?.narrative || review?.assessment,
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

  // 2. Snapshot desires and assumptions
  const desires = await loadDesires(K);
  const assumptions = await loadAssumptions(K);

  // 2b. Cache embeddings for Tier 1 relevance filtering
  if (inferenceConfig) {
    const embedModel = defaults?.inference?.embed_model || 'bge-small-en-v1.5';
    await cacheEmbeddings(K, desires, 'description', embedModel, inferenceConfig);
    await cacheEmbeddings(K, assumptions, 'check', embedModel, inferenceConfig);
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
    const plan = await planPhase(K, { desires, assumptions, circumstances, defaults, modelsConfig });
    if (!plan) break; // parse failure
    if (plan.no_action) {
      await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });
      break;
    }

    // 6c. Act phase
    const ledger = await actPhase(K, {
      plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults,
    });

    // 6d. Eval phase
    const evalResult = await evaluateAction(K, ledger, desires, assumptions, inferenceConfig || {});

    // 6e. Review phase
    const review = await reviewPhase(K, { ledger, evalResult, defaults });

    // 6f. Memory writes
    await writeMemory(K, { ledger, evalResult, review, desires, assumptions, inferenceConfig });

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

  // 7. Check deep-reflect due
  const state = { defaults, modelsConfig };
  const reflectDepth = await highestReflectDepthDue(K, state);
  if (reflectDepth > 0) {
    await runReflect(K, state, reflectDepth, {});
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

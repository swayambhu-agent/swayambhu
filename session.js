// Swayambhu — Session Hook (Module 3)
// Main session entry point: plan → act → eval → review cycle.
// Called by kernel via HOOKS.session.run(K, { crashData, balances, events, schedule }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { runReflect, highestReflectDepthDue } from './reflect.js';
import { evaluateAction } from './eval.js';

// ── Local helpers (move to act.js in Task 5) ────────────────

async function renderActPrompt(K, { defaults }) {
  const actPrompt = await K.kvGet("prompt:act");
  if (!actPrompt) return "You are a helpful agent. Execute the planned action using available tools.";
  return K.buildPrompt(actPrompt, { config: defaults });
}

async function buildToolSet(K) {
  return K.buildToolDefinitions();
}

function formatDesires(d) {
  return JSON.stringify(Object.entries(d).map(([key, val]) => ({
    key, slug: val.slug, direction: val.direction, description: val.description,
  })), null, 2);
}

function formatAssumptions(m) {
  return JSON.stringify(Object.entries(m).map(([key, val]) => ({
    key, slug: val.slug, check: val.check, confidence: val.confidence, ttl_expires: val.ttl_expires,
  })), null, 2);
}

function formatCircumstances(c) {
  return JSON.stringify(c, null, 2);
}

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
    "",
    `candidate_check_ids: ${JSON.stringify(evalResult.candidate_check_ids)}`,
    "IMPORTANT: mu_updates check_ids MUST come from candidate_check_ids above. Unknown IDs will be stripped.",
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
    "Respond with JSON: { assessment, narrative, salience_estimate, mu_updates: [{ check_id, confirmed }] }",
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

  // Validate check_ids
  if (review.mu_updates?.length) {
    const allowed = new Set(evalResult.candidate_check_ids || []);
    const unknown = review.mu_updates.filter(u => !allowed.has(u.check_id));
    if (unknown.length) {
      await K.karmaRecord({
        event: "review_unknown_check_ids",
        unknown: unknown.map(u => u.check_id),
        stripped: true,
      });
      review.mu_updates = review.mu_updates.filter(u => allowed.has(u.check_id));
    }
  }

  return review;
}

// ── Memory writes ───────────────────────────────────────────

async function writeMemory(K, { ledger, evalResult, review, desires, assumptions }) {
  const now = new Date().toISOString();

  // μ writes — always, for each mu_update
  if (review?.mu_updates?.length) {
    for (const update of review.mu_updates) {
      const muKey = `mu:${update.check_id}`;
      const existing = await K.kvGet(muKey) || {
        check_id: update.check_id,
        confirmation_count: 0,
        violation_count: 0,
        last_checked: null,
      };

      if (update.confirmed) {
        existing.confirmation_count = (existing.confirmation_count || 0) + 1;
      } else {
        existing.violation_count = (existing.violation_count || 0) + 1;
      }
      existing.last_checked = now;

      await K.kvWriteSafe(muKey, existing);
    }
  }

  // ε writes — if salience exceeds threshold
  const salienceThreshold = 0.5;
  const salience = evalResult.salience > 0
    ? evalResult.salience
    : (review?.salience_estimate || 0);

  if (salience > salienceThreshold) {
    const episodeKey = `episode:${Date.now()}`;
    await K.kvWriteSafe(episodeKey, {
      action_id: ledger.action_id,
      plan: ledger.plan,
      tool_outcomes: evalResult.tool_outcomes,
      assessment: review?.assessment,
      narrative: review?.narrative,
      salience,
      sigma: evalResult.sigma,
      timestamp: now,
    });
  }
}

// ── Main session hook ───────────────────────────────────────

export async function run(K, { crashData, balances, events, schedule }) {
  // 1. Load config
  const defaults = await K.getDefaults();
  const modelsConfig = await K.getModelsConfig();

  // 2. Snapshot desires and assumptions
  const desires = await loadDesires(K);
  const assumptions = await loadAssumptions(K);

  // 3. Cold start: no desires → deep reflect to derive them
  if (Object.keys(desires).length === 0) {
    await K.karmaRecord({ event: "cold_start", reason: "no desires found" });

    const state = { defaults, modelsConfig };
    await runReflect(K, state, 1, { coldStart: true });

    // Schedule next session soon so we can act on new desires
    const interval = 60; // seconds
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + interval * 1000).toISOString(),
      interval_seconds: interval,
      reason: "post_cold_start",
    });

    return;
  }

  // 4. Build initial circumstances
  let circumstances = buildCircumstances(events, balances, crashData);

  // 5. Build system prompt, tools, model
  const systemPrompt = await renderActPrompt(K, { defaults });
  const tools = await buildToolSet(K);
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const effort = defaults?.act?.effort || "low";
  const maxTokens = defaults?.act?.max_output_tokens || 4000;

  // 6. Shared messages array
  const messages = [];

  // 7. Main loop
  const maxCycles = 10;
  const budget = defaults?.session_budget || {};
  const maxCost = budget.max_cost || 0.50;
  const minReviewCost = defaults?.session?.min_review_cost || 0.05;
  let cyclesRun = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // 7a. Budget preflight
    const spent = await K.getSessionCost();
    if (spent + minReviewCost >= maxCost) {
      await K.karmaRecord({ event: "session_budget_exhausted", spent, cycle });
      break;
    }

    // 7b. Plan phase
    const plan = await planPhase(K, { desires, assumptions, circumstances, defaults, modelsConfig });
    if (!plan) break; // parse failure
    if (plan.no_action) {
      await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });
      break;
    }

    // 7c. Act phase
    const ledger = await actPhase(K, {
      plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults,
    });

    // 7d. Eval phase
    const evalResult = evaluateAction(ledger, desires, assumptions);

    // 7e. Review phase
    const review = await reviewPhase(K, { ledger, evalResult, defaults });

    // 7f. Memory writes
    await writeMemory(K, { ledger, evalResult, review, desires, assumptions });

    cyclesRun++;

    // 7g. Refresh circumstances
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

  // 8. Check deep-reflect due
  const state = { defaults, modelsConfig };
  const reflectDepth = await highestReflectDepthDue(K, state);
  if (reflectDepth > 0) {
    await runReflect(K, state, reflectDepth, {});
  }

  // 9. Update session schedule
  const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
    interval_seconds: scheduleInterval,
  });

  // 10. Karma log session complete
  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "session_complete",
    cycles_run: cyclesRun,
    total_cost: finalCost,
  });
}

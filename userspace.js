// Swayambhu — Userspace (cognitive policy)
// Entry point for all scheduled cognitive work: act cycle + DR lifecycle.
// Called by kernel on every cron tick via HOOKS.tick.run(K, { crashData, balances, events }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { evaluateAction } from './eval.js';
import { updatePatternStrength, callInference, embeddingCacheKey } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatPatterns, formatCircumstances } from './act.js';
import { executeReflect } from './reflect.js';
import { parseJobOutput } from './lib/parse-job-output.js';
import { writeReasoningArtifacts } from "./lib/reasoning.js";

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

async function loadPatterns(K) {
  const list = await K.kvList({ prefix: "pattern:" });
  const patterns = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (val) patterns[entry.name] = val;
  }
  return patterns;
}

// ── Plan prompt vars ────────────────────────────────────────

const COMMS_TOOLS = new Set(["send_slack", "send_whatsapp", "send_email", "check_email"]);

async function loadPlanVars(K, defaults) {
  const subagents = await K.kvGet("config:subagents");
  const skillList = await K.kvList({ prefix: "skill:", limit: 100 });
  const skills = [];
  for (const k of skillList.keys) {
    if (k.name.includes(":ref")) continue;
    const v = await K.kvGet(k.name);
    if (v) {
      try {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        skills.push({ key: k.name, name: parsed.name, description: parsed.description });
      } catch {}
    }
  }

  // Tool manifest for planner — names and descriptions, excluding comms tools
  const allTools = await K.buildToolDefinitions();
  const tools = allTools
    .filter(t => !COMMS_TOOLS.has(t.function.name))
    .map(t => ({ name: t.function.name, description: t.function.description }));

  return {
    config: defaults,
    tools: tools.length ? tools : null,
    skill_manifest: skills.length ? skills : null,
    subagents: subagents || null,
  };
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

async function planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems }) {
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const planPrompt = await K.kvGet("prompt:plan");
  const systemPrompt = planPrompt
    ? await K.buildPrompt(planPrompt, await loadPlanVars(K, defaults))
    : "You are a planning agent. Given desires, patterns, and circumstances, output a JSON action plan.";

  // Load tactics — agent-managed behavioral rules, injected into planner context
  // alongside desires (not kernel-injected, because they're not safety invariants)
  const tacticList = await K.kvList({ prefix: "tactic:" });
  const tactics = [];
  for (const entry of tacticList.keys) {
    const val = await K.kvGet(entry.name);
    if (val) tactics.push({ key: entry.name, ...(typeof val === 'string' ? { description: val } : val) });
  }

  const sections = [
    "[DESIRES]", formatDesires(desires), "",
    "[PATTERNS]", formatPatterns(patterns), "",
  ];
  if (tactics.length) {
    sections.push("[TACTICS]");
    for (const t of tactics) {
      sections.push(`- ${t.slug || t.key}: ${t.description}`);
    }
    sections.push("");
  }
  if (carryForwardItems?.length) {
    sections.push("[CARRY-FORWARD]", "(plans from previous session — continue or re-evaluate; desires remain the authority)");
    for (const item of carryForwardItems) {
      const priority = item.priority ? `[${item.priority}] ` : "";
      const why = item.why ? ` — ${item.why}` : "";
      const desire = item.desire_key ? ` (supports ${item.desire_key})` : "";
      sections.push(`- ${priority}${item.item}${why}${desire}`);
    }
    sections.push("");
  }
  sections.push("[CIRCUMSTANCES]", formatCircumstances(circumstances));
  if (priorActions?.length) {
    sections.push("", "[PRIOR ACTIONS THIS SESSION]");
    for (const pa of priorActions) {
      const tools = pa.tools.length ? ` [${pa.tools.join(", ")}]` : "";
      const findings = Array.isArray(pa.key_findings) ? pa.key_findings.join("; ") : pa.key_findings || "";
      let line = `- ${pa.action}${tools}`;
      if (pa.accomplished) line += ` → ${pa.accomplished}`;
      if (findings) line += ` | Findings: ${findings}`;
      if (pa.next_gap) line += ` | Gap: ${pa.next_gap}`;
      sections.push(line);
    }
  }
  sections.push(
    "",
    "Respond with a JSON plan object: { action, success, relies_on, defer_if, no_action }",
    "If no action is warranted, respond: { no_action: true, reason: \"...\" }",
  );
  const userContent = sections.join("\n");

  const response = await K.callLLM({
    model,
    step: "plan",
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
      step: "plan_retry",
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

  // Validate relies_on keys against desire + pattern + tactic snapshots
  // tacticList is in scope from the tactic loading above (line 123)
  if (plan.relies_on?.length) {
    const knownKeys = new Set([...Object.keys(desires), ...Object.keys(patterns), ...tacticList.keys.map(k => k.name)]);
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

  for (let actStep = 0; actStep < maxActSteps; actStep++) {
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
      step: `act_${actStep}`,
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
    `patterns_relied_on: ${JSON.stringify(evalResult.patterns_relied_on)}`,
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
    "Respond with JSON: { assessment, narrative, salience_estimate, accomplished, key_findings, next_gap }",
    "- accomplished: one sentence summary of what was achieved",
    "- key_findings: array of 1-3 short factual findings",
    "- next_gap: one sentence describing what remains unknown or unfinished (or null if complete)",
  ].join("\n");

  const maxTokens = defaults?.reflect?.max_output_tokens || 1000;
  const response = await K.callLLM({
    model,
    effort: defaults?.reflect?.effort || "medium",
    maxTokens,
    systemPrompt: finalSystem,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    step: "review",
    json: true,
  });

  // Retry once with 2x tokens if truncated (finish_reason was "length")
  if (!response.parsed && response.finish_reason === "length") {
    await K.karmaRecord({ event: "review_truncated_retry", original_tokens: maxTokens });
    const retry = await K.callLLM({
      model,
      effort: defaults?.reflect?.effort || "medium",
      maxTokens: maxTokens * 2,
      systemPrompt: finalSystem,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: response.content || "" },
        { role: "user", content: "Your response was truncated. Be more concise. Respond with ONLY the JSON object." },
      ],
      tools: [],
      step: "review_retry",
      json: true,
    });
    if (retry.parsed) return retry.parsed;
  }

  if (!response.parsed) {
    await K.karmaRecord({ event: "review_parse_failure", raw: response.content?.slice(0, 500) });
    return null;
  }

  return response.parsed;
}

// ── Memory writes ───────────────────────────────────────────

async function writeMemory(K, { ledger, evalResult, review, desires, patterns, inferenceConfig, executionId, sessionNumber, cycle }) {
  const now = new Date().toISOString();
  const cap = (s, n = 500) => s && s.length > n ? s.slice(0, n) + '…' : s;

  // Action record — structured audit trail
  await K.kvWriteSafe(`action:${ledger.action_id}`, {
    kind: ledger.plan?.no_action ? "no_action" : "action",
    timestamp: now,
    execution_id: executionId || null,
    session_number: sessionNumber || null,
    cycle: cycle ?? null,
    plan: ledger.plan,
    tool_calls: ledger.tool_calls.map(tc => ({
      tool: tc.tool,
      ok: tc.ok,
      input_preview: cap(typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)),
      output_preview: cap(typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output)),
    })),
    final_text: cap(ledger.final_text, 1000),
    eval: {
      sigma: evalResult.sigma,
      salience: evalResult.salience,
      method: evalResult.eval_method,
      tool_outcomes: evalResult.tool_outcomes,
    },
    review: review ? {
      assessment: review.assessment,
      narrative: review.narrative,
    } : null,
  });

  // Pattern strength updates — from eval's per-pattern surprise scores
  if (evalResult.pattern_scores) {
    for (const [key, score] of Object.entries(evalResult.pattern_scores)) {
      const existing = patterns[key];
      if (!existing) continue;
      const newStrength = updatePatternStrength(existing.strength, score.surprise);
      await K.kvWriteGated({ op: "put", key, value: { ...existing, strength: newStrength } }, "act");
    }
  }

  // Experience writes — if salience exceeds threshold
  const salienceThreshold = 0.5;
  // Clamp review fallback to [0,1] — some review models output uncalibrated values > 1.
  const rawSalience = evalResult.salience > 0
    ? evalResult.salience
    : Math.min(1, Math.max(0, review?.salience_estimate || 0));

  // For no_action: use sigma-only salience. NLI classifies long-horizon aspirational
  // desires as "contradicted" by no-action outcome text (false positive — not acting
  // does not falsify "I have demonstrated usefulness"). Only pattern surprise (sigma)
  // is semantically meaningful for abstention events. Raw evalResult.salience is still
  // preserved in the action:* audit record for diagnostics.
  //
  // Note: this assumes desires are approach-only target states requiring action to
  // advance. If tactical desires are added that can be entailed by principled
  // abstention, this gate should be revisited.
  const salience = ledger.plan?.no_action
    ? evalResult.sigma
    : rawSalience;

  if (salience > salienceThreshold) {
    let embedding = null;
    if (inferenceConfig) {
      try {
        // 30s timeout prevents cold-start inference latency from exhausting session budget.
        // Promise.race abandons the await; CF runtime cancels the in-flight request when the worker completes.
        const embedTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("embedding_timeout")), 30000)
        );
        const resp = await Promise.race([
          callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
            texts: [review?.narrative || review?.assessment || ledger.final_text || '']
          }),
          embedTimeout,
        ]);
        embedding = resp.embeddings?.[0] || null;
      } catch (err) {
        const event = err?.message === "embedding_timeout"
          ? "experience_embedding_timeout"
          : "experience_embedding_failed";
        await K.karmaRecord({ event });
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
    await K.karmaRecord({ event: "experience_written", key: experienceKey, salience, sigma: evalResult.sigma });
  } else {
    await K.karmaRecord({ event: "experience_skipped", salience, sigma: evalResult.sigma, threshold: salienceThreshold });
  }
}

// ── Act cycle ─────────────────────────────────────────────

async function actCycle(K, { crashData, balances, events }) {
  // Crash experience synthesis — write what happened so DR can learn.
  // The kernel detects crashes and passes the dead session's karma.
  // Userspace interprets it into an experience (cognitive concept).
  if (crashData?.dead_execution_id) {
    const marker = `crash_memory:${crashData.dead_execution_id}`;
    const alreadyWritten = await K.kvGet(marker);
    if (!alreadyWritten) {
      const karma = crashData.karma || [];
      const llmCalls = karma.filter(e => e.event === 'llm_call').length;
      const toolCalls = karma.filter(e => e.event === 'tool_start').length;
      const lastEvent = crashData.last_entry || {};
      const elapsed = lastEvent.elapsed_ms ? Math.round(lastEvent.elapsed_ms / 1000) : 0;
      const lastStep = lastEvent.step || lastEvent.tool || lastEvent.event || 'unknown';
      const cost = karma.filter(e => e.event === 'llm_call').reduce((s, e) => s + (e.cost || 0), 0);

      await K.kvWriteSafe(`experience:${Date.now()}`, {
        timestamp: new Date().toISOString(),
        action_taken: "session_killed",
        outcome: `Session ${crashData.dead_execution_id} killed after ${elapsed}s. ${llmCalls} LLM calls, ${toolCalls} tool calls, $${cost.toFixed(4)} spent. Last activity: ${lastStep}. Probable cause: execution time limit exceeded.`,
        surprise_score: 1,
        salience: 1,
        narrative: `A session was killed before it could complete. The last activity was ${lastStep} after ${elapsed}s of execution. This is a crash the agent should learn from — either sessions need to be shorter, or the activity that caused the hang should be avoided.`,
        embedding: null,
      });
      await K.kvWriteSafe(marker, { written_at: new Date().toISOString() }, { unprotected: true });
      await K.karmaRecord({ event: "crash_experience_written", dead_execution_id: crashData.dead_execution_id });
    }
  }

  // Schedule gate — userspace decides if it's time
  const schedule = await K.kvGet("session_schedule");
  if (schedule?.next_session_after) {
    if (Date.now() < new Date(schedule.next_session_after).getTime()) {
      return { skipped: true };
    }
  }

  // Session bookkeeping — userspace concept
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  await K.kvWriteSafe("session_counter", sessionCount + 1);

  const sessionIds = (await K.kvGet("cache:session_ids")) || [];
  const executionId = await K.getExecutionId();
  sessionIds.push(executionId);
  await K.kvWriteSafe("cache:session_ids", sessionIds);

  await K.karmaRecord({
    event: "act_start",
    session_number: sessionCount + 1,
    scheduled_at: schedule?.next_session_after || null,
    crash_detected: !!crashData,
    balances,
  });

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

  // 2. Snapshot desires and patterns
  let desires = await loadDesires(K);
  let patterns = await loadPatterns(K);

  // 2c. Load carry-forward items from last session's reflect output
  const lastReflect = await K.kvGet("last_reflect");
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const carryForwardItems = (lastReflect?.carry_forward || [])
    .filter(item => item.status === "active")
    .filter(item => !item.expires_at || new Date(item.expires_at).getTime() >= Date.now())
    .sort((a, b) => {
      const priorityDelta = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
    })
    .slice(0, 5);

  // 2b. Cache embeddings for Tier 1 relevance filtering
  if (inferenceConfig) {
    const embedModel = defaults?.inference?.embed_model || 'bge-small-en-v1.5';
    await cacheEmbeddings(K, desires, 'description', embedModel, inferenceConfig);
    await cacheEmbeddings(K, patterns, 'pattern', embedModel, inferenceConfig);
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

  // 5b. Load recent actions from KV for cross-session planner context
  const actionKeys = await K.kvList({ prefix: "action:" });
  const recentActionKeys = actionKeys.keys
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-5);
  const priorActions = [];
  for (const ak of recentActionKeys) {
    const rec = await K.kvGet(ak.name);
    if (!rec) continue;
    priorActions.push({
      action: rec.plan?.action || rec.plan?.reason || "no_action",
      tools: (rec.tool_calls || []).map(tc => tc.tool),
      accomplished: rec.review?.accomplished || String(rec.review?.narrative || "").slice(0, 150) || null,
      key_findings: rec.review?.key_findings || null,
      next_gap: rec.review?.next_gap || null,
    });
  }

  // 6. Main loop
  const maxCycles = 10;
  const budget = defaults?.session_budget || {};
  const maxCost = budget.max_cost || 0.50;
  // Reserve budget for eval+review+reflect — derived from config, not hardcoded
  const reflectReservePct = budget.reflect_reserve_pct || 0.33;
  const actBudgetCap = maxCost * (1 - reflectReservePct);
  let cyclesRun = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // 6a. Budget preflight — stop act cycles when reserve is reached
    const spent = await K.getSessionCost();
    if (spent >= actBudgetCap) {
      await K.karmaRecord({ event: "session_budget_exhausted", spent, cycle, act_cap: actBudgetCap });
      break;
    }

    // 6b. Plan phase
    const plan = await planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems });
    if (!plan) break; // parse failure
    if (plan.no_action) {
      await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });

      // Still run eval + memory so the experience gets recorded. When
      // patterns are empty, eval returns σ=1 (max surprise) — this is
      // what bootstraps the agent by making "no desires" a high-salience
      // experience that reflect can act on.
      const noActionLedger = {
        action_id: `a_${Date.now()}_noaction`,
        plan,
        tool_calls: [],
        final_text: plan.reason,
      };
      const evalResult = await evaluateAction(K, noActionLedger, desires, patterns, inferenceConfig || {});
      const syntheticReview = {
        assessment: "no_action",
        narrative: `No action taken: ${plan.reason}`,
        salience_estimate: evalResult.salience || 0,
      };
      await writeMemory(K, { ledger: noActionLedger, evalResult, review: syntheticReview, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

      break;
    }

    // 6c. Act phase
    const ledger = await actPhase(K, {
      plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults,
    });

    // 6d. Eval phase
    const evalResult = await evaluateAction(K, ledger, desires, patterns, inferenceConfig || {});

    // 6e. Review phase
    const review = await reviewPhase(K, { ledger, evalResult, defaults });

    // 6f. Memory writes
    await writeMemory(K, { ledger, evalResult, review, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

    cyclesRun++;

    // 6g. Record outcome for planner
    priorActions.push({
      action: plan.action,
      tools: ledger.tool_calls.map(tc => tc.tool),
      accomplished: review?.accomplished || ledger.final_text?.slice(0, 150) || null,
      key_findings: review?.key_findings || null,
      next_gap: review?.next_gap || null,
    });

    // 6h. Refresh circumstances
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

  // Emit session_complete if any actions were taken
  if (cyclesRun > 0) {
    const summary = priorActions.map(pa => `${pa.action} [${pa.tools.join(",")}] → ${pa.review}`).join("; ");
    await K.emitEvent("session_complete", {
      contact: (await K.kvGet("patron:contact")) || null,
      actions_summary: summary || "session completed",
      cycles: cyclesRun,
    });
  }

  // Schedule next session
  const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
    interval_seconds: scheduleInterval,
  });

  // Session complete
  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "act_complete",
    cycles_run: cyclesRun,
    total_cost: finalCost,
  });

  return { defaults, modelsConfig, desires, patterns, cyclesRun };
}

// ── DR Lifecycle (independent state machine) ──────────────

async function drCycle(K) {
  const defaults = await K.getDefaults();
  const sessionCount = (await K.kvGet("session_counter")) || 0;
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
      state.last_failure_session = sessionCount;
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
      state.last_failure_session = sessionCount;
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
      state.last_failure_session = sessionCount;
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    await applyDrResults(K, state, output);

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = sessionCount;
    state.last_execution_id = await K.getExecutionId();
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
      state.last_failure_session = sessionCount;
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
  const sessionCount = (await K.kvGet("session_counter")) || 0;
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
        // Reasoning artifacts live on the shared filesystem at
        // /home/swayambhu/reasoning/. Deep-reflect reads them directly;
        // they are not packed into the KV tarball context.
        context_keys: [
          "pattern:*", "experience:*", "desire:*", "tactic:*",
          "action:*", "principle:*",
          "config:defaults", "config:models", "config:model_capabilities",
          "config:tool_registry", "config:event_handlers",
          "prompt:plan", "prompt:act", "prompt:reflect", "prompt:communication",
          "kernel:source_map",
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
  const esc = s => s.replace(/'/g, "'\\''");

  let checkResult;
  try {
    checkResult = await K.executeAdapter("provider:compute", {
      command: `test -f '${esc(state.workdir)}/exit_code' && cat '${esc(state.workdir)}/exit_code' || echo RUNNING`,
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
      command: `cat '${esc(state.workdir)}/output.json' 2>/dev/null || echo '{}'`,
      baseUrl: jobs.base_url, timeout: 10,
    });
  } catch {
    return { status: "failed", error: "could not read output" };
  }

  if (!outputResult?.ok) return { status: "failed", error: "could not read output" };

  const raw = Array.isArray(outputResult.output)
    ? outputResult.output.map(o => o.data || '').join('')
    : String(outputResult.output || '');

  const { payload, meta } = parseJobOutput(raw);
  if (!payload) {
    return { status: "failed", error: "could not parse output.json" };
  }
  if (!payload.reflection && !payload.kv_operations?.length) {
    return { status: "failed", error: "output.json has no reflection or kv_operations" };
  }
  return { status: "completed", output: payload, meta };
}

export async function applyDrResults(K, state, output) {
  const executionId = await K.getExecutionId();

  const ops = (output.kv_operations || []).filter(op =>
    op.key?.startsWith("pattern:") || op.key?.startsWith("desire:") ||
    op.key?.startsWith("tactic:") || op.key?.startsWith("principle:") ||
    op.key?.startsWith("config:") || op.key?.startsWith("prompt:")
  );

  const blocked = [];
  for (const op of ops) {
    // Preserve the full op shape — DR may use patch + deliberation for principles
    const gatedOp = op.op === "delete"
      ? { key: op.key, op: "delete" }
      : op.op === "patch"
      ? { key: op.key, op: "patch", old_string: op.old_string, new_string: op.new_string, deliberation: op.deliberation }
      : { key: op.key, op: "put", value: op.value, ...(op.deliberation ? { deliberation: op.deliberation } : {}) };
    const result = await K.kvWriteGated(gatedOp, "deep-reflect");
    if (!result.ok) blocked.push({ key: op.key, error: result.error });
  }

  // Code staging — DR can stage code changes for governor deployment
  if (output.code_stage_requests?.length) {
    for (const req of output.code_stage_requests) {
      try {
        await K.stageCode(req.target, req.code);
      } catch (err) {
        blocked.push({ key: req.target, error: err.message });
      }
    }
    if (output.deploy) {
      await K.signalDeploy();
      await K.karmaRecord({ event: "deploy_requested_by_dr", staged: output.code_stage_requests.length });
    }
  }

  if (blocked.length > 0) {
    await K.karmaRecord({ event: "dr_apply_blocked", blocked, applied: ops.length - blocked.length });
  }

  if (output.reasoning_artifacts?.length) {
    await writeReasoningArtifacts(output.reasoning_artifacts.map((artifact) => ({
      ...artifact,
      created_at: artifact.created_at || new Date().toISOString(),
      source: artifact.source || "deep-reflect",
    })));
  }

  const prevLastReflect = await K.kvGet("last_reflect");
  const carry_forward = output.carry_forward || prevLastReflect?.carry_forward || [];

  await K.kvWriteSafe(`reflect:1:${executionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: executionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
    carry_forward,
  });

  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    note_to_future_self: output.note_to_future_self || prevLastReflect?.note_to_future_self,
    carry_forward,
    was_deep_reflect: true,
    depth: 1,
    session_id: executionId,
  });

  await K.emitEvent("dr_complete", {
    contact: (await K.kvGet("patron:contact")) || null,
    reflection: output.reflection || "",
    desires_changed: ops.filter(o => o.key?.startsWith("desire:")).length,
    patterns_changed: ops.filter(o => o.key?.startsWith("pattern:")).length,
    tactics_changed: ops.filter(o => o.key?.startsWith("tactic:")).length,
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

// ── Pulse bucket classifier ────────────────────────────────
// Maps raw touched KV keys to semantic buckets for kernel:pulse.
// The kernel tracks which keys were written; this function provides
// the cognitive-architecture meaning the kernel deliberately lacks.

const BUCKET_MAP = [
  [['session_counter', 'cache:session_ids'], 'sessions'],
  [['action:'], 'sessions'],
  [['karma:'], 'sessions'],
  [['desire:', 'pattern:', 'experience:', 'tactic:'], 'mind'],
  [['dr:', 'reflect:', 'last_reflect'], 'reflections'],
  [['chat:', 'outbox:', 'conversation_index:'], 'chats'],
  [['contact:', 'contact_platform:'], 'contacts'],
];

export function classify(touchedKeys) {
  const buckets = new Set(['health']);
  for (const key of touchedKeys) {
    for (const [patterns, bucket] of BUCKET_MAP) {
      if (patterns.some(p => p.endsWith(':') ? key.startsWith(p) : key === p)) {
        buckets.add(bucket);
        break;
      }
    }
  }
  return [...buckets];
}

// ── Main session hook ───────────────────────────────────────

export async function run(K, { crashData, balances, events }) {
  // Independent concern 1: act cycle (schedule-gated)
  let actResult = { skipped: true };
  try {
    actResult = await actCycle(K, { crashData, balances, events });
  } catch (e) {
    await K.karmaRecord({ event: "act_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Independent concern 2: session reflect (runs for all non-skipped sessions,
  // including no_action — those run eval+memory and benefit from reflect)
  if (actResult.skipped !== true) {
    try {
      const state = {
        defaults: actResult.defaults || await K.getDefaults(),
        modelsConfig: actResult.modelsConfig || await K.getModelsConfig(),
        desires: actResult.desires || {},
      };
      await executeReflect(K, state, {});
    } catch (e) {
      await K.karmaRecord({ event: "reflect_error", error: e.message, stack: e.stack?.slice(0, 500) });
    }
  }

  // Independent concern 3: DR lifecycle (every tick)
  try {
    await drCycle(K);
  } catch (e) {
    await K.karmaRecord({ event: "dr_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

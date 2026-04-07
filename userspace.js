// Swayambhu — Userspace (cognitive policy)
// Entry point for all scheduled cognitive work: act cycle + DR lifecycle.
// Called by kernel on every cron tick via HOOKS.tick.run(K, { crashData, balances, events }).
// Mutable — the agent can propose changes to this file via the proposal system.

import { evaluateAction } from './eval.js';
import { updatePatternStrength, callInference, embeddingCacheKey, cosineSimilarity } from './memory.js';
import { renderActPrompt, buildToolSet, formatDesires, formatCircumstances, deriveDebugMode, buildDebugModeNote } from './act.js';
import { executeReflect } from './reflect.js';
import { parseJobOutput } from './lib/parse-job-output.js';
import { applyRequestUpdate, SESSION_REQUEST_STATUSES } from './lib/session-requests.js';
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

async function loadPendingRequests(K, defaults, events = []) {
  const scheduleIntervalMs = (defaults?.schedule?.interval_seconds || 21600) * 1000;
  const staleAfterMs = Math.max(60 * 60 * 1000, scheduleIntervalMs);
  const now = Date.now();
  const referencedKeys = new Set(
    (events || [])
      .filter(event => event?.ref?.startsWith("session_request:"))
      .map(event => event.ref)
  );

  const list = await K.kvList({ prefix: "session_request:" });
  const requests = [];
  for (const entry of list.keys) {
    const request = await K.kvGet(entry.name);
    if (!request) continue;
    if (request.status === "fulfilled" || request.status === "rejected") continue;

    const updatedMs = request.updated_at ? new Date(request.updated_at).getTime() : 0;
    const ageMs = updatedMs ? Math.max(0, now - updatedMs) : null;
    requests.push({
      ...request,
      key: entry.name,
      from_event: referencedKeys.has(entry.name),
      stale: ageMs !== null ? ageMs >= staleAfterMs : false,
      age_hours: ageMs !== null ? Number((ageMs / 3_600_000).toFixed(1)) : null,
    });
  }

  requests.sort((a, b) => {
    if (a.from_event !== b.from_event) return a.from_event ? -1 : 1;
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    return new Date(a.updated_at || a.created_at || 0).getTime()
      - new Date(b.updated_at || b.created_at || 0).getTime();
  });

  return requests.slice(0, 5);
}

// ── Plan prompt vars ────────────────────────────────────────

const NON_PLANNER_TOOLS = new Set(["send_slack", "send_whatsapp", "send_email", "check_email", "update_request"]);

async function loadPlanVars(K, defaults, debugMode) {
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
    .filter(t => !NON_PLANNER_TOOLS.has(t.function.name))
    .map(t => ({ name: t.function.name, description: t.function.description }));

  return {
    config: defaults,
    debug_mode_note: buildDebugModeNote(debugMode),
    tools: tools.length ? tools : null,
    skill_manifest: skills.length ? skills : null,
    subagents: subagents || null,
  };
}

// ── Circumstances builder ───────────────────────────────────

function buildCircumstances(events, balances, crashData, pendingRequests) {
  const circumstances = {};
  if (events?.length) circumstances.events = events;
  if (balances) circumstances.balances = balances;
  if (crashData) circumstances.crash = crashData;
  if (pendingRequests?.length) circumstances.pending_requests = pendingRequests;
  return circumstances;
}

function extractWakeProvenance(events = []) {
  const wake = (events || []).find(event => event?.type === "wake");
  if (!wake) return null;
  return {
    origin: wake.origin || null,
    actor: wake.trigger?.actor || null,
    context: wake.trigger?.context || null,
  };
}

function getOperatingBalanceUsd(balances) {
  let total = 0;
  let found = false;

  // Sum wallet balances
  const wallets = balances?.wallets;
  if (wallets && typeof wallets === "object") {
    for (const entry of Object.values(wallets)) {
      if (!entry || entry.scope !== "general") continue;
      if (typeof entry.balance !== "number" || Number.isNaN(entry.balance)) continue;
      total += entry.balance;
      found = true;
    }
  }

  // Sum provider balances
  const providers = balances?.providers;
  if (providers && typeof providers === "object") {
    for (const entry of Object.values(providers)) {
      if (!entry || entry.scope !== "general") continue;
      if (typeof entry.balance !== "number" || Number.isNaN(entry.balance)) continue;
      total += entry.balance;
      found = true;
    }
  }

  return found ? Number(total.toFixed(2)) : null;
}

function deriveCapacitySnapshot({ balances, defaults, sessionCost = 0 }) {
  const sessionBudgetMax = defaults?.session_budget?.max_cost || 0;
  const remainingUsd = sessionBudgetMax > 0
    ? Math.max(0, sessionBudgetMax - sessionCost)
    : null;
  const remainingPct = sessionBudgetMax > 0
    ? Math.max(0, Math.min(1, remainingUsd / sessionBudgetMax))
    : null;
  const operatingBalanceUsd = getOperatingBalanceUsd(balances);
  const healthy = remainingPct !== null
    ? remainingPct >= 0.5 && (operatingBalanceUsd === null || operatingBalanceUsd >= sessionBudgetMax * 10)
    : (operatingBalanceUsd === null ? false : operatingBalanceUsd >= 1);

  return {
    budget_remaining_pct: remainingPct !== null ? Number(remainingPct.toFixed(2)) : null,
    session_budget_remaining_usd: remainingUsd !== null ? Number(remainingUsd.toFixed(3)) : null,
    operating_balance_usd: operatingBalanceUsd,
    healthy,
  };
}

function buildPlannerCircumstances(events, balances, crashData, pendingRequests, schedule, capacity, wake) {
  const circumstances = buildCircumstances(events, balances, crashData, pendingRequests);
  if (typeof schedule?.no_action_streak === "number") {
    circumstances.no_action_streak = schedule.no_action_streak;
  }
  if (capacity) circumstances.capacity = capacity;
  if (wake) circumstances.wake = wake;
  return circumstances;
}

function selectRequestsForAutoReconcile(pendingRequests = [], respondedRequestIds = new Set()) {
  const unresolved = pendingRequests.filter((request) => !respondedRequestIds.has(request.id));
  if (unresolved.length === 0) return [];

  const eventDriven = unresolved.filter((request) => request.from_event);
  if (eventDriven.length > 0) return eventDriven;
  if (unresolved.length === 1) return unresolved;
  return [];
}

function buildMechanicalRequestFallback({ review, ledger }) {
  const accomplished = typeof review?.accomplished === "string" ? review.accomplished.trim() : "";
  const nextGap = typeof review?.next_gap === "string" ? review.next_gap.trim() : "";
  const finding = Array.isArray(review?.key_findings)
    ? review.key_findings.find((item) => typeof item === "string" && item.trim())
    : "";
  const finalText = typeof ledger?.final_text === "string" ? ledger.final_text.trim() : "";

  const parts = [accomplished || finalText || "Work progressed on the request."];
  if (finding) parts.push(`Key finding: ${finding}`);
  if (nextGap) parts.push(`Remaining gap: ${nextGap}`);

  return parts.join(" ").trim().slice(0, 1000);
}

async function autoReconcileRequests(K, {
  pendingRequests,
  respondedRequestIds,
  plan,
  ledger,
  review,
  defaults,
  signal,
}) {
  const scope = selectRequestsForAutoReconcile(pendingRequests, respondedRequestIds);
  if (scope.length === 0) return [];

  const progressObserved = !!(
    ledger?.tool_calls?.length
    || (typeof ledger?.final_text === "string" && ledger.final_text.trim())
    || (typeof review?.accomplished === "string" && review.accomplished.trim())
  );
  if (!progressObserved) return [];

  const model = await K.resolveModel(
    defaults?.chat?.model
      || defaults?.reflect?.model
      || defaults?.act?.model
      || "sonnet"
  );

  const requestSummaries = scope.map((request) => ({
    id: request.id,
    summary: request.summary,
    status: request.status,
    stale: request.stale || false,
    from_event: request.from_event || false,
  }));
  const ledgerSummary = {
    action: plan?.action || null,
    success: plan?.success || null,
    serves_desires: plan?.serves_desires || [],
    tool_calls: (ledger?.tool_calls || []).map((call) => ({
      tool: call.tool,
      ok: call.ok,
      output_preview: typeof call.output === "string"
        ? call.output.slice(0, 240)
        : JSON.stringify(call.output || {}).slice(0, 240),
    })),
    final_text: ledger?.final_text || null,
  };
  const reviewSummary = review ? {
    accomplished: review.accomplished || null,
    key_findings: review.key_findings || [],
    next_gap: review.next_gap ?? null,
    assessment: review.assessment || null,
  } : null;

  const systemPrompt = [
    "You reconcile durable work requests after an act session.",
    "Decide whether each request is now fulfilled, still pending, or rejected.",
    "Be conservative about rejection. Use fulfilled when the requester-facing ask appears satisfied even if optional follow-up ideas remain.",
    "Return JSON only: {\"updates\":[{\"request_id\":\"...\",\"status\":\"fulfilled|pending|rejected\",\"result\":\"... optional ...\",\"note\":\"... optional ...\"}]}",
    "If status is fulfilled, prefer result over note.",
    "If status is pending, prefer note over result.",
    "Keep result/note concise and requester-facing. Do not mention internal prompts or tool names unless useful.",
  ].join("\n");

  let parsed = null;
  try {
    const response = await K.callLLM({
      model,
      effort: defaults?.chat?.effort || "low",
      maxTokens: Math.min(defaults?.chat?.max_output_tokens || 1000, 800),
      systemPrompt,
      messages: [{
        role: "user",
        content: JSON.stringify({
          requests: requestSummaries,
          ledger: ledgerSummary,
          review: reviewSummary,
        }, null, 2),
      }],
      tools: [],
      step: "request_reconcile",
      signal,
      json: true,
    });
    parsed = response.parsed;
  } catch (err) {
    if (err?.name !== "AbortError") {
      await K.karmaRecord({ event: "request_reconcile_failed", error: err.message });
    }
  }

  const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
  const applied = [];

  for (const request of scope) {
    const modelUpdate = updates.find((update) => update?.request_id === request.id);
    const status = SESSION_REQUEST_STATUSES.has(modelUpdate?.status)
      ? modelUpdate.status
      : "pending";
    const fallback = buildMechanicalRequestFallback({ review, ledger });
    const result = typeof modelUpdate?.result === "string" && modelUpdate.result.trim()
      ? modelUpdate.result.trim().slice(0, 1000)
      : status === "fulfilled"
        ? fallback
        : undefined;
    const note = typeof modelUpdate?.note === "string" && modelUpdate.note.trim()
      ? modelUpdate.note.trim().slice(0, 1000)
      : status === "pending"
        ? fallback
        : undefined;

    const outcome = await applyRequestUpdate({
      requestKey: request.key,
      existing: request,
      status,
      note,
      result,
      kv: {
        put: async (key, value) => K.kvWriteSafe(key, value, { unprotected: true }),
      },
      emitEvent: K.emitEvent.bind(K),
    });

    if (outcome.ok) {
      respondedRequestIds.add(request.id);
      applied.push({ request_id: request.id, status });
    }
  }

  if (applied.length > 0) {
    await K.karmaRecord({
      event: "requests_auto_reconciled",
      updates: applied,
    });
  }

  return applied;
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

function normalizeReview(review, ledger) {
  const observation = String(
    review?.observation
    || review?.narrative
    || review?.assessment
    || ledger.final_text
    || ledger.plan?.reason
    || ""
  );

  return {
    observation,
    assessment: review?.assessment || null,
    accomplished: review?.accomplished || null,
    key_findings: Array.isArray(review?.key_findings)
      ? review.key_findings.filter(item => typeof item === "string" && item.trim())
      : [],
    next_gap: review?.next_gap || null,
    narrative: review?.narrative || null,
    salience_estimate: typeof review?.salience_estimate === "number" ? review.salience_estimate : null,
  };
}

function deriveDesireAlignment(alpha = {}) {
  const entries = Object.entries(alpha)
    .filter(([, score]) => typeof score === "number" && Math.abs(score) >= 0.3)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const top_positive = entries
    .filter(([, score]) => score > 0)
    .slice(0, 3)
    .map(([desire_key, score]) => ({ desire_key, score: Math.abs(score) }));

  const top_negative = entries
    .filter(([, score]) => score < 0)
    .slice(0, 3)
    .map(([desire_key, score]) => ({ desire_key, score: Math.abs(score) }));

  const magnitudes = entries.map(([, score]) => Math.abs(score));
  const affinity_magnitude = magnitudes.length
    ? Math.sqrt(magnitudes.reduce((sum, score) => sum + score ** 2, 0) / magnitudes.length)
    : 0;

  return {
    top_positive,
    top_negative,
    affinity_magnitude,
  };
}

function derivePatternDelta(evalResult) {
  const scores = Object.entries(evalResult.pattern_scores || {})
    .map(([pattern_key, value]) => ({
      pattern_key,
      direction: value.direction,
      surprise: value.surprise || 0,
    }))
    .sort((a, b) => b.surprise - a.surprise);

  return {
    sigma: evalResult.sigma || 0,
    scores,
  };
}

function deriveBootstrapNoActionPlan({ circumstances }) {
  let reason = "No active desires are present. Action is not warranted until experience seeds desire through reflection.";

  if (circumstances?.events?.length) {
    reason += " External events are noted as circumstances, but without desire-grounding they do not yet authorize action.";
  }

  return {
    no_action: true,
    reason,
  };
}

// ── Plan phase ──────────────────────────────────────────────

async function planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems, reflectLoadedContext, pendingRequests }) {
  const model = await K.resolveModel(defaults?.act?.model || "sonnet");
  const planPrompt = await K.kvGet("prompt:plan");
  const debugMode = deriveDebugMode(defaults, { wake: circumstances?.wake });
  const systemPrompt = planPrompt
    ? await K.buildPrompt(planPrompt, await loadPlanVars(K, defaults, debugMode))
    : "You are a planning agent. Given desires, tactics, and circumstances, output a JSON action plan.";

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
  if (reflectLoadedContext && Object.keys(reflectLoadedContext).length) {
    sections.push("[REFLECT-LOADED CONTEXT]", "(keys loaded per last session's next_act_context.load_keys)");
    for (const [key, val] of Object.entries(reflectLoadedContext)) {
      const display = typeof val === 'string' ? val : JSON.stringify(val);
      sections.push(`- ${key}: ${display.slice(0, 500)}`);
    }
    sections.push("");
  }
  if (pendingRequests?.length) {
    sections.push("[PENDING REQUESTS]", "(durable work contracts currently awaiting execution or update)");
    for (const request of pendingRequests) {
      const stale = request.stale ? " [stale]" : "";
      const age = request.age_hours != null ? ` (${request.age_hours}h old)` : "";
      const note = request.note ? ` — ${request.note}` : "";
      sections.push(`- ${request.id}: ${request.summary}${stale}${age}${note}`);
    }
    sections.push("");
  }
  // Idle trap breaker: when the agent has been idle far beyond the exploration
  // unlock threshold, override any tactics that justify continued inaction.
  // This prevents self-imposed tactics from creating permanent idle loops.
  const noActionStreak = circumstances?.no_action_streak || 0;
  const idleTrapThreshold = (defaults?.schedule?.exploration_unlock_streak || 3) * 2;
  const noRequestsPending = !Array.isArray(pendingRequests) || pendingRequests.length === 0;
  if (noRequestsPending && noActionStreak >= idleTrapThreshold) {
    sections.push(
      "[IDLE TRAP OVERRIDE]",
      `You have been idle for ${noActionStreak} consecutive sessions. Your tactics may`,
      "be keeping you idle, but prolonged inaction is itself a failure mode.",
      "Re-evaluate whether your blocked dependency is still the right path.",
      "Consider: sending a follow-up, exploring alternative approaches, or",
      "updating the carry-forward plan to reflect changed circumstances.",
      "Do NOT cite a tactic as justification for continued inaction beyond",
      "this threshold.",
      "",
    );
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
  } else {
    sections.push("", "[SESSION STATE]", "This is the start of the session. No tools have been called yet. Any tool outputs referenced in carry-forward or patterns are from prior sessions.");
  }
  sections.push(
    "",
    "Respond with a JSON plan object: { action, success, serves_desires, follows_tactics, defer_if, no_action }",
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

  const legacyReliesOn = Array.isArray(plan.relies_on)
    ? plan.relies_on.filter(key => typeof key === "string")
    : [];
  const servesDesires = (Array.isArray(plan.serves_desires)
    ? plan.serves_desires.filter(key => typeof key === "string")
    : legacyReliesOn.filter(key => key.startsWith("desire:"))
  ).map(d => d.startsWith("desire:") ? d : `desire:${d}`);
  const followsTactics = (Array.isArray(plan.follows_tactics)
    ? plan.follows_tactics.filter(key => typeof key === "string")
    : legacyReliesOn.filter(key => key.startsWith("tactic:"))
  ).map(t => t.startsWith("tactic:") ? t : `tactic:${t}`);
  const legacyPatterns = legacyReliesOn.filter(key => key.startsWith("pattern:"));

  if (legacyPatterns.length) {
    await K.karmaRecord({
      event: "plan_pattern_guidance_stripped",
      pattern_keys: legacyPatterns,
      stripped: true,
    });
  }

  const desireKeys = new Set(Object.keys(desires));
  const tacticKeys = new Set(tacticList.keys.map(k => k.name));
  const unknownDesires = servesDesires.filter(key => !desireKeys.has(key));
  const unknownTactics = followsTactics.filter(key => !tacticKeys.has(key));
  if (unknownDesires.length || unknownTactics.length) {
    await K.karmaRecord({
      event: "plan_unknown_refs",
      unknown_desires: unknownDesires,
      unknown_tactics: unknownTactics,
      stripped: true,
    });
  }

  plan.serves_desires = servesDesires.filter(key => desireKeys.has(key));
  plan.follows_tactics = followsTactics.filter(key => tacticKeys.has(key));
  delete plan.relies_on;

  const allowRequestDrivenPlan = Array.isArray(pendingRequests) && pendingRequests.length > 0;
  const explorationUnlockStreak = defaults?.schedule?.exploration_unlock_streak || 3;
  const allowExploratoryPlan = !allowRequestDrivenPlan
    && (priorActions?.length || 0) === 0
    && (circumstances?.no_action_streak || 0) >= explorationUnlockStreak
    && circumstances?.capacity?.healthy === true
    && typeof plan.action === "string"
    && plan.action.trim().length > 0
    && typeof plan.success === "string"
    && plan.success.trim().length > 0;

  if (plan.serves_desires.length === 0 && !allowRequestDrivenPlan && !allowExploratoryPlan) {
    await K.karmaRecord({
      event: "plan_missing_serves_desires",
      action: plan.action || null,
    });
    return null;
  }
  if (plan.serves_desires.length === 0 && allowRequestDrivenPlan) {
    await K.karmaRecord({
      event: "plan_request_driven_without_desire",
      action: plan.action || null,
      request_ids: pendingRequests.map(request => request.id),
    });
  }
  if (plan.serves_desires.length === 0 && allowExploratoryPlan) {
    await K.karmaRecord({
      event: "plan_exploratory_without_desire",
      action: plan.action || null,
      no_action_streak: circumstances?.no_action_streak || 0,
      operating_balance_usd: circumstances?.capacity?.operating_balance_usd ?? null,
      budget_remaining_pct: circumstances?.capacity?.budget_remaining_pct ?? null,
    });
  }

  return plan;
}

// ── Act phase ───────────────────────────────────────────────

async function actPhase(K, { plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults, pendingRequests }) {
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
    content: [
      pendingRequests?.length
        ? `Pending requests in scope:\n${JSON.stringify(pendingRequests, null, 2)}`
        : null,
      `Execute this plan:\n${JSON.stringify(plan, null, 2)}`,
    ].filter(Boolean).join("\n\n"),
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

async function reviewPhase(K, { ledger, evalResult, defaults, signal }) {
  const model = await K.resolveModel(defaults?.reflect?.model || defaults?.act?.model || "sonnet");
  const reviewPrompt = await K.kvGet("prompt:review");

  const evalBlock = [
    "[KERNEL EVALUATION]",
    `sigma (surprise signal): ${evalResult.sigma}`,
    `desire_axis: ${evalResult.desire_axis ?? 0}`,
    `salience: ${evalResult.salience}`,
    `eval_method: ${evalResult.eval_method}`,
    `alpha: ${JSON.stringify(evalResult.alpha || {})}`,
    `pattern_scores: ${JSON.stringify(evalResult.pattern_scores || {})}`,
    `tool_outcomes: ${JSON.stringify(evalResult.tool_outcomes)}`,
    `plan_success_criteria: ${evalResult.plan_success_criteria || "none"}`,
    `served_desires: ${JSON.stringify(evalResult.served_desires || [])}`,
    `followed_tactics: ${JSON.stringify(evalResult.followed_tactics || [])}`,
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
    "Respond with JSON: { observation, assessment, accomplished, key_findings, next_gap, narrative }",
    "- observation: factual account of what happened; no advice, no tactics, no scheduler policy",
    "- assessment: optional one-sentence judgment",
    "- accomplished: one sentence summary of what was achieved",
    "- key_findings: array of 1-3 short factual findings",
    "- next_gap: one sentence describing what remains unknown or unfinished (or null if complete)",
    "- narrative: optional concise audit text for humans",
    "- only include salience_estimate if eval_method is degraded and you need an emergency fallback",
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
    signal,
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
      signal,
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
  const reviewRecord = normalizeReview(review, ledger);

  const salienceThreshold = 0.5;
  const rawSalience = evalResult.salience > 0
    ? evalResult.salience
    : Math.min(1, Math.max(0, reviewRecord.salience_estimate || 0));

  // For no_action: use sigma-only salience. NLI classifies long-horizon aspirational
  // desires as "contradicted" by no-action outcome text (false positive — not acting
  // does not falsify "I have demonstrated usefulness"). Only pattern surprise (sigma)
  // is semantically meaningful for abstention events. Raw evalResult.salience is still
  // preserved in the action:* audit record for diagnostics.
  //
  // Note: this assumes desires are approach-only target states requiring action to
  // advance. If tactical desires are added that can be entailed by principled
  // abstention, this gate should be revisited.
  let salience = ledger.plan?.no_action
    ? evalResult.sigma
    : rawSalience;
  if (ledger.plan?.no_action && typeof ledger.meta?.salience_floor === "number") {
    salience = Math.max(salience, ledger.meta.salience_floor);
  }
  const actionKey = `action:${ledger.action_id}`;

  // Action record — structured audit trail
  await K.kvWriteSafe(actionKey, {
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
      desire_axis: evalResult.desire_axis ?? 0,
      alpha: evalResult.alpha || {},
      salience: evalResult.salience,
      memory_gate_salience: salience,
      method: evalResult.eval_method,
      tool_outcomes: evalResult.tool_outcomes,
      pattern_scores: evalResult.pattern_scores || {},
      plan_success_criteria: evalResult.plan_success_criteria || null,
      served_desires: evalResult.served_desires || [],
      followed_tactics: evalResult.followed_tactics || [],
    },
    review: reviewRecord,
  });

  // Pattern strength updates — skip for no_action cycles.
  // NLI classifies no-action text as contradicting descriptive patterns
  // (false positive — abstention doesn't invalidate observed regularities).
  // Same rationale as the desire-axis gate at line 521.
  if (evalResult.pattern_scores && !ledger.plan?.no_action) {
    for (const [key, score] of Object.entries(evalResult.pattern_scores)) {
      if (score.direction === "neutral") continue;  // irrelevant → no update
      const existing = patterns[key];
      if (!existing) continue;
      const newStrength = updatePatternStrength(existing.strength, score.surprise);
      const writeResult = await K.updatePatternStrength(key, newStrength);
      if (!writeResult.ok) {
        await K.karmaRecord({ event: "pattern_strength_write_failed", key, error: writeResult.error });
      }
    }
  }

  if (salience > salienceThreshold) {
    let embedding = null;
    if (inferenceConfig) {
      try {
        const resp = await callInference(inferenceConfig.url, inferenceConfig.secret, '/embed', {
          texts: [reviewRecord.observation || reviewRecord.narrative || ledger.final_text || '']
        });
        embedding = resp.embeddings?.[0] || null;
      } catch (err) {
        const event = err?.name === "AbortError"
          ? "experience_embedding_timeout"
          : "experience_embedding_failed";
        await K.karmaRecord({ event });
      }
    }

    const experienceKey = `experience:${Date.now()}`;
    const experienceRecord = {
      timestamp: now,
      action_ref: actionKey,
      session_id: executionId || null,
      cycle: cycle ?? null,
      observation: reviewRecord.observation,
      desire_alignment: deriveDesireAlignment(evalResult.alpha || {}),
      pattern_delta: derivePatternDelta(evalResult),
      salience,
      embedding,
      ...(reviewRecord.narrative ? { text_rendering: { narrative: reviewRecord.narrative } } : {}),
    };
    // Deduplicate near-identical experiences — decay salience for similar
    // observations, skip entirely for near-duplicates. Prevents repetitive
    // eval signals (e.g. tactic-blind contradiction flags) from polluting
    // the experience store and drowning out genuinely novel experiences.
    if (embedding) {
      const recentList = await K.kvList({ prefix: "experience:", limit: 5 });
      const recentKeys = recentList.keys || [];
      let maxSim = 0;
      for (const k of recentKeys) {
        const recentExp = await K.kvGet(k.name);
        if (recentExp?.embedding) {
          const sim = cosineSimilarity(embedding, recentExp.embedding);
          if (sim > maxSim) maxSim = sim;
        }
      }
      if (maxSim > 0.95) {
        await K.karmaRecord({ event: "experience_deduplicated", similarity: maxSim, salience });
        return;
      }
      if (maxSim > 0.90) {
        salience *= 0.2;
        await K.karmaRecord({ event: "experience_salience_decayed", similarity: maxSim, original_salience: experienceRecord.salience, decayed_salience: salience });
        experienceRecord.salience = salience;
      }
    }

    // Schema validation — reject experiences missing required fields
    const requiredFields = ['observation', 'desire_alignment', 'pattern_delta', 'salience'];
    const missing = requiredFields.filter(f => experienceRecord[f] === undefined || experienceRecord[f] === null);
    if (missing.length > 0) {
      await K.karmaRecord({ event: "experience_schema_rejected", key: experienceKey, missing });
      return;
    }

    await K.kvWriteSafe(experienceKey, experienceRecord);
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
        action_ref: null,
        session_id: crashData.dead_execution_id,
        cycle: 0,
        observation: `Session ${crashData.dead_execution_id} was killed after ${elapsed}s. ${llmCalls} LLM calls and ${toolCalls} tool calls ran. Last activity: ${lastStep}. Probable cause: execution time limit exceeded.`,
        desire_alignment: { top_positive: [], top_negative: [], affinity_magnitude: 0 },
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
        text_rendering: {
          narrative: `A session was killed before it could complete. The last activity was ${lastStep} after ${elapsed}s of execution. This crash should inform future tactic and configuration changes.`,
        },
        embedding: null,
      });
      await K.kvWriteSafe(marker, { written_at: new Date().toISOString() }, { unprotected: true });
      await K.karmaRecord({ event: "crash_experience_written", dead_execution_id: crashData.dead_execution_id });
    }
  }

  // Schedule gate — userspace decides if it's time
  const schedule = await K.kvGet("session_schedule");
  const wake = extractWakeProvenance(events);
  const externalWake = wake?.origin === "external";
  if (schedule?.next_session_after) {
    if (!externalWake && Date.now() < new Date(schedule.next_session_after).getTime()) {
      return { skipped: true };
    }
  }
  if (externalWake && schedule?.next_session_after && Date.now() < new Date(schedule.next_session_after).getTime()) {
    await K.karmaRecord({
      event: "schedule_gate_bypassed",
      reason: "external_wake",
      scheduled_for: schedule.next_session_after,
      wake_origin: wake?.origin,
      wake_actor: wake?.actor,
    });
  }

  let desires = await loadDesires(K);
  const drState = await K.kvGet("dr:state:1");
  if (
    Object.keys(desires).length === 0
    && (drState?.status === "dispatched" || drState?.status === "completed")
  ) {
    await K.karmaRecord({
      event: "bootstrap_waiting_for_dr",
      dr_status: drState.status,
      generation: drState.generation || 0,
    });
    return { skipped: true };
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
    no_action_streak: schedule?.no_action_streak || 0,
    wake_origin: wake?.origin || "scheduled",
    wake_actor: wake?.actor || null,
    wake_context: wake?.context || null,
  });

  // 1. Load config
  const defaults = await K.getDefaults();
  const modelsConfig = await K.getModelsConfig();
  const pendingRequests = await loadPendingRequests(K, defaults, events);
  const initialCapacity = deriveCapacitySnapshot({
    balances,
    defaults,
    sessionCost: await K.getSessionCost(),
  });
  await K.karmaRecord({
    event: "capacity_snapshot",
    no_action_streak: schedule?.no_action_streak || 0,
    ...initialCapacity,
  });

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
  let patterns = await loadPatterns(K);

  // 2c. Load carry-forward items from last session's reflect output
  const lastReflect = await K.kvGet("last_reflect");
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const normalizeDate = (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };
  const carryForwardItems = (lastReflect?.carry_forward || [])
    .map(item => ({
      ...item,
      expires_at: item.expires_at ? normalizeDate(item.expires_at) : undefined,
      created_at: item.created_at ? normalizeDate(item.created_at) : undefined,
      updated_at: item.updated_at ? normalizeDate(item.updated_at) : undefined,
    }))
    .filter(item => item.status === "active")
    .filter(item => !item.expires_at || new Date(item.expires_at).getTime() >= Date.now())
    .sort((a, b) => {
      const priorityDelta = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
    })
    .slice(0, 5);

  // 2d. Load keys requested by last reflect's next_act_context.load_keys
  const requestedLoadKeys = (lastReflect?.next_act_context?.load_keys || []).slice(0, 10);
  const alreadyLoaded = new Set([...Object.keys(desires), ...Object.keys(patterns)]);
  const reflectLoadedContext = {};
  for (const key of requestedLoadKeys) {
    if (alreadyLoaded.has(key)) continue;
    const val = await K.kvGet(key);
    if (val != null) reflectLoadedContext[key] = val;
  }

  // 2b. Cache embeddings for Tier 1 relevance filtering
  if (inferenceConfig) {
    const embedModel = defaults?.inference?.embed_model || 'bge-small-en-v1.5';
    await cacheEmbeddings(K, desires, 'description', embedModel, inferenceConfig);
    await cacheEmbeddings(K, patterns, 'pattern', embedModel, inferenceConfig);
  }

  // 3. Build initial circumstances
  let circumstances = buildPlannerCircumstances(
    events,
    balances,
    crashData,
    pendingRequests,
    schedule,
    initialCapacity,
    wake,
  );

  // 4. Build system prompt, tools, model
  const debugMode = deriveDebugMode(defaults, { wake });
  const systemPrompt = await renderActPrompt(K, { defaults, debugMode });
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
      accomplished: rec.review?.accomplished || String(rec.review?.observation || rec.review?.narrative || "").slice(0, 150) || null,
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
  const respondedRequestIds = new Set();

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // 6a. Budget preflight — stop act cycles when reserve is reached
    const spent = await K.getSessionCost();
    if (spent >= actBudgetCap) {
      await K.karmaRecord({ event: "session_budget_exhausted", spent, cycle, act_cap: actBudgetCap });
      break;
    }

    // 6b. Plan phase
    const plan = (Object.keys(desires).length === 0 && pendingRequests.length === 0)
      ? deriveBootstrapNoActionPlan({ circumstances })
      : await planPhase(K, { desires, patterns, circumstances, priorActions, defaults, modelsConfig, carryForwardItems, reflectLoadedContext, pendingRequests });
    if (!plan) break; // parse failure
    const cycleAbortController = new AbortController();
    const abortFromSession = () => cycleAbortController.abort(K.sessionAbortSignal?.reason);
    const cycleTimeout = setTimeout(() => cycleAbortController.abort(), 120_000);
    if (K.sessionAbortSignal) {
      if (K.sessionAbortSignal.aborted) cycleAbortController.abort(K.sessionAbortSignal.reason);
      else K.sessionAbortSignal.addEventListener("abort", abortFromSession, { once: true });
    }
    try {
      if (plan.no_action) {
        await K.karmaRecord({ event: "plan_no_action", reason: plan.reason, cycle });
        const projectedNoActionStreak = (schedule?.no_action_streak || 0) + 1;
        const capacityRichNoAction = circumstances?.capacity?.healthy === true
          && projectedNoActionStreak >= (defaults?.schedule?.exploration_unlock_streak || 3);
        if (capacityRichNoAction) {
          await K.karmaRecord({
            event: "capacity_rich_no_action",
            cycle,
            no_action_streak: projectedNoActionStreak,
            operating_balance_usd: circumstances?.capacity?.operating_balance_usd ?? null,
            budget_remaining_pct: circumstances?.capacity?.budget_remaining_pct ?? null,
          });
        }

        // Still run eval + memory so the experience gets recorded. When
        // patterns are empty, eval returns σ=1 (max surprise) — this is
        // what bootstraps the agent by making "no desires" a high-salience
        // experience that reflect can act on.
        const noActionLedger = {
          action_id: `a_${Date.now()}_noaction`,
          plan,
          tool_calls: [],
          final_text: plan.reason,
          meta: capacityRichNoAction ? {
            // Only floor salience on the first idle session that crosses the
            // exploration-unlock threshold — subsequent near-identical observations
            // should be filtered by natural dedup (sigma < threshold).
            ...(projectedNoActionStreak === (defaults?.schedule?.exploration_unlock_streak || 3)
              ? { salience_floor: 0.6 } : {}),
            no_action_streak: projectedNoActionStreak,
            capacity: circumstances?.capacity || null,
          } : null,
        };
        const evalResult = await evaluateAction(K, noActionLedger, desires, patterns, inferenceConfig || {}, cycleAbortController.signal);
        const syntheticReview = {
          observation: capacityRichNoAction
            ? `No action was taken despite healthy available capacity after ${projectedNoActionStreak} consecutive idle sessions. Reason: ${plan.reason}`
            : `No action was taken. Reason: ${plan.reason}`,
          assessment: "no_action",
          narrative: capacityRichNoAction
            ? `No action taken after ${projectedNoActionStreak} consecutive idle sessions despite healthy available capacity. Reason: ${plan.reason}`
            : `No action taken: ${plan.reason}`,
          salience_estimate: evalResult.salience || 0,
        };
        await K.karmaRecord({
          event: "review_synthesized",
          source: "no_action_bootstrap",
          observation: syntheticReview.observation,
          assessment: syntheticReview.assessment,
          cycle,
        });
        await writeMemory(K, { ledger: noActionLedger, evalResult, review: syntheticReview, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

        break;
      }

      // 6c. Act phase
      const ledger = await actPhase(K, {
        plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults, pendingRequests,
      });
      for (const call of ledger.tool_calls) {
        if (call.tool !== "update_request") continue;
        let parsedInput = call.input;
        if (typeof parsedInput === "string") {
          try { parsedInput = JSON.parse(parsedInput); } catch { parsedInput = null; }
        }
        if (parsedInput?.request_id) respondedRequestIds.add(parsedInput.request_id);
      }

      // 6d. Eval phase
      const evalResult = await evaluateAction(K, ledger, desires, patterns, inferenceConfig || {}, cycleAbortController.signal);

      // 6e. Review phase
      const review = await reviewPhase(K, { ledger, evalResult, defaults, signal: cycleAbortController.signal });

      // 6f. Memory writes
      await writeMemory(K, { ledger, evalResult, review, desires, patterns, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

      if (pendingRequests.length) {
        await autoReconcileRequests(K, {
          pendingRequests,
          respondedRequestIds,
          plan,
          ledger,
          review,
          defaults,
          signal: cycleAbortController.signal,
        });
      }

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
      const freshCapacity = deriveCapacitySnapshot({
        balances: freshBalances,
        defaults,
        sessionCost: await K.getSessionCost(),
      });
      circumstances = buildPlannerCircumstances(
        null, // events only on first cycle
        freshBalances,
        null, // crashData only on first cycle
        pendingRequests,
        schedule,
        freshCapacity,
        wake,
      );
      // Add recent tool outcomes
      if (ledger.tool_calls.length) {
        circumstances.recent_outcomes = ledger.tool_calls.map(tc => ({
          tool: tc.tool, ok: tc.ok,
        }));
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        await K.karmaRecord({ event: "eval_review_aborted", cycle });
        continue;
      }
      throw err;
    } finally {
      clearTimeout(cycleTimeout);
      if (K.sessionAbortSignal && !K.sessionAbortSignal.aborted) {
        K.sessionAbortSignal.removeEventListener("abort", abortFromSession);
      }
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

  if (pendingRequests.length) {
    const unaddressed = pendingRequests
      .map(request => request.id)
      .filter(id => !respondedRequestIds.has(id));
    if (unaddressed.length > 0) {
      await K.karmaRecord({
        event: "unaddressed_requests",
        count: unaddressed.length,
        request_ids: unaddressed,
      });
    }
  }

  // Schedule next session
  let scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  const idleInterval = defaults?.schedule?.idle_interval_seconds || 1800;
  const explorationUnlockStreak = defaults?.schedule?.exploration_unlock_streak || 3;
  const isBootstrapNoAction = cyclesRun === 0
    && sessionCount === 0
    && Object.keys(desires).length === 0;

  // Repeated no_action under healthy capacity should become cheaper/faster rather
  // than deepening into long dormancy. Preserve the default cadence for
  // bootstrap or genuinely constrained states.
  if (cyclesRun === 0) {
    const currentSchedule = await K.kvGet("session_schedule");
    const streak = (currentSchedule?.no_action_streak || 0) + 1;
    const capacityHealthy = circumstances?.capacity?.healthy === true;
    if (!isBootstrapNoAction && capacityHealthy && streak >= explorationUnlockStreak) {
      scheduleInterval = Math.min(scheduleInterval, idleInterval);
    }
    // Persist streak for next session
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
      interval_seconds: scheduleInterval,
      no_action_streak: streak,
    });
  } else {
    // Active session: reset streak
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
      interval_seconds: scheduleInterval,
      no_action_streak: 0,
    });
  }

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

async function drCycle(K, { phase = "post", events = [] } = {}) {
  const defaults = await K.getDefaults();
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  const state = await K.kvGet("dr:state:1") || {
    status: "idle", generation: 0, consecutive_failures: 0,
  };
  const callbackJobIds = new Set(
    (events || [])
      .filter(event => event?.type === "job_complete")
      .map(getEventJobId)
      .filter(Boolean),
  );
  const hasMatchingCallback = !!(state.job_id && callbackJobIds.has(state.job_id));
  const handledJobIds = hasMatchingCallback ? [state.job_id] : [];

  if (state.status === "dispatched" && (phase !== "pre" || hasMatchingCallback)) {
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
      return { handledJobIds };
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
      return { handledJobIds };
    } else {
      return { handledJobIds };
    }
  }

  if (state.status === "completed" && (phase !== "pre" || hasMatchingCallback)) {
    const output = await K.kvGet(`dr:result:${state.generation}`);
    if (!output) {
      state.status = "failed";
      state.failure_reason = "result missing from KV";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await K.kvWriteSafe("dr:state:1", state);
      return { handledJobIds };
    }

    const hadNoDesires = Object.keys(await loadDesires(K)).length === 0;
    await applyDrResults(K, state, output);
    const desireCount = Object.keys(await loadDesires(K)).length;
    if (hadNoDesires && desireCount > 0) {
      const schedule = await K.kvGet("session_schedule");
      await K.kvWriteSafe("session_schedule", {
        next_session_after: new Date().toISOString(),
        interval_seconds: schedule?.interval_seconds || defaults?.schedule?.interval_seconds || 21600,
        no_action_streak: schedule?.no_action_streak || 0,
      });
      await K.karmaRecord({
        event: "bootstrap_ready_after_dr",
        generation: state.generation,
        desires_created: desireCount,
      });
    }

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = sessionCount;
    state.last_execution_id = await K.getExecutionId();
    state.consecutive_failures = 0;
    state.last_failure_session = null;

    const defaultInterval = defaults?.deep_reflect?.default_interval_sessions || 20;
    const requestedInterval = output.next_reflect?.after_sessions || defaultInterval;
    const interval = state.generation <= 5
      ? Math.min(defaultInterval, requestedInterval)
      : requestedInterval;
    const intervalDays = output.next_reflect?.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    state.next_due_session = state.last_applied_session + interval;
    state.next_due_date = new Date(Date.now() + intervalDays * 86400000).toISOString();

    await K.kvDeleteSafe(`dr:result:${state.generation}`);
    await K.kvWriteSafe("dr:state:1", state);
    return { handledJobIds };
  }

  if (phase === "pre") {
    return { handledJobIds };
  }

  if (state.status === "failed") {
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) return { handledJobIds };

    state.status = "idle";
    state.next_due_session = sessionCount;
    await K.kvWriteSafe("dr:state:1", state);
  }

  if (state.status === "idle") {
    if (!await isDrDue(K, state)) return { handledJobIds };

    const dispatch = await dispatchDr(K, defaults);
    if (!dispatch) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = "dispatch failed";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_dispatch_failed" });
      return { handledJobIds };
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

  return { handledJobIds };
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
    try {
      await writeReasoningArtifacts(output.reasoning_artifacts.map((artifact) => ({
        ...artifact,
        created_at: artifact.created_at || new Date().toISOString(),
        source: artifact.source || "deep-reflect",
      })));
    } catch (err) {
      // writeReasoningArtifacts writes to /home/swayambhu/reasoning/ (Akash machine path).
      // The Cloudflare Workers runtime (unenv shim) does not implement fs.mkdir — this always
      // fails in the Worker. The DR job produces reasoning_artifacts in its JSON output; the
      // architectural intent is for them to be persisted here, but that requires KV-backed
      // storage or DR-job-side writes (tracked separately). Log best-effort and continue —
      // KV operations are already applied and must not be blocked by a filesystem write.
      try { await K.karmaRecord({ event: "reasoning_artifacts_write_failed", error: err.message }); } catch (_) {}
    }
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

function getEventJobId(event) {
  return event?.job_id || event?.source?.job_id || null;
}

// ── Pulse bucket classifier ────────────────────────────────
// Maps raw touched KV keys to semantic buckets for kernel:pulse.
// The kernel tracks which keys were written; this function provides
// the cognitive-architecture meaning the kernel deliberately lacks.

const BUCKET_MAP = [
  [['session_counter', 'cache:session_ids'], 'sessions'],
  [['action:'], 'sessions'],
  [['karma:'], 'sessions'],
  [['session_request:'], 'requests'],
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
  const preDr = await (async () => {
    try {
      return await drCycle(K, { phase: "pre", events });
    } catch (e) {
      await K.karmaRecord({ event: "dr_cycle_error", phase: "pre", error: e.message, stack: e.stack?.slice(0, 500) });
      return { handledJobIds: [] };
    }
  })();

  const handledJobIds = new Set(preDr?.handledJobIds || []);
  const actEvents = handledJobIds.size > 0
    ? events.filter(event => !(event.type === "job_complete" && handledJobIds.has(getEventJobId(event))))
    : events;

  // Independent concern 1: act cycle (schedule-gated)
  let actResult = { skipped: true };
  try {
    actResult = await actCycle(K, { crashData, balances, events: actEvents });
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
    await drCycle(K, { phase: "post", events });
  } catch (e) {
    await K.karmaRecord({ event: "dr_cycle_error", phase: "post", error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

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
import { normalizeMetaPolicyNotes, persistMetaPolicyNotes } from "./meta-policy.js";

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

async function loadIdentifications(K) {
  const list = await K.kvList({ prefix: "identification:" });
  const identifications = {};
  for (const entry of list.keys) {
    const val = await K.kvGet(entry.name);
    if (val) identifications[entry.name] = val;
  }
  return identifications;
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

export function summarizeCarryForwardWaitState(carryForwardItems = []) {
  const active = (carryForwardItems || []).filter(item => item?.status === "active");
  if (active.length === 0) {
    return {
      active_item_count: 0,
      waiting_item_count: 0,
      all_active_items_waiting: false,
    };
  }

  const waitish = active.filter((item) => {
    const hasStructuredWait = [item?.blocked_on, item?.wake_condition]
      .some(value => typeof value === "string" && value.trim());
    if (hasStructuredWait) return true;
    const text = `${item?.item || ""} ${item?.why || ""} ${item?.result || ""}`.toLowerCase();
    return /wait|waiting|callback|reply|response|completion|complete|status|pending|expiry|ttl/.test(text);
  });

  return {
    active_item_count: active.length,
    waiting_item_count: waitish.length,
    all_active_items_waiting: waitish.length === active.length,
  };
}

function collectPlanSurfaceText(plan) {
  return [
    plan?.action,
    plan?.success,
    plan?.defer_if,
    plan?.reason,
  ].filter(Boolean).join("\n").toLowerCase();
}

function countWorkingBodyPrefixMatches(text, prefixes = []) {
  return prefixes.filter((prefix) => text.includes(String(prefix).toLowerCase())).length;
}

function isSelfMaintenancePlan(plan, environmentContext) {
  const planText = collectPlanSurfaceText(plan);
  if (!planText) return false;

  const workingBodyPrefixes = Array.isArray(environmentContext?.working_body_prefixes)
    ? environmentContext.working_body_prefixes
    : [];
  const workingBodyHitCount = countWorkingBodyPrefixMatches(planText, workingBodyPrefixes);
  const nonSelfRoots = (Array.isArray(environmentContext?.accessible_roots) ? environmentContext.accessible_roots : [])
    .filter((root) => !workingBodyPrefixes.some((prefix) => root === prefix || prefix.startsWith(`${root}/`) || root.startsWith(`${prefix}/`)));
  const nonSelfRootHit = nonSelfRoots.some((root) => planText.includes(String(root).toLowerCase()));

  return workingBodyHitCount > 0 && !nonSelfRootHit;
}

function normalizeActiveAims(rawActiveAims, plan) {
  const normalized = Array.isArray(rawActiveAims)
    ? rawActiveAims
      .filter(aim => aim && typeof aim === "object")
      .map((aim) => ({
        description: typeof aim.description === "string" ? aim.description.trim() : "",
        success_test: typeof aim.success_test === "string" ? aim.success_test.trim() : "",
      }))
      .filter((aim) => aim.description && aim.success_test)
    : [];

  const truncated = normalized.length > 1;
  const aims = truncated ? normalized.slice(0, 1) : normalized;

  if (aims.length > 0) {
    return { aims, synthesized: false, truncated };
  }

  const action = typeof plan?.action === "string" ? plan.action.trim() : "";
  const success = typeof plan?.success === "string" ? plan.success.trim() : "";
  if (!action || !success) {
    return { aims: [], synthesized: false, truncated: false };
  }

  return {
    aims: [{ description: action, success_test: success }],
    synthesized: true,
    truncated: false,
  };
}

function buildEnvironmentContext(defaults, identifications, signals = {}) {
  if (defaults?.identity?.enabled !== true) return null;
  const workingBody = identifications?.["identification:working-body"]?.identification || null;
  const roots = Array.isArray(defaults?.identity?.environment_roots)
    ? defaults.identity.environment_roots.filter(Boolean).map(String)
    : [];
  const workingBodyPrefixes = Array.isArray(defaults?.identity?.working_body_prefixes)
    ? defaults.identity.working_body_prefixes.filter(Boolean).map(String)
    : [];
  const waitState = summarizeCarryForwardWaitState(signals?.carryForwardItems || []);
  return {
    working_body: workingBody,
    accessible_roots: roots,
    working_body_prefixes: workingBodyPrefixes,
    ...waitState,
  };
}

function buildCircumstances(events, balances, crashData, pendingRequests, environmentContext) {
  const circumstances = {};
  if (events?.length) circumstances.events = events;
  if (balances) circumstances.balances = balances;
  if (crashData) circumstances.crash = crashData;
  if (pendingRequests?.length) circumstances.pending_requests = pendingRequests;
  if (environmentContext) circumstances.environment_context = environmentContext;
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

function isBootstrapImmediateWake(wake) {
  return wake?.origin === "internal"
    && wake?.context?.bootstrap_fast === true
    && wake?.context?.immediate === true;
}

function shouldQueueBootstrapImmediateWake({ desireCount, drState, retryLimit = 5 }) {
  const status = drState?.status || "idle";
  const lastAppliedSession = drState?.last_applied_session ?? null;
  const consecutiveFailures = Number(drState?.consecutive_failures || 0);
  return desireCount === 0
    && lastAppliedSession == null
    && (status === "idle" || status === "failed")
    && consecutiveFailures < retryLimit;
}

async function hasPendingBootstrapImmediateWake(K) {
  const list = await K.kvList({ prefix: "event:", limit: 50 });
  for (const entry of list.keys || []) {
    const event = await K.kvGet(entry.name);
    if (
      event?.type === "wake"
      && event?.origin === "internal"
      && event?.trigger?.context?.bootstrap_fast === true
      && event?.trigger?.context?.immediate === true
    ) {
      return true;
    }
  }
  return false;
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

function buildPlannerCircumstances(events, balances, crashData, pendingRequests, schedule, capacity, wake, environmentContext) {
  const circumstances = buildCircumstances(events, balances, crashData, pendingRequests, environmentContext);
  if (typeof schedule?.no_action_streak === "number") {
    circumstances.no_action_streak = schedule.no_action_streak;
  }
  if (capacity) circumstances.capacity = capacity;
  if (wake) circumstances.wake = wake;
  return circumstances;
}

function normalizeBurstSchedule(schedule) {
  const remaining = Number(schedule?.burst_remaining || 0);
  return Number.isFinite(remaining) && remaining > 0
    ? Math.floor(remaining)
    : 0;
}

function buildNextSessionSchedule({
  currentSchedule,
  defaults,
  circumstances,
  cyclesRun,
  sessionCount,
  desireCount,
}) {
  let scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  const idleInterval = defaults?.schedule?.idle_interval_seconds || 1800;
  const explorationUnlockStreak = defaults?.schedule?.exploration_unlock_streak || 3;
  const isBootstrapNoAction = cyclesRun === 0
    && sessionCount === 0
    && desireCount === 0;
  const burstRemaining = normalizeBurstSchedule(currentSchedule);

  let noActionStreak = 0;
  if (cyclesRun === 0) {
    noActionStreak = (currentSchedule?.no_action_streak || 0) + 1;
    const capacityHealthy = circumstances?.capacity?.healthy === true;
    if (!isBootstrapNoAction && capacityHealthy && noActionStreak >= explorationUnlockStreak) {
      scheduleInterval = Math.min(scheduleInterval, idleInterval);
    }
  }

  const nextBurstRemaining = burstRemaining > 0 ? burstRemaining - 1 : 0;
  const nextSchedule = {
    next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
    interval_seconds: scheduleInterval,
    no_action_streak: cyclesRun === 0 ? noActionStreak : 0,
  };

  if (nextBurstRemaining > 0) {
    nextSchedule.next_session_after = new Date().toISOString();
    nextSchedule.burst_remaining = nextBurstRemaining;
    if (typeof currentSchedule?.burst_origin === "string" && currentSchedule.burst_origin.trim()) {
      nextSchedule.burst_origin = currentSchedule.burst_origin;
    }
    if (typeof currentSchedule?.burst_reason === "string" && currentSchedule.burst_reason.trim()) {
      nextSchedule.burst_reason = currentSchedule.burst_reason;
    }
  }

  return {
    nextSchedule,
    burstConsumed: burstRemaining > 0,
    nextBurstRemaining,
  };
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
    active_aims: Array.isArray(plan?.active_aims) ? plan.active_aims : [],
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

function deriveFallbackObservation(review, ledger) {
  const explicitObservation = typeof review?.observation === "string" ? review.observation.trim() : "";
  if (explicitObservation) return explicitObservation;
  if (ledger?.plan?.no_action) return "No action was taken.";
  const toolCount = Array.isArray(ledger?.tool_calls) ? ledger.tool_calls.length : 0;
  if (toolCount > 0) {
    return toolCount === 1 ? "One tool call was executed." : `${toolCount} tool calls were executed.`;
  }
  if (typeof ledger?.final_text === "string" && ledger.final_text.trim()) {
    return "An action completed and produced a response.";
  }
  return "An action completed.";
}

function normalizeReview(review, ledger) {
  const observation = deriveFallbackObservation(review, ledger);

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

function deriveExperienceSupport({ ledger, evalResult, now }) {
  const externalAnchorCount = Array.isArray(evalResult?.tool_outcomes) && evalResult.tool_outcomes.length > 0
    ? evalResult.tool_outcomes.length
    : (ledger?.tool_calls || []).filter(call => call?.ok).length;
  const completion = ledger?.plan?.no_action
    ? "no_action"
    : ((ledger?.tool_calls || []).length > 0 || typeof ledger?.final_text === "string"
      ? "full_cycle"
      : "partial");
  const selfGeneratedOnly = externalAnchorCount === 0;
  const grounding = selfGeneratedOnly
    ? (ledger?.plan?.no_action ? "internal_only" : "mixed")
    : "external_event";

  return {
    grounding,
    completion,
    external_anchor_count: externalAnchorCount,
    self_generated_only: selfGeneratedOnly,
    recurrence_count: 1,
    first_observed_at: now,
    last_observed_at: now,
  };
}

function mergeExperienceSupport(existingSupport = {}, nextSupport = {}, now) {
  const groundingValues = [existingSupport.grounding, nextSupport.grounding];
  const grounding = groundingValues.includes("external_event")
    ? "external_event"
    : groundingValues.includes("mixed")
      ? "mixed"
      : "internal_only";
  const existingCompletion = existingSupport.completion || null;
  const nextCompletion = nextSupport.completion || null;
  const completion = [existingCompletion, nextCompletion].includes("full_cycle")
    ? "full_cycle"
    : [existingCompletion, nextCompletion].includes("no_action")
      ? "no_action"
      : nextCompletion || existingCompletion || "partial";

  return {
    grounding,
    completion,
    external_anchor_count: Math.max(
      Number(existingSupport.external_anchor_count || 0),
      Number(nextSupport.external_anchor_count || 0),
    ),
    self_generated_only: Boolean(existingSupport.self_generated_only ?? true)
      && Boolean(nextSupport.self_generated_only ?? true),
    recurrence_count: Number(existingSupport.recurrence_count || 1) + 1,
    first_observed_at: existingSupport.first_observed_at || nextSupport.first_observed_at || now,
    last_observed_at: now,
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

const PLANNER_CONTEXT_BLOCKED_PREFIXES = [
  "reflect:",
  "last_reflect",
  "action:",
  "experience:",
  "pattern:",
  "desire:",
  "tactic:",
  "principle:",
];

function isPlannerContinuityKeyAllowed(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  return !PLANNER_CONTEXT_BLOCKED_PREFIXES.some(prefix =>
    prefix.endsWith(":") ? key.startsWith(prefix) : key === prefix
  );
}

function formatCarryForwardPlannerLine(item) {
  const priority = item.priority ? `[${item.priority}] ` : "";
  const desire = item.desire_key ? ` (supports ${item.desire_key})` : "";
  const details = [];
  if (item.blocked_on) details.push(`blocked_on=${item.blocked_on}`);
  if (item.wake_condition) details.push(`wake_condition=${item.wake_condition}`);
  const lastResult = item.last_result || item.result;
  if (lastResult) details.push(`last_result=${lastResult}`);
  return `- ${priority}${item.item}${desire}${details.length ? ` | ${details.join(" | ")}` : ""}`;
}

function formatIdentificationPlannerLine(key, value) {
  const strength = typeof value?.strength === "number"
    ? ` (strength ${value.strength.toFixed(2)})`
    : "";
  return `- ${key}: ${value?.identification || ""}${strength}`;
}

const IDENTIFICATION_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "through", "into", "from",
  "ongoing", "unfinished", "operational", "body", "mine", "care", "your",
  "swayambhu", "within", "across", "surface", "surfaces", "continuity",
  "legitimate", "boundary", "responsibility",
]);

function normalizeSurfaceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIdentificationTerms(key, record) {
  const slugText = key.replace(/^identification:/, "").replace(/[-_:]+/g, " ");
  const bodyText = typeof record?.identification === "string" ? record.identification : "";
  const tokens = `${slugText} ${bodyText}`
    .split(/[^a-zA-Z0-9]+/)
    .map(token => token.toLowerCase())
    .filter(token => token.length >= 4 && !IDENTIFICATION_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function collectSessionSurfaceText({ ledger, reviewRecord, pendingRequests }) {
  const parts = [
    ledger?.plan?.action,
    ledger?.plan?.success,
    ledger?.plan?.reason,
    ledger?.final_text,
    reviewRecord?.observation,
    reviewRecord?.assessment,
    reviewRecord?.accomplished,
    reviewRecord?.next_gap,
    reviewRecord?.narrative,
    ...(Array.isArray(reviewRecord?.key_findings) ? reviewRecord.key_findings : []),
    ...(Array.isArray(pendingRequests) ? pendingRequests.map(request => request?.summary).filter(Boolean) : []),
  ];
  for (const call of ledger?.tool_calls || []) {
    parts.push(call?.tool);
    if (typeof call?.input === "string") parts.push(call.input);
    else if (call?.input != null) parts.push(JSON.stringify(call.input));
    if (typeof call?.output === "string") parts.push(call.output);
    else if (call?.output != null) parts.push(JSON.stringify(call.output));
  }
  return normalizeSurfaceText(parts.filter(Boolean).join(" "));
}

function inferExercisedIdentificationKeys(identifications, context) {
  const surfaceText = collectSessionSurfaceText(context);
  if (!surfaceText) return [];

  const matches = [];
  const toolNames = new Set((context?.ledger?.tool_calls || []).map(call => call?.tool).filter(Boolean));
  for (const [key, record] of Object.entries(identifications || {})) {
    if (key === "identification:working-body") continue;
    const terms = extractIdentificationTerms(key, record);
    if (terms.length === 0) continue;
    const hitCount = terms.filter(term => surfaceText.includes(term)).length;
    const communicationLike = (
      toolNames.has("request_message")
      || toolNames.has("send_email")
      || toolNames.has("send_slack")
      || toolNames.has("send_whatsapp")
    ) && terms.some(term => ["patron", "relationship", "follow", "followthrough", "promise", "continuity"].includes(term));
    const workspaceLike = (
      toolNames.has("computer")
      || toolNames.has("delegate_task")
      || toolNames.has("google_docs")
    ) && terms.some(term => ["workspace", "repo", "docs", "document", "maintenance", "integrity"].includes(term));
    if (hitCount >= 2 || communicationLike || workspaceLike) {
      matches.push(key);
    }
  }
  return matches;
}

// ── Plan phase ──────────────────────────────────────────────

async function planPhase(K, { desires, patterns, identifications, circumstances, priorActions, defaults, modelsConfig, carryForwardItems, reflectLoadedContext, pendingRequests }) {
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
  const workingBody = defaults?.identity?.enabled === true
    ? identifications?.["identification:working-body"]
    : null;
  if (workingBody?.identification) {
    sections.push("[WORKING BODY]");
    sections.push(`${workingBody.identification}`);
    sections.push("Treat this as the operational body through which outward work can be discovered and acted upon, not as a target for self-audit.");
    sections.push("");
  }
  let plannerIdentifications = [];
  if (defaults?.identity?.enabled === true) {
    plannerIdentifications = Object.entries(identifications || {})
      .filter(([key]) => key !== "identification:working-body")
      .sort(([, a], [, b]) => (Number(b?.strength || 0) - Number(a?.strength || 0)))
      .slice(0, defaults?.identity?.max_planner_items || 5);
  }
  if (plannerIdentifications.length) {
    sections.push("[IDENTIFICATIONS]", "(read-only boundaries of what is mine to care for; neither goals nor tactics)");
    for (const [key, value] of plannerIdentifications) {
      sections.push(formatIdentificationPlannerLine(key, value));
    }
    sections.push("");
  }
  if (tactics.length) {
    sections.push("[TACTICS]");
    for (const t of tactics) {
      sections.push(`- ${t.slug || t.key}: ${t.description}`);
    }
    sections.push("");
  }
  if (carryForwardItems?.length) {
    sections.push("[CARRY-FORWARD]", "(operational continuity only — use as facts or pending commitments, not as conclusions)");
    for (const item of carryForwardItems) {
      sections.push(formatCarryForwardPlannerLine(item));
    }
    sections.push("");
  }
  if (reflectLoadedContext && Object.keys(reflectLoadedContext).length) {
    sections.push("[REFLECT-LOADED CONTEXT]", "(factual continuity keys only — reflective/self-interpretive keys are withheld)");
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
    "Respond with a JSON plan object: { action, success, active_aims, serves_desires, follows_tactics, defer_if, no_action }",
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

  const bootstrapIdentityOnly = defaults?.identity?.enabled === true
    && Object.keys(identifications || {}).filter(key => key !== "identification:working-body").length === 0;
  const allowSelfMaintenanceProbe = Array.isArray(pendingRequests) && pendingRequests.length > 0;
  if (!plan.no_action && bootstrapIdentityOnly && !allowSelfMaintenanceProbe && isSelfMaintenancePlan(plan, circumstances?.environment_context)) {
    await K.karmaRecord({
      event: "plan_self_maintenance_probe_blocked",
      action: plan.action || null,
    });
    const redirected = await K.callLLM({
      model,
      step: "plan_retry_self_surface",
      effort: defaults?.act?.effort || "low",
      maxTokens: defaults?.act?.max_output_tokens || 2000,
      systemPrompt,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: JSON.stringify(plan) },
        {
          role: "user",
          content: "That plan spends the bootstrap probe on self-maintenance (git/repo/kernel/userspace/prompt/bug-list/self-description work). Choose a different non-self reachable surface or root instead, unless there is an explicit maintenance need. Respond with ONLY a valid JSON plan object.",
        },
      ],
      tools: [],
      json: true,
    });
    if (redirected?.parsed && !isSelfMaintenancePlan(redirected.parsed, circumstances?.environment_context)) {
      plan = redirected.parsed;
    } else {
      return {
        no_action: true,
        reason: "Bootstrap self-maintenance probe blocked; no non-self replacement plan was produced.",
      };
    }
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
  const { aims: activeAims, synthesized: activeAimSynthesized, truncated: activeAimTruncated } =
    normalizeActiveAims(plan.active_aims, plan);
  plan.active_aims = activeAims;
  delete plan.relies_on;

  if (activeAimTruncated) {
    await K.karmaRecord({
      event: "plan_multiple_active_aims_truncated",
      count: Array.isArray(plan.active_aims) ? plan.active_aims.length : null,
    });
  }
  if (activeAimSynthesized) {
    await K.karmaRecord({
      event: "plan_active_aim_synthesized",
      action: plan.action || null,
    });
  }

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
  if (plan.active_aims.length === 0) {
    await K.karmaRecord({
      event: "plan_missing_active_aim",
      action: plan.action || null,
    });
    return null;
  }

  return plan;
}

// ── Act phase ───────────────────────────────────────────────

async function actPhase(K, { plan, systemPrompt, messages, tools, model, effort, maxTokens, defaults, pendingRequests, signal }) {
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

async function writeMemory(K, { ledger, evalResult, review, desires, patterns, identifications, pendingRequests, inferenceConfig, executionId, sessionNumber, cycle }) {
  const now = new Date().toISOString();
  const cap = (s, n = 500) => s && s.length > n ? s.slice(0, n) + '…' : s;
  const reviewRecord = normalizeReview(review, ledger);
  const exercisedIdentificationKeys = inferExercisedIdentificationKeys(identifications, {
    ledger,
    reviewRecord,
    pendingRequests,
  });
  const identityEnabled = Object.keys(identifications || {}).length > 0;

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
    ...(identityEnabled ? { exercised_identifications: exercisedIdentificationKeys } : {}),
  });

  if (identityEnabled) {
    const touched = new Set(exercisedIdentificationKeys);
    if (identifications["identification:working-body"]) {
      touched.add("identification:working-body");
    }
    for (const key of touched) {
      const result = await K.kvWriteGated({
        op: "field_merge",
        key,
        fields: { last_exercised_at: now },
      }, "act");
      if (!result.ok) {
        await K.karmaRecord({ event: "identification_exercise_write_failed", key, error: result.error });
      }
    }
  }

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
      const writeResult = await K.kvWriteGated({
        op: "field_merge",
        key,
        fields: { strength: newStrength },
      }, "act");
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
          texts: [reviewRecord.observation]
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
      support: deriveExperienceSupport({ ledger, evalResult, now }),
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
      let closestExperience = null;
      let closestKey = null;
      for (const k of recentKeys) {
        const recentExp = await K.kvGet(k.name);
        if (recentExp?.embedding) {
          const sim = cosineSimilarity(embedding, recentExp.embedding);
          if (sim > maxSim) {
            maxSim = sim;
            closestExperience = recentExp;
            closestKey = k.name;
          }
        }
      }
      if (maxSim > 0.95 && closestExperience && closestKey) {
        const mergedSupport = mergeExperienceSupport(closestExperience.support, experienceRecord.support, now);
        await K.kvWriteSafe(closestKey, {
          ...closestExperience,
          support: mergedSupport,
        });
        await K.karmaRecord({
          event: "experience_recurrence_merged",
          key: closestKey,
          similarity: maxSim,
          recurrence_count: mergedSupport.recurrence_count,
        });
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
        observation: `Session ${crashData.dead_execution_id} was killed after ${elapsed}s. ${llmCalls} LLM calls and ${toolCalls} tool calls ran. Last activity: ${lastStep}.`,
        desire_alignment: { top_positive: [], top_negative: [], affinity_magnitude: 0 },
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
        support: {
          grounding: "external_event",
          completion: "aborted",
          external_anchor_count: toolCalls,
          self_generated_only: false,
          recurrence_count: 1,
          first_observed_at: new Date().toISOString(),
          last_observed_at: new Date().toISOString(),
        },
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
  const bootstrapImmediateWake = isBootstrapImmediateWake(wake);
  const bypassScheduleGate = externalWake || bootstrapImmediateWake;
  if (schedule?.next_session_after) {
    if (!bypassScheduleGate && Date.now() < new Date(schedule.next_session_after).getTime()) {
      return { skipped: true };
    }
  }
  if (bypassScheduleGate && schedule?.next_session_after && Date.now() < new Date(schedule.next_session_after).getTime()) {
    await K.karmaRecord({
      event: "schedule_gate_bypassed",
      reason: externalWake ? "external_wake" : "internal_immediate_wake",
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
  const identifications = defaults?.identity?.enabled === true ? await loadIdentifications(K) : {};

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

  // 2e. Load recent actions from KV for cross-session planner context
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

  const environmentContext = buildEnvironmentContext(defaults, identifications, {
    priorActions,
    carryForwardItems,
    lastReflect,
    pendingRequests,
  });

  // 2d. Load keys requested by last reflect's next_act_context.load_keys
  const requestedLoadKeys = (lastReflect?.next_act_context?.load_keys || []).slice(0, 10);
  const alreadyLoaded = new Set([...Object.keys(desires), ...Object.keys(patterns)]);
  const reflectLoadedContext = {};
  const blockedReflectLoadKeys = [];
  for (const key of requestedLoadKeys) {
    if (alreadyLoaded.has(key)) continue;
    if (!isPlannerContinuityKeyAllowed(key)) {
      blockedReflectLoadKeys.push(key);
      continue;
    }
    const val = await K.kvGet(key);
    if (val != null) reflectLoadedContext[key] = val;
  }
  if (blockedReflectLoadKeys.length) {
    await K.karmaRecord({
      event: "reflect_load_keys_blocked",
      blocked_keys: blockedReflectLoadKeys,
    });
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
    environmentContext,
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
    // After DR has successfully applied once, empty desires are no longer
    // treated as a purely pre-bootstrap mechanical state.
    const drHasBeenApplied = drState?.last_applied_session != null;
    const emptyDesireBootstrap = Object.keys(desires).length === 0 && pendingRequests.length === 0;
    let plan = (emptyDesireBootstrap && !drHasBeenApplied)
      ? deriveBootstrapNoActionPlan({ circumstances })
      : await planPhase(K, { desires, patterns, identifications, circumstances, priorActions, defaults, modelsConfig, carryForwardItems, reflectLoadedContext, pendingRequests });
    if (!plan && emptyDesireBootstrap && drHasBeenApplied) {
      await K.karmaRecord({
        event: "bootstrap_planner_fallback_no_action",
        no_action_streak: circumstances?.no_action_streak || 0,
      });
      plan = deriveBootstrapNoActionPlan({ circumstances });
    }
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
          observation: "No changes in circumstances. No action taken.",
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
        await writeMemory(K, { ledger: noActionLedger, evalResult, review: syntheticReview, desires, patterns, identifications, pendingRequests, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

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
      await writeMemory(K, { ledger, evalResult, review, desires, patterns, identifications, pendingRequests, inferenceConfig, executionId, sessionNumber: sessionCount + 1, cycle });

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
        environmentContext,
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
  const currentSchedule = await K.kvGet("session_schedule");
  const { nextSchedule, burstConsumed, nextBurstRemaining } = buildNextSessionSchedule({
    currentSchedule,
    defaults,
    circumstances,
    cyclesRun,
    sessionCount,
    desireCount: Object.keys(desires).length,
  });
  await K.kvWriteSafe("session_schedule", nextSchedule);
  if (burstConsumed) {
    await K.karmaRecord({
      event: "burst_session_progress",
      burst_origin: currentSchedule?.burst_origin || null,
      burst_reason: currentSchedule?.burst_reason || null,
      remaining: nextBurstRemaining,
      immediate_next: nextBurstRemaining > 0,
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

function isStageableCodeTarget(target) {
  return typeof target === "string"
    && (target.startsWith("tool:") || target.startsWith("hook:") || target.startsWith("provider:") || target.startsWith("channel:"))
    && target.endsWith(":code");
}

function looksLikeReplacementSource(code) {
  if (typeof code !== "string") return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/\b(import|export|function|class|const|let|var|async)\b/.test(trimmed)) return true;
  if (trimmed.includes("=>")) return true;
  if (trimmed.includes("{") && trimmed.includes("}") && /[;=]/.test(trimmed)) return true;
  return false;
}

function toPrivilegedOp(op) {
  return op.op === "delete"
    ? { key: op.key, op: "delete" }
    : op.op === "patch"
    ? { key: op.key, op: "patch", old_string: op.old_string, new_string: op.new_string, deliberation: op.deliberation }
    : { key: op.key, op: "put", value: op.value, ...(op.deliberation ? { deliberation: op.deliberation } : {}) };
}

function trimProcessedNoteKeys(keys, limit) {
  const max = Math.max(1, Number(limit || 50));
  return Array.isArray(keys) ? keys.slice(-max) : [];
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
      await K.writeLifecycleState("dr:state:1", state);
      await K.karmaRecord({ event: "dr_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return { handledJobIds };
    }

    const result = await pollJobResult(K, state, defaults);

    if (result.status === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      await K.writeLifecycleState(`dr:result:${state.generation}`, result.output);
      await updateJobRecord(K, state.job_id, "completed");
      await K.writeLifecycleState("dr:state:1", state);
    } else if (result.status === "failed") {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = result.error || "non-zero exit code";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await updateJobRecord(K, state.job_id, "failed");
      await K.writeLifecycleState("dr:state:1", state);
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
      await K.writeLifecycleState("dr:state:1", state);
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

    await K.deleteLifecycleState(`dr:result:${state.generation}`);
    await K.writeLifecycleState("dr:state:1", state);
    return { handledJobIds };
  }

  if (phase === "pre") {
    return { handledJobIds };
  }

  if (state.status === "failed") {
    const bootstrapIncomplete = state.last_applied_session == null;
    if (!bootstrapIncomplete) {
      const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
      if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) return { handledJobIds };
    }
    state.status = "idle";
    state.next_due_session = sessionCount;
    await K.writeLifecycleState("dr:state:1", state);
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
      await K.writeLifecycleState("dr:state:1", state);
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
    await K.writeLifecycleState("dr:state:1", state);
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
          "pattern:*", "experience:*", "desire:*", "tactic:*", "identification:*",
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

async function listPendingUserspaceReviewNotes(K, state, defaults) {
  const list = await K.kvList({ prefix: "review_note:userspace_review:" });
  const processedKeys = new Set(state.processed_note_keys || []);
  const processedThroughMs = state.processed_through_created_at
    ? new Date(state.processed_through_created_at).getTime()
    : 0;
  const candidates = [];

  for (const entry of list.keys || []) {
    const key = entry.name;
    if (processedKeys.has(key)) continue;
    const note = await K.kvGet(key);
    if (!note) continue;
    const createdMs = note.created_at ? new Date(note.created_at).getTime() : 0;
    if (processedThroughMs && createdMs && createdMs <= processedThroughMs) continue;
    candidates.push({ key, note, createdMs });
  }

  candidates.sort((a, b) => a.createdMs - b.createdMs || a.key.localeCompare(b.key));
  return candidates.slice(0, Math.max(1, Number(defaults?.dr2?.max_processed_note_keys || 50)));
}

async function isDr2Due(K, state, defaults) {
  if (defaults?.dr2?.enabled !== true) return false;
  if (!state.generation) return true;
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;
  return false;
}

async function dispatchDr2(K, defaults, reviewNoteKey) {
  const dr2 = defaults?.dr2 || {};
  const repoDir = dr2.repo_dir || "/home/swami/swayambhu/repo";
  const esc = (value) => String(value).replace(/'/g, "'\\''");
  const stateLab = await K.kvGet("kernel:state_lab");
  const reviewNote = await K.kvGet(reviewNoteKey);
  const sourceMap = await K.kvGet("kernel:source_map");
  const directSourceKeys = [...new Set(
    Object.values(sourceMap || {})
      .filter((value) => typeof value === "string" && !value.includes("*"))
  )];
  const configuredSourceRef = typeof dr2.source_ref === "string" ? dr2.source_ref : null;
  const sourceRef = configuredSourceRef && configuredSourceRef !== "current"
    ? configuredSourceRef
    : (stateLab?.ref || configuredSourceRef || "current");
  const envPrefix = [];
  if (Number.isFinite(Number(dr2.review_timeout_ms)) && Number(dr2.review_timeout_ms) > 0) {
    envPrefix.push(`export SWAYAMBHU_USERSPACE_REVIEW_TIMEOUT_MS='${esc(Number(dr2.review_timeout_ms))}'`);
  }
  if (Number.isFinite(Number(dr2.author_timeout_ms)) && Number(dr2.author_timeout_ms) > 0) {
    envPrefix.push(`export SWAYAMBHU_USERSPACE_AUTHOR_TIMEOUT_MS='${esc(Number(dr2.author_timeout_ms))}'`);
  }
  const args = [
    "--review-note-key", reviewNoteKey,
    "--source-ref", sourceRef,
    "--review-runner", dr2.review_runner || "codex",
    "--author-runner", dr2.author_runner || "codex",
  ];
  if (typeof dr2.adversarial_runner === "string" && dr2.adversarial_runner.trim()) {
    args.push("--adversarial-runner", dr2.adversarial_runner.trim());
    if (Number.isFinite(Number(dr2.adversarial_timeout_ms)) && Number(dr2.adversarial_timeout_ms) > 0) {
      args.push("--adversarial-timeout-ms", String(Number(dr2.adversarial_timeout_ms)));
    }
    if (Number.isFinite(Number(dr2.adversarial_max_rounds)) && Number(dr2.adversarial_max_rounds) > 0) {
      args.push("--adversarial-max-rounds", String(Number(dr2.adversarial_max_rounds)));
    }
  }
  const command = [
    "export SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR=\"$PWD\"",
    `cd '${esc(repoDir)}' || exit 1`,
    ...envPrefix,
    `node lib/dr2-lab-run.js ${args.map((arg) => `'${esc(arg)}'`).join(" ")}`,
  ].join("\n");

  const result = await K.executeToolCall({
    id: `dr2_dispatch_${Date.now()}`,
    function: {
      name: "start_job",
      arguments: JSON.stringify({
        type: "custom",
        command,
        context_keys: [
          reviewNoteKey,
          ...(reviewNote?.source_reflect_key ? [reviewNote.source_reflect_key] : []),
          "last_reflect",
          "config:defaults",
          "prompt:plan",
          "prompt:reflect",
          "prompt:deep_reflect",
          "kernel:source_map",
          ...directSourceKeys,
        ],
      }),
    },
  });

  if (!result?.ok) return null;
  return { job_id: result.job_id, workdir: result.workdir };
}

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildRemoteBase64ReadCommand(path) {
  const esc = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  return `node -e "const fs=require('fs');try{process.stdout.write(fs.readFileSync(process.argv[1]).toString('base64'))}catch{process.exit(0)}" '${esc(path)}'`;
}

function decodeBase64Utf8(base64) {
  const normalized = String(base64 || "").replace(/\s+/g, "");
  if (!normalized) return "";
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readRemoteJsonArtifact(K, defaults, path, { missingError, invalidError }) {
  const jobs = defaults?.jobs || {};
  let artifactResult;
  try {
    artifactResult = await K.executeAdapter("provider:compute", {
      command: buildRemoteBase64ReadCommand(path),
      baseUrl: jobs.base_url,
      timeout: 10,
    });
  } catch {
    return { ok: false, error: missingError };
  }

  if (!artifactResult?.ok) {
    return { ok: false, error: missingError };
  }

  const rawBase64 = Array.isArray(artifactResult.output)
    ? artifactResult.output.map((entry) => entry.data || "").join("")
    : String(artifactResult.output || "");
  if (!rawBase64.trim()) {
    return { ok: false, error: missingError };
  }

  let raw;
  try {
    raw = decodeBase64Utf8(rawBase64);
  } catch {
    return { ok: false, error: invalidError };
  }

  try {
    return { ok: true, raw, parsed: JSON.parse(raw) };
  } catch {
    return { ok: false, error: invalidError };
  }
}

async function verifyDr2StageableResult(K, state, output, defaults, { labResult = null } = {}) {
  if (output?.promotion_recommendation !== "stageable") return { ok: true };
  if (!output?.validated_changes_hash || !state?.workdir) {
    return { ok: false, error: "stageable_result_missing_verification_fields" };
  }

  const recomputedHash = await sha256Json(output.validated_changes || null);
  if (recomputedHash !== output.validated_changes_hash) {
    return { ok: false, error: "validated_changes_content_hash_mismatch" };
  }

  let parsed = labResult;
  if (!parsed) {
    const trustedBundledLabResultPath =
      typeof output?.lab_result_path === "string"
        && /\/state-lab\/dr2-runs\/.+\/lab-result\.json$/.test(output.lab_result_path)
        ? output.lab_result_path.trim()
        : null;
    const candidatePaths = [
      trustedBundledLabResultPath,
      `${state.workdir}/lab-result.json`,
    ].filter(Boolean);

    let lastError = "could_not_read_lab_result";
    for (const path of candidatePaths) {
      const artifact = await readRemoteJsonArtifact(K, defaults, path, {
        missingError: "could_not_read_lab_result",
        invalidError: "lab_result_not_json",
      });
      if (!artifact.ok) {
        lastError = artifact.error;
        continue;
      }
      parsed = artifact.parsed;
      break;
    }
    if (!parsed) return { ok: false, error: lastError };
  }

  if (parsed.review_note_key !== output.review_note_key) {
    return { ok: false, error: "review_note_key_mismatch" };
  }
  if (parsed.validated_changes_hash !== output.validated_changes_hash) {
    return { ok: false, error: "validated_changes_hash_mismatch" };
  }
  return { ok: true };
}

async function hydrateCompletedJobResult(K, job, defaults) {
  if (!job?.id || !job?.workdir) {
    return { ok: false, error: "job_result_missing_after_callback" };
  }

  const jobs = defaults?.jobs || {};
  const esc = (value) => String(value).replace(/'/g, "'\\''");
  let outputResult;
  try {
    outputResult = await K.executeAdapter("provider:compute", {
      command: `cat '${esc(job.workdir)}/output.json' 2>/dev/null || echo '{}'`,
      baseUrl: jobs.base_url,
      timeout: 10,
    });
  } catch {
    return { ok: false, error: "job_result_missing_after_callback" };
  }

  if (!outputResult?.ok) {
    return { ok: false, error: "job_result_missing_after_callback" };
  }

  const raw = Array.isArray(outputResult.output)
    ? outputResult.output.map((entry) => entry.data || "").join("")
    : String(outputResult.output || "");
  const { payload, meta } = parseJobOutput(raw);
  if (!payload || typeof payload !== "object" || typeof payload.review_note_key !== "string") {
    return { ok: false, error: "job_result_missing_after_callback" };
  }

  const jobResult = {
    job_id: job.id,
    type: job.type,
    result: payload,
    ...(meta ? { meta } : {}),
  };

  const labArtifact = await readRemoteJsonArtifact(K, defaults, `${job.workdir}/lab-result.json`, {
    missingError: "lab_result_missing_after_callback",
    invalidError: "lab_result_not_json",
  });
  if (labArtifact.ok) {
    jobResult.lab_result = labArtifact.parsed;
  }

  const resultKey = job.result_key || `job_result:${job.id}`;
  job.result_key = resultKey;
  await K.kvWriteSafe(resultKey, jobResult, { unprotected: true });
  await K.kvWriteSafe(`job:${job.id}`, job, { unprotected: true });
  return { ok: true, jobResult };
}

async function readDr2ResultFromJobRecord(K, state, defaults) {
  if (!state?.job_id) return null;
  const job = await K.kvGet(`job:${state.job_id}`);
  if (!job) return null;
  if (job.status !== "completed" && job.status !== "failed") return null;

  const resultKey = job.result_key || `job_result:${job.id}`;
  let jobResult = await K.kvGet(resultKey);
  if (!jobResult) {
    const hydration = await hydrateCompletedJobResult(K, job, defaults);
    if (!hydration.ok) {
      return { status: "failed", error: hydration.error };
    }
    jobResult = hydration.jobResult;
  }

  if (!jobResult || typeof jobResult !== "object") {
    return { status: "failed", error: "job_result_missing" };
  }

  const payload = (jobResult.result && typeof jobResult.result === "object")
    ? jobResult.result
    : ((jobResult.lab_result && typeof jobResult.lab_result === "object")
      ? jobResult.lab_result
      : null);
  if (!payload) {
    return { status: "failed", error: jobResult?.callback_error || "job_result_missing" };
  }
  if (payload.review_note_key !== state.active_review_note_key) {
    return { status: "failed", error: "review_note_key mismatch" };
  }

  const verification = await verifyDr2StageableResult(K, state, payload, defaults, {
    labResult: jobResult.lab_result || null,
  });
  if (!verification.ok) {
    return { status: "failed", error: verification.error };
  }

  return { status: "completed", output: payload, meta: jobResult.meta || null };
}

async function pollDr2Result(K, state, defaults) {
  const jobs = defaults?.jobs || {};
  const esc = (value) => String(value).replace(/'/g, "'\\''");

  const completedJobResult = await readDr2ResultFromJobRecord(K, state, defaults);
  if (completedJobResult) return completedJobResult;

  let checkResult;
  try {
    checkResult = await K.executeAdapter("provider:compute", {
      command: `test -f '${esc(state.workdir)}/exit_code' && cat '${esc(state.workdir)}/exit_code' || echo RUNNING`,
      baseUrl: jobs.base_url,
      timeout: 5,
    });
  } catch {
    return { status: "running" };
  }

  if (!checkResult?.ok) return { status: "running" };

  const exitText = Array.isArray(checkResult.output)
    ? checkResult.output.map((entry) => entry.data || "").join("").trim()
    : String(checkResult.output || "").trim();

  if (exitText === "RUNNING") return { status: "running" };

  const exitCode = parseInt(exitText, 10);
  if (exitCode !== 0) return { status: "failed", error: `exit code ${exitCode}` };

  const outputArtifact = await readRemoteJsonArtifact(K, defaults, `${state.workdir}/output.json`, {
    missingError: "could not read output",
    invalidError: "could not parse output.json",
  });
  if (!outputArtifact.ok) return { status: "failed", error: outputArtifact.error };

  const raw = outputArtifact.raw;
  const { payload, meta } = parseJobOutput(raw);

  if (!payload || typeof payload !== "object") {
    return { status: "failed", error: "could not parse output.json" };
  }
  if (payload.review_note_key !== state.active_review_note_key) {
    return { status: "failed", error: "review_note_key mismatch" };
  }

  const verification = await verifyDr2StageableResult(K, state, payload, defaults);
  if (!verification.ok) {
    return { status: "failed", error: verification.error };
  }

  return { status: "completed", output: payload, meta };
}

async function applyDr2ValidatedChanges(K, output) {
  const changes = output?.validated_changes || {};
  const kvOps = Array.isArray(changes.kv_operations) ? changes.kv_operations : [];
  const codeStageRequests = Array.isArray(changes.code_stage_requests) ? changes.code_stage_requests : [];
  const blocked = [];
  let appliedKv = 0;
  let stagedCode = 0;

  for (const op of kvOps) {
    const result = await K.kvWriteGated(toPrivilegedOp(op), "userspace-review");
    if (!result?.ok) {
      blocked.push({ key: op.key, error: result?.error || "unknown error" });
      continue;
    }
    appliedKv += 1;
  }

  for (const req of codeStageRequests) {
    const target = req?.target || null;
    if (!isStageableCodeTarget(target)) {
      blocked.push({ key: target, error: "invalid_code_stage_target" });
      continue;
    }
    if (!looksLikeReplacementSource(req?.code)) {
      blocked.push({ key: target, error: "code_stage_requires_replacement_source" });
      continue;
    }
    try {
      await K.stageCode(target, req.code);
      stagedCode += 1;
    } catch (error) {
      blocked.push({ key: target, error: error.message });
    }
  }

  if (stagedCode > 0 && changes.deploy !== false) {
    await K.signalDeploy();
    await K.karmaRecord({ event: "deploy_requested_by_dr2", staged: stagedCode });
  }

  await K.karmaRecord({
    event: "dr2_validated_changes_applied",
    applied_kv: appliedKv,
    staged_code: stagedCode,
    blocked,
    review_note_key: output.review_note_key || null,
  });

  return { appliedKv, stagedCode, blocked };
}

async function dr2Cycle(K, { phase = "post", events = [] } = {}) {
  await K.karmaRecord({ event: "dr2_cycle_entered", phase });
  const defaults = await K.getDefaults();
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  const state = await K.kvGet("dr2:state:1") || {
    status: "idle",
    generation: 0,
    consecutive_failures: 0,
    processed_note_keys: [],
    processed_through_created_at: null,
  };
  const enabled = defaults?.dr2?.enabled === true;
  await K.karmaRecord({
    event: "dr2_gate_state",
    phase,
    enabled,
    status: state.status || null,
    generation: state.generation || 0,
    next_due_session: state.next_due_session ?? null,
    next_due_date: state.next_due_date ?? null,
    session_count: sessionCount,
  });
  if (!enabled) return { handledJobIds: [] };

  const callbackJobIds = new Set(
    (events || [])
      .filter((event) => event?.type === "job_complete")
      .map(getEventJobId)
      .filter(Boolean),
  );
  const hasMatchingCallback = !!(state.job_id && callbackJobIds.has(state.job_id));
  const handledJobIds = hasMatchingCallback ? [state.job_id] : [];

  if (state.status === "dispatched" && (phase !== "pre" || hasMatchingCallback)) {
    const ttl = defaults?.dr2?.timeout_minutes || defaults?.jobs?.default_ttl_minutes || 30;
    const age = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
    if (age > ttl) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = `TTL expired after ${Math.round(age)} minutes`;
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await updateJobRecord(K, state.job_id, "expired");
      await K.writeLifecycleState("dr2:state:1", state);
      await K.karmaRecord({ event: "dr2_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return { handledJobIds };
    }

    const result = await pollDr2Result(K, state, defaults);
    if (result.status === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      state.result_ref = result.output?.lab_result_path || null;
      await K.writeLifecycleState(`dr2:result:${state.generation}`, result.output);
      await updateJobRecord(K, state.job_id, "completed");
      await K.writeLifecycleState("dr2:state:1", state);
    } else if (result.status === "failed") {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = result.error || "non-zero exit code";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await updateJobRecord(K, state.job_id, "failed");
      await K.writeLifecycleState("dr2:state:1", state);
      await K.karmaRecord({ event: "dr2_failed", job_id: state.job_id, error: result.error });
      return { handledJobIds };
    } else {
      return { handledJobIds };
    }
  }

  if (state.status === "completed" && (phase !== "pre" || hasMatchingCallback)) {
    const output = await K.kvGet(`dr2:result:${state.generation}`);
    if (!output) {
      state.status = "failed";
      state.failure_reason = "result missing from KV";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await K.writeLifecycleState("dr2:state:1", state);
      return { handledJobIds };
    }

    if (output.promotion_recommendation === "stageable") {
      await applyDr2ValidatedChanges(K, output);
    } else {
      await K.karmaRecord({
        event: "dr2_non_stageable_result",
        review_note_key: output.review_note_key || state.active_review_note_key || null,
        recommendation: output.promotion_recommendation || null,
      });
    }

    const cooldown = Math.max(1, Number(defaults?.dr2?.cooldown_sessions || 3));
    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = sessionCount;
    state.last_execution_id = await K.getExecutionId();
    state.consecutive_failures = 0;
    state.last_failure_session = null;
    state.next_due_session = sessionCount + cooldown;
    state.next_due_date = null;
    state.processed_note_keys = trimProcessedNoteKeys(
      [...(state.processed_note_keys || []), state.active_review_note_key].filter(Boolean),
      defaults?.dr2?.max_processed_note_keys,
    );
    if (state.active_review_note_created_at) {
      state.processed_through_created_at = state.active_review_note_created_at;
    }
    state.active_review_note_key = null;
    state.active_review_note_created_at = null;
    state.job_id = null;
    state.workdir = null;
    state.result_ref = output.lab_result_path || state.result_ref || null;

    await K.deleteLifecycleState(`dr2:result:${state.generation}`);
    await K.writeLifecycleState("dr2:state:1", state);
    return { handledJobIds };
  }

  if (phase === "pre") {
    return { handledJobIds };
  }

  if (state.status === "failed") {
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) {
      return { handledJobIds };
    }
    state.status = "idle";
    state.next_due_session = sessionCount;
    await K.writeLifecycleState("dr2:state:1", state);
  }

  if (state.status === "idle") {
    const due = await isDr2Due(K, state, defaults);
    await K.karmaRecord({
      event: "dr2_due_check",
      phase,
      due,
      generation: state.generation || 0,
      next_due_session: state.next_due_session ?? null,
      next_due_date: state.next_due_date ?? null,
      session_count: sessionCount,
    });
    if (!due) return { handledJobIds };
    const candidates = await listPendingUserspaceReviewNotes(K, state, defaults);
    await K.karmaRecord({
      event: "dr2_idle_scan",
      candidate_count: candidates.length,
      next_review_note_key: candidates[0]?.key || null,
    });
    const nextNote = candidates[0];
    if (!nextNote) return { handledJobIds };

    const dispatch = await dispatchDr2(K, defaults, nextNote.key);
    if (!dispatch) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = "dispatch failed";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = sessionCount;
      await K.writeLifecycleState("dr2:state:1", state);
      await K.karmaRecord({ event: "dr2_dispatch_failed", review_note_key: nextNote.key });
      return { handledJobIds };
    }

    state.status = "dispatched";
    state.generation = (state.generation || 0) + 1;
    state.active_review_note_key = nextNote.key;
    state.active_review_note_created_at = nextNote.note?.created_at || null;
    state.job_id = dispatch.job_id;
    state.workdir = dispatch.workdir;
    state.dispatched_at = new Date().toISOString();
    state.completed_at = null;
    state.applied_at = null;
    state.failed_at = null;
    state.failure_reason = null;
    await K.writeLifecycleState("dr2:state:1", state);
    await K.karmaRecord({
      event: "dr2_dispatched",
      job_id: dispatch.job_id,
      generation: state.generation,
      review_note_key: nextNote.key,
    });
  }

  return { handledJobIds };
}

export async function applyDrResults(K, state, output) {
  const executionId = await K.getExecutionId();
  const metaPolicyNotes = normalizeMetaPolicyNotes(output.meta_policy_notes);
  const defaults = typeof K.getDefaults === "function" ? await K.getDefaults() : {};
  const identityEnabled = defaults?.identity?.enabled === true;

  const candidateOps = output.kv_operations || [];
  const ops = candidateOps.filter(op =>
    op.key?.startsWith("pattern:") || op.key?.startsWith("desire:") ||
    op.key?.startsWith("tactic:") || op.key?.startsWith("principle:") ||
    op.key?.startsWith("config:") || op.key?.startsWith("prompt:") ||
    (identityEnabled && op.key?.startsWith("identification:"))
  );

  const blocked = [];
  if (!identityEnabled) {
    for (const op of candidateOps.filter(op => op.key?.startsWith("identification:"))) {
      blocked.push({ key: op.key, error: "identity_review_disabled" });
    }
  }
  for (const op of ops) {
    const result = await K.kvWriteGated(toPrivilegedOp(op), "deep-reflect");
    if (!result.ok) blocked.push({ key: op.key, error: result.error });
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
    meta_policy_notes: metaPolicyNotes,
  });

  if (metaPolicyNotes.length > 0) {
    await persistMetaPolicyNotes(K, metaPolicyNotes, {
      sessionId: executionId,
      depth: 1,
      source: "deep_reflect",
    });
  }

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
    identifications_changed: ops.filter(o => o.key?.startsWith("identification:")).length,
    meta_policy_notes: metaPolicyNotes.length,
  });

  if (metaPolicyNotes.length > 0) {
    await K.karmaRecord({
      event: "dr_meta_policy_notes_recorded",
      count: metaPolicyNotes.length,
      slugs: metaPolicyNotes.map((note) => note.slug).filter(Boolean),
    });
  }
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
  [['desire:', 'pattern:', 'experience:', 'tactic:', 'identification:'], 'mind'],
  [['dr:', 'dr2:', 'reflect:', 'last_reflect'], 'reflections'],
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

  const preDr2 = await (async () => {
    try {
      return await dr2Cycle(K, { phase: "pre", events });
    } catch (e) {
      await K.karmaRecord({ event: "dr2_cycle_error", phase: "pre", error: e.message, stack: e.stack?.slice(0, 500) });
      return { handledJobIds: [] };
    }
  })();

  const handledJobIds = new Set([
    ...(preDr?.handledJobIds || []),
    ...(preDr2?.handledJobIds || []),
  ]);
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

  try {
    await dr2Cycle(K, { phase: "post", events });
  } catch (e) {
    await K.karmaRecord({ event: "dr2_cycle_error", phase: "post", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  try {
    const finalDrState = await K.kvGet("dr:state:1") || { status: "idle", generation: 0 };
    const finalDesireCount = Object.keys(await loadDesires(K)).length;
    if (
      shouldQueueBootstrapImmediateWake({
        desireCount: finalDesireCount,
        drState: finalDrState,
      })
      && !(await hasPendingBootstrapImmediateWake(K))
    ) {
      await K.emitEvent("wake", {
        origin: "internal",
        trigger: {
          actor: "bootstrap_fast",
          context: {
            bootstrap_fast: true,
            immediate: true,
            reason: "pre_dr_bootstrap",
          },
        },
      });
      await K.karmaRecord({
        event: "bootstrap_fast_wake_enqueued",
        desire_count: finalDesireCount,
        dr_status: finalDrState.status,
        dr_generation: finalDrState.generation || 0,
      });
    }
  } catch (e) {
    await K.karmaRecord({ event: "bootstrap_fast_wake_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }
}

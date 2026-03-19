// Swayambhu Wake Hook — Entry Point
// Session control flow — the entire policy layer that governs what happens
// when the brainstem wakes up. Stored in KV as hook:wake:code, loaded and
// executed by the kernel in a Worker Loader isolate.
//
// Every kernel method is called via K (the KernelRPC binding).
// Every policy method is a local function call.
//
// Named exports for testing, default export for Worker Loader.
// KV key: hook:wake:code

import { applyKVOperation } from './hook-protect.js';
import { initTracking, runCircuitBreaker, retryPendingGitSyncs } from './hook-modifications.js';
import { executeReflect, runReflect, highestReflectDepthDue, getMaxSteps } from './hook-reflect.js';

// ── Wake flow ──────────────────────────────────────────────

export async function wake(K, input) {
  // Load hook-local state eagerly
  let defaults = await K.getDefaults();
  let modelsConfig = await K.getModelsConfig();
  let toolRegistry = await K.getToolRegistry();
  const sessionId = await K.getSessionId();

  // Build shared state object passed to sub-functions
  const state = {
    defaults, modelsConfig, toolRegistry, sessionId,
    async refreshDefaults() {
      state.defaults = await K.getDefaults();
      defaults = state.defaults;
    },
    async refreshModels() {
      state.modelsConfig = await K.getModelsConfig();
      modelsConfig = state.modelsConfig;
    },
    async refreshToolRegistry() {
      state.toolRegistry = await K.getToolRegistry();
      toolRegistry = state.toolRegistry;
    },
  };

  try {
    // 0. Check if it's actually time to wake up
    const wakeConfig = await K.kvGet("wake_config");
    if (wakeConfig?.next_wake_after) {
      if (Date.now() < new Date(wakeConfig.next_wake_after).getTime()) {
        return { skipped: true, reason: "not_time_yet" };
      }
    }

    // 1. Crash detection
    const crashData = await detectCrash(K);

    // 1a-pre. Initialize modification tracking from targeted prefix scans
    const [stagedList, snapshotList] = await Promise.all([
      K.kvList({ prefix: "modification_staged:", limit: 200 }),
      K.kvList({ prefix: "modification_snapshot:", limit: 200 }),
    ]);
    initTracking(
      stagedList.keys.map(k => k.name.slice("modification_staged:".length)),
      snapshotList.keys.map(k => k.name.slice("modification_snapshot:".length)),
    );

    // 1b. Circuit breaker
    await runCircuitBreaker(K);

    // 1c. Retry any pending git syncs from previous promotes
    await retryPendingGitSyncs(K);

    // 2. Load ground truth
    const balances = await getBalances(K, state);

    // 3. Load core state from KV
    defaults = await K.kvGet("config:defaults");
    state.defaults = defaults;
    const lastReflect = await K.kvGet("last_reflect");

    // 4. Merge with defaults
    const config = await K.mergeDefaults(defaults, wakeConfig);

    // 4a. Cache immutable/stable values
    modelsConfig = await K.kvGet("config:models");
    state.modelsConfig = modelsConfig;
    toolRegistry = await K.kvGet("config:tool_registry");
    state.toolRegistry = toolRegistry;

    // 5. Check if reflection is due
    const reflectDepth = await highestReflectDepthDue(K, state);

    // 6. Evaluate tripwires
    const effort = evaluateTripwires(config, { balances });

    // 7. Load context keys
    const loadKeys = lastReflect?.next_orient_context?.load_keys
      || defaults?.memory?.default_load_keys
      || [];
    const additionalContext = await K.loadKeys(loadKeys);

    // 8. Build context
    const context = {
      balances, lastReflect, additionalContext,
      effort, reflectDepth,
      crashData,
    };

    // 10. Record session start
    await K.karmaRecord({
      event: "session_start",
      session_id: sessionId,
      effort,
      crash_detected: !!crashData,
      balances,
    });

    // 11. Run session or reflect
    if (reflectDepth > 0) {
      await runReflect(K, state, reflectDepth, context);
    } else {
      await runSession(K, state, context, config);
    }

    return { ok: true };

  } catch (err) {
    await K.karmaRecord({
      event: "fatal_error",
      error: err.message,
      stack: err.stack,
    });
    return { ok: false, error: err.message };
  }
}

// ── Crash detection ─────────────────────────────────────────

export async function detectCrash(K) {
  const stale = await K.kvGet("kernel:active_session");
  if (!stale) return null;

  // The kernel writes active_session before invoking the hook,
  // so if it matches our current session, it's not a crash.
  const currentId = await K.getSessionId();
  if (stale === currentId) return null;

  const deadKarma = await K.kvGet(`karma:${stale}`);
  return {
    dead_session_id: stale,
    karma: deadKarma,
    last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
  };
}

// ── Normal session ──────────────────────────────────────────

export async function runSession(K, state, context, config) {
  const { defaults, modelsConfig } = state;

  const orientPrompt = await K.kvGet("prompt:orient");
  const resources = await K.kvGet("config:resources");

  // Build skill manifest for orient prompt injection
  const skillList = await K.kvList({ prefix: "skill:", limit: 100 });
  const skill_manifest = [];
  for (const k of skillList.keys) {
    // Skip :ref companion keys
    if (k.name.includes(":ref")) continue;
    const v = await K.kvGet(k.name);
    if (v) {
      try {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        skill_manifest.push({
          key: k.name,
          name: parsed.name,
          description: parsed.description,
          trigger_patterns: parsed.trigger_patterns,
        });
      } catch {}
    }
  }

  const systemPrompt = await K.buildPrompt(orientPrompt, {
    models: modelsConfig,
    resources,
    config,
    skill_manifest: skill_manifest.length ? skill_manifest : null,
  });

  const initialContext = buildOrientContext(context);

  const orientModel = await K.resolveModel(
    config.orient?.model || defaults?.orient?.model
  );

  const tools = await K.buildToolDefinitions();

  // Reserve budget for reflect if configured
  const budget = defaults?.session_budget;
  const reservePct = budget?.reflect_reserve_pct || 0;
  const orientBudgetCap = (budget?.max_cost && reservePct > 0)
    ? budget.max_cost * (1 - reservePct)
    : undefined;

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools,
    model: orientModel,
    effort: context.effort || config.orient?.effort || defaults?.orient?.effort,
    maxTokens: config.orient?.max_output_tokens || defaults?.orient?.max_output_tokens,
    maxSteps: getMaxSteps(state, 'orient'),
    step: 'orient',
    budgetCap: orientBudgetCap,
  });

  // Apply KV operations (gated by protection)
  if (output.kv_operations?.length) {
    for (const op of output.kv_operations) {
      await applyKVOperation(K, op);
    }
  }

  // Session reflect — skip if budget fully exhausted (but not if
  // orient was soft-capped by reflect_reserve_pct)
  const skipReflect = output.budget_exceeded && !reservePct;
  if (!skipReflect) {
    await executeReflect(K, state, { model: defaults?.reflect?.model });
  }

  await writeSessionResults(K, config, { reflectRan: !skipReflect });
}

export function buildOrientContext(context) {
  // Static/stable fields first for prompt caching (prefix match),
  // volatile fields last so cache hits on the stable prefix.
  // current_time is always different — must be last.
  return JSON.stringify({
    additional_context: context.additionalContext,
    last_reflect: context.lastReflect,
    effort: context.effort,
    crash_data: context.crashData,
    balances: context.balances,
    current_time: new Date().toISOString(),
  });
}

// ── Session results ────────────────────────────────────────

export async function writeSessionResults(K, config, { reflectRan = true } = {}) {
  // If reflect was skipped, reset wake_config to system defaults.
  // When reflect runs, it writes wake_config itself — no override needed here.
  if (!reflectRan) {
    const defaults = await K.getDefaults();
    const sleepSeconds = defaults?.wake?.sleep_seconds || 21600;
    await K.kvPutSafe("wake_config", {
      next_wake_after: new Date(Date.now() + sleepSeconds * 1000).toISOString(),
    });
  }

  const count = await K.getSessionCount();
  await K.kvPutSafe("session_counter", count + 1);

  // Cache session ID list for dashboard
  const sessionIds = await K.kvGet("cache:session_ids") || [];
  const sessionId = await K.getSessionId();
  sessionIds.push(sessionId);
  await K.kvPutSafe("cache:session_ids", sessionIds);

  // Write karma summary for efficient investigation by reflect
  const karma = await K.getKarma();
  if (karma.length > 0) {
    await K.kvPutSafe(`karma_summary:${sessionId}`, summarizeKarma(karma));
  }
}

// ── Karma summarization ──────────────────────────────────

export function summarizeKarma(karma) {
  const events = {};
  let total_cost = 0;
  const models = {};
  const tools = {};
  let duration_total = 0;
  let duration_count = 0;
  const errors = [];
  const comms = {};

  for (const entry of karma) {
    events[entry.event] = (events[entry.event] || 0) + 1;

    if (entry.event === 'llm_call') {
      if (entry.cost != null) total_cost += entry.cost;
      if (entry.model) models[entry.model] = (models[entry.model] || 0) + 1;
      if (entry.duration_ms != null) {
        duration_total += entry.duration_ms;
        duration_count++;
      }
    }

    if (entry.event === 'tool_complete' && entry.tool) {
      tools[entry.tool] = (tools[entry.tool] || 0) + 1;
    }

    if (entry.event === 'fatal_error' && entry.error) {
      errors.push(entry.error);
    }

    if (entry.event?.startsWith('comms_')) {
      comms[entry.event] = (comms[entry.event] || 0) + 1;
    }
  }

  return {
    events,
    total_cost,
    models,
    tools,
    duration_ms: { total: duration_total, count: duration_count },
    errors,
    comms,
  };
}

// ── Helpers ────────────────────────────────────────────────

export async function getBalances(K, state) {
  return K.checkBalance({});
}

export function evaluateTripwires(config, liveData) {
  const alerts = config.alerts || [];
  let effort = config.default_effort || config.wake?.default_effort || "low";
  for (const alert of alerts) {
    const value = alert.field.split(".").reduce((o, k) => o?.[k], liveData) ?? null;
    if (value === null) continue;
    let fired = false;
    switch (alert.condition) {
      case "below": fired = value < alert.value; break;
      case "above": fired = value > alert.value; break;
      case "equals": fired = value === alert.value; break;
      case "changed": fired = true; break;
    }
    if (fired && alert.override_effort) {
      const levels = ["low", "medium", "high", "xhigh"];
      if (levels.indexOf(alert.override_effort) > levels.indexOf(effort)) {
        effort = alert.override_effort;
      }
    }
  }
  return effort;
}

// ── Worker Loader default export ───────────────────────────

export default {
  async fetch(request, env) {
    const K = env.KERNEL;
    const input = await request.json();
    const result = await wake(K, input);
    return Response.json(result);
  },
};

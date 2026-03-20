// Swayambhu — Session Policy (act)
// How a normal orient session works: context building, agent loop, output processing.
// Mutable — the agent can propose changes to this file via the proposal system.
//
// Receives K (kernel interface) for all kernel interactions.

import { executeReflect } from './reflect.js';

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

  const maxSteps = await K.getMaxSteps(state, 'orient');

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools,
    model: orientModel,
    effort: context.effort || config.orient?.effort || defaults?.orient?.effort,
    maxTokens: config.orient?.max_output_tokens || defaults?.orient?.max_output_tokens,
    maxSteps,
    step: 'orient',
    budgetCap: orientBudgetCap,
  });

  // Apply KV operations (gated by kernel protection)
  if (output.kv_operations?.length) {
    for (const op of output.kv_operations) {
      await K.applyKVOperation(op);
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

// ── Orient context builder ──────────────────────────────────

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

// ── Session results ─────────────────────────────────────────

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

// ── Karma summarization ─────────────────────────────────────

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

// ── Crash detection (K-based, for backward compatibility with tests) ──

export async function detectCrash(K) {
  const stale = await K.kvGet("kernel:active_session");
  if (!stale) return null;

  const currentId = await K.getSessionId();
  if (stale === currentId) return null;

  const deadKarma = await K.kvGet(`karma:${stale}`);
  return {
    dead_session_id: stale,
    karma: deadKarma,
    last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
  };
}

// ── Helpers ─────────────────────────────────────────────────

export async function getBalances(K, state) {
  return K.checkBalance({});
}

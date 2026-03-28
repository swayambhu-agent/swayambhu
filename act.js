// Swayambhu — Session Policy (act)
// How a normal act session works: context building, agent loop, output processing.
// Mutable — the agent can propose changes to this file via the proposal system.
//
// Receives K (kernel interface) for all kernel interactions.

import { executeReflect } from './reflect.js';

// ── Normal session ──────────────────────────────────────────

export async function runAct(K, state, context, config) {
  const { defaults, modelsConfig } = state;

  const actPrompt = await K.kvGet("prompt:act");
  const resources = await K.kvGet("config:resources");
  const subagents = await K.kvGet("config:subagents");

  // Build skill manifest for act prompt injection
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

  const systemPrompt = await K.buildPrompt(actPrompt, {
    models: modelsConfig,
    resources,
    config,
    skill_manifest: skill_manifest.length ? skill_manifest : null,
    subagents: subagents || null,
  });

  const initialContext = buildActContext(context);

  // Use act_after_dm config when a direct message is present
  const dmConfig = context.directMessage ? defaults?.act_after_dm : null;

  const actModel = await K.resolveModel(
    dmConfig?.model || config.act?.model || defaults?.act?.model
  );

  const tools = await K.buildToolDefinitions([], { context: "act" });

  // Reserve budget for reflect if configured
  const budget = defaults?.session_budget;
  const reservePct = budget?.reflect_reserve_pct || 0;
  const actBudgetCap = (budget?.max_cost && reservePct > 0)
    ? budget.max_cost * (1 - reservePct)
    : undefined;

  const maxSteps = await K.getMaxSteps(state, 'act');

  const output = await K.runAgentLoop({
    systemPrompt,
    initialContext,
    tools,
    model: actModel,
    effort: dmConfig?.effort || context.effort || config.act?.effort || defaults?.act?.effort,
    maxTokens: dmConfig?.max_output_tokens || config.act?.max_output_tokens || defaults?.act?.max_output_tokens,
    maxSteps,
    step: 'act',
    budgetCap: actBudgetCap,
  });

  // Apply KV operations (gated by kernel — context determines permissions)
  if (output.kv_operations?.length) {
    const blocked = [];
    for (const op of output.kv_operations) {
      const result = await K.kvWriteGated(op, "act");
      if (!result.ok) blocked.push({ key: op.key, error: result.error });
    }
    if (blocked.length) {
      await K.karmaRecord({ event: "kv_writes_blocked", blocked });
    }
  }

  // Session reflect — skip if budget fully exhausted (but not if
  // act was soft-capped by reflect_reserve_pct)
  const skipReflect = output.budget_exceeded && !reservePct;
  if (!skipReflect) {
    await executeReflect(K, state, { model: defaults?.reflect?.model });
  }

  await writeSessionResults(K, config, { reflectRan: !skipReflect });
}

// ── Act context builder ──────────────────────────────────

export function buildActContext(context) {
  // Static/stable fields first for prompt caching (prefix match),
  // volatile fields last so cache hits on the stable prefix.
  // current_time is always different — must be last.
  return JSON.stringify({
    // Patron direct message — first so the agent reads it immediately
    ...(context.directMessage ? { direct_message: context.directMessage } : {}),
    // Events — all events since last session (chat messages, job completions, etc.)
    ...(context.events?.length ? { events: context.events } : {}),
    ...(context.patronPlatforms ? { patron_platforms: context.patronPlatforms } : {}),
    additional_context: context.additionalContext,
    last_reflect: context.lastReflect,
    ...(context.reflectSchedule ? { reflect_schedule: context.reflectSchedule } : {}),
    effort: context.effort,
    crash_data: context.crashData,
    balances: context.balances,
    current_time: new Date().toISOString(),
  });
}

// ── Session results ─────────────────────────────────────────

export async function writeSessionResults(K, config, { reflectRan = true } = {}) {
  // If reflect was skipped, reset session_schedule to system defaults.
  // When reflect runs, it writes session_schedule itself — no override needed here.
  if (!reflectRan) {
    const defaults = await K.getDefaults();
    const intervalSeconds = defaults?.schedule?.interval_seconds || 21600;
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    });
  }
  // Note: session_counter, cache:session_ids, and karma_summary are now
  // written by kernel.js runScheduled() — runs for both act and deep reflect.
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

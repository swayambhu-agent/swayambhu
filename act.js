// Swayambhu — Act Library
// Prompt rendering, tool set building, context formatting.
// Called by session.js — no longer a standalone hook entry point.

// ── Prompt rendering ─────────────────────────────────────────

export function deriveDebugMode(defaults, { wake } = {}) {
  const debugConfig = defaults?.debug_mode || {};
  const wakeDebug = wake?.context?.debug_mode === true;
  const active = debugConfig.enabled === true || wakeDebug;
  if (!active) return null;

  return {
    active: true,
    label: wake?.actor || debugConfig.label || "external_debugger",
    schedule_may_be_overridden: debugConfig.schedule_may_be_overridden === true || wakeDebug,
    external_wakes_expected: debugConfig.external_wakes_expected === true || wakeDebug,
  };
}

export function buildDebugModeNote(debugMode) {
  if (!debugMode?.active) return "";

  const lines = [
    "## Debug Mode",
    `This session is running under external debug/probe conditions (${debugMode.label}).`,
  ];
  if (debugMode.external_wakes_expected) {
    lines.push("External observation wakes may occur even when no new real-world demand has appeared.");
  }
  if (debugMode.schedule_may_be_overridden) {
    lines.push("Your own interval and next-session preferences may be overridden by the harness. Do not infer scheduler bugs or urgency from this wake alone.");
  }
  lines.push("Treat this as an observation/diagnostic context. Preserve the distinction between live service demand and externally induced probe activity.", "");
  return lines.join("\n");
}

export async function renderActPrompt(K, { defaults, modelsConfig, debugMode } = {}) {
  const actPrompt = await K.kvGet("prompt:act");
  if (!actPrompt) return "You are a helpful agent. Execute the planned action using available tools.";

  const resources = await K.kvGet("config:resources");
  const subagents = await K.kvGet("config:subagents");

  const skillList = await K.kvList({ prefix: "skill:", limit: 100 });
  const skill_manifest = [];
  for (const k of skillList.keys) {
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

  return K.buildPrompt(actPrompt, {
    models: modelsConfig,
    resources,
    config: defaults,
    debug_mode_note: buildDebugModeNote(debugMode),
    skill_manifest: skill_manifest.length ? skill_manifest : null,
    subagents: subagents || null,
  });
}

export async function buildToolSet(K) {
  return K.buildToolDefinitions();
}

// ── Context formatters ───────────────────────────────────────

export function formatDesires(d) {
  return JSON.stringify(
    Object.entries(d).map(([key, val]) => ({
      key,
      slug: val.slug,
      direction: val.direction,
      description: val.description,
    })),
    null, 2
  );
}

export function formatPatterns(s) {
  if (!s || Object.keys(s).length === 0) return "(no patterns)";
  const arr = Object.entries(s).map(([key, val]) => ({
    key,
    pattern: val.pattern,
    strength: val.strength,
  }));
  return JSON.stringify(arr, null, 2);
}

export function formatCircumstances(c) {
  return JSON.stringify(c, null, 2);
}

// ── Act context builder ──────────────────────────────────────

export function buildActContext(context) {
  // Static/stable fields first for prompt caching (prefix match),
  // volatile fields last so cache hits on the stable prefix.
  // current_time is always different — must be last.
  return JSON.stringify({
    // Patron direct message — first so the agent reads it immediately
    ...(context.directMessage ? { direct_message: context.directMessage } : {}),
    // Pending requests from contacts (source of truth — from KV, crash-proof)
    ...(context.pendingRequests?.length ? { pending_requests: context.pendingRequests } : {}),
    // Events — signals since last session (job completions, patron directives, etc.)
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

// ── Session results ─────────────────────────────────────────────

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
  // Note: session_counter and cache:session_ids are managed by userspace actCycle.
}

// ── Karma summarization ─────────────────────────────────────────

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
  const stale = await K.kvGet("kernel:active_execution");
  if (!stale) return null;

  const currentId = await K.getExecutionId();
  if (stale === currentId) return null;

  const deadKarma = await K.kvGet(`karma:${stale}`);
  return {
    dead_session_id: stale,
    karma: deadKarma,
    last_entry: Array.isArray(deadKarma) ? deadKarma[deadKarma.length - 1] : null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

export async function getBalances(K, state) {
  return K.checkBalance({});
}

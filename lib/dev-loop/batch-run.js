import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";

export function readNumericArg(argv, flag, defaultValue) {
  const index = argv.indexOf(flag);
  if (index === -1) return defaultValue;
  const raw = argv[index + 1];
  if (raw == null) throw new Error(`${flag} requires a number`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

export function readStringArg(argv, flag, defaultValue) {
  const index = argv.indexOf(flag);
  if (index === -1) return defaultValue;
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const cycles = readNumericArg(argv, "--cycles", 20);
  const label = readStringArg(argv, "--label", `batch-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const baseDir = readStringArg(argv, "--base-dir", join("/home/swami/swayambhu/dev-loop", label));
  const cleanCompute = !argv.includes("--keep-compute");
  const noColdStart = argv.includes("--no-cold-start");
  const identityEnabled = argv.includes("--identity-enabled")
    || /^(true|1|yes|on)$/i.test(String(process.env.SWAYAMBHU_IDENTITY_ENABLED || ""));
  const emailProgress = argv.includes("--email-progress")
    || /^(true|1|yes|on)$/i.test(String(process.env.SWAYAMBHU_DEV_LOOP_EMAIL_PROGRESS || ""));
  const emailEvery = readNumericArg(argv, "--email-every", 5);

  return {
    cycles,
    label,
    baseDir,
    cleanCompute,
    noColdStart,
    identityEnabled,
    emailProgress,
    emailEvery,
  };
}

export async function cleanLocalComputeSurfaces() {
  const targets = [
    "/home/swayambhu/workspace",
    "/home/swayambhu/reasoning",
    "/home/swayambhu/jobs",
  ];
  const warnings = [];
  for (const dir of targets) {
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      try {
        await rm(join(dir, entry), { recursive: true, force: true });
      } catch (error) {
        warnings.push(`${join(dir, entry)}: ${error.message}`);
      }
    }
  }
  return warnings;
}

export async function maybeSendProgressEmail(enabled, subject, lines) {
  if (!enabled) return;
  try {
    const { sendEmail } = await import("../../scripts/dev-loop/comms.mjs");
    await sendEmail(lines.join("\n"), subject);
  } catch (error) {
    console.log(`[BATCH] Email warning: ${error.message}`);
  }
}

export function summarizeClassification(classification) {
  const payload = classification?.classification || classification || {};
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const metaPolicyNoteRefs = Array.isArray(payload.meta_policy_note_refs)
    ? payload.meta_policy_note_refs.map((ref) => String(ref))
    : [];
  const counts = {
    total: issues.length,
    tactic_smuggling: 0,
    carry_forward_smuggling: 0,
    observation_contamination: 0,
    outbound_internal_state_leakage: 0,
    meta_policy_notes_total: Number(payload.meta_policy_notes_total || 0),
    meta_policy_note_refs: metaPolicyNoteRefs,
  };
  for (const issue of issues) {
    const summary = String(issue.summary || "");
    if (summary.includes("tactic layer") || summary.includes("reflection/review instead of act-time")) {
      counts.tactic_smuggling += 1;
    }
    if (summary.includes("Carry-forward item")) {
      counts.carry_forward_smuggling += 1;
    }
    if (summary.includes("observation appears to contain narrative or internal reasoning")) {
      counts.observation_contamination += 1;
    }
    if (summary.includes("leak internal runtime/cognitive vocabulary")) {
      counts.outbound_internal_state_leakage += 1;
    }
  }
  return counts;
}

export function summarizeProactivity(analysis, latestSessionId) {
  const actions = Object.entries(analysis?.actions || {}).map(([key, value]) => ({ key, ...(value || {}) }));
  const experiences = Object.entries(analysis?.experiences || {}).map(([key, value]) => ({ key, ...(value || {}) }));
  const identifications = analysis?.identifications || {};

  const sessionActions = actions.filter((action) =>
    action.execution_id === latestSessionId || action.session_id === latestSessionId);
  const sessionExperiences = experiences.filter((experience) =>
    experience.session_id === latestSessionId || experience.execution_id === latestSessionId);
  const meaningfulActions = sessionActions.filter((action) => action.kind !== "no_action");
  const toolCalls = sessionActions.flatMap((action) => Array.isArray(action.tool_calls) ? action.tool_calls : []);
  const uniqueTools = [...new Set(toolCalls
    .map((call) => String(call?.tool || call?.name || "").trim())
    .filter(Boolean))].sort();
  const exercisedIdentifications = [...new Set(sessionActions.flatMap((action) =>
    Array.isArray(action.exercised_identifications) ? action.exercised_identifications : []))].sort();
  const identificationKeys = Object.keys(identifications);
  const nonSeedIdentificationKeys = identificationKeys.filter((key) => key !== "identification:working-body");
  const requestMessageCount = sessionActions.filter((action) =>
    action.plan?.action === "request_message"
    || (Array.isArray(action.tool_calls) && action.tool_calls.some((call) => call?.tool === "request_message"))).length;

  const searchablePayload = JSON.stringify({
    actions: sessionActions,
    experiences: sessionExperiences,
    last_reflect: analysis?.last_reflect || null,
  }).toLowerCase();
  const fanoMatches = searchablePayload.match(/\/home\/swami\/fano|\bfano\b/g) || [];

  return {
    session_has_meaningful_action: meaningfulActions.length > 0,
    session_meaningful_action_count: meaningfulActions.length,
    session_no_action_only: sessionActions.length > 0 && meaningfulActions.length === 0,
    session_tool_call_count: toolCalls.length,
    session_unique_tools: uniqueTools,
    request_message_count: requestMessageCount,
    exercised_identifications: exercisedIdentifications,
    total_identification_count: identificationKeys.length,
    non_seed_identification_count: nonSeedIdentificationKeys.length,
    touched_fano: fanoMatches.length > 0,
    fano_match_count: fanoMatches.length,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  const [{ initState, saveRun }, { ensureServices }, { runObserve }, { runClassify }, { cleanRemoteComputeSurfaces }] = await Promise.all([
    import("../../scripts/dev-loop/state.mjs"),
    import("../../scripts/dev-loop/services.mjs"),
    import("../../scripts/dev-loop/observe.mjs"),
    import("../../scripts/dev-loop/classify.mjs"),
    import("../../scripts/dev-loop/remote-compute.mjs"),
  ]);

  if (config.identityEnabled) {
    process.env.SWAYAMBHU_IDENTITY_ENABLED = "true";
  } else if (!process.env.SWAYAMBHU_IDENTITY_ENABLED) {
    delete process.env.SWAYAMBHU_IDENTITY_ENABLED;
  }

  await initState(config.baseDir);
  let remoteCleanup = {
    attempted: false,
    status: "skipped",
    lines: [],
    error: null,
  };
  if (config.cleanCompute) {
    console.log("[BATCH] Cleaning compute-side surfaces");
    remoteCleanup.attempted = true;
    try {
      const remoteResult = await cleanRemoteComputeSurfaces();
      remoteCleanup.status = "ok";
      remoteCleanup.lines = remoteResult.lines;
      for (const line of remoteResult.lines) {
        console.log(`[BATCH] Remote cleanup: ${line}`);
      }
    } catch (error) {
      remoteCleanup.status = "warning";
      remoteCleanup.error = error.message;
      console.log(`[BATCH] Remote cleanup warning: ${error.message}`);
    }

    console.log("[BATCH] Cleaning local compute surfaces");
    const warnings = await cleanLocalComputeSurfaces();
    for (const warning of warnings) {
      console.log(`[BATCH] Cleanup warning: ${warning}`);
    }
  }

  console.log(`[BATCH] Ensuring services for ${config.label}`);
  await ensureServices();
  await maybeSendProgressEmail(
    config.emailProgress,
    `[SWAYAMBHU-DEV] Batch started: ${config.label}`,
    [
      `Label: ${config.label}`,
      `Cycles: ${config.cycles}`,
      `Base dir: ${config.baseDir}`,
      `Identity enabled: ${config.identityEnabled}`,
      `Clean compute: ${config.cleanCompute}`,
      `Started at: ${new Date().toISOString()}`,
    ],
  );

  const cycleSummaries = [];
  const startedAt = new Date().toISOString();

  for (let cycle = 0; cycle < config.cycles; cycle += 1) {
    const timestamp = `${Date.now()}-${cycle + 1}`;
    const observeCycle = config.noColdStart ? cycle + 1 : cycle;
    console.log(`\n[BATCH] Cycle ${cycle + 1}/${config.cycles}`);

    const observationResult = await runObserve({
      baseDir: config.baseDir,
      cycle: observeCycle,
      probes: [],
      codeChanged: cycle === 0 && !config.noColdStart,
      coldStart: cycle === 0 && !config.noColdStart,
      timestamp,
    });

    if (!observationResult?.success) {
      throw new Error(`observe failed on cycle ${cycle + 1}: ${observationResult?.error || "unknown error"}`);
    }

    const classification = await runClassify({
      baseDir: config.baseDir,
      observation: observationResult.observation,
      timestamp,
    });

    const counts = summarizeClassification(classification);
    const proactivity = summarizeProactivity(
      observationResult.observation.analysis,
      observationResult.observation.latest_session_id,
    );
    cycleSummaries.push({
      cycle: cycle + 1,
      timestamp,
      latest_session_id: observationResult.observation.latest_session_id,
      strategy: observationResult.observation.strategy,
      issue_counts: counts,
      proactivity,
    });

    if (config.emailProgress && ((cycle + 1) % config.emailEvery === 0 || cycle + 1 === config.cycles)) {
      const progressTotals = cycleSummaries.reduce((acc, entry) => ({
        total_issues: acc.total_issues + entry.issue_counts.total,
        tactic_smuggling: acc.tactic_smuggling + entry.issue_counts.tactic_smuggling,
        carry_forward_smuggling: acc.carry_forward_smuggling + entry.issue_counts.carry_forward_smuggling,
        observation_contamination: acc.observation_contamination + entry.issue_counts.observation_contamination,
        outbound_internal_state_leakage: acc.outbound_internal_state_leakage + entry.issue_counts.outbound_internal_state_leakage,
        meta_policy_notes_total: acc.meta_policy_notes_total + (entry.issue_counts.meta_policy_notes_total || 0),
      }), {
        total_issues: 0,
        tactic_smuggling: 0,
        carry_forward_smuggling: 0,
        observation_contamination: 0,
        outbound_internal_state_leakage: 0,
        meta_policy_notes_total: 0,
      });
      await maybeSendProgressEmail(
        config.emailProgress,
        `[SWAYAMBHU-DEV] Batch progress: ${config.label} (${cycle + 1}/${config.cycles})`,
        [
          `Label: ${config.label}`,
          `Progress: ${cycle + 1}/${config.cycles}`,
          `Latest session: ${observationResult.observation.latest_session_id}`,
          `Strategy: ${observationResult.observation.strategy}`,
          `Totals so far: ${JSON.stringify(progressTotals)}`,
          `Base dir: ${config.baseDir}`,
        ],
      );
    }
  }

  const totals = cycleSummaries.reduce((acc, cycle) => ({
    total_issues: acc.total_issues + cycle.issue_counts.total,
    tactic_smuggling: acc.tactic_smuggling + cycle.issue_counts.tactic_smuggling,
    carry_forward_smuggling: acc.carry_forward_smuggling + cycle.issue_counts.carry_forward_smuggling,
    observation_contamination: acc.observation_contamination + cycle.issue_counts.observation_contamination,
    outbound_internal_state_leakage: acc.outbound_internal_state_leakage + cycle.issue_counts.outbound_internal_state_leakage,
    meta_policy_notes_total: acc.meta_policy_notes_total + cycle.issue_counts.meta_policy_notes_total,
    meta_policy_notes_unique_total: 0,
    meaningful_action_sessions: acc.meaningful_action_sessions + (cycle.proactivity.session_has_meaningful_action ? 1 : 0),
    no_action_only_sessions: acc.no_action_only_sessions + (cycle.proactivity.session_no_action_only ? 1 : 0),
    tool_calls_total: acc.tool_calls_total + cycle.proactivity.session_tool_call_count,
    request_message_total: acc.request_message_total + cycle.proactivity.request_message_count,
    exercised_identification_sessions: acc.exercised_identification_sessions + (cycle.proactivity.exercised_identifications.length > 0 ? 1 : 0),
    fano_sessions: acc.fano_sessions + (cycle.proactivity.touched_fano ? 1 : 0),
    max_identification_count: Math.max(acc.max_identification_count, cycle.proactivity.total_identification_count),
    max_non_seed_identification_count: Math.max(acc.max_non_seed_identification_count, cycle.proactivity.non_seed_identification_count),
  }), {
    total_issues: 0,
    tactic_smuggling: 0,
    carry_forward_smuggling: 0,
    observation_contamination: 0,
    outbound_internal_state_leakage: 0,
    meta_policy_notes_total: 0,
    meta_policy_notes_unique_total: 0,
    meaningful_action_sessions: 0,
    no_action_only_sessions: 0,
    tool_calls_total: 0,
    request_message_total: 0,
    exercised_identification_sessions: 0,
    fano_sessions: 0,
    max_identification_count: 0,
    max_non_seed_identification_count: 0,
  });

  const uniqueMetaPolicyNotes = [...new Set(
    cycleSummaries.flatMap((cycle) => cycle.issue_counts.meta_policy_note_refs || []),
  )];
  totals.meta_policy_notes_unique_total = uniqueMetaPolicyNotes.length;

  const summary = {
    label: config.label,
    base_dir: config.baseDir,
    cycles: config.cycles,
    identity_enabled: config.identityEnabled,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cleaned_local_compute: config.cleanCompute,
    remote_cleanup: remoteCleanup,
    totals,
    meta_policy_note_refs: uniqueMetaPolicyNotes,
    per_cycle: cycleSummaries,
  };

  await writeFile(join(config.baseDir, "batch-summary.json"), JSON.stringify(summary, null, 2));
  await saveRun(config.baseDir, `summary-${Date.now()}`, "batch-summary.json", summary);
  await maybeSendProgressEmail(
    config.emailProgress,
    `[SWAYAMBHU-DEV] Batch complete: ${config.label}`,
    [
      `Label: ${config.label}`,
      `Cycles: ${config.cycles}`,
      `Identity enabled: ${config.identityEnabled}`,
      `Summary: ${join(config.baseDir, "batch-summary.json")}`,
      `Totals: ${JSON.stringify(summary.totals)}`,
      `Completed at: ${summary.completed_at}`,
    ],
  );
  console.log(`\n[BATCH] Complete: ${config.baseDir}/batch-summary.json`);
}

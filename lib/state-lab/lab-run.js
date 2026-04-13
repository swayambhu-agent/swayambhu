import { execFileSync } from "child_process";
import { writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

import {
  compareContinuationSummaries,
  getContinuationConfig,
  isInfrastructureContinuationFailure,
  reconcileComparativeStaticValidation,
} from "./validation.js";
import { buildLabBranchName } from "./workspace.js";

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireFunction(name, value) {
  if (typeof value !== "function") throw new Error(`Missing state-lab dependency: ${name}`);
  return value;
}

async function writeLabJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

export async function writeLabState(paths, state) {
  await writeLabJson(paths.labStatePath, state);
}

export async function writeLabReport(paths, report) {
  await writeLabJson(paths.labReportPath, report);
}

export async function writeLabResult(paths, result) {
  await writeLabJson(paths.labResultPath, result);
}

export async function runContinuationValidation(entry, validation = {}, limits = {}, candidateChanges = [], deps = {}) {
  const continuation = getContinuationConfig(validation);
  if (!continuation.enabled) {
    return {
      enabled: false,
      passed: null,
      base_dir: null,
      summary: null,
      stdout_tail: "",
      stderr_tail: "",
      error: null,
    };
  }

  const buildStartEnv = requireFunction("buildStartEnv", deps.buildStartEnv);
  const pathExists = requireFunction("pathExists", deps.pathExists);
  const readJson = requireFunction("readJson", deps.readJson);
  const syncWorkspaceCodeTargetsToBranchKv = requireFunction(
    "syncWorkspaceCodeTargetsToBranchKv",
    deps.syncWorkspaceCodeTargetsToBranchKv,
  );

  const syncedCodeTargets = await syncWorkspaceCodeTargetsToBranchKv(entry, candidateChanges);
  const baseDir = join(entry.paths.base, "dev-loop");
  const env = {
    ...process.env,
    ...buildStartEnv(entry.metadata),
    SWAYAMBHU_DEV_LOOP_SERVICE_MODE: "default",
  };
  const timeoutMs = Math.max(180_000, (limits.max_wall_time_minutes || 30) * 60_000);
  const command = `node scripts/dev-loop/batch-run.mjs --cycles ${continuation.maxSessions} --base-dir '${baseDir}' --label '${entry.name}-continuation'`;

  try {
    const stdout = execFileSync("bash", ["-lc", command], {
      cwd: entry.paths.workspaceDir,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      enabled: true,
      passed: true,
      base_dir: baseDir,
      summary: await readJson(join(baseDir, "batch-summary.json")),
      synced_code_targets: syncedCodeTargets,
      stdout_tail: String(stdout || "").slice(-4000),
      stderr_tail: "",
      error: null,
    };
  } catch (error) {
    let summary = null;
    if (await pathExists(join(baseDir, "batch-summary.json"))) {
      summary = await readJson(join(baseDir, "batch-summary.json"));
    }
    return {
      enabled: true,
      passed: false,
      base_dir: baseDir,
      summary,
      synced_code_targets: syncedCodeTargets,
      stdout_tail: String(error.stdout || "").slice(-4000),
      stderr_tail: String(error.stderr || "").slice(-4000),
      error: error.message,
    };
  }
}

export async function runLabRun(args, deps = {}) {
  const loadLabHypothesis = requireFunction("loadLabHypothesis", deps.loadLabHypothesis);
  const sanitizeName = requireFunction("sanitizeName", deps.sanitizeName);
  const createBranchFromSource = requireFunction("createBranchFromSource", deps.createBranchFromSource);
  const prepareWorkspace = requireFunction("prepareWorkspace", deps.prepareWorkspace);
  const applyCandidateChanges = requireFunction("applyCandidateChanges", deps.applyCandidateChanges);
  const runStaticValidation = requireFunction("runStaticValidation", deps.runStaticValidation);
  const buildValidatedChanges = requireFunction("buildValidatedChanges", deps.buildValidatedChanges);

  const sourceRef = args[0];
  const hypothesisPath = args[1];
  if (!sourceRef || !hypothesisPath) {
    throw new Error("lab-run requires <source-ref> <hypothesis-path>");
  }

  const { payload, resolvedPath } = await loadLabHypothesis(hypothesisPath);
  const branchStem = buildLabBranchName(resolvedPath);
  const baselineName = sanitizeName(`${branchStem}-baseline`);
  const candidateName = sanitizeName(`${branchStem}-candidate`);
  const { source, entry: baselineEntry } = await createBranchFromSource(sourceRef, baselineName);
  const { entry } = await createBranchFromSource(sourceRef, candidateName);
  await prepareWorkspace(baselineEntry);
  await prepareWorkspace(entry);

  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + ((payload.limits.max_wall_time_minutes || 30) * 60_000)).toISOString();
  await writeLabState(entry.paths, {
    status: "preparing",
    branch: entry.name,
    source_ref: source.ref,
    hypothesis_path: resolvedPath,
    started_at: startedAt,
    updated_at: startedAt,
    deadline_at: deadlineAt,
    consecutive_failures: 0,
    failure_reason: null,
    baseline_branch: baselineEntry.name,
  });

  let appliedChanges = [];
  let baselineStaticValidation = { passed: false, commands: [] };
  let staticValidation = { passed: false, commands: [] };
  let baselineContinuation = { enabled: false, passed: null, summary: null };
  let candidateContinuation = { enabled: false, passed: null, summary: null };
  const staticValidationFailureResult = (label) => ({
    enabled: getContinuationConfig(payload.validation).enabled,
    passed: false,
    base_dir: null,
    summary: null,
    synced_code_targets: [],
    stdout_tail: "",
    stderr_tail: "",
    error: `${label}_static_validation_failed`,
  });

  try {
    appliedChanges = await applyCandidateChanges(entry, payload.candidate_changes);
    await writeLabState(entry.paths, {
      status: "validating_static",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 0,
      failure_reason: null,
      baseline_branch: baselineEntry.name,
    });

    baselineStaticValidation = await runStaticValidation(baselineEntry, payload.validation, payload.limits, "baseline");
    staticValidation = await runStaticValidation(entry, payload.validation, payload.limits, "candidate");
    const reconciledStaticValidation = reconcileComparativeStaticValidation(
      baselineStaticValidation,
      staticValidation,
      payload.validation,
    );
    baselineStaticValidation = reconciledStaticValidation.baseline;
    staticValidation = reconciledStaticValidation.candidate;

    await writeLabState(entry.paths, {
      status: "running_continuations",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 0,
      failure_reason: null,
      baseline_branch: baselineEntry.name,
    });

    baselineContinuation = baselineStaticValidation.passed
      ? await runContinuationValidation(baselineEntry, payload.validation, payload.limits, [], deps)
      : staticValidationFailureResult("baseline");
    candidateContinuation = staticValidation.passed
      ? await runContinuationValidation(entry, payload.validation, payload.limits, payload.candidate_changes, deps)
      : staticValidationFailureResult("candidate");

    const continuationComparison = compareContinuationSummaries(
      baselineContinuation.summary,
      candidateContinuation.summary,
    );
    const continuationEnabled = getContinuationConfig(payload.validation).enabled;
    const continuationPassed = !continuationEnabled
      || (baselineContinuation.passed === true && candidateContinuation.passed === true);
    const validatedChanges = (baselineStaticValidation.passed && staticValidation.passed && continuationPassed)
      ? await buildValidatedChanges(entry, payload.candidate_changes)
      : null;
    const infrastructureContinuationFailure = continuationEnabled
      && (isInfrastructureContinuationFailure(baselineContinuation)
        || isInfrastructureContinuationFailure(candidateContinuation));
    const promotionRecommendation = validatedChanges
      ? "stageable"
      : (infrastructureContinuationFailure ? "inconclusive" : "reject");
    const hypothesisHash = sha256Json({
      hypothesis: payload.hypothesis,
      candidate_changes: payload.candidate_changes,
      validation: payload.validation,
      limits: payload.limits,
      review_note_key: payload.review_note_key || null,
    });
    const validatedChangesHash = validatedChanges ? sha256Json(validatedChanges) : null;

    const report = {
      branch: entry.name,
      baseline_branch: baselineEntry.name,
      source_ref: source.ref,
      workspace_dir: entry.paths.workspaceDir,
      state_dir: entry.metadata.state_dir,
      baseline_workspace_dir: baselineEntry.paths.workspaceDir,
      baseline_state_dir: baselineEntry.metadata.state_dir,
      hypothesis_path: resolvedPath,
      hypothesis: payload.hypothesis,
      candidate_changes_requested: payload.candidate_changes,
      candidate_changes_applied: appliedChanges,
      baseline_static_validation: baselineStaticValidation,
      static_validation: staticValidation,
      neutralized_shared_static_failures: reconciledStaticValidation.neutralized_shared_failures,
      baseline_continuation: baselineContinuation,
      candidate_continuation: candidateContinuation,
      continuation_comparison: continuationComparison,
      promotion_recommendation: promotionRecommendation,
      review_note_key: payload.review_note_key || null,
      hypothesis_hash: hypothesisHash,
      validated_changes_hash: validatedChangesHash,
      validated_changes: validatedChanges,
      generated_at: new Date().toISOString(),
    };
    await writeLabReport(entry.paths, report);

    const result = {
      branch: entry.name,
      baseline_branch: baselineEntry.name,
      source_ref: source.ref,
      hypothesis: payload.hypothesis,
      review_note_key: payload.review_note_key || null,
      promotion_recommendation: promotionRecommendation,
      comparison_summary: continuationComparison,
      hypothesis_hash: hypothesisHash,
      validated_changes_hash: validatedChangesHash,
      validated_changes: validatedChanges,
      reasons_not_to_change: promotionRecommendation === "stageable"
        ? []
        : [
            ...(baselineStaticValidation.passed ? [] : ["Baseline static validation failed."]),
            ...(staticValidation.passed ? [] : ["Candidate static validation failed."]),
            ...(continuationEnabled && baselineContinuation.passed !== true
              ? [isInfrastructureContinuationFailure(baselineContinuation)
                ? "Baseline continuation infrastructure failed."
                : "Baseline continuation failed."]
              : []),
            ...(continuationEnabled && candidateContinuation.passed !== true
              ? [isInfrastructureContinuationFailure(candidateContinuation)
                ? "Candidate continuation infrastructure failed."
                : "Candidate continuation failed."]
              : []),
          ],
      generated_at: new Date().toISOString(),
    };
    await writeLabResult(entry.paths, result);
    await writeLabState(entry.paths, {
      status: promotionRecommendation === "stageable"
        ? "stageable"
        : (promotionRecommendation === "inconclusive" ? "inconclusive" : "rejected"),
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 0,
      failure_reason: promotionRecommendation === "stageable" ? null : "validation_failed",
      baseline_branch: baselineEntry.name,
    });

    console.log(`Lab run complete for ${entry.name}`);
    console.log(`  baseline: branch:${baselineEntry.name}`);
    console.log(`  branch: branch:${entry.name}`);
    console.log(`  workspace: ${entry.paths.workspaceDir}`);
    console.log(`  report: ${entry.paths.labReportPath}`);
    console.log(`  result: ${entry.paths.labResultPath}`);
    console.log(`  verdict: ${result.promotion_recommendation}`);
  } catch (error) {
    await writeLabState(entry.paths, {
      status: "failed",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 1,
      failure_reason: error.message,
      baseline_branch: baselineEntry.name,
    });
    throw error;
  }
}

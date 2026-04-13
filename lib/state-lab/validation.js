import { resolve } from "path";

import { root as REPO_ROOT } from "../../scripts/shared.mjs";

function normalizeStaticCheckExpectation(value, fallback = "pass") {
  if (value === true) return "pass";
  if (value === false) return "fail";
  if (value === "pass" || value === "fail" || value === "skip") return value;
  return fallback;
}

export function normalizeStaticChecks(validation = {}) {
  const explicitChecks = Array.isArray(validation?.static_checks) ? validation.static_checks : [];
  const commands = Array.isArray(validation.static_commands) ? validation.static_commands : [];
  const normalizedCommands = commands
    .filter((command) => typeof command === "string" && command.trim())
    .map((command) => ({
      command,
      label: null,
      source: "static_command",
      expect: {
        baseline: "pass",
        candidate: "pass",
      },
    }));

  const normalizedChecks = explicitChecks
    .filter((check) => check && typeof check.command === "string" && check.command.trim())
    .map((check) => ({
      command: check.command,
      label: typeof check.label === "string" && check.label.trim() ? check.label.trim() : null,
      source: "static_check",
      expect: {
        baseline: normalizeStaticCheckExpectation(check?.expect?.baseline, "pass"),
        candidate: normalizeStaticCheckExpectation(check?.expect?.candidate, "pass"),
      },
    }));

  return [...normalizedCommands, ...normalizedChecks];
}

export function hasComparativeStaticChecks(validation = {}) {
  return normalizeStaticChecks(validation).some((check) => (
    check.expect?.baseline !== "pass" || check.expect?.candidate !== "pass"
  ));
}

export function retargetStaticCommandToWorkspace(command, workspaceDir) {
  if (typeof command !== "string" || !command.trim()) return command;
  const repoRoot = resolve(REPO_ROOT);
  const workspaceRoot = resolve(workspaceDir);
  return command.split(repoRoot).join(workspaceRoot);
}

function sameStaticFailureSignature(baselineCommand = {}, candidateCommand = {}) {
  return baselineCommand.source === "static_command"
    && candidateCommand.source === "static_command"
    && baselineCommand.command === candidateCommand.command
    && String(baselineCommand.label || "") === String(candidateCommand.label || "")
    && baselineCommand.expected_outcome === "pass"
    && candidateCommand.expected_outcome === "pass"
    && baselineCommand.actual_outcome === "fail"
    && candidateCommand.actual_outcome === "fail"
    && (baselineCommand.exit_code ?? null) === (candidateCommand.exit_code ?? null)
    && String(baselineCommand.failure_signature_hash || "") === String(candidateCommand.failure_signature_hash || "");
}

function buildStaticCommandKeys(commands = []) {
  const seen = new Map();
  return commands.map((command = {}) => {
    const base = [
      command.source || "",
      command.command || "",
      command.label || "",
    ].join("\u0000");
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return `${base}\u0000${occurrence}`;
  });
}

export function reconcileComparativeStaticValidation(
  baselineValidation = { passed: false, commands: [] },
  candidateValidation = { passed: false, commands: [] },
  validation = {},
) {
  if (!hasComparativeStaticChecks(validation)) {
    return {
      baseline: baselineValidation,
      candidate: candidateValidation,
      neutralized_shared_failures: 0,
    };
  }

  const baselineCommands = Array.isArray(baselineValidation?.commands)
    ? baselineValidation.commands.map((command) => ({ ...command }))
    : [];
  const candidateCommands = Array.isArray(candidateValidation?.commands)
    ? candidateValidation.commands.map((command) => ({ ...command }))
    : [];
  let neutralizedSharedFailures = 0;
  const baselineKeys = buildStaticCommandKeys(baselineCommands);
  const candidateKeys = buildStaticCommandKeys(candidateCommands);
  const candidateIndexByKey = new Map(candidateKeys.map((key, index) => [key, index]));

  for (let index = 0; index < baselineCommands.length; index += 1) {
    const candidateIndex = candidateIndexByKey.get(baselineKeys[index]);
    if (candidateIndex == null) continue;
    const baselineCommand = baselineCommands[index];
    const candidateCommand = candidateCommands[candidateIndex];
    if (!sameStaticFailureSignature(baselineCommand, candidateCommand)) continue;

    neutralizedSharedFailures += 1;
    baselineCommands[index] = {
      ...baselineCommand,
      ok: true,
      matched: true,
      neutralized_shared_baseline_failure: true,
    };
    candidateCommands[candidateIndex] = {
      ...candidateCommand,
      ok: true,
      matched: true,
      neutralized_shared_baseline_failure: true,
    };
  }

  const validationPassed = (commands) => commands.every((command) => (
    command?.skipped === true || command?.matched === true
  ));

  return {
    baseline: {
      ...baselineValidation,
      passed: validationPassed(baselineCommands),
      commands: baselineCommands,
    },
    candidate: {
      ...candidateValidation,
      passed: validationPassed(candidateCommands),
      commands: candidateCommands,
    },
    neutralized_shared_failures: neutralizedSharedFailures,
  };
}

export function getContinuationConfig(validation = {}) {
  const continuation = validation?.continuation || {};
  const maxSessions = Number(continuation.max_sessions);
  return {
    enabled: continuation.enabled === true,
    maxSessions: Number.isFinite(maxSessions) ? Math.max(1, maxSessions) : 1,
    maxCashCost: Number.isFinite(Number(continuation.max_cash_cost))
      ? Number(continuation.max_cash_cost)
      : null,
  };
}

export function isInfrastructureContinuationFailure(result = {}) {
  const text = [result?.error, result?.stderr_tail, result?.stdout_tail]
    .filter(Boolean)
    .join("\n");
  return /services failed to start|did not start within|service-start-.*\.log|port .* occupied/i.test(text);
}

export function summarizeBatchSummary(summary) {
  if (!summary) return null;
  return {
    cycles: summary.cycles || 0,
    totals: summary.totals || {},
    remote_cleanup: summary.remote_cleanup || null,
    completed_at: summary.completed_at || null,
  };
}

export function compareContinuationSummaries(baselineSummary, candidateSummary) {
  const baseline = summarizeBatchSummary(baselineSummary);
  const candidate = summarizeBatchSummary(candidateSummary);
  if (!baseline || !candidate) {
    return { baseline, candidate, deltas: null };
  }

  const baselineTotals = baseline.totals || {};
  const candidateTotals = candidate.totals || {};
  const keys = new Set([...Object.keys(baselineTotals), ...Object.keys(candidateTotals)]);
  const deltas = {};
  for (const key of keys) {
    const baseValue = Number(baselineTotals[key] || 0);
    const candidateValue = Number(candidateTotals[key] || 0);
    deltas[key] = candidateValue - baseValue;
  }

  return { baseline, candidate, deltas };
}

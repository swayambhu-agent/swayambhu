// Verify stage — run tests after applying fixes, rollback on regression.
// No unit tests needed (wraps shell commands). Integration-tested only.

import { execSync } from "child_process";
import { join } from "path";
import { saveRun } from "./state.mjs";

const ROOT = join(import.meta.dirname, "../..");

// ── Shell wrappers ─────────────────────────────────────────

export function runTests() {
  try {
    const output = execSync("npm test", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true, output };
  } catch (err) {
    // Non-zero exit — tests failed
    const output = (err.stdout || "") + (err.stderr || "");
    return { passed: false, output };
  }
}

export function rollbackLastCommit() {
  try {
    execSync("git revert HEAD --no-edit", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Orchestrator ───────────────────────────────────────────

export async function runVerify({ baseDir, timestamp, appliedFixes }) {
  const testResult = runTests();

  if (!testResult.passed) {
    // Rollback each applied fix in reverse order
    const rollbacks = [];
    for (const fix of [...appliedFixes].reverse()) {
      const rb = rollbackLastCommit();
      rollbacks.push({ fix: fix.id || fix, ...rb });
    }

    await saveRun(baseDir, timestamp, "verification.json", {
      tests_passed: false,
      test_output: testResult.output,
      rollbacks,
    });

    return { success: false, results: { tests_passed: false, rollbacks } };
  }

  // Tests passed — mark all fixes as verified
  const verified = appliedFixes.map((fix) => ({
    fix: fix.id || fix,
    verified: true,
  }));

  await saveRun(baseDir, timestamp, "verification.json", {
    tests_passed: true,
    verified,
  });

  return { success: true, results: { tests_passed: true, verified } };
}

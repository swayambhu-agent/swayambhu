// Observe stage — trigger an agent session and collect results.
// Pure functions (detectCompletion, chooseStrategy) are unit-testable.
// runObserve orchestrates shell commands and is integration-tested only.

import { execSync } from "child_process";
import { join } from "path";
import { saveRun } from "./state.mjs";

const ROOT = join(import.meta.dirname, "../..");

// ── Pure functions ──────────────────────────────────────────

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged }) {
  if (cycle === 0 || codeChanged) {
    return {
      type: "cold_start",
      // Start services WITHOUT --trigger. We trigger separately via curl
      // so we can poll session_counter instead of blocking.
      setup: `bash ${join(ROOT, "scripts/start.sh")} --reset-all-state --yes`,
      trigger: "curl -s http://localhost:8787/__scheduled",
    };
  }
  return {
    type: "accumulate",
    setup: null,
    trigger: "curl -s http://localhost:8787/__scheduled",
  };
}

// ── Helpers ─────────────────────────────────────────────────

function readSessionCounter() {
  try {
    const out = execSync(
      `node ${join(ROOT, "scripts/read-kv.mjs")} --json session_counter`,
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const n = parseInt(out, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function pollUntilIncrement(beforeCount, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  const interval = 5_000;
  while (Date.now() < deadline) {
    const current = readSessionCounter();
    if (detectCompletion(beforeCount, current)) return current;
    execSync(`sleep ${interval / 1000}`);
  }
  throw new Error(
    `Session did not complete within ${timeoutMs / 1000}s (counter stuck at ${beforeCount})`,
  );
}

function runAnalysis() {
  const out = execSync(
    `node ${join(ROOT, "scripts/analyze-sessions.mjs")} --last 1`,
    { encoding: "utf8", timeout: 60_000 },
  ).trim();
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

// ── Main ────────────────────────────────────────────────────

export async function runObserve({
  baseDir,
  cycle,
  probes,
  codeChanged,
  timestamp,
}) {
  try {
    const strategy = chooseStrategy({ probes, cycle, codeChanged });

    // Setup step (cold_start only): seed KV + start services
    if (strategy.setup) {
      console.log(`[OBSERVE] Running setup: ${strategy.type}`);
      execSync(strategy.setup, {
        encoding: "utf8",
        timeout: 300_000,
        cwd: ROOT,
        stdio: "inherit",
      });
    }

    const counterBefore = readSessionCounter();

    // Trigger the session — curl returns immediately, we poll for completion
    execSync(strategy.trigger, {
      encoding: "utf8",
      timeout: 30_000,
      cwd: ROOT,
      stdio: "pipe",
    });

    // Poll until session_counter increments
    const counterAfter = pollUntilIncrement(counterBefore);

    // Collect analysis data
    const analysis = runAnalysis();

    // Derive latest session id from analysis if available
    const latestSessionId =
      analysis?.sessions?.[0]?.id ||
      analysis?.sessions?.[0]?.session_id ||
      null;

    const observation = {
      timestamp,
      strategy: strategy.type,
      session_counter_before: counterBefore,
      session_counter_after: counterAfter,
      latest_session_id: latestSessionId,
      analysis,
    };

    await saveRun(baseDir, timestamp, "observation.json", observation);

    return { success: true, observation };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

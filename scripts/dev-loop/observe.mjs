// Observe stage — trigger an agent session and collect results.
// Pure functions (detectCompletion, chooseStrategy) are unit-testable.
// runObserve orchestrates shell commands and is integration-tested only.

import { execSync } from "child_process";
import { join } from "path";
import { saveRun } from "./state.mjs";
import { getKV, dispose } from "../shared.mjs";

const ROOT = join(import.meta.dirname, "../..");

// ── Pure functions ──────────────────────────────────────────

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged }) {
  const clearScheduleCmd = "curl -sf -X POST http://localhost:8787/__clear-schedule";
  const triggerCmd = "curl -sf http://localhost:8787/__scheduled";

  if (cycle === 0 || codeChanged) {
    return {
      type: "cold_start",
      // Don't use start.sh — it ends with `wait` and blocks forever.
      // Instead: seed KV directly, then force the running worker's schedule
      // into the past before triggering. Assumes services are already running.
      setup: [
        `node ${join(ROOT, "scripts/seed-local-kv.mjs")}`,
        clearScheduleCmd,
      ],
      trigger: triggerCmd,
    };
  }
  return {
    type: "accumulate",
    // Accumulate keeps existing state, but still needs to bypass the live
    // schedule gate so the dev loop can force a session on demand.
    setup: [clearScheduleCmd],
    trigger: triggerCmd,
  };
}

// ── Helpers ─────────────────────────────────────────────────

async function getSessionIds(kv) {
  try {
    return (await kv.get("cache:session_ids", "json")) || [];
  } catch {
    return [];
  }
}

async function pollForNewSession(kv, beforeIds, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  const interval = 10_000;
  const beforeSet = new Set(beforeIds);
  while (Date.now() < deadline) {
    const currentIds = await getSessionIds(kv);
    const newId = currentIds.find(id => !beforeSet.has(id));
    if (newId) {
      console.log(`\n[OBSERVE] Session complete: ${newId}`);
      return newId;
    }
    const elapsed = Math.round((Date.now() + timeoutMs - deadline) / 1000);
    process.stdout.write(`\r[OBSERVE] Waiting for act session... ${elapsed}s (${currentIds.length} sessions)`);
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(
    `No new act session within ${timeoutMs / 1000}s`,
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

    // Setup step: cold_start seeds KV, all strategies clear the schedule first.
    const setupCmds = Array.isArray(strategy.setup) ? strategy.setup
      : strategy.setup ? [strategy.setup] : [];
    if (setupCmds.length) {
      console.log(`[OBSERVE] Running setup: ${strategy.type}`);
      for (const cmd of setupCmds) {
        execSync(cmd, {
          encoding: "utf8",
          timeout: 300_000,
          cwd: ROOT,
          stdio: "inherit",
        });
      }
    }

    // Read session IDs via shared Miniflare KV (one instance, no lock conflicts)
    const kv = await getKV();
    const beforeIds = await getSessionIds(kv);

    // Trigger the session in the background — /__scheduled is synchronous
    // and blocks until the full tick completes (minutes). Fire and forget,
    // then poll cache:session_ids for the new entry.
    console.log(`[OBSERVE] Triggering session (${beforeIds.length} sessions before)`);
    const { spawn } = await import("child_process");
    const triggerProc = spawn("sh", ["-c", strategy.trigger], {
      cwd: ROOT,
      stdio: "ignore",
      detached: true,
    });
    triggerProc.unref();

    // Poll until a new session ID appears in cache:session_ids (10 min timeout)
    // This only fires for real act sessions, not schedule-skipped ticks
    const newSessionId = await pollForNewSession(kv, beforeIds);
    await dispose();

    // Collect analysis data
    const analysis = runAnalysis();

    const observation = {
      timestamp,
      strategy: strategy.type,
      latest_session_id: newSessionId,
      analysis,
    };

    await saveRun(baseDir, timestamp, "observation.json", observation);

    return { success: true, observation };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

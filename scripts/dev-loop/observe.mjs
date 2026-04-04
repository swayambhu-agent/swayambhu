// Observe stage — trigger an agent session and collect results.
// Pure functions (detectCompletion, chooseStrategy) are unit-testable.
// runObserve orchestrates shell commands and is integration-tested only.

import { execSync, spawn } from "child_process";
import { join } from "path";
import { saveRun } from "./state.mjs";

const ROOT = join(import.meta.dirname, "../..");
const KERNEL_URL = process.env.SWAYAMBHU_KERNEL_URL || "http://localhost:8787";
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || "http://localhost:8790";
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
const OBSERVE_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 10_000;

// ── Pure functions ──────────────────────────────────────────

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged }) {
  const clearScheduleCmd = `curl -sf -X POST ${KERNEL_URL}/__clear-schedule`;
  const triggerUrl = `${KERNEL_URL}/__scheduled`;

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
      trigger: triggerUrl,
    };
  }
  return {
    type: "accumulate",
    // Accumulate keeps existing state, but still needs to bypass the live
    // schedule gate so the dev loop can force a session on demand.
    setup: [clearScheduleCmd],
    trigger: triggerUrl,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "X-Patron-Key": DASHBOARD_KEY,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} from ${url}: ${body || res.statusText}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readSessionIds() {
  const keys = encodeURIComponent("cache:session_ids");
  const data = await fetchJson(`${DASHBOARD_URL}/kv/multi?keys=${keys}`);
  return Array.isArray(data["cache:session_ids"]) ? data["cache:session_ids"] : [];
}

async function pollForNewSession(beforeIds, timeoutMs = OBSERVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const beforeSet = new Set(beforeIds);

  while (Date.now() < deadline) {
    const currentIds = await readSessionIds();
    const newId = currentIds.find(id => !beforeSet.has(id));
    if (newId) {
      process.stdout.write("\n");
      console.log(`[OBSERVE] Session complete: ${newId}`);
      return newId;
    }
    const elapsedSec = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const latest = currentIds.at(-1) || "none";
    process.stdout.write(
      `\r[OBSERVE] Waiting for act session... ${elapsedSec}s elapsed, ${remainingSec}s left, ` +
      `${currentIds.length} sessions, latest=${latest}`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  process.stdout.write("\n");
  throw new Error(
    `No new act session within ${timeoutMs / 1000}s while polling dashboard KV`,
  );
}

function runAnalysis() {
  const out = execSync(
    `node ${join(ROOT, "scripts/analyze-sessions.mjs")} --last 1 --source dashboard`,
    {
      encoding: "utf8",
      timeout: 60_000,
      cwd: ROOT,
      env: {
        ...process.env,
        SWAYAMBHU_DASHBOARD_URL: DASHBOARD_URL,
        SWAYAMBHU_PATRON_KEY: DASHBOARD_KEY,
      },
    },
  ).trim();
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

async function assertDashboardAvailable() {
  await fetchJson(`${DASHBOARD_URL}/health`, { timeoutMs: 10_000 });
}

function triggerScheduled(url) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `await fetch(${JSON.stringify(url)});`,
  ], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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

    await assertDashboardAvailable();
    const beforeIds = await readSessionIds();

    // /__scheduled is synchronous and may run for several minutes.
    // Fire it in a detached child so observe can poll independently.
    console.log(`[OBSERVE] Triggering session (${beforeIds.length} sessions before)`);
    triggerScheduled(strategy.trigger);

    // Poll until a new session ID appears in cache:session_ids (10 min timeout).
    // This only moves when the act lifecycle actually starts.
    const newSessionId = await pollForNewSession(beforeIds);

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

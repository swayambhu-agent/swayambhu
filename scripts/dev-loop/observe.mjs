// Observe stage — trigger an agent session and collect results.
// Pure functions (detectCompletion, chooseStrategy) are unit-testable.
// runObserve orchestrates shell commands and is integration-tested only.

import { execSync } from "child_process";
import { join } from "path";
import { saveRun } from "./state.mjs";
import { getDefaultServiceUrls, restartServices } from "./services.mjs";

const ROOT = join(import.meta.dirname, "../..");
const DEFAULT_URLS = getDefaultServiceUrls();
const KERNEL_URL = process.env.SWAYAMBHU_KERNEL_URL || DEFAULT_URLS.kernelUrl;
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
const OBSERVE_TIMEOUT_MS = 900_000; // 15 minutes
const POLL_INTERVAL_MS = 10_000;

// ── Pure functions ──────────────────────────────────────────

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged, coldStart }) {
  const wakeTrigger = {
    url: `${KERNEL_URL}/__wake`,
    method: "POST",
    body: {
      actor: "dev_loop",
      context: { intent: "probe", debug_mode: true },
    },
  };

  if (cycle === 0 || codeChanged || coldStart) {
    return {
      type: "cold_start",
      // Full reset handled by runObserve: stop workers, wipe, seed, restart.
      setup: "cold_start_sequence",
      trigger: wakeTrigger,
    };
  }
  return {
    type: "accumulate",
    setup: [],
    trigger: wakeTrigger,
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

async function readLastExecutions() {
  const keys = encodeURIComponent("kernel:last_executions");
  const data = await fetchJson(`${DASHBOARD_URL}/kv/multi?keys=${keys}`);
  return Array.isArray(data["kernel:last_executions"]) ? data["kernel:last_executions"] : [];
}

export async function pollForNewSession(beforeIds, timeoutMs = OBSERVE_TIMEOUT_MS, deps = {}) {
  const {
    readSessionIdsFn = readSessionIds,
    readLastExecutionsFn = readLastExecutions,
    restartServicesFn = restartServices,
    sleepFn = sleep,
    stdout = process.stdout,
    log = console.log,
  } = deps;
  const deadline = Date.now() + timeoutMs;
  const beforeSet = new Set(beforeIds);
  const beforeExecutions = await readLastExecutionsFn();
  const beforeExecutionSet = new Set(beforeExecutions.map((execution) => execution.id));

  // Phase 1: poll cache:session_ids for a new session ID (session started)
  let newId = null;
  while (Date.now() < deadline) {
    const currentIds = await readSessionIdsFn();
    newId = currentIds.find(id => !beforeSet.has(id));
    if (newId) {
      stdout.write("\n");
      log(`[OBSERVE] Session started: ${newId}`);
      break;
    }
    const executions = await readLastExecutionsFn();
    const execution = executions.find((entry) => !beforeExecutionSet.has(entry.id));
    if (execution) {
      newId = execution.id;
      stdout.write("\n");
      log(`[OBSERVE] Execution started without session cache entry: ${newId}`);
      break;
    }
    const elapsedSec = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    stdout.write(
      `\r[OBSERVE] Waiting for session to start... ${elapsedSec}s elapsed, ${remainingSec}s left`,
    );
    await sleepFn(POLL_INTERVAL_MS);
  }

  if (!newId) {
    stdout.write("\n");
    await restartServicesFn();
    throw new Error(`No new session started within ${timeoutMs / 1000}s`);
  }

  // Phase 2: poll kernel:last_executions for terminal outcome with this ID
  // (session completed — clean, crash, or killed)
  while (Date.now() < deadline) {
    const executions = await readLastExecutionsFn();
    const completed = executions.find(e => e.id === newId);
    if (completed) {
      log(`[OBSERVE] Session completed: ${newId} (outcome: ${completed.outcome})`);
      // Brief delay for KV writes to propagate through dashboard cache
      await sleepFn(5000);
      return newId;
    }
    const elapsedSec = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    stdout.write(
      `\r[OBSERVE] Session ${newId} running... ${elapsedSec}s elapsed, ${remainingSec}s left`,
    );
    await sleepFn(POLL_INTERVAL_MS);
  }

  stdout.write("\n");
  await restartServicesFn();
  throw new Error(
    `Session ${newId} started but did not complete within ${timeoutMs / 1000}s`,
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

async function triggerRequest(spec) {
  const method = spec?.method || "GET";
  const body = spec?.body ? JSON.stringify(spec.body) : null;
  const response = await fetch(spec.url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`wake trigger failed (${response.status}): ${text || response.statusText}`);
  }
}

// ── Main ────────────────────────────────────────────────────

export async function runObserve({
  baseDir,
  cycle,
  probes,
  codeChanged,
  coldStart,
  timestamp,
}) {
  try {
    const strategy = chooseStrategy({ probes, cycle, codeChanged, coldStart });

    // Setup
    if (strategy.setup === "cold_start_sequence") {
      console.log(`[OBSERVE] Running cold start via managed service restart`);
      await restartServices({ resetAllState: true });

    } else if (strategy.setup) {
      // Normal setup (e.g. clear schedule)
      const setupCmds = Array.isArray(strategy.setup) ? strategy.setup : [strategy.setup];
      console.log(`[OBSERVE] Running setup: ${strategy.type}`);
      for (const cmd of setupCmds) {
        execSync(cmd, { encoding: 'utf8', timeout: 300_000, cwd: ROOT, stdio: 'inherit' });
      }
    }

    await assertDashboardAvailable();
    const beforeIds = await readSessionIds();

    // /__wake returns immediately after queueing the execution, so a direct
    // fetch is simpler and more reliable than a detached child process.
    console.log(`[OBSERVE] Triggering session (${beforeIds.length} sessions before)`);
    await triggerRequest(strategy.trigger);

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

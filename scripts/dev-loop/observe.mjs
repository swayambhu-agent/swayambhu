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
const KERNEL_PORT = process.env.SWAYAMBHU_KERNEL_PORT || 8787;
const DASHBOARD_PORT = process.env.SWAYAMBHU_DASHBOARD_PORT || 8790;
const OBSERVE_TIMEOUT_MS = 900_000; // 15 minutes
const POLL_INTERVAL_MS = 10_000;

async function restartServices() {
  // Shared logic with loop.mjs ensureServices — spawns both workers
  // and waits for HTTP readiness. Duplicated here to avoid circular imports.
  const kernel = spawn('npx', [
    'wrangler', 'dev', '-c', 'wrangler.dev.toml',
    '--test-scheduled', '--persist-to', '.wrangler/shared-state',
  ], { cwd: ROOT, detached: true, stdio: 'ignore' });
  kernel.unref();

  const dashboard = spawn('npx', [
    'wrangler', 'dev', '--port', String(DASHBOARD_PORT),
    '--inspector-port', '9230', '--persist-to', '../.wrangler/shared-state',
  ], { cwd: join(ROOT, 'dashboard-api'), detached: true, stdio: 'ignore' });
  dashboard.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const [k, d] = await Promise.all([
        fetch(`http://localhost:${KERNEL_PORT}/`, { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false),
        fetch(`http://localhost:${DASHBOARD_PORT}/`, { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false),
      ]);
      if (k && d) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error('Services failed to restart within 30s');
}

// ── Pure functions ──────────────────────────────────────────

export function detectCompletion(beforeCount, afterCount) {
  return afterCount > beforeCount;
}

export function chooseStrategy({ probes, cycle, codeChanged, coldStart }) {
  const clearScheduleCmd = `curl -sf -X POST ${KERNEL_URL}/__clear-schedule`;
  const triggerUrl = `${KERNEL_URL}/__scheduled`;

  if (cycle === 0 || codeChanged || coldStart) {
    return {
      type: "cold_start",
      // Full reset handled by runObserve: stop workers, wipe, seed, restart.
      setup: "cold_start_sequence",
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

async function readLastExecutions() {
  const keys = encodeURIComponent("kernel:last_executions");
  const data = await fetchJson(`${DASHBOARD_URL}/kv/multi?keys=${keys}`);
  return Array.isArray(data["kernel:last_executions"]) ? data["kernel:last_executions"] : [];
}

async function pollForNewSession(beforeIds, timeoutMs = OBSERVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const beforeSet = new Set(beforeIds);

  // Phase 1: poll cache:session_ids for a new session ID (session started)
  let newId = null;
  while (Date.now() < deadline) {
    const currentIds = await readSessionIds();
    newId = currentIds.find(id => !beforeSet.has(id));
    if (newId) {
      process.stdout.write("\n");
      console.log(`[OBSERVE] Session started: ${newId}`);
      break;
    }
    const elapsedSec = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    process.stdout.write(
      `\r[OBSERVE] Waiting for session to start... ${elapsedSec}s elapsed, ${remainingSec}s left`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  if (!newId) {
    process.stdout.write("\n");
    throw new Error(`No new session started within ${timeoutMs / 1000}s`);
  }

  // Phase 2: poll kernel:last_executions for terminal outcome with this ID
  // (session completed — clean, crash, or killed)
  while (Date.now() < deadline) {
    const executions = await readLastExecutions();
    const completed = executions.find(e => e.id === newId);
    if (completed) {
      console.log(`[OBSERVE] Session completed: ${newId} (outcome: ${completed.outcome})`);
      // Brief delay for KV writes to propagate through dashboard cache
      await sleep(5000);
      return newId;
    }
    const elapsedSec = Math.round((timeoutMs - (deadline - Date.now())) / 1000);
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    process.stdout.write(
      `\r[OBSERVE] Session ${newId} running... ${elapsedSec}s elapsed, ${remainingSec}s left`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  process.stdout.write("\n");
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
  coldStart,
  timestamp,
}) {
  try {
    const strategy = chooseStrategy({ probes, cycle, codeChanged, coldStart });

    // Setup
    if (strategy.setup === "cold_start_sequence") {
      console.log(`[OBSERVE] Running cold start: stop → wipe → seed → restart`);

      // 1. Kill all wrangler/workerd processes
      try { execSync('pkill -9 -f workerd', { stdio: 'ignore', timeout: 5000 }); } catch {}
      try { execSync('pkill -9 -f "wrangler dev"', { stdio: 'ignore', timeout: 5000 }); } catch {}

      // 2. Wait for both workerd and wrangler dev to exit (up to 10s)
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        let alive = false;
        try { execSync('pgrep -f workerd', { stdio: 'ignore' }); alive = true; } catch {}
        try { execSync('pgrep -f "wrangler dev"', { stdio: 'ignore' }); alive = true; } catch {}
        if (!alive) break;
        await sleep(500);
      }
      await sleep(2000); // extra wait for ports to free

      // 3. Wipe state
      try { execSync(`rm -rf ${join(ROOT, '.wrangler/shared-state')}`, { stdio: 'ignore' }); } catch {}

      // 4. Seed
      execSync(`node ${join(ROOT, 'scripts/seed-local-kv.mjs')}`, {
        cwd: ROOT, stdio: 'inherit', timeout: 60_000,
      });

      // 5. Restart workers
      console.log('[OBSERVE] Restarting services...');
      await restartServices();

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

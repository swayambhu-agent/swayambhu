// Observe stage — trigger an agent session and collect results.
// Reusable polling/strategy logic lives in lib/dev-loop/observe.js.

import { execFileSync, execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveRun } from "./state.mjs";
import { getDefaultServiceUrls, restartServices } from "./services.mjs";
import {
  detectCompletion,
  chooseStrategy,
  pollForNewSession,
} from "../../../lib/dev-loop/observe.js";

const ROOT = join(import.meta.dirname, "../../..");
const DEFAULT_URLS = getDefaultServiceUrls();
const KERNEL_URL = process.env.SWAYAMBHU_KERNEL_URL || DEFAULT_URLS.kernelUrl;
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
export {
  detectCompletion,
  chooseStrategy,
  pollForNewSession,
};

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

function runAnalysis() {
  const tempDir = mkdtempSync(join(tmpdir(), "swayambhu-observe-"));
  const outPath = join(tempDir, "analysis.json");
  try {
    execFileSync(
      "node",
      [
        join(ROOT, "scripts/analyze-sessions.mjs"),
        "--last", "1",
        "--source", "dashboard",
        "--out", outPath,
      ],
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
    );
    const out = readFileSync(outPath, "utf8").trim();
    try {
      return JSON.parse(out);
    } catch {
      return { raw: out };
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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
    const newSessionId = await pollForNewSession(beforeIds, undefined, {
      readSessionIdsFn: readSessionIds,
      readLastExecutionsFn: readLastExecutions,
      restartServicesFn: restartServices,
    });

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

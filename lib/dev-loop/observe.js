import { getDefaultServiceUrls } from "../local-services.js";

const DEFAULT_URLS = getDefaultServiceUrls();
const KERNEL_URL = process.env.SWAYAMBHU_KERNEL_URL || DEFAULT_URLS.kernelUrl;
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";
const OBSERVE_TIMEOUT_MS = 900_000;
const POLL_INTERVAL_MS = 10_000;

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

export async function pollForNewSession(beforeIds, timeoutMs = OBSERVE_TIMEOUT_MS, deps = {}) {
  const {
    readSessionIdsFn = readSessionIds,
    readLastExecutionsFn = readLastExecutions,
    restartServicesFn,
    sleepFn = sleep,
    stdout = process.stdout,
    log = console.log,
  } = deps;
  const deadline = Date.now() + timeoutMs;
  const beforeSet = new Set(beforeIds);
  const safeRead = async (label, reader, fallback = null) => {
    try {
      return await reader();
    } catch (error) {
      stdout.write("\n");
      log(`[OBSERVE] ${label} read failed: ${error.message}`);
      return fallback;
    }
  };

  const beforeExecutions = await safeRead("kernel:last_executions", readLastExecutionsFn, []);
  const beforeExecutionSet = new Set(beforeExecutions.map((execution) => execution.id));

  let newId = null;
  while (Date.now() < deadline) {
    const currentIds = await safeRead("cache:session_ids", readSessionIdsFn, null);
    newId = currentIds?.find((id) => !beforeSet.has(id));
    if (newId) {
      stdout.write("\n");
      log(`[OBSERVE] Session started: ${newId}`);
      break;
    }
    const executions = await safeRead("kernel:last_executions", readLastExecutionsFn, null);
    const execution = executions?.find((entry) => !beforeExecutionSet.has(entry.id));
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

  while (Date.now() < deadline) {
    const executions = await safeRead("kernel:last_executions", readLastExecutionsFn, null);
    const completed = executions?.find((e) => e.id === newId);
    if (completed) {
      log(`[OBSERVE] Session completed: ${newId} (outcome: ${completed.outcome})`);
      await sleepFn(5000);
      return newId;
    }
    const supersedingExecution = executions?.find((entry) =>
      !beforeExecutionSet.has(entry.id) && entry.id !== newId);
    if (supersedingExecution) {
      log(
        `[OBSERVE] Session ${newId} was superseded by completed execution ` +
        `${supersedingExecution.id} (outcome: ${supersedingExecution.outcome})`,
      );
      await sleepFn(5000);
      return supersedingExecution.id;
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

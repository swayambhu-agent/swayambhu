#!/usr/bin/env node
// Service management for dev-loop runs.
// Supports the default local stack and the active state-lab branch.

import { spawn } from "child_process";
import { existsSync, openSync, readFileSync } from "fs";
import { join } from "path";

import { STATE_DIR } from "./state.mjs";

const REPO_ROOT = join(import.meta.dirname, "../..");
const DEFAULT_STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const ACTIVE_UI_PATH = join(DEFAULT_STATE_LAB_DIR, "active-ui.json");
const DEFAULT_SERVICE_MODE = process.env.SWAYAMBHU_DEV_LOOP_SERVICE_MODE || "default";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServiceUp(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

function readActiveBranch() {
  if (!existsSync(ACTIVE_UI_PATH)) {
    throw new Error(`No active state-lab branch found at ${ACTIVE_UI_PATH}`);
  }
  return JSON.parse(readFileSync(ACTIVE_UI_PATH, "utf8"));
}

function resolveServiceConfig() {
  if (DEFAULT_SERVICE_MODE === "state_lab_active") {
    const active = readActiveBranch();
    return {
      mode: "state_lab_active",
      branch: active.branch,
      kernelPort: active.kernel_port,
      dashboardPort: active.dashboard_port,
      logPath: join(STATE_DIR, `service-start-${active.branch}.log`),
    };
  }

  return {
    mode: "default",
    branch: null,
    kernelPort: Number(process.env.SWAYAMBHU_KERNEL_PORT || 8787),
    dashboardPort: Number(process.env.SWAYAMBHU_DASHBOARD_PORT || 8790),
    logPath: join(STATE_DIR, "service-start-default.log"),
  };
}

function spawnManagedStart(config, { resetAllState = false } = {}) {
  const logFd = openSync(config.logPath, "a");
  const commonEnv = { ...process.env };
  let child;

  if (config.mode === "state_lab_active") {
    const args = ["scripts/state-lab.mjs", "start", config.branch, "--no-governor"];
    if (resetAllState) args.push("--reset-all-state", "--yes");
    child = spawn("node", args, {
      cwd: REPO_ROOT,
      env: commonEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } else {
    const args = ["scripts/start.sh", "--no-governor"];
    if (resetAllState) args.push("--reset-all-state", "--yes");
    child = spawn("bash", args, {
      cwd: REPO_ROOT,
      env: commonEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  }

  child.unref();
  return child.pid;
}

async function waitForServices(config, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [kernelUp, dashboardUp] = await Promise.all([
      isServiceUp(config.kernelPort),
      isServiceUp(config.dashboardPort),
    ]);
    if (kernelUp && dashboardUp) return;
    await sleep(2000);
  }
  throw new Error(
    `Services failed to start in ${Math.round(timeoutMs / 1000)}s (kernel ${config.kernelPort}, dashboard ${config.dashboardPort}). See ${config.logPath}`,
  );
}

export async function ensureServices(options = {}) {
  const config = resolveServiceConfig();
  const forceRestart = Boolean(options.forceRestart);
  const resetAllState = Boolean(options.resetAllState);

  const [kernelUp, dashboardUp] = await Promise.all([
    isServiceUp(config.kernelPort),
    isServiceUp(config.dashboardPort),
  ]);
  if (kernelUp && dashboardUp && !forceRestart && !resetAllState) {
    return config;
  }

  const pid = spawnManagedStart(config, { resetAllState });
  await waitForServices(config);
  return { ...config, pid };
}

export async function restartServices(options = {}) {
  return ensureServices({ ...options, forceRestart: true });
}

export function getServiceMode() {
  return DEFAULT_SERVICE_MODE;
}

export function getActiveServiceConfig() {
  return resolveServiceConfig();
}

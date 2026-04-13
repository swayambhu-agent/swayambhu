#!/usr/bin/env node
// Service management for dev-loop runs.
// Supports the default local stack and the active state-lab branch.

import { spawn } from "child_process";
import { existsSync, openSync } from "fs";
import { join } from "path";

import {
  getDefaultServiceUrls,
  resolveLocalServiceConfig,
} from "../../lib/local-services.js";
import { STATE_DIR } from "./state.mjs";

const REPO_ROOT = join(import.meta.dirname, "../..");
const DEFAULT_STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const ACTIVE_UI_PATH = join(DEFAULT_STATE_LAB_DIR, "active-ui.json");
const DEFAULT_SERVICE_MODE = process.env.SWAYAMBHU_DEV_LOOP_SERVICE_MODE
  || (existsSync(ACTIVE_UI_PATH) ? "state_lab_active" : "default");

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

export async function waitForRestartBoundary(config, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let sawDownState = false;
  while (Date.now() < deadline) {
    const [kernelUp, dashboardUp] = await Promise.all([
      isServiceUp(config.kernelPort),
      isServiceUp(config.dashboardPort),
    ]);
    if (!kernelUp || !dashboardUp) {
      sawDownState = true;
      return;
    }
    await sleep(1000);
  }

  throw new Error(
    `Services on kernel ${config.kernelPort} and dashboard ${config.dashboardPort} never dropped during restart window. See ${config.logPath}`,
  );
}

function resolveServiceConfig() {
  const base = resolveLocalServiceConfig({
    serviceMode: DEFAULT_SERVICE_MODE,
    activeUiPath: ACTIVE_UI_PATH,
  });
  return {
    ...base,
    logPath: base.mode === "state_lab_active"
      ? join(STATE_DIR, `service-start-${base.branch}.log`)
      : join(STATE_DIR, "service-start-default.log"),
  };
}

function readStartOverrides() {
  const raw = process.env.SWAYAMBHU_START_SET_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).filter(Boolean);
    }
  } catch {}
  return raw
    .split(/\r?\n|;;/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function spawnManagedStart(config, { resetAllState = false } = {}) {
  const logFd = openSync(config.logPath, "a");
  const commonEnv = { ...process.env };
  const overrides = readStartOverrides();
  let child;

  if (config.mode === "state_lab_active") {
    const args = ["scripts/state-lab.mjs", "start", config.branch, "--no-governor"];
    if (resetAllState) args.push("--reset-all-state", "--yes");
    for (const override of overrides) args.push("--set", override);
    child = spawn("node", args, {
      cwd: REPO_ROOT,
      env: commonEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } else {
    const args = ["scripts/start.sh", "--no-governor"];
    if (resetAllState) args.push("--reset-all-state", "--yes");
    for (const override of overrides) args.push("--set", override);
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
  if ((forceRestart || resetAllState) && kernelUp && dashboardUp) {
    await waitForRestartBoundary(config);
  }
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

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { resolve, join } from "path";
import { cleanRemoteComputeSurfaces } from "./remote-compute.js";

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function parseTeardownArgs(argv = []) {
  const options = {
    scope: "all",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--local-only") {
      options.scope = "local";
      continue;
    }
    if (arg === "--remote-only") {
      options.scope = "remote";
      continue;
    }
    if (arg === "--scope") {
      const scope = argv[i + 1];
      if (!scope || !["local", "remote", "all"].includes(scope)) {
        throw new Error("--scope requires one of: local, remote, all");
      }
      options.scope = scope;
      i += 1;
      continue;
    }
    if (arg === "--state-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("--state-dir requires a value");
      options.stateDir = value;
      i += 1;
      continue;
    }
    if (arg === "--snapshot-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("--snapshot-dir requires a value");
      options.snapshotDir = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function resolveTeardownTargets({ root, env = process.env, options = {} }) {
  const stateDir = resolve(options.stateDir || env.SWAYAMBHU_PERSIST_DIR || join(root, ".wrangler/shared-state"));
  const snapshotDir = resolve(
    options.snapshotDir
      || env.SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR
      || join(root, ".wrangler/pre-trigger-snapshot"),
  );

  return {
    stateDir,
    snapshotDir,
    ports: [
      parseInteger(env.SWAYAMBHU_KERNEL_PORT, 8787),
      parseInteger(env.SWAYAMBHU_DASHBOARD_PORT, 8790),
      parseInteger(env.SWAYAMBHU_SPA_PORT, 3001),
      parseInteger(env.SWAYAMBHU_GOVERNOR_PORT, 8791),
      parseInteger(env.SWAYAMBHU_DASHBOARD_INSPECTOR_PORT, 9230),
      parseInteger(env.SWAYAMBHU_GOVERNOR_INSPECTOR_PORT, 9231),
    ],
  };
}

function runShell(command) {
  return spawnSync("bash", ["-lc", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function stopLocalPorts(ports = []) {
  const stopped = [];
  for (const port of ports) {
    const lookup = runShell(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`);
    const pids = String(lookup.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const pid of pids) {
      spawnSync("kill", [pid], { stdio: "ignore" });
      spawnSync("bash", ["-lc", "sleep 0.2"], { stdio: "ignore" });
      spawnSync("kill", ["-9", pid], { stdio: "ignore" });
      stopped.push({ port, pid: Number(pid) });
    }
  }
  return stopped;
}

export async function teardownLocalState({ stateDir, snapshotDir, ports }) {
  const stopped = stopLocalPorts(ports);
  const removed = [];

  for (const target of [stateDir, snapshotDir]) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    }
  }

  return { stopped, removed };
}

export async function teardownRemoteState() {
  return cleanRemoteComputeSurfaces();
}

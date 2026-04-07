#!/usr/bin/env node
// Branchable local-state lab for A/B experiments.
// Saves immutable snapshots, creates writable branches, freezes visible
// balances inside each branch, and starts branch-local services on unique ports.

import { execFileSync, spawn } from "child_process";
import { cp, mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { Kernel } from "../kernel.js";
import * as llm_balance from "../providers/llm_balance.js";
import * as wallet_balance from "../providers/wallet_balance.js";
import { writeReasoningArtifacts } from "../lib/reasoning.js";
import { DEFAULT_LOCAL_STATE_DIR, dispose, getKV, root as REPO_ROOT } from "./shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_LAB_DIR = "/home/swami/swayambhu/state-lab";
export const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || DEFAULT_STATE_LAB_DIR;
export const ACTIVE_UI_PORT = Number(process.env.SWAYAMBHU_ACTIVE_UI_PORT || 9071);
export const ACTIVE_KERNEL_PORT = Number(process.env.SWAYAMBHU_ACTIVE_KERNEL_PORT || 8787);
export const PUBLIC_CALLBACK_URL = process.env.SWAYAMBHU_PUBLIC_CALLBACK_URL || "https://swayambhu.dev";

const SNAPSHOTS_DIR = join(STATE_LAB_DIR, "snapshots");
const BRANCHES_DIR = join(STATE_LAB_DIR, "branches");
const ACTIVE_UI_PATH = join(STATE_LAB_DIR, "active-ui.json");
const PROVIDERS = {
  "provider:llm_balance": llm_balance,
  "provider:wallet_balance": wallet_balance,
};

const PORT_BASES = {
  kernel: 8887,
  dashboard: 8890,
  governor: 8891,
  spa: 9001,
  dashboard_inspector: 9330,
  governor_inspector: 9331,
  step: 10,
};

function loadDotEnv() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

function usage() {
  console.log([
    "Usage:",
    "  node scripts/state-lab.mjs save <snapshot-name> [--from <ref>]",
    "  node scripts/state-lab.mjs branch <source-ref> <branch-name>",
    "  node scripts/state-lab.mjs materialize-dr <source-ref> <branch-name> <payload-path> [--runner <codex|claude>]",
    "  node scripts/state-lab.mjs lab-run <source-ref> <hypothesis-path>",
    "  node scripts/state-lab.mjs promote <branch-name>",
    "  node scripts/state-lab.mjs list",
    "  node scripts/state-lab.mjs show <ref>",
    "  node scripts/state-lab.mjs activate <branch-name>",
    "  node scripts/state-lab.mjs start <branch-name> [start.sh args...]",
    "",
    "Refs:",
    "  current",
    "  snapshot:<name>",
    "  branch:<name>",
    "  <name> (if unique across snapshots/branches)",
  ].join("\n"));
}

export function sanitizeName(name) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid name "${name}" (use letters, numbers, ., _, -)`);
  }
  return name;
}

function absoluteStateDir(input = DEFAULT_LOCAL_STATE_DIR) {
  return resolve(input);
}

function refPath(type, name) {
  const baseDir = type === "snapshot" ? SNAPSHOTS_DIR : BRANCHES_DIR;
  const base = join(baseDir, name);
  return {
    base,
    stateDir: join(base, "state"),
    metadataPath: join(base, "metadata.json"),
    preTriggerSnapshotDir: join(base, "pre-trigger-snapshot"),
    workspaceDir: join(base, "workspace"),
    labStatePath: join(base, "lab-state.json"),
    labReportPath: join(base, "lab-report.json"),
    labResultPath: join(base, "lab-result.json"),
  };
}

async function ensureLabDirs() {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  await mkdir(BRANCHES_DIR, { recursive: true });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadEntry(type, name) {
  const paths = refPath(type, name);
  if (!await pathExists(paths.metadataPath)) return null;
  const metadata = await readJson(paths.metadataPath);
  return { ref: `${type}:${name}`, type, name, metadata, paths };
}

async function loadUniqueNamedEntry(name) {
  const [snapshot, branch] = await Promise.all([
    loadEntry("snapshot", name),
    loadEntry("branch", name),
  ]);
  if (snapshot && branch) {
    throw new Error(`Reference "${name}" is ambiguous; use snapshot:${name} or branch:${name}`);
  }
  return snapshot || branch;
}

async function resolveRef(ref, options = {}) {
  if (!ref || ref === "current") {
    return {
      ref: "current",
      type: "current",
      name: "current",
      metadata: null,
      paths: null,
      stateDir: absoluteStateDir(options.currentStateDir || process.env.SWAYAMBHU_PERSIST_DIR || DEFAULT_LOCAL_STATE_DIR),
    };
  }
  if (ref.startsWith("snapshot:")) {
    const name = sanitizeName(ref.slice("snapshot:".length));
    const entry = await loadEntry("snapshot", name);
    if (!entry) throw new Error(`Snapshot not found: ${name}`);
    return { ...entry, stateDir: entry.paths.stateDir };
  }
  if (ref.startsWith("branch:")) {
    const name = sanitizeName(ref.slice("branch:".length));
    const entry = await loadEntry("branch", name);
    if (!entry) throw new Error(`Branch not found: ${name}`);
    return { ...entry, stateDir: entry.paths.stateDir };
  }

  const entry = await loadUniqueNamedEntry(sanitizeName(ref));
  if (!entry) throw new Error(`Unknown ref: ${ref}`);
  return { ...entry, stateDir: entry.paths.stateDir };
}

async function listEntries(type) {
  const dir = type === "snapshot" ? SNAPSHOTS_DIR : BRANCHES_DIR;
  let names = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {}
  const loaded = [];
  for (const name of names.sort()) {
    const entry = await loadEntry(type, name);
    if (entry) loaded.push(entry);
  }
  return loaded.sort((a, b) => String(a.metadata.created_at).localeCompare(String(b.metadata.created_at)));
}

export function allocateBranchPorts(existingBranches = []) {
  const usedSlots = new Set(
    existingBranches
      .map((entry) => entry?.metadata?.ports?.slot)
      .filter((slot) => Number.isInteger(slot)),
  );
  let slot = 0;
  while (true) {
    if (usedSlots.has(slot)) {
      slot += 1;
      continue;
    }
    const ports = {
      slot,
      kernel: PORT_BASES.kernel + (slot * PORT_BASES.step),
      dashboard: PORT_BASES.dashboard + (slot * PORT_BASES.step),
      governor: PORT_BASES.governor + (slot * PORT_BASES.step),
      spa: PORT_BASES.spa + (slot * PORT_BASES.step),
      dashboard_inspector: PORT_BASES.dashboard_inspector + (slot * PORT_BASES.step),
      governor_inspector: PORT_BASES.governor_inspector + (slot * PORT_BASES.step),
    };
    if (Object.values(ports).includes(ACTIVE_UI_PORT)) {
      slot += 1;
      continue;
    }
    return ports;
  }
}

export function buildStartEnv(metadata) {
  return {
    SWAYAMBHU_PERSIST_DIR: metadata.state_dir,
    SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR: metadata.pre_trigger_snapshot_dir,
    SWAYAMBHU_KERNEL_PORT: String(metadata.ports.kernel),
    SWAYAMBHU_DASHBOARD_PORT: String(metadata.ports.dashboard),
    SWAYAMBHU_GOVERNOR_PORT: String(metadata.ports.governor),
    SWAYAMBHU_SPA_PORT: String(metadata.ports.spa),
    SWAYAMBHU_DASHBOARD_INSPECTOR_PORT: String(metadata.ports.dashboard_inspector),
    SWAYAMBHU_GOVERNOR_INSPECTOR_PORT: String(metadata.ports.governor_inspector),
    SWAYAMBHU_GOVERNOR_ENABLED: "true",
    SWAYAMBHU_START_ISOLATED: "true",
  };
}

function portListening(port) {
  try {
    const output = execFileSync("bash", ["-lc", `ss -ltnH '( sport = :${port} )' 2>/dev/null || true`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function gatewayHealthy(port, proxyKind) {
  try {
    const response = await fetch(`http://localhost:${port}/__active`, { headers: { "Cache-Control": "no-store" } });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.state_lab_gateway === true && payload?.proxy_kind === proxyKind;
  } catch {
    return false;
  }
}

async function ensureGatewayRunning(proxyKind, port) {
  if (await gatewayHealthy(port, proxyKind)) return;
  if (portListening(port)) {
    throw new Error(`Port ${port} is occupied by a non-state-lab ${proxyKind} gateway process`);
  }

  const child = spawn("node", ["scripts/state-lab-gateway.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SWAYAMBHU_STATE_LAB_DIR: STATE_LAB_DIR,
      SWAYAMBHU_ACTIVE_PROXY_KIND: proxyKind,
      SWAYAMBHU_ACTIVE_PROXY_PORT: String(port),
      SWAYAMBHU_ACTIVE_UI_PORT: String(ACTIVE_UI_PORT),
      SWAYAMBHU_ACTIVE_KERNEL_PORT: String(ACTIVE_KERNEL_PORT),
    },
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    if (await gatewayHealthy(port, proxyKind)) return;
  }

  throw new Error(`State-lab ${proxyKind} gateway did not start on port ${port}`);
}

async function setBranchCallbackUrl(stateDir, callbackUrl = PUBLIC_CALLBACK_URL) {
  if (!callbackUrl) return false;
  const kv = await getKV({ stateDir });
  try {
    const defaults = await kv.get("config:defaults", "json");
    if (!defaults) return false;
    if (defaults?.jobs?.callback_url === callbackUrl) return false;
    const updated = {
      ...defaults,
      jobs: {
        ...(defaults.jobs || {}),
        callback_url: callbackUrl,
      },
    };
    await kv.put("config:defaults", JSON.stringify(updated), { metadata: { format: "json" } });
    return true;
  } finally {
    await dispose();
  }
}

async function captureVisibleBalances(stateDir) {
  const kv = await getKV({ stateDir });
  try {
    const kernel = new Kernel({ KV: kv, ...process.env }, { PROVIDERS });
    return await kernel.checkBalance({});
  } finally {
    await dispose();
  }
}

async function persistBranchRuntimeState(metadata) {
  const kv = await getKV({ stateDir: metadata.state_dir });
  const now = metadata.created_at;
  try {
    await kv.put("kernel:balance_overrides", JSON.stringify(metadata.recorded_balances), {
      metadata: { format: "json", updated_at: now, state_lab: true },
    });
    await kv.put("kernel:state_lab", JSON.stringify({
      ref: `branch:${metadata.name}`,
      source_ref: metadata.source_ref,
      created_at: metadata.created_at,
      ports: metadata.ports,
      pre_trigger_snapshot_dir: metadata.pre_trigger_snapshot_dir,
    }), {
      metadata: { format: "json", updated_at: now, state_lab: true },
    });
  } finally {
    await dispose();
  }
}

async function loadDesireCount(kv) {
  const list = await kv.list({ prefix: "desire:" });
  return list.keys.length;
}

async function writeMetadata(path, metadata) {
  await writeFile(path, JSON.stringify(metadata, null, 2), "utf8");
}

async function copyStateTree(sourceDir, destDir) {
  if (!await pathExists(sourceDir)) {
    throw new Error(`State dir not found: ${sourceDir}`);
  }
  await mkdir(dirname(destDir), { recursive: true });
  await cp(sourceDir, destDir, { recursive: true });
}

const LAB_CODE_TARGETS = {
  "hook:session:code": "userspace.js",
  "hook:reflect:code": "reflect.js",
  "hook:communication:code": "hook-communication.js",
  "kernel:source:kernel.js": "kernel.js",
};

function slugifyLabName(input) {
  const slug = String(input || "lab")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return slug || "lab";
}

export function buildLabBranchName(hypothesisPath, now = new Date()) {
  const base = basename(hypothesisPath, extname(hypothesisPath));
  const date = now.toISOString().replace(/[:.]/g, "-");
  return sanitizeName(`lab-${slugifyLabName(base)}-${date}`);
}

function shouldCopyWorkspacePath(srcPath) {
  const rel = relative(REPO_ROOT, srcPath);
  if (!rel || rel === "") return true;
  const top = rel.split("/")[0];
  return ![
    ".git",
    "node_modules",
    "local-state",
    ".wrangler",
    "coverage",
  ].includes(top);
}

async function prepareWorkspace(entry) {
  const { workspaceDir } = entry.paths;
  await mkdir(dirname(workspaceDir), { recursive: true });
  await cp(REPO_ROOT, workspaceDir, {
    recursive: true,
    filter: shouldCopyWorkspacePath,
  });

  const rootNodeModules = join(REPO_ROOT, "node_modules");
  const workspaceNodeModules = join(workspaceDir, "node_modules");
  if (await pathExists(rootNodeModules) && !await pathExists(workspaceNodeModules)) {
    await symlink(rootNodeModules, workspaceNodeModules, "dir");
  }
}

function resolveLabTargetRelativePath(change) {
  const target = change.path || change.target;
  if (!target || typeof target !== "string") {
    throw new Error("Candidate code change requires path or target");
  }
  if (LAB_CODE_TARGETS[target]) return LAB_CODE_TARGETS[target];
  return target;
}

export function resolveLabWorkspacePath(workspaceDir, change) {
  const relativePath = resolveLabTargetRelativePath(change);
  const resolved = resolve(workspaceDir, relativePath);
  const normalizedWorkspace = `${resolve(workspaceDir)}/`;
  if (!resolved.startsWith(normalizedWorkspace) && resolved !== resolve(workspaceDir)) {
    throw new Error(`Candidate change escapes workspace: ${relativePath}`);
  }
  return resolved;
}

export async function applyWorkspaceCandidateChange(workspaceDir, change) {
  const targetPath = resolveLabWorkspacePath(workspaceDir, change);
  await mkdir(dirname(targetPath), { recursive: true });

  if (typeof change.code === "string") {
    await writeFile(targetPath, change.code, "utf8");
    return { kind: "workspace_write", targetPath };
  }

  if (typeof change.old_string === "string" && typeof change.new_string === "string") {
    const current = await readFile(targetPath, "utf8");
    if (!current.includes(change.old_string)) {
      throw new Error(`old_string not found in ${relative(workspaceDir, targetPath)}`);
    }
    if (current.indexOf(change.old_string) !== current.lastIndexOf(change.old_string)) {
      throw new Error(`old_string matches multiple locations in ${relative(workspaceDir, targetPath)}`);
    }
    await writeFile(targetPath, current.replace(change.old_string, change.new_string), "utf8");
    return { kind: "workspace_patch", targetPath };
  }

  throw new Error(`Unsupported code change for ${relative(workspaceDir, targetPath)}`);
}

async function applyKvCandidateChange(stateDir, change) {
  const kv = await getKV({ stateDir });
  try {
    if (change.type === "kv_put") {
      await kv.put(change.key, JSON.stringify(change.value), { metadata: { format: "json", state_lab: true } });
      return { kind: "kv_put", key: change.key };
    }
    if (change.type === "kv_delete") {
      await kv.delete(change.key);
      return { kind: "kv_delete", key: change.key };
    }
    if (change.type === "kv_patch") {
      const current = await kv.get(change.key, "text");
      if (typeof current !== "string") throw new Error(`kv_patch target is not string: ${change.key}`);
      if (!current.includes(change.old_string)) throw new Error(`old_string not found in ${change.key}`);
      if (current.indexOf(change.old_string) !== current.lastIndexOf(change.old_string)) {
        throw new Error(`old_string matches multiple locations in ${change.key}`);
      }
      await kv.put(change.key, current.replace(change.old_string, change.new_string), {
        metadata: { format: "text", state_lab: true },
      });
      return { kind: "kv_patch", key: change.key };
    }
    throw new Error(`Unsupported KV change type: ${change.type}`);
  } finally {
    await dispose();
  }
}

async function applyCandidateChanges(entry, candidateChanges = []) {
  const applied = [];
  for (const change of candidateChanges) {
    if (!change?.type) throw new Error("Candidate change missing type");
    if (change.type.startsWith("kv_")) {
      applied.push(await applyKvCandidateChange(entry.metadata.state_dir, change));
      continue;
    }
    if (change.type === "code_patch") {
      applied.push(await applyWorkspaceCandidateChange(entry.paths.workspaceDir, change));
      continue;
    }
    throw new Error(`Unsupported candidate change type: ${change.type}`);
  }
  return applied;
}

async function runStaticValidation(entry, validation = {}, limits = {}) {
  const commands = Array.isArray(validation.static_commands) ? validation.static_commands : [];
  const timeoutMs = Math.max(60_000, (limits.max_wall_time_minutes || 30) * 60_000);
  const env = {
    ...process.env,
    ...buildStartEnv(entry.metadata),
    SWAYAMBHU_LAB_PROFILE: "static",
  };
  const results = [];
  let passed = true;

  for (const command of commands) {
    try {
      const output = execFileSync("bash", ["-lc", command], {
        cwd: entry.paths.workspaceDir,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
      results.push({
        command,
        ok: true,
        output_tail: output.slice(-4000),
      });
    } catch (error) {
      passed = false;
      results.push({
        command,
        ok: false,
        exit_code: Number.isInteger(error.status) ? error.status : null,
        stdout_tail: String(error.stdout || "").slice(-4000),
        stderr_tail: String(error.stderr || "").slice(-4000),
      });
      break;
    }
  }

  return { passed, commands: results };
}

async function writeLabState(paths, state) {
  await writeFile(paths.labStatePath, JSON.stringify(state, null, 2), "utf8");
}

async function writeLabReport(paths, report) {
  await writeFile(paths.labReportPath, JSON.stringify(report, null, 2), "utf8");
}

async function writeLabResult(paths, result) {
  await writeFile(paths.labResultPath, JSON.stringify(result, null, 2), "utf8");
}

async function deriveRecordedBalances(source) {
  if (source.metadata?.recorded_balances) {
    return {
      recorded_balances: source.metadata.recorded_balances,
      recorded_balance_at: source.metadata.recorded_balance_at || source.metadata.created_at || null,
      recorded_balance_source: source.metadata.recorded_balance_source || source.ref,
    };
  }

  const recorded_balances = await captureVisibleBalances(source.stateDir);
  return {
    recorded_balances,
    recorded_balance_at: new Date().toISOString(),
    recorded_balance_source: `${source.ref}:captured_live`,
  };
}

async function createBranchFromSource(sourceRef, name) {
  const target = refPath("branch", sanitizeName(name));
  if (await pathExists(target.base)) throw new Error(`Branch already exists: ${name}`);

  const source = await resolveRef(sourceRef);
  const recorded = await deriveRecordedBalances(source);
  const ports = allocateBranchPorts(await listEntries("branch"));
  const createdAt = new Date().toISOString();

  await copyStateTree(source.stateDir, target.stateDir);

  const metadata = {
    type: "branch",
    name,
    created_at: createdAt,
    source_ref: source.ref,
    source_state_dir: source.stateDir,
    state_dir: target.stateDir,
    pre_trigger_snapshot_dir: target.preTriggerSnapshotDir,
    ports,
    recorded_balance_at: recorded.recorded_balance_at,
    recorded_balance_source: recorded.recorded_balance_source,
    recorded_balances: recorded.recorded_balances,
  };

  await persistBranchRuntimeState(metadata);
  await writeMetadata(target.metadataPath, metadata);
  return {
    source,
    recorded,
    entry: { ref: `branch:${name}`, type: "branch", name, metadata, paths: target, stateDir: target.stateDir },
  };
}

async function loadDrPayload(payloadPath, runner = null) {
  const resolved = resolve(payloadPath);
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  if (Array.isArray(parsed?.kv_operations) || parsed?.reflection || parsed?.carry_forward) {
    return { payload: parsed, resolvedPath: resolved, runner: runner || null };
  }

  if (runner && parsed?.[runner]?.payload) {
    return { payload: parsed[runner].payload, resolvedPath: resolved, runner };
  }

  if (parsed?.codex?.payload && !runner) {
    return { payload: parsed.codex.payload, resolvedPath: resolved, runner: "codex" };
  }
  if (parsed?.claude?.payload && !runner) {
    return { payload: parsed.claude.payload, resolvedPath: resolved, runner: "claude" };
  }

  throw new Error(`Could not find DR payload in ${resolved}`);
}

async function materializeDrToBranch(branchEntry, payload, options = {}) {
  const kv = await getKV({ stateDir: branchEntry.stateDir });
  const kernel = new Kernel({ KV: kv, ...process.env }, { PROVIDERS });
  const now = new Date().toISOString();
  const executionId = options.executionId
    || `x_state_lab_dr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  kernel.executionId = executionId;
  kernel.keyTiers = await kernel.kvGet("kernel:key_tiers") || Kernel.DEFAULT_KEY_TIERS;
  kernel.defaults = await kernel.kvGet("config:defaults");

  const state = await kernel.kvGet("dr:state:1") || {
    status: "completed",
    generation: 1,
    consecutive_failures: 0,
  };
  const inheritedJobId = state.job_id || null;
  const sessionCount = (await kernel.kvGet("session_counter")) || 0;
  const hadNoDesires = (await loadDesireCount(kv)) === 0;

  const ops = (payload.kv_operations || []).filter((op) =>
    op.key?.startsWith("pattern:") || op.key?.startsWith("desire:")
    || op.key?.startsWith("tactic:") || op.key?.startsWith("principle:")
    || op.key?.startsWith("config:") || op.key?.startsWith("prompt:")
  );
  const blocked = [];
  for (const op of ops) {
    const gatedOp = op.op === "delete"
      ? { key: op.key, op: "delete" }
      : op.op === "patch"
      ? { key: op.key, op: "patch", old_string: op.old_string, new_string: op.new_string, deliberation: op.deliberation }
      : { key: op.key, op: "put", value: op.value, ...(op.deliberation ? { deliberation: op.deliberation } : {}) };
    const result = await kernel.kvWriteGated(gatedOp, "deep-reflect");
    if (!result.ok) blocked.push({ key: op.key, error: result.error });
  }
  if (blocked.length > 0) {
    await kernel.karmaRecord({ event: "dr_apply_blocked", blocked, applied: ops.length - blocked.length });
  }

  const reasoningDir = join(branchEntry.paths.base, "reasoning");
  if (payload.reasoning_artifacts?.length) {
    await writeReasoningArtifacts(payload.reasoning_artifacts.map((artifact) => ({
      ...artifact,
      created_at: artifact.created_at || now,
      source: artifact.source || options.runner || "state-lab",
    })), { dir: reasoningDir });
  }

  const prevLastReflect = await kernel.kvGet("last_reflect");
  const carry_forward = payload.carry_forward || prevLastReflect?.carry_forward || [];

  await kernel.kvWriteSafe(`reflect:1:${executionId}`, {
    reflection: payload.reflection,
    note_to_future_self: payload.note_to_future_self,
    depth: 1,
    session_id: executionId,
    timestamp: now,
    from_dr_generation: state.generation || 1,
    carry_forward,
  });

  await kernel.kvWriteSafe("last_reflect", {
    session_summary: payload.reflection,
    note_to_future_self: payload.note_to_future_self || prevLastReflect?.note_to_future_self,
    carry_forward,
    was_deep_reflect: true,
    depth: 1,
    session_id: executionId,
  });

  const eventTs = Date.now().toString().padStart(15, "0");
  const eventNonce = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const eventKey = `event:${eventTs}:dr_complete:${eventNonce}`;
  await kv.put(eventKey, JSON.stringify({
    type: "dr_complete",
    contact: (await kernel.kvGet("patron:contact")) || null,
    reflection: payload.reflection || "",
    desires_changed: ops.filter((o) => o.key?.startsWith("desire:")).length,
    patterns_changed: ops.filter((o) => o.key?.startsWith("pattern:")).length,
    tactics_changed: ops.filter((o) => o.key?.startsWith("tactic:")).length,
    timestamp: now,
  }), { expirationTtl: 86400 });
  await kernel.karmaRecord({ event: "event_emitted", type: "dr_complete", key: eventKey });

  const desireCount = await loadDesireCount(kv);
  if (hadNoDesires && desireCount > 0) {
    const schedule = await kernel.kvGet("session_schedule");
    await kernel.kvWriteSafe("session_schedule", {
      next_session_after: now,
      interval_seconds: schedule?.interval_seconds || kernel.defaults?.schedule?.interval_seconds || 21600,
      no_action_streak: schedule?.no_action_streak || 0,
    });
    await kernel.karmaRecord({
      event: "bootstrap_ready_after_dr",
      generation: state.generation || 1,
      desires_created: desireCount,
    });
  }

  const defaultInterval = kernel.defaults?.deep_reflect?.default_interval_sessions || 20;
  const requestedInterval = payload.next_reflect?.after_sessions || defaultInterval;
  const interval = (state.generation || 1) <= 5
    ? Math.min(defaultInterval, requestedInterval)
    : requestedInterval;
  const intervalDays = payload.next_reflect?.after_days
    || kernel.defaults?.deep_reflect?.default_interval_days || 7;

  const nextState = {
    ...state,
    status: "idle",
    generation: state.generation || 1,
    job_id: null,
    workdir: null,
    applied_at: now,
    completed_at: state.completed_at || now,
    last_applied_session: sessionCount,
    last_execution_id: executionId,
    consecutive_failures: 0,
    last_failure_session: null,
    failure_reason: null,
    next_due_session: sessionCount + interval,
    next_due_date: new Date(Date.now() + intervalDays * 86400000).toISOString(),
  };
  await kernel.kvDeleteSafe(`dr:result:${nextState.generation}`);
  if (inheritedJobId) {
    await kernel.kvDeleteSafe(`job:${inheritedJobId}`);
    await kernel.kvDeleteSafe(`job_result:${inheritedJobId}`);
    await kernel.karmaRecord({
      event: "state_lab_job_sanitized",
      job_id: inheritedJobId,
      reason: "materialized_dr_branch",
    });
  }
  await kernel.kvWriteSafe("dr:state:1", nextState);

  return {
    executionId,
    blocked,
    reasoningDir,
    sanitized_inherited_job_id: inheritedJobId,
    next_due_session: nextState.next_due_session,
    desire_count: desireCount,
  };
}

function summarizeBalances(balanceSnapshot = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(balanceSnapshot.providers || {})) {
    if (typeof value?.balance === "number") parts.push(`provider:${name}=${value.balance}`);
    else if (value?.error) parts.push(`provider:${name}=error:${value.error}`);
  }
  for (const [name, value] of Object.entries(balanceSnapshot.wallets || {})) {
    if (typeof value?.balance === "number") parts.push(`wallet:${name}=${value.balance}`);
    else if (value?.error) parts.push(`wallet:${name}=error:${value.error}`);
  }
  return parts.join(", ");
}

async function cmdSave(args) {
  const name = sanitizeName(args[0]);
  let sourceRef = "current";
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--from") {
      sourceRef = args[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${args[i]}`);
  }

  const target = refPath("snapshot", name);
  if (await pathExists(target.base)) throw new Error(`Snapshot already exists: ${name}`);

  const source = await resolveRef(sourceRef);
  const recorded = await deriveRecordedBalances(source);
  const createdAt = new Date().toISOString();

  await copyStateTree(source.stateDir, target.stateDir);

  const metadata = {
    type: "snapshot",
    name,
    created_at: createdAt,
    source_ref: source.ref,
    source_state_dir: source.stateDir,
    state_dir: target.stateDir,
    recorded_balance_at: recorded.recorded_balance_at,
    recorded_balance_source: recorded.recorded_balance_source,
    recorded_balances: recorded.recorded_balances,
  };
  await writeMetadata(target.metadataPath, metadata);

  console.log(`Saved snapshot ${name}`);
  console.log(`  state: ${target.stateDir}`);
  console.log(`  balances: ${summarizeBalances(recorded.recorded_balances) || "none recorded"}`);
}

async function cmdBranch(args) {
  const sourceRef = args[0];
  const name = sanitizeName(args[1]);
  if (!sourceRef || !name) throw new Error("branch requires <source-ref> <branch-name>");

  const { source, recorded, entry } = await createBranchFromSource(sourceRef, name);

  console.log(`Created branch ${name} from ${source.ref}`);
  console.log(`  state: ${entry.metadata.state_dir}`);
  console.log(`  ports: kernel=${entry.metadata.ports.kernel} dashboard=${entry.metadata.ports.dashboard} spa=${entry.metadata.ports.spa} governor=${entry.metadata.ports.governor}`);
  console.log(`  balances: ${summarizeBalances(recorded.recorded_balances) || "none recorded"}`);
}

async function cmdMaterializeDr(args) {
  const sourceRef = args[0];
  const branchName = sanitizeName(args[1]);
  const payloadPath = args[2];
  if (!sourceRef || !branchName || !payloadPath) {
    throw new Error("materialize-dr requires <source-ref> <branch-name> <payload-path>");
  }

  let runner = null;
  for (let i = 3; i < args.length; i += 1) {
    if (args[i] === "--runner") {
      runner = args[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${args[i]}`);
  }

  const { payload, resolvedPath, runner: resolvedRunner } = await loadDrPayload(payloadPath, runner);
  const { entry } = await createBranchFromSource(sourceRef, branchName);
  const materialized = await materializeDrToBranch(entry, payload, { runner: resolvedRunner });

  entry.metadata.materialized_dr = {
    applied_at: new Date().toISOString(),
    source_payload_path: resolvedPath,
    runner: resolvedRunner,
    execution_id: materialized.executionId,
    reasoning_dir: materialized.reasoningDir,
    blocked: materialized.blocked,
    sanitized_inherited_job_id: materialized.sanitized_inherited_job_id,
    next_due_session: materialized.next_due_session,
    desire_count: materialized.desire_count,
  };
  await writeMetadata(entry.paths.metadataPath, entry.metadata);
  await persistBranchRuntimeState(entry.metadata);

  console.log(`Created branch ${branchName} from ${sourceRef} and materialized DR payload`);
  console.log(`  runner: ${resolvedRunner || "unknown"}`);
  console.log(`  state: ${entry.metadata.state_dir}`);
  console.log(`  reasoning: ${materialized.reasoningDir}`);
  console.log(`  desires: ${materialized.desire_count}`);
  console.log(`  next_due_session: ${materialized.next_due_session}`);
  if (materialized.blocked.length > 0) {
    console.log(`  blocked writes: ${materialized.blocked.length}`);
  }
}

async function loadLabHypothesis(hypothesisPath) {
  const resolved = resolve(hypothesisPath);
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  return {
    resolvedPath: resolved,
    payload: {
      hypothesis: parsed?.hypothesis || "lab-run",
      candidate_changes: Array.isArray(parsed?.candidate_changes) ? parsed.candidate_changes : [],
      validation: parsed?.validation || {},
      limits: parsed?.limits || {},
    },
  };
}

async function cmdLabRun(args) {
  const sourceRef = args[0];
  const hypothesisPath = args[1];
  if (!sourceRef || !hypothesisPath) {
    throw new Error("lab-run requires <source-ref> <hypothesis-path>");
  }

  const { payload, resolvedPath } = await loadLabHypothesis(hypothesisPath);
  const branchName = buildLabBranchName(resolvedPath);
  const { source, entry } = await createBranchFromSource(sourceRef, branchName);
  await prepareWorkspace(entry);

  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + ((payload.limits.max_wall_time_minutes || 30) * 60_000)).toISOString();
  await writeLabState(entry.paths, {
    status: "preparing",
    branch: entry.name,
    source_ref: source.ref,
    hypothesis_path: resolvedPath,
    started_at: startedAt,
    updated_at: startedAt,
    deadline_at: deadlineAt,
    consecutive_failures: 0,
    failure_reason: null,
  });

  let appliedChanges = [];
  let staticValidation = { passed: false, commands: [] };
  try {
    appliedChanges = await applyCandidateChanges(entry, payload.candidate_changes);
    await writeLabState(entry.paths, {
      status: "validating_static",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 0,
      failure_reason: null,
    });

    staticValidation = await runStaticValidation(entry, payload.validation, payload.limits);

    const report = {
      branch: entry.name,
      source_ref: source.ref,
      workspace_dir: entry.paths.workspaceDir,
      state_dir: entry.metadata.state_dir,
      hypothesis_path: resolvedPath,
      hypothesis: payload.hypothesis,
      candidate_changes_requested: payload.candidate_changes,
      candidate_changes_applied: appliedChanges,
      static_validation: staticValidation,
      promotion_recommendation: staticValidation.passed ? "needs_more_evidence" : "reject",
      generated_at: new Date().toISOString(),
    };
    await writeLabReport(entry.paths, report);

    const result = {
      branch: entry.name,
      source_ref: source.ref,
      hypothesis: payload.hypothesis,
      promotion_recommendation: staticValidation.passed ? "needs_more_evidence" : "reject",
      comparison_summary: {
        baseline: null,
        candidate_static_validation: staticValidation,
      },
      validated_changes: [],
      reasons_not_to_change: staticValidation.passed
        ? [
            "Stage A only runs static validation.",
            "No bounded continuation or baseline/candidate comparison has run yet.",
          ]
        : [
            "Static validation failed.",
          ],
      generated_at: new Date().toISOString(),
    };
    await writeLabResult(entry.paths, result);
    await writeLabState(entry.paths, {
      status: staticValidation.passed ? "judging" : "rejected",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 0,
      failure_reason: staticValidation.passed ? null : "static_validation_failed",
    });

    console.log(`Lab run complete for ${entry.name}`);
    console.log(`  branch: branch:${entry.name}`);
    console.log(`  workspace: ${entry.paths.workspaceDir}`);
    console.log(`  report: ${entry.paths.labReportPath}`);
    console.log(`  result: ${entry.paths.labResultPath}`);
    console.log(`  verdict: ${result.promotion_recommendation}`);
    return;
  } catch (error) {
    await writeLabState(entry.paths, {
      status: "failed",
      branch: entry.name,
      source_ref: source.ref,
      hypothesis_path: resolvedPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      deadline_at: deadlineAt,
      consecutive_failures: 1,
      failure_reason: error.message,
    });
    throw error;
  }
}

async function cmdPromote(args) {
  const name = sanitizeName(args[0]);
  if (!name) throw new Error("promote requires <branch-name>");
  const ref = await resolveRef(`branch:${name}`);
  if (!await pathExists(ref.paths.labResultPath)) {
    throw new Error(`No lab-result.json found for branch ${name}`);
  }
  const result = await readJson(ref.paths.labResultPath);
  if (result.promotion_recommendation !== "stageable") {
    throw new Error(`Branch ${name} is not stageable (verdict: ${result.promotion_recommendation})`);
  }
  throw new Error("Stage A lab promotion is intentionally disabled; use governor after later lab stages.");
}

async function cmdList() {
  const [snapshots, branches] = await Promise.all([
    listEntries("snapshot"),
    listEntries("branch"),
  ]);
  let activeUi = null;
  if (await pathExists(ACTIVE_UI_PATH)) {
    activeUi = await readJson(ACTIVE_UI_PATH);
  }

  console.log("Snapshots:");
  if (snapshots.length === 0) console.log("  (none)");
  for (const entry of snapshots) {
    console.log(`  ${entry.name}  ${entry.metadata.created_at}  from ${entry.metadata.source_ref}`);
  }

  console.log("Branches:");
  if (branches.length === 0) console.log("  (none)");
  for (const entry of branches) {
    const ports = entry.metadata.ports || {};
    const activeSuffix = activeUi?.branch === entry.name ? "  active-ui" : "";
    console.log(
      `  ${entry.name}  ${entry.metadata.created_at}  from ${entry.metadata.source_ref}  ` +
      `ports k:${ports.kernel} d:${ports.dashboard} s:${ports.spa}${activeSuffix}`,
    );
  }
  if (activeUi) {
    console.log(`Active UI: http://localhost:${ACTIVE_UI_PORT}/patron/ -> branch:${activeUi.branch} (spa ${activeUi.spa_port})`);
    console.log(`Active kernel: http://localhost:${ACTIVE_KERNEL_PORT}/ -> branch:${activeUi.branch} (kernel ${activeUi.kernel_port})`);
  } else {
    console.log(`Active UI: (none)  fixed port ${ACTIVE_UI_PORT}`);
    console.log(`Active kernel: (none)  fixed port ${ACTIVE_KERNEL_PORT}`);
  }
}

async function cmdShow(args) {
  const ref = await resolveRef(args[0]);
  if (ref.type === "current") {
    console.log(JSON.stringify({
      ref: "current",
      state_dir: ref.stateDir,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(ref.metadata, null, 2));
}

async function cmdStart(args) {
  const name = sanitizeName(args[0]);
  if (!name) throw new Error("start requires <branch-name>");
  const ref = await resolveRef(`branch:${name}`);
  const env = {
    ...process.env,
    ...buildStartEnv(ref.metadata),
  };
  const passthrough = args.slice(1);

  console.log(`Starting branch ${name}`);
  console.log(`  state: ${ref.metadata.state_dir}`);
  console.log(`  dashboard: http://localhost:${ref.metadata.ports.dashboard}/`);

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bash", ["scripts/start.sh", ...passthrough], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`start.sh exited with code ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function cmdActivate(args) {
  const name = sanitizeName(args[0]);
  if (!name) throw new Error("activate requires <branch-name>");
  const ref = await resolveRef(`branch:${name}`);
  const activeUi = {
    branch: name,
    activated_at: new Date().toISOString(),
    ui_port: ACTIVE_UI_PORT,
    spa_port: ref.metadata.ports.spa,
    dashboard_port: ref.metadata.ports.dashboard,
    kernel_port: ref.metadata.ports.kernel,
  };
  await writeFile(ACTIVE_UI_PATH, JSON.stringify(activeUi, null, 2), "utf8");
  await ensureGatewayRunning("ui", ACTIVE_UI_PORT);
  await ensureGatewayRunning("kernel", ACTIVE_KERNEL_PORT);
  const callbackUpdated = await setBranchCallbackUrl(ref.metadata.state_dir);

  console.log(`Activated branch ${name} on stable UI port ${ACTIVE_UI_PORT}`);
  console.log(`  ui: http://localhost:${ACTIVE_UI_PORT}/patron/`);
  console.log(`  target spa: http://localhost:${ref.metadata.ports.spa}/patron/`);
  console.log(`  kernel: http://localhost:${ACTIVE_KERNEL_PORT}/`);
  console.log(`  target kernel: http://localhost:${ref.metadata.ports.kernel}/`);
  if (callbackUpdated) {
    console.log(`  callback_url: ${PUBLIC_CALLBACK_URL}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  await ensureLabDirs();
  const [command, ...args] = argv;
  switch (command) {
    case "save":
      if (args.length === 0) throw new Error("save requires <snapshot-name>");
      await cmdSave(args);
      break;
    case "branch":
      await cmdBranch(args);
      break;
    case "materialize-dr":
      await cmdMaterializeDr(args);
      break;
    case "lab-run":
      await cmdLabRun(args);
      break;
    case "list":
      await cmdList();
      break;
    case "show":
      if (args.length === 0) throw new Error("show requires <ref>");
      await cmdShow(args);
      break;
    case "activate":
      await cmdActivate(args);
      break;
    case "promote":
      await cmdPromote(args);
      break;
    case "start":
      await cmdStart(args);
      break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

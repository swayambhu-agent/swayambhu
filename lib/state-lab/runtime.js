import { execFileSync } from "child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { createHash } from "crypto";

import { Kernel } from "../../kernel.js";
import { filePathToKey } from "../../governor/builder.js";
import {
  normalizeStaticChecks,
  retargetStaticCommandToWorkspace,
} from "./validation.js";
import {
  applyWorkspaceCandidateChange,
  materializeStateLabWorkspace,
  resolveLabTargetRelativePath,
  resolveLabWorkspacePath,
} from "./workspace.js";
import * as llm_balance from "../../providers/llm_balance.js";
import * as wallet_balance from "../../providers/wallet_balance.js";
import { DEFAULT_LOCAL_STATE_DIR, dispose, getKV, root as REPO_ROOT } from "../../scripts/shared.mjs";

const DEFAULT_STATE_LAB_DIR = "/home/swami/swayambhu/state-lab";
export const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || DEFAULT_STATE_LAB_DIR;
export const ACTIVE_UI_PORT = Number(process.env.SWAYAMBHU_ACTIVE_UI_PORT || 9071);

const SNAPSHOTS_DIR = join(STATE_LAB_DIR, "snapshots");
const BRANCHES_DIR = join(STATE_LAB_DIR, "branches");
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

function absoluteStateDir(input = DEFAULT_LOCAL_STATE_DIR) {
  return resolve(input);
}

export function sanitizeName(name) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid name "${name}" (use letters, numbers, ., _, -)`);
  }
  return name;
}

export function refPath(type, name) {
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

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
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

export async function resolveRef(ref, options = {}) {
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
    SWAYAMBHU_RUNTIME_WORKSPACE: metadata.runtime_workspace_dir || join(dirname(metadata.state_dir), "runtime-workspace"),
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

export async function writeMetadata(path, metadata) {
  await writeFile(path, JSON.stringify(metadata, null, 2), "utf8");
}

async function copyStateTree(sourceDir, destDir) {
  if (!await pathExists(sourceDir)) {
    throw new Error(`State dir not found: ${sourceDir}`);
  }
  await mkdir(dirname(destDir), { recursive: true });
  await cp(sourceDir, destDir, { recursive: true });
}

export async function prepareWorkspace(entry) {
  await materializeStateLabWorkspace({
    workspaceDir: entry.paths.workspaceDir,
    repoRoot: REPO_ROOT,
    stateDir: entry.metadata.state_dir,
  });
}

async function applyKvCandidateChange(stateDir, change) {
  const kv = await getKV({ stateDir });
  try {
    const putValue = "value" in change
      ? change.value
      : ("value_json" in change ? JSON.parse(change.value_json) : undefined);
    if (change.type === "kv_put") {
      await kv.put(change.key, JSON.stringify(putValue), { metadata: { format: "json", state_lab: true } });
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

export async function applyCandidateChanges(entry, candidateChanges = []) {
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

export async function syncWorkspaceCodeTargetsToBranchKv(entry, candidateChanges = []) {
  const codeChanges = candidateChanges.filter((change) => change?.type === "code_patch");
  if (codeChanges.length === 0) return [];

  const kv = await getKV({ stateDir: entry.metadata.state_dir });
  const syncedTargets = [];
  try {
    for (const change of codeChanges) {
      const relativePath = resolveLabTargetRelativePath(change);
      const target = change.target || filePathToKey(relativePath);
      if (!target) {
        throw new Error(`Cannot map lab code change to live code key: ${relativePath}`);
      }
      const targetPath = resolveLabWorkspacePath(entry.paths.workspaceDir, change);
      const code = await readFile(targetPath, "utf8");
      await kv.put(target, code, {
        metadata: { format: "text", state_lab: true },
      });
      syncedTargets.push(target);
    }
  } finally {
    await dispose();
  }
  return syncedTargets;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeProcessOutput(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line
      .replace(/\b\d+ms\b/g, "<ms>")
      .replace(/Start at\s+.+$/, "Start at <time>")
      .replace(/Duration\s+\d+ms.*$/, "Duration <time>")
      .replace(/(\s+)\d+ms$/g, "$1<ms>"))
    .join("\n");
}

export async function buildValidatedChanges(entry, candidateChanges = []) {
  const kv_operations = [];
  const code_stage_requests = [];

  for (const change of candidateChanges) {
    if (!change?.type) continue;

    if (change.type === "kv_put") {
      kv_operations.push({
        op: "put",
        key: change.key,
        value: "value" in change ? change.value : JSON.parse(change.value_json),
        ...(change.deliberation ? { deliberation: change.deliberation } : {}),
      });
      continue;
    }

    if (change.type === "kv_delete") {
      kv_operations.push({ op: "delete", key: change.key });
      continue;
    }

    if (change.type === "kv_patch") {
      kv_operations.push({
        op: "patch",
        key: change.key,
        old_string: change.old_string,
        new_string: change.new_string,
        ...(change.deliberation ? { deliberation: change.deliberation } : {}),
      });
      continue;
    }

    if (change.type === "code_patch") {
      const relativePath = resolveLabTargetRelativePath(change);
      const target = change.target || filePathToKey(relativePath);
      if (!target) {
        throw new Error(`Cannot map lab code change to live code key: ${relativePath}`);
      }
      const targetPath = resolveLabWorkspacePath(entry.paths.workspaceDir, change);
      const code = await readFile(targetPath, "utf8");
      code_stage_requests.push({ target, code });
      continue;
    }

    throw new Error(`Unsupported candidate change type: ${change.type}`);
  }

  return {
    kv_operations,
    code_stage_requests,
    deploy: code_stage_requests.length > 0,
  };
}

function normalizeStaticCheckExpectation(value, fallback = "pass") {
  if (value === true) return "pass";
  if (value === false) return "fail";
  if (value === "pass" || value === "fail" || value === "skip") return value;
  return fallback;
}

export async function runStaticValidation(entry, validation = {}, limits = {}, surface = "candidate") {
  const checks = normalizeStaticChecks(validation);
  const timeoutMs = Math.max(60_000, (limits.max_wall_time_minutes || 30) * 60_000);
  const env = {
    ...process.env,
    ...buildStartEnv(entry.metadata),
    SWAYAMBHU_LAB_PROFILE: "static",
  };
  const results = [];
  let passed = true;

  for (const check of checks) {
    const command = retargetStaticCommandToWorkspace(check.command, entry.paths.workspaceDir);
    const expectedOutcome = normalizeStaticCheckExpectation(check?.expect?.[surface], "pass");
    if (expectedOutcome === "skip") {
      results.push({
        command,
        label: check.label,
        source: check.source,
        expected_outcome: expectedOutcome,
        actual_outcome: "skip",
        matched: true,
        skipped: true,
      });
      continue;
    }

    try {
      const output = execFileSync("bash", ["-lc", command], {
        cwd: entry.paths.workspaceDir,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const matched = expectedOutcome === "pass";
      passed = passed && matched;
      results.push({
        command,
        label: check.label,
        source: check.source,
        ok: matched,
        expected_outcome: expectedOutcome,
        actual_outcome: "pass",
        matched,
        output_hash: sha256Text(output),
        output_tail: output.slice(-4000),
      });
    } catch (error) {
      const stdout = String(error.stdout || "");
      const stderr = String(error.stderr || "");
      const failureSignature = [
        normalizeProcessOutput(stdout),
        normalizeProcessOutput(stderr),
      ].join("\n---stderr---\n");
      const matched = expectedOutcome === "fail";
      passed = passed && matched;
      results.push({
        command,
        label: check.label,
        source: check.source,
        ok: matched,
        expected_outcome: expectedOutcome,
        actual_outcome: "fail",
        matched,
        exit_code: Number.isInteger(error.status) ? error.status : null,
        failure_signature_hash: sha256Text(failureSignature),
        stdout_hash: sha256Text(stdout),
        stderr_hash: sha256Text(stderr),
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-4000),
      });
    }
  }

  return { passed, commands: results };
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

export async function createBranchFromSource(sourceRef, name) {
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
    runtime_workspace_dir: join(target.base, "runtime-workspace"),
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

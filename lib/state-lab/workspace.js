import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "path";

import { keyToFilePath } from "../../governor/builder.js";
import { dispose, getKV, root as REPO_ROOT } from "../../scripts/shared.mjs";

const LAB_CODE_TARGETS = {
  "hook:session:code": "userspace.js",
  "hook:reflect:code": "reflect.js",
  "kernel:source:hook-communication.js": "hook-communication.js",
  "kernel:source:kernel.js": "kernel.js",
  "kernel:source:authority-policy.js": "authority-policy.js",
};

function sanitizeName(name) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid name "${name}" (use letters, numbers, ., _, -)`);
  }
  return name;
}

function slugifyLabName(input) {
  const slug = String(input || "lab")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return slug || "lab";
}

function promptKeyToWorkspacePath(key) {
  if (!key.startsWith("prompt:")) return null;
  const name = key.slice("prompt:".length);
  return name ? `prompts/${name}.md` : null;
}

function resolveWorkspaceBoundedPath(workspaceDir, relativePath, errorPrefix = "Path escapes workspace") {
  const resolved = resolve(workspaceDir, relativePath);
  const normalizedWorkspace = `${resolve(workspaceDir)}/`;
  if (!resolved.startsWith(normalizedWorkspace) && resolved !== resolve(workspaceDir)) {
    throw new Error(`${errorPrefix}: ${relativePath}`);
  }
  return resolved;
}

function resolvePromptOverlayTargetPath(workspaceDir, relativePath) {
  const resolved = resolveWorkspaceBoundedPath(workspaceDir, relativePath, "Overlay path escapes workspace");
  const promptsRoot = resolve(workspaceDir, "prompts");
  const normalizedPromptsRoot = `${promptsRoot}/`;
  if (!resolved.startsWith(normalizedPromptsRoot) && resolved !== promptsRoot) {
    throw new Error(`Overlay prompt path escapes prompts dir: ${relativePath}`);
  }
  return resolved;
}

async function listKeysWithPrefix(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys.map((entry) => entry.name));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}

async function fetchDashboardJson(dashboardPort, path) {
  const response = await fetch(`http://127.0.0.1:${dashboardPort}${path}`, {
    headers: { "X-Patron-Key": process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test" },
  });
  if (!response.ok) throw new Error(`dashboard ${path} failed: ${response.status}`);
  return response.json();
}

async function fetchDashboardTextKey(dashboardPort, key) {
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/kv/${encodeURIComponent(key)}`, {
    headers: { "X-Patron-Key": process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`dashboard key ${key} failed: ${response.status}`);
  const payload = await response.json();
  return typeof payload.value === "string" ? payload.value : null;
}

async function resolveSourceMapOverlayKeys(sourceMap, { listByPrefix }) {
  const overlayKeys = new Set();
  for (const value of Object.values(sourceMap || {})) {
    if (typeof value !== "string") continue;
    if (!value.includes("*")) {
      overlayKeys.add(value);
      continue;
    }
    if (value === "tool:*:code") {
      const keys = await listByPrefix("tool:");
      for (const key of keys) if (keyToFilePath(key)) overlayKeys.add(key);
      continue;
    }
    if (value === "provider:*:code") {
      const keys = await listByPrefix("provider:");
      for (const key of keys) if (keyToFilePath(key)) overlayKeys.add(key);
      continue;
    }
    if (value === "channel:*:code") {
      const keys = await listByPrefix("channel:");
      for (const key of keys) if (keyToFilePath(key)) overlayKeys.add(key);
      continue;
    }
  }
  return [...overlayKeys];
}

export function resolveLabTargetRelativePath(change) {
  const target = change.path || change.target;
  if (!target || typeof target !== "string") {
    throw new Error("Candidate code change requires path or target");
  }
  if (LAB_CODE_TARGETS[target]) return LAB_CODE_TARGETS[target];
  return target;
}

export function buildLabBranchName(hypothesisPath, now = new Date()) {
  const base = basename(hypothesisPath, extname(hypothesisPath));
  const date = now.toISOString().replace(/[:.]/g, "-");
  return sanitizeName(`lab-${slugifyLabName(base)}-${date}`);
}

export function shouldCopyWorkspacePath(srcPath) {
  const rel = relative(REPO_ROOT, srcPath);
  if (!rel || rel === "") return true;
  const segments = rel.split("/").filter(Boolean);
  return !segments.some((segment) => [
    ".git",
    "node_modules",
    "local-state",
    ".wrangler",
    "coverage",
  ].includes(segment));
}

export async function overlayWorkspaceFromSourceState({ workspaceDir, stateDir, dashboardPort = null }) {
  const kv = dashboardPort ? null : await getKV({ stateDir });
  try {
    const sourceMap = dashboardPort
      ? (await fetchDashboardJson(dashboardPort, `/kv/${encodeURIComponent("kernel:source_map")}`)).value || {}
      : (await kv.get("kernel:source_map", "json")) || {};
    const listByPrefix = dashboardPort
      ? async (prefix) => {
          const payload = await fetchDashboardJson(dashboardPort, `/kv?prefix=${encodeURIComponent(prefix)}`);
          return (payload.keys || []).map((entry) => entry.key);
        }
      : async (prefix) => listKeysWithPrefix(kv, prefix);
    const getText = dashboardPort
      ? async (key) => fetchDashboardTextKey(dashboardPort, key)
      : async (key) => kv.get(key, "text");

    const directCodeKeys = await resolveSourceMapOverlayKeys(sourceMap, { listByPrefix });
    const overlayKeys = [
      ...new Set([
        ...directCodeKeys,
        "prompt:plan",
        "prompt:act",
        "prompt:review",
        "prompt:reflect",
        "prompt:deep_reflect",
      ]),
    ];

    for (const key of overlayKeys) {
      const relativePath = keyToFilePath(key) || promptKeyToWorkspacePath(key);
      if (!relativePath) continue;
      const value = await getText(key);
      if (typeof value !== "string") continue;
      const targetPath = key.startsWith("prompt:")
        ? resolvePromptOverlayTargetPath(workspaceDir, relativePath)
        : resolveWorkspaceBoundedPath(workspaceDir, relativePath, "Overlay path escapes workspace");
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, value, "utf8");
    }
  } finally {
    await dispose();
  }
}

export function resolveLabWorkspacePath(workspaceDir, change) {
  const relativePath = resolveLabTargetRelativePath(change);
  return resolveWorkspaceBoundedPath(workspaceDir, relativePath, "Candidate change escapes workspace");
}

export async function applyWorkspaceCandidateChange(workspaceDir, change) {
  const targetPath = resolveLabWorkspacePath(workspaceDir, change);
  await mkdir(dirname(targetPath), { recursive: true });

  if (typeof change.code === "string") {
    await writeFile(targetPath, change.code, "utf8");
    return { kind: "workspace_write", targetPath };
  }

  if (typeof change.old_string === "string" && typeof change.new_string === "string") {
    if (!change.old_string) {
      throw new Error(`old_string must be non-empty for ${relative(workspaceDir, targetPath)}`);
    }
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

export async function loadLabHypothesis(hypothesisPath) {
  const resolved = resolve(hypothesisPath);
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  return {
    resolvedPath: resolved,
    payload: {
      review_note_key: parsed?.review_note_key || null,
      hypothesis: parsed?.hypothesis || "lab-run",
      candidate_changes: Array.isArray(parsed?.candidate_changes) ? parsed.candidate_changes : [],
      validation: parsed?.validation || {},
      limits: parsed?.limits || {},
    },
  };
}

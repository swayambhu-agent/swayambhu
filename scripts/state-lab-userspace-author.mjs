#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { parseJobOutput } from "../lib/parse-job-output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const AUTHORS_DIR = join(STATE_LAB_DIR, "authors");
const DEFAULT_RUNNER = process.env.SWAYAMBHU_USERSPACE_AUTHOR_RUNNER || "codex";
const DEFAULT_TIMEOUT_MS = Number(process.env.SWAYAMBHU_USERSPACE_AUTHOR_TIMEOUT_MS || 180000);
const DEFAULT_CODEX_PROFILE = process.env.SWAYAMBHU_USERSPACE_AUTHOR_CODEX_PROFILE || null;
const DEFAULT_CLAUDE_MODEL = process.env.SWAYAMBHU_USERSPACE_AUTHOR_CLAUDE_MODEL || "opus";
const DEFAULT_CODEX_MODEL = process.env.SWAYAMBHU_USERSPACE_AUTHOR_CODEX_MODEL || null;
const DEFAULT_GEMINI_MODEL = process.env.SWAYAMBHU_USERSPACE_AUTHOR_GEMINI_MODEL || "gemini-2.5-flash";

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  const slug = String(input || "userspace-author")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "userspace-author";
}

function loadDotEnv() {
  const envPath = process.env.SWAYAMBHU_ENV_FILE || join(ROOT, ".env");
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

function parseArgs(argv) {
  const args = {
    reviewResultPath: null,
    workspaceRoot: null,
    label: null,
    runner: DEFAULT_RUNNER,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    codexProfile: DEFAULT_CODEX_PROFILE,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    codexModel: DEFAULT_CODEX_MODEL,
    geminiModel: DEFAULT_GEMINI_MODEL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--review-result") {
      args.reviewResultPath = argv[++i];
    } else if (arg === "--workspace-root") {
      args.workspaceRoot = argv[++i];
    } else if (arg === "--label") {
      args.label = argv[++i];
    } else if (arg === "--runner") {
      args.runner = argv[++i];
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--codex-profile") {
      args.codexProfile = argv[++i];
    } else if (arg === "--claude-model") {
      args.claudeModel = argv[++i];
    } else if (arg === "--codex-model") {
      args.codexModel = argv[++i];
    } else if (arg === "--gemini-model") {
      args.geminiModel = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log("Usage:\n  node scripts/state-lab-userspace-author.mjs --review-result <userspace-review-result.json> [--workspace-root <path>] [--label <name>] [--runner codex|claude|gemini]");
}

function buildPrompt(basePrompt, reviewResultPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    "Read that JSON file first, then inspect only the target files needed to materialize the smallest candidate change set.",
    "Respond with JSON only.",
  ].join("\n");
}

export function normalizePatchLikeChange(change) {
  if (!change || typeof change !== "object") return [];
  const base = { ...change };
  delete base.patches;
  if (typeof base.search === "string" && typeof base.old_string !== "string") {
    base.old_string = base.search;
  }
  if (typeof base.replace === "string" && typeof base.new_string !== "string") {
    base.new_string = base.replace;
  }
  delete base.search;
  delete base.replace;

  const patchList = Array.isArray(change.patches) ? change.patches : null;
  if (!patchList || patchList.length === 0) {
    return [base];
  }

  return patchList.map((patch) => {
    const normalized = { ...base };
    if (typeof patch?.search === "string" && typeof normalized.old_string !== "string") {
      normalized.old_string = patch.search;
    } else if (typeof patch?.old_string === "string" && typeof normalized.old_string !== "string") {
      normalized.old_string = patch.old_string;
    }
    if (typeof patch?.replace === "string" && typeof normalized.new_string !== "string") {
      normalized.new_string = patch.replace;
    } else if (typeof patch?.new_string === "string" && typeof normalized.new_string !== "string") {
      normalized.new_string = patch.new_string;
    }
    return normalized;
  });
}

export function normalizeCandidateChanges(candidateChanges) {
  if (!Array.isArray(candidateChanges)) return null;
  const normalized = [];
  for (const rawChange of candidateChanges) {
    if (!rawChange || typeof rawChange !== "object" || typeof rawChange.type !== "string") return null;

    if (rawChange.type === "kv_patch" || rawChange.type === "code_patch") {
      const expanded = normalizePatchLikeChange(rawChange);
      for (const change of expanded) {
        if (change.type === "kv_patch" && typeof change.key !== "string") return null;
        if (change.type === "code_patch" && typeof change.target !== "string" && typeof change.file !== "string") {
          return null;
        }
        normalized.push(change);
      }
      continue;
    }

    normalized.push(rawChange);
  }
  return normalized;
}

export function normalizeAuthorPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.hypothesis !== "string") return null;
  const candidateChanges = normalizeCandidateChanges(payload.candidate_changes);
  if (!candidateChanges) return null;
  if (!payload.validation || typeof payload.validation !== "object") return null;
  if (!payload.limits || typeof payload.limits !== "object") return null;
  return {
    ...payload,
    candidate_changes: candidateChanges,
  };
}

function runCommand(command, args, { cwd, stdinText, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill("SIGKILL");
      finished = true;
      resolvePromise({ code: null, stdout, stderr, timed_out: true, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      resolvePromise({ code: null, stdout, stderr, timed_out: false, error: error.message });
    });
    child.on("close", (code) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      resolvePromise({ code, stdout, stderr, timed_out: false, error: code === 0 ? null : `exit ${code}` });
    });

    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

async function runCodex({ prompt, runDir, timeoutMs, model, profile, cwd }) {
  const stdoutPath = join(runDir, "codex.stdout.log");
  const stderrPath = join(runDir, "codex.stderr.log");
  const lastMessagePath = join(runDir, "codex.last-message.json");
  const resolvedProfile = profile || DEFAULT_CODEX_PROFILE;
  const args = ["exec", "-"];
  if (resolvedProfile) args.push("--profile", resolvedProfile);
  args.push(
    "-C", cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message", lastMessagePath,
    "--color", "never",
  );
  if (model) args.push("--model", model);

  const result = await runCommand("codex", args, { cwd, stdinText: prompt, timeoutMs });
  await writeFile(stdoutPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  let rawLastMessage = "";
  try {
    rawLastMessage = await readFile(lastMessagePath, "utf8");
  } catch {
    rawLastMessage = "";
  }
  const parsed = parseJobOutput(rawLastMessage || "");
  return {
    runner: "codex",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!normalizeAuthorPayload(parsed.payload),
    payload: normalizeAuthorPayload(parsed.payload),
    meta: parsed.meta,
    raw_path: lastMessagePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

async function runClaude({ prompt, runDir, timeoutMs, model, cwd }) {
  const rawPath = join(runDir, "claude.raw.json");
  const stderrPath = join(runDir, "claude.stderr.log");
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);
  const result = await runCommand("claude", args, { cwd, stdinText: prompt, timeoutMs });
  await writeFile(rawPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");
  const parsed = parseJobOutput(result.stdout || "");
  return {
    runner: "claude",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!normalizeAuthorPayload(parsed.payload),
    payload: normalizeAuthorPayload(parsed.payload),
    meta: parsed.meta,
    raw_path: rawPath,
    stdout_path: null,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

async function runGemini({ prompt, runDir, timeoutMs, model, cwd }) {
  const stdoutPath = join(runDir, "gemini.stdout.json");
  const stderrPath = join(runDir, "gemini.stderr.log");
  const args = ["--prompt", prompt, "--output-format", "json", "--approval-mode", "yolo"];
  if (model) args.push("--model", model);
  const result = await runCommand("gemini", args, { cwd, timeoutMs });
  await writeFile(stdoutPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  let envelope = null;
  let payload = null;
  try {
    envelope = JSON.parse(result.stdout || "");
    payload = JSON.parse(envelope?.response || "");
  } catch {
    envelope = null;
    payload = null;
  }

  return {
    runner: "gemini",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!normalizeAuthorPayload(payload),
    payload: normalizeAuthorPayload(payload),
    meta: envelope?.stats ? { stats: envelope.stats, session_id: envelope.session_id || null } : null,
    raw_path: stdoutPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  if (!args.reviewResultPath) {
    usage();
    throw new Error("Provide --review-result");
  }

  const resolvedReviewResultPath = resolve(args.reviewResultPath);
  const resolvedWorkspaceRoot = resolve(args.workspaceRoot || ROOT);
  const reviewArtifact = JSON.parse(await readFile(resolvedReviewResultPath, "utf8"));
  if (!reviewArtifact?.payload) {
    throw new Error(`Review result has no payload: ${resolvedReviewResultPath}`);
  }

  const labelSeed = args.label || basename(resolvedReviewResultPath, extname(resolvedReviewResultPath));
  const runDir = join(AUTHORS_DIR, `${nowTimestamp()}-${slugify(labelSeed)}`);
  await mkdir(runDir, { recursive: true });

  const basePrompt = await readFile(join(ROOT, "prompts", "userspace_lab_author.md"), "utf8");
  const prompt = buildPrompt(basePrompt, resolvedReviewResultPath);
  await writeFile(join(runDir, "prompt.userspace-lab-author.md"), prompt, "utf8");

  const startedAt = new Date().toISOString();
  let result;
  if (args.runner === "claude") {
    result = await runClaude({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.claudeModel, cwd: resolvedWorkspaceRoot });
  } else if (args.runner === "gemini") {
    result = await runGemini({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.geminiModel, cwd: resolvedWorkspaceRoot });
  } else {
    result = await runCodex({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.codexModel, profile: args.codexProfile, cwd: resolvedWorkspaceRoot });
  }

  const artifact = {
    review_role: "userspace_lab_author",
    review_result_path: resolvedReviewResultPath,
    workspace_root: resolvedWorkspaceRoot,
    runner: args.runner,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    parse_ok: result.parse_ok,
    payload: result.payload,
    meta: result.meta || null,
    raw_path: result.raw_path,
    stdout_path: result.stdout_path || null,
    stderr_path: result.stderr_path || null,
    timed_out: result.timed_out,
    exit_code: result.exit_code,
    error: result.error || null,
  };
  const artifactPath = join(runDir, "userspace-author-result.json");
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Userspace author complete: ${runDir}`);
  console.log(`  runner: ${args.runner}`);
  console.log(`  parse_ok: ${result.parse_ok}`);
  console.log(`  result: ${artifactPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-author: ${error.message}`);
    process.exit(1);
  });
}

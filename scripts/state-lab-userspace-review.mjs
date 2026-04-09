#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { cp, mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { parseJobOutput } from "../lib/parse-job-output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const REVIEWS_DIR = join(STATE_LAB_DIR, "reviews");
const DEFAULT_RUNNER = process.env.SWAYAMBHU_USERSPACE_REVIEW_RUNNER || "codex";
const DEFAULT_TIMEOUT_MS = Number(process.env.SWAYAMBHU_USERSPACE_REVIEW_TIMEOUT_MS || 180000);
const DEFAULT_CODEX_PROFILE = process.env.SWAYAMBHU_USERSPACE_REVIEW_CODEX_PROFILE || "high";
const DEFAULT_CLAUDE_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_CLAUDE_MODEL || "opus";
const DEFAULT_CODEX_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_CODEX_MODEL || null;
const DEFAULT_GEMINI_MODEL = process.env.SWAYAMBHU_USERSPACE_REVIEW_GEMINI_MODEL || "gemini-2.5-flash";
const REVIEW_SCHEMA_PATH = join(ROOT, "schemas", "userspace-review-result.schema.json");

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  const slug = String(input || "userspace-review")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "userspace-review";
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
    specPath: null,
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
    if (arg === "--spec") {
      args.specPath = argv[++i];
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
  console.log([
    "Usage:",
    "  node scripts/state-lab-userspace-review.mjs --spec <spec.json> [--label <name>] [--runner codex|claude|gemini]",
  ].join("\n"));
}

export function normalizeSpec(raw, specPath) {
  const files = Array.isArray(raw?.files) ? raw.files : [];
  if (!raw?.question || typeof raw.question !== "string") {
    throw new Error(`Review spec ${specPath} missing string question`);
  }
  if (files.length === 0) {
    throw new Error(`Review spec ${specPath} must include at least one file`);
  }
  return {
    question: raw.question,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : [],
    files: files.map((entry) => {
      if (typeof entry === "string") return { path: entry, kind: "artifact" };
      if (!entry?.path) throw new Error(`Invalid file entry in ${specPath}`);
      return {
        path: String(entry.path),
        kind: entry.kind ? String(entry.kind) : "artifact",
      };
    }),
  };
}

function resolveInputPath(inputPath, specDir) {
  if (isAbsolute(inputPath)) return inputPath;
  const repoResolved = resolve(ROOT, inputPath);
  if (existsSync(repoResolved)) return repoResolved;
  return resolve(specDir, inputPath);
}

export function targetRelativePathForSource(sourcePath, index) {
  const repoRoot = resolve(ROOT);
  const resolved = resolve(sourcePath);
  if (resolved.startsWith(`${repoRoot}/`)) {
    return join("repo", relative(repoRoot, resolved));
  }
  return join("external", `${String(index).padStart(2, "0")}-${basename(resolved)}`);
}

async function copyContextFiles(runDir, spec, specDir) {
  const contextDir = join(runDir, "context");
  const filesDir = join(contextDir, "files");
  await mkdir(filesDir, { recursive: true });

  const manifest = [];
  for (let index = 0; index < spec.files.length; index += 1) {
    const entry = spec.files[index];
    const sourcePath = resolveInputPath(entry.path, specDir);
    const targetRel = targetRelativePathForSource(sourcePath, index);
    const targetPath = join(filesDir, targetRel);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
    manifest.push({
      source_path: sourcePath,
      relative_path: join("context", "files", targetRel),
      kind: entry.kind,
    });
  }

  return { contextDir, manifest };
}

export function buildOverview(spec, manifest) {
  return [
    "# Userspace Review Overview",
    "",
    `## Question`,
    spec.question,
    "",
    ...(spec.notes.length
      ? ["## Notes", ...spec.notes.map((note) => `- ${note}`), ""]
      : []),
    "## Included Evidence",
    ...manifest.map((entry) => `- ${entry.kind}: ${entry.relative_path} (from ${entry.source_path})`),
    "",
    "Read the behaviorally direct evidence first, then inspect code and prompt surfaces as needed.",
  ].join("\n");
}

export function buildPrompt(basePrompt) {
  return [
    "You are running inside the Swayambhu proto-DR-2 userspace review harness.",
    "The current working directory is an isolated review bundle.",
    `Start with ${join("context", "overview.md")} and ${join("context", "manifest.json")}.`,
    "All evidence files are copied under context/files/.",
    "Do not modify files. Do not browse the web. Respond with JSON only.",
    "",
    basePrompt,
  ].join("\n\n");
}

function runCommand(command, args, { cwd, stdinText = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timed_out: timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, error: error.message, timed_out: timedOut });
    });
  });
}

async function runClaude({ prompt, runDir, timeoutMs, model }) {
  const promptPath = join(runDir, "prompt.userspace-review.md");
  const rawPath = join(runDir, "claude.raw.json");
  const stderrPath = join(runDir, "claude.stderr.log");
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];
  if (model) args.push("--model", model);

  const result = await runCommand("claude", args, { cwd: runDir, timeoutMs });
  await writeFile(rawPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");
  const parsed = parseJobOutput(result.stdout || "");
  return {
    runner: "claude",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!parsed.payload,
    payload: parsed.payload,
    meta: parsed.meta,
    raw_path: rawPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

export function extractJsonFromString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }
  return null;
}

async function runCodex({ prompt, runDir, timeoutMs, model, profile }) {
  const promptPath = join(runDir, "prompt.userspace-review.md");
  const stdoutPath = join(runDir, "codex.stdout.log");
  const stderrPath = join(runDir, "codex.stderr.log");
  const lastMessagePath = join(runDir, "codex.last-message.json");
  const args = [
    "exec",
    "-",
    "-C", runDir,
    "--profile", profile || DEFAULT_CODEX_PROFILE,
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-schema", REVIEW_SCHEMA_PATH,
    "--output-last-message", lastMessagePath,
    "--color", "never",
  ];
  if (model) args.push("--model", model);

  const result = await runCommand("codex", args, { cwd: ROOT, stdinText: prompt, timeoutMs });
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
    parse_ok: !!parsed.payload,
    payload: parsed.payload,
    meta: parsed.meta,
    raw_path: lastMessagePath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    error: result.error || null,
  };
}

async function runGemini({ prompt, runDir, timeoutMs, model }) {
  const stdoutPath = join(runDir, "gemini.stdout.json");
  const stderrPath = join(runDir, "gemini.stderr.log");
  const args = [
    "--prompt", prompt,
    "--output-format", "json",
    "--approval-mode", "yolo",
  ];
  if (model) args.push("--model", model);

  const result = await runCommand("gemini", args, { cwd: runDir, timeoutMs });
  await writeFile(stdoutPath, result.stdout || "", "utf8");
  await writeFile(stderrPath, result.stderr || "", "utf8");

  let envelope = null;
  let payload = null;
  try {
    envelope = JSON.parse(result.stdout || "");
    payload = extractJsonFromString(envelope?.response || "");
  } catch {
    envelope = null;
    payload = null;
  }

  return {
    runner: "gemini",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!payload,
    payload,
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
  if (!args.specPath) {
    usage();
    throw new Error("--spec is required");
  }

  const resolvedSpecPath = resolve(args.specPath);
  const rawSpec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
  const spec = normalizeSpec(rawSpec, resolvedSpecPath);
  const label = slugify(args.label || basename(resolvedSpecPath, extname(resolvedSpecPath)));
  const runDir = join(REVIEWS_DIR, `${nowTimestamp()}-${label}`);
  const specDir = dirname(resolvedSpecPath);

  await mkdir(runDir, { recursive: true });
  const { contextDir, manifest } = await copyContextFiles(runDir, spec, specDir);
  await writeFile(join(contextDir, "manifest.json"), JSON.stringify({
    question: spec.question,
    notes: spec.notes,
    files: manifest,
  }, null, 2), "utf8");
  await writeFile(join(contextDir, "overview.md"), buildOverview(spec, manifest), "utf8");

  const basePrompt = await readFile(join(ROOT, "prompts/userspace_review.md"), "utf8");
  const prompt = buildPrompt(basePrompt);
  await writeFile(join(runDir, "prompt.userspace-review.md"), prompt, "utf8");

  const startedAt = new Date().toISOString();
  let result;
  if (args.runner === "claude") {
    result = await runClaude({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.claudeModel });
  } else if (args.runner === "gemini") {
    result = await runGemini({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.geminiModel });
  } else {
    result = await runCodex({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.codexModel, profile: args.codexProfile });
  }

  const artifact = {
    review_role: "userspace_review",
    question: spec.question,
    spec_path: resolvedSpecPath,
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
    context_manifest_path: join(contextDir, "manifest.json"),
  };
  await writeFile(join(runDir, "userspace-review-result.json"), JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Userspace review complete: ${runDir}`);
  console.log(`  runner: ${args.runner}`);
  console.log(`  parse_ok: ${result.parse_ok}`);
  console.log(`  result: ${join(runDir, "userspace-review-result.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-review: ${error.message}`);
    process.exit(1);
  });
}

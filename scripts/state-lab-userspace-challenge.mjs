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
const CHALLENGES_DIR = join(STATE_LAB_DIR, "challenges");
const DEFAULT_RUNNER = process.env.SWAYAMBHU_USERSPACE_CHALLENGE_RUNNER || "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.SWAYAMBHU_USERSPACE_CHALLENGE_TIMEOUT_MS || 180000);
const DEFAULT_CODEX_PROFILE = process.env.SWAYAMBHU_USERSPACE_CHALLENGE_CODEX_PROFILE || null;
const DEFAULT_CLAUDE_MODEL = process.env.SWAYAMBHU_USERSPACE_CHALLENGE_CLAUDE_MODEL || "opus";
const DEFAULT_CODEX_MODEL = process.env.SWAYAMBHU_USERSPACE_CHALLENGE_CODEX_MODEL || null;
const DEFAULT_GEMINI_MODEL = process.env.SWAYAMBHU_USERSPACE_CHALLENGE_GEMINI_MODEL || "gemini-2.5-flash";

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  const slug = String(input || "userspace-challenge")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "userspace-challenge";
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
  console.log("Usage:\n  node scripts/state-lab-userspace-challenge.mjs --review-result <userspace-review-result.json> [--label <name>] [--runner codex|claude|gemini]");
}

function buildPrompt(basePrompt, reviewResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Review result path: ${reviewResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read both files first. Use the original evidence bundle to test whether the review is actually justified.",
    "Respond with JSON only.",
  ].join("\n");
}

export function normalizeChallengePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.review_role !== "userspace_review_adversarial") return null;
  if (typeof payload.review_result_path !== "string") return null;
  if (!["pass", "revise", "reject"].includes(payload.verdict)) return null;
  if (typeof payload.summary !== "string") return null;
  if (!Array.isArray(payload.agreements)) return null;
  if (!Array.isArray(payload.major_concerns)) return null;
  if (!Array.isArray(payload.required_changes)) return null;
  if (!Array.isArray(payload.reasons_not_to_change)) return null;
  if (typeof payload.confidence !== "number") return null;
  return payload;
}

function buildClaudeMeta(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    session_id: envelope.session_id || null,
    total_cost_usd: envelope.total_cost_usd || null,
    usage: envelope.usage || null,
    stop_reason: envelope.stop_reason || null,
    duration_ms: envelope.duration_ms || null,
  };
}

export function extractNormalizedChallengePayload(raw) {
  const parsed = parseJobOutput(raw || "");
  const direct = normalizeChallengePayload(parsed.payload);
  if (direct) {
    return { payload: direct, meta: parsed.meta };
  }

  let envelope = null;
  try {
    envelope = JSON.parse(raw || "");
  } catch {
    envelope = null;
  }
  const resultText = typeof envelope?.result === "string" ? envelope.result : "";
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  let match;
  while ((match = fenceRegex.exec(resultText)) !== null) {
    try {
      const candidate = JSON.parse(match[1].trim());
      const normalized = normalizeChallengePayload(candidate);
      if (normalized) {
        return { payload: normalized, meta: parsed.meta || buildClaudeMeta(envelope) };
      }
    } catch {
      // Keep scanning later fenced blocks.
    }
  }

  return { payload: null, meta: parsed.meta || buildClaudeMeta(envelope) };
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
    parse_ok: !!normalizeChallengePayload(parsed.payload),
    payload: normalizeChallengePayload(parsed.payload),
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
  const parsed = extractNormalizedChallengePayload(result.stdout || "");
  return {
    runner: "claude",
    exit_code: result.code,
    timed_out: !!result.timed_out,
    parse_ok: !!parsed.payload,
    payload: parsed.payload,
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
    parse_ok: !!normalizeChallengePayload(payload),
    payload: normalizeChallengePayload(payload),
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
  const reviewArtifact = JSON.parse(await readFile(resolvedReviewResultPath, "utf8"));
  if (!reviewArtifact?.payload) throw new Error(`Review result has no payload: ${resolvedReviewResultPath}`);
  if (!reviewArtifact?.context_manifest_path) throw new Error(`Review result has no context manifest: ${resolvedReviewResultPath}`);

  const labelSeed = args.label || basename(resolvedReviewResultPath, extname(resolvedReviewResultPath));
  const runDir = join(CHALLENGES_DIR, `${nowTimestamp()}-${slugify(labelSeed)}`);
  await mkdir(runDir, { recursive: true });

  const basePrompt = await readFile(join(ROOT, "prompts", "userspace_review_adversarial.md"), "utf8");
  const prompt = buildPrompt(basePrompt, resolvedReviewResultPath, reviewArtifact.context_manifest_path);
  await writeFile(join(runDir, "prompt.userspace-review-adversarial.md"), prompt, "utf8");

  const startedAt = new Date().toISOString();
  let result;
  if (args.runner === "claude") {
    result = await runClaude({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.claudeModel, cwd: ROOT });
  } else if (args.runner === "gemini") {
    result = await runGemini({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.geminiModel, cwd: ROOT });
  } else {
    result = await runCodex({ prompt, runDir, timeoutMs: args.timeoutMs, model: args.codexModel, profile: args.codexProfile, cwd: ROOT });
  }

  const artifact = {
    review_role: "userspace_review_adversarial",
    review_result_path: resolvedReviewResultPath,
    context_manifest_path: reviewArtifact.context_manifest_path,
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
  const artifactPath = join(runDir, "userspace-challenge-result.json");
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Userspace challenge complete: ${runDir}`);
  console.log(`  runner: ${args.runner}`);
  console.log(`  parse_ok: ${result.parse_ok}`);
  console.log(`  result: ${artifactPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-challenge: ${error.message}`);
    process.exit(1);
  });
}

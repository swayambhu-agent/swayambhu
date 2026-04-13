#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  buildChallengePrompt as buildPrompt,
  normalizeChallengePayload,
  extractNormalizedChallengePayload,
} from "../lib/userspace-review/payloads.js";
import {
  runClaudeJob,
  runCodexJob,
  runGeminiJob,
} from "../lib/userspace-review/runners.js";

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

export { buildPrompt, normalizeChallengePayload, extractNormalizedChallengePayload };

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
    result = await runClaudeJob({
      prompt,
      runDir,
      timeoutMs: args.timeoutMs,
      model: args.claudeModel,
      cwd: ROOT,
      parseRawOutput: extractNormalizedChallengePayload,
    });
  } else if (args.runner === "gemini") {
    result = await runGeminiJob({
      prompt,
      runDir,
      timeoutMs: args.timeoutMs,
      model: args.geminiModel,
      cwd: ROOT,
      normalizePayload: normalizeChallengePayload,
    });
  } else {
    result = await runCodexJob({
      prompt,
      runDir,
      timeoutMs: args.timeoutMs,
      model: args.codexModel,
      profile: args.codexProfile,
      cwd: ROOT,
      normalizePayload: normalizeChallengePayload,
    });
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

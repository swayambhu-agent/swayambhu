#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { cp, mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const RUNS_DIR = join(STATE_LAB_DIR, "deployment-review-runs");
const PROMPT_PATH = join(ROOT, "prompts", "deployment_review.md");
const SCHEMA_PATH = join(ROOT, "schemas", "deployment-review-result.schema.json");

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

function parseNumberLike(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadRepoDeploymentReviewDefaults() {
  const configPath = join(ROOT, "config", "defaults.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.deployment_review && typeof parsed.deployment_review === "object"
      ? parsed.deployment_review
      : {};
  } catch {
    return {};
  }
}

export function buildDeploymentReviewDefaults() {
  const repoDefaults = loadRepoDeploymentReviewDefaults();
  return {
    reviewRunner: process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_RUNNER || repoDefaults.review_runner || "codex",
    adversarialRunner: process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_RUNNER || repoDefaults.adversarial_runner || "claude",
    reviewTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_TIMEOUT_MS, parseNumberLike(repoDefaults.review_timeout_ms, 600000)),
    adversarialTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_TIMEOUT_MS, parseNumberLike(repoDefaults.adversarial_timeout_ms, 600000)),
    adversarialMaxRounds: parseNumberLike(process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_MAX_ROUNDS, parseNumberLike(repoDefaults.adversarial_max_rounds, 3)),
    observationMode: process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_OBSERVATION_MODE || repoDefaults.observation_mode || "devloop_30",
  };
}

function slugify(input) {
  const slug = String(input || "deployment-review")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "deployment-review";
}

function parseArgs(argv, defaults) {
  const args = {
    specPath: null,
    label: null,
    reviewRunner: defaults.reviewRunner,
    adversarialRunner: defaults.adversarialRunner,
    reviewTimeoutMs: defaults.reviewTimeoutMs,
    adversarialTimeoutMs: defaults.adversarialTimeoutMs,
    adversarialMaxRounds: defaults.adversarialMaxRounds,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") args.specPath = argv[++i];
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--review-runner") args.reviewRunner = argv[++i];
    else if (arg === "--adversarial-runner") args.adversarialRunner = argv[++i];
    else if (arg === "--review-timeout-ms") args.reviewTimeoutMs = Number(argv[++i]);
    else if (arg === "--adversarial-timeout-ms") args.adversarialTimeoutMs = Number(argv[++i]);
    else if (arg === "--adversarial-max-rounds") args.adversarialMaxRounds = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function usage() {
  console.log("Usage: node scripts/deployment-review-run.mjs --spec <spec.json> [--label name]");
}

function normalizeSpec(raw) {
  if (!raw || typeof raw !== "object") throw new Error("spec must be a JSON object");
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) throw new Error("spec.question is required");
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  if (evidence.length === 0) throw new Error("spec.evidence must contain at least one item");
  return {
    question,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    evidence: evidence.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("invalid evidence entry");
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "doc";
      if (!path) throw new Error("evidence entry missing path");
      return { path, kind, label: typeof entry.label === "string" ? entry.label.trim() : null };
    }),
  };
}

async function copyEvidence(spec, runDir) {
  const contextDir = join(runDir, "context");
  const filesDir = join(contextDir, "files");
  await mkdir(filesDir, { recursive: true });
  const manifest = [];
  for (let index = 0; index < spec.evidence.length; index += 1) {
    const entry = spec.evidence[index];
    const abs = entry.path.startsWith("/") ? entry.path : resolve(ROOT, entry.path);
    const filename = `${String(index + 1).padStart(2, "0")}-${basename(abs)}`;
    const relative = join("context", "files", filename);
    await cp(abs, join(filesDir, filename));
    manifest.push({
      kind: entry.kind,
      source_path: abs,
      relative_path: relative,
      label: entry.label || null,
    });
  }
  const overview = [
    "# Deployment Review Overview",
    "",
    "## Question",
    spec.question,
    "",
    ...(spec.notes.length ? ["## Notes", ...spec.notes.map((note) => `- ${note}`), ""] : []),
    "## Included Evidence",
    ...manifest.map((entry) => `- ${entry.kind}: ${entry.relative_path} (from ${entry.source_path})`),
    "",
    "Start from the comparative probation evidence before interpreting causality.",
  ].join("\n");
  await writeFile(join(contextDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(contextDir, "overview.md"), `${overview}\n`, "utf8");
  return manifest;
}

function buildReviewPrompt(basePrompt) {
  return [
    "You are running inside the Swayambhu deployment_review harness.",
    "The current working directory is an isolated review bundle.",
    `Start with ${join("context", "overview.md")} and ${join("context", "manifest.json")}.`,
    "All evidence files are copied under context/files/.",
    "Do not modify files. Do not browse the web. Respond with JSON only.",
    "",
    basePrompt.trim(),
  ].join("\n\n");
}

function buildChallengePrompt(reviewResultPath, contextManifestPath) {
  return [
    "You are the adversarial reviewer for a probationary deployment decision.",
    `Review result path: ${reviewResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read both files first.",
    "Test whether the deployment_review result is actually justified by the evidence bundle.",
    "Respond with a single JSON object:",
    "{\"review_role\":\"deployment_review_adversarial\",\"review_result_path\":\"string\",\"verdict\":\"pass|revise|reject\",\"summary\":\"string\",\"agreements\":[\"...\"],\"major_concerns\":[\"...\"],\"required_changes\":[\"...\"],\"confidence\":0.0}",
  ].join("\n");
}

function buildRevisePrompt(basePrompt, reviewResultPath, challengeResultPath, contextManifestPath) {
  return [
    basePrompt.trim(),
    "",
    `Prior review result path: ${reviewResultPath}`,
    `Adversarial review result path: ${challengeResultPath}`,
    `Original context manifest path: ${contextManifestPath}`,
    "Read all three before revising.",
    "Respond with JSON only.",
  ].join("\n");
}

function parseJsonLoose(raw) {
  try {
    const parsed = JSON.parse(raw || "");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  const fenceMatch = String(raw || "").match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function looksLikeReviewPayload(payload) {
  return !!(
    payload
    && payload.review_role === "deployment_review"
    && ["keep", "rollback", "extend"].includes(payload.verdict)
    && typeof payload.summary === "string"
    && typeof payload.target_current_version === "string"
    && ["low", "medium", "high"].includes(payload.causal_adjacency)
    && Array.isArray(payload.evidence_for_improvement)
    && Array.isArray(payload.evidence_for_regression)
    && typeof payload.quarantine_recommended === "boolean"
    && typeof payload.confidence === "number"
  );
}

function looksLikeChallengePayload(payload) {
  return !!(
    payload
    && payload.review_role === "deployment_review_adversarial"
    && ["pass", "revise", "reject"].includes(payload.verdict)
    && typeof payload.review_result_path === "string"
    && typeof payload.summary === "string"
    && Array.isArray(payload.agreements)
    && Array.isArray(payload.major_concerns)
    && Array.isArray(payload.required_changes)
    && typeof payload.confidence === "number"
  );
}

function buildFinalResult(reviewPayload, challengePayload, maxRoundsReached) {
  if (challengePayload?.verdict === "pass") return reviewPayload;
  return {
    review_role: "deployment_review",
    verdict: "extend",
    confidence: Math.min(
      typeof reviewPayload?.confidence === "number" ? reviewPayload.confidence : 0.25,
      typeof challengePayload?.confidence === "number" ? challengePayload.confidence : 0.25,
    ),
    summary: maxRoundsReached
      ? "Adversarial review did not converge to a clear keep/rollback result during the configured rounds."
      : "Adversarial review rejected the current deployment decision as not yet justified.",
    target_current_version: reviewPayload?.target_current_version || "unknown",
    expected_predecessor_version: reviewPayload?.expected_predecessor_version ?? null,
    causal_adjacency: reviewPayload?.causal_adjacency || "medium",
    evidence_for_improvement: Array.isArray(reviewPayload?.evidence_for_improvement) ? reviewPayload.evidence_for_improvement : [],
    evidence_for_regression: Array.isArray(reviewPayload?.evidence_for_regression) ? reviewPayload.evidence_for_regression : [],
    quarantine_recommended: false,
    quarantine_reason: null,
  };
}

function runCommand(command, args, { cwd, stdinText, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(stdinText);
  });
}

async function writeLogs(runDir, name, result) {
  await writeFile(join(runDir, `${name}.stdout.log`), result.stdout || "", "utf8");
  await writeFile(join(runDir, `${name}.stderr.log`), result.stderr || "", "utf8");
}

async function runCodex({ prompt, runDir, timeoutMs, schemaPath = null, cwd = ROOT }) {
  const lastMessagePath = join(runDir, "codex.last-message.json");
  const args = [
    "exec", "-",
    "-C", cwd,
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message", lastMessagePath,
    "--color", "never",
  ];
  if (schemaPath) args.push("--output-schema", schemaPath);
  const result = await runCommand("codex", args, { cwd: ROOT, stdinText: prompt, timeoutMs });
  await writeLogs(runDir, "codex", result);
  let raw = "";
  try {
    raw = await readFile(lastMessagePath, "utf8");
  } catch {
    raw = result.stdout || "";
  }
  return { ...result, payload: parseJsonLoose(raw) };
}

async function runClaude({ prompt, runDir, timeoutMs, cwd = ROOT }) {
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--no-session-persistence"];
  const result = await runCommand("claude", args, { cwd, stdinText: prompt, timeoutMs });
  await writeLogs(runDir, "claude", result);
  return { ...result, payload: parseJsonLoose(result.stdout || "") };
}

async function runModel(runner, params) {
  if (runner === "claude") return runClaude(params);
  if (runner === "codex") return runCodex(params);
  throw new Error(`Unsupported runner: ${runner}`);
}

export async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const defaults = buildDeploymentReviewDefaults();
  const args = parseArgs(argv, defaults);
  if (args.help || !args.specPath) {
    usage();
    return args.help ? 0 : 1;
  }

  const spec = normalizeSpec(JSON.parse(await readFile(resolve(process.cwd(), args.specPath), "utf8")));
  const label = slugify(args.label || spec.question);
  const runDir = join(RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
  await mkdir(runDir, { recursive: true });
  const manifest = await copyEvidence(spec, runDir);
  const basePrompt = await readFile(PROMPT_PATH, "utf8");
  const reviewPrompt = buildReviewPrompt(basePrompt);
  const contextManifestPath = join("context", "manifest.json");

  let reviewResultPath = null;
  let reviewPayload = null;
  let finalChallengePayload = null;

  for (let round = 0; round < Math.max(1, args.adversarialMaxRounds); round += 1) {
    const reviewPromptPath = join(runDir, round === 0 ? "prompt.deployment-review.md" : `prompt.deployment-review-r${round + 1}.md`);
    const promptText = round === 0
      ? reviewPrompt
      : buildRevisePrompt(basePrompt, reviewResultPath, join(runDir, `deployment-review-challenge-r${round}.json`), contextManifestPath);
    await writeFile(reviewPromptPath, promptText, "utf8");
    const reviewResult = await runModel(args.reviewRunner, {
      prompt: promptText,
      runDir: join(runDir, round === 0 ? "review" : `review-r${round + 1}`),
      timeoutMs: args.reviewTimeoutMs,
      cwd: runDir,
      schemaPath: SCHEMA_PATH,
    });
    const parsedReview = reviewResult.payload;
    if (!looksLikeReviewPayload(parsedReview)) {
      throw new Error("deployment_review runner did not return valid JSON");
    }
    reviewPayload = parsedReview;
    reviewResultPath = join(runDir, round === 0 ? "deployment-review-result.json" : `deployment-review-r${round + 1}.json`);
    await writeFile(reviewResultPath, `${JSON.stringify(reviewPayload, null, 2)}\n`, "utf8");

    const challengePrompt = buildChallengePrompt(reviewResultPath, contextManifestPath);
    const challengeResult = await runModel(args.adversarialRunner, {
      prompt: challengePrompt,
      runDir: join(runDir, `challenge-r${round + 1}`),
      timeoutMs: args.adversarialTimeoutMs,
      cwd: runDir,
      schemaPath: null,
    });
    const parsedChallenge = challengeResult.payload;
    if (!looksLikeChallengePayload(parsedChallenge)) {
      throw new Error("deployment_review adversarial runner did not return valid JSON");
    }
    finalChallengePayload = parsedChallenge;
    const challengePath = join(runDir, `deployment-review-challenge-r${round + 1}.json`);
    await writeFile(challengePath, `${JSON.stringify(parsedChallenge, null, 2)}\n`, "utf8");

    if (parsedChallenge.verdict === "pass") {
      const finalPath = join(runDir, "deployment-review-final.json");
      await writeFile(finalPath, `${JSON.stringify(reviewPayload, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(reviewPayload, null, 2)}\n`);
      return 0;
    }

    if (parsedChallenge.verdict === "reject" || round === Math.max(1, args.adversarialMaxRounds) - 1) {
      const finalPayload = buildFinalResult(reviewPayload, parsedChallenge, round === Math.max(1, args.adversarialMaxRounds) - 1);
      const finalPath = join(runDir, "deployment-review-final.json");
      await writeFile(finalPath, `${JSON.stringify(finalPayload, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(finalPayload, null, 2)}\n`);
      return 0;
    }
  }

  const fallback = buildFinalResult(reviewPayload, finalChallengePayload, true);
  await writeFile(join(runDir, "deployment-review-final.json"), `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(fallback, null, 2)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

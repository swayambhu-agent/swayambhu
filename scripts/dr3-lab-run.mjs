#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { cp, mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  classifyAuthorityReviewPlan,
  mergeAuthorityValidation,
} from "../authority-review.js";
import {
  buildAuthorityAuthorPrompt,
  buildAuthorityChallengePrompt,
  buildAuthorityOverview,
  buildAuthorityReviewPrompt,
  buildAuthorityRevisePrompt,
  normalizeAuthorityChallengePayload,
  normalizeAuthorityReviewPayload,
  parseAuthorityJsonLoose,
} from "../lib/authority-review/harness.js";
import {
  loadDotEnv,
  nowTimestamp,
  runSelectedRunner,
  slugifyLabel,
} from "../lib/userspace-review/cli.js";
import { normalizeAuthorPayload } from "../lib/userspace-review/payloads.js";
import { collectDirectSourceKeys, normalizeSpec, targetRelativePathForSource } from "../lib/userspace-review/spec.js";
import { getKV, dispose as disposeKV } from "./shared.mjs";
import {
  materializeAuthorWorkspace,
  persistLabResultCopies,
  persistOutputCopies,
} from "../lib/state-lab/review-jobs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const RUNS_DIR = join(STATE_LAB_DIR, "dr3-runs");
const REVIEW_SCHEMA_PATH = join(ROOT, "schemas", "authority-review-result.schema.json");

function parseNumberLike(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadRepoDr3Defaults() {
  const configPath = join(ROOT, "config", "defaults.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.dr3 && typeof parsed.dr3 === "object" ? parsed.dr3 : {};
  } catch {
    return {};
  }
}

export function buildDr3Defaults() {
  const repoDefaults = loadRepoDr3Defaults();
  return {
    reviewRunner: process.env.SWAYAMBHU_DR3_REVIEW_RUNNER || repoDefaults.review_runner || "codex",
    adversarialRunner: process.env.SWAYAMBHU_DR3_ADVERSARIAL_RUNNER || repoDefaults.adversarial_runner || "claude",
    authorRunner: process.env.SWAYAMBHU_DR3_AUTHOR_RUNNER || repoDefaults.author_runner || "codex",
    reviewTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DR3_REVIEW_TIMEOUT_MS, parseNumberLike(repoDefaults.review_timeout_ms, 600000)),
    adversarialTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DR3_ADVERSARIAL_TIMEOUT_MS, parseNumberLike(repoDefaults.adversarial_timeout_ms, 600000)),
    authorTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DR3_AUTHOR_TIMEOUT_MS, parseNumberLike(repoDefaults.author_timeout_ms, 600000)),
    labTimeoutMs: parseNumberLike(process.env.SWAYAMBHU_DR3_LAB_TIMEOUT_MS, parseNumberLike(repoDefaults.lab_timeout_ms, 600000)),
    adversarialMaxRounds: parseNumberLike(process.env.SWAYAMBHU_DR3_ADVERSARIAL_MAX_ROUNDS, parseNumberLike(repoDefaults.adversarial_max_rounds, 3)),
    sourceRef: process.env.SWAYAMBHU_DR3_SOURCE_REF || repoDefaults.source_ref || "current",
    allowAuthorityWidening: parseBooleanLike(
      process.env.SWAYAMBHU_DR3_ALLOW_AUTHORITY_WIDENING,
      parseBooleanLike(repoDefaults.allow_authority_widening, false),
    ),
  };
}

function parseArgs(argv, defaults) {
  const args = {
    specPath: null,
    reviewNoteKey: null,
    label: null,
    sourceRef: defaults.sourceRef,
    reviewRunner: defaults.reviewRunner,
    adversarialRunner: defaults.adversarialRunner,
    authorRunner: defaults.authorRunner,
    reviewTimeoutMs: defaults.reviewTimeoutMs,
    adversarialTimeoutMs: defaults.adversarialTimeoutMs,
    authorTimeoutMs: defaults.authorTimeoutMs,
    labTimeoutMs: defaults.labTimeoutMs,
    adversarialMaxRounds: defaults.adversarialMaxRounds,
    allowAuthorityWidening: defaults.allowAuthorityWidening,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") {
      args.specPath = argv[++i];
    } else if (arg === "--review-note-key") {
      args.reviewNoteKey = argv[++i];
    } else if (arg === "--label") {
      args.label = argv[++i];
    } else if (arg === "--source-ref") {
      args.sourceRef = argv[++i];
    } else if (arg === "--review-runner") {
      args.reviewRunner = argv[++i];
    } else if (arg === "--adversarial-runner") {
      args.adversarialRunner = argv[++i];
    } else if (arg === "--author-runner") {
      args.authorRunner = argv[++i];
    } else if (arg === "--review-timeout-ms") {
      args.reviewTimeoutMs = Number(argv[++i]);
    } else if (arg === "--adversarial-timeout-ms") {
      args.adversarialTimeoutMs = Number(argv[++i]);
    } else if (arg === "--author-timeout-ms") {
      args.authorTimeoutMs = Number(argv[++i]);
    } else if (arg === "--lab-timeout-ms") {
      args.labTimeoutMs = Number(argv[++i]);
    } else if (arg === "--adversarial-max-rounds") {
      args.adversarialMaxRounds = Number(argv[++i]);
    } else if (arg === "--allow-authority-widening") {
      args.allowAuthorityWidening = true;
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
    "  node scripts/dr3-lab-run.mjs --spec <spec.json> [--source-ref current]",
    "  node scripts/dr3-lab-run.mjs --review-note-key <review_note:authority_review:...> [--source-ref current]",
    "",
    "Flags:",
    "  --lab-timeout-ms <ms>         Timeout for state-lab validation",
    "  --allow-authority-widening    Permit stageable widening changes in proto mode",
  ].join("\n"));
}

function runCommand(command, args, { cwd, stdinText = null, timeoutMs = 600000 } = {}) {
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

    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

function writeArtifactLogs(runDir, name, result) {
  return Promise.all([
    writeFile(join(runDir, `${name}.stdout.log`), result.stdout || "", "utf8"),
    writeFile(join(runDir, `${name}.stderr.log`), result.stderr || "", "utf8"),
  ]);
}

function parseResultPath(stdout, suffix) {
  const match = String(stdout || "").match(new RegExp(`result:\\s*(.+${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})`));
  return match?.[1]?.trim() || null;
}

async function copyContextFiles(runDir, spec, specDir) {
  const contextDir = join(runDir, "context");
  const filesDir = join(contextDir, "files");
  await mkdir(filesDir, { recursive: true });
  const manifest = [];

  for (let index = 0; index < spec.files.length; index += 1) {
    const entry = spec.files[index];
    const sourcePath = resolve(specDir, entry.path);
    const actualSourcePath = existsSync(sourcePath) ? sourcePath : resolve(ROOT, entry.path);
    const targetRel = targetRelativePathForSource(actualSourcePath, index);
    const targetPath = join(filesDir, targetRel);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(actualSourcePath, targetPath, { recursive: true });
    manifest.push({
      source_path: actualSourcePath,
      relative_path: join("context", "files", targetRel),
      kind: entry.kind,
    });
  }

  await writeFile(join(contextDir, "manifest.json"), JSON.stringify({
    question: spec.question,
    notes: spec.notes,
    files: manifest,
  }, null, 2), "utf8");
  await writeFile(join(contextDir, "overview.md"), buildAuthorityOverview(spec, manifest), "utf8");
  return { contextDir, manifest };
}

async function materializeGeneratedSpec(runDir, generatedSpec) {
  const generatedDir = join(runDir, "generated-inputs");
  await mkdir(generatedDir, { recursive: true });
  const files = [];
  for (const [index, file] of (generatedSpec.files || []).entries()) {
    const filename = file.filename || `${String(index).padStart(2, "0")}.txt`;
    const targetPath = join(generatedDir, filename);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
    files.push({ path: targetPath, kind: file.kind || "artifact" });
  }
  return {
    question: generatedSpec.question,
    notes: generatedSpec.notes || [],
    files,
  };
}

function sourceKeyToFilename(sourceKey) {
  const sanitized = String(sourceKey).replace(/[^A-Za-z0-9._/-]+/g, "-");
  return join("live", `${sanitized}.txt`);
}

async function buildSpecFromReviewNote(reviewNoteKey, runDir) {
  const kv = await getKV();
  try {
    const reviewNote = await kv.get(reviewNoteKey, "json");
    if (!reviewNote || typeof reviewNote !== "object") {
      throw new Error(`Review note not found or invalid: ${reviewNoteKey}`);
    }

    const sourceReflectKey = reviewNote.source_reflect_key || null;
    const [
      sourceReflect,
      lastReflect,
      defaults,
      deepReflectPrompt,
      keyTiers,
      writePolicy,
      sourceMap,
    ] = await Promise.all([
      sourceReflectKey ? kv.get(sourceReflectKey, "json") : Promise.resolve(null),
      kv.get("last_reflect", "json"),
      kv.get("config:defaults", "json"),
      kv.get("prompt:deep_reflect", "text"),
      kv.get("kernel:key_tiers", "json"),
      kv.get("kernel:write_policy", "json"),
      kv.get("kernel:source_map", "json"),
    ]);

    const directSourceKeys = collectDirectSourceKeys(sourceMap || {});
    const sourceTexts = Object.fromEntries(
      await Promise.all(directSourceKeys.map(async (key) => [key, await kv.get(key, "text")])),
    );

    const question = `${String(reviewNote.summary || reviewNoteKey).trim()} Does the authority model itself need to change?`;
    const generatedSpec = {
      question,
      notes: [
        "Generated from a live review_note:* for proto-DR-3 authority review.",
        "Treat userspace repair as the default alternative. Only stay in authority review if the boundary model itself is implicated.",
      ],
      files: [
        {
          filename: join("live", "review-note.json"),
          kind: "analysis",
          content: JSON.stringify({ key: reviewNoteKey, value: reviewNote }, null, 2),
        },
        ...(sourceReflectKey && sourceReflect ? [{
          filename: join("live", "source-reflect.json"),
          kind: "trace",
          content: JSON.stringify({ key: sourceReflectKey, value: sourceReflect }, null, 2),
        }] : []),
        ...(lastReflect ? [{
          filename: join("live", "last-reflect.json"),
          kind: "state",
          content: JSON.stringify({ key: "last_reflect", value: lastReflect }, null, 2),
        }] : []),
        ...(defaults ? [{
          filename: join("live", "config-defaults.json"),
          kind: "doc",
          content: JSON.stringify({ key: "config:defaults", value: defaults }, null, 2),
        }] : []),
        ...(keyTiers ? [{
          filename: join("live", "kernel-key-tiers.json"),
          kind: "doc",
          content: JSON.stringify({ key: "kernel:key_tiers", value: keyTiers }, null, 2),
        }] : []),
        ...(writePolicy ? [{
          filename: join("live", "kernel-write-policy.json"),
          kind: "doc",
          content: JSON.stringify({ key: "kernel:write_policy", value: writePolicy }, null, 2),
        }] : []),
        ...(deepReflectPrompt ? [{
          filename: join("live", "prompt-deep_reflect.md"),
          kind: "prompt",
          content: String(deepReflectPrompt),
        }] : []),
        {
          filename: join("repo", "authority-policy.js"),
          kind: "code",
          content: await readFile(join(ROOT, "authority-policy.js"), "utf8"),
        },
        {
          filename: join("repo", "scripts", "seed-local-kv.mjs"),
          kind: "code",
          content: await readFile(join(ROOT, "scripts", "seed-local-kv.mjs"), "utf8"),
        },
        ...Object.entries(sourceTexts)
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([key, value]) => ({
            filename: sourceKeyToFilename(key),
            kind: "code",
            content: String(value),
          })),
      ],
    };

    return materializeGeneratedSpec(runDir, generatedSpec);
  } finally {
    await disposeKV();
  }
}

async function emitReject({ runDir, reviewNoteKey, reviewResultPath = null, challengeResultPaths = [], authorResultPath = null, labResultPath = null, authorityEffect = null, reasons = [] }) {
  const payload = {
    review_note_key: reviewNoteKey || null,
    review_result_path: reviewResultPath,
    adversarial_result_paths: challengeResultPaths,
    author_result_path: authorResultPath,
    lab_result_path: labResultPath,
    authority_effect: authorityEffect,
    promotion_recommendation: "reject",
    hypothesis_hash: null,
    validated_changes_hash: null,
    validated_changes: null,
    reasons_not_to_change: reasons,
    generated_at: new Date().toISOString(),
  };
  const outputRaw = JSON.stringify(payload, null, 2);
  if (runDir) await persistOutputCopies({ outputRaw, runDir });
  process.stdout.write(`${outputRaw}\n`);
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv(ROOT);
  const args = parseArgs(argv, buildDr3Defaults());
  if (args.help) {
    usage();
    return;
  }
  if ((args.specPath && args.reviewNoteKey) || (!args.specPath && !args.reviewNoteKey)) {
    usage();
    throw new Error("Provide exactly one of --spec or --review-note-key");
  }

  const labelSeed = args.label || args.reviewNoteKey || basename(args.specPath, extname(args.specPath));
  const runDir = join(RUNS_DIR, `${nowTimestamp()}-${slugifyLabel(labelSeed, "authority-review")}`);
  await mkdir(runDir, { recursive: true });

  let reviewResultPath = null;
  let challengeResultPaths = [];
  let authorResultPath = null;
  let labResultPath = null;
  let authorityEffect = null;

  try {
    let spec;
    let specDir = runDir;
    if (args.specPath) {
      const resolvedSpecPath = resolve(args.specPath);
      spec = normalizeSpec(JSON.parse(await readFile(resolvedSpecPath, "utf8")), resolvedSpecPath);
      specDir = dirname(resolvedSpecPath);
    } else {
      spec = await buildSpecFromReviewNote(args.reviewNoteKey, runDir);
    }

    const { contextDir } = await copyContextFiles(runDir, spec, specDir);
    const reviewPrompt = buildAuthorityReviewPrompt(await readFile(join(ROOT, "prompts", "authority_review.md"), "utf8"));
    await writeFile(join(runDir, "prompt.authority-review.md"), reviewPrompt, "utf8");

    const review = await runSelectedRunner({
      runner: args.reviewRunner,
      prompt: reviewPrompt,
      runDir,
      timeoutMs: args.reviewTimeoutMs,
      claudeOptions: {
        cwd: runDir,
        extraArgs: ["--no-session-persistence"],
        parseRawOutput: parseAuthorityJsonLoose,
        normalizePayload: normalizeAuthorityReviewPayload,
      },
      codexOptions: {
        cwd: runDir,
        commandCwd: ROOT,
        outputSchemaPath: REVIEW_SCHEMA_PATH,
        parseRawOutput: parseAuthorityJsonLoose,
        normalizePayload: normalizeAuthorityReviewPayload,
      },
      geminiOptions: {
        cwd: runDir,
        normalizePayload: normalizeAuthorityReviewPayload,
      },
    });
    if (review.exit_code !== 0 || !review.parse_ok || !review.payload) {
      throw new Error(`authority review failed: ${review.error || "parse failure"}`);
    }

    const reviewArtifact = {
      review_role: "authority_review",
      runner: args.reviewRunner,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      parse_ok: true,
      payload: review.payload,
      meta: review.meta || null,
      raw_path: review.raw_path,
      stdout_path: review.stdout_path || null,
      stderr_path: review.stderr_path || null,
      timed_out: !!review.timed_out,
      exit_code: review.exit_code,
      error: review.error || null,
      context_manifest_path: join(contextDir, "manifest.json"),
    };
    reviewResultPath = join(runDir, "authority-review-result.json");
    await writeFile(reviewResultPath, JSON.stringify(reviewArtifact, null, 2), "utf8");

    let currentReviewPayload = review.payload;
    let currentReviewResultPath = reviewResultPath;

    for (let round = 1; round <= Math.max(1, Number(args.adversarialMaxRounds || 1)); round += 1) {
      const challengePrompt = buildAuthorityChallengePrompt(
        await readFile(join(ROOT, "prompts", "authority_review_adversarial.md"), "utf8"),
        currentReviewResultPath,
        reviewArtifact.context_manifest_path,
      );
      const challengeRunDir = join(runDir, `challenge-r${round}`);
      await mkdir(challengeRunDir, { recursive: true });
      const challenge = await runSelectedRunner({
        runner: args.adversarialRunner,
        prompt: challengePrompt,
        runDir: challengeRunDir,
        timeoutMs: args.adversarialTimeoutMs,
        claudeOptions: {
          cwd: ROOT,
          extraArgs: ["--no-session-persistence"],
          parseRawOutput: parseAuthorityJsonLoose,
          normalizePayload: normalizeAuthorityChallengePayload,
        },
        codexOptions: {
          cwd: ROOT,
          commandCwd: ROOT,
          parseRawOutput: parseAuthorityJsonLoose,
          normalizePayload: normalizeAuthorityChallengePayload,
        },
        geminiOptions: {
          cwd: ROOT,
          normalizePayload: normalizeAuthorityChallengePayload,
        },
      });
      if (challenge.exit_code !== 0 || !challenge.parse_ok || !challenge.payload) {
        throw new Error(`authority challenge failed: ${challenge.error || "parse failure"}`);
      }
      const challengeArtifactPath = join(runDir, `authority-challenge-r${round}.json`);
      await writeFile(challengeArtifactPath, JSON.stringify({
        review_role: "authority_review_adversarial",
        review_result_path: currentReviewResultPath,
        context_manifest_path: reviewArtifact.context_manifest_path,
        runner: args.adversarialRunner,
        parse_ok: true,
        payload: challenge.payload,
        meta: challenge.meta || null,
        raw_path: challenge.raw_path,
        stdout_path: challenge.stdout_path || null,
        stderr_path: challenge.stderr_path || null,
        timed_out: !!challenge.timed_out,
        exit_code: challenge.exit_code,
        error: challenge.error || null,
      }, null, 2), "utf8");
      challengeResultPaths.push(challengeArtifactPath);

      if (challenge.payload.verdict === "pass") break;
      if (challenge.payload.verdict === "reject") {
        await emitReject({
          runDir,
          reviewNoteKey: args.reviewNoteKey,
          reviewResultPath: currentReviewResultPath,
          challengeResultPaths,
          authorityEffect: currentReviewPayload.authority_effect || null,
          reasons: [challenge.payload.summary, ...(challenge.payload.required_changes || [])].filter(Boolean),
        });
        return;
      }
      if (round >= args.adversarialMaxRounds) {
        await emitReject({
          runDir,
          reviewNoteKey: args.reviewNoteKey,
          reviewResultPath: currentReviewResultPath,
          challengeResultPaths,
          authorityEffect: currentReviewPayload.authority_effect || null,
          reasons: [`authority review did not converge after ${args.adversarialMaxRounds} rounds`, ...(challenge.payload.required_changes || [])],
        });
        return;
      }

      const revisePrompt = buildAuthorityRevisePrompt(
        await readFile(join(ROOT, "prompts", "authority_review_revise.md"), "utf8"),
        currentReviewResultPath,
        challengeArtifactPath,
        reviewArtifact.context_manifest_path,
      );
      const reviseRunDir = join(runDir, `review-revise-r${round}`);
      await mkdir(reviseRunDir, { recursive: true });
      const revised = await runSelectedRunner({
        runner: args.reviewRunner,
        prompt: revisePrompt,
        runDir: reviseRunDir,
        timeoutMs: args.reviewTimeoutMs,
        claudeOptions: {
          cwd: ROOT,
          extraArgs: ["--no-session-persistence"],
          parseRawOutput: parseAuthorityJsonLoose,
          normalizePayload: normalizeAuthorityReviewPayload,
        },
        codexOptions: {
          cwd: ROOT,
          commandCwd: ROOT,
          outputSchemaPath: REVIEW_SCHEMA_PATH,
          parseRawOutput: parseAuthorityJsonLoose,
          normalizePayload: normalizeAuthorityReviewPayload,
        },
        geminiOptions: {
          cwd: ROOT,
          normalizePayload: normalizeAuthorityReviewPayload,
        },
      });
      if (revised.exit_code !== 0 || !revised.parse_ok || !revised.payload) {
        throw new Error(`authority review revise failed: ${revised.error || "parse failure"}`);
      }
      currentReviewPayload = revised.payload;
      currentReviewResultPath = join(runDir, `authority-review-r${round + 1}.json`);
      await writeFile(currentReviewResultPath, JSON.stringify({
        ...reviewArtifact,
        payload: currentReviewPayload,
        raw_path: revised.raw_path,
        stdout_path: revised.stdout_path || null,
        stderr_path: revised.stderr_path || null,
        timed_out: !!revised.timed_out,
        exit_code: revised.exit_code,
        error: revised.error || null,
      }, null, 2), "utf8");
    }

    authorityEffect = currentReviewPayload.authority_effect;

    const authorWorkspace = await materializeAuthorWorkspace({
      sourceRef: args.sourceRef,
      workspaceDir: join(runDir, "author-workspace"),
    });
    const authorPrompt = buildAuthorityAuthorPrompt(
      await readFile(join(ROOT, "prompts", "authority_lab_author.md"), "utf8"),
      currentReviewResultPath,
    );
    const authorRunDir = join(runDir, "author");
    await mkdir(authorRunDir, { recursive: true });
    const author = await runSelectedRunner({
      runner: args.authorRunner,
      prompt: authorPrompt,
      runDir: authorRunDir,
      timeoutMs: args.authorTimeoutMs,
      claudeOptions: {
        cwd: authorWorkspace,
        normalizePayload: normalizeAuthorPayload,
      },
      codexOptions: {
        cwd: authorWorkspace,
        commandCwd: ROOT,
        normalizePayload: normalizeAuthorPayload,
      },
      geminiOptions: {
        cwd: authorWorkspace,
        normalizePayload: normalizeAuthorPayload,
      },
    });
    const authorPayload = author.payload;
    if (author.exit_code !== 0 || !authorPayload) {
      throw new Error(`authority author failed: ${author.error || "parse failure"}`);
    }
    authorResultPath = join(runDir, "authority-author-result.json");
    await writeFile(authorResultPath, JSON.stringify({
      review_role: "authority_lab_author",
      review_result_path: currentReviewResultPath,
      workspace_root: authorWorkspace,
      runner: args.authorRunner,
      parse_ok: true,
      payload: authorPayload,
      meta: author.meta || null,
      raw_path: author.raw_path,
      stdout_path: author.stdout_path || null,
      stderr_path: author.stderr_path || null,
      timed_out: !!author.timed_out,
      exit_code: author.exit_code,
      error: author.error || null,
    }, null, 2), "utf8");

    const planClassification = classifyAuthorityReviewPlan({
      reviewPayload: currentReviewPayload,
      candidateChanges: authorPayload.candidate_changes,
    });
    if (!planClassification.ok) {
      await emitReject({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath: currentReviewResultPath,
        challengeResultPaths,
        authorResultPath,
        authorityEffect: planClassification.authority_effect,
        reasons: [planClassification.error],
      });
      return;
    }
    authorityEffect = planClassification.authority_effect;
    if (authorityEffect === "authority_widening" && !args.allowAuthorityWidening) {
      await emitReject({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath: currentReviewResultPath,
        challengeResultPaths,
        authorResultPath,
        authorityEffect,
        reasons: ["authority_widening_requires_elevated_approval_in_proto_dr3"],
      });
      return;
    }

    const hypothesisPath = join(runDir, "authority-hypothesis.json");
    await writeFile(hypothesisPath, JSON.stringify({
      review_note_key: args.reviewNoteKey || null,
      hypothesis: authorPayload.hypothesis,
      candidate_changes: authorPayload.candidate_changes,
      validation: mergeAuthorityValidation(authorPayload.validation),
      limits: authorPayload.limits,
    }, null, 2), "utf8");

    const labRun = await runCommand("node", [
      "scripts/state-lab.mjs",
      "lab-run",
      args.sourceRef,
      hypothesisPath,
    ], { cwd: ROOT, timeoutMs: args.labTimeoutMs });
    await writeArtifactLogs(runDir, "lab-run", labRun);
    if (labRun.code !== 0) {
      throw new Error(`state-lab lab-run failed: ${labRun.error}`);
    }

    labResultPath = parseResultPath(labRun.stdout, "lab-result.json");
    if (!labResultPath) {
      throw new Error("could not locate lab-result.json");
    }
    const labResultRaw = await readFile(resolve(labResultPath), "utf8");
    const { bundledLabResultPath } = await persistLabResultCopies({ labResultRaw, runDir });
    const labResult = JSON.parse(labResultRaw);

    const payload = {
      review_note_key: args.reviewNoteKey || null,
      review_result_path: currentReviewResultPath,
      adversarial_result_paths: challengeResultPaths,
      author_result_path: authorResultPath,
      lab_result_path: bundledLabResultPath,
      branch_name: labResult.branch || null,
      authority_effect: authorityEffect,
      promotion_recommendation: labResult.promotion_recommendation || "reject",
      hypothesis_hash: labResult.hypothesis_hash || null,
      validated_changes_hash: labResult.validated_changes_hash || null,
      validated_changes: labResult.validated_changes || null,
      reasons_not_to_change: labResult.reasons_not_to_change || [],
      generated_at: new Date().toISOString(),
    };
    const outputRaw = JSON.stringify(payload, null, 2);
    await persistOutputCopies({ outputRaw, runDir });
    process.stdout.write(`${outputRaw}\n`);
  } catch (error) {
    await emitReject({
      runDir,
      reviewNoteKey: args.reviewNoteKey,
      reviewResultPath,
      challengeResultPaths,
      authorResultPath,
      labResultPath,
      authorityEffect,
      reasons: [`dr3_pipeline_error: ${error.message}`],
    });
  } finally {
    await disposeKV();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dr3-lab-run: ${error.message}`);
    process.exit(1);
  });
}

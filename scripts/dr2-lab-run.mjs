#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildReviewInvocation,
  materializeAuthorWorkspace,
  persistLabResultCopies,
  persistOutputCopies,
} from "../lib/state-lab/review-jobs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const RUNS_DIR = join(STATE_LAB_DIR, "dr2-runs");

function nowTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  const slug = String(input || "dr2")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "dr2";
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
    reviewNoteKey: null,
    sourceRef: "current",
    reviewRunner: "claude",
    authorRunner: "codex",
    adversarialRunner: null,
    adversarialTimeoutMs: null,
    adversarialMaxRounds: 2,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--review-note-key") {
      args.reviewNoteKey = argv[++i];
    } else if (arg === "--source-ref") {
      args.sourceRef = argv[++i];
    } else if (arg === "--review-runner") {
      args.reviewRunner = argv[++i];
    } else if (arg === "--author-runner") {
      args.authorRunner = argv[++i];
    } else if (arg === "--adversarial-runner") {
      args.adversarialRunner = argv[++i];
    } else if (arg === "--adversarial-timeout-ms") {
      args.adversarialTimeoutMs = Number(argv[++i]);
    } else if (arg === "--adversarial-max-rounds") {
      args.adversarialMaxRounds = Number(argv[++i]);
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log("Usage:\n  node scripts/dr2-lab-run.mjs --review-note-key <review_note:...> [--source-ref current] [--review-runner claude] [--author-runner codex] [--adversarial-runner claude|codex|gemini] [--adversarial-timeout-ms 600000] [--adversarial-max-rounds 2]");
}

function runCommand(command, args, { cwd, env = {} }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolvePromise({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr, error: code === 0 ? null : `exit ${code}` });
    });
  });
}

function parseResultPath(stdout, suffix) {
  const match = String(stdout || "").match(new RegExp(`result:\\s*(.+${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})`));
  return match?.[1]?.trim() || null;
}

async function writeStepLogs(runDir, name, result) {
  await writeFile(join(runDir, `${name}.stdout.log`), result.stdout || "", "utf8");
  await writeFile(join(runDir, `${name}.stderr.log`), result.stderr || "", "utf8");
}

function parseArtifactPath(stdout, suffix) {
  return parseResultPath(stdout, suffix);
}

async function runReviewRevision({
  runDir,
  round,
  reviewResultPath,
  challengeResultPath,
  reviewRunner,
}) {
  console.error(`[dr2] review revise start: round ${round}`);
  const reviseResult = await runCommand("node", [
    "scripts/state-lab-userspace-review-revise.mjs",
    "--review-result", reviewResultPath,
    "--challenge-result", challengeResultPath,
    "--label", `dr2-revise-r${round}-${slugify(reviewResultPath)}`,
    "--runner", reviewRunner,
  ], { cwd: ROOT });
  await writeStepLogs(runDir, `review-revise-r${round}`, reviseResult);
  if (reviseResult.code !== 0) {
    throw new Error(`userspace review revise failed: ${reviseResult.error}`);
  }
  const revisedResultPath = parseArtifactPath(reviseResult.stdout, "userspace-review-result.json");
  if (!revisedResultPath) {
    throw new Error("could not locate revised userspace-review-result.json");
  }
  const revisedArtifact = JSON.parse(await readFile(resolve(revisedResultPath), "utf8"));
  return { revisedResultPath, revisedArtifact };
}

async function runAdversarialLoop({
  runDir,
  reviewNoteKey,
  reviewResultPath,
  reviewArtifact,
  reviewRunner,
  adversarialRunner,
  adversarialTimeoutMs,
  adversarialMaxRounds,
}) {
  let currentReviewResultPath = reviewResultPath;
  let currentReviewArtifact = reviewArtifact;
  const challengeResultPaths = [];
  const maxRounds = Math.max(1, Number(adversarialMaxRounds || 1));

  for (let round = 1; round <= maxRounds; round += 1) {
    console.error(`[dr2] adversarial review start: round ${round}`);
    const challengeArgs = [
      "scripts/state-lab-userspace-challenge.mjs",
      "--review-result", currentReviewResultPath,
      "--label", `dr2-challenge-r${round}-${slugify(reviewNoteKey)}`,
      "--runner", adversarialRunner,
    ];
    if (Number.isFinite(adversarialTimeoutMs) && adversarialTimeoutMs > 0) {
      challengeArgs.push("--timeout-ms", String(adversarialTimeoutMs));
    }

    const challengeResult = await runCommand("node", challengeArgs, { cwd: ROOT });
    await writeStepLogs(runDir, `challenge-r${round}`, challengeResult);
    if (challengeResult.code !== 0) {
      throw new Error(`userspace challenge failed: ${challengeResult.error}`);
    }

    const challengeResultPath = parseArtifactPath(challengeResult.stdout, "userspace-challenge-result.json");
    if (!challengeResultPath) {
      throw new Error("could not locate userspace-challenge-result.json");
    }
    challengeResultPaths.push(challengeResultPath);
    const challengeArtifact = JSON.parse(await readFile(resolve(challengeResultPath), "utf8"));
    if (!challengeArtifact.parse_ok || !challengeArtifact.payload) {
      return {
        status: "reject",
        reviewResultPath: currentReviewResultPath,
        reviewArtifact: currentReviewArtifact,
        challengeResultPaths,
        finalChallengeArtifact: challengeArtifact,
        reasons: ["userspace_review_adversarial did not return a parseable result"],
      };
    }

    const verdict = challengeArtifact.payload.verdict;
    if (verdict === "pass") {
      return {
        status: "pass",
        reviewResultPath: currentReviewResultPath,
        reviewArtifact: currentReviewArtifact,
        challengeResultPaths,
        finalChallengeArtifact: challengeArtifact,
      };
    }

    if (verdict === "reject") {
      return {
        status: "reject",
        reviewResultPath: currentReviewResultPath,
        reviewArtifact: currentReviewArtifact,
        challengeResultPaths,
        finalChallengeArtifact: challengeArtifact,
        reasons: [
          challengeArtifact.payload.summary,
          ...(challengeArtifact.payload.required_changes || []),
        ].filter(Boolean),
      };
    }

    if (round >= maxRounds) {
      return {
        status: "reject",
        reviewResultPath: currentReviewResultPath,
        reviewArtifact: currentReviewArtifact,
        challengeResultPaths,
        finalChallengeArtifact: challengeArtifact,
        reasons: [
          `adversarial review did not converge after ${maxRounds} rounds`,
          ...(challengeArtifact.payload.required_changes || []),
        ].filter(Boolean),
      };
    }

    const revised = await runReviewRevision({
      runDir,
      round,
      reviewResultPath: currentReviewResultPath,
      challengeResultPath,
      reviewRunner,
    });

    if (!revised.revisedArtifact.parse_ok || !revised.revisedArtifact.payload) {
      return {
        status: "reject",
        reviewResultPath: revised.revisedResultPath,
        reviewArtifact: revised.revisedArtifact,
        challengeResultPaths,
        finalChallengeArtifact: challengeArtifact,
        reasons: ["userspace_review revision did not return a parseable result"],
      };
    }

    currentReviewResultPath = revised.revisedResultPath;
    currentReviewArtifact = revised.revisedArtifact;
  }

  return {
    status: "reject",
    reviewResultPath: currentReviewResultPath,
    reviewArtifact: currentReviewArtifact,
    challengeResultPaths,
    finalChallengeArtifact: null,
    reasons: ["adversarial review loop exited without a recognized verdict"],
  };

}

async function emitReject({
  runDir,
  reviewNoteKey,
  reviewResultPath = null,
  challengeResultPaths = [],
  authorResultPath = null,
  labResultPath = null,
  reasons = [],
}) {
  const payload = {
    review_note_key: reviewNoteKey,
    review_result_path: reviewResultPath,
    adversarial_result_paths: challengeResultPaths,
    author_result_path: authorResultPath,
    lab_result_path: labResultPath,
    promotion_recommendation: "reject",
    hypothesis_hash: null,
    validated_changes_hash: null,
    validated_changes: null,
    reasons_not_to_change: reasons,
    generated_at: new Date().toISOString(),
  };
  const outputRaw = JSON.stringify(payload, null, 2);
  if (runDir) {
    await persistOutputCopies({ outputRaw, runDir });
  }
  process.stdout.write(`${outputRaw}\n`);
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const args = parseArgs(argv);
  if (args.help || !args.reviewNoteKey) {
    usage();
    if (!args.help) throw new Error("Provide --review-note-key");
    return;
  }

  const runDir = join(RUNS_DIR, `${nowTimestamp()}-${slugify(args.reviewNoteKey)}`);
  await mkdir(runDir, { recursive: true });
  let finalReviewResultPath = null;
  let challengeResultPaths = [];
  let authorResultPath = null;
  let labResultPath = null;
  let finalChallengeArtifact = null;

  try {
    const reviewInvocation = buildReviewInvocation({
      reviewNoteKey: args.reviewNoteKey,
      reviewRunner: args.reviewRunner,
      sourceRef: args.sourceRef,
      label: `dr2-${slugify(args.reviewNoteKey)}`,
    });

    console.error(`[dr2] review start: ${args.reviewNoteKey}`);
    const reviewResult = await runCommand("node", reviewInvocation.args, { cwd: ROOT, env: reviewInvocation.env });
    await writeStepLogs(runDir, "review", reviewResult);
    if (reviewResult.code !== 0) {
      throw new Error(`userspace review failed: ${reviewResult.error}`);
    }

    const reviewResultPath = parseResultPath(reviewResult.stdout, "userspace-review-result.json");
    if (!reviewResultPath) {
      throw new Error("could not locate userspace-review-result.json");
    }
    const reviewArtifact = JSON.parse(await readFile(resolve(reviewResultPath), "utf8"));
    if (!reviewArtifact.parse_ok || !reviewArtifact.payload) {
      await emitReject({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath,
        reasons: ["userspace_review did not return a parseable proposal"],
      });
      return;
    }

    finalReviewResultPath = reviewResultPath;
    let finalReviewArtifact = reviewArtifact;
    if (args.adversarialRunner) {
      const adversarial = await runAdversarialLoop({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath,
        reviewArtifact,
        reviewRunner: args.reviewRunner,
        adversarialRunner: args.adversarialRunner,
        adversarialTimeoutMs: args.adversarialTimeoutMs,
        adversarialMaxRounds: args.adversarialMaxRounds,
      });
      finalReviewResultPath = adversarial.reviewResultPath;
      finalReviewArtifact = adversarial.reviewArtifact;
      challengeResultPaths = adversarial.challengeResultPaths;
      finalChallengeArtifact = adversarial.finalChallengeArtifact || null;
      if (adversarial.status !== "pass") {
        await emitReject({
          runDir,
          reviewNoteKey: args.reviewNoteKey,
          reviewResultPath: finalReviewResultPath,
          challengeResultPaths,
          reasons: adversarial.reasons || ["adversarial review rejected the proposal"],
        });
        return;
      }
    }

    const authorWorkspace = await materializeAuthorWorkspace({
      sourceRef: args.sourceRef,
      workspaceDir: join(runDir, "author-workspace"),
    });

    console.error("[dr2] author start");
    const authorResult = await runCommand("node", [
      "scripts/state-lab-userspace-author.mjs",
      "--review-result", finalReviewResultPath,
      "--workspace-root", authorWorkspace,
      "--label", `dr2-${slugify(args.reviewNoteKey)}`,
      "--runner", args.authorRunner,
    ], { cwd: ROOT });
    await writeStepLogs(runDir, "author", authorResult);
    if (authorResult.code !== 0) {
      throw new Error(`userspace author failed: ${authorResult.error}`);
    }

    authorResultPath = parseResultPath(authorResult.stdout, "userspace-author-result.json");
    if (!authorResultPath) {
      throw new Error("could not locate userspace-author-result.json");
    }
    const authorArtifact = JSON.parse(await readFile(resolve(authorResultPath), "utf8"));
    const authorPayload = authorArtifact.payload;
    if (!authorArtifact.parse_ok || !authorPayload) {
      await emitReject({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath: finalReviewResultPath,
        challengeResultPaths,
        authorResultPath,
        reasons: ["userspace_lab_author did not return a parseable candidate change set"],
      });
      return;
    }

    const candidateChanges = Array.isArray(authorPayload.candidate_changes) ? authorPayload.candidate_changes : [];
    if (candidateChanges.length === 0) {
      await emitReject({
        runDir,
        reviewNoteKey: args.reviewNoteKey,
        reviewResultPath: finalReviewResultPath,
        challengeResultPaths,
        authorResultPath,
        reasons: authorPayload.reasons_not_to_change || ["author returned no candidate changes"],
      });
      return;
    }

    const hypothesisPath = join(runDir, "lab-hypothesis.json");
    await writeFile(hypothesisPath, JSON.stringify({
      review_note_key: args.reviewNoteKey,
      hypothesis: authorPayload.hypothesis,
      candidate_changes: candidateChanges,
      validation: authorPayload.validation,
      limits: authorPayload.limits,
    }, null, 2), "utf8");

    console.error("[dr2] lab-run start");
    const labRun = await runCommand("node", [
      "scripts/state-lab.mjs",
      "lab-run",
      args.sourceRef,
      hypothesisPath,
    ], { cwd: ROOT });
    await writeStepLogs(runDir, "lab-run", labRun);
    if (labRun.code !== 0) {
      throw new Error(`state-lab lab-run failed: ${labRun.error}`);
    }

    labResultPath = parseResultPath(labRun.stdout, "lab-result.json");
    if (!labResultPath) {
      throw new Error("could not locate lab-result.json");
    }
    const labResultRaw = await readFile(resolve(labResultPath), "utf8");
    const { bundledLabResultPath } = await persistLabResultCopies({
      labResultRaw,
      runDir,
    });
    const labResult = JSON.parse(labResultRaw);

    const payload = {
      review_note_key: args.reviewNoteKey,
      review_result_path: finalReviewResultPath,
      adversarial_result_paths: challengeResultPaths,
      adversarial_final_verdict: finalChallengeArtifact?.payload?.verdict || null,
      author_result_path: authorResultPath,
      lab_result_path: bundledLabResultPath,
      branch_name: labResult.branch || null,
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
    void finalReviewArtifact;
  } catch (error) {
    await emitReject({
      runDir,
      reviewNoteKey: args.reviewNoteKey,
      reviewResultPath: finalReviewResultPath,
      challengeResultPaths,
      authorResultPath,
      labResultPath,
      reasons: [`dr2_pipeline_error: ${error.message}`],
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dr2-lab-run: ${error.message}`);
    process.exit(1);
  });
}

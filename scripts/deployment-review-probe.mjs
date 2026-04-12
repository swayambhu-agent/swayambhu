#!/usr/bin/env node

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { buildStartEnv, STATE_LAB_DIR } from "./state-lab.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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
    branchName: null,
    workspaceDir: null,
    versionId: null,
    expectedPredecessorVersion: null,
    reviewNoteKey: null,
    labResultPath: null,
    cycles: 30,
    generation: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--branch-name") args.branchName = argv[++index];
    else if (arg === "--workspace-dir") args.workspaceDir = argv[++index];
    else if (arg === "--version-id") args.versionId = argv[++index];
    else if (arg === "--expected-predecessor-version") args.expectedPredecessorVersion = argv[++index];
    else if (arg === "--review-note-key") args.reviewNoteKey = argv[++index];
    else if (arg === "--lab-result-path") args.labResultPath = argv[++index];
    else if (arg === "--cycles") args.cycles = Number(argv[++index]);
    else if (arg === "--generation") args.generation = Number(argv[++index]);
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function usage() {
  console.log("Usage: node scripts/deployment-review-probe.mjs --version-id <v_...> --workspace-dir <path> [--branch-name name] [--lab-result-path path]");
}

function keyFilePathFromWorkdir(workdir, key) {
  return join(workdir, `${String(key).replace(/:/g, "/")}.json`);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveBaselineSummary(probationState, labResult) {
  if (probationState?.source_baseline_summary && typeof probationState.source_baseline_summary === "object") {
    return probationState.source_baseline_summary;
  }
  return labResult?.comparison_summary?.baseline || null;
}

async function main(argv = process.argv.slice(2)) {
  loadDotEnv();
  const args = parseArgs(argv);
  if (args.help || !args.versionId || !args.workspaceDir) {
    usage();
    return args.help ? 0 : 1;
  }

  const jobWorkdir = process.cwd();
  const workspaceDir = resolve(args.workspaceDir);
  const probeDir = join(jobWorkdir, "probe-devloop");
  const artifactsDir = join(jobWorkdir, "probe-artifacts");
  await mkdir(probeDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  let env = { ...process.env, SWAYAMBHU_DEV_LOOP_SERVICE_MODE: "default" };
  if (args.branchName) {
    const metadataPath = join(STATE_LAB_DIR, "branches", args.branchName, "metadata.json");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      env = { ...env, ...buildStartEnv(metadata) };
    }
  }

  const command = `node scripts/dev-loop/batch-run.mjs --cycles ${Number.isFinite(args.cycles) ? args.cycles : 30} --base-dir '${probeDir}' --label 'deployment-review-${args.versionId}'`;
  execFileSync("bash", ["-lc", command], {
    cwd: workspaceDir,
    env,
    encoding: "utf8",
    timeout: 60 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const batchSummaryPath = join(probeDir, "batch-summary.json");
  const batchSummary = JSON.parse(await readFile(batchSummaryPath, "utf8"));
  const probationState = await readJsonIfExists(keyFilePathFromWorkdir(jobWorkdir, "deployment_review:state:1"));

  const evidence = [
    { path: batchSummaryPath, kind: "analysis", label: "probation batch summary" },
    { path: keyFilePathFromWorkdir(jobWorkdir, "deployment_review:state:1"), kind: "state", label: "active probation state" },
    { path: keyFilePathFromWorkdir(jobWorkdir, "deploy:current"), kind: "state", label: "current deployment pointer" },
    { path: keyFilePathFromWorkdir(jobWorkdir, `deploy:version:${args.versionId}`), kind: "doc", label: "active deployment manifest" },
  ];
  if (args.expectedPredecessorVersion) {
    evidence.push({
      path: keyFilePathFromWorkdir(jobWorkdir, `deploy:version:${args.expectedPredecessorVersion}`),
      kind: "doc",
      label: "predecessor deployment manifest",
    });
  }
  if (args.reviewNoteKey) {
    evidence.push({
      path: keyFilePathFromWorkdir(jobWorkdir, args.reviewNoteKey),
      kind: "analysis",
      label: "source review note",
    });
  }

  let labResult = null;
  if (args.labResultPath) {
    labResult = await readJsonIfExists(args.labResultPath);
    if (labResult) {
      evidence.push({ path: resolve(args.labResultPath), kind: "analysis", label: "source lab result" });
    }
  }
  const baselineSummary = resolveBaselineSummary(probationState, labResult);
  if (baselineSummary) {
    const baselineSummaryPath = join(artifactsDir, "baseline-summary.json");
    await writeFile(baselineSummaryPath, `${JSON.stringify(baselineSummary, null, 2)}\n`, "utf8");
    evidence.push({ path: baselineSummaryPath, kind: "analysis", label: "pre-deploy baseline summary" });
  }

  const spec = {
    question: `Should deployment ${args.versionId} be kept, rolled back, or extended after probation?`,
    notes: [
      "Generated by the deployment_review_probe.",
      "Compare the probationary deployment against its predecessor baseline when available.",
    ],
    evidence,
  };
  const specPath = join(jobWorkdir, "deployment-review-spec.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const payload = {
    review_role: "deployment_review_probe",
    target_current_version: args.versionId,
    expected_predecessor_version: args.expectedPredecessorVersion || null,
    observation_mode: "devloop_30",
    observation_artifact_ref: batchSummaryPath,
    batch_summary_path: batchSummaryPath,
    batch_summary: batchSummary,
    meta_policy_note_refs: Array.isArray(batchSummary.meta_policy_note_refs) ? batchSummary.meta_policy_note_refs : [],
    spec_path: specPath,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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

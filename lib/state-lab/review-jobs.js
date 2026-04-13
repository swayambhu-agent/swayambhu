import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import {
  materializeStateLabWorkspace,
} from "./workspace.js";

export const DEFAULT_STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveStateDirForSourceRef(sourceRef, stateLabDir = DEFAULT_STATE_LAB_DIR) {
  if (!sourceRef || sourceRef === "current") return null;
  if (sourceRef.startsWith("branch:")) {
    const name = sourceRef.slice("branch:".length);
    return join(stateLabDir, "branches", name, "state");
  }
  throw new Error(`Unsupported source ref for author workspace: ${sourceRef}`);
}

function resolveBranchMetadataPath(sourceRef, stateLabDir = DEFAULT_STATE_LAB_DIR) {
  if (!sourceRef?.startsWith("branch:")) return null;
  const name = sourceRef.slice("branch:".length);
  return join(stateLabDir, "branches", name, "metadata.json");
}

export function buildReviewInvocation({
  reviewNoteKey,
  reviewRunner,
  sourceRef,
  label,
  stateLabDir = DEFAULT_STATE_LAB_DIR,
}) {
  const args = [
    "lib/userspace-review/review-run.js",
    "--review-note-key", reviewNoteKey,
    "--label", label,
    "--runner", reviewRunner,
  ];
  const env = {};
  const reviewStateDir = resolveStateDirForSourceRef(sourceRef, stateLabDir);
  if (reviewStateDir) {
    args.push("--input-source", "kv");
    env.SWAYAMBHU_PERSIST_DIR = reviewStateDir;
  } else if (process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR) {
    args.push("--input-source", "bundle");
  }
  return { args, env };
}

export async function materializeAuthorWorkspace({
  sourceRef,
  workspaceDir,
  repoRoot = ROOT,
  stateLabDir = DEFAULT_STATE_LAB_DIR,
}) {
  if (!sourceRef || sourceRef === "current") return resolve(repoRoot);

  const stateDir = resolveStateDirForSourceRef(sourceRef, stateLabDir);
  if (!existsSync(stateDir)) {
    throw new Error(`State dir not found for source ref ${sourceRef}: ${stateDir}`);
  }
  const metadataPath = resolveBranchMetadataPath(sourceRef, stateLabDir);
  const branchMetadata = metadataPath && existsSync(metadataPath)
    ? JSON.parse(readFileSync(metadataPath, "utf8"))
    : null;
  await materializeStateLabWorkspace({
    workspaceDir,
    repoRoot,
    stateDir,
    dashboardPort: branchMetadata?.ports?.dashboard || null,
  });

  const provenance = {
    source_ref: sourceRef,
    workspace_dir: workspaceDir,
    relative_to_repo: relative(repoRoot, workspaceDir),
  };
  await writeFile(join(workspaceDir, ".state-lab-source-ref.json"), JSON.stringify(provenance, null, 2), "utf8");
  return workspaceDir;
}

export async function persistLabResultCopies({
  labResultRaw,
  runDir,
  cwd = process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR || process.cwd(),
}) {
  const bundledLabResultPath = join(runDir, "lab-result.json");
  await writeFile(bundledLabResultPath, labResultRaw, "utf8");

  const jobWorkdirLabResultPath = resolve(cwd, "lab-result.json");
  if (jobWorkdirLabResultPath !== bundledLabResultPath) {
    await writeFile(jobWorkdirLabResultPath, labResultRaw, "utf8");
  }

  return {
    bundledLabResultPath,
    jobWorkdirLabResultPath,
  };
}

export async function persistOutputCopies({
  outputRaw,
  runDir,
  cwd = process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR || process.cwd(),
}) {
  const bundledOutputPath = join(runDir, "output.json");
  await writeFile(bundledOutputPath, outputRaw, "utf8");

  const jobWorkdirOutputPath = resolve(cwd, "output.json");
  if (jobWorkdirOutputPath !== bundledOutputPath) {
    await writeFile(jobWorkdirOutputPath, outputRaw, "utf8");
  }

  return {
    bundledOutputPath,
    jobWorkdirOutputPath,
  };
}

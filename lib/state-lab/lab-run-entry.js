import { loadLabHypothesis } from "./workspace.js";
import { runLabRun } from "./lab-run.js";
import {
  applyCandidateChanges,
  buildStartEnv,
  buildValidatedChanges,
  createBranchFromSource,
  pathExists,
  prepareWorkspace,
  readJson,
  runStaticValidation,
  sanitizeName,
  syncWorkspaceCodeTargetsToBranchKv,
} from "./runtime.js";

export async function main(argv = process.argv.slice(2)) {
  await runLabRun(argv, {
    applyCandidateChanges,
    buildStartEnv,
    buildValidatedChanges,
    createBranchFromSource,
    loadLabHypothesis,
    pathExists,
    prepareWorkspace,
    readJson,
    runStaticValidation,
    sanitizeName,
    syncWorkspaceCodeTargetsToBranchKv,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`state-lab-lab-run: ${error.message}`);
    process.exit(1);
  });
}

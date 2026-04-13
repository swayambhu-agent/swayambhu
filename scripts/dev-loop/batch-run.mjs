#!/usr/bin/env node
// Bounded offline dev-loop batch runner.
// Runs observe + classify repeatedly against the current checkout without
// invoking the heavier CC/decide/verify stages from loop.mjs.

import { main, maybeSendProgressEmail, parseArgs } from "../../lib/dev-loop/batch-run.js";

main().catch(async (error) => {
  const config = parseArgs(process.argv.slice(2));
  console.error(`[BATCH] Fatal: ${error.message}`);
  await maybeSendProgressEmail(
    config.emailProgress,
    `[SWAYAMBHU-DEV] Batch failed: ${config.label}`,
    [
      `Label: ${config.label}`,
      `Identity enabled: ${config.identityEnabled}`,
      `Base dir: ${config.baseDir}`,
      `Error: ${error.message}`,
      `Failed at: ${new Date().toISOString()}`,
    ],
  );
  process.exit(1);
});

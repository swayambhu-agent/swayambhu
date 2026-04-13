#!/usr/bin/env node

import { join } from "path";
import {
  parseTeardownArgs,
  resolveTeardownTargets,
  teardownLocalState,
  teardownRemoteState,
} from "../lib/operator/teardown.js";

const ROOT = join(import.meta.dirname, "..");

async function main() {
  const options = parseTeardownArgs(process.argv.slice(2));
  const targets = resolveTeardownTargets({ root: ROOT, options });
  const report = {
    scope: options.scope,
    local: null,
    remote: null,
  };

  if (options.scope === "local" || options.scope === "all") {
    report.local = await teardownLocalState(targets);
  }

  if (options.scope === "remote" || options.scope === "all") {
    report.remote = await teardownRemoteState();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`teardown-experiment: ${error.message}`);
  process.exit(1);
});

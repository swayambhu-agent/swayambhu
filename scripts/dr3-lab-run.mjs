#!/usr/bin/env node

export { buildDr3Defaults, loadRepoDr3Defaults, main, parseArgs } from "../lib/dr3-lab-run.js";

import { main } from "../lib/dr3-lab-run.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dr3-lab-run: ${error.message}`);
    process.exit(1);
  });
}

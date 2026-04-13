#!/usr/bin/env node

import { main } from "../lib/dr2-lab-run.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dr2-lab-run: ${error.message}`);
    process.exit(1);
  });
}

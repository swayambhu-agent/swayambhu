#!/usr/bin/env node

import {
  main,
  parseArgs,
  usage,
  buildPrompt,
  normalizeChallengePayload,
  extractNormalizedChallengePayload,
} from "../lib/userspace-review/challenge-run.js";

export {
  main,
  parseArgs,
  usage,
  buildPrompt,
  normalizeChallengePayload,
  extractNormalizedChallengePayload,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-challenge: ${error.message}`);
    process.exit(1);
  });
}

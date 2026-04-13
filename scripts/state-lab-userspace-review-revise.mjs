#!/usr/bin/env node

import {
  main,
  parseArgs,
  usage,
  buildPrompt,
  looksLikeUserspaceReviewPayload,
} from "../lib/userspace-review/review-revise-run.js";

export {
  main,
  parseArgs,
  usage,
  buildPrompt,
  looksLikeUserspaceReviewPayload,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-review-revise: ${error.message}`);
    process.exit(1);
  });
}

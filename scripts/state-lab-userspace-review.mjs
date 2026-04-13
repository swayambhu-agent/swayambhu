#!/usr/bin/env node

import {
  main,
  parseArgs,
  usage,
  normalizeSpec,
  targetRelativePathForSource,
  collectDirectSourceKeys,
  buildLiveReviewSpec,
  buildOverview,
  buildPrompt,
  extractJsonFromString,
} from "../lib/userspace-review/review-run.js";

export {
  main,
  parseArgs,
  usage,
  normalizeSpec,
  targetRelativePathForSource,
  collectDirectSourceKeys,
  buildLiveReviewSpec,
  buildOverview,
  buildPrompt,
  extractJsonFromString,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-review: ${error.message}`);
    process.exit(1);
  });
}

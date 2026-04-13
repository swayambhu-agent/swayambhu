#!/usr/bin/env node

import {
  main,
  parseArgs,
  usage,
  buildPrompt,
  normalizePatchLikeChange,
  normalizeCandidateChanges,
  normalizeAuthorPayload,
} from "../lib/userspace-review/author-run.js";

export {
  main,
  parseArgs,
  usage,
  buildPrompt,
  normalizePatchLikeChange,
  normalizeCandidateChanges,
  normalizeAuthorPayload,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`userspace-author: ${error.message}`);
    process.exit(1);
  });
}

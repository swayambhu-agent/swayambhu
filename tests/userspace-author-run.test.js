import { describe, expect, it } from "vitest";

import {
  parseArgs,
} from "../lib/userspace-review/author-run.js";

describe("userspace author run module", () => {
  it("parses author-run CLI args", () => {
    const args = parseArgs([
      "--review-result", "/tmp/review.json",
      "--workspace-root", "/tmp/workspace",
      "--runner", "claude",
      "--timeout-ms", "1234",
    ]);

    expect(args.reviewResultPath).toBe("/tmp/review.json");
    expect(args.workspaceRoot).toBe("/tmp/workspace");
    expect(args.runner).toBe("claude");
    expect(args.timeoutMs).toBe(1234);
  });
});

import { describe, expect, it } from "vitest";

import { parseArgs as parseChallengeArgs } from "../lib/userspace-review/challenge-run.js";
import { parseArgs as parseReviseArgs } from "../lib/userspace-review/review-revise-run.js";

describe("userspace challenge/revise run modules", () => {
  it("parses challenge-run CLI args", () => {
    const args = parseChallengeArgs([
      "--review-result", "/tmp/review.json",
      "--runner", "claude",
      "--timeout-ms", "1234",
    ]);

    expect(args.reviewResultPath).toBe("/tmp/review.json");
    expect(args.runner).toBe("claude");
    expect(args.timeoutMs).toBe(1234);
  });

  it("parses review-revise CLI args", () => {
    const args = parseReviseArgs([
      "--review-result", "/tmp/review.json",
      "--challenge-result", "/tmp/challenge.json",
      "--runner", "codex",
      "--timeout-ms", "2345",
    ]);

    expect(args.reviewResultPath).toBe("/tmp/review.json");
    expect(args.challengeResultPath).toBe("/tmp/challenge.json");
    expect(args.runner).toBe("codex");
    expect(args.timeoutMs).toBe(2345);
  });
});

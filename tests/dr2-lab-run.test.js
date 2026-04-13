import { describe, expect, it } from "vitest";

import { parseArgs } from "../lib/dr2-lab-run.js";

describe("dr2-lab-run args", () => {
  it("parses defaults for the dr2 pipeline", () => {
    expect(parseArgs(["--review-note-key", "review_note:x"])).toEqual({
      reviewNoteKey: "review_note:x",
      sourceRef: "current",
      reviewRunner: "claude",
      authorRunner: "codex",
      adversarialRunner: null,
      adversarialTimeoutMs: null,
      adversarialMaxRounds: 2,
    });
  });

  it("parses optional adversarial controls", () => {
    expect(parseArgs([
      "--review-note-key", "review_note:x",
      "--source-ref", "branch:test",
      "--review-runner", "codex",
      "--author-runner", "claude",
      "--adversarial-runner", "gemini",
      "--adversarial-timeout-ms", "120000",
      "--adversarial-max-rounds", "3",
    ])).toEqual({
      reviewNoteKey: "review_note:x",
      sourceRef: "branch:test",
      reviewRunner: "codex",
      authorRunner: "claude",
      adversarialRunner: "gemini",
      adversarialTimeoutMs: 120000,
      adversarialMaxRounds: 3,
    });
  });

  it("rejects missing flag values explicitly", () => {
    expect(() => parseArgs(["--review-note-key"])).toThrow("Missing value for --review-note-key");
    expect(() => parseArgs(["--adversarial-runner"])).toThrow("Missing value for --adversarial-runner");
  });
});

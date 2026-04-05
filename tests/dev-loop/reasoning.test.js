import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../lib/reasoning.js", () => ({
  collectReasoningArtifacts: vi.fn(async () => [{
    slug: "carry-forward-continuations",
    summary: "Replace tasks with carry_forward continuations.",
    decision: "Use carry_forward as the only structured continuity mechanism.",
    conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
    body: "# Debate\n",
    created_at: "2026-04-05T12:00:00.000Z",
    source: "dev-loop",
  }]),
  writeReasoningArtifacts: vi.fn(async () => ({ written: ["carry-forward-continuations"], indexEntries: [] })),
}));

import * as reasoning from "../../lib/reasoning.js";

describe("dev-loop reasoning prompt contract", () => {
  it("tells CC to read reasoning artifacts and emit artifact_candidate metadata", () => {
    const prompt = readFileSync(new URL("../../scripts/dev-loop/cc-analyze.md", import.meta.url), "utf8");

    expect(prompt).toContain("/home/swayambhu/reasoning/INDEX.md");
    expect(prompt).toContain("artifact_candidate");
    expect(prompt).toContain("proposal_modified");
    expect(prompt).toContain("conditions_to_revisit");
  });
});

describe("dev-loop reasoning integration", () => {
  it("imports permanent helpers from lib/reasoning.js", () => {
    const loopSource = readFileSync(new URL("../../scripts/dev-loop/loop.mjs", import.meta.url), "utf8");

    expect(loopSource).toContain('from "../../lib/reasoning.js"');
    expect(loopSource).not.toContain("scripts/dev-loop/reasoning");
  });

  it("compiles converged verdicts through the shared helper module", async () => {
    const { maybeCompileReasoningArtifacts } = await import("../../scripts/dev-loop/loop.mjs");

    await maybeCompileReasoningArtifacts("/tmp/run-1", {
      decisions: [
        { seq: 1, verified: true },
      ],
    });

    expect(reasoning.collectReasoningArtifacts).toHaveBeenCalledWith(
      "/tmp/run-1",
      [{ seq: 1, verified: true }],
    );
    expect(reasoning.writeReasoningArtifacts).toHaveBeenCalled();
  });
});

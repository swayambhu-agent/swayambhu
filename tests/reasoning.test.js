import { describe, it, expect } from "vitest";
import {
  REASONING_DIR,
  shouldCompileReasoningArtifact,
  renderReasoningArtifact,
  renderReasoningIndex,
  loadReasoningArtifacts,
  collectReasoningArtifacts,
} from "../lib/reasoning.js";

describe("reasoning helpers", () => {
  it("exports the permanent reasoning directory", () => {
    expect(REASONING_DIR).toBe("/home/swayambhu/reasoning");
  });

  it("compiles only verified converged debate outcomes", () => {
    expect(shouldCompileReasoningArtifact(
      { verified: true },
      { status: "converged", rounds: 2, proposal_modified: false },
    )).toBe(true);

    expect(shouldCompileReasoningArtifact(
      { verified: true },
      { status: "converged", rounds: 1, proposal_modified: true },
    )).toBe(true);

    expect(shouldCompileReasoningArtifact(
      { verified: false },
      { status: "converged", rounds: 3, proposal_modified: true },
    )).toBe(false);

    expect(shouldCompileReasoningArtifact(
      { verified: true },
      { status: "withdrawn", rounds: 3, proposal_modified: true },
    )).toBe(false);
  });

  it("renders a DR-authored artifact with frontmatter and body", () => {
    const markdown = renderReasoningArtifact({
      slug: "tasks-vs-desires-debate",
      summary: "Decide whether explicit task continuity belongs in the architecture.",
      decision: "Use carry_forward, not tasks, as the sole structured continuity mechanism.",
      conditions_to_revisit: [
        "Planner evidence shows carry_forward causes stale-plan inertia.",
        "A better continuity mechanism replaces carry_forward.",
      ],
      body: "# Tasks vs Desires\n\nDecision details.",
      created_at: "2026-04-05T12:00:00.000Z",
      source: "deep-reflect",
    });

    expect(markdown).toContain("---");
    expect(markdown).toContain("slug: tasks-vs-desires-debate");
    expect(markdown).toContain("summary: Decide whether explicit task continuity belongs in the architecture.");
    expect(markdown).toContain("decision: Use carry_forward, not tasks, as the sole structured continuity mechanism.");
    expect(markdown).toContain("conditions_to_revisit:");
    expect(markdown).toContain("- Planner evidence shows carry_forward causes stale-plan inertia.");
    expect(markdown).toContain("# Tasks vs Desires");
  });

  it("renders INDEX.md newest first", () => {
    const index = renderReasoningIndex([
      {
        slug: "newer",
        summary: "Newer summary",
        decision: "Newer decision",
        created_at: "2026-04-05T12:00:00.000Z",
      },
      {
        slug: "older",
        summary: "Older summary",
        decision: "Older decision",
        created_at: "2026-04-04T12:00:00.000Z",
      },
    ]);

    expect(index).toContain("# Reasoning Artifacts");
    expect(index).toContain("[newer](./newer.md)");
    expect(index).toContain("[older](./older.md)");
    expect(index.indexOf("[newer](./newer.md)")).toBeLessThan(index.indexOf("[older](./older.md)"));
  });

  it("loads artifacts from markdown frontmatter", async () => {
    const files = new Map([
      ["/home/swayambhu/reasoning/INDEX.md", "# Reasoning Artifacts"],
      ["/home/swayambhu/reasoning/a.md", `---
slug: a
summary: Summary A
decision: Decision A
created_at: 2026-04-05T12:00:00.000Z
conditions_to_revisit:
  - Revisit A
---

# A
`],
      ["/home/swayambhu/reasoning/b.md", `---
slug: b
summary: Summary B
decision: Decision B
created_at: 2026-04-04T12:00:00.000Z
conditions_to_revisit:
  - Revisit B
---

# B
`],
    ]);

    const fsImpl = {
      readdir: async () => [
        { name: "INDEX.md", isFile: () => true },
        { name: "a.md", isFile: () => true },
        { name: "b.md", isFile: () => true },
      ],
      readFile: async (path) => files.get(path),
    };

    const loaded = await loadReasoningArtifacts(fsImpl);
    expect(loaded.map(x => x.slug)).toEqual(["a", "b"]);
    expect(loaded[0].conditions_to_revisit).toEqual(["Revisit A"]);
    expect(loaded[0].body).toContain("# A");
  });

  it("collects converged dev-loop artifacts from a run directory", async () => {
    const fsImpl = {
      readFile: async (path) => {
        if (path.endsWith("proposal-1.md")) return "# Proposal\n\nUse carry_forward.";
        if (path.endsWith("response-1-round-1.md")) return "# Response\n\nAddressed objection.";
        if (path.endsWith("verdict-1.json")) return JSON.stringify({
          status: "converged",
          rounds: 2,
          proposal_modified: true,
          artifact_candidate: {
            slug: "carry-forward-continuations",
            summary: "Replace tasks with carry_forward continuations.",
            decision: "Use carry_forward as the only structured continuity mechanism.",
            conditions_to_revisit: [
              "Planner evidence shows carry_forward causes stale-plan inertia.",
            ],
          },
        });
        throw new Error(`unexpected path: ${path}`);
      },
    };

    const artifacts = await collectReasoningArtifacts(
      "/tmp/run-1",
      [{ seq: 1, verified: true }],
      fsImpl,
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].slug).toBe("carry-forward-continuations");
    expect(artifacts[0].body).toContain("## Proposal");
    expect(artifacts[0].body).toContain("## Response Round 1");
    expect(artifacts[0].body).toContain("## Verdict");
    expect(artifacts[0].source).toBe("dev-loop");
  });

  it("writes artifact files and rewrites INDEX.md", async () => {
    const writes = [];
    const files = new Map([
      ["/home/swayambhu/reasoning/INDEX.md", "# Reasoning Artifacts"],
    ]);

    const fsImpl = {
      mkdir: async () => {},
      readdir: async () => [],
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
        files.set(path, contents);
      },
    };

    const { writeReasoningArtifacts } = await import("../lib/reasoning.js");
    await writeReasoningArtifacts([
      {
        slug: "tasks-vs-desires-debate",
        summary: "Decide how continuity should work.",
        decision: "Use carry_forward as the only structured continuity mechanism.",
        conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
        body: "# Tasks vs Desires\n\nDecision details.",
        created_at: "2026-04-05T12:00:00.000Z",
        source: "deep-reflect",
      },
    ], fsImpl);

    expect(writes.map(x => x.path)).toEqual([
      "/home/swayambhu/reasoning/tasks-vs-desires-debate.md",
      "/home/swayambhu/reasoning/INDEX.md",
    ]);
    expect(writes[0].contents).toContain("slug: tasks-vs-desires-debate");
    expect(writes[1].contents).toContain("[tasks-vs-desires-debate](./tasks-vs-desires-debate.md)");
  });

  it("ignores non-converged or unverified dev-loop decisions", async () => {
    const fsImpl = {
      readFile: async (path) => {
        if (path.endsWith("verdict-1.json")) return JSON.stringify({
          status: "withdrawn",
          rounds: 2,
          proposal_modified: true,
          artifact_candidate: {
            slug: "ignored-one",
            summary: "ignored",
            decision: "ignored",
            conditions_to_revisit: ["ignored"],
          },
        });
        if (path.endsWith("verdict-2.json")) return JSON.stringify({
          status: "converged",
          rounds: 1,
          proposal_modified: false,
          artifact_candidate: {
            slug: "ignored-two",
            summary: "ignored",
            decision: "ignored",
            conditions_to_revisit: ["ignored"],
          },
        });
        throw new Error(`unexpected path: ${path}`);
      },
    };

    const artifacts = await collectReasoningArtifacts(
      "/tmp/run-2",
      [
        { seq: 1, verified: true },
        { seq: 2, verified: true },
        { seq: 3, verified: false },
      ],
      fsImpl,
    );

    expect(artifacts).toEqual([]);
  });
});

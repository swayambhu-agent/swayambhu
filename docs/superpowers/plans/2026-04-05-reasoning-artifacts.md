# Reasoning Artifacts Implementation Plan

This plan replaces the prior dev-loop-centric design with the required architecture:

- Reasoning artifacts are an agent capability.
- Permanent logic lives in [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js).
- DR is the primary creator and consumer.
- The dev loop may also compile artifacts during bootstrapping, but only by importing from [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js).
- No agent code imports from `scripts/dev-loop/`.

## Target structure

Permanent agent code:

- [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js)
- [prompts/deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md)
- [userspace.js](/home/swami/swayambhu/repo/userspace.js)

Temporary dev-loop code:

- [scripts/dev-loop/loop.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/loop.mjs)
- [scripts/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo/scripts/dev-loop/cc-analyze.md)

Tests:

- [tests/reasoning.test.js](/home/swami/swayambhu/repo/tests/reasoning.test.js)
- [tests/dev-loop/reasoning.test.js](/home/swami/swayambhu/repo/tests/dev-loop/reasoning.test.js)
- [tests/reflect.test.js](/home/swami/swayambhu/repo/tests/reflect.test.js)
- [tests/userspace.test.js](/home/swami/swayambhu/repo/tests/userspace.test.js)

Filesystem output at runtime:

- `/home/swayambhu/reasoning/INDEX.md`
- `/home/swayambhu/reasoning/{slug}.md`

## Shared implementation contract

`applyDrResults` must accept this optional field in DR output:

```json
{
  "kv_operations": [],
  "carry_forward": [],
  "reasoning_artifacts": [
    {
      "slug": "tasks-vs-desires-debate",
      "summary": "Short summary",
      "decision": "What was decided",
      "conditions_to_revisit": [
        "Concrete falsifiable trigger"
      ],
      "body": "# Full markdown body"
    }
  ]
}
```

`applyDrResults` writes each artifact to `/home/swayambhu/reasoning/{slug}.md` with frontmatter, then rewrites `/home/swayambhu/reasoning/INDEX.md`.

`lib/reasoning.js` owns:

- `REASONING_DIR`
- `shouldCompileReasoningArtifact(decision, verdict)`
- `renderReasoningArtifact(artifact)`
- `renderReasoningIndex(entries)`
- `loadReasoningArtifacts(fsImpl?)`
- `collectReasoningArtifacts(runDir, decisions, fsImpl?)`
- `writeReasoningArtifacts(artifacts, fsImpl?)`

`scripts/dev-loop/loop.mjs` imports from `../../lib/reasoning.js`. There is no `scripts/dev-loop/reasoning.mjs` in the target design.

## Task 1: Lock the permanent helper API in agent tests

Write [tests/reasoning.test.js](/home/swami/swayambhu/repo/tests/reasoning.test.js) first.

Add this exact test file:

```js
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
});
```

Run:

```bash
npx vitest run tests/reasoning.test.js
```

Expected failure before implementation: `../lib/reasoning.js` does not exist.

Implement [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js) next with this exact export surface:

```js
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const REASONING_DIR = "/home/swayambhu/reasoning";
export const REASONING_INDEX_PATH = join(REASONING_DIR, "INDEX.md");

export function shouldCompileReasoningArtifact(decision, verdict) {
  return !!decision?.verified
    && verdict?.status === "converged"
    && (verdict?.rounds >= 2 || verdict?.proposal_modified === true);
}

export function renderReasoningArtifact(artifact) { /* implement */ }
export function renderReasoningIndex(entries) { /* implement */ }
export async function loadReasoningArtifacts(fsImpl = fs) { /* implement */ }
export async function collectReasoningArtifacts(runDir, decisions, fsImpl = fs) { /* implement */ }
export async function writeReasoningArtifacts(artifacts, fsImpl = fs) { /* implement in Task 5 */ }
```

This test asserts:

- helper API is agent-owned in `lib/`
- compile gate is deterministic
- artifact markdown uses frontmatter plus body
- index ordering is newest-first
- loading works from the permanent on-disk format
- dev-loop compilation uses the same helper module

## Task 2: Extend the DR prompt contract to read and emit reasoning artifacts

Write prompt-contract coverage first.

In [tests/reflect.test.js](/home/swami/swayambhu/repo/tests/reflect.test.js), add:

```js
  it("teaches deep-reflect to read and emit reasoning artifacts", () => {
    const prompt = readFileSync(new URL("../prompts/deep_reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain("/home/swayambhu/reasoning/INDEX.md");
    expect(prompt).toContain("Treat each artifact as prior deliberation, not immutable truth.");
    expect(prompt).toContain("reasoning_artifacts");
    expect(prompt).toContain("conditions_to_revisit");
    expect(prompt).toContain("full markdown body of the reasoning");
  });
```

Run:

```bash
npx vitest run tests/reflect.test.js -t "teaches deep-reflect to read and emit reasoning artifacts"
```

Expected failure before implementation: [prompts/deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md) does not mention the archive or the new output field.

Implement in [prompts/deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md):

1. Insert a `## Reasoning artifacts` section after the initial context list:

```md
## Reasoning artifacts

This machine has a local reasoning archive at `/home/swayambhu/reasoning/`.
Start with `/home/swayambhu/reasoning/INDEX.md`, then open any relevant artifact files.
Treat each artifact as prior deliberation, not immutable truth.

When a current question matches a prior artifact:
- reuse its recorded decision by default
- revisit only when current evidence hits one of that artifact's `conditions_to_revisit`
- if you overturn or materially refine it, say so explicitly in `reflection`
```

2. Extend the `## Output` JSON schema:

```json
"reasoning_artifacts": [
  {
    "slug": "kebab-case-slug",
    "summary": "Short summary of the reasoning",
    "decision": "What was decided",
    "conditions_to_revisit": ["Concrete falsifiable trigger"],
    "body": "full markdown body of the reasoning"
  }
]
```

This test asserts:

- DR is taught to read the permanent archive
- DR is taught to emit artifacts directly
- the schema names exactly match the runtime contract

## Task 3: Add DR apply-path tests before touching runtime code

Add these tests to [tests/userspace.test.js](/home/swami/swayambhu/repo/tests/userspace.test.js).

First add the import:

```js
import * as reasoning from "../lib/reasoning.js";
```

Then add the mock near the existing `vi.mock(...)` calls:

```js
vi.mock("../lib/reasoning.js", () => ({
  writeReasoningArtifacts: vi.fn(async () => ({ written: [], indexEntries: [] })),
}));
```

Then append these tests under `describe("applyDrResults key filter", ...)`:

```js
  it("writes DR reasoning artifacts through lib/reasoning.js", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      kv_operations: [],
      reasoning_artifacts: [
        {
          slug: "tasks-vs-desires-debate",
          summary: "Decide how continuity should work.",
          decision: "Use carry_forward as the only structured continuity mechanism.",
          conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
          body: "# Tasks vs Desires\n\nDecision details.",
        },
      ],
    });

    expect(reasoning.writeReasoningArtifacts).toHaveBeenCalledWith([
      {
        slug: "tasks-vs-desires-debate",
        summary: "Decide how continuity should work.",
        decision: "Use carry_forward as the only structured continuity mechanism.",
        conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
        body: "# Tasks vs Desires\n\nDecision details.",
        created_at: expect.any(String),
        source: "deep-reflect",
      },
    ]);
  });

  it("does not call reasoning writer when DR omits reasoning_artifacts", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      kv_operations: [],
    });

    expect(reasoning.writeReasoningArtifacts).not.toHaveBeenCalled();
  });
```

Run:

```bash
npx vitest run tests/userspace.test.js -t "reasoning artifacts"
```

Expected failure before implementation: `applyDrResults` never calls the reasoning helper.

Implement in [userspace.js](/home/swami/swayambhu/repo/userspace.js):

1. Add the import at top level:

```js
import { writeReasoningArtifacts } from "./lib/reasoning.js";
```

2. Add a clarifying comment in `dispatchDr()` above `context_keys`:

```js
        // Reasoning artifacts live on the shared filesystem at
        // /home/swayambhu/reasoning/. Deep-reflect reads them directly;
        // they are not packed into the KV tarball context.
```

3. In `applyDrResults`, after the KV/code-stage block and before `reflect:1:${executionId}` is written, add:

```js
  if (output.reasoning_artifacts?.length) {
    await writeReasoningArtifacts(output.reasoning_artifacts.map((artifact) => ({
      ...artifact,
      created_at: artifact.created_at || new Date().toISOString(),
      source: artifact.source || "deep-reflect",
    })));
  }
```

This test asserts:

- DR artifact writes happen in agent runtime, not in dev-loop code
- `applyDrResults` is the integration point
- DR remains the primary creator

## Task 4: Finish `writeReasoningArtifacts` with index management in agent code

Extend [tests/reasoning.test.js](/home/swami/swayambhu/repo/tests/reasoning.test.js) with a write-path test:

```js
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
```

Run:

```bash
npx vitest run tests/reasoning.test.js -t "writes artifact files and rewrites INDEX.md"
```

Expected failure before implementation: `writeReasoningArtifacts` is missing or incomplete.

Implement in [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js):

```js
export async function writeReasoningArtifacts(artifacts, fsImpl = fs) {
  if (!artifacts?.length) return { written: [], indexEntries: await loadReasoningArtifacts(fsImpl) };

  await fsImpl.mkdir(REASONING_DIR, { recursive: true });

  for (const artifact of artifacts) {
    const path = join(REASONING_DIR, `${artifact.slug}.md`);
    await fsImpl.writeFile(path, renderReasoningArtifact(artifact), "utf8");
  }

  const indexEntries = await loadReasoningArtifacts(fsImpl);
  const mergedBySlug = new Map(indexEntries.map((entry) => [entry.slug, entry]));
  for (const artifact of artifacts) mergedBySlug.set(artifact.slug, artifact);

  const merged = [...mergedBySlug.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  await fsImpl.writeFile(REASONING_INDEX_PATH, renderReasoningIndex(merged), "utf8");
  return { written: artifacts.map((x) => x.slug), indexEntries: merged };
}
```

This test asserts:

- file writes are agent-owned
- the artifact file path is exact
- `INDEX.md` is regenerated from the same helper module

## Task 5: Add dev-loop prompt coverage that points back to the agent archive

Write [tests/dev-loop/reasoning.test.js](/home/swami/swayambhu/repo/tests/dev-loop/reasoning.test.js) first:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("dev-loop reasoning prompt contract", () => {
  it("tells CC to read reasoning artifacts and emit artifact_candidate metadata", () => {
    const prompt = readFileSync(new URL("../../scripts/dev-loop/cc-analyze.md", import.meta.url), "utf8");

    expect(prompt).toContain("/home/swayambhu/reasoning/INDEX.md");
    expect(prompt).toContain("artifact_candidate");
    expect(prompt).toContain("proposal_modified");
    expect(prompt).toContain("conditions_to_revisit");
  });
});
```

Run:

```bash
npx vitest run tests/dev-loop/reasoning.test.js
```

Expected failure before implementation: [scripts/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo/scripts/dev-loop/cc-analyze.md) does not mention the archive or verdict metadata.

Implement in [scripts/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo/scripts/dev-loop/cc-analyze.md):

1. In the inputs section, add:

```md
- `/home/swayambhu/reasoning/INDEX.md` and relevant artifact files — prior architecture decisions
```

2. In Stage 4, require verdict metadata:

```md
When a proposal reaches a reusable architecture conclusion, include this in `verdict-{seq}.json`:

```json
{
  "status": "converged",
  "rounds": 2,
  "proposal_modified": true,
  "artifact_candidate": {
    "slug": "kebab-case-slug",
    "summary": "Short summary",
    "decision": "What was decided",
    "conditions_to_revisit": ["Concrete falsifiable trigger"]
  }
}
```
```

This test asserts:

- the dev loop is a consumer of the permanent archive
- verdict files carry enough metadata for `lib/reasoning.js` to compile artifacts

## Task 6: Add dev-loop integration tests before changing the loop

Extend [tests/dev-loop/reasoning.test.js](/home/swami/swayambhu/repo/tests/dev-loop/reasoning.test.js) with loop-level integration coverage:

```js
import { vi } from "vitest";

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
```

Run:

```bash
npx vitest run tests/dev-loop/reasoning.test.js -t "compiles converged verdicts through the shared helper module"
```

Expected failure before implementation: [scripts/dev-loop/loop.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/loop.mjs) does not import or expose the helper.

Implement in [scripts/dev-loop/loop.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/loop.mjs):

1. Add the import:

```js
import { collectReasoningArtifacts, writeReasoningArtifacts } from '../../lib/reasoning.js';
```

2. Add a helper near other orchestration helpers:

```js
export async function maybeCompileReasoningArtifacts(runDir, decisionsJson) {
  const decisions = decisionsJson?.decisions || [];
  const artifacts = await collectReasoningArtifacts(runDir, decisions);
  if (!artifacts.length) return [];
  await writeReasoningArtifacts(artifacts);
  return artifacts;
}
```

3. Call it after the loop has `ccResult?.decisions?.decisions` and before reporting finishes:

```js
      await maybeCompileReasoningArtifacts(runDir, ccResult.decisions);
```

This test asserts:

- dev loop imports from the permanent agent module
- dev loop compilation is optional bootstrapping, not a separate implementation

## Task 7: Make `collectReasoningArtifacts` concrete enough for the loop and tests

Add one more collector test to [tests/reasoning.test.js](/home/swami/swayambhu/repo/tests/reasoning.test.js):

```js
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
```

Run:

```bash
npx vitest run tests/reasoning.test.js -t "ignores non-converged or unverified dev-loop decisions"
```

Implement the collector in [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js) with this exact shape:

```js
export async function collectReasoningArtifacts(runDir, decisions, fsImpl = fs) {
  const artifacts = [];

  for (const decision of decisions) {
    const verdict = JSON.parse(await fsImpl.readFile(join(runDir, `verdict-${decision.seq}.json`), "utf8"));
    if (!shouldCompileReasoningArtifact(decision, verdict)) continue;
    if (!verdict.artifact_candidate) continue;

    const proposal = await fsImpl.readFile(join(runDir, `proposal-${decision.seq}.md`), "utf8");
    let response = "";
    for (let round = 1; round <= (verdict.rounds || 0); round++) {
      try {
        response += `\n\n## Response Round ${round}\n\n`;
        response += await fsImpl.readFile(join(runDir, `response-${decision.seq}-round-${round}.md`), "utf8");
      } catch {}
    }

    artifacts.push({
      ...verdict.artifact_candidate,
      body: [
        "## Proposal",
        "",
        proposal,
        response,
        "",
        "## Verdict",
        "",
        "```json",
        JSON.stringify(verdict, null, 2),
        "```",
      ].join("\n"),
      created_at: new Date().toISOString(),
      source: "dev-loop",
    });
  }

  return artifacts;
}
```

This test asserts:

- compile gating stays in one place
- the loop can only produce artifacts through the same helper contract as DR

## Task 8: Final verification run

Run the exact suite after implementation:

```bash
npx vitest run tests/reasoning.test.js tests/reflect.test.js tests/userspace.test.js tests/dev-loop/reasoning.test.js
```

Then re-read the edited files and verify these four constraints explicitly:

1. No agent code imports from `scripts/dev-loop/`.
2. All helper logic lives in [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js).
3. [scripts/dev-loop/loop.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/loop.mjs) imports from [lib/reasoning.js](/home/swami/swayambhu/repo/lib/reasoning.js).
4. Every task above is test-first: test to write, code to implement, assertion to satisfy.

If any of those fail, revise before implementation starts.

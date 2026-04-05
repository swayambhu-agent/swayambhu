# DR Self-Modification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable deep-reflect to modify config, prompts, and code through the existing output format.

**Architecture:** Widen the `applyDrResults` key filter to allow `config:*` and `prompt:*`, add deliberation safety gate for prompt writes, expand DR's context tarball, and update the DR prompt. No new tools or mechanisms — unblocking what's already designed.

**Tech Stack:** Node.js, Cloudflare Workers KV, vitest

---

### Task 1: Add deliberation requirement for prompt writes

**Files:**
- Modify: `kernel.js:683-697` (inside `_gateSystem`)
- Test: `tests/kernel.test.js:2127-2153` (deliberation tests section)

- [ ] **Step 1: Write failing tests for prompt deliberation**

Add these tests after the existing principle deliberation tests in `tests/kernel.test.js` (after line ~2153):

```javascript
it("kvWriteGated rejects prompt: writes without deliberation", async () => {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async () => {});
  const result = await kernel.kvWriteGated(
    { op: "put", key: "prompt:plan", value: "new plan prompt" },
    "deep-reflect"
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("deliberation");
});

it("kvWriteGated allows prompt: writes with deliberation in deep-reflect", async () => {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async () => {});
  const deliberation = "The plan prompt lacks autonomous agent framing, causing the planner to reason as a reactive chatbot when desires are empty. Adding a single paragraph establishing that desires emerge from DR, not user input. This prevents the awaiting user input failure mode.";
  const result = await kernel.kvWriteGated(
    { op: "put", key: "prompt:plan", value: "updated plan prompt", deliberation },
    "deep-reflect"
  );
  expect(result.ok).toBe(true);
});

it("kvWriteGated allows config: writes without deliberation in deep-reflect", async () => {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async () => {});
  const result = await kernel.kvWriteGated(
    { op: "put", key: "config:defaults", value: { session_budget: { max_cost: 0.20 } } },
    "deep-reflect"
  );
  expect(result.ok).toBe(true);
});

it("kvWriteGated rejects prompt: delete without deliberation", async () => {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async () => {});
  const result = await kernel.kvWriteGated(
    { op: "delete", key: "prompt:deep_reflect" },
    "deep-reflect"
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("deliberation");
});

it("kvWriteGated rejects prompt: patch without deliberation", async () => {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async () => {});
  await kernel.kv.put("prompt:plan", "old text here");
  const result = await kernel.kvWriteGated(
    { op: "patch", key: "prompt:plan", old_string: "old text", new_string: "new text" },
    "deep-reflect"
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("deliberation");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js`
Expected: First test FAILS (prompt write without deliberation currently succeeds). Second and third should pass.

- [ ] **Step 3: Add deliberation check for prompt: keys**

In `kernel.js`, inside `_gateSystem` (after the `config:model_capabilities` check at line ~697, before the per-session limit at line ~699):

```javascript
// Prompt changes require deliberation — prompts are read live and shape
// all LLM behavior. Deleting prompt:deep_reflect would halt DR entirely.
if (key.startsWith("prompt:") && (!op.deliberation || op.deliberation.length < 200)) {
  return { ok: false, error: `Prompt changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})` };
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test -- tests/kernel.test.js`
Expected: All pass, including the new prompt deliberation tests.

- [ ] **Step 5: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: add deliberation requirement for prompt: writes in _gateSystem"
```

---

### Task 2: Widen applyDrResults key filter

**Files:**
- Modify: `userspace.js:876-879` (the `ops` filter in `applyDrResults`)
- Modify: `userspace.js` (export `applyDrResults` for testing — add to existing exports)
- Test: `tests/userspace.test.js`

- [ ] **Step 1: Export applyDrResults for testing**

In `userspace.js`, find `async function applyDrResults(K, state, output)` (line ~873)
and change from:

```javascript
async function applyDrResults(K, state, output) {
```

To:

```javascript
export async function applyDrResults(K, state, output) {
```

- [ ] **Step 2: Write failing tests**

In `tests/userspace.test.js`, add:

```javascript
import { applyDrResults } from '../userspace.js';

describe("applyDrResults key filter", () => {
  function mockK(writes = []) {
    return {
      getExecutionId: async () => "x_test",
      kvWriteGated: async (op, ctx) => { writes.push({ key: op.key, ctx }); return { ok: true }; },
      kvWriteSafe: async () => {},
      karmaRecord: async () => {},
      stageCode: async () => {},
      signalDeploy: async () => {},
    };
  }

  it("passes config: and prompt: operations to kvWriteGated", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "config:defaults", op: "put", value: { max_cost: 0.20 } },
        { key: "prompt:plan", op: "put", value: "new prompt", deliberation: "x".repeat(201) },
        { key: "pattern:test", op: "put", value: { pattern: "test", strength: 0.5 } },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(3);
    expect(writes.map(w => w.key)).toEqual(["config:defaults", "prompt:plan", "pattern:test"]);
    expect(writes.every(w => w.ctx === "deep-reflect")).toBe(true);
  });

  it("filters out kernel: and other disallowed keys", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "kernel:secret", op: "put", value: "hacked" },
        { key: "karma:fake", op: "put", value: "injected" },
        { key: "sealed:data", op: "put", value: "leaked" },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(0);
  });

  it("still passes pattern/desire/tactic/principle as before", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "pattern:foo", op: "put", value: { pattern: "x", strength: 0.5 } },
        { key: "desire:bar", op: "put", value: { description: "x" } },
        { key: "tactic:baz", op: "put", value: { tactic: "x" } },
        { key: "principle:qux", op: "put", value: "x", deliberation: "x".repeat(201) },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run tests — first test should FAIL (config/prompt filtered out)**

Run: `npm test -- tests/userspace.test.js`
Expected: First test FAILS — current filter doesn't allow config:/prompt:.

- [ ] **Step 4: Widen the filter in userspace.js**

Change `userspace.js` line 876-879 from:

```javascript
const ops = (output.kv_operations || []).filter(op =>
  op.key?.startsWith("pattern:") || op.key?.startsWith("desire:") ||
  op.key?.startsWith("tactic:") || op.key?.startsWith("principle:")
);
```

To:

```javascript
const ops = (output.kv_operations || []).filter(op =>
  op.key?.startsWith("pattern:") || op.key?.startsWith("desire:") ||
  op.key?.startsWith("tactic:") || op.key?.startsWith("principle:") ||
  op.key?.startsWith("config:") || op.key?.startsWith("prompt:")
);
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass. The kernel's `_gateSystem` already handles these prefixes — we're just letting them through the userspace filter.

- [ ] **Step 5: Commit**

```bash
git add userspace.js
git commit -m "feat: widen applyDrResults to allow config: and prompt: writes from DR"
```

---

### Task 3: Expand DR context tarball

**Files:**
- Modify: `userspace.js:807-813` (context_keys in `dispatchDr`)

- [ ] **Step 1: Update context_keys in dispatchDr**

Change `userspace.js` lines 807-813 from:

```javascript
context_keys: [
  "pattern:*", "experience:*", "desire:*", "tactic:*",
  "action:*",
  "principle:*", "config:defaults", "config:tool_registry",
  "kernel:source_map",
  "reflect:1:*", "last_reflect",
],
```

To:

```javascript
context_keys: [
  "pattern:*", "experience:*", "desire:*", "tactic:*",
  "action:*", "principle:*",
  "config:defaults", "config:models", "config:model_capabilities",
  "config:tool_registry", "config:event_handlers",
  "prompt:plan", "prompt:act", "prompt:reflect", "prompt:communication",
  "kernel:source_map",
  "reflect:1:*", "last_reflect",
],
```

Note: `tool:*:meta` is NOT included because `start_job.js` only supports
trailing-`*` prefix globs (e.g. `tool:*` would match `tool:foo:code` too).
DR already gets `config:tool_registry` which has tool descriptions and
schemas — sufficient for reasoning about tool capabilities.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All pass. This only changes what keys are packed into the DR tarball — no behavioral change.

- [ ] **Step 3: Commit**

```bash
git add userspace.js
git commit -m "feat: expand DR context tarball with prompts and config keys"
```

---

### Task 4: Update DR prompt

**Files:**
- Modify: `prompts/deep_reflect.md`

- [ ] **Step 1: Read current prompt**

Read `prompts/deep_reflect.md` in full to understand the current structure before modifying.

- [ ] **Step 2: Update kv_operations documentation in output section**

Find the output section (around line 136):

```markdown
"kv_operations": [
  // pattern, desire, tactic, and (rarely) principle changes
],
```

Change to:

```markdown
"kv_operations": [
  // pattern, desire, tactic, principle, config, and prompt changes
],
```

- [ ] **Step 3: Add config/prompt modification section**

Add before the `## Output` section:

```markdown
## Config and Prompt Modification

You can propose changes to config:* and prompt:* keys via kv_operations.
Your context tarball includes the current prompts and config — read them
before proposing changes.

When to modify config:
- Observed performance data justifies a parameter change (e.g. model choice,
  budget split, interval timing)
- A config value contradicts observed behavior or principles

When to modify prompts:
- The agent consistently misframes its situation due to prompt wording
- A prompt is missing context the agent needs for correct reasoning
- A prompt contradicts the cognitive architecture design

Requirements:
- prompt:* changes require a deliberation field (200+ chars) explaining
  why the change is needed and what behavior it will produce
- Be conservative — small, targeted changes. Don't rewrite entire prompts.
- Prefer patch over put when changing a specific section.
- Changes take effect on the next session (prompts are read live from KV).

Example:
{ "key": "config:defaults", "op": "patch",
  "old_string": "\"reflect_reserve_pct\": 0.33",
  "new_string": "\"reflect_reserve_pct\": 0.40" }

{ "key": "prompt:plan", "op": "patch",
  "old_string": "decide what single action to take",
  "new_string": "decide what single action to take — or do nothing",
  "deliberation": "The plan prompt omits the no_action framing, causing
  the planner to force unnecessary actions when no desire gap is closable.
  Sessions 4-8 show repeated low-value actions that waste budget. Adding
  the explicit 'or do nothing' option aligns with the no_action code path
  in userspace.js and the cognitive architecture's stance that inaction
  is a valid choice." }
```

- [ ] **Step 4: Update KV with new prompt**

```bash
node scripts/write-kv.mjs prompt:deep_reflect prompts/deep_reflect.md
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All pass. Prompt changes don't affect tests.

- [ ] **Step 6: Commit**

```bash
git add prompts/deep_reflect.md
git commit -m "feat: document config/prompt self-modification in DR prompt"
```

---

### Task 5: Integration verification

**Files:**
- No new files — manual verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Verify kernel safety gates work end-to-end**

Manually test with read-kv/write-kv that the safety model is intact:

```bash
# Verify prompt:deep_reflect is readable
node scripts/read-kv.mjs prompt:deep_reflect | head -5

# Verify config:defaults is readable
node scripts/read-kv.mjs config:defaults | head -5
```

- [ ] **Step 3: Cold-start and trigger a session to verify nothing broke**

```bash
# Restart workers to pick up userspace.js changes
pkill -9 -f workerd; sleep 3

# Start the loop for one cycle
node scripts/dev-loop/loop.mjs --once --cold-start
```

Verify: session completes cleanly, DR dispatches with expanded context (check karma for `dr_dispatched` event).

- [ ] **Step 4: Final commit with all changes**

If any files were missed in individual commits:

```bash
git add -A
git status  # verify only expected files
git commit -m "feat: enable DR self-modification for config, prompts, and code"
```

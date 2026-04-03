# Cognitive Tiers and Desire Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tactics tier (agent-earned behavioral rules), make principles mutable with high friction, and formalize desire as always-positive, always-expanding, and append-only.

**Architecture:** Move `principle:*` from immutable to protected tier with deliberation gate. Add `tactic:*` as a new protected-tier KV prefix, loaded at boot and injected into plan+act LLM calls only. Update the DR prompt with T operator (tactics), revised D operator (expansion, always-positive, append-only), and principle modification permission. Update eval, schema, dashboard, and architecture spec to remove avoidance.

**Tech Stack:** Cloudflare Workers (kernel.js), KV storage, React dashboard SPA.

## IMPORTANT: Codex Review Corrections

An adversarial review found 10 execution-level bugs in this plan.
Implementers MUST apply these corrections:

**1. planPhase missing `step` (Task 2):** `planPhase` at userspace.js:144
and :157 never passes `step` to `callLLM`. Add `step: "plan"` to both
`callLLM` calls in `planPhase` (the initial call and the retry). Without
this, tactics injection keyed off `step` won't fire for real plan calls.

**2. applyDrResults drops patch/deliberation (Task 3/4):** At
userspace.js:814-816, `applyDrResults` rewrites all non-delete ops to
`{ op: "put", value }`, dropping `patch`, `old_string`, `new_string`,
and `deliberation`. To support principle refinement, pass through the
raw op shape instead of normalizing: if `op.op` is `"patch"`, preserve
`old_string`, `new_string`, and `deliberation`. If `op.op` is `"put"`,
preserve `deliberation`.

**3. makeKernel returns `{ kernel, env }` not `{ kernel, kv }` (Tasks 2,8):**
All test code must use `const { kernel, env } = makeKernel()` and access
KV via `env.KV`, not `kv`.

**4. Additional immutability tests at lines 2128-2143 (Task 1):** The plan
only fixes tests around lines 1117/1159. Also update lines 2128-2143 which
assert `principle:*` is immutable and `kvWriteSafe` throws "immutable".
After the change, `kvWriteSafe` should throw "system key" (protected, not
immutable), and `kvWriteGated` should succeed with deliberation.

**5. applyDrResults not exported (Task 4):** `applyDrResults` is internal
to `userspace.js` and not exported. Test it indirectly through integration
tests or export it for testing.

**6. Mock kernel has no `K._writes` (Task 4):** The mock at
`tests/helpers/mock-kernel.js` uses `_kv` store and spy functions, not
`K._writes`. Match the existing mock pattern.

**7. Mock kernel principle/tactic patterns (Task 4):** Update
`tests/helpers/mock-kernel.js` to include `tactic:*` in its system-key
patterns and move `principle:*` from immutable to protected.

**8. MindTab type-driven rendering (Task 6):** `MindTab.jsx` classifies
entities by type (principle/desire/samskara). Adding tactics requires a
tactic type handler, color, and sidebar section — not just passing data.

**9. UI files reference avoidance (Task 5):** `MindTab.jsx` (lines 124,
158, 193) and `ReflectionsTab.jsx` (line 154) hard-code
`direction === 'avoidance'`. Remove these alongside the schema change.

**10. Architecture spec incomplete update (Task 5):** The spec still says
"Three agent operators" and lists `principle:*` under `immutable`. Update
both the operator count and the key tier table.

---

### Task 1: Move principles from immutable to protected tier

**Files:**
- Modify: `kernel.js:60-69` (DEFAULT_KEY_TIERS)
- Modify: `kernel.js:670-690` (_gateSystem — add deliberation gate for principles)
- Modify: `scripts/seed-local-kv.mjs:65-75` (seeded key_tiers)
- Modify: `tests/kernel.test.js:1117-1124,1159-1168` (immutability tests)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Update DEFAULT_KEY_TIERS in kernel.js**

In `kernel.js` line 61, move `"principle:*"` from `immutable` to `protected`:

```js
  static DEFAULT_KEY_TIERS = {
    immutable: ["dharma", "patron:public_key"],
    kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
    protected: [
      "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
      "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
      "secret:*", "samskara:*", "skill:*", "task:*",
      "providers", "wallets", "patron:contact", "patron:identity_snapshot",
      "desire:*", "principle:*", "tactic:*",
    ],
  };
```

- [ ] **Step 2: Add deliberation gate for principles in _gateSystem**

In `kernel.js` `_gateSystem` method (around line 682), after the `config:model_capabilities` deliberation check, add a similar check for `principle:*`:

```js
    // Principle changes require deliberation — high friction to prevent casual modification
    if (key.startsWith("principle:")) {
      if (!op.deliberation || op.deliberation.length < 200) {
        return { ok: false, error: `Principle changes require deliberation (min 200 chars, got ${op.deliberation?.length || 0})` };
      }
    }
```

- [ ] **Step 3: Update seeded key_tiers in seed script**

In `scripts/seed-local-kv.mjs` lines 65-75, make the same change — move `principle:*` from immutable to protected, add `tactic:*`:

```js
await put("kernel:key_tiers", {
  immutable: ["dharma", "patron:public_key"],
  kernel_only: ["karma:*", "sealed:*", "event:*", "event_dead:*", "kernel:*", "patron:direct"],
  protected: [
    "config:*", "prompt:*", "tool:*", "provider:*", "channel:*",
    "hook:*", "contact:*", "contact_platform:*", "code_staging:*",
    "secret:*", "skill:*", "task:*",
    "providers", "wallets", "patron:contact", "patron:identity_snapshot",
    "desire:*", "samskara:*", "principle:*", "tactic:*",
  ],
}, "json", "KV write-protection tiers — kernel-only, agent cannot modify");
```

- [ ] **Step 4: Update tests**

In `tests/kernel.test.js`, find tests that assert `principle:*` is immutable (lines 1120-1121, 1167-1168) and change them to assert it's a system key (protected) but NOT immutable:

```js
// Was: expect(kernel.isImmutableKey("principle:honesty")).toBe(true);
expect(kernel.isImmutableKey("principle:honesty")).toBe(false);
expect(kernel.isSystemKey("principle:honesty")).toBe(true);
```

Add a test for principle deliberation gate:

```js
it("principle changes require 200-char deliberation", async () => {
  const { kernel } = makeKernel();
  const result = await kernel.kvWriteGated(
    { key: "principle:test", op: "put", value: "new value", deliberation: "too short" },
    "deep-reflect"
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("deliberation");
});

it("principle changes succeed with sufficient deliberation", async () => {
  const { kernel } = makeKernel();
  const deliberation = "A".repeat(200);
  const result = await kernel.kvWriteGated(
    { key: "principle:test", op: "put", value: "refined value", deliberation },
    "deep-reflect"
  );
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add kernel.js scripts/seed-local-kv.mjs tests/kernel.test.js
git commit -m "feat: move principles from immutable to protected tier with deliberation gate"
```

---

### Task 2: Add tactic loading and scoped injection to kernel

**Files:**
- Modify: `kernel.js:43` (constructor — add tactics cache)
- Modify: `kernel.js:120-131` (loadEagerConfig — load tactics)
- Modify: `kernel.js:1341-1367` (callLLM — inject tactics for plan+act)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Add tests for tactic loading and injection**

```js
describe("tactics", () => {
  it("loads tactics at boot", async () => {
    const { kernel, kv } = makeKernel();
    await kv.put("tactic:explore-first", JSON.stringify({
      slug: "explore-first",
      description: "Try one exploratory tool use before planning no_action.",
    }));
    await kernel.loadEagerConfig();
    expect(kernel.tactics).toBeDefined();
    expect(kernel.tactics["tactic:explore-first"]).toBeDefined();
  });

  it("injects tactics into plan step LLM calls", async () => {
    const { kernel, kv } = makeKernel();
    await kv.put("tactic:explore-first", JSON.stringify({
      slug: "explore-first",
      description: "Try one exploratory tool use before planning no_action.",
    }));
    await kernel.loadEagerConfig();

    let capturedMessages;
    kernel.PROVIDERS = { 'provider:llm': {
      meta: { secrets: [] },
      call: async (req) => {
        capturedMessages = req.messages;
        return { content: "test", usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true };
      },
    }};

    await kernel.callLLM({
      model: "test", systemPrompt: "test", messages: [{ role: "user", content: "test" }],
      step: "act_0",
    });

    const systemMsg = capturedMessages[0].content;
    expect(systemMsg).toContain("[TACTICS]");
    expect(systemMsg).toContain("explore-first");
  });

  it("does NOT inject tactics into review step", async () => {
    const { kernel, kv } = makeKernel();
    await kv.put("tactic:explore-first", JSON.stringify({
      slug: "explore-first",
      description: "Try one exploratory tool use.",
    }));
    await kernel.loadEagerConfig();

    let capturedMessages;
    kernel.PROVIDERS = { 'provider:llm': {
      meta: { secrets: [] },
      call: async (req) => {
        capturedMessages = req.messages;
        return { content: "test", usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true };
      },
    }};

    await kernel.callLLM({
      model: "test", systemPrompt: "test", messages: [{ role: "user", content: "test" }],
      step: "review",
    });

    const systemMsg = capturedMessages[0].content;
    expect(systemMsg).not.toContain("[TACTICS]");
  });

  it("does NOT inject tactics into chat mode", async () => {
    const { kernel, kv } = makeKernel();
    kernel.mode = "chat";
    await kv.put("tactic:test", JSON.stringify({ slug: "test", description: "test" }));
    await kernel.loadEagerConfig();

    let capturedMessages;
    kernel.PROVIDERS = { 'provider:llm': {
      meta: { secrets: [] },
      call: async (req) => {
        capturedMessages = req.messages;
        return { content: "test", usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true };
      },
    }};

    await kernel.callLLM({
      model: "test", systemPrompt: "test", messages: [{ role: "user", content: "test" }],
    });

    const systemMsg = capturedMessages[0].content;
    expect(systemMsg).not.toContain("[TACTICS]");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js`
Expected: FAIL

- [ ] **Step 3: Add tactics to constructor**

In `kernel.js` constructor, after `this.principles = null;` (line 43):

```js
    this.tactics = null;       // Cached tactics (loaded at boot, agent-managed via DR)
```

- [ ] **Step 4: Add loadTactics method and wire into loadEagerConfig**

After the `loadPrinciples` method (around line 143), add:

```js
  async loadTactics() {
    this.tactics = {};
    const keys = await this.kvListAll({ prefix: 'tactic:' });
    for (const { name: key } of keys) {
      const value = await this.kvGet(key);
      if (value !== null) this.tactics[key] = value;
    }
  }
```

In `loadEagerConfig`, after `await this.loadPrinciples();` (line 131), add:

```js
    await this.loadTactics();
```

- [ ] **Step 5: Add tactic injection in callLLM**

In `kernel.js` `callLLM`, after the principles block construction (around line 1362), add tactic injection scoped to plan+act steps:

```js
    // Tactics injected only for plan and act steps — action-selection
    // heuristics that shouldn't contaminate eval, chat, or DR.
    let tacticsBlock = '';
    const isPlanOrAct = step && (step.startsWith('act') || step === 'plan' || step === 'plan_retry');
    if (isPlanOrAct && this.tactics && Object.keys(this.tactics).length > 0) {
      const entries = Object.entries(this.tactics)
        .map(([key, val]) => {
          const slug = key.replace('tactic:', '');
          const desc = typeof val === 'string' ? val : val.description || JSON.stringify(val);
          return `[${slug}]\n${desc}\n[/${slug}]`;
        }).join('\n');
      tacticsBlock = `[TACTICS]\n${entries}\n[/TACTICS]\n\n`;
    }

    const fullSystemPrompt = systemPrompt
      ? dharmaPrefix + principlesBlock + tacticsBlock + systemPrompt
      : (dharmaPrefix + principlesBlock + tacticsBlock) || null;
```

Replace the existing `fullSystemPrompt` construction (lines 1365-1367) with the version above that includes `tacticsBlock`.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: add tactic loading and scoped injection (plan+act only)"
```

---

### Task 3: Update DR prompt — T operator, D operator properties, principle permission

**Files:**
- Modify: `prompts/deep_reflect.md`

- [ ] **Step 1: Add T operator section**

In `prompts/deep_reflect.md`, after the D operator section and before the Output section, add:

```markdown
## T operator: Tactic Management

Tactics are practical approaches learned from experience — behavioral
rules that guide action selection. Unlike principles (operational
ethics that apply everywhere), tactics are situation-specific moves
for planning and acting.

If a rule applies to all contexts (communication, reflection,
evaluation), it belongs as a principle, not a tactic.

**Create** when a pattern in experiences suggests a behavioral rule
that would improve future act sessions.
**Refine** when new experience sharpens the rule.
**Retire** when the tactic is no longer useful or superseded.

Format:
{ "key": "tactic:{slug}", "value": {
    "slug": "...",
    "description": "behavioral rule — when X, do Y",
    "source_principles": ["..."],
    "created_at": "ISO8601",
    "updated_at": "ISO8601"
} }
{ "key": "tactic:{slug}", "op": "delete" }
```

- [ ] **Step 2: Update D operator with append-only and principle modification**

In the D operator section, after the Expand action, add:

```markdown
Desires are append-only: never modify an existing desire's description.
When a desire is fulfilled, create a NEW desire with a new slug and
broader scope. The fulfilled desire stays as a historical record.

## Principle refinement

You can propose changes to principles via kv_operations when
experience reveals a principle needs sharpening. Principle changes
require a `deliberation` field (min 200 chars) explaining why.

Format:
{ "key": "principle:{name}", "op": "patch", "old_string": "...", "new_string": "...",
  "deliberation": "200+ char explanation of why this refinement is warranted..." }

Use this rarely. Principles are operational ethics — they should change
slowly, only when experience provides strong evidence.
```

- [ ] **Step 3: Update output schema to include tactics**

Change the output section comment from `// samskara and desire changes only` to:

```markdown
## Output

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // samskara, desire, tactic, and (rarely) principle changes
  ],
  "reflection": "what changed and why",
  "note_to_future_self": "what to watch in the next deep-reflect",
  "next_reflect": {
    "after_sessions": 20,
    "after_days": 7
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add prompts/deep_reflect.md
git commit -m "feat: add T operator, append-only desires, principle refinement to DR prompt"
```

---

### Task 4: Update applyDrResults to handle tactics

**Files:**
- Modify: `userspace.js:807-809` (applyDrResults filter)
- Modify: `userspace.js:740-744` (DR dispatch context_keys)
- Test: `tests/userspace.test.js`

- [ ] **Step 1: Add test for tactic operations in DR results**

Add to `tests/userspace.test.js`:

```js
describe("applyDrResults with tactics", () => {
  it("applies tactic operations from DR output", async () => {
    const K = makeMockK({});
    const state = { defaults: {} };
    const output = {
      kv_operations: [
        { key: "tactic:explore-first", value: { slug: "explore-first", description: "Try one probe before no_action." } },
        { key: "desire:test", value: { slug: "test", direction: "approach", description: "test" } },
      ],
      reflection: "test",
    };
    await applyDrResults(K, state, output);
    // Both should be applied (not filtered out)
    const writes = K._writes || [];
    expect(writes.some(w => w.key === "tactic:explore-first")).toBe(true);
    expect(writes.some(w => w.key === "desire:test")).toBe(true);
  });
});
```

(Note: this test's exact shape depends on how `makeMockK` works in the existing test file. Read the file to match the existing mock pattern.)

- [ ] **Step 2: Update applyDrResults filter**

In `userspace.js` line 807-809, change the filter to include `tactic:*`:

```js
  const ops = (output.kv_operations || []).filter(op =>
    op.key?.startsWith("samskara:") || op.key?.startsWith("desire:") || op.key?.startsWith("tactic:") || op.key?.startsWith("principle:")
  );
```

- [ ] **Step 3: Add tool_registry to DR dispatch context_keys**

In `userspace.js` lines 740-744, add `config:tool_registry` to the context_keys array:

```js
          context_keys: [
            "samskara:*", "experience:*", "desire:*", "tactic:*",
            "principle:*", "config:defaults", "config:tool_registry",
            "reflect:1:*", "last_reflect",
          ],
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add userspace.js tests/userspace.test.js
git commit -m "feat: allow tactic and principle ops in DR results, add tool_registry to DR context"
```

---

### Task 5: Remove avoidance from eval, schema, and architecture spec

**Files:**
- Modify: `eval.js:33-39,78-80` (remove avoidance-specific logic)
- Modify: `tests/schema.test.js:11` (remove avoidance from validation)
- Modify: `swayambhu-cognitive-architecture.md` (update desire definition)

- [ ] **Step 1: Update schema validation**

In `tests/schema.test.js` line 11, change:

```js
// Was: if (d.direction !== "approach" && d.direction !== "avoidance")
if (d.direction !== "approach")
  errors.push("direction must be 'approach'");
```

- [ ] **Step 2: Check eval.js for avoidance-specific logic**

Read `eval.js` lines 33-39 and 78-80. The `direction` field there refers to NLI classification direction (entailment/contradiction), NOT desire direction (approach/avoidance). These are different concepts and should NOT be changed. Verify this by reading the code, then leave eval.js unchanged.

- [ ] **Step 3: Update architecture spec**

In `swayambhu-cognitive-architecture.md`, find the desire definition (around line 43) and update:
- Change `d_t | Desires | Directional vectors — positive affinity (approach) or negative affinity (avoidance)` to `d_t | Desires | Approach vectors — always positive, always expanding`
- Find the bidirectional amplification text (around line 121) and update to reflect always-positive
- Add the expansion axiom: `D_p(ε, d_t) = d_{t+1} where |d_{t+1}| > |d_t|`
- Add append-only property
- Add tactics as a new entity in the symbols table
- Update principle mutability from "Never changes" to "High-friction changes via DR with deliberation"

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eval.js tests/schema.test.js swayambhu-cognitive-architecture.md
git commit -m "feat: remove avoidance from desires, update architecture spec with expansion + tactics"
```

---

### Task 6: Update dashboard API and SPA for tactics

**Files:**
- Modify: `dashboard-api/worker.js:89-145` (/mind endpoint)
- Modify: `site/patron/src/components/MindTab.jsx`

- [ ] **Step 1: Add tactics to /mind endpoint**

In `dashboard-api/worker.js`, inside the `/mind` endpoint handler (around line 90), alongside the existing desire and samskara loading, add tactic loading:

```js
      const tacticKeys = await kvListAll(env.KV, { prefix: "tactic:" });
      const tactics = {};
      for (const k of tacticKeys) {
        const val = await env.KV.get(k.name, "json");
        if (val) tactics[k.name] = val;
      }
```

Add `tactics` to the response JSON object.

- [ ] **Step 2: Add tactics rendering to MindTab**

In `site/patron/src/components/MindTab.jsx`, add a section that renders tactics alongside desires and samskaras. Follow the existing pattern for desires — show slug, description, and source_principles.

- [ ] **Step 3: Rebuild dashboard**

```bash
npm run build:dashboard
```

- [ ] **Step 4: Commit**

```bash
git add dashboard-api/worker.js site/patron/src/components/MindTab.jsx
git commit -m "feat: show tactics in dashboard mind tab"
```

---

### Task 7: Update plan prompt and classify function

**Files:**
- Modify: `prompts/plan.md` (add tactics documentation)
- Modify: `userspace.js` (classify function — add tactic:* to mind bucket)

- [ ] **Step 1: Update plan prompt**

In `prompts/plan.md`, add after the "How to decide" section:

```markdown
## Tactics

Your [TACTICS] block contains behavioral rules you've learned from
experience. These are injected into this prompt automatically. Follow
them — they represent patterns you've identified as effective.
```

- [ ] **Step 2: Add tactic:* to pulse classify buckets**

In `userspace.js`, find the BUCKET_MAP (around line 843) and add `tactic:*` to the mind bucket:

```js
  [['desire:', 'samskara:', 'experience:', 'tactic:'], 'mind'],
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add prompts/plan.md userspace.js
git commit -m "feat: document tactics in plan prompt, add tactic:* to pulse mind bucket"
```

---

### Task 8: Integration test — full tactic flow

**Files:**
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write integration test**

```js
describe("tactic integration", () => {
  it("full flow: tactic written via kvWriteGated, loaded at boot, injected into plan call", async () => {
    const { kernel, kv } = makeKernel();
    await kernel.loadEagerConfig();

    // Write a tactic via kvWriteGated (simulating DR)
    const result = await kernel.kvWriteGated(
      { key: "tactic:test-tactic", op: "put", value: { slug: "test-tactic", description: "Always greet politely." } },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);

    // Reload to pick up the new tactic
    await kernel.loadTactics();
    expect(kernel.tactics["tactic:test-tactic"]).toBeDefined();

    // Verify it appears in a plan-step LLM call
    let capturedSystem;
    kernel.PROVIDERS = { 'provider:llm': {
      meta: { secrets: [] },
      call: async (req) => {
        capturedSystem = req.messages[0]?.content;
        return { content: "test", usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true };
      },
    }};

    await kernel.callLLM({
      model: "test", systemPrompt: "plan context", messages: [{ role: "user", content: "test" }],
      step: "plan",
    });

    expect(capturedSystem).toContain("[TACTICS]");
    expect(capturedSystem).toContain("test-tactic");
    expect(capturedSystem).toContain("Always greet politely");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit and push**

```bash
git add tests/kernel.test.js
git commit -m "test: add tactic integration test"
git push
```

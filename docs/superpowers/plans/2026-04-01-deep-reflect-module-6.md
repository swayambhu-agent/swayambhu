# Module 6: Deep Reflect on Akash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move deep-reflect from in-Worker execution ($0.50/run) to async CC analysis jobs on akash (zero marginal cost). Add M/D operator prompts. Eliminate cold start special case.

**Architecture:** Deep-reflect dispatches via existing `start_job` tool (cc_analysis type). Results stored in KV, applied by next session via `applyReflectOutput`. Cold start eliminated — first session orients naturally from principles + circumstances.

**Tech Stack:** Cloudflare Workers (JS), Vitest, existing async-jobs infrastructure (start_job, collect_jobs, /job-complete)

**Spec:** `docs/superpowers/specs/2026-04-01-deep-reflect-module-6-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `reflect.js` | Modify (~lines 200-220, ~570) | runReflect dispatches to akash, delete coldStart, add dispatchDeepReflect |
| `session.js` | Modify (~lines 352-368, ~437-442) | Delete cold start branch, add job_complete processing, per-depth dispatch |
| `scripts/seed-local-kv.mjs` | Modify | Seed `prompt:deep_reflect` |
| `config/defaults.json` | Modify | Add deep_reflect.ttl_minutes, jobs.cc_model |
| `prompts/deep_reflect.md` | Create | M/D operator prompt template |
| `tests/session.test.js` | Modify | Update cold start tests, add job_complete tests |
| `tests/reflect.test.js` | Modify (if exists) | Add dispatch tests |
| `CLAUDE.md` | Modify | Document deep-reflect on akash |

---

## Task 1: Delete cold start special case

**Files:**
- Modify: `session.js` (~lines 352-368)
- Modify: `reflect.js` (~lines 200-212, ~570-585)
- Modify: `tests/session.test.js`

- [ ] **Step 1: Read session.js cold start branch**

Read `session.js` lines 352-368 to see the exact cold start code to delete.

- [ ] **Step 2: Delete cold start branch in session.js**

Remove the entire block:
```javascript
  // 3. Cold start: no desires → deep reflect to derive them
  if (Object.keys(desires).length === 0) {
    await K.karmaRecord({ event: "cold_start", reason: "no desires found" });

    const state = { defaults, modelsConfig };
    await runReflect(K, state, 1, { coldStart: true });

    // Schedule next session soon so we can act on new desires
    const interval = 60; // seconds
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + interval * 1000).toISOString(),
      interval_seconds: interval,
      reason: "post_cold_start",
    });

    return;
  }
```

The plan phase naturally handles `d = ∅` — the model sees empty desires alongside principles and circumstances and orients.

- [ ] **Step 3: Delete coldStart handling in reflect.js**

In `runReflect` (~line 200), remove the `isColdStart` branch:

Change:
```javascript
  // Cold start: derive desires from principles alone
  const isColdStart = context?.coldStart === true;

  const prompt = isColdStart
    ? coldStartPrompt()
    : await loadReflectPrompt(K, state, depth);
  const initialCtx = isColdStart
    ? { userMessage: "Begin. Derive initial desires from principles.", templateVars: {} }
    : await gatherReflectContext(K, state, depth, context);
```

To:
```javascript
  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
```

- [ ] **Step 4: Delete coldStartPrompt function in reflect.js**

Find and delete the `coldStartPrompt()` function (added in Module 3). Search for `function coldStartPrompt` and remove the entire function.

- [ ] **Step 5: Update cold start tests in tests/session.test.js**

The existing cold start tests check that:
- runReflect is called with coldStart: true
- session_schedule is written with post_cold_start
- callLLM is not called

Replace with a test that verifies the normal flow runs when desires are empty:

```javascript
  describe("zero desires (first boot)", () => {
    it("runs normal plan→act cycle even with no desires", async () => {
      // kvList returns empty for desire: prefix
      K.kvList = vi.fn(async (opts) => {
        if (opts?.prefix === "desire:") return { keys: [], list_complete: true };
        if (opts?.prefix === "assumption:") return { keys: [], list_complete: true };
        return { keys: [], list_complete: true };
      });

      // Plan returns no_action (model orients, finds nothing to do yet)
      K.callLLM = vi.fn(async () => ({
        content: JSON.stringify({ no_action: true, reason: "Orienting — no desires yet, observing environment" }),
        cost: 0.01, toolCalls: null,
      }));

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Plan was called (not skipped)
      expect(K.callLLM).toHaveBeenCalled();
      // No cold_start karma event
      expect(K.karmaRecord).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "cold_start" })
      );
    });

    it("can precipitate an action even with no desires (principles guide)", async () => {
      K.kvList = vi.fn(async (opts) => {
        if (opts?.prefix === "desire:") return { keys: [], list_complete: true };
        if (opts?.prefix === "assumption:") return { keys: [], list_complete: true };
        return { keys: [], list_complete: true };
      });

      let callCount = 0;
      K.callLLM = vi.fn(async ({ step }) => {
        callCount++;
        if (step?.includes("plan")) {
          return {
            content: JSON.stringify({
              action: "Orient: observe environment and available tools",
              success: "Understanding of current state",
              relies_on: [], defer_if: "", no_action: false,
            }),
            cost: 0.01, toolCalls: null,
          };
        }
        // Review
        return {
          content: JSON.stringify({
            assessment: "Oriented successfully",
            narrative: "First boot — observed environment, understood available tools and resources",
            salience_estimate: 0.9,
          }),
          cost: 0.01, toolCalls: null,
        };
      });

      K.runAgentTurn = vi.fn(async ({ messages }) => {
        messages.push({ role: "assistant", content: "Observed environment." });
        return { response: { content: "Observed environment." }, toolResults: [], cost: 0.01, done: true };
      });

      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

      // Full cycle ran
      expect(K.callLLM).toHaveBeenCalledTimes(2); // plan + review
      expect(K.runAgentTurn).toHaveBeenCalled(); // act
    });
  });
```

- [ ] **Step 6: Run all tests**

Run: `npm test`

Expected: All tests pass. Some old cold start tests may need removal if they assert the deleted behavior.

- [ ] **Step 7: Commit**

```bash
git add session.js reflect.js tests/session.test.js
git commit -m "refactor(m6): delete cold start special case

When d=∅, the first session orients naturally from principles +
circumstances. No synthetic desires, no synchronous deep-reflect,
no wasted first session. Awareness precedes desire."
```

---

## Task 2: Create M/D operator prompt

**Files:**
- Create: `prompts/deep_reflect.md`
- Modify: `scripts/seed-local-kv.mjs`

- [ ] **Step 1: Create the deep-reflect prompt**

Create `prompts/deep_reflect.md`:

```markdown
You are running deep-reflect for Swayambhu, a self-improving agent.

Read the context files in this directory:
- mu/ — statistical memory (confirmation/violation counts, cumulative surprise per check)
- experience/ — salient experiences (narratives, surprise scores, affinity vectors)
- desire/ — current desires (directional vectors the agent pursues)
- assumption/ — current assumptions (cached heuristics with TTL)
- principle/ — immutable principles (the agent's dharma)
- config/defaults.json — current configuration
- reflect/schedule/ — when each depth last ran

Run two operators in sequence:

## PHASE 1 — M operator: Assumption Evolution

Review μ (statistical memory). For each mu entry:
- High confirmation_count + low cumulative_surprise → this pattern is stable. Create a new assumption or extend an existing assumption's TTL.
- High violation_count + high cumulative_surprise → this pattern is broken. Expire the assumption (delete it or shorten TTL) so the act loop is forced to check actual state.
- New patterns: look for circumstances where the agent repeatedly checks something that could be assumed. Create new assumptions where cost(state_check) × frequency > cost(risk_of_wrong_assumption).

For new/extended assumptions, output:
{ "key": "assumption:{slug}", "value": { "slug": "...", "check": "...", "confidence": 0.0-1.0, "ttl_expires": "ISO8601", "source": "statistical", "created_at": "ISO8601" } }

For expired assumptions, output:
{ "key": "assumption:{slug}", "op": "delete" }

## PHASE 2 — D operator: Desire Evolution

Review ε (experiences) through the immutable lens of principles.
- Strengthen desires that experiences validate through principles
- Weaken or retire desires that experiences show are unproductive or misaligned with principles
- Create new desires if experiences + principles reveal unmet directional needs
- Each desire must trace to at least one principle (source_principles field)

For new/modified desires:
{ "key": "desire:{slug}", "value": { "slug": "...", "direction": "approach|avoidance", "description": "...", "source_principles": ["..."], "created_at": "ISO8601", "updated_at": "ISO8601" } }

For retired desires:
{ "key": "desire:{slug}", "op": "delete" }

## Output Format

Respond with ONLY a JSON object:
{
  "kv_operations": [
    // All assumption and desire changes from Phase 1 and Phase 2
  ],
  "reflection": "Narrative summary of what changed and why",
  "note_to_future_self": "What to pay attention to in the next deep-reflect",
  "next_reflect": {
    "after_sessions": 20,
    "after_days": 7
  }
}

Only output kv_operations for desire:* and assumption:* keys. Do not modify any other keys.
```

- [ ] **Step 2: Seed the prompt in seed-local-kv.mjs**

Find the prompts section in `scripts/seed-local-kv.mjs` and add:

```javascript
await put("prompt:deep_reflect", read("prompts/deep_reflect.md"), "text", "Deep-reflect M/D operator prompt — dispatched as CC analysis job");
```

- [ ] **Step 3: Run seed script to verify**

Run: `source .env && node scripts/seed-local-kv.mjs`

Expected: No errors. Prompt seeded.

- [ ] **Step 4: Verify**

Run: `node scripts/read-kv.mjs prompt:deep_reflect | head -5`

Expected: Shows the first lines of the prompt.

- [ ] **Step 5: Commit**

```bash
git add prompts/deep_reflect.md scripts/seed-local-kv.mjs
git commit -m "feat(m6): add M/D operator prompt for deep-reflect

Phase 1 (M): evolve assumptions from statistical memory.
Phase 2 (D): evolve desires from experiences through principles.
Stored as prompt:deep_reflect in KV, dispatched via start_job."
```

---

## Task 3: Update reflect.js — dispatch to akash

**Files:**
- Modify: `reflect.js` (~line 200)

- [ ] **Step 1: Read reflect.js runReflect function**

Read the current `runReflect` function to understand its full structure (after Task 1's cold start deletion).

- [ ] **Step 2: Split runReflect into dispatch vs in-Worker paths**

Replace the `runReflect` function:

```javascript
export async function runReflect(K, state, depth, context) {
  const { defaults } = state;

  // Dispatch as async job if akash jobs configured
  const jobsConfig = defaults?.jobs;
  if (jobsConfig?.base_url) {
    return dispatchDeepReflect(K, state, depth);
  }

  // Fallback: run in-Worker (no akash configured)
  return runReflectInWorker(K, state, depth, context);
}
```

- [ ] **Step 3: Rename current logic to runReflectInWorker**

The existing body of `runReflect` (after the lines you just replaced) becomes `runReflectInWorker`. This is the fallback path — identical to what was there before, just renamed:

```javascript
async function runReflectInWorker(K, state, depth, context) {
  const { defaults } = state;
  const sessionId = await K.getSessionId();

  const prompt = await loadReflectPrompt(K, state, depth);
  const initialCtx = await gatherReflectContext(K, state, depth, context);
  // ... rest of the existing runReflect body unchanged ...
}
```

Make it a non-exported function (just `async function`, not `export async function`).

- [ ] **Step 4: Add dispatchDeepReflect function**

Add after `runReflect`:

```javascript
async function dispatchDeepReflect(K, state, depth) {
  const { defaults } = state;

  // Load the M/D operator prompt
  const prompt = await K.kvGet("prompt:deep_reflect");
  if (!prompt) {
    await K.karmaRecord({ event: "deep_reflect_no_prompt", depth });
    return runReflectInWorker(K, state, depth, {});
  }

  // Dispatch via start_job tool
  const result = await K.executeToolCall({
    id: `dr_dispatch_${Date.now()}`,
    function: {
      name: "start_job",
      arguments: JSON.stringify({
        type: "cc_analysis",
        prompt,
        context_keys: [
          "mu:*", "experience:*", "desire:*", "assumption:*",
          "principle:*", "config:defaults", `reflect:schedule:${depth}`,
        ],
      }),
    },
  });

  if (result?.ok) {
    // Tag the job record as deep-reflect
    const jobRecord = await K.kvGet(`job:${result.job_id}`);
    if (jobRecord) {
      jobRecord.config = jobRecord.config || {};
      jobRecord.config.deep_reflect = true;
      jobRecord.config.depth = depth;
      await K.kvWriteSafe(`job:${result.job_id}`, jobRecord);
    }

    await K.karmaRecord({
      event: "deep_reflect_dispatched",
      job_id: result.job_id,
      depth,
    });
  } else {
    // Dispatch failed — fall back to in-Worker
    await K.karmaRecord({ event: "deep_reflect_dispatch_failed", error: result?.error });
    return runReflectInWorker(K, state, depth, {});
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: All pass. Existing reflect tests call `runReflect` which now checks for `jobs.base_url` in defaults — since test mocks don't set this, they fall through to `runReflectInWorker` (same behavior as before).

- [ ] **Step 6: Commit**

```bash
git add reflect.js
git commit -m "feat(m6): dispatch deep-reflect to akash via start_job

runReflect dispatches as cc_analysis job when jobs.base_url configured.
Falls back to in-Worker execution otherwise. Tags job record with
deep_reflect flag for collection."
```

---

## Task 4: Update session.js — collect results + per-depth dispatch

**Files:**
- Modify: `session.js` (~lines 437-442)
- Modify: `tests/session.test.js`

- [ ] **Step 1: Read session.js event processing and reflect dispatch**

Read session.js to find:
- Where events are processed (near the top of run(), after loading config)
- The reflect dispatch at the end of the session loop (~line 437-442)

- [ ] **Step 2: Add deep-reflect result collection**

After loading desires/assumptions and before the main loop, add job_complete processing:

```javascript
  // 2c. Process deep-reflect job completions from events
  let desires = await loadDesires(K);
  let assumptions = await loadAssumptions(K);

  for (const event of (events || [])) {
    if (event.type === "job_complete" && event.source?.job_id) {
      const job = await K.kvGet(`job:${event.source.job_id}`);
      if (job?.config?.deep_reflect) {
        // Check staleness
        const maxStale = defaults?.deep_reflect?.max_stale_sessions || 5;
        const sessionCount = await K.getSessionCount();
        const dispatchSession = job.config?.dispatch_session || 0;
        if (sessionCount - dispatchSession > maxStale) {
          await K.karmaRecord({ event: "deep_reflect_stale", job_id: job.id, age_sessions: sessionCount - dispatchSession });
          continue;
        }

        // Read result
        const resultKey = `job_result:${job.id}`;
        const jobResult = await K.kvGet(resultKey);
        if (jobResult?.result) {
          // Filter kv_operations to only desire:*/assumption:*
          const output = jobResult.result;
          if (output.kv_operations) {
            output.kv_operations = output.kv_operations.filter(op =>
              op.key?.startsWith("desire:") || op.key?.startsWith("assumption:")
            );
          }

          // Apply via existing applyReflectOutput
          const state = { defaults, modelsConfig };
          await applyReflectOutput(K, state, job.config.depth || 1, output, { fromJob: job.id });

          await K.karmaRecord({
            event: "deep_reflect_applied",
            job_id: job.id,
            operations: output.kv_operations?.length || 0,
          });

          // Re-snapshot (desires/assumptions may have changed)
          desires = await loadDesires(K);
          assumptions = await loadAssumptions(K);
        }
      }
    }
  }
```

Note: `desires` and `assumptions` need to be `let` not `const` for re-assignment. Check if they're already `let` — if not, change them.

Also add `applyReflectOutput` to the imports from reflect.js:

```javascript
import { runReflect, highestReflectDepthDue, isReflectDue, applyReflectOutput } from './reflect.js';
```

- [ ] **Step 3: Update reflect dispatch to per-depth**

Replace the single `highestReflectDepthDue` dispatch (~line 437-442):

```javascript
  // 8. Check deep-reflect due — dispatch per depth
  const state = { defaults, modelsConfig };
  const maxDepth = defaults?.execution?.max_reflect_depth || 1;
  for (let d = maxDepth; d >= 1; d--) {
    if (await isReflectDue(K, state, d)) {
      await runReflect(K, state, d, {});
    }
  }
```

Add `isReflectDue` to the reflect.js imports if not already there.

- [ ] **Step 4: Add tests for job_complete collection**

Add to `tests/session.test.js`:

```javascript
  describe("deep-reflect job collection", () => {
    it("applies deep-reflect job results from events", async () => {
      // Set up desires so we don't hit zero-desire state
      K.kvList = vi.fn(async (opts) => {
        if (opts?.prefix === "desire:") return {
          keys: [{ name: "desire:serve" }], list_complete: true,
        };
        if (opts?.prefix === "assumption:") return { keys: [], list_complete: true };
        return { keys: [], list_complete: true };
      });
      K.kvGet = vi.fn(async (key) => {
        if (key === "desire:serve") return { slug: "serve", direction: "approach", description: "Serve" };
        if (key === "config:defaults") return { session_budget: { max_cost: 0.01 } }; // low budget → no cycles
        if (key === "job:j_123") return {
          id: "j_123", type: "cc_analysis", status: "completed",
          config: { deep_reflect: true, depth: 1 },
        };
        if (key === "job_result:j_123") return {
          result: {
            kv_operations: [
              { key: "desire:grow", value: { slug: "grow", direction: "approach", description: "Grow" }, op: "put" },
            ],
            reflection: "Derived growth desire",
            next_reflect: { after_sessions: 20 },
          },
        };
        return null;
      });

      const events = [{
        type: "job_complete",
        source: { job_id: "j_123" },
      }];

      await run(K, { crashData: null, balances: {}, events, schedule: {} });

      // applyReflectOutput should have been called (via kvWriteGated)
      expect(K.kvWriteGated).toHaveBeenCalledWith(
        expect.objectContaining({ key: "desire:grow" }),
        "deep-reflect"
      );
    });

    it("filters non-desire/assumption kv_operations", async () => {
      K.kvList = vi.fn(async (opts) => {
        if (opts?.prefix === "desire:") return {
          keys: [{ name: "desire:serve" }], list_complete: true,
        };
        return { keys: [], list_complete: true };
      });
      K.kvGet = vi.fn(async (key) => {
        if (key === "desire:serve") return { slug: "serve", direction: "approach", description: "Serve" };
        if (key === "config:defaults") return { session_budget: { max_cost: 0.01 } };
        if (key === "job:j_456") return {
          id: "j_456", type: "cc_analysis", status: "completed",
          config: { deep_reflect: true, depth: 1 },
        };
        if (key === "job_result:j_456") return {
          result: {
            kv_operations: [
              { key: "desire:new", value: { slug: "new" }, op: "put" },
              { key: "config:defaults", value: { hacked: true }, op: "put" }, // should be filtered
            ],
            reflection: "test",
          },
        };
        return null;
      });

      await run(K, { crashData: null, balances: {}, events: [{ type: "job_complete", source: { job_id: "j_456" } }], schedule: {} });

      // Only desire:new should be written, not config:defaults
      const gatedCalls = K.kvWriteGated.mock.calls;
      const writtenKeys = gatedCalls.map(c => c[0]?.key);
      expect(writtenKeys).toContain("desire:new");
      expect(writtenKeys).not.toContain("config:defaults");
    });
  });
```

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add session.js tests/session.test.js
git commit -m "feat(m6): collect deep-reflect job results + per-depth dispatch

Process job_complete events for deep-reflect jobs. Filter kv_operations
to desire:*/assumption:* only (trust boundary). Re-snapshot after apply.
Dispatch per-depth instead of highest-only."
```

---

## Task 5: Update config and CLAUDE.md

**Files:**
- Modify: `config/defaults.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add deep_reflect config to defaults.json**

Add to `config/defaults.json`:

```json
"deep_reflect": {
  "model": "opus",
  "effort": "high",
  "max_output_tokens": 4000,
  "default_interval_sessions": 20,
  "default_interval_days": 7,
  "ttl_minutes": 60,
  "max_stale_sessions": 5,
  "budget_multiplier": 2
}
```

And ensure the `jobs` section exists:

```json
"jobs": {
  "cc_model": "opus",
  "default_ttl_minutes": 120,
  "max_concurrent_jobs": 2
}
```

Read the file first — some of these keys may already exist. Only add what's missing.

- [ ] **Step 2: Update CLAUDE.md**

Add a note about deep-reflect on akash in the architecture section. Find the existing deep-reflect reference and update:

```markdown
**Deep-reflect** runs as an async CC analysis job on akash (via `start_job`
tool). Results are stored in KV and applied by the next session. Falls back
to in-Worker execution when akash is not configured. The M/D operator prompt
is stored as `prompt:deep_reflect` in KV.
```

- [ ] **Step 3: Run all tests**

Run: `npm test`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add config/defaults.json CLAUDE.md
git commit -m "doc(m6): add deep-reflect config and update CLAUDE.md

deep_reflect.ttl_minutes (60), max_stale_sessions (5), jobs.cc_model (opus).
Document async deep-reflect on akash."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Section 2 (CC Analysis Job): Task 3 (dispatch via start_job)
- ✅ Section 3 (M/D Operator Prompts): Task 2
- ✅ Section 3 (No Cold Start): Task 1 (delete cold start)
- ✅ Section 4 (Result Collection): Task 4 (job_complete processing)
- ✅ Section 4 (Trust Boundary): Task 4 (filter kv_operations)
- ✅ Section 4 (Stale Check): Task 4 (max_stale_sessions)
- ✅ Section 5 (reflect.js dispatch): Task 3
- ✅ Section 5 (Fallback): Task 3 (runReflectInWorker)
- ✅ Section 5 (Depth cascade): Task 4 (per-depth dispatch)
- ✅ Section 6 (session.js changes): Tasks 1, 4
- ✅ Section 7 (Config): Task 5

**Placeholder scan:** No TBDs. All code complete.

**Type consistency:**
- `runReflect(K, state, depth, context)` — signature unchanged
- `dispatchDeepReflect(K, state, depth)` — consistent across reflect.js
- `applyReflectOutput(K, state, depth, output, context)` — existing signature, reused
- `job.config.deep_reflect` — consistent between dispatch (Task 3) and collection (Task 4)

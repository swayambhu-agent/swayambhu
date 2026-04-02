# Userspace Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename session.js → userspace.js, isolate act cycle and DR dispatch as independent concerns, remove in-worker DR fallback, fix the loadProposals crash.

**Architecture:** The cognitive policy entry point becomes `userspace.js`. Its `run()` function coordinates two independent concerns — act cycle and DR dispatch — each wrapped in try/catch so one's failure doesn't affect the other. DR only runs on akash (no in-worker fallback). The stale `loadProposals` reference is removed.

**Tech Stack:** Vitest, Cloudflare Workers, KV store.

---

### Task 1: Rename session.js → userspace.js

**Files:**
- Rename: `session.js` → `userspace.js`
- Modify: `index.js` (import path)
- Modify: `scripts/seed-local-kv.mjs` (seed path + description)
- Modify: `governor/builder.js` (KV key mapping + generated import)
- Rename: `tests/session.test.js` → `tests/userspace.test.js`
- Modify: `tests/userspace.test.js` (import path)
- Modify: `tests/governor.test.js` (expected import in generated code)

- [ ] **Step 1: Rename the files**

```bash
git mv session.js userspace.js
git mv tests/session.test.js tests/userspace.test.js
```

- [ ] **Step 2: Update index.js import**

Find line 10:
```javascript
import * as session from './session.js';
```
Change to:
```javascript
import * as session from './userspace.js';
```

Keep the import name as `session` — the kernel references `HOOKS.session.run`. The variable name doesn't need to change, just the file path.

- [ ] **Step 3: Update seed script**

In `scripts/seed-local-kv.mjs`, find line 172:
```javascript
await put("hook:session:code", read("session.js"), "text", "Session policy — act flow, context building");
```
Change to:
```javascript
await put("hook:session:code", read("userspace.js"), "text", "Userspace — act cycle, DR dispatch, cognitive policy");
```

- [ ] **Step 4: Update governor/builder.js**

Find line 16 where it maps KV key to filename:
```javascript
'hook:session:code': 'session.js',
```
Change to:
```javascript
'hook:session:code': 'userspace.js',
```

Find line 96 where it generates the import:
```javascript
lines.push("import * as session from './session.js';");
```
Change to:
```javascript
lines.push("import * as session from './userspace.js';");
```

- [ ] **Step 5: Update test import**

In `tests/userspace.test.js`, find:
```javascript
import { run } from "../session.js";
```
Change to:
```javascript
import { run } from "../userspace.js";
```

- [ ] **Step 6: Update governor test expectations**

In `tests/governor.test.js`, find any assertions that check for `session.js` in generated import code and update to `userspace.js`.

- [ ] **Step 7: Update the file header comment**

In `userspace.js`, update the header comment:
```javascript
// Swayambhu — Userspace (cognitive policy)
// Entry point for all scheduled cognitive work: act cycle + DR dispatch.
// Called by kernel via HOOKS.session.run(K, { crashData, balances, events, schedule }).
// Mutable — the agent can propose changes to this file via the proposal system.
```

- [ ] **Step 8: Run tests**

```bash
npm test
```
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: session.js → userspace.js — cognitive policy entry point"
```

---

### Task 2: Isolate act cycle and DR dispatch

**Files:**
- Modify: `userspace.js`

- [ ] **Step 1: Extract actCycle function**

Move the main loop (steps 1-6 of the current `run()`) into a separate function:

```javascript
async function actCycle(K, { crashData, balances, events, schedule }) {
  // 1. Load config
  const defaults = await K.getDefaults();
  const modelsConfig = await K.getModelsConfig();

  // ... everything from step 1 through step 6 (the main loop)
  // ... including loadDesires, loadSamskaras, planPhase, actPhase, etc.

  // Return desires so reflectDispatch can check if DR is needed
  return { defaults, modelsConfig, desires };
}
```

Cut steps 1-6 (and the deep-reflect job processing in step 2c) out of `run()` and into `actCycle`. The function returns `{ defaults, modelsConfig, desires }` so that `reflectDispatch` can use them without re-reading KV.

- [ ] **Step 2: Extract reflectDispatch function**

```javascript
async function reflectDispatch(K, { defaults, modelsConfig, desires }) {
  const state = { defaults, modelsConfig, desires };
  const maxDepth = defaults?.execution?.max_reflect_depth || 1;
  for (let d = maxDepth; d >= 1; d--) {
    if (await isReflectDue(K, state, d)) {
      await runReflect(K, state, d, {});
    }
  }
}
```

- [ ] **Step 3: Rewrite run() as coordinator**

```javascript
export async function run(K, { crashData, balances, events, schedule }) {
  let actResult = { defaults: null, modelsConfig: null, desires: {} };

  // Independent concern 1: act cycle
  try {
    actResult = await actCycle(K, { crashData, balances, events, schedule });
  } catch (e) {
    await K.karmaRecord({ event: "act_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Independent concern 2: DR dispatch
  try {
    const defaults = actResult.defaults || await K.getDefaults();
    const modelsConfig = actResult.modelsConfig || await K.getModelsConfig();
    const desires = actResult.desires || {};
    await reflectDispatch(K, { defaults, modelsConfig, desires });
  } catch (e) {
    await K.karmaRecord({ event: "reflect_dispatch_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Schedule next session (always runs, even if above failed)
  try {
    const defaults = actResult.defaults || await K.getDefaults();
    const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
    await K.kvWriteSafe("session_schedule", {
      next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
      interval_seconds: scheduleInterval,
    });
  } catch (e) {
    await K.karmaRecord({ event: "schedule_update_error", error: e.message });
  }

  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "session_complete",
    cycles_run: actResult.cyclesRun || 0,
    total_cost: finalCost,
  });
}
```

Note: `actCycle` needs to return `cyclesRun` as well. Update its return to include it.

- [ ] **Step 4: Update tests**

In `tests/userspace.test.js`, the tests call `run()` which now delegates to `actCycle` and `reflectDispatch`. The existing tests should still work since `run()` still calls the same code, just wrapped in try/catch. Verify by running tests.

Some tests may need updating if they assert on specific karma events (e.g., `session_complete` now always fires even after errors).

- [ ] **Step 5: Run tests**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add userspace.js tests/userspace.test.js
git commit -m "refactor: isolate act cycle and DR dispatch as independent concerns"
```

---

### Task 3: Remove in-worker DR fallback

**Files:**
- Modify: `reflect.js`

- [ ] **Step 1: Remove fallback in dispatchDeepReflect**

Find the `dispatchDeepReflect` function in `reflect.js`. The current fallback:

```javascript
  } else {
    // Dispatch failed — fall back to in-Worker
    await K.karmaRecord({ event: "deep_reflect_dispatch_failed", error: result?.error });
    return runReflectInWorker(K, state, depth, {});
  }
```

Replace with:

```javascript
  } else {
    // Dispatch failed — log and move on. DR only runs on akash.
    await K.karmaRecord({ event: "deep_reflect_dispatch_failed", error: result?.error });
  }
```

- [ ] **Step 2: Remove fallback when prompt is missing**

Find the no-prompt fallback:

```javascript
  if (!prompt) {
    await K.karmaRecord({ event: "deep_reflect_no_prompt", depth });
    return runReflectInWorker(K, state, depth, {});
  }
```

Replace with:

```javascript
  if (!prompt) {
    await K.karmaRecord({ event: "deep_reflect_no_prompt", depth });
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add reflect.js
git commit -m "fix: remove in-worker DR fallback — DR only runs on akash"
```

---

### Task 4: Fix loadProposals crash

**Files:**
- Modify: `reflect.js`

- [ ] **Step 1: Remove loadProposals calls**

The proposal system was replaced by code staging. `K.loadProposals` no longer exists on the kernel interface. Find both references:

In `executeReflect` (~line 30):
```javascript
const proposals = await K.loadProposals('proposed');
```
Replace with:
```javascript
const proposals = [];
```

In `gatherReflectContext` (~line 318):
```javascript
const proposals = await K.loadProposals();
```
Replace with:
```javascript
const proposals = [];
```

This makes the reflect context pass an empty proposals array. The prompts still reference proposals but will see nothing, which is correct — the old proposal system is gone.

- [ ] **Step 2: Run tests**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add reflect.js
git commit -m "fix: remove stale loadProposals calls — proposal system replaced by code staging"
```

---

### Task 5: Update CLAUDE.md and docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update file table**

In CLAUDE.md, find the Runtime Worker file table. Change:
```
| `session.js` | Session hook — plan→act→eval→review cycle, cold start | Yes (via code staging) |
```
to:
```
| `userspace.js` | Cognitive policy — act cycle, DR dispatch, schedule | Yes (via code staging) |
```

- [ ] **Step 2: Search and replace remaining session.js references**

Search CLAUDE.md for `session.js` and update to `userspace.js` where it refers to the file (not the concept of "sessions").

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session.js → userspace.js references"
```

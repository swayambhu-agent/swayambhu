# Tick-Based Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the kernel from session semantics so it calls userspace on every cron tick, and userspace owns session scheduling, counting, and bookkeeping.

**Architecture:** The kernel merges `executeHook()` + `runSession()` into `runTick()`, drops the schedule gate and session bookkeeping, renames session → execution throughout its internals. Userspace's `actCycle()` gains its own schedule gate and session bookkeeping. `drCycle()` runs on every tick unconditionally. The hook contract changes from `HOOKS.session` to `HOOKS.tick`.

**Tech Stack:** Cloudflare Workers, KV, Vitest

**Spec:** `docs/superpowers/specs/2026-04-02-tick-based-kernel-design.md`

---

## File Map

| File | Changes |
|------|---------|
| `kernel.js` | Merge executeHook+runSession→runTick, remove schedule gate + session bookkeeping, rename session→execution |
| `userspace.js` | Add schedule gate + session bookkeeping to actCycle, update run() signature, update drCycle K.getSessionCount→KV read |
| `index.js` | Change HOOKS from `{ session }` to `{ tick: session }` |
| `act.js` | Remove stale comment about session_counter (line 109) |
| `reflect.js` | Change K.getSessionCount() → K.kvGet("session_counter"), K.getSessionId() → K.getExecutionId() |
| `tests/kernel.test.js` | Update tests for renamed methods and removed schedule gate |
| `tests/userspace.test.js` | Add schedule gate tests, update hook contract |
| `tests/helpers/mock-kernel.js` | Rename getSessionId→getExecutionId, remove getSessionCount, add kvGet fallback |
| `scripts/seed-local-kv.mjs` | Keep session_schedule seed (now userspace-owned, same KV key) |

---

### Task 1: Rename session → execution in kernel internals

**Files:**
- Modify: `kernel.js:23` (sessionId → executionId)
- Modify: `kernel.js:730-767` (runScheduled — KV key renames)
- Modify: `kernel.js:769-788` (checkHookSafety — KV key renames)
- Modify: `kernel.js:884-900` (_detectCrash — KV key renames)
- Modify: `kernel.js:936-941` (updateSessionOutcome → updateExecutionOutcome)
- Modify: `kernel.js:902-934` (_writeSessionHealth → _writeExecutionHealth)

This is a pure rename — no logic changes. Makes the next tasks cleaner.

- [ ] **Step 1: Write failing tests for renamed methods**

In `tests/kernel.test.js`, find the existing `updateSessionOutcome` describe block (~line 1596) and add a test for the new name:

```javascript
describe("updateExecutionOutcome", () => {
  it("adds clean outcome to kernel:last_executions", async () => {
    const { kernel } = makeKernel();
    await kernel.updateExecutionOutcome("clean");
    const putCalls = kernel.env.KV.put.mock.calls;
    const execPut = putCalls.find(([key]) => key === "kernel:last_executions");
    expect(execPut).toBeTruthy();
    const history = JSON.parse(execPut[1]);
    expect(history[0].outcome).toBe("clean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "updateExecutionOutcome"`
Expected: FAIL — `kernel.updateExecutionOutcome is not a function`

- [ ] **Step 3: Rename in kernel.js**

In `kernel.js`:

1. Line 23: `this.sessionId` → `this.executionId`
   ```javascript
   this.executionId = `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
   ```

2. Line 333 (karmaRecord persist): `karma:${this.sessionId}` → `karma:${this.executionId}`

3. Line 340 (karmaRecord entry): `session_id: this.sessionId` → `execution_id: this.executionId`

4. Line 359 (sendKernelAlert): `session: this.sessionId` → `execution: this.executionId`

5. Line 634 (privileged write log): `session ${this.sessionId}` → `execution ${this.executionId}`

6. Line 695 (tool_start karma): `session_id: this.sessionId` → keep as-is for now (tool karma uses session_id as a generic label)

7. Line 732: `kernel:active_session` → `kernel:active_execution`

8. Line 746: `kernel:last_sessions` → `kernel:last_executions`

9. Line 749: `kernel:last_sessions` → `kernel:last_executions`

10. Line 753-754: `kernel:active_session` → `kernel:active_execution`, `id: this.sessionId` → `id: this.executionId`

11. Line 770: `kernel:last_sessions` → `kernel:last_executions`

12. Line 780, 784: `last_sessions` → `last_executions`

13. Line 810: `kernel:active_session` → `kernel:active_execution`

14. Line 885-890: comments and `kernel:last_sessions` → `kernel:last_executions`

15. Line 902: `_writeSessionHealth` → `_writeExecutionHealth`

16. Line 929: `session_health:${this.sessionId}` → `execution_health:${this.executionId}`

17. Line 936-940: `updateSessionOutcome` → `updateExecutionOutcome`, `kernel:last_sessions` → `kernel:last_executions`, `id: this.sessionId` → `id: this.executionId`

18. Line 978-979 (runMinimalFallback): `this.getSessionCount()` → `this.kvGet("session_counter")` and parse as number. This stays because the fallback still needs to increment (it's the kernel's emergency path):
    ```javascript
    const count = (await this.kvGet("session_counter")) || 0;
    await this.kvWrite("session_counter", count + 1);
    ```

19. Line 991: `this.updateSessionOutcome("clean")` → `this.updateExecutionOutcome("clean")`

20. Line 1169 (patron key rotation log): `session ${this.sessionId}` → `execution ${this.executionId}`

- [ ] **Step 4: Rename K interface methods**

In `kernel.js` `buildKernelInterface()`:

1. Line 456: Remove `getSessionCount: async () => kernel.getSessionCount()`

2. Line 469: `getSessionId: async () => kernel.sessionId` → `getExecutionId: async () => kernel.executionId`

3. Keep `getSessionCost` — it's budget enforcement (infrastructure), not session policy.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/kernel.test.js`
Expected: Many tests fail due to renamed methods/keys. That's expected — we'll fix tests in Task 5.

- [ ] **Step 6: Commit**

```bash
git add kernel.js
git commit -m "refactor: rename session → execution in kernel internals"
```

---

### Task 2: Merge executeHook + runSession into runTick

**Files:**
- Modify: `kernel.js:790-880` (replace executeHook + runSession + _isSessionDue with runTick)

- [ ] **Step 1: Write failing test for runTick**

In `tests/kernel.test.js`, add:

```javascript
describe("runTick", () => {
  it("calls HOOKS.tick.run with K, crashData, balances, events", async () => {
    const hookRun = vi.fn(async () => {});
    const { kernel, env } = makeKernel({}, { tick: { run: hookRun } });
    env.KV.get.mockImplementation(async (key) => {
      if (key === "kernel:last_executions") return JSON.stringify([]);
      if (key === "config:defaults") return JSON.stringify({});
      return null;
    });
    await kernel.runTick();
    expect(hookRun).toHaveBeenCalledTimes(1);
    const [K, inputs] = hookRun.mock.calls[0];
    expect(K).toHaveProperty("kvGet");
    expect(inputs).toHaveProperty("crashData");
    expect(inputs).toHaveProperty("balances");
    expect(inputs).toHaveProperty("events");
  });

  it("records crash outcome when hook throws", async () => {
    const hookRun = vi.fn(async () => { throw new Error("boom"); });
    const { kernel, env } = makeKernel({}, { tick: { run: hookRun } });
    env.KV.get.mockImplementation(async (key) => {
      if (key === "kernel:last_executions") return JSON.stringify([]);
      if (key === "config:defaults") return JSON.stringify({});
      return null;
    });
    await kernel.runTick();
    const putCalls = env.KV.put.mock.calls;
    const execPut = putCalls.find(([key]) => key === "kernel:last_executions");
    expect(execPut).toBeTruthy();
    const history = JSON.parse(execPut[1]);
    expect(history[0].outcome).toBe("crash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "runTick"`
Expected: FAIL — `kernel.runTick is not a function`

- [ ] **Step 3: Replace executeHook + runSession with runTick**

Delete `executeHook()` (lines 790-811), `runSession()` (lines 814-874), and `_isSessionDue()` (lines 876-880). Replace with:

```javascript
  async runTick() {
    await this.loadEagerConfig();
    const K = this.buildKernelInterface();
    let outcome = "clean";

    try {
      // Infrastructure inputs
      const crashData = await this._detectCrash();
      const balances = await this.checkBalance({});
      const { actContext: events } = await this.drainEvents(this._eventHandlers);

      // Hand to userspace — one call, userspace decides everything
      const { tick } = this.HOOKS;
      if (!tick?.run) throw new Error("No HOOKS.tick.run");
      await tick.run(K, { crashData, balances, events });

    } catch (err) {
      outcome = "crash";
      await this.karmaRecord({
        event: "fatal_error",
        error: err.message,
        stack: err.stack,
      });
    }

    // Always record execution outcome and release lock
    await this._writeExecutionHealth(outcome);
    await this.updateExecutionOutcome(outcome);
    await this.kv.delete("kernel:active_execution");
  }
```

- [ ] **Step 4: Update runScheduled to call runTick**

In `runScheduled()`, replace the hook-safe dispatch block (lines 758-766):

```javascript
    // 3. Meta-safety check (3 consecutive bad outcomes → signal governor + fallback)
    const hookSafe = await this.checkHookSafety();

    // 4. Execute tick or fallback
    if (hookSafe) {
      await this.runTick();
    } else {
      await this.runFallbackSession();
    }
```

- [ ] **Step 5: Delete getSessionCount from kernel**

Remove the `getSessionCount()` method (~line 1934-1936). The fallback path already
uses direct KV read (updated in Task 1).

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/kernel.test.js -t "runTick"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add kernel.js
git commit -m "refactor: merge executeHook + runSession into runTick, remove schedule gate"
```

---

### Task 3: Move schedule gate and session bookkeeping to userspace

**Files:**
- Modify: `userspace.js:312-420` (actCycle — add schedule gate + bookkeeping)
- Modify: `userspace.js:665-701` (run — update signature, remove schedule concern)

- [ ] **Step 1: Write failing test**

In `tests/userspace.test.js`, add a test that actCycle skips when not due:

```javascript
describe("actCycle schedule gate", () => {
  it("skips when session_schedule is in the future", async () => {
    const K = makeMockK({
      kvData: {
        "session_schedule": {
          next_session_after: new Date(Date.now() + 999999).toISOString(),
          interval_seconds: 21600,
        },
      },
    });
    // actCycle should return without doing anything
    // (no LLM calls, no karma events beyond maybe a skip log)
    const result = await actCycle(K, { crashData: null, balances: {}, events: [] });
    expect(K.callLLM).not.toHaveBeenCalled();
  });
});
```

Note: `actCycle` isn't exported. Either export it for testing or test indirectly through `run()`. If not exported, add `export { actCycle }` at the bottom of `userspace.js` for test access, or test via `run()` and check that no LLM calls happen when schedule isn't due.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/userspace.test.js -t "schedule gate"`
Expected: FAIL — actCycle doesn't check schedule yet

- [ ] **Step 3: Add schedule gate to actCycle**

At the top of `actCycle()` (line 312), change the signature and add the gate:

```javascript
async function actCycle(K, { crashData, balances, events }) {
  // Schedule gate — userspace decides if it's time
  const schedule = await K.kvGet("session_schedule");
  if (schedule?.next_session_after) {
    if (Date.now() < new Date(schedule.next_session_after).getTime()) {
      return { skipped: true };
    }
  }

  // Session bookkeeping — userspace concept
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  await K.kvWriteSafe("session_counter", sessionCount + 1);

  const sessionIds = (await K.kvGet("cache:session_ids")) || [];
  const executionId = await K.getExecutionId();
  sessionIds.push(executionId);
  await K.kvWriteSafe("cache:session_ids", sessionIds);

  await K.karmaRecord({
    event: "session_start",
    session_number: sessionCount + 1,
    scheduled_at: schedule?.next_session_after || null,
    crash_detected: !!crashData,
    balances,
  });

  // ... rest of existing actCycle (load config, desires, samskaras, loop) ...
```

Remove the `schedule` parameter from actCycle's destructured args (it was only used by the kernel's schedule gate, which is now gone).

- [ ] **Step 4: Move schedule update into actCycle**

At the end of `actCycle()`, before the return, add the schedule update that was in `run()`:

```javascript
  // Schedule next session
  const scheduleInterval = defaults?.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + scheduleInterval * 1000).toISOString(),
    interval_seconds: scheduleInterval,
  });

  return { defaults, modelsConfig, desires, cyclesRun };
}
```

- [ ] **Step 5: Simplify run()**

Replace the current `run()` function:

```javascript
export async function run(K, { crashData, balances, events }) {
  // Independent concern 1: act cycle (schedule-gated)
  try {
    await actCycle(K, { crashData, balances, events });
  } catch (e) {
    await K.karmaRecord({ event: "act_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }

  // Independent concern 2: DR lifecycle (every tick)
  try {
    await drCycle(K);
  } catch (e) {
    await K.karmaRecord({ event: "dr_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
  }
}
```

Remove the schedule update try/catch (moved into actCycle).
Remove the session_complete karma record (session_complete is now emitted by actCycle, not run).
Remove `schedule` from the destructured input.

- [ ] **Step 6: Add session_complete to actCycle**

At the end of actCycle (after scheduling next session, before return), add:

```javascript
  const finalCost = await K.getSessionCost();
  await K.karmaRecord({
    event: "session_complete",
    cycles_run: cyclesRun,
    total_cost: finalCost,
  });
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS (or existing test failures from rename — addressed in Task 5)

- [ ] **Step 8: Commit**

```bash
git add userspace.js
git commit -m "refactor: move schedule gate and session bookkeeping to userspace"
```

---

### Task 4: Update drCycle and reflect.js for new K interface

**Files:**
- Modify: `userspace.js:424-660` (drCycle — replace K.getSessionCount with KV read)
- Modify: `reflect.js` (replace K.getSessionId→K.getExecutionId, K.getSessionCount→KV read)
- Modify: `act.js:109,164,167` (update stale comment and getSessionId reference)

- [ ] **Step 1: Update drCycle in userspace.js**

Replace all `await K.getSessionCount()` calls in drCycle with:
```javascript
const sessionCount = (await K.kvGet("session_counter")) || 0;
```

This appears at lines 438, 458, 472, 481, 500, 517, 539. Each one becomes a local read.

For efficiency, load it once at the top of drCycle and pass it down:
```javascript
async function drCycle(K) {
  const defaults = await K.getDefaults();
  const sessionCount = (await K.kvGet("session_counter")) || 0;
  const state = await K.kvGet("dr:state:1") || {
    status: "idle", generation: 0, consecutive_failures: 0,
  };
  // ... use sessionCount instead of await K.getSessionCount() throughout
```

- [ ] **Step 2: Update getSessionId → getExecutionId in drCycle**

Line 482: `state.last_session_id = await K.getSessionId()` → `state.last_execution_id = await K.getExecutionId()`

Line 621: `const sessionId = await K.getSessionId()` → `const executionId = await K.getExecutionId()` and update all references in `applyDrResults` to use `executionId`.

- [ ] **Step 3: Update reflect.js**

Replace all `K.getSessionId()` → `K.getExecutionId()` and `K.getSessionCount()` → `(await K.kvGet("session_counter")) || 0`:

- Line 27: `const sessionId = await K.getSessionId()` → `const sessionId = await K.getExecutionId()` (variable name can stay `sessionId` for now — it's used as a key suffix)
- Line 35: `const sessionCounter = await K.getSessionCount()` → `const sessionCounter = (await K.kvGet("session_counter")) || 0`
- Line 201: `const sessionId = await K.getSessionId()` → `const sessionId = await K.getExecutionId()`
- Line 335: `const sessionCount = await K.getSessionCount()` → `const sessionCount = (await K.kvGet("session_counter")) || 0`
- Line 385: `const sessionId = await K.getSessionId()` → `const sessionId = await K.getExecutionId()`
- Line 410: `const sessionCount = await K.getSessionCount()` → `const sessionCount = (await K.kvGet("session_counter")) || 0`
- Line 453: similar pattern

- [ ] **Step 4: Update act.js**

- Line 109: Remove or update comment `// Note: session_counter, cache:session_ids, and karma_summary are now` — this is stale. Replace with:
  ```javascript
  // Note: session_counter and cache:session_ids are managed by userspace actCycle.
  ```

- Line 164: `const stale = await K.kvGet("kernel:active_session")` → `const stale = await K.kvGet("kernel:active_execution")`

- Line 167: `const currentId = await K.getSessionId()` → `const currentId = await K.getExecutionId()`

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: Some failures from mock-kernel changes (Task 5 fixes those)

- [ ] **Step 6: Commit**

```bash
git add userspace.js reflect.js act.js
git commit -m "refactor: update userspace + reflect + act for tick-based K interface"
```

---

### Task 5: Update index.js and HOOKS contract

**Files:**
- Modify: `index.js:61` (HOOKS rename)

- [ ] **Step 1: Change HOOKS wiring**

Line 61: `const HOOKS = { session };` → `const HOOKS = { tick: session };`

That's it. The `session` import stays the same (it's `userspace.js`), it's just registered under the `tick` key instead of `session`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: Index.js isn't directly unit tested. Kernel tests need updating (next task).

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "refactor: rename HOOKS.session to HOOKS.tick"
```

---

### Task 6: Fix all tests

**Files:**
- Modify: `tests/kernel.test.js` (rename all session→execution references)
- Modify: `tests/userspace.test.js` (update hook contract, add schedule gate tests)
- Modify: `tests/helpers/mock-kernel.js` (rename getSessionId→getExecutionId, remove getSessionCount)

- [ ] **Step 1: Update mock-kernel.js**

```javascript
// Line 79: Remove getSessionCount
// Line 103: Rename getSessionId → getExecutionId
getExecutionId: vi.fn(async () => opts.executionId || opts.sessionId || "test_execution"),
```

Add a kvGet handler that returns `session_counter` when requested (if not already handled by the mock KV):
```javascript
// Ensure kvGet can return session_counter for userspace code that reads it directly
```

- [ ] **Step 2: Update kernel.test.js**

Search and replace throughout:
- `kernel:active_session` → `kernel:active_execution`
- `kernel:last_sessions` → `kernel:last_executions`
- `updateSessionOutcome` → `updateExecutionOutcome`
- `_writeSessionHealth` → `_writeExecutionHealth`
- `session_health:` → `execution_health:`
- `executeHook` → `runTick` (in runScheduled tests)
- `HOOKS.session` → `HOOKS.tick` (in any test that constructs a kernel with hooks)
- Remove or update tests that test the schedule gate in the kernel (it no longer exists there)
- Remove tests for `_isSessionDue` (deleted method)

The `runScheduled` test block (~line 1555-1592):
- "calls executeHook" → "calls runTick"
- Mock setup: `kernel.executeHook = vi.fn(...)` → `kernel.runTick = vi.fn(...)`
- KV key references: all `active_session` → `active_execution`, `last_sessions` → `last_executions`

The `updateSessionOutcome` describe block → rename to `updateExecutionOutcome`.

The `_writeSessionHealth` describe block → rename to `_writeExecutionHealth`.

- [ ] **Step 3: Update userspace.test.js**

Update the hook contract in test setup: if tests construct HOOKS, use `tick` not `session`.

Add test for actCycle schedule gate:
```javascript
it("actCycle skips when schedule is in the future", async () => {
  // Mock K with session_schedule in the future
  // Call run() — verify no LLM calls, drCycle still runs
});

it("actCycle runs when schedule is in the past", async () => {
  // Mock K with session_schedule in the past
  // Call run() — verify LLM calls happen, session_counter incremented
});

it("drCycle runs even when actCycle skips", async () => {
  // Mock K with session_schedule in the future but dr:state:1 = dispatched
  // Call run() — verify drCycle polls (tool call to compute adapter)
});
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: update all tests for tick-based kernel"
```

---

### Task 7: Update seed script, CLAUDE.md, and cleanup

**Files:**
- Modify: `scripts/seed-local-kv.mjs` (no change needed — session_schedule is same key, still userspace-readable)
- Modify: `CLAUDE.md` (update session lifecycle description)
- Delete: `docs/20260331/KERNEL.md` (already deleted in git status, confirm)

- [ ] **Step 1: Verify seed script**

The seed script seeds `session_schedule` and `dr:state:1`. Both are still the correct keys. No changes needed. Verify:

Run: `grep -n "session_schedule\|active_session\|last_sessions\|session_counter" scripts/seed-local-kv.mjs`
Expected: Only `session_schedule` appears (line 216). No `active_session` or `last_sessions` — those are created by the kernel at runtime.

- [ ] **Step 2: Update CLAUDE.md**

In the `## Code Layout` section, update the `runSession` reference:

Find: `Session dispatch: The kernel's runSession() is 5 steps:`
Replace with:
```
Tick dispatch: The kernel's runTick() calls userspace on every cron tick:
1. Load config (dharma, principles, key tiers, models)
2. Infrastructure inputs — crash detection, balances, drained events
3. **Hand to userspace** — `HOOKS.tick.run(K, { crashData, balances, events })`
4. Record execution outcome (clean/crash)
5. Release execution lock
```

Update: `Userspace decides everything: what type of session to run...`
→ `Userspace decides everything: whether to run an act session, whether to poll DR, what context to load, how to structure the work. The kernel doesn't know or care.`

In the session lifecycle table or any reference to `HOOKS.session`, update to `HOOKS.tick`.

Remove `schedule` from the hook signature reference if it appears.

- [ ] **Step 3: Clean up deleted doc**

The git status shows `docs/20260331/KERNEL.md` is deleted. Stage the deletion:

```bash
git add docs/20260331/KERNEL.md
```

- [ ] **Step 4: Run full test suite one last time**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Start services and trigger a session to verify end-to-end**

```bash
source .env && bash scripts/start.sh --reset-all-state --trigger
```

Watch stderr for:
- `[KARMA]` session_start — should come from userspace now
- DR polling should happen in the same tick
- No errors about missing methods

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: update CLAUDE.md and docs for tick-based kernel"
```

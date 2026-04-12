# DR Lifecycle State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the DR lifecycle as an independent state machine on `dr:state:1`, decoupling DR from act sessions and removing the callback mechanism.

**Architecture:** `drCycle()` manages DR lifecycle independently via a state machine (idle→dispatched→completed→failed→idle). Polls akash for job completion instead of using callbacks. `actCycle()` has zero DR awareness. Both are peers called by the `run()` multiplexer.

**Tech Stack:** Vitest, Cloudflare Workers, KV store, SSH via compute adapter.

**Reference:** `docs/superpowers/specs/2026-04-02-dr-lifecycle-design.md` (v5)

---

### Task 1: Remove DR coupling from actCycle

**Files:**
- Modify: `userspace.js`

- [ ] **Step 1: Remove step 2c (deep-reflect job processing from events)**

In `userspace.js`, find the `actCycle` function. Remove the entire block at lines ~339-384 that processes deep-reflect job completions from events. This is the block starting with:
```javascript
// 2c. Process deep-reflect job completions from events
for (const event of (events || [])) {
```
and ending with the closing brace and re-snapshot of desires/samskaras.

Delete the entire block. actCycle should have zero DR awareness.

- [ ] **Step 2: Remove reflectDispatch function**

Delete the entire `reflectDispatch` function (lines ~472-483).

- [ ] **Step 3: Remove reflectDispatch call from run()**

In the `run()` function, find the try block that calls `reflectDispatch`:
```javascript
try {
  const defaults = actResult.defaults || await K.getDefaults();
  const modelsConfig = actResult.modelsConfig || await K.getModelsConfig();
  const desires = actResult.desires || {};
  await reflectDispatch(K, { defaults, modelsConfig, desires });
} catch (e) {
  await K.karmaRecord({ event: "reflect_dispatch_error", ...
```

Replace the entire try block with a placeholder for drCycle (Task 2 will fill it in):
```javascript
// Independent concern 2: DR lifecycle
try {
  // drCycle will be added in Task 2
} catch (e) {
  await K.karmaRecord({ event: "dr_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
}
```

- [ ] **Step 4: Update imports**

Change the import from reflect.js:
```javascript
// Before:
import { runReflect, highestReflectDepthDue, isReflectDue, applyReflectOutput } from './reflect.js';

// After:
import { executeReflect } from './reflect.js';
```

Only keep `executeReflect` — it's used for session-level reflect (not deep-reflect). All DR-related imports are removed.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Some tests may fail if they assert on reflect dispatch behavior. Fix by removing/updating those assertions. The deep-reflect job collection tests and per-depth reflect dispatch tests should be removed since that functionality is moving to drCycle.

- [ ] **Step 6: Commit**

```bash
git add userspace.js tests/userspace.test.js
git commit -m "refactor: remove DR coupling from actCycle — zero DR awareness"
```

---

### Task 2: Implement drCycle state machine

**Files:**
- Modify: `userspace.js`

This is the core task. Add the full `drCycle` function and its helpers.

- [ ] **Step 1: Add drCycle and helpers**

Add these functions to `userspace.js`, after the `actCycle` function and before `run()`:

```javascript
// ── DR Lifecycle (independent state machine) ──────────────

async function drCycle(K) {
  const defaults = await K.getDefaults();
  const state = await K.kvGet("dr:state:1") || {
    status: "idle", generation: 0, consecutive_failures: 0,
  };

  if (state.status === "dispatched") {
    // Check TTL
    const ttl = defaults?.deep_reflect?.ttl_minutes || 120;
    const age = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
    if (age > ttl) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = `TTL expired after ${Math.round(age)} minutes`;
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await updateJobRecord(K, state.job_id, "expired");
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return;
    }

    // Poll for completion
    const result = await pollJobResult(K, state, defaults);

    if (result.status === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      await K.kvWriteSafe(`dr:result:${state.generation}`, result.output);
      await updateJobRecord(K, state.job_id, "completed");
      await K.kvWriteSafe("dr:state:1", state);
    } else if (result.status === "failed") {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = result.error || "non-zero exit code";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await updateJobRecord(K, state.job_id, "failed");
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_failed", job_id: state.job_id, error: result.error });
    }
    return;
  }

  if (state.status === "completed") {
    const output = await K.kvGet(`dr:result:${state.generation}`);
    if (!output) {
      state.status = "failed";
      state.failure_reason = "result missing from KV";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    await applyDrResults(K, state, output);

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = await K.getSessionCount();
    state.last_session_id = await K.getSessionId();
    state.consecutive_failures = 0;
    state.last_failure_session = null;

    const interval = output.next_reflect?.after_sessions
      || defaults?.deep_reflect?.default_interval_sessions || 20;
    const intervalDays = output.next_reflect?.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    state.next_due_session = state.last_applied_session + interval;
    state.next_due_date = new Date(Date.now() + intervalDays * 86400000).toISOString();

    await K.kvDeleteSafe(`dr:result:${state.generation}`);
    await K.kvWriteSafe("dr:state:1", state);
    return;
  }

  if (state.status === "failed") {
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    const sessionCount = await K.getSessionCount();
    if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) return;

    state.status = "idle";
    state.next_due_session = sessionCount; // due now (backoff already waited)
    await K.kvWriteSafe("dr:state:1", state);
  }

  if (state.status === "idle") {
    if (!await isDrDue(K, state)) return;

    const dispatch = await dispatchDr(K, defaults);
    if (!dispatch) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = "dispatch failed";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_dispatch_failed" });
      return;
    }

    state.status = "dispatched";
    state.generation = (state.generation || 0) + 1;
    state.job_id = dispatch.job_id;
    state.workdir = dispatch.workdir;
    state.dispatched_at = new Date().toISOString();
    state.completed_at = null;
    state.applied_at = null;
    state.failed_at = null;
    state.failure_reason = null;
    await K.kvWriteSafe("dr:state:1", state);
    await K.karmaRecord({ event: "dr_dispatched", job_id: dispatch.job_id, generation: state.generation });
  }
}

async function isDrDue(K, state) {
  if (!state.generation) return true; // cold start
  const sessionCount = await K.getSessionCount();
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;
  return false;
}

async function dispatchDr(K, defaults) {
  const prompt = await K.kvGet("prompt:deep_reflect");
  if (!prompt) return null;

  const result = await K.executeToolCall({
    id: `dr_dispatch_${Date.now()}`,
    function: {
      name: "start_job",
      arguments: JSON.stringify({
        type: "cc_analysis",
        prompt,
        context_keys: [
          "samskara:*", "experience:*", "desire:*",
          "principle:*", "config:defaults",
          "reflect:1:*", "last_reflect",
        ],
      }),
    },
  });

  if (!result?.ok) return null;
  return { job_id: result.job_id, workdir: result.workdir };
}

async function pollJobResult(K, state, defaults) {
  const jobs = defaults?.jobs || {};

  let checkResult;
  try {
    checkResult = await K.executeAdapter("provider:compute", {
      command: `test -f ${state.workdir}/exit_code && cat ${state.workdir}/exit_code || echo RUNNING`,
      baseUrl: jobs.base_url, timeout: 5,
    });
  } catch {
    return { status: "running" }; // SSH failed, retry next tick
  }

  if (!checkResult?.ok) return { status: "running" };

  const exitText = Array.isArray(checkResult.output)
    ? checkResult.output.map(o => o.data || '').join('').trim()
    : String(checkResult.output || '').trim();

  if (exitText === "RUNNING") return { status: "running" };

  const exitCode = parseInt(exitText, 10);
  if (exitCode !== 0) return { status: "failed", error: `exit code ${exitCode}` };

  let outputResult;
  try {
    outputResult = await K.executeAdapter("provider:compute", {
      command: `cat ${state.workdir}/output.json 2>/dev/null || echo '{}'`,
      baseUrl: jobs.base_url, timeout: 10,
    });
  } catch {
    return { status: "failed", error: "could not read output" };
  }

  if (!outputResult?.ok) return { status: "failed", error: "could not read output" };

  const raw = Array.isArray(outputResult.output)
    ? outputResult.output.map(o => o.data || '').join('')
    : String(outputResult.output || '');

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.reflection && !parsed.kv_operations?.length) {
      return { status: "failed", error: "output.json has no reflection or kv_operations" };
    }
    return { status: "completed", output: parsed };
  } catch {
    return { status: "failed", error: "invalid JSON in output.json" };
  }
}

async function applyDrResults(K, state, output) {
  const sessionId = await K.getSessionId();

  // Apply kv_operations — all through kvWriteGated (protected keys)
  const ops = (output.kv_operations || []).filter(op =>
    op.key?.startsWith("samskara:") || op.key?.startsWith("desire:")
  );

  const blocked = [];
  for (const op of ops) {
    const result = await K.kvWriteGated(op, "deep-reflect");
    if (!result.ok) blocked.push({ key: op.key, error: result.error });
  }

  if (blocked.length > 0) {
    await K.karmaRecord({ event: "dr_apply_blocked", blocked, applied: ops.length - blocked.length });
  }

  // Write reflect history
  await K.kvWriteSafe(`reflect:1:${sessionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
  });

  // Write last_reflect
  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    was_deep_reflect: true,
    depth: 1,
    session_id: sessionId,
  });
}

async function updateJobRecord(K, jobId, status) {
  const record = await K.kvGet(`job:${jobId}`);
  if (record) {
    record.status = status;
    record.completed_at = new Date().toISOString();
    await K.kvWriteSafe(`job:${jobId}`, record);
  }
}
```

- [ ] **Step 2: Wire drCycle into run()**

Replace the drCycle placeholder in `run()`:
```javascript
// Independent concern 2: DR lifecycle
try {
  await drCycle(K);
} catch (e) {
  await K.karmaRecord({ event: "dr_cycle_error", error: e.message, stack: e.stack?.slice(0, 500) });
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add userspace.js
git commit -m "feat: implement drCycle state machine — independent DR lifecycle"
```

---

### Task 3: Clean up reflect.js — remove DR dispatch functions

**Files:**
- Modify: `reflect.js`

- [ ] **Step 1: Remove DR-specific exports**

Remove these functions from reflect.js:
- `dispatchDeepReflect` (lines ~264-311)
- `isReflectDue` (lines ~620-647)
- `highestReflectDepthDue` (lines ~649-659)

Also remove `runReflect` if it only dispatches deep-reflect. Check if `runReflect` is used for session-level reflect — if so, keep it. If it only calls `dispatchDeepReflect` or `runReflectInWorker`, remove it.

- [ ] **Step 2: Keep session-level reflect functions**

Keep these (used by session-level reflect, not deep-reflect):
- `executeReflect`
- `gatherReflectContext`
- `applyReflectOutput`
- `loadReflectPrompt`
- `loadBelowPrompt`
- `getRelevantSessionIds`
- `loadReflectHistory`
- `defaultReflectPrompt`
- `defaultDeepReflectPrompt`
- `loadSamskaraManifest`
- `runReflectInWorker` (kept for potential future in-worker use)

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add reflect.js
git commit -m "refactor: remove DR dispatch functions from reflect.js — moved to drCycle"
```

---

### Task 4: Remove callback from start_job.js

**Files:**
- Modify: `tools/start_job.js`

- [ ] **Step 1: Remove callback curl from shell script**

Find the shell script construction (lines ~104-117). Remove the callback curl lines and the `callbackSecret` variable. The shell script becomes:

```javascript
const shellScript = [
  `mkdir -p ${workdir}`,
  `echo '${base64Tar}' | base64 -d | tar xz -C ${workdir}`,
  `nohup sh -c '`,
  `  cd ${workdir} &&`,
  `  ${jobCommand} > output.json 2>stderr.log;`,
  `  EXIT=$?; echo $EXIT > exit_code`,
  `' > /dev/null 2>&1 & echo $!`,
].join(' && \\\n');
```

Jobs just run and exit. The exit_code file signals completion. `drCycle` polls for it.

- [ ] **Step 2: Remove callbackSecret from job record**

Remove the `callbackSecret` generation (lines ~41-43) and remove `callback_secret` from the job record (line ~146). The `callbackBase` variable and `callback_url` config reference can also be removed.

- [ ] **Step 3: Run tests**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add tools/start_job.js
git commit -m "refactor: remove callback curl from start_job — jobs polled by drCycle"
```

---

### Task 5: Remove /job-complete handler from index.js

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Remove the handler**

Find the `/job-complete` handler (lines ~113-160). Remove the entire `if (jobMatch && request.method === "POST")` block.

- [ ] **Step 2: Run tests**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "refactor: remove /job-complete handler — DR uses polling, not callbacks"
```

---

### Task 6: Seed dr:state:1

**Files:**
- Modify: `scripts/seed-local-kv.mjs`

- [ ] **Step 1: Add dr:state:1 seeding**

Find where session_schedule is seeded (around line 216). Add nearby:

```javascript
await put("dr:state:1", {
  status: "idle",
  generation: 0,
  consecutive_failures: 0,
}, "json", "DR lifecycle state — idle, ready for first dispatch");
```

- [ ] **Step 2: Commit**

```bash
git add scripts/seed-local-kv.mjs
git commit -m "seed: add dr:state:1 for DR lifecycle state machine"
```

---

### Task 7: Update tests

**Files:**
- Modify: `tests/userspace.test.js`

- [ ] **Step 1: Remove deep-reflect job collection tests**

Find the `describe("deep-reflect job collection", ...)` block and remove it entirely. This functionality has moved from actCycle events to drCycle polling.

- [ ] **Step 2: Remove per-depth reflect dispatch tests**

Find the `describe("per-depth reflect dispatch", ...)` block and remove it. Reflect dispatch is now in drCycle, not in the session flow.

- [ ] **Step 3: Remove stale imports**

Update the vi.mock for reflect.js to only mock what's still used:
```javascript
vi.mock("../reflect.js", () => ({
  executeReflect: vi.fn(async () => {}),
}));
```

Remove unused imports:
```javascript
// Before:
import { runReflect, highestReflectDepthDue, isReflectDue, applyReflectOutput } from "../reflect.js";

// After:
import { executeReflect } from "../reflect.js";
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: All tests pass. The removed tests covered functionality that now lives in drCycle (which would get its own tests later).

- [ ] **Step 5: Commit**

```bash
git add tests/userspace.test.js
git commit -m "test: remove stale DR tests — functionality moved to drCycle"
```

---

### Task 8: Update docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/april/USERSPACE.md`

- [ ] **Step 1: Update CLAUDE.md**

Find the deep-reflect section in CLAUDE.md. Update to reference `dr:state:1` instead of `reflect:schedule:1`. Update the description of how DR is dispatched (polling, not callbacks).

- [ ] **Step 2: Update USERSPACE.md**

Update the DR dispatch section to describe `drCycle` and the state machine instead of the old `reflectDispatch` flow.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/april/USERSPACE.md
git commit -m "docs: update DR lifecycle references for state machine"
```

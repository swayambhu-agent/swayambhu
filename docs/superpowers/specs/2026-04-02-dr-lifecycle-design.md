# Design: DR Lifecycle — Independent State Machine (v5)

## Problem

Act and deep-reflect were coupled: DR result collection inside the act
cycle, callbacks to the kernel, event-based notification, shared
scheduling. Four Codex adversarial reviews refined this design.

## Core Principle

Act and DR are independent systems that share a clock tick and a KV
store. Nothing else. The cron provides the tick. Each system reads its
own state from KV, decides what to do, and writes results back to KV.
Neither knows the other exists.

```javascript
// userspace.js — multiplexer, not orchestrator
export async function run(K, { crashData, balances, events, schedule }) {
  try { await actCycle(K, { crashData, balances, events, schedule }); }
  catch (e) { await K.karmaRecord({ event: "act_cycle_error", ... }); }

  try { await drCycle(K); }
  catch (e) { await K.karmaRecord({ event: "dr_cycle_error", ... }); }

  try { await updateSchedule(K); }
  catch (e) { await K.karmaRecord({ event: "schedule_error", ... }); }

  await K.karmaRecord({ event: "session_complete", ... });
}
```

`run()` is a multiplexer. It does not orchestrate. It does not pass
state between act and DR. Each reads KV independently.

## DR State Machine

One KV record per reflect depth: `dr:state:1`.

### State Record

```json
{
  "status": "idle",
  "generation": 4,
  "job_id": "j_1775062240706_r5b2",
  "workdir": "/home/swayambhu/jobs/j_1775062240706_r5b2",
  "dispatched_at": "2026-04-01T16:50:40Z",
  "completed_at": "2026-04-01T17:05:00Z",
  "applied_at": "2026-04-01T22:51:09Z",
  "failed_at": null,
  "failure_reason": null,
  "consecutive_failures": 0,
  "last_failure_session": null,
  "next_due_session": 25,
  "next_due_date": "2026-04-08T00:00:00Z",
  "last_applied_session": 5,
  "last_session_id": "s_1775062232541_mlmo64"
}
```

### State Transitions

```
                ┌──────────────────────────────────────────┐
                │                                          │
idle ──(due)──→ dispatched ──(job done, exit 0)──→ completed ──(applied)──→ idle
                    │              │                                          ↑
                    │         (exit ≠ 0 or                                    │
                    │          bad output)                                    │
                    │              │                                          │
                    │              ↓                                          │
                    │           failed ────(backoff elapsed)──────────────────┘
                    │
                    └──(ttl expired)──→ failed
```

### drCycle Logic

```javascript
async function drCycle(K) {
  const defaults = await K.getDefaults();
  const state = await K.kvGet("dr:state:1") || {
    status: "idle", generation: 0, consecutive_failures: 0
  };

  if (state.status === "dispatched") {
    // Check TTL first
    const ttl = defaults?.deep_reflect?.ttl_minutes || 120;
    const age = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
    if (age > ttl) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = `TTL expired after ${Math.round(age)} minutes`;
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      // Update job record so start_job concurrency check stays accurate
      await updateJobRecord(K, state.job_id, "expired");
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return;
    }

    // Poll for completion — one SSH check, short timeout
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
    // else still running — do nothing
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

    const applied = await applyDrResults(K, state, output, defaults);
    if (!applied) {
      state.status = "failed";
      state.failure_reason = "apply failed — write errors";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      state.last_failure_session = await K.getSessionCount();
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = await K.getSessionCount();
    state.last_session_id = await K.getSessionId();
    state.consecutive_failures = 0;
    state.last_failure_session = null;

    // Schedule from DR output or defaults
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
    // Backoff: wait N sessions from last failure (exponential, capped at 20)
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    const sessionCount = await K.getSessionCount();
    if (state.last_failure_session && sessionCount - state.last_failure_session < backoff) return;

    // Set a schedule so isDrDue can trigger — without this, a failed
    // first generation would strand forever (no next_due_session set)
    const sessionCount = await K.getSessionCount();
    state.status = "idle";
    state.next_due_session = sessionCount; // due now (backoff already waited)
    await K.kvWriteSafe("dr:state:1", state);
    // Fall through to idle check
  }

  if (state.status === "idle") {
    if (!await isDrDue(K, state, defaults)) return;

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
```

### updateJobRecord — Keep start_job concurrency accurate

```javascript
async function updateJobRecord(K, jobId, status) {
  const record = await K.kvGet(`job:${jobId}`);
  if (record) {
    record.status = status;
    record.completed_at = new Date().toISOString();
    await K.kvWriteSafe(`job:${jobId}`, record);
  }
}
```

When `drCycle` detects completion/failure/expiry, it also updates the
generic `job:*` record. This keeps `start_job`'s global concurrency
check accurate without needing the callback.

### isDrDue

```javascript
async function isDrDue(K, state, defaults) {
  // Cold start — no DR has ever run
  if (!state.generation) return true;

  const sessionCount = await K.getSessionCount();

  // Session threshold
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;

  // Time threshold
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;

  return false;
}
```

No "no desires" special case. Cold start (generation 0) is the only
immediate trigger — a one-time condition that can never recur. After
that, the schedule governs everything.

If the D operator retires all desires mid-lifecycle, the agent produces
`no_action` experiences until the next scheduled DR. Those experiences
give D fresh material to work with. The normal schedule handles
recovery. If 20 idle sessions feels too long, adjust
`default_interval_sessions` — that's a tuning parameter, not an
architectural problem.

### pollJobResult — SSH with timeout, normalized output

Reads exit_code and output.json from the job's workdir on akash.
Short timeout (5s) prevents SSH hang from killing the cron.

```javascript
async function pollJobResult(K, state, defaults) {
  const jobs = defaults?.jobs || {};

  // Check exit_code file
  const checkResult = await K.executeAdapter("provider:compute", {
    command: `test -f ${state.workdir}/exit_code && cat ${state.workdir}/exit_code || echo RUNNING`,
    baseUrl: jobs.base_url, timeout: 5,
  });

  if (!checkResult.ok) return { status: "running" }; // SSH failed, retry next tick

  // Normalize output (compute adapter returns array or string)
  const exitText = Array.isArray(checkResult.output)
    ? checkResult.output.map(o => o.data || '').join('').trim()
    : String(checkResult.output || '').trim();

  if (exitText === "RUNNING") return { status: "running" };

  const exitCode = parseInt(exitText, 10);
  if (exitCode !== 0) return { status: "failed", error: `exit code ${exitCode}` };

  // Read output.json
  const outputResult = await K.executeAdapter("provider:compute", {
    command: `cat ${state.workdir}/output.json 2>/dev/null || echo '{}'`,
    baseUrl: jobs.base_url, timeout: 10,
  });

  if (!outputResult.ok) return { status: "failed", error: "could not read output" };

  const raw = Array.isArray(outputResult.output)
    ? outputResult.output.map(o => o.data || '').join('')
    : String(outputResult.output || '');

  try {
    const parsed = JSON.parse(raw);
    // Validate output has meaningful content — reject empty/stub payloads
    if (!parsed.reflection && !parsed.kv_operations?.length) {
      return { status: "failed", error: "output.json has no reflection or kv_operations" };
    }
    return { status: "completed", output: parsed };
  } catch {
    return { status: "failed", error: "invalid JSON in output.json" };
  }
}
```

### dispatchDr — Returns job_id + workdir

```javascript
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
```

### applyDrResults — All ops through kvWriteGated, checked

All writes to `samskara:*` and `desire:*` go through `kvWriteGated`
because these are protected keys. `kvDeleteSafe` would reject them.

```javascript
async function applyDrResults(K, state, output, defaults) {
  const sessionId = await K.getSessionId();

  // 1. Apply kv_operations — ALL through kvWriteGated (protected keys)
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
    // KV has no transactions — some writes may have succeeded.
    // Log it and continue. The applied writes are still valid;
    // the blocked ones will be retried on the next DR cycle.
    // This is not ideal but unavoidable without a transaction primitive.
  }

  // 2. Write reflect history (for continuity and dashboard)
  await K.kvWriteSafe(`reflect:1:${sessionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
  });

  // 3. Write last_reflect (for dashboard and act orientation)
  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    was_deep_reflect: true,
    depth: 1,
    session_id: sessionId,
  });

  return true;
}
```

## Concurrency Safety

**No CAS needed.** The kernel's `active_session` lock prevents
overlapping `run()` calls. Only one `drCycle()` executes at a time.
The state record is lifecycle tracking, not a mutex.

The `active_session` lock is a read-then-write on a KV key — not
atomic. But Cloudflare Workers cron serializes invocations at the
platform level. For overlapping invocations to occur, two Workers
instances would need to hit the same cron within the propagation
window of KV (which is eventually consistent). This is a theoretical
risk accepted for simplicity. If it becomes real, the state machine's
status field prevents harm — a double-dispatch would see `dispatched`
on the second attempt and do nothing.

## Hot-Loop Prevention

Two mechanisms:

**1. No "empty desires" special case.** `isDrDue` only triggers
immediately on cold start (generation 0). After that, the schedule
governs. An agent that loses all desires waits for the next scheduled
DR — no hot loop possible.

**2. Failed-state backoff for actual failures.** If DR dispatch fails,
job fails, or apply fails:
- Each failure increments `consecutive_failures` and records `last_failure_session`
- Backoff: `min(20, 2^consecutive_failures)` sessions from `last_failure_session`
- After 1 failure: wait 2 sessions. After 3: wait 8. After 5: capped at 20.
- Success resets both counters to 0 / null.

## Job Record Lifecycle

`start_job` creates `job:{id}` with `status: "running"`. `drCycle`
updates it to "completed", "failed", or "expired" when detected. This
keeps `start_job`'s global concurrency gate accurate without callbacks.

The callback `curl` in `start_job.js`'s shell script is removed. Jobs
just run and exit. `drCycle` polls. Non-DR job types don't exist today.
If added later, they get their own polling cycle (same pattern as drCycle).

## What Gets Deleted

- **Callback curl** in `start_job.js` shell script
- **`/job-complete` handler** in index.js
- **Event-based DR notification** (no `job_complete` events)
- **DR job processing in actCycle** (step 2c) — removed entirely
- **`isReflectDue` function** — replaced by `isDrDue`
- **`dispatchDeepReflect` function** — replaced by `dispatchDr`
- **`reflect:schedule:1` key** — schedule embedded in `dr:state:1`

## What Gets Kept

- **`executeReflect`** — session-level reflect (not deep-reflect)
- **`gatherReflectContext`** — used by in-worker session reflect
- **`applyReflectOutput`** — used by in-worker session reflect
- **`collect_jobs.js` tool** — kept for manual debugging
- **`start_job.js` tool** — kept with callback curl removed.
  Global concurrency check stays (scans all `job:*` keys).

## Implementation Scope

**userspace.js:**
- Remove step 2c (DR job processing) from actCycle
- Remove `reflectDispatch` function
- Add `drCycle`, `isDrDue`, `pollJobResult`, `dispatchDr`, `applyDrResults`, `updateJobRecord`
- actCycle has zero DR awareness

**reflect.js:**
- Remove `dispatchDeepReflect`
- Remove `isReflectDue`, `highestReflectDepthDue`
- Keep session-level reflect: `executeReflect`, `gatherReflectContext`, `applyReflectOutput`, `runReflectInWorker`

**tools/start_job.js:**
- Remove callback curl from shell script
- Keep global concurrency check unchanged

**index.js:**
- Remove `/job-complete` handler

**Seed script:**
- Seed `dr:state:1` with `{ status: "idle", generation: 0, consecutive_failures: 0 }`

**No kernel changes.** Everything is userspace.

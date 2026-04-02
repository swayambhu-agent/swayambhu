# Design: DR Lifecycle — Independent State Machine (v2)

## Problem

Act and deep-reflect were coupled: DR result collection inside the act
cycle, callbacks to the kernel, event-based notification, shared
scheduling. Two Codex adversarial reviews identified: double-dispatch
race, missing result collection path, no failed state, DR continuity
dropped, context regression, hot-loop on empty desires, write failures
ignored.

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
  "dispatched_at": "2026-04-01T16:50:40Z",
  "completed_at": "2026-04-01T17:05:00Z",
  "applied_at": "2026-04-01T22:51:09Z",
  "failed_at": null,
  "failure_reason": null,
  "consecutive_failures": 0,
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
  const state = await K.kvGet("dr:state:1") || { status: "idle", generation: 0, consecutive_failures: 0 };

  if (state.status === "dispatched") {
    // Check TTL first
    const ttl = defaults?.deep_reflect?.ttl_minutes || 120;
    const age = (Date.now() - new Date(state.dispatched_at).getTime()) / 60000;
    if (age > ttl) {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = `TTL expired after ${Math.round(age)} minutes`;
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_expired", job_id: state.job_id, age_minutes: Math.round(age) });
      return;
    }

    // Poll for completion — one SSH check, short timeout
    const result = await pollJobResult(K, state, defaults);
    // result: { status: "running" | "completed" | "failed", output?, error? }

    if (result.status === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      // Store output in KV for apply step
      await K.kvWriteSafe(`dr:result:${state.generation}`, result.output);
      await K.kvWriteSafe("dr:state:1", state);
    } else if (result.status === "failed") {
      state.status = "failed";
      state.failed_at = new Date().toISOString();
      state.failure_reason = result.error || "non-zero exit code";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      await K.kvWriteSafe("dr:state:1", state);
      await K.karmaRecord({ event: "dr_failed", job_id: state.job_id, error: result.error });
    }
    // else still running — do nothing
    return;
  }

  if (state.status === "completed") {
    // Apply results
    const output = await K.kvGet(`dr:result:${state.generation}`);
    if (!output) {
      // Result missing — treat as failure
      state.status = "failed";
      state.failure_reason = "result missing from KV";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    const applied = await applyDrResults(K, state, output, defaults);
    if (!applied) {
      state.status = "failed";
      state.failure_reason = "apply failed — write errors";
      state.consecutive_failures = (state.consecutive_failures || 0) + 1;
      await K.kvWriteSafe("dr:state:1", state);
      return;
    }

    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = await K.getSessionCount();
    state.last_session_id = await K.getSessionId();
    state.consecutive_failures = 0;

    // Schedule from DR output or defaults
    const interval = output.next_reflect?.after_sessions
      || defaults?.deep_reflect?.default_interval_sessions || 20;
    const intervalDays = output.next_reflect?.after_days
      || defaults?.deep_reflect?.default_interval_days || 7;
    state.next_due_session = state.last_applied_session + interval;
    state.next_due_date = new Date(Date.now() + intervalDays * 86400000).toISOString();

    // Clean up result
    await K.kvDeleteSafe(`dr:result:${state.generation}`);
    await K.kvWriteSafe("dr:state:1", state);
    return;
  }

  if (state.status === "failed") {
    // Backoff: wait N sessions before retrying (exponential, capped at 20)
    const backoff = Math.min(20, Math.pow(2, state.consecutive_failures || 1));
    const sessionCount = await K.getSessionCount();
    const failedSession = state.last_applied_session || 0;
    if (sessionCount - failedSession < backoff) return; // still in backoff

    // Reset to idle, let isDrDue decide
    state.status = "idle";
    await K.kvWriteSafe("dr:state:1", state);
    // Fall through to idle check below
  }

  if (state.status === "idle") {
    if (!await isDrDue(K, state, defaults)) return;

    const jobId = await dispatchDr(K, defaults);
    if (!jobId) {
      await K.karmaRecord({ event: "dr_dispatch_failed" });
      return;
    }

    state.status = "dispatched";
    state.generation = (state.generation || 0) + 1;
    state.job_id = jobId;
    state.dispatched_at = new Date().toISOString();
    state.completed_at = null;
    state.applied_at = null;
    state.failed_at = null;
    state.failure_reason = null;
    await K.kvWriteSafe("dr:state:1", state);
    await K.karmaRecord({ event: "dr_dispatched", job_id: jobId, generation: state.generation });
  }
}
```

### isDrDue

```javascript
async function isDrDue(K, state, defaults) {
  const sessionCount = await K.getSessionCount();

  // No desires → due (bootstrap/recovery)
  const desires = await K.kvList({ prefix: "desire:" });
  if (desires.keys.length === 0) return true;

  // Session threshold
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;

  // Time threshold
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;

  return false;
}
```

### pollJobResult — SSH with timeout

Reads exit_code and output.json from the job's workdir on akash.
Short timeout (5s) prevents SSH hang from killing the cron.

```javascript
async function pollJobResult(K, state, defaults) {
  const jobs = defaults?.jobs || {};
  const baseUrl = jobs.base_url;

  // Check exit_code file
  const checkResult = await K.executeAdapter("provider:compute", {
    command: `test -f ${state.workdir}/exit_code && cat ${state.workdir}/exit_code || echo RUNNING`,
    baseUrl, timeout: 5,
  });

  if (!checkResult.ok) return { status: "running" }; // SSH failed, retry next tick
  const exitText = (checkResult.output || "").trim();
  if (exitText === "RUNNING") return { status: "running" };

  const exitCode = parseInt(exitText, 10);
  if (exitCode !== 0) return { status: "failed", error: `exit code ${exitCode}` };

  // Read output.json
  const outputResult = await K.executeAdapter("provider:compute", {
    command: `cat ${state.workdir}/output.json 2>/dev/null || echo '{}'`,
    baseUrl, timeout: 10,
  });

  if (!outputResult.ok) return { status: "failed", error: "could not read output" };

  const raw = (outputResult.output || "").trim();
  try {
    const parsed = JSON.parse(raw);
    return { status: "completed", output: parsed };
  } catch {
    return { status: "failed", error: "invalid JSON in output.json" };
  }
}
```

Note: `pollJobResult` needs access to the job's workdir. The state
record stores `workdir` (set during dispatch, from start_job result).
Add `workdir` to the state record.

### dispatchDr

Uses `start_job` tool. Context includes the full set needed by the
S/D operator prompt — not simplified. `gatherReflectContext` is NOT
used (it was for in-worker reflect). The DR prompt on akash receives
raw KV files via the tarball mechanism in `start_job`.

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
  return result.job_id;
}
```

Context keys include `reflect:1:*` and `last_reflect` so the DR prompt
has continuity with prior reflections (addresses Codex finding #6 —
DR continuity).

### applyDrResults — Idempotent, Checked

```javascript
async function applyDrResults(K, state, output, defaults) {
  const sessionId = await K.getSessionId();

  // 1. Apply kv_operations (samskara:* and desire:* only)
  const ops = (output.kv_operations || []).filter(op =>
    op.key?.startsWith("samskara:") || op.key?.startsWith("desire:")
  );

  const blocked = [];
  for (const op of ops) {
    if (op.op === "delete") {
      await K.kvDeleteSafe(op.key);
    } else {
      const result = await K.kvWriteGated(op, "deep-reflect");
      if (!result.ok) blocked.push({ key: op.key, error: result.error });
    }
  }

  if (blocked.length > 0) {
    await K.karmaRecord({ event: "dr_apply_blocked", blocked });
    // Partial apply is worse than no apply — return false
    return false;
  }

  // 2. Write reflect history (addresses Codex finding #6)
  await K.kvWriteSafe(`reflect:1:${sessionId}`, {
    reflection: output.reflection,
    note_to_future_self: output.note_to_future_self,
    depth: 1,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    from_dr_generation: state.generation,
  });

  // 3. Write last_reflect (for act orientation and dashboard)
  await K.kvWriteSafe("last_reflect", {
    session_summary: output.reflection,
    was_deep_reflect: true,
    depth: 1,
    session_id: sessionId,
  });

  return true;
}
```

## Race Condition Analysis

**No CAS needed.** The kernel's `active_session` lock guarantees only
one `run()` executes at a time. There is no concurrent access to
`dr:state:1`. The state record is lifecycle tracking, not a lock.

**No double-dispatch.** Only one `run()` at a time means only one
`drCycle()` at a time. If state is `dispatched`, it can't be read as
`idle` by a concurrent caller because there are no concurrent callers.

## Hot-Loop Prevention

If desires are empty and DR repeatedly fails to create them:
- Each failure increments `consecutive_failures`
- Backoff: `min(20, 2^consecutive_failures)` sessions before retry
- After 5 failures: 32 sessions (capped at 20) ≈ 5 days at 6h intervals
- Success resets `consecutive_failures` to 0

## What Gets Deleted

- **Callback curl** in `start_job.js` shell script — jobs just exit
- **`/job-complete` handler** in index.js — no more callback endpoint
- **Event-based DR notification** — no `job_complete` events
- **DR job processing in actCycle** (step 2c) — removed entirely
- **`isReflectDue` function** — replaced by `isDrDue`
- **`dispatchDeepReflect` function** — replaced by `dispatchDr`
- **`reflect:schedule:1` key** — schedule in `dr:state:1`

## What Gets Kept

- **`executeReflect`** — session-level reflect (not deep-reflect)
- **`gatherReflectContext`** — used by in-worker reflect path
- **`applyReflectOutput`** — used by in-worker reflect path
- **`collect_jobs.js` tool** — kept for manual debugging
- **`start_job.js` tool** — kept, but callback curl removed from shell script
- **`start_job` concurrency check** — kept as global compute capacity gate

## State Record Fields

```
status              "idle" | "dispatched" | "completed" | "failed"
generation          monotonic counter, incremented on each dispatch
job_id              current/last job ID
workdir             remote workdir path (from start_job result)
dispatched_at       when dispatched
completed_at        when job finished
applied_at          when results written to KV
failed_at           when failure detected
failure_reason      human-readable error
consecutive_failures count of failures without a successful apply (backoff)
next_due_session    session count threshold for next DR
next_due_date       wall-clock date threshold for next DR
last_applied_session session count when last successfully applied
last_session_id     session ID when last successfully applied
```

## Implementation Scope

**userspace.js:**
- Remove step 2c (DR job processing) from actCycle
- Remove `reflectDispatch` function
- Add `drCycle`, `isDrDue`, `pollJobResult`, `dispatchDr`, `applyDrResults`
- actCycle has zero DR awareness

**reflect.js:**
- Remove `dispatchDeepReflect`
- Remove `isReflectDue`, `highestReflectDepthDue`
- Keep `executeReflect`, `gatherReflectContext`, `applyReflectOutput`,
  `runReflectInWorker` for session-level reflect

**tools/start_job.js:**
- Remove callback curl from shell script
- Keep global concurrency check (do NOT simplify to dr:state check)

**index.js:**
- Remove `/job-complete` handler

**Seed script:**
- Seed `dr:state:1` with `{ status: "idle", generation: 0, consecutive_failures: 0 }`

**No kernel changes.** Everything is userspace.

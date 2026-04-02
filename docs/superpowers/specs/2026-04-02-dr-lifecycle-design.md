# Design: DR Lifecycle — Independent State Machine

## Problem

Act sessions and deep-reflect are coupled in multiple ways:
- DR result collection happens inside the act cycle
- DR dispatch is triggered by the act session
- A callback mechanism tries to notify the kernel (wrong layer)
- No coordination primitive prevents double-dispatch or duplicate application
- Job polling scans all `job:*` keys, not just the current DR

Codex adversarial review identified: double-dispatch race, lost updates,
SSH hang killing scheduling, non-idempotent application, O(all jobs) polling.

## Design: State Machine on a Single KV Key

DR manages its own lifecycle through one KV record: `dr:state:1`
(one per reflect depth). The cron is just a clock tick — DR decides
for itself whether to run.

### State Record

```json
{
  "status": "idle",
  "generation": 4,
  "job_id": "j_1775062240706_r5b2",
  "dispatched_at": "2026-04-01T16:50:40Z",
  "completed_at": "2026-04-01T17:05:00Z",
  "applied_at": "2026-04-01T22:51:09Z",
  "next_due_session": 25,
  "next_due_date": "2026-04-08T00:00:00Z",
  "last_applied_session": 5
}
```

### State Transitions

```
idle ──(due)──→ dispatched ──(job done)──→ completed ──(results applied)──→ idle
  ↑                 │                          │
  │            (ttl expired)              (crash recovery)
  │                 │                          │
  └────(expired)────┘                     (next run sees
                                           "completed", retries
                                           apply, sets idle)
```

### drCycle Logic

```javascript
async function drCycle(K) {
  const defaults = await K.getDefaults();
  const state = await K.kvGet("dr:state:1") || { status: "idle", generation: 0 };

  if (state.status === "dispatched") {
    // Poll for completion — one SSH check, one job
    const job = await pollJob(K, state.job_id);
    if (job === "completed") {
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      await K.kvWriteSafe("dr:state:1", state);
    } else if (job === "expired") {
      state.status = "idle"; // TTL exceeded, give up on this job
      await K.kvWriteSafe("dr:state:1", state);
    }
    // else still running — do nothing, check next session
    return;
  }

  if (state.status === "completed") {
    // Apply results to KV
    await applyDrResults(K, state);
    state.status = "idle";
    state.applied_at = new Date().toISOString();
    state.last_applied_session = await K.getSessionCount();
    // Schedule next DR
    state.next_due_session = state.last_applied_session + (defaults?.deep_reflect?.default_interval_sessions || 20);
    await K.kvWriteSafe("dr:state:1", state);
    return;
  }

  if (state.status === "idle") {
    // Check if due
    if (!isDrDue(K, state, defaults)) return;
    // Dispatch
    const jobId = await dispatchDr(K, defaults);
    if (!jobId) return; // dispatch failed, try next session
    state.status = "dispatched";
    state.generation += 1;
    state.job_id = jobId;
    state.dispatched_at = new Date().toISOString();
    state.completed_at = null;
    state.applied_at = null;
    await K.kvWriteSafe("dr:state:1", state);
    return;
  }
}
```

### Why Each Codex Finding Is Resolved

**1. Double-dispatch race:** Impossible. Can't go from `dispatched` to
`dispatched`. The state record is the lock. One read, one check,
one write.

**2. Non-idempotent apply:** If crash after apply but before setting
`idle`, next run sees `completed`, calls `applyDrResults` again.
Make `applyDrResults` idempotent: write samskaras/desires as full
values (not patches), so re-applying is harmless.

**3. Stale-result reversion:** Generation counter. If a DR job returns
results for generation N but state is already at generation N+1,
reject the stale results.

**4. SSH hang:** `pollJob` has a short timeout (5s). If SSH hangs,
it throws, `drCycle` catches it (already in try/catch in `run()`),
schedule update still runs. No unbounded blocking.

**5. O(all jobs) polling:** `drCycle` polls exactly one job — the one
in `state.job_id`. No scanning `job:*` keys. Start_job's concurrency
check can be simplified to check `dr:state:1.status === "dispatched"`.

**6. Zombie handling:** TTL check is part of the state machine. If
`dispatched_at` is older than TTL, transition to `idle`. No separate
expiry mechanism needed.

**7. Lost updates on samskara writes:** Separate concern from DR
lifecycle. Act writes strength-only updates (EMA). DR writes full
samskara objects (create/delete). These are different write patterns.
Act should write only the strength field, not the whole object. (This
is a separate fix for `writeMemory` in userspace.js.)

### isDrDue — Simplified

No longer needs the complex `isReflectDue` function. The state record
contains everything:

```javascript
function isDrDue(K, state, defaults) {
  const sessionCount = await K.getSessionCount();
  const desires = await K.kvList({ prefix: "desire:" });

  // No desires → always due (bootstrap/recovery)
  if (desires.keys.length === 0) return true;

  // Session threshold
  if (state.next_due_session && sessionCount >= state.next_due_session) return true;

  // Time threshold
  if (state.next_due_date && new Date() >= new Date(state.next_due_date)) return true;

  return false;
}
```

### dispatchDr — Simplified

Uses `start_job` tool but no longer needs the complex prompt loading
from `gatherReflectContext`. The DR prompt is in KV (`prompt:deep_reflect`),
context keys are fixed:

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
        ],
      }),
    },
  });

  return result?.ok ? result.job_id : null;
}
```

### applyDrResults — Idempotent

Reads job output from akash, parses kv_operations, writes to KV.
Full-value writes (not patches) so re-application is harmless.

```javascript
async function applyDrResults(K, state) {
  // Read output from akash via collect_jobs logic
  const result = await collectJobResult(K, state.job_id);
  if (!result?.kv_operations) return;

  // Filter to samskara:* and desire:* only
  const ops = result.kv_operations.filter(op =>
    op.key?.startsWith("samskara:") || op.key?.startsWith("desire:")
  );

  // Apply (idempotent full-value writes)
  for (const op of ops) {
    if (op.op === "delete") {
      await K.kvDeleteSafe(op.key);
    } else {
      await K.kvWriteGated(op, "deep-reflect");
    }
  }

  // Update reflect schedule
  if (result.next_reflect) {
    const sessionCount = await K.getSessionCount();
    // Schedule is embedded in dr:state:1, not a separate key
  }
}
```

### What Gets Deleted

- **Callback mechanism:** The `curl` in `start_job.js` shell script.
  Jobs run and exit. Results are polled.
- **`/job-complete` endpoint** (if it exists in the kernel)
- **Event-based DR notification:** No more `job_complete` events.
  `drCycle` polls directly.
- **`reflect:schedule:1` key:** Schedule lives in `dr:state:1`
- **`isReflectDue` function** in reflect.js — replaced by `isDrDue`
  reading the state record
- **DR job processing in actCycle (step 2c)** — moved to `drCycle`
- **`collect_jobs.js` tool** — logic inlined into `drCycle`. The tool
  was a manual fallback for the broken callback. With state-machine
  polling, it's redundant.

### What actCycle Loses

Step 2c (deep-reflect job completions from events) is removed entirely.
actCycle has zero DR awareness. It reads samskaras and desires from KV
at session start — whatever `drCycle` wrote last time is what it sees.
One session of lag, which is fine for background cognitive evolution.

### Callback: Keep or Delete?

Delete. The callback was:
1. Wrong layer (kernel endpoint for a userspace concern)
2. Unreliable (wrong URL, curl failures)
3. Unnecessary (polling is simpler and more robust)

The only benefit of callbacks is lower latency (DR results arrive
mid-session instead of next session). But DR is a slow background
process — six-hour intervals. One session of lag is irrelevant.

### userspace.js Final Shape

```javascript
export async function run(K, { crashData, balances, events, schedule }) {
  // Two independent systems, same clock tick
  try { await actCycle(K, { crashData, balances, events, schedule }); }
  catch (e) { await K.karmaRecord({ event: "act_cycle_error", ... }); }

  try { await drCycle(K); }
  catch (e) { await K.karmaRecord({ event: "dr_cycle_error", ... }); }

  // Schedule always runs
  try { await updateSchedule(K); }
  catch (e) { await K.karmaRecord({ event: "schedule_error", ... }); }

  await K.karmaRecord({ event: "session_complete", ... });
}
```

Act and DR are peers. They share the clock and the KV store. Nothing else.

### Implementation Scope

**userspace.js:**
- Remove step 2c (DR job processing) from actCycle
- Rewrite `reflectDispatch` → `drCycle` with state machine
- Inline `isDrDue` (replaces `isReflectDue` from reflect.js)
- Inline `pollJob`, `dispatchDr`, `applyDrResults`

**reflect.js:**
- Remove `dispatchDeepReflect` (moved to userspace drCycle)
- Remove `isReflectDue` (replaced by isDrDue)
- Keep `executeReflect`, `gatherReflectContext`, `applyReflectOutput`
  for in-worker reflect (session-level reflect, not deep-reflect)

**tools/start_job.js:**
- Remove callback curl from shell script
- Simplify concurrency check (just check `dr:state:1.status`)

**tools/collect_jobs.js:**
- Keep for manual debugging, but `drCycle` doesn't use it

**Seed script:**
- Seed `dr:state:1` with `{ status: "idle", generation: 0 }` on fresh start

**No kernel changes.** Everything is userspace.

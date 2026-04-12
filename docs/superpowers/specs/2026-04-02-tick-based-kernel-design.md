# Design: Tick-Based Kernel — Sessions Are Policy, Executions Are Infrastructure

## Problem

The kernel owns `session_schedule`, `session_counter`, `session_start`,
and `session_complete`. This couples deep-reflect's lifecycle to the act
session schedule — DR can only advance one state per session (potentially
6 hours apart). The kernel is supposed to be cognitive-architecture-agnostic,
but "session" is a cognitive concept.

Codex independently confirmed: the current split is muddled enough to
cause a correctness bug — `runSession()` catches errors internally and
returns `{ ok: false }`, but `executeHook()` still records `"clean"`
because the error doesn't propagate as an exception.

## Core Principle

The kernel owns **executions** (ticks). Userspace owns **sessions**.

An execution is: cron fires → kernel acquires lock → kernel checks safety
→ kernel calls userspace → kernel records outcome → kernel releases lock.
The kernel does not know or care what userspace does with the tick.

A session is: userspace decides it's time for an act cycle, increments
its own counter, loads context, runs the plan-act-eval loop. This is
cognitive policy. The kernel never sees it.

## What Moves

### From kernel to userspace

| Concern | Current location | New location |
|---------|-----------------|--------------|
| Schedule gate (`session_schedule` check) | `kernel.runSession()` line 819-831 | `userspace.actCycle()` — reads `session_schedule`, returns early if not due |
| Session counter (`session_counter` increment) | `kernel.runSession()` line 839-840 | `userspace.actCycle()` — increments when an act session actually runs |
| Session ID cache (`cache:session_ids`) | `kernel.runSession()` line 841-843 | `userspace.actCycle()` |
| Session start karma | `kernel.runSession()` line 845-852 | `userspace.actCycle()` |
| Session health write | `kernel.runSession()` line 860 | Removed — replaced by execution health |
| Session outcome history | `kernel.runSession()` line 861 | Removed — replaced by execution outcomes |

### Stays in kernel (renamed)

| Old | New | Purpose |
|-----|-----|---------|
| `kernel:active_session` | `kernel:active_execution` | Overlap prevention |
| `kernel:last_sessions` | `kernel:last_executions` | Crash detection / safety tripwire |
| `this.sessionId` | `this.executionId` | Unique ID for this tick |
| `getSessionId()` | `getExecutionId()` | Exposed to userspace via K |
| `getSessionCount()` | Removed from kernel | Userspace owns session counting |
| `_writeSessionHealth()` | `_writeExecutionHealth()` | Execution-level health |
| `updateSessionOutcome()` | `updateExecutionOutcome()` | Execution-level outcome |

### K interface changes

| Removed | Replacement |
|---------|------------|
| `K.getSessionCount()` | Userspace reads `session_counter` from KV directly |
| `K.getSessionId()` | `K.getExecutionId()` — returns execution ID, userspace maps to session if needed |

## Kernel Flow (after refactor)

```
runScheduled()
  +-- Execution lock (prevent overlapping ticks)
  +-- Stale lock detection (mark dead executions as killed)
  +-- Safety check (3 consecutive bad outcomes -> rollback + fallback)
  +-- runTick()
       +-- Load config (dharma, principles, key tiers, models)
       +-- Infrastructure inputs (crash detection, balances, drain events)
       +-- Call HOOKS.tick.run(K, { crashData, balances, events })
       +-- Record execution outcome (clean/crash)
       +-- Release lock
```

Key changes from current:
1. **No schedule gate.** The kernel calls userspace on every cron tick.
2. **No session bookkeeping.** No counter, no session_start karma, no session IDs.
3. **`runSession()` and `executeHook()` merge into `runTick()`.** This fixes the
   correctness bug where errors in `runSession()` were swallowed.
4. **Hook renamed from `HOOKS.session` to `HOOKS.tick`.** Reflects the new semantics.

### runTick (replaces runSession + executeHook)

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

  // Always record execution outcome (for crash tripwire)
  await this._writeExecutionHealth(outcome);
  await this.updateExecutionOutcome(outcome);
  await this.kv.delete("kernel:active_execution");
}
```

No more split between `executeHook()` and `runSession()`. One method,
one try/catch, one outcome recording path. The bug where errors were
swallowed is structurally impossible.

### Fallback mode (unchanged in spirit)

If 3 consecutive executions are bad, the kernel runs a hardcoded minimal
tick. Same as before — check balances, report status. The fallback
doesn't need to know about sessions.

## Userspace Flow (after refactor)

```javascript
// userspace.js — the tick handler
export async function run(K, { crashData, balances, events }) {
  // Independent concern 1: Act session (schedule-gated)
  try {
    await actCycle(K, { crashData, balances, events });
  } catch (e) {
    await K.karmaRecord({ event: "act_cycle_error", error: e.message });
  }

  // Independent concern 2: DR lifecycle (runs every tick)
  try {
    await drCycle(K);
  } catch (e) {
    await K.karmaRecord({ event: "dr_cycle_error", error: e.message });
  }
}
```

### actCycle — now owns its own schedule

```javascript
async function actCycle(K, { crashData, balances, events }) {
  // Schedule gate — userspace decides if it's time
  const schedule = await K.kvGet("session_schedule");
  if (!isSessionDue(schedule)) return;

  // Session bookkeeping — userspace concept
  const count = (await K.kvGet("session_counter")) || 0;
  await K.kvWriteSafe("session_counter", count + 1);

  await K.karmaRecord({
    event: "session_start",
    session_number: count + 1,
    scheduled_at: schedule?.next_session_after || null,
    crash_detected: !!crashData,
    balances,
  });

  // ... existing act cycle logic (plan, act, eval, review) ...

  // Schedule next session
  const defaults = await K.getDefaults();
  const intervalSeconds = defaults?.schedule?.interval_seconds || 21600;
  await K.kvWriteSafe("session_schedule", {
    next_session_after: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    interval_seconds: intervalSeconds,
  });
}

function isSessionDue(schedule) {
  const next = schedule?.next_session_after;
  if (!next) return false;
  return Date.now() >= new Date(next).getTime();
}
```

### drCycle — unchanged but now truly independent

`drCycle` already reads its own state from `dr:state:1` and decides
what to do. The only change: it now runs on every cron tick (e.g. every
minute or every 5 minutes) instead of every 6 hours. This means:

- **Dispatch → poll → apply** can happen within minutes, not 12+ hours
- DR polling is cheap (one KV read, maybe one SSH call)
- `isDrDue` still gates dispatch on session count + time thresholds

One note: `isDrDue` currently references `K.getSessionCount()`. This
changes to reading `session_counter` from KV directly, since the kernel
no longer exposes it.

## DR State Machine: session count vs time

The DR state record tracks `next_due_session` and `next_due_date`. With
the tick-based kernel, `next_due_date` becomes the primary scheduling
mechanism (it works on wall-clock time, independent of session cadence).

`next_due_session` still works — `isDrDue` reads `session_counter` from
KV. But it's now secondary to the time-based trigger since ticks happen
more frequently than sessions.

## Cron Frequency

Currently the cron is set to match the session schedule (presumably
every few hours or triggered manually via `/__scheduled`). With a
tick-based kernel, the cron should fire more frequently — every 1-5
minutes — since DR polling needs sub-session granularity.

This is a wrangler.toml / Cloudflare cron config change, not a code
change. For local dev, `/__scheduled` continues to work for manual
triggers.

The session schedule gate in userspace ensures act sessions don't run
more often than intended, regardless of cron frequency.

## What Gets Deleted

- `kernel.runSession()` — replaced by `runTick()`
- `kernel.executeHook()` — merged into `runTick()`
- `kernel._isSessionDue()` — moves to userspace as `isSessionDue()`
- `kernel.getSessionCount()` — userspace reads KV directly
- `kernel._writeSessionHealth()` — renamed to `_writeExecutionHealth()`
- `kernel.updateSessionOutcome()` — renamed to `updateExecutionOutcome()`
- Schedule gate logic from kernel
- Session counter increment from kernel
- Session start karma from kernel

## What Gets Renamed

- `kernel:active_session` → `kernel:active_execution`
- `kernel:last_sessions` → `kernel:last_executions`
- `this.sessionId` → `this.executionId`
- `HOOKS.session` → `HOOKS.tick`

## Migration

This is v0.1 — no backwards compatibility needed. Wipe local state with
`--reset-all-state` and re-seed. The seed script updates to seed
`kernel:active_execution` instead of `kernel:active_session`.

## Boundary Summary

**Kernel owns (infrastructure):**
- Execution lock and overlap prevention
- Crash/kill detection for executions
- Safety tripwire (3 consecutive bad outcomes → rollback)
- KV access with tier enforcement
- LLM calling with dharma/principles injection
- Tool dispatch with safety gates
- Event bus
- Code staging
- Budget metering
- Karma recording

**Kernel does NOT own:**
- When to run act sessions (session schedule)
- What a "session" is
- Session counting or session IDs
- What to do during a tick
- Whether to run DR, act, both, or neither
- Any cognitive architecture concepts

**Userspace owns (policy):**
- Session schedule gate
- Session bookkeeping (counter, IDs, start/complete karma)
- Act cycle (plan → act → eval → review → memory)
- DR lifecycle (state machine, polling, dispatch, apply)
- Reflection scheduling
- All cognitive architecture concepts (desires, samskaras, experiences)

## Implementation Scope

**kernel.js:**
- Merge `executeHook()` + `runSession()` → `runTick()`
- Remove schedule gate, session counter, session bookkeeping
- Rename session → execution in lock/crash/safety/health code
- Remove `getSessionCount()` from K interface
- Rename `getSessionId()` → `getExecutionId()` in K interface
- Rename `HOOKS.session` → `HOOKS.tick`

**userspace.js:**
- Add schedule gate to `actCycle()` (move from kernel)
- Add session bookkeeping to `actCycle()` (counter, karma, IDs)
- Remove `schedule` from `run()` signature (userspace reads KV directly)
- Update `drCycle` to read `session_counter` from KV instead of `K.getSessionCount()`

**index.js:**
- Change `HOOKS` from `{ session }` to `{ tick: session }` (or rename the import)

**seed script:**
- Seed `kernel:active_execution` instead of `kernel:active_session`
- Keep seeding `session_schedule` and `session_counter` (now userspace-owned)

**wrangler.toml:**
- Consider increasing cron frequency for production

**Tests:**
- Update kernel tests for execution-based naming
- Add test: act cycle skips when schedule not due
- Add test: drCycle runs even when act session not due
- Update userspace tests for schedule ownership

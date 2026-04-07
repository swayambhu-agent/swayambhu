# Wake Provenance And External Trigger Plan

Date: 2026-04-07

This plan is grounded in the current source at:

- [index.js](/home/swami/swayambhu/repo/index.js)
- [kernel.js](/home/swami/swayambhu/repo/kernel.js)
- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [scripts/dev-loop/observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs)
- [config/event-handlers.json](/home/swami/swayambhu/repo/config/event-handlers.json)
- [docs/superpowers/specs/2026-04-07-three-tier-runtime-evolution.md](/home/swami/swayambhu/repo/docs/superpowers/specs/2026-04-07-three-tier-runtime-evolution.md)

Claude review outcome:

- the original dev-loop-specific payload was overfit
- wake provenance should be carried as kernel facts, not as userspace policy
- the kernel should transport wake metadata
- userspace should decide what the wake means

Design target: replace hidden schedule manipulation with an explicit wake path.
External wakes must be visible to userspace, must be able to bypass the normal
schedule gate when appropriate, and must not be mislearned as evidence about the
agent's own scheduler.

## Problem

The current dev-loop observe path forces sessions by:

1. calling `POST /__clear-schedule`
2. mutating `session_schedule.next_session_after` into the past
3. calling `/__scheduled`

This creates two problems:

1. userspace cannot distinguish a natural scheduled wake from a forced wake
2. the agent can misattribute externally forced wakes to internal scheduling

That is exactly what happened overnight:

- false scheduler narratives appeared
- `pattern:session:interval-config-delay` was learned from contaminated data
- reflect and DR used those wakes as if they were evidence about the agent's own
  interval behavior

The fix is not to annotate dev-loop prose more clearly.

The fix is to make wake provenance first-class in the runtime.

## Main Decision

Do not keep using `__clear-schedule` as the normal dev-loop trigger path.

Introduce a dedicated external wake path using an explicit `wake` event:

```json
{
  "type": "wake",
  "origin": "external",
  "trigger": {
    "actor": "dev_loop",
    "context": {
      "intent": "probe"
    }
  },
  "timestamp": "2026-04-07T12:00:00.000Z"
}
```

Important boundary:

- `origin` is kernel/runtime fact
- `trigger.actor` and `trigger.context` are provenance facts
- whether the wake counts as scheduler evidence is userspace policy, not an
  event field

## Why Not Reuse `session_request`

Do not overload `session_request`.

`session_request` is a work contract emitted when someone asks the agent to do
something.

`wake` is an infrastructure trigger that says:

- run a session now
- here is why the wake happened

Those are different concepts and should remain different event types.

## Runtime Contract

### Scheduled wake

This is the normal cron path.

- no `wake` event is required
- userspace treats the absence of an external wake as normal scheduled behavior

Optional later refinement:

- kernel may inject synthetic wake metadata with `origin: "scheduled"`

That is not required for the first implementation.

### External wake

This is any explicit out-of-band session trigger.

Examples:

- dev-loop probe
- patron “run now” button
- operator CLI wake
- monitoring or watchdog wake

These must flow through:

1. emit `wake` event
2. call `runScheduled()`
3. let userspace inspect the `wake` event

They must not mutate `session_schedule` to fake a scheduled wake.

## Implementation Stages

## Stage 1: Add Explicit `/__wake`

Files:

- [index.js](/home/swami/swayambhu/repo/index.js)

Changes:

- add `POST /__wake`
- accept a JSON body with:
  - `actor`
  - optional `context`
- emit a `wake` event into the event bus with:
  - `type: "wake"`
  - `origin: "external"`
  - `trigger.actor`
  - `trigger.context`
- immediately call `runScheduled()` after emitting the event

Rules:

- no `session_schedule` mutation in this path
- no use of `advanceSessionSchedule()` for plain external wake
- endpoint should remain admin/dev-only like current scheduler helpers

Result:

- external sessions become visible runtime facts instead of hidden schedule
  hacks

## Stage 2: Teach Userspace About Wake Provenance

Files:

- [userspace.js](/home/swami/swayambhu/repo/userspace.js)

Changes:

1. add a helper to extract the relevant wake event from `events`
2. surface wake provenance in `buildCircumstances()`
3. make the schedule gate in `actCycle()` respect external wake provenance
4. record wake provenance in `act_start` karma

Target behavior:

- if an external wake event is present, userspace may run even when
  `session_schedule.next_session_after` is still in the future
- if no external wake event is present, the existing schedule gate remains
  unchanged

Required `act_start` fields:

- `wake_origin`
- `wake_actor`
- `wake_context`
- `scheduled_at`

This makes the provenance visible to:

- plan
- reflect
- session analysis
- dev-loop

without adding a new cognitive concept.

## Stage 3: Replace Dev-Loop Triggering

Files:

- [scripts/dev-loop/observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs)

Changes:

- stop calling `POST /__clear-schedule` in accumulate mode
- stop using schedule mutation as the way to force sessions
- replace that setup with `POST /__wake`

Recommended request body:

```json
{
  "actor": "dev_loop",
  "context": {
    "intent": "probe"
  }
}
```

Result:

- dev-loop can still force observation cycles
- but the agent now knows they were externally caused

## Stage 4: Deprecate `__clear-schedule`

Files:

- [index.js](/home/swami/swayambhu/repo/index.js)
- [scripts/dev-loop/observe.mjs](/home/swami/swayambhu/repo/scripts/dev-loop/observe.mjs)

Changes:

- keep `__clear-schedule` only as a temporary compatibility/debug endpoint
- add a deprecation note in code comments
- remove it from all normal dev-loop paths

Do not remove it immediately if there are still manual workflows depending on
it. But it should stop being part of the standard observation loop.

## Stage 5: Clean Up Contaminated Scheduler Learning

Files:

- runtime KV state
- follow-up analysis tooling if needed

Actions:

- explicitly treat prior forced-wake scheduler evidence as contaminated
- delete or retire the false pattern `pattern:session:interval-config-delay`
- rerun a shorter validation loop after the new wake path lands

This cleanup is part of making the next corpus trustworthy.

## Tests

### `index.js`

- `POST /__wake` emits exactly one `wake` event
- `POST /__wake` triggers a scheduled execution
- `POST /__wake` does not rewrite `session_schedule`

### `userspace.js`

- natural scheduled tick with future `next_session_after` still skips
- external wake with future `next_session_after` bypasses the schedule gate
- `act_start` karma includes `wake_origin` and `wake_actor`

### `observe.mjs`

- accumulate strategy uses `/__wake`, not `/__clear-schedule`
- no schedule-clearing shell command remains in the normal path

## Validation Protocol

After implementation, run a short validation loop of 10-15 sessions.

What to verify:

1. externally forced sessions record `wake_origin = "external"`
2. naturally scheduled sessions do not carry external wake provenance
3. scheduler reasoning stops attributing dev-loop probes to internal interval
   failure
4. no new `pattern:session:interval-config-delay` evidence appears from forced
   probes

Important rule for analysis:

- external wakes do not count as evidence about interval correctness

Scheduler correctness should only be evaluated from:

- naturally scheduled wakes
- or explicit future validation logic designed for scheduler tests

## Success Criteria

This plan is complete when all of the following are true:

1. dev-loop can wake the agent without touching `session_schedule`
2. userspace can distinguish scheduled wakes from external wakes
3. forced wakes no longer pollute scheduler-learning signals
4. `pattern:session:interval-config-delay` is recognized as contaminated and
   removed or retired
5. the wake contract is generic enough to support future actors besides
   dev-loop

## Non-Goals

This plan does not:

- redesign the cognitive architecture
- add a new curiosity or motivation layer
- solve reflect/tactic access generally
- introduce a full generic admin command bus

It only fixes wake provenance and the scheduler-learning contamination caused by
hidden external triggers.

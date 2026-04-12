# DR-1 / DR-2 Self-Modification Handoff

Date: 2026-04-10

Status: Draft

## Purpose

Make the existing DR-1 / DR-2 split real in runtime authority, not just in
prompt wording.

The immediate problem is narrow:

- `deep_reflect` / DR-1 still has live code-staging power via
  `code_stage_requests` and `deploy`
- `userspace_review` / DR-2 can diagnose userspace defects, but does not yet
  own the code-change path

The goal is to move code-change authorship out of DR-1 without accidentally
moving all bounded prompt/config learning out of live operational review.

## Main Decision

Make one surgical cut:

- DR-1 keeps its existing `kvWriteGated` write path for protected non-code
  state
- DR-1 loses `code_stage_requests` and `deploy`
- DR-2 owns userspace code-change authorship through the lab
- governor remains the live deployment path for code

This is the smallest change that makes the boundary real.

## What DR-1 Keeps

This plan does **not** remove DR-1's existing protected non-code writes.

DR-1 keeps direct live `kvWriteGated` authority for the key families already
applied by `applyDrResults()`:

- `pattern:*`
- `desire:*`
- `tactic:*`
- `identification:*` when identity review is enabled
- `config:*`
- `prompt:*`

Interpretation:

- first-order cognitive-state updates remain live DR-1 work
- bounded prompt/config changes that preserve the current architecture remain
  live DR-1 work
- this plan is only about removing live code staging from DR-1

Whether some future subset of `config:*` or `prompt:*` should also move to
DR-2 is a separate question and is intentionally not decided here.

## What DR-1 Loses

Remove these live outputs from DR-1:

- `code_stage_requests`
- `deploy`

Consequences:

- `deep_reflect.md` should stop advertising code staging
- `applyDrResults()` should stop staging code and signaling deploy from
  DR-1 output

From that point on, any userspace code change must flow through DR-2 lab
validation before it reaches governor staging.

## Escalation Surface: `review_note:*`

DR-1's escalation surface is `review_note:*`.

This already exists and should become the sole live bridge from DR-1 into DR-2.

Current implementation references:

- note normalization and key construction live in `meta-policy.js`
- note persistence from DR-1 happens in `applyDrResults()` in `userspace.js`

### Contract

Key format:

- `review_note:{target_review}:{source_session_id}:d{depth}:{ordinal}:{slug}`

Payload:

- `slug`
- `summary`
- `subsystem`
- `observation`
- `proposed_experiment`
- `rationale`
- `target_review`
- `non_live`
- `confidence`
- `created_at`
- `source`
- `source_session_id`
- `source_depth`
- `source_reflect_key`

### Meaning

`review_note:*` is not a command and not a patch request.

It is append-only divergence evidence:

- a trace-grounded note that later behavior no longer fits an earlier state
- plus enough metadata for DR-2 to build a compact review bundle

### Lifecycle

`review_note:*` should remain historical evidence and should **not** be deleted
when DR-2 processes it.

Processing state should live elsewhere.

This keeps:

- the trace evidence durable
- DR-2 retryable
- later replay and dev-loop analysis possible

## DR-2 Trigger And Lifecycle

Do **not** invent a second unrelated heartbeat.

Follow the existing runtime direction:

- keep dispatch inside the live scheduling loop
- give DR-2 its own state machine and trigger policy

### New runtime state

Add `dr2:state:1`.

Add `dr2:state:*` and `dr2:result:*` to a non-agent-writable lifecycle tier.

They must not default to ordinary agent keys, because validated stageable
payloads must not be forgeable from act-time cognition.

Suggested minimal shape:

```json
{
  "status": "idle|dispatched|completed|failed",
  "generation": 0,
  "active_review_note_key": "review_note:...",
  "processed_note_keys": ["review_note:..."],
  "processed_through_created_at": "ISO8601 or null",
  "result_ref": "branch or artifact path or null",
  "dispatched_at": "ISO8601 or null",
  "completed_at": "ISO8601 or null",
  "failed_at": "ISO8601 or null",
  "failure_reason": "string or null",
  "consecutive_failures": 0,
  "next_due_session": 0,
  "next_due_date": "ISO8601 or null"
}
```

### Trigger policy

V1 should stay simple:

- if DR-2 is idle
- and there exists at least one new `review_note:*` targeting
  `userspace_review`
- and the DR-2 cooldown has elapsed
- dispatch one DR-2 review for the earliest unprocessed note by `created_at`

Why this is enough for v1:

- DR-1 already emits `review_note:*` conservatively
- note volume is currently low
- a one-note-at-a-time queue is enough to make the bridge real

Important detail:

- do not rely on lexicographic key order for note processing
- scan `review_note:userspace_review:*`
- ignore keys already in the bounded recent `processed_note_keys` set
- ignore notes older than `processed_through_created_at`
- order candidates by payload `created_at`

Future note clustering or recurrence thresholds can come later if the queue
becomes noisy.

### Write path for lifecycle state

This design needs a dedicated runtime write path for lifecycle state.

Reason:

- `kvWriteSafe` must not remain the write path for forged-stageable state
- `kvWriteGated("deep-reflect")` is the wrong abstraction for runtime
  bookkeeping

The clean fix is a small kernel primitive for runtime-owned lifecycle keys,
for example:

- `K.writeLifecycleState(key, value)`
- `K.deleteLifecycleState(key)`

This same primitive should absorb the existing `dr:state:*` and `dr:result:*`
path in the same pass, so the old DR state machine and the new DR-2 state
machine use one consistent internal write surface.

## DR-2 Is Two-Step, Not One Prompt

Do **not** solve this by copying DR-1's old `code_stage_requests` block into
`userspace_review`.

DR-2 should stay split:

1. `userspace_review`
   - read-only diagnosis
   - identifies root constraint
   - proposes the smallest structural change and validation plan
2. `lab author`
   - turns a validated review result into concrete `candidate_changes`
   - writes the hypothesis file consumed by `state-lab.mjs lab-run`

Reason:

- diagnosis and patch authorship are different acts
- keeping them separate preserves cleaner reasoning and smaller prompts
- `userspace_review` stays trace-first and read-only

The lab authoring step may be implemented as:

- a dedicated prompt/runner
- a state-lab subcommand
- or another bounded internal authoring tool

The exact form is secondary.

The important boundary is:

- DR-2 review does not directly stage live code
- DR-2 review produces or authorizes lab candidate changes

## DR-2 Lab Execution Model

The live runtime cannot run `state-lab.mjs` directly.

So DR-2 needs an explicit adjacent lab job class.

V1 decision:

- keep orchestration in the live runtime
- dispatch Tier-3 lab work through the existing job system
- run the actual `state-lab.mjs` commands on the adjacent machine that already
  has the repo checkout and state-lab workspace

In practice, `dr2Cycle` should dispatch a dedicated lab job type, not a raw
shell command hidden inside userspace.

That job should:

1. build or load the compact review bundle
2. run `userspace_review`
3. run the lab-author step when appropriate
4. invoke `state-lab.mjs lab-run`
5. return a normalized lab result artifact reference to the live runtime

This keeps one scheduling loop while still letting Tier 3 execute where the
Node-based lab actually exists.

## Validation Tiers

Not every DR-2 change should pay the same validation cost.

Use two tiers:

- `Tier 0`
  - prompt/config only
  - static validation only
  - no continuation required by default
- `Tier 1+`
  - code changes or changes needing behavioral proof
  - branch-local validation
  - optional bounded continuation

This prevents over-engineering one-line prompt/config changes while keeping
code changes on the heavier lab path.

For v1, tier selection should be inferred by the lab-author step from the
candidate change set:

- prompt/config-only changes -> `Tier 0`
- any code change or state migration -> `Tier 1+`

## Promotion Actor

The canonical promotion actor should stay inside the live runtime.

`state-lab.mjs promote` may remain a local developer helper, but it should not
be the architectural source of truth for production promotion.

The real live path should be:

- lab produces a validated stageable payload
- `dr2Cycle` reads that result
- runtime code calls kernel primitives to apply it

This keeps staging inside the same authority model as the rest of live
userspace.

### Promotion flow

For a stageable lab result:

1. DR-2 lab completes and writes a stageable result artifact
2. runtime stores that artifact at `dr2:result:{generation}`
3. `dr2Cycle` generates a fresh `execution_id`
4. for validated code changes:
   - call `K.stageCode(...)`
   - then call `K.signalDeploy()`
5. for validated non-code changes:
   - apply them through the existing protected write path
   - record distinct DR-2 promotion provenance for audit and rollback

This preserves the existing authority story:

- state-lab validates
- runtime stages validated changes through kernel primitives
- live KV remains authoritative
- governor remains the live deployment actor

### Trust contract for `dr2:result:*`

The runtime should not blindly stage arbitrary payloads found under
`dr2:result:*`.

For v1:

- the live runtime launches the lab run
- the live runtime reads the resulting branch artifact
- the live runtime writes normalized `dr2:result:{generation}` itself
- that result should include:
  - `review_note_key`
  - `branch_name`
  - `hypothesis_hash`
  - `validated_changes_hash`
  - normalized `validated_changes`
- before staging, `dr2Cycle` should re-check the branch artifact against those
  hashes

This is enough for local adjacent lab execution without inventing a full
signature system.

## Review Note Trust Boundary

If `review_note:*` is the trigger into DR-2, it should not remain forgeable
from ordinary act-time cognition.

So in the same pass:

- move `review_note:*` to a protected tier
- stop writing it through `kvWriteSafe`
- persist it from DR-1 apply through the appropriate privileged/runtime path

Worst case if this is delayed is wasted DR-2 lab work, not silent code
promotion, but the trust boundary should still be tightened.

## Runtime Flow

The intended end-to-end path is:

1. DR-1 notices a structural-looking divergence
2. DR-1 records `review_note:*`
3. live scheduling loop dispatches DR-2 for the next pending note
4. DR-2 builds a compact bundle from:
   - the review note
   - source reflect
   - current live state
   - relevant prompts/config
   - `kernel:source_map`
5. `userspace_review` diagnoses the root constraint
6. lab authoring materializes `candidate_changes`
7. `state-lab.mjs lab-run` validates baseline vs candidate
8. if stageable, runtime stores the validated payload at `dr2:result:{generation}`
9. `dr2Cycle` applies validated stageable outputs through kernel primitives
10. governor deploys code changes

Relevant runtime files:

- `applyDrResults()` currently stages DR-1 code in `userspace.js`
- `drCycle` currently runs in `userspace.js` and participates in the existing
  session lifecycle
- `dr2Cycle` should be added there deliberately, with an explicit phase choice
  instead of being implied
- the fallback deep-reflect prompt in `reflect.js` must also stop advertising
  `K.stageCode()` and `K.signalDeploy()`

## Why This Is Better Than The Old Shape

It fixes the actual mismatch:

- DR-1 remains a live within-architecture repair path
- DR-2 becomes the owner of userspace code-change authorship
- governor remains the live code-deployment path
- `review_note:*` becomes a real bridge, not just a side log

And it does so without:

- forcing all prompt/config changes through the lab
- inventing a second runtime heartbeat
- making `userspace_review` both diagnose and patch in one step

## Immediate Implementation Order

1. Remove `code_stage_requests` and `deploy` from DR-1 prompt and apply path.
2. Add `dr2:state:1` and a simple one-note-at-a-time dispatcher inside the
   existing scheduling loop.
3. Add a kernel lifecycle-state write primitive and move both `dr:*` and
   `dr2:*` lifecycle keys onto it.
4. Add `dr2:state:*` and `dr2:result:*` to a non-agent-writable lifecycle
   tier.
5. Move `review_note:*` to a protected tier and stop writing it via
   `kvWriteSafe`.
6. Keep `review_note:*` append-only and make DR-2 track processing in
   `dr2:state:1.processed_note_keys`, not by deleting notes.
7. Add an adjacent lab job class that runs the `userspace_review` bundle,
   lab-author step, and `state-lab.mjs lab-run`.
8. Add a lab-author step that turns a `userspace_review` result into
   `candidate_changes`.
9. Add a DR-2 apply path in runtime that reads `dr2:result:{generation}` and
   applies validated changes through `K.stageCode`, `K.signalDeploy`, and the
   existing protected write path.
10. Remove DR-1 code-staging language from both `deep_reflect.md` and the
    fallback default prompt in `reflect.js`.
11. Optionally re-enable `state-lab.mjs promote` later as a developer helper,
   but only if it routes through the same runtime/kernel promotion contract.

## What Not To Do

- Do not move all `kvWriteGated` prompt/config changes out of DR-1.
- Do not give `userspace_review` direct live staging authority.
- Do not make `review_note:*` a destructive queue.
- Do not bolt on a second unrelated polling loop for DR-2.
- Do not describe governor as the promotion actor when it is really the
  deployment actor.
- Do not merge diagnosis and patch authorship into one oversized prompt unless
  the two-step lab path demonstrably fails.

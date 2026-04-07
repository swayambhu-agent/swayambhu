# Cognitive Implementation Plan

Date: 2026-04-06

## Purpose

This document resolves the implementation debate for Swayambhu's cognitive
architecture using the codebase that exists today.

It is not a debate transcript anymore. It is the final near-term plan derived
from:

- the current runtime (`userspace.js`, `eval.js`, `reflect.js`, `memory.js`)
- the cognitive learning model design
- the revised cognitive framework spec
- the vision notes
- the implementation concerns raised in discussion

The goal is to identify the shortest correct path from today's prompt-heavy
runtime to a substrate that can later support a learned cognitive core.

The agent is not yet live. Therefore, backwards compatibility is not a primary
goal. Prefer the simplest coherent implementation over migration ceremony unless
small shims materially reduce implementation cost or make short-term inspection
easier.

## Additional Constraint From DR Comparison

Recent deep-reflect comparison work should be treated as a source of design
requirements for the next cognitive model, not as a reason to optimize the
current DR mechanism into a final architecture.

The distilled requirements are captured in:

- `docs/superpowers/specs/2026-04-06-next-cognitive-model-requirements-from-dr-comparison.md`

In particular:

- bootstrap updates should be minimal and explicitly calibrated
- continuation quality matters more than one-shot reflective prose
- cognitive context should be compact and exclude low-signal payloads by default
- debugger legibility is a core architectural requirement, not just a UI concern

## Additional Constraint From Overnight Dev-Looping

The overnight run also produced a stronger architectural constraint: the next
framework should not remain flat.

The active top-level framework spec is now:

- `docs/superpowers/specs/2026-04-07-cognitive-framework-v2.md`

The active review-system direction is now:

- `docs/superpowers/specs/2026-04-07-userspace-review-roles.md`
- `docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md`
- `docs/superpowers/specs/2026-04-07-three-tier-runtime-evolution.md`
- `docs/superpowers/plans/2026-04-07-wake-provenance-and-external-trigger-plan.md`

That spec changes the target ontology from a flat
`experience -> desire -> tactic -> action` loop to a layered framework centered
on:

- the existing normative floor
- standing desires
- situational state
- active aims
- tactics
- patterns
- experiences

Separately, the review-system discussion now treats self-improvement as
role-based userspace review rather than as a necessarily strict numeric deep
reflect hierarchy. In particular:

- operational review may remain architecture-specific
- userspace review should critique userspace generically
- architecture research should remain more speculative and more heavily
  validated

It also explicitly defers identity commitments to a later stage until the
desire/aim split and situational-state layer are proven.

## Additional Constraint From The Vision Notes

The vision notes add an important refinement to that direction:

- curiosity should be allowed to emerge, not installed as a separate drive

The active vision source is:

- `docs/superpowers/specs/2026-04-06-swayambhu-vision-notes.md`

This means the near-term work should prefer:

- removing gates that suppress exploratory action
- making capacity and stagnation legible to the planner and slow cycle
- making `no_action` a justified positive judgment rather than a sink state

before adding more motivational layers or explicit curiosity machinery.

One concrete runtime consequence of that constraint: externally forced sessions
must become explicit runtime facts rather than hidden schedule manipulation.
Otherwise dev-loop or review-lab probes contaminate scheduler-learning and make
the resulting corpus less trustworthy.

## Current Runtime Facts

The current codebase has the right outer shell and the wrong inner substrate.

### What is already good

- The kernel is intentionally thin and safety-oriented.
- Userspace owns cognition.
- Evaluation already has a partially mechanized local path:
  embeddings + NLI + LLM fallback.
- Deep-reflect already exists as a slow-cycle mechanism and can modify prompts,
  config, desires, patterns, and tactics.

### What is still wrong

- Plan is still prompt-authored JSON.
- Review is still an LLM summary step with no checked-in review prompt source.
- `experience:*` is still dominated by `outcome` and `narrative`.
- Patterns are still represented primarily as text strings.
- The salience gate is still based on the old unbounded formula.

That means the system does not yet produce a reliable cognitive corpus. It
produces a shell of one.

## Core Diagnosis

The immediate bottleneck is not model choice.

The immediate bottleneck is that the runtime does not yet produce clean,
structured, cognitively meaningful experience records.

Three current defects matter most:

1. Review does not yet author proper experience structure.
2. Experience storage collapses back into narrative text.
3. Salience is still mathematically wrong at the point where memory is gated.

Until these are fixed, any learned component will mainly learn prompt artifacts.

## Final Decisions

### 1. Stage-0 substrate repair comes before learned components

Do not begin by building a learned planner.
Do not begin by introducing a large new trace subsystem.
Do not begin by forcing the full end-state schema into production.

Repair the substrate first.

### 2. Execution-surface unblocking comes before adding more live motivation structure

Before adding more persistent cognitive objects, first remove the main runtime
gates that currently suppress exploratory life:

- planner framing that treats `no_action` as the default
- hard pre-grounding of every act in an existing desire
- weak visibility of available capacity and stagnation
- low salience for repeated capacity-rich passivity
- dormancy-inducing interval backoff

This is the most elegant next move because it tests whether the existing
experience/desire/tactic loop is already sufficient once the surface is no
longer biased toward inaction.

### 3. The first-wave experience schema must be minimal and authorable

The first production schema should be small and grounded in signals the current
runtime can actually author.

Use:

- `observation`
- `desire_alignment`
- `pattern_delta`
- `salience`
- action/session/cycle links
- optional audit text

Do not require:

- `entities`
- `relations`
- `time_scope`
- richer latent refs

Those belong later, after the runtime proves it can produce stable records.

### 4. Do not store raw `alpha` as the canonical long-term experience field

Eval's `alpha` vector is useful, but it is defined relative to the current
desire set and current desire wording.

So:

- preserve full `alpha` in `action:*` or equivalent audit records
- derive a compact `desire_alignment` summary for `experience:*`

Recommended first-wave shape:

```json
{
  "observation": "factual outcome summary",
  "desire_alignment": {
    "top_positive": [{ "desire_key": "desire:...", "score": 0.0 }],
    "top_negative": [{ "desire_key": "desire:...", "score": 0.0 }],
    "affinity_magnitude": 0.0
  },
  "pattern_delta": {
    "sigma": 0.0,
    "scores": [
      { "pattern_key": "pattern:...", "direction": "contradiction", "surprise": 0.0 },
      { "pattern_key": "pattern:...", "direction": "entailment", "surprise": 0.0 }
    ]
  },
  "salience": 0.0
}
```

This keeps the durable memory representation compact while preserving raw eval
detail in the audit trail.

Selection policy for the first-wave `desire_alignment` summary:

- keep up to 3 positive and 3 negative desires
- only include entries where `|alpha| >= 0.3`
- compute `affinity_magnitude` from the same filtered subset

### 5. `pattern_delta` must be mechanically derived, not invented as prose

`pattern_delta` is only acceptable if it has a real authoring path.

For the current runtime, that means:

- `sigma` comes from eval
- `scores` come directly from `pattern_scores`
- review does not invent `pattern_delta` freehand

This keeps the field aligned with current code reality.

### 6. The salience-formula fix is immediate, not deferred

The bounded salience redesign should be implemented before collecting the next
50-100 sessions intended as a seed corpus.

Reason:

- the current formula distorts what gets remembered
- the write threshold is unstable under the current formula
- collecting a "clean" corpus under a known-bad gate is wasteful

Learned salience comes later. Formula repair comes now.

### 7. Deep-reflect prompt changes are first-wave work

Deep-reflect must be aligned to the repaired substrate immediately.

In particular:

- S must remain observation-only
- D must consume the new structured experience fields
- T must avoid being derived from narrative contamination

If deep-reflect is not updated, it will continue to smear patterns, tactics, and
desires back into prose and corrupt the repaired memory substrate.

### 7. Humans commit the contracts; the dev loop implements and validates

The correct self-authoring boundary for this stage is:

- humans design and commit the review prompt contract and first-wave schema
- the dev loop implements the integration and validates behavior against those
  committed artifacts

This is better than:

- humans hand-implement everything
- or asking the current runtime to rediscover foundational cognition design from
  scratch

### 8. Do not add a dedicated `cog_trace:*` runtime object yet

The runtime already writes:

- `action:*`
- `experience:*`
- `reflect:*`
- `last_reflect`

For the near term:

- improve these records
- add stable IDs and links
- build offline export tooling over them

Do not introduce a new trace prefix until the repaired records stabilize.

### 9. Do not commit to the first learned sidecar yet

It is reasonable to suspect that the first learned sidecar will be one of:

- salience/utility scorer
- retrieval reranker

But that should remain contingent until:

- the repaired schema is live
- deep-reflect is aligned
- 50-100 sessions have been inspected

At this stage, "first learned component" is a hypothesis, not an already-fixed
deliverable.

## First-Wave Runtime Contract

### Review contract

Review becomes the explicit experience author.

Responsibilities:

- author factual `observation`
- optionally author concise audit text
- not author an independent desire-alignment signal if eval already computes it
- not collapse durable memory back into narrative

Eval remains responsible for:

- `alpha`
- `sigma`
- `pattern_scores`
- `salience`

This does not require inventing a new runtime phase. The current code already
has a dedicated `reviewPhase()` LLM call in `userspace.js`; the required change
is to strengthen its contract and prompt source.

### Experience contract

First-wave `experience:*` should include:

- `timestamp`
- `action_ref`
- `session_id`
- `cycle`
- `observation`
- `desire_alignment`
- `pattern_delta`
- `salience`
- optional `text_rendering`

### Action contract

`action:*` should be expanded so later export does not lose the richer eval
signals.

Add or preserve:

- full `alpha`
- full `pattern_scores`
- `sigma`
- bounded `salience`
- review outputs

That makes `action:*` the high-detail audit record and `experience:*` the
compact durable cognitive record.

## Implementation Order

The cleanest implementation against the current codebase now starts with a
runtime-seam repair before the two main cognitive bites:

1. repair the communication/work seam
2. substrate repair and corpus cleanup
3. controlled cognitive-architecture changes

The comms/session seam repair plan is:

- [2026-04-07-comms-session-seam-repair-plan.md](/home/swami/swayambhu/repo/docs/superpowers/plans/2026-04-07-comms-session-seam-repair-plan.md)

This is the current `#1` implementation priority because patron messages and
durable request tracking are part of the live behavioral substrate. Leaving the
request seam broken would pollute both the runtime behavior and the corpus we
use to judge later cognitive changes.

After that, the remaining implementation should proceed in two bites, not one
blurred pass:

1. substrate repair and corpus cleanup
2. controlled cognitive-architecture changes

This separation matters because salience repair, review contract repair, and
experience-structure repair are not the same thing as introducing active aims,
situational state, or role-based self-review.

### Priority 0: Comms/session seam repair

Touch these files first:

- [index.js](/home/swami/swayambhu/repo/index.js)
- [hook-communication.js](/home/swami/swayambhu/repo/hook-communication.js)
- [tools/trigger_session.js](/home/swami/swayambhu/repo/tools/trigger_session.js)
- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [act.js](/home/swami/swayambhu/repo/act.js)
- relevant tests

Required outcomes:

1. `trigger_session` runs through the normal kernel tool path.
2. pending `session_request:*` records are loaded into act context.
3. sessions can write durable request updates and emit `session_response`.
4. stale or unaddressed requests are surfaced mechanically instead of
   disappearing.
5. comms renders patron-facing updates from durable request state, not
   ephemeral inbound evidence.

Do this before Bite 1.

### Bite 1: Atomic substrate-repair pass

Touch these files together:

- [userspace.js](/home/swami/swayambhu/repo/userspace.js)
- [eval.js](/home/swami/swayambhu/repo/eval.js)
- [memory.js](/home/swami/swayambhu/repo/memory.js)
- [prompts/deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md)
- [prompts/review.md](/home/swami/swayambhu/repo/prompts/review.md)
- relevant tests

Required changes:

1. Add checked-in `prompts/review.md`.
2. Update `reviewPhase()` to target the new review contract.
3. Update `writeMemory()` to write the first-wave `experience:*` schema.
4. Expand `action:*` eval persistence with full `alpha` and `pattern_scores`.
5. Replace the current unbounded salience formula in `eval.js`.
6. Update deep-reflect prompt wording so S is strictly observation-only and D
   consumes the repaired experience structure.
7. Update any readers of `experience:*` that need the new shape.

Because the agent is not yet live, do not optimize this pass for long-term
backwards compatibility. If a small read shim in `memory.js` makes inspection of
old dev data easier, that is acceptable, but it is optional.

### Bite 2: Controlled v2 architecture changes

Only after Bite 1 is live and producing a cleaner corpus:

- first unblock exploratory emergence at the execution surface
- introduce `standing_desire` vs `active_aim` handling
- introduce `situational_state`
- update planner/eval contracts around aims
- extend tactic reach where needed
- begin the shift from numeric deep-reflect framing toward role-based

### First sub-stage inside Bite 2: unblock exploratory emergence

Before treating the current flat ontology as insufficient, test whether the
existing desire/tactic/experience loop becomes much richer once the main
suppression gates are removed.

Priority changes in this sub-stage:

1. Reframe the planner so `no_action` is a positive judgment, not the default
   fallback when no gap is obviously closable.
2. Remove the hard requirement that every non-`no_action` act be pre-grounded
   in an already-existing desire key.
3. Surface capacity and stagnation signals to planning and deep-reflect.
4. Make repeated capacity-rich `no_action` states more visible to the slow
   cycle instead of letting them fade as low-value inactivity.
5. Replace dormancy-deepening backoff with cheaper/faster idle behavior where
   possible.

This sub-stage is the cleanest test of the vision-notes claim that curiosity
should be emergent from expansion plus salience, not installed as its own
drive.

If this sub-stage materially improves aliveness and exploratory behavior, that
is evidence for restraint in adding further motivational structure.

If it does not, then additional structure such as more explicit aim handling is
better justified.
  userspace review

Gate Bite 2 on at least a modest clean sample from Bite 1 rather than rolling
it into the same migration wave.

### Phase 2: Implement through the dev loop

1. Let the dev loop implement the committed contract changes.
2. Validate resulting records and behavioral changes manually.

### Phase 3: Stabilize the corpus

1. Run 50-100 sessions under the repaired substrate.
2. Export from existing `action:*`, `experience:*`, and `reflect:*` records.
3. Inspect whether the new signals are informative and stable.

### Phase 4: Revisit learned sidecars

Only after Phase 3:

- decide whether salience/utility scoring is the best first learned component
- or whether retrieval reranking is the better first target

### Phase 5: Resume the broader learning-model roadmap

Once the substrate is repaired and validated:

- richer typed schemas
- proposal sidecars
- action ranking
- dream-learning adapters/checkpoints
- full cognitive-core replacement path

### Final queued task after the runtime/cognition repair stack

After the above implementation stack is complete and verified, switch the
agent's deep-reflect execution path from Claude Code to Codex, then validate the
quality of the resulting DR outputs before resuming long dev-loop runs.

Do this last, not first, so model-provider comparison happens against a cleaner
runtime with:

- repaired request/comms seam
- explicit wake provenance
- reduced dormancy bias
- cleaner experience substrate

Required outcomes:

1. update the DR execution path and config to use Codex instead of Claude Code
2. run focused validation on DR quality and apply path correctness
3. only then resume sustained dev-looping, choosing fresh-bootstrap vs
   continuation based on which produces the cleaner comparison corpus

### Production training policy

When learned components are introduced, do not assume that dream-learning
should run forever on a fixed frequent cadence.

Expected operational policy:

- early on, train relatively often because the first runs should have the
  highest leverage
- once behavior stabilizes, reduce cadence
- temporarily increase cadence again when tools, prompts, architecture, or
  operating environment change materially
- skip or slow runs when validation lift is flat and recent sessions are mostly
  redundant

The right long-term criterion is marginal gain, not ritual frequency:

- keep training while held-out behavior, retrieval quality, salience quality,
  or long-horizon coherence improve enough to justify the GPU spend
- reduce training when gains flatten
- resume heavier training when the agent's life changes enough to create a new
  learning opportunity

This means a modest permanent GPU budget is defensible if it keeps producing
validated improvements in real operation, but diminishing returns should be
expected and planned for.

## What Not To Do Yet

Do not:

- ship the full end-state experience schema now
- train a learned planner now
- introduce a dedicated runtime trace prefix now
- store raw `alpha` as the canonical experience payload
- defer the salience fix until after corpus collection
- split the initial substrate repair into multiple long-lived partially valid
  intermediate states unless that materially simplifies implementation

## Success Gates Before Learning

The runtime is ready for the first learned sidecar only when all of the
following are true:

1. Review reliably emits factual `observation`.
2. `experience:*` stores structured fields directly rather than collapsing back
   to narrative.
3. `action:*` preserves full eval detail needed for later export.
4. Salience is bounded and the write threshold is meaningful again.
5. Deep-reflect is using the repaired experience substrate rather than prose
   summaries.
6. 50-100 sessions of repaired data look structurally clean on inspection.

## Final Position

The immediate path is:

- commit review and schema contracts
- fix review and experience storage
- fix salience now
- align deep-reflect immediately after
- use the dev loop to implement and validate against those committed contracts
- inspect a repaired corpus before choosing the first learned sidecar

This is the shortest correct path from today's prompt shell to a real learned
cognitive substrate, because it fixes the actual bottleneck: not ambition, but
clean experience.

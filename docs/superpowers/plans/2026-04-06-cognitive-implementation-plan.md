# Cognitive Implementation Plan

Date: 2026-04-06

## Purpose

This document resolves the implementation debate for Swayambhu's cognitive
architecture using the codebase that exists today.

It is not a debate transcript anymore. It is the final near-term plan derived
from:

- the current runtime (`userspace.js`, `eval.js`, `reflect.js`, `memory.js`)
- the cognitive learning model design
- the vision notes
- the implementation concerns raised in discussion

The goal is to identify the shortest correct path from today's prompt-heavy
runtime to a substrate that can later support a learned cognitive core.

The agent is not yet live. Therefore, backwards compatibility is not a primary
goal. Prefer the simplest coherent implementation over migration ceremony unless
small shims materially reduce implementation cost or make short-term inspection
easier.

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

### 2. The first-wave experience schema must be minimal and authorable

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

### 3. Do not store raw `alpha` as the canonical long-term experience field

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

### 4. `pattern_delta` must be mechanically derived, not invented as prose

`pattern_delta` is only acceptable if it has a real authoring path.

For the current runtime, that means:

- `sigma` comes from eval
- `scores` come directly from `pattern_scores`
- review does not invent `pattern_delta` freehand

This keeps the field aligned with current code reality.

### 5. The salience-formula fix is immediate, not deferred

The bounded salience redesign should be implemented before collecting the next
50-100 sessions intended as a seed corpus.

Reason:

- the current formula distorts what gets remembered
- the write threshold is unstable under the current formula
- collecting a "clean" corpus under a known-bad gate is wasteful

Learned salience comes later. Formula repair comes now.

### 6. Deep-reflect prompt changes are first-wave work

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

The cleanest implementation against the current codebase is one coherent
substrate-repair pass, followed by data stabilization and inspection.

### Atomic substrate-repair pass

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

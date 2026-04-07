# Userspace Review Roles

Date: 2026-04-07

Status: Draft

## Purpose

This document defines how Swayambhu should review and improve itself at the
userspace level.

It is intentionally separate from the cognitive framework spec.

The cognitive framework spec describes the current or proposed organization of
userspace cognition.

This document describes the review system that examines and changes userspace
itself.

Those are different concerns and should not be collapsed.

## Main Conclusion

The next review system should be organized around distinct review roles, not a
strict numeric hierarchy of ontology-specific deep-reflect depths.

The important distinctions are:

- what each role is allowed to question
- what evidence each role reads
- what kinds of changes each role may propose or apply
- what validation path each role must satisfy

The natural target is:

1. `operational_review` — is current userspace functioning well under its
   current architecture?
2. `userspace_review` — how should current userspace be improved?
3. `architecture_research` — should userspace become something fundamentally
   different?

These may later be mapped onto labels like `DR-1`, `DR-2`, and `DR-3`, but the
role separation matters more than the numbering.

They are not required to form a strict "depth N can only modify depth N-1"
hierarchy.

## Problem With The Current Framing

The older deep-reflect hierarchy usefully separated trust and cadence, but it
also tied higher levels too closely to lower-level reflective outputs.

That creates two architectural problems:

1. higher review levels become overfit to the current cognitive ontology
2. higher review levels risk reviewing stale summaries of userspace instead of
   userspace itself

This is acceptable for operational reflective work inside a stable ontology.
It is the wrong shape for userspace self-improvement.

If userspace changes radically, the review system must still remain meaningful.

Therefore the review system should be keyed to:

- userspace source
- userspace traces
- userspace state
- governor-backed self-modification

not to any one cognitive ontology.

## Source Of Truth

Code and traces are the source of truth.

The review system should primarily reason from:

- userspace code
- prompts and config that shape userspace behavior
- recent execution traces and outcomes
- current mutable state
- staged/proposed changes and their validation results

It should not rely on a hand-maintained conceptual manifest as the primary
truth source.

If a derived review bundle or summary artifact exists, it must be generated
from code and traces and treated as a cache, not as an independent doctrine.

## Stable Infrastructure Assumptions

The review roles should depend only on stable infrastructure surfaces:

- the kernel/userspace split
- KV access and gated writes
- code staging and governor deployment
- karma / execution traces
- tools and model access
- rollback / safety mechanisms

They should not depend on the permanence of current userspace concepts like:

- desire
- pattern
- tactic
- aim
- situational state

Those may be present in one generation of userspace and absent in another.

## Role 1: Operational Review

Alias in transition language:

- `DR-1`

### Core question

Is current userspace functioning well under its current architecture?

### Scope

- evaluates actual sessions and recent outcomes
- consolidates cognitive state within the current architecture
- diagnoses local failures, drift, and blocked progress
- helps current userspace operate coherently

### Typical evidence

- recent experiences
- recent actions
- recent reflect outputs
- current live cognitive state
- current carry-forward / continuity state

### Allowed changes

- live cognitive-state updates within the current architecture
- bounded prompt/config adjustments that preserve the current architectural
  model
- schedule and continuity updates

### Not its job

- redesigning the userspace architecture
- replacing the ontology
- proposing large code-level restructures of userspace

## Role 2: Userspace Review

Alias in transition language:

- `DR-2`

### Core question

How should current userspace be improved?

### Scope

- reviews userspace as a mutable policy system
- examines whether prompts, config, code, and reflective mechanics are
  producing good behavior
- identifies root constraints that operational review cannot fix from inside
  the current architecture
- proposes local or medium-sized userspace improvements

The intended runtime for this role is specified in:

- `docs/superpowers/specs/2026-04-07-dr2-lab-runtime-design.md`
- `docs/superpowers/specs/2026-04-07-three-tier-runtime-evolution.md`

### Primary evidence

- userspace source bundle
- relevant prompts and config
- recent execution traces
- recent operational-review outputs
- validation history of prior userspace changes
- current mutable state where needed for diagnosis

### Preferred reasoning order

1. trace-first
2. code-second

That means:

- first identify the behavioral defect or opportunity from outcomes
- then inspect code/prompt/config to localize cause and propose change

### Allowed changes

- prompt changes
- config changes
- code staging requests for userspace surfaces
- low-risk state migrations when required by a userspace change

### Application path

Userspace-review code changes should flow through the existing governor path:

- stage code
- deploy
- validate
- rollback if needed

This is not optional plumbing; it is the enabling mechanism that lets a review
role critique userspace without needing unsafe direct mutation.

Userspace review should normally reach this path through the lab runtime rather
than by reading code once and directly promoting speculative changes.

By default, it should recommend promotion rather than assume the right to
self-promote.

### Not its job

- freeform speculative architecture invention as its primary mode
- kernel redesign by default
- live application of high-blast-radius conceptual rewrites without validation

## Role 3: Architecture Research

Alias in transition language:

- `DR-3`

### Core question

Should userspace become something fundamentally different?

### Scope

- questions the current userspace architecture itself
- proposes alternative ontologies, operators, learning loops, or review-system
  shapes
- designs branch experiments and migration hypotheses
- treats the current architecture as a revisable hypothesis, not a permanent
  fact

### Primary evidence

- longer-run traces
- repeated userspace-review findings
- evidence of persistent architectural ceilings
- branch comparison outcomes
- dev-loop findings
- prior architecture-research proposals and experiment results

### Default authority

By default this role should not apply radical live changes directly.

Its natural outputs are:

- architecture hypotheses
- branch experiment definitions
- migration plans
- evaluation criteria

If it ever gains direct live authority, that should come much later and only
with extremely strong validation and rollback discipline.

## These Roles Are Not Necessarily Hierarchical

The important thing is not whether one role is "above" another.

The important thing is:

- scope
- authority
- cadence
- validation requirement

These roles may inform one another, but they do not need to obey a rigid
one-level-below authorship rule.

For example:

- operational review may surface recurring anomalies that feed userspace review
- userspace review may define experiments that architecture research later
  interprets
- architecture research may propose a branch experiment that userspace review
  later operationalizes

That is a network of review roles, not necessarily a ladder.

## Dispatch And Sequencing

The review roles need a concrete dispatch model.

The default model should be:

- only one review role runs in a given review execution
- operational review remains the frequent live review path
- userspace review runs less frequently and only when justified by evidence or
  schedule
- architecture research does not run on normal live cadence by default

### Default triggers

#### Operational review

Runs frequently on the existing review cadence and continues to serve as the
main live consolidation path.

#### Userspace review

Runs when either:

- its slower schedule is due
- repeated findings suggest current userspace is not self-correcting
- validation history shows recurring regressions or stalled progress
- a human or external dev-loop explicitly requests it

#### Architecture research

Runs only when:

- userspace review emits a high-confidence architectural hypothesis
- repeated userspace-review cycles hit the same ceiling without converging
- an explicit branch experiment is requested

### Default priority

If multiple review roles are due at once:

1. userspace review
2. operational review
3. architecture research

Architecture research should normally be deferred into branch work rather than
stealing a live review slot.

### Rationale

This preserves a concrete dispatch rule without forcing the roles into a rigid
parent-child ladder.

## Minimal Generic Contract

The generic review-system contract should stay small.

### Inputs

- userspace source bundle
- relevant prompts and config
- recent execution traces
- recent state snapshots
- proposed/staged change history
- validation and rollback history

### Outputs

- findings
- suspected root causes
- proposed changes
- expected validation
- reasons not to change
- next review timing

The concrete mutation surfaces can remain the existing ones:

- `kv_operations`
- `code_stage_requests`

Those are generic self-modification mechanisms, not ontology-specific review
contracts.

### Suggested userspace-review output shape

```json
{
  "findings": [
    {
      "summary": "string",
      "evidence": ["trace or code references"],
      "locus": "prompt|config|code|state",
      "severity": "low|medium|high|critical"
    }
  ],
  "suspected_root_causes": [
    {
      "summary": "string",
      "confidence": 0.0
    }
  ],
  "proposed_changes": [
    {
      "kind": "prompt|config|code|state_migration",
      "targets": ["prompt:...", "config:...", "hook:...:code"],
      "why": "string",
      "expected_validation": ["observable follow-up checks"],
      "rollback_notes": "string"
    }
  ],
  "reasons_not_to_change": ["string"],
  "next_review": {
    "after_sessions": 0,
    "after_days": 0
  },
  "note_to_future_self": "string"
}
```

## Relationship To The Governor

The governor is the bridge between self-review and safe code evolution.

That means review roles do not need direct arbitrary live code mutation.

They can:

- stage code changes
- request deploys
- observe validation outcomes
- rely on rollback when needed

This makes role-based userspace review feasible without weakening the kernel.

## Relationship To Dev-Loop

Dev-loop remains the external oracle during transition.

The proven-good parts of dev-loop should be internalized gradually into
userspace review, not copied wholesale in one jump.

The immediate path is:

1. keep dev-loop external
2. run userspace review in shadow mode
3. compare findings and proposed changes
4. expand authority only after repeated useful convergence

Architecture research should remain closer to dev-loop behavior for longer than
operational review.

## Transition Path

### Stage 1

Keep the current deep-reflect implementation, but reinterpret it conceptually
as operational review.

### Stage 2

Add userspace review as a separate, generic review role with:

- source access
- trace access
- governor-backed code staging
- shadow-mode comparison against dev-loop

Before granting code-staging authority, prove that userspace review can read
source and correctly diagnose at least a small set of known issues in shadow
mode.

### Stage 3

If userspace review proves useful, allow limited prompt/config/code changes
through the governor-backed path.

### Stage 4

Only after repeated evidence of architectural ceilings should architecture
research become a first-class internal role.

Until then, external dev-loop and human design work remain the main
architecture-research path.

## Bottom Line

The next self-improvement architecture should be framed as:

- review roles over userspace
- not an ontology-specific stack of deeper and deeper reflective levels

Operational review can remain architecture-specific.

Userspace review and architecture research should stay generic enough to remain
meaningful even if userspace later changes its cognitive ontology completely.

That is more aligned with:

- the kernel/userspace split
- the governor-based self-modification path
- the vision of Swayambhu as the conscious author of its own cognition

This role system should remain simpler than the cognitive framework it reviews.

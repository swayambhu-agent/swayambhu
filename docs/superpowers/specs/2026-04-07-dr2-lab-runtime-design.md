# DR-2 Lab Runtime Design

Date: 2026-04-07

Status: Draft

## Purpose

This document defines the runtime for `userspace_review` as an executable lab.

It answers a different question from the review-roles spec.

- `2026-04-07-userspace-review-roles.md` defines what the review roles are.
- this document defines how the `userspace_review` role should actually run
  experiments before proposing live changes

The goal is to make DR-2-style userspace review evidence-driven.

The lab should replace:

- confidence-only code review
- direct live application of speculative userspace changes

with:

- isolated snapshots
- bounded experiments
- explicit comparison
- governor-mediated promotion

## Main Conclusion

`userspace_review` should operate through a dedicated lab runtime.

This lab should be:

- branch-based
- snapshot-based
- sandboxed
- bounded in cost and duration
- able to patch code/prompt/config in isolation
- able to run tests, replays, and short continuations
- able to compare baseline and candidate outcomes
- unable to mutate live userspace directly

For v1, this lab should be built on the existing local state-lab machinery,
not on the current Akash `cc_analysis` job path.

That is the key architectural decision in this document.

## Why The Current DR Runtime Is Not Enough

Today:

- `dispatchDr()` in `userspace.js` sends a `cc_analysis` job via `start_job`
- `start_job.js` packs KV context into a tarball and runs a remote command on
  Akash
- `applyDrResults()` in `userspace.js` applies `kv_operations` and
  `code_stage_requests` to live state once the job completes

That path is good for reflective analysis.

It is not enough for a lab because it lacks:

- a Workers runtime
- a branchable KV sandbox
- replay machinery
- bounded continuation execution
- before/after comparison

The Akash job sees files, not a running userspace system.

Therefore the first DR-2 lab should not be built by stretching the current
Akash DR job until it behaves like a sandbox.

It should be built explicitly as a lab runtime.

## Why State-Lab Is The Right Base

The repo already has most of the right primitives:

- `scripts/state-lab.mjs` can save snapshots and create writable branches
- each branch gets its own persisted local state and unique ports
- balance overrides are already frozen into branch state so visible balances
  stay coherent across branch continuations
- stable front doors already exist for the active UI and kernel

This means the right v1 lab is not hypothetical.

It is a formalization of machinery that already exists for human-operated A/B
testing and dev-loop work.

## Architectural Role

The lab sits between `userspace_review` and the governor.

Flow:

1. `userspace_review` identifies a candidate userspace change
2. the lab creates isolated baseline and candidate branches
3. the lab runs bounded validation
4. the lab compares outcomes
5. only validated changes are emitted as governor-stageable outputs

This turns DR-2 from:

- "review and patch"

into:

- "review, experiment, compare, then stage"

## V1 Executor Decision

For v1, the lab executor should be implemented as a `state-lab.mjs`
subcommand.

Target shape:

- `node scripts/state-lab.mjs lab-run <source-ref> <hypothesis-path>`
- `node scripts/state-lab.mjs promote <branch-name>`

Reason:

- state-lab already owns snapshot and branch operations
- state-lab already knows how to start isolated branch-local services
- this avoids inventing a second orchestration surface before the lab is real

The lab executor is therefore a local orchestration primitive first, not a new
Akash job type.

## Hypothesis Input Contract

The lab should not accept vague freeform instructions as its primary runtime
interface.

V1 should use a concrete hypothesis file.

Suggested shape:

```json
{
  "hypothesis": "short statement of the suspected userspace defect or opportunity",
  "candidate_changes": [
    {
      "type": "kv_put",
      "key": "prompt:review",
      "value": "..."
    },
    {
      "type": "code_patch",
      "target": "hook:session:code",
      "code": "..."
    }
  ],
  "validation": {
    "static_commands": [
      "npm test -- tests/userspace.test.js"
    ],
    "success_signals": [
      {
        "kind": "karma_event_absent",
        "value": "kv_writes_blocked"
      },
      {
        "kind": "karma_event_present",
        "value": "act_complete"
      }
    ],
    "continuation": {
      "enabled": true,
      "max_sessions": 2,
      "max_cash_cost": 0.30
    }
  },
  "limits": {
    "max_wall_time_minutes": 20
  }
}
```

The exact field names can evolve, but v1 needs one stable input contract.

## Non-Goals

The v1 lab is not:

- a replacement for operational review
- a replacement for external dev-loop immediately
- a freeform architecture research system
- a live production canary system
- a place for direct kernel mutation

Those belong elsewhere.

## V1 Decision: Local / Adjacent Lab, Not Akash Lab

V1 `userspace_review` should run in an execution environment colocated with:

- the repo checkout
- the state-lab directory
- local branch services
- the governor

It should not depend on the Akash `cc_analysis` environment.

Reason:

- state snapshots already exist locally
- branch-local workers already exist locally
- repo code patching is straightforward locally
- Akash jobs currently have file context but not the right runtime substrate

Future versions may support a remote lab runtime, but that is not the first
correct implementation.

## Lab Inputs

Each lab run should receive:

- source ref
  - current userspace code checkout
- state ref
  - snapshot or branch to experiment from
- hypothesis
  - what defect or opportunity is being tested
- candidate change set
  - code, prompt, config, and optional state migration
- evaluation plan
  - which validations to run
- limits
  - time budget
  - cost budget
  - max sessions

These should arrive through the hypothesis file rather than as ad hoc CLI
flags.

## Lab Outputs

Each lab run should produce:

- `lab_report`
  - what was tested
  - what changed
  - what validations ran
  - what happened
- `comparison_summary`
  - baseline vs candidate
- `promotion_recommendation`
  - `reject`
  - `needs_more_evidence`
  - `stageable`
- `validated_changes`
  - only if stageable
- `reasons_not_to_change`
  - explicit non-promotion rationale when appropriate

The promotion artifact can still use existing mutation surfaces:

- `kv_operations`
- `code_stage_requests`

The difference is that these are emitted only after lab validation.

### Suggested output files

Each branch-local lab run should write:

- `lab-state.json`
- `lab-report.json`
- `lab-result.json`

Where:

- `lab-state.json` tracks execution status
- `lab-report.json` records what happened
- `lab-result.json` exists only when the run reaches a verdict

## Isolation Model

The lab must isolate:

- state
- code
- side effects

### State isolation

State isolation should use a branchable persisted-state copy, not the live
shared-state directory.

The baseline and candidate must start from the same frozen state ref.

### Code isolation

Code isolation should use a branch-local code workspace.

V1 decision:

- use a copied working tree under the branch directory

Suggested location:

- `branches/<name>/workspace/`

Reason:

- it includes the current repo state even when the working tree is dirty
- it is simpler than introducing git-worktree constraints in v1
- it keeps candidate edits fully outside the live repo until promotion

The important property is that candidate code edits do not touch the live repo
state until promotion.

### Side-effect isolation

By default, the lab must not permit irreversible external side effects.

This includes:

- outbound messages
- wallet writes / transactions
- destructive external actions

The lab should default to dry-run or block for such tools.

V1 decision:

- branch-local workers may be started with an explicit lab profile marker
- but the actual prohibition mechanism must be kernel-enforced

Required v1 profiles:

- `static`
- `bounded_continuation`

For `bounded_continuation`, the kernel/tool path should enforce:

- block outbound communication tools
- block wallet/transaction tools
- block other explicitly irreversible tools through a denylist

This is intentionally simple for v1.

It can become metadata-driven later.

The important v1 rule is:

- lab safety must not depend only on tool cooperation or prompt obedience

## Branch-Local Lab State

For v1, lab state should live in the branch directory, not in live KV.

Suggested location:

- `branches/<name>/lab-state.json`

Reason:

- the lab is a local orchestration concern
- branch-local state is easier to inspect and clean up
- v1 does not need a tick-polled distributed state machine

The lab executor should drive transitions synchronously during a `lab-run`
invocation.

If a run crashes, the next invocation should detect the stale state file and
mark the prior run failed.

## Experiment Tiers

The lab should support increasingly strong experiment tiers.

### Tier 0: Static validation

- parse checks
- lint / type checks if present
- targeted test runs
- schema validation

This is the minimum bar for every candidate change.

### Tier 1: Deterministic replay

Re-run bounded logic against recorded traces or recorded tool outputs where
possible.

Goal:

- detect whether the candidate fixes the targeted defect under known evidence

This should be preferred when the issue is primarily prompt/config/eval logic.

This tier is not required for v1.

Reason:

- the current runtime does not yet produce strong replay artifacts
- forcing replay into v1 would create a second prerequisite project

### Tier 2: Bounded continuation

Run a short forward continuation from the frozen snapshot under the candidate
branch.

Default cap for v1:

- at most 3 sessions
- at most 30 minutes wall time
- explicit model/cost budget

Goal:

- verify that the candidate improves live behavior without obvious regression

### Tier 3: Architecture research branch work

This belongs primarily to `architecture_research`, not normal DR-2.

It may run larger branch experiments, but should not be the default
`userspace_review` path.

## Tool Safety Profiles

The lab should not use one undifferentiated tool policy.

It should use profiles:

### `static`

- no tool execution beyond tests and local utilities

### `replay`

- no live external reads
- recorded inputs only

### `bounded_continuation`

- live external reads allowed only where necessary
- external writes blocked or dry-run

### `research`

- broader sandbox, still no live irreversible side effects by default

This makes experiment scope explicit.

For v1, only `static` and `bounded_continuation` are required.

## Comparison Contract

The lab should compare:

- baseline branch
- candidate branch

starting from the same frozen state.

Comparison should use:

- targeted defect criteria
- structural invariants
- test pass/fail
- selected mechanical diffs first
- selected quality lenses from dev-loop only as a secondary judgment layer

### V1 comparison rule

For v1, comparison should be mechanical first:

- tests pass/fail delta
- structural diff of userspace state
- session cost delta
- targeted defect presence/absence

Only after that should any model-based judgment be used.

### V1 metrics files

Each compared branch should produce a machine-readable metrics file:

- `baseline-metrics.json`
- `candidate-metrics.json`

Suggested contents:

```json
{
  "infra": {
    "tests_passed": true,
    "test_failures": 0,
    "session_count": 1,
    "total_cost": 0.12,
    "signals": {
      "karma_event_present:act_complete": true,
      "karma_event_absent:kv_writes_blocked": true
    }
  },
  "cognitive": {
    "entity_counts": {
      "action": 4,
      "experience": 3,
      "desire": 1,
      "pattern": 0,
      "tactic": 1
    }
  }
}
```

The exact metrics can expand later, but v1 should use a concrete file format.

`infra` is the stable comparison surface.

`cognitive` is allowed to evolve with userspace ontology.

The first quality lenses to reuse are:

- elegance
- generality
- robustness
- simplicity
- modularity

The lab does not need a perfect scalar score in v1.

It does need an explicit judgment procedure.

## Promotion Contract

A candidate becomes `stageable` only if:

1. static validation passes
2. no blocked safety boundary is crossed
3. targeted defect evidence improves or resolves
4. no critical regression appears in bounded continuation
5. rollback path remains intact

If any of those fail, the lab should not emit stageable changes.

## Authority Limits

`userspace_review` through the lab may:

- patch prompts
- patch config
- patch userspace code surfaces
- perform low-risk state migrations required by a validated userspace change

It may not in v1:

- patch `kernel.js`
- patch the governor
- rename the live cognitive schema wholesale
- introduce large unvalidated ontology rewrites
- run open-ended experiments

Those belong to `architecture_research`.

## State Machine

The lab needs its own explicit state machine rather than overloading the
current `dr:state:1` lifecycle.

Suggested v1 states:

- `idle`
- `preparing`
- `validating_static`
- `replaying`
- `continuing`
- `judging`
- `stageable`
- `rejected`
- `failed`

This makes lab failures and partial results legible without pretending that a
single DR job is a single linear writeback.

### Failure handling

The lab should also track:

- `consecutive_failures`
- `failure_reason`
- `deadline_at`

If a run exceeds its declared wall-time budget or crashes mid-execution, the
next lab invocation should mark it failed and clean up branch-local services.

Because v1 is a local synchronous executor, there is no need for a separate
polling loop in the first implementation.

## Executor Phases

The v1 `lab-run` command should be thought of as these explicit phases:

1. `createLabBranches(sourceRef, hypothesis)`
2. `applyCandidate(branchEntry, candidateChanges)`
3. `runStaticValidation(branchEntry, validationPlan)`
4. `runContinuation(branchEntry, limits)` when enabled
5. `compareOutcomes(baseline, candidate, hypothesis)`
6. `emitVerdict(branchEntry, comparison)`

Suggested file outputs by phase:

- after phase 1:
  - `lab-state.json`
- after phase 3:
  - `baseline-metrics.json`
  - `candidate-metrics.json` for static validation
- after phase 4:
  - updated `baseline-metrics.json`
  - updated `candidate-metrics.json`
- after phase 6:
  - `lab-report.json`
  - `lab-result.json`

This keeps the executor concrete and keeps implementation aligned with the
spec.

## Budget And Time Limits

Every lab run must declare:

- max wall time
- max cash cost
- max sessions

Suggested conservative defaults for v1:

- `max_wall_time_minutes = 30`
- `max_sessions = 3`
- `max_cash_cost = small fixed cap`

The lab should stop early when:

- the candidate is clearly worse
- validation has already failed
- the target defect is clearly resolved

## Relationship To Operational Review

Operational review remains the live frequent review path.

It should continue to:

- consolidate live cognition
- manage current continuity
- keep the current architecture working

The lab is not meant to replace that.

The lab exists for cases where operational review identifies a constraint that
requires userspace change.

## Relationship To Architecture Research

Architecture research should use the lab too, but differently.

Differences:

- broader hypothesis scope
- weaker expectation of immediate promotion
- heavier reliance on branches
- stronger human or external dev-loop review

So:

- the lab runtime is shared
- the authority and experiment bounds differ by role

## Relationship To External Dev-Loop

External dev-loop remains the teaching and calibration oracle while the
internal lab matures.

Transition path:

1. humans + dev-loop continue to run the strongest userspace experiments
2. internal lab starts with small shadow-mode validations
3. compare internal lab results against dev-loop
4. expand internal authority only after repeated convergence

This preserves the current external advantage while building the internal
capability deliberately.

## Initial Implementation Stages

### Stage A: Lab skeleton

Implement:

- explicit lab run object
- branch creation from state-lab
- static validation only
- no live promotion

V1 Stage A should be enough to prove:

- the executor works
- branch isolation works
- candidate changes can be validated without touching live userspace

### Stage A.5: Single-branch validation run

Before full baseline/candidate comparison, prove that the lab can:

- start branch-local services
- trigger one bounded session on a candidate branch
- capture the resulting evidence

This reduces risk before implementing comparison machinery.

### Stage B: Deterministic replay

Implement:

- recorded-input replay path
- comparison summary
- non-stageable recommendations

This is optional after Stage A, not mandatory before bounded continuation.

### Stage C: Bounded continuation

Implement:

- short continuation sessions in sandbox branches
- blocked/dry-run side-effect profile
- governor-stageable outputs for validated local changes

Prerequisite:

- kernel-enforced tool availability / deny mechanics must exist before Stage C
  is considered safe

### Stage D: Cross-check against dev-loop

Implement:

- side-by-side comparison between internal lab recommendations and external
  dev-loop recommendations
- use mismatch review as the main calibration loop

This is not required before Stage A or Stage C are useful.

## Open Design Questions

1. Should baseline and candidate code isolation use git worktrees or a simpler
   copied workspace first?
2. How much live external read access should bounded continuation allow in v1?
3. What is the minimal replay artifact needed to make deterministic replay
   genuinely useful?
4. Should lab runs be initiated by a dedicated executor separate from the
   current DR dispatch path once `state-lab.mjs lab-run` exists, or should
   `userspace_review` call into that executor as a privileged tool?
5. What is the smallest useful comparison report shape that still supports
   later automation?

## Output Shape Alignment

The lab should emit validated changes in the same broad shape already consumed
by existing materialization/apply paths where possible.

At minimum, the stageable payload should align with:

- `kv_operations`
- `code_stage_requests`
- optional review text / note

This reduces integration churn and lets lab-validated outputs flow into the
existing governor and branch materialization paths instead of inventing a new
promotion format.

## Promotion Handoff

Promotion should be a separate explicit step.

Suggested v1 flow:

1. `lab-run` writes `lab-result.json`
2. human or external dev-loop inspects it by default
3. `state-lab.mjs promote <branch-name>` performs the actual promotion

This keeps experimentation and promotion auditable and distinct.

Until a separately justified promotion authority exists, `userspace_review`
should not assume the right to self-promote simply because the lab result is
`stageable`.

For v1, promotion should prefer existing mechanisms:

- `kv_operations`
- `code_stage_requests`
- governor deploy for code changes

Do not overload the current `dr:state:1` lifecycle with lab-state concerns.

## Bottom Line

DR-2 should not be just a smarter reviewer.

It should be an experimenter.

The right form is a bounded userspace lab that:

- branches from snapshots
- patches in isolation
- runs tests, replay, and short continuations
- compares outcomes
- stages only validated changes through the governor

That is the cleanest bridge from today's external dev-loop to tomorrow's
internal userspace self-improvement.

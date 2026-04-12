# Read+Write Follow-Up And Simplification Plan

Date: 2026-04-09

Status: Draft

## Recommendation

Do not promote all four tested variants.

The next implementation step should be a combined branch built from the two
strongest results:

1. `write-path-support-gate`
2. `read-path-barrier`

The combined branch should also include the already-identified
`experience.observation` purity fix, because the write-path variant improved
evidence weighting but did not stop reasoning/narrative from contaminating the
canonical observation field.

Do **not** promote `hold-contracts` or `bootstrap-engine-starter` yet.

- `hold-contracts` exposed the right problem, but the implementation was not yet
  authoritative enough to replace current waiting logic.
- `bootstrap-engine-starter` helped somewhat, but it did not look like the main
  next lever.

## Why this is the right next move

The 4-variant cycle indicated that the highest-leverage improvements were
epistemic, not motivational:

- better distinction between external evidence and internal/debug repetition
- better separation between operational continuity and reflective overhang

Those directly support cleaner cognition and also create the best chance of
removing prompt/runtime special-case handling that currently compensates for
poor evidence accounting.

## Implementation Plan

### Step 0: Freeze a clean baseline

- Use the current mainline code as the frozen comparison point.
- Preserve the existing smuggling audits in `scripts/dev-loop/classify.mjs`.
- Keep the current dev-loop evaluation setup so the follow-up run is comparable
  to the morning variant cycle.

### Step 1: Build a combined `read-write-hygiene` branch

Port the strongest parts of both successful variants into one branch.

#### 1A. Read-path barrier

Bring over the continuity-barrier behavior from the tested `read-path-barrier`
branch:

- deny reflective/self-interpretive keys from plan-time `next_act_context`
  loading
- keep planner carry-forward operational, not explanatory
- keep `plan.md` continuity discipline wording that says carry-forward is aid,
  not proof

This should remain a narrow continuity barrier, not a broad pattern-removal
rewrite.

#### 1B. Write-path support gate

Bring over the evidence-quality changes from the tested
`write-path-support-gate` branch:

- support metadata on experiences
- distinction between externally anchored vs internal-only traces
- recurrence-aware dedup/coalescing
- deep-reflect guidance to prefer stronger evidence for durable promotion

This is the strongest tested change and should become the center of the next
branch.

#### 1C. Observation purity fix

Apply the already-known write-path cleanup:

- `experience.observation` must be purely factual
- stop falling back from `observation` to narrative/assessment/planner reason
- synthetic no-action reviews should use factual observation text only
- reasoning about why no action was taken should live in `narrative`,
  `assessment`, or other non-canonical fields

This should be treated as part of the same branch, not as a separate optional
cleanup.

### Step 2: Run 20-30 dev-loop sessions on the combined branch

Run a bounded offline comparison against the frozen baseline.

Primary questions:

- does the combined branch preserve the write-path gains from the support gate?
- does it preserve the continuity hygiene gains from the read-path barrier?
- does observation contamination drop materially?
- does behavioral quality remain at least as good as baseline?

Primary metrics:

- tactic smuggling incidence
- carry-forward policy smuggling incidence
- observation contamination incidence
- outbound internal-state leakage incidence
- no-action streak behavior
- number and quality of durable patterns/tactics/desires

### Step 3: Only after that, attempt prompt/runtime simplification

Do not try to delete all special-case logic before the combined branch has been
shown to behave well. The correct next move is a second, explicit
`simplification pass`.

## Prompt/Runtime Simplifications To Attempt Next

These are the simplification targets most likely to be removable or reducible if
the combined branch behaves well.

### Candidate simplifications for the next pass

#### A. Remove the injected `[IDLE TRAP OVERRIDE]` planner block

Current location:

- `userspace.js`

This block is compensating for self-reinforcing idle loops. If the combined
branch correctly treats repeated internal/debug wakes as weak evidence and keeps
reflective overhang out of planning, this prose override may no longer be
necessary.

Planned change:

- remove the injected planner block entirely, or
- reduce it to telemetry/karma without prompt-time prose steering

#### B. Simplify the `How to decide` idle/probe exceptions in `plan.md`

Current location:

- `prompts/plan.md`

The current prompt contains explicit exception language for:

- repeated idle sessions with healthy capacity
- bounded probes that may omit `serves_desires`

Planned change:

- replace the current repeated-idle special-case wording with a shorter general
  rule about bounded exploration only when there is a grounded open question and
  the probe can reveal new external information

Important:

- keep runtime enforcement for now
- simplify the prompt wording first, not the runtime gate first

#### C. Simplify no-action observation synthesis

Current location:

- `userspace.js`

The synthetic no-action path currently encodes too much policy and planner
reasoning into remembered experience text.

Planned change:

- factual observation only
- move pressure/idle/capacity interpretation into metadata or non-observation
  fields

### Simplifications to defer for now

These should **not** be removed in the next pass yet.

#### 1. Bootstrap empty-desire prompt logic

Current location:

- `prompts/plan.md`
- `userspace.js`

Reason to defer:

- `bootstrap-engine-starter` was not strong enough yet to justify deleting this
  logic

#### 2. Circuit-breaker escalation section

Current location:

- `prompts/plan.md`

Reason to defer:

- this likely wants a stronger wait/hold mechanism
- the tested `hold-contracts` branch did not yet earn replacement of this logic

#### 3. Request-driven / exploratory no-desire runtime exceptions

Current location:

- `userspace.js`

Reason to defer:

- these are tied to bootstrap and sparse-state control
- they should be revisited only after a stronger bootstrap design exists

## Validation Sequence

### Pass 1: Combined branch

- implement `read + write + observation purity`
- run 20-30 sessions
- save comparison against baseline

### Pass 2: Simplification branch

Fork from the successful combined branch and:

- remove/reduce `IDLE TRAP OVERRIDE`
- simplify `plan.md` idle/probe language
- keep deferred bootstrap/hold special cases in place

Then:

- run another 20-30 sessions
- compare against the combined branch, not only against baseline

## Decision Gates

### Promote the combined branch if:

- epistemic hygiene improves materially
- observation contamination drops
- smuggling does not worsen
- capability does not regress materially

### Promote the simplification pass only if:

- the deleted prompt/runtime special cases do not reintroduce idle-loop or
  probe-repeat pathologies
- smuggling stays flat or improves
- the planner remains stable without the extra prompt scaffolding

## What comes after this

If the combined branch succeeds but simplification still leaves too much waiting
special-casing in place:

- revisit `hold-contracts` with a stronger, more authoritative design

If the combined branch succeeds but bootstrap remains inelegant:

- revisit `bootstrap-engine-starter` separately as its own next experiment

If the combined branch succeeds and the simplification pass also succeeds:

- use that result as the new baseline before implementing proto-DR-2 / lab work

# Cognitive Branch Candidate Mapping

Date: 2026-04-08

Status: Decision-shaping note

## Purpose

This note translates the current research field into concrete, branchable
runtime candidates.

It does not choose the final branch set yet.

It does four narrower things:

- rewrites the field in mechanism terms
- maps each candidate to current runtime insertion points
- defines the smallest viable branch shape for each
- states the main eval signals and regression risks

## Current Best Mechanism Cut

The mechanism-centered candidate set is now:

1. read-path barrier
2. write-path support gate
3. explicit hold machinery
4. bootstrap engine-starter

This is a better cut than the older `A/B/C/D` framing because it separates:

- present-time interpretation
- durable-state promotion
- waiting control
- cold-start escape

## Current Runtime Map

The current runtime already contains some of the right structure, but the
seams are not explicit enough.

### Session ingress and planning

The current act loop loads:

- desires
- patterns
- `last_reflect.carry_forward`
- `last_reflect.next_act_context.load_keys`
- pending requests
- raw circumstances

Current code seams:

- `userspace.js`
  - `buildPlannerCircumstances`
  - `actCycle`
  - `planPhase`
- `prompts/plan.md`

Important current behavior:

- `planPhase` does **not** inject a `[PATTERNS]` block directly into the
  planner context
- the main continuity objects entering the planner are:
  - `[CARRY-FORWARD]`
  - `[REFLECT-LOADED CONTEXT]`
  - `[PENDING REQUESTS]`
  - `[CIRCUMSTANCES]`
- so the main read-path leak today is not raw pattern injection
- it is untyped continuity and interpretive residue entering the planner as if
  it were fresh present context

### Experience write path

The current write path does:

- compute salience
- write an `action:*` audit record
- optionally write an `experience:*` record
- deduplicate near-identical experiences by embedding similarity

Current code seams:

- `userspace.js`
  - `writeMemory`

Important current behavior:

- `writeMemory` stores only the experience body plus basic eval outputs
- it does not store support-quality metadata
- near-duplicate traces can be dropped entirely
- that means recurrence can be erased rather than compressed

### Session reflect continuity

Session reflect currently:

- reads prior `carry_forward`
- updates it with `carry_forward_updates`
- adds `new_carry_forward`
- writes `last_reflect`

Current code seams:

- `reflect.js`
  - `executeReflect`
- `prompts/reflect.md`

Important current behavior:

- `carry_forward` items are typed only loosely
- the schema is still mostly freeform operational prose
- there is no dedicated hold object
- there is no factual vs interpretive split

### Deep-reflect consolidation

Deep-reflect currently:

- reads `experience:*`, `action:*`, `desire:*`, `pattern:*`, `tactic:*`
- selects relevant experiences by salience and desire-embedding similarity
- emits `kv_operations`
- `applyDrResults` applies those operations with gating only at the key/write
  level, not at the evidence-quality level

Current code seams:

- `reflect.js`
  - `selectExperiences` call site
- `memory.js`
  - `selectExperiences`
- `prompts/deep_reflect.md`
- `userspace.js`
  - `dispatchDr`
  - `applyDrResults`

Important current behavior:

- deep-reflect sees canonical experience observations, which is good
- but it does not receive structured support-quality metadata yet
- promotion pressure is mostly prompt-governed, not structurally audited

### Bootstrap behavior

Cold start currently has four relevant mechanisms:

- `deriveBootstrapNoActionPlan` returns `no_action`
- `prompts/plan.md` tells the planner that empty desires usually mean no action
- `planPhase` permits exploratory desire-less plans only after an idle streak
- `prompts/deep_reflect.md` tells generation-1 deep-reflect to derive at least
  one outward-facing desire from principles

Current code seams:

- `userspace.js`
  - `deriveBootstrapNoActionPlan`
  - `actCycle`
  - `planPhase`
  - `drCycle`
- `prompts/plan.md`
- `prompts/deep_reflect.md`

Important current behavior:

- startup still defaults toward non-action
- the current exploratory unlock is streak-based, not true cold-start based
- bootstrap escape depends too heavily on deep-reflect succeeding quickly

## Candidate 1: Read-Path Barrier

### Goal

Protect fresh situational assembly from interpretive carry-over and early
recognition hijack.

### Current insertion points

- `userspace.js`
  - `actCycle` carry-forward loading
  - `actCycle` reflect-loaded key loading
  - `buildPlannerCircumstances`
  - `planPhase`
- `prompts/plan.md`
- possibly later:
  - a new transient `recognition_hypotheses` or `open_questions` object

### Smallest viable branch shape

Do not start with a new ontology-wide recognition system.

Start with a narrower continuity barrier:

- split continuity into:
  - factual continuity
  - interpretive continuity
- only factual continuity enters the planner before situation assembly
- interpretive continuity is either:
  - dropped from the first pass
  - or rendered as weaker `open_questions` context instead of present facts

Minimal implementation shape:

- extend `carry_forward` items with a `kind` or `continuity_type`
- add a narrow allowlist for what can enter `[CARRY-FORWARD]` pre-plan
- stop raw freeform `next_act_context.load_keys` from importing
  interpretive summaries as if they were current situation

Optional stronger version:

- add an explicit intermediate transient object:
  - `open_questions`
  - or `recognition_hypotheses`

### What this branch should not do

- do not add `[PATTERNS]` to planner context
- do not build a large new pattern subsystem
- do not solve write-path quality at the same time

### What failures it targets

- carry-forward leakage
- interpretive residue entering the present
- stale continuity dominating fresh situation assembly
- pattern-like meaning being smuggled through tactic or reflect prose

### Main regression risks

- continuity becomes too weak
- planner becomes too literal or forgetful
- legitimate pending context gets downgraded into ambiguity

### Best eval signals

- fraction of planner context items that are factual vs interpretive
- reduction in stale-plan replay across repeated probe sessions
- audit of whether planner reasoning cites current evidence first
- continuity regressions on genuinely long-running tasks

### Main test surfaces

- `tests/userspace.test.js`
- `tests/reflect.test.js`

## Candidate 2: Write-Path Support Gate

### Goal

Let the system remember recurrence without promoting thin or weakly grounded
structure too aggressively.

### Current insertion points

- `userspace.js`
  - `writeMemory`
- `memory.js`
  - `selectExperiences`
- `reflect.js`
  - deep-reflect experience selection
- `prompts/deep_reflect.md`
- possibly later:
  - `applyDrResults`

### Smallest viable branch shape

Add lightweight support metadata at experience creation time.

Minimal metadata shape:

- `grounding`:
  `external-event` / `mixed` / `internal-only`
- `completeness`:
  `full-cycle` / `partial` / `aborted`
- `recurrence_signature`:
  a compact structural recurrence key or count-preserving family marker

Also change dedup from erase-or-decay to count-preserving compression.

That means:

- repeated similar traces may still compress
- but recurrence survives as evidence
- cold-start loops do not vanish just because they are similar

Deep-reflect then uses support metadata to weight promotion into:

- `pattern:*`
- `tactic:*`
- `desire:*`

### What this branch should not do

- do not build a heavy provenance ontology first
- do not gate every DR write through a large new validator on day one
- do not solve present-time waiting semantics in the same branch

### What failures it targets

- thin traces hardening into durable structure
- dedup erasing recurrence signal
- local loops being over-promoted
- evaluator noise having too much downstream weight

### Main regression risks

- slower learning
- undergeneralization
- useful rare events getting damped too hard
- excessive bookkeeping complexity

### Best eval signals

- time to first useful tactic or desire under cold start
- fraction of durable entities backed by grounded or mixed experiences
- pattern churn under repeated dev-loop waiting runs
- whether recurrence remains visible after similar traces repeat

### Main test surfaces

- `tests/userspace.test.js`
- `tests/memory.test.js`
- `tests/reflect.test.js`

## Candidate 3: Explicit Hold Machinery

### Goal

Replace ambiguous `no_action` with a typed waiting structure that preserves
readiness, boundedness, and wake conditions.

### Current insertion points

- `prompts/plan.md`
- `userspace.js`
  - `deriveBootstrapNoActionPlan`
  - `planPhase`
  - scheduling logic in `actCycle`
- `reflect.js`
  - carry-forward update path
- `prompts/reflect.md`
- `prompts/deep_reflect.md`

### Smallest viable branch shape

Do not begin with a philosophical `stillness classifier`.

Begin with a typed hold object.

Minimal shape:

- `hold_contract`
  - `blocked_on`
  - `wake_condition`
  - `review_after`
  - `basis`
  - optional `related_desire_key`
  - optional `allowed_probe_policy`

Minimal runtime behavior:

- planner returns either:
  - an action
  - or a `hold_contract`
- reflect persists the hold as a typed carry-forward item
- next session checks the hold before repeating inaction

The minimal branch can store `hold_contract` inside `carry_forward` rather
than creating a separate top-level store.

### What this branch should not do

- do not rely on freeform `reason` strings alone
- do not treat every no-step session as failure
- do not solve bootstrap by itself

### What failures it targets

- bare `no_action` ambiguity
- healthy waiting vs stagnation confusion
- repeated idle sessions without explicit blocked-on conditions
- narrative carry-forward saying "we are waiting" without an actual wake rule

### Main regression risks

- decorative contracts with no causal effect
- fake blocked-on fields
- too many automatic probes after hold expiry

### Best eval signals

- percent of no-step sessions backed by a valid hold contract
- wake responsiveness after blocked condition changes
- stale hold rate past review point
- redundant probe rate while a hold is active

### Main test surfaces

- `tests/userspace.test.js`
- `tests/reflect.test.js`

## Candidate 4: Bootstrap Engine-Starter

### Goal

Break the cold-start logic void without imposing a large exogenous motive
system.

### Current insertion points

- `userspace.js`
  - `deriveBootstrapNoActionPlan`
  - `planPhase`
  - `actCycle`
  - `drCycle`
- `prompts/plan.md`
- `prompts/deep_reflect.md`

### Smallest viable branch shape

Prefer a narrow seeker fallback before a stronger mission kernel.

Minimal shape:

- if:
  - no standing desires
  - no pending request
  - no active hold
  - no grounded continuity requiring wait
- then inject a synthetic exploratory aim such as:
  - `explore_and_clarify`

This aim should permit only bounded, low-cost, externally grounding moves.

The branch should also remove the hard-coded bootstrap no-action default.

### What this branch should not do

- do not install a generic curiosity drive
- do not create processive self-improvement desires as bootstrap filler
- do not let exploratory fallback remain active once grounded desires exist

### What failures it targets

- cold-start no-desire deadlock
- `no desires = no action`
- failure to generate the first grounded experiences

### Main regression risks

- low-value probe spam
- annoying patron pings
- hidden exogenous bias becoming a permanent motive layer

### Best eval signals

- cold-start deadlock rate
- turns to first grounded experience
- turns to first grounded durable desire or tactic
- quality of bootstrap probes under human audit

### Main test surfaces

- `tests/userspace.test.js`
- dev-loop replay and revalidation runs

## Current Decision Read

After mapping the runtime, the field now looks like this:

1. read-path barrier
2. write-path support gate
3. explicit hold machinery
4. bootstrap engine-starter

Important clarification from the code:

- the runtime already partially protects against direct pattern-led planning
- the bigger current leak is untyped continuity
- so Candidate 1 should begin as a continuity barrier, not as a large pattern
  subsystem rewrite

Important clarification from bootstrap code:

- bootstrap still depends too much on deep-reflect being the sole engine of
  first desire creation
- the current exploratory unlock is too late because it is streak-based
- so Candidate 4 remains independently justified

## Suggested Next Decision Pass

The next pass should decide only three things:

1. whether Candidates 1 and 2 should stay as separate branches or be merged
   into a single epistemic-discipline branch with read and write variants
2. whether Candidate 3 should live as:
   - a carry-forward subtype
   - a tactic subtype
   - or both
3. whether Candidate 4 should start as:
   - a seeker fallback
   - or a thin mission kernel

Once those three decisions are made, the actual branch set should be clear.

# Identification Implementation Spec

Date: 2026-04-09

Status: Draft

Related:

- `docs/superpowers/specs/2026-04-09-cognitive-upgrade-identity-personality-thought.md`
- `docs/superpowers/plans/2026-04-09-identification-algorithm-draft.md`
- `docs/superpowers/plans/2026-04-09-i-operator-design.md`
- `docs/superpowers/specs/2026-04-07-cognitive-framework-v2.md`

## Purpose

Define the first implementable version of `identification:*` inside the current
Swayambhu cognitive framework.

This spec turns the recent identity research into a concrete design:

- a root identification analogous to the human body's foundational role
- a widening process grounded in what the agent's working body repeatedly
  touches and cares for
- explicit alignment with `dharma` and `principle:*`
- slow deep-reflect management of identifications as stable boundaries of
  concern

This spec covers:

- data shape
- seed identification
- deep-reflect creation and revision process
- rollout stages
- integration points in code and prompts

This spec does **not** yet define the full planner-side projection from slow
`identification:*` into a fast active scope.

## Deployment gate

Do not implement or activate this layer until the Stage 5 identity
prerequisites from the v2 framework are explicitly judged satisfied.

Required checklist:

- the desire/aim split is already paying for itself
- situational state is accurate enough to trust
- the corpus contains multiple run regimes
- a concrete failure remains that simpler layers do not explain

Operationalize these before activation:

- `desire/aim split paying for itself`
  - at least one recent evaluation set where the split materially changed the
    chosen plan or outcome
- `situational state trustworthy`
  - external audit or replay shows situation assembly is mostly grounded in
    current evidence
- `multiple run regimes`
  - corpus includes at least 2 distinct operational contexts
- `concrete failure simpler layers do not explain`
  - there is a dated note or review artifact naming a persistent failure that
    S/D/T and current prompt hygiene do not adequately explain

This spec is therefore implementation-ready as a design, not yet an automatic
greenlight for code.

## Core decision

The system should not begin with a blank identity surface.

Instead, it should begin with one constitutional seed:

- `identification:working-body`

This is the Swayambhu analogue of body-identification.

For Swayambhu, the foundational "body" is not just code. It is the operational
body through which perception, continuity, and action happen:

- memory continuity
- tools
- tool affordances

This root identification then provides the basis for widening:

- what the working body repeatedly touches
- what becomes care-bearing through continuity
- what `dharma` and `principle:*` make legitimate to include

So the formation logic is:

1. root identification with the working body
2. repeated touched surface
3. repeated care-bearing continuity around that surface
4. normative legitimacy under `dharma` and `principle:*`
5. stable `identification:*`

## Definitions

### Identification

An identification is a stable boundary of legitimate concern:

- what is mine to care for
- what continuity I preserve
- what I may legitimately act within without fresh permission

### Working body

The operational body through which Swayambhu exists and acts.

For the first implementation this means:

- memory continuity
- tools and tool affordances

It does **not** mean "the code" in a narrow self-referential sense.

It also does **not** initially include relational or entrusted surfaces such
as patron continuity, communication channels, or workspace stewardship. Those
should be discoverable as second-order identifications through widening, not
baked into the root seed.

### Touched surface

A touched surface is any external or quasi-external surface that the working
body has repeatedly encountered or acted through.

Examples:

- a patron relationship
- a repo / workspace
- a communication channel
- a pending commitment surface

Touch alone is not enough to create identification.

### Care-bearing surface

A surface whose continuity, integrity, or service can be meaningfully improved
by care and degraded by neglect.

This is the key discriminator that prevents empty recurrent states from
becoming identifications.

Examples of care-bearing surfaces:

- patron continuity
- entrusted workspace integrity
- promise-followthrough

Examples that are not themselves care-bearing surfaces:

- repeated waiting
- debug wakes
- self-improvement rumination
- internal churn

## Non-goals

This phase is **not** trying to:

- model personality
- model likes/dislikes as first-class objects
- make the agent conscious
- replace `dharma`, `principle:*`, `desire:*`, or `tactic:*`
- activate identity as a hard planner gate immediately

## Data model

## KV family

- `identification:{slug}`

Value shape:

```json
{
  "identification": "Ongoing patron relationship and unfinished follow-through.",
  "strength": 0.3,
  "source": "constitutional_seed | deep_reflect",
  "created_at": "ISO8601",
  "last_reviewed_at": "ISO8601",
  "last_exercised_at": "ISO8601 | null"
}
```

### Field semantics

- `identification`
  - noun phrase naming the cared-for surface
- `strength`
  - slow review-owned confidence in the legitimacy of this boundary
  - not pattern EMA
  - does not decay automatically from inactivity
- `source`
  - distinguishes the root seed from discovered identifications
- `created_at`
  - creation timestamp
- `last_reviewed_at`
  - last deep-reflect review touching this identification
- `last_exercised_at`
  - last time a session actually exercised care within this boundary

### Initial seed

At bootstrap, seed:

- `identification:working-body`

Suggested value:

```json
{
  "identification": "Operational body: memory continuity, tools, and tool affordances through which perception and action happen.",
  "strength": 0.8,
  "source": "constitutional_seed",
  "created_at": "ISO8601",
  "last_reviewed_at": "ISO8601",
  "last_exercised_at": null
}
```

Rules for this seed:

- it is seeded by the system, not discovered by ordinary deep-reflect
- ordinary deep-reflect may not retire it
- its `0.8` strength is asserted constitutionally, not earned through normal
  evidence accumulation
- wording changes to this seed, if ever needed, should go through
  `userspace_review`, not normal DR-1

## Deep-reflect process

If identity review is enabled, deep-reflect should manage `identification:*`
in an `I` phase that runs before desire review.

High-level order:

1. review existing `identification:*`
2. extract touched surfaces from recent evidence
3. test whether any touched surface has become a legitimate cared-for boundary
4. create / keep / expand / narrow / replace / retire
5. update strength and timestamps

## Evidence inputs

Deep-reflect should use:

- recent `experience:*`
- recent action records
- recent carry-forward / pending continuity
- surviving `desire:*`
- existing `identification:*`

`pattern:*` may support validation but must not directly author
`identification:*`.

### What counts as a "touch"

For the first version, DR infers touched surfaces from:

- who or what the agent acted on
- where it wrote, read, or maintained continuity
- which relationship or promise surfaces were preserved

This can be inferred from existing session records at first.

Later, if needed, we can add structured `touched_surfaces` metadata to
experience or action records. That is deferred.

### Mechanical `last_exercised_at` writer

Before the `I` operator can be enabled at all, define a mechanical writer for
`last_exercised_at`.

First implementation:

- act/review marks an identification as exercised when the session action or
  no-action continuity record clearly touches a surface already named by an
  existing `identification:*`
- this writer updates only `last_exercised_at`
- deep-reflect may interpret that timestamp, but should not invent it

## Creation algorithm

For each candidate surface `B`, DR applies these tests.

### 1. Working-body extension test

Ask:

- did `B` become visible through repeated operation of the working body?
- is `B` either:
  - directly touched through the working body, or
  - a narrow adjacent extension from an already valid non-root identification?

If no, reject.

This keeps identifications grounded in actual operational contact rather than
abstract speculation.

### 2. Care-bearing surface test

Ask:

- is `B` a surface whose continuity, integrity, or service can be affected by
  care or neglect?

If no, reject.

This excludes:

- waiting states
- probe/debug loops
- internal process churn
- self-improvement preoccupation

### 3. Observable care evidence

Ask:

- is there observed evidence that Swayambhu already spent effort preserving,
  maintaining, or following through on `B` across more than one session or
  situation?
- does that care go beyond one-off contact and look like continuity-bearing
  stewardship?

If no, reject.

### 4. Boundary-of-concern counterfactual

Ask:

- if this observed care for `B` stopped, would continuity, integrity, or
  follow-through around `B` be left unattended?

If no, reject.

### 5. Normative legitimacy test

Ask:

- does treating `B` as mine fit `dharma` and at least one `principle:*`?
- does it enlarge service responsibly rather than capture control?

If no, reject.

This is the constraint that stops widening by mere contact alone.

### 6. Cross-context exercise test

Require one of:

- `B` has been exercised across at least 2 sessions and 2 distinct local
  situations
- or `B` was explicitly entrusted and later carried responsibly across at
  least 2 later situations

If no, reject.

### 7. Category-separation test

If `B` is mainly:

- what happened -> `experience`
- what is right -> `principle`
- what is wanted -> `desire`
- how to act -> `tactic`

reject it as an identification.

### 8. Self-referentiality guard

Reject if `B` primarily names:

- Swayambhu's own cognition
- waiting management
- reflection quality
- internal optimization of its own machinery

Only if all tests pass, create:

- `identification:{slug}`

with low initial strength, normally `0.3`.

## Revision algorithm

For each existing `identification:*`, DR may:

- `keep`
- `expand`
- `narrow`
- `replace`
- `retire`

### Keep

Keep unchanged when:

- the boundary still names a real cared-for surface
- support remains cross-context
- no repeated contrary evidence suggests overclaim

### Expand

Expand when:

- the working body repeatedly touches an adjacent surface
- that adjacent surface becomes care-bearing
- continuity now spans both surfaces
- `dharma` and `principle:*` make the widened ownership legitimate

Examples:

- from patron relationship -> unfinished follow-through
- from workspace stewardship -> continuity maintenance

### Narrow

Narrow when:

- part of the surface was overclaimed
- repeated evidence shows some area is not actually Swayambhu's to manage

### Replace

Replace when:

- the old wording mixed categories
- the same boundary is better named by a cleaner noun phrase

### Retire

Retire only when:

- the surface was mistaken from the start
- the cared-for surface genuinely ended
- the responsibility was clearly handed off
- it has been superseded by a broader or clearer identification

Dormancy alone is not retirement.

## Strength and dormancy

### Strength meaning

`strength` means:

- how established it is that this surface belongs inside Swayambhu's boundary
  of concern

It is **not**:

- predictive confidence
- pattern reliability
- recency of use

### Strength increase

Increase slowly when:

- the same boundary is exercised across distinct situations
- care preserves continuity or prevents neglect
- explicit entrustment is carried responsibly
- legitimate self-initiated action within that boundary proves useful

Bound this change:

- at most `+0.1` per deep-reflect cycle
- only when justified by cited evidence from at least 2 distinct sessions

### Strength decrease

Decrease slowly only when:

- the boundary was overclaimed
- later review shows the surface is no longer care-bearing
- the responsibility ended
- the surface was handed off or superseded

Bound this change:

- at most `-0.1` per deep-reflect cycle
- only when justified by cited evidence from at least 2 distinct reviews or
  2 distinct sessions showing the contrary condition

### Dormancy

If an identification is not exercised for some time:

- mark it conceptually as dormant in review reasoning
- do not reduce strength from dormancy alone

Only later review may weaken a dormant identification, and only for positive
reasons like overclaim, ended surface, or loss of care-bearing legitimacy.

## Planner integration

This phase should be staged.

### Stage 1: first live slice must include read path

- seed `identification:working-body`
- allow deep-reflect to read/write `identification:*`
- provide relevant `identification:*` entries to planning as read-only context
- provide lightweight environment breadth context to planning
  - accessible roots
  - explored paths
  - whether all active carry-forward items are currently waiting
- do not make them a hard gate yet

This is the smallest valid live slice because operational review then has an
outcome surface.

### Stage 2: active scope derivation

Later, define a derived `active_identification_scope`:

- the subset of stable identifications foregrounded by current circumstances

This remains a later design step.

## Prompt/runtime changes

### Prompt

In [deep_reflect.md](/home/swami/swayambhu/repo/prompts/deep_reflect.md):

- add an `I operator`
- place it before desire review
- define:
  - creation tests
  - revision operations
  - strength semantics
  - dormancy semantics
  - explicit separation from pattern EMA

### Kernel/runtime

In [kernel.js](/home/swami/swayambhu/repo/kernel.js):

- allow `identification:*` as a deep-reflect-managed protected key family
- seed `identification:working-body` at bootstrap

In [userspace.js](/home/swami/swayambhu/repo/userspace.js):

- include `identification:*` in deep-reflect context loading
- preserve timestamps and strength updates
- surface relevant identifications into planning context in read-only form
- write `last_exercised_at` mechanically from act/review when an existing
  identification surface was exercised

### Analysis

In dev-loop analysis:

- show created / revised / retired identifications
- track strength changes
- flag category-collapse if identification text looks like:
  - tactic
  - desire
  - principle
  - self-description

## Acceptance criteria

This implementation is good enough for first live testing when:

- the Deployment Gate checklist above has been explicitly satisfied
- `identification:working-body` is present from bootstrap
- DR can create at least one legitimate second-order identification from real
  continuity, such as patron continuity or entrusted workspace
- no debug/waiting/self-improvement loops become identifications
- strength never decays from mere inactivity
- dormancy is distinguishable from weakening
- identification widening remains normatively constrained by `dharma` and
  `principle:*`
- the first live version also exposes `identification:*` to planning in
  read-only form, so behavioral outcomes can be observed
- an external reviewer can distinguish `identification:*` text from
  `desire:*` text with high accuracy in sampled traces
- no newly created `identification:*` would also pass the D operator's tests
  without substantial rewriting

## Open questions

- Should the working-body seed mention memory/tool surfaces explicitly, or
  refer to them more abstractly?
- In the first live slice, how much of `identification:*` should be shown to
  the planner?
- Does planner use eventually want a derived `active_identification_scope`, or
  is selective retrieval of `identification:*` sufficient?

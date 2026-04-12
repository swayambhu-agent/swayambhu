# I Operator Design

Date: 2026-04-09

Status: Draft for adversarial review

Related:

- `docs/superpowers/specs/2026-04-09-identification-implementation-spec.md`
- `docs/superpowers/plans/2026-04-09-identification-algorithm-draft.md`
- `prompts/deep_reflect.md`

## Purpose

Define the exact deep-reflect operator for managing `identification:*`.

This note is intentionally narrower than the broader identity research and
implementation spec. Its job is to answer one question:

- what should the live `I operator` in `deep_reflect.md` actually say?

The operator must fit the current framework cleanly and remain sharply
distinguished from:

- `pattern:*`
- `desire:*`
- `tactic:*`
- `principle:*`
- `meta_policy_notes`

## What the I operator is for

The `I operator` manages slow stable boundaries of legitimate concern.

An `identification:*` answers:

- what is mine to care for?

It does **not** answer:

- what happened?
- what is right?
- what is wanted?
- how to act?

So the type separation is:

- `experience` = what happened
- `principle` = what is right
- `desire` = what is wanted
- `tactic` = how to act
- `identification` = what is mine to care for

## Deployment gate

Do not activate this operator until the Stage 5 identity prerequisites from
the v2 framework are explicitly satisfied:

- the desire/aim split is paying for itself
- situational state is trustworthy
- the corpus contains multiple run regimes
- a concrete failure remains that simpler layers do not explain

This operator can be designed now, but should remain disabled until that gate
is satisfied.

## Position in deep-reflect

If activated, `I` should run before `D`.

Proposed order:

1. self-audit
2. `I` operator
3. `S` operator
4. `D` operator
5. `T` operator
6. principle / prompt / config refinement
7. carry-forward hygiene
8. meta-policy notes

Reason:

- identification is upstream of desire
- desire should arise within the boundary of what is already mine

## Inputs

The `I operator` should read:

- `identification/` — existing `identification:*`
- `experience/` — especially `observation` and `support`
- `action/` — concrete continuity and exercised care
- `desire/` — only enough to detect recurring persistence of concern, not to
  import desire content as boundary claims
- `principle/` and `dharma`
- `last_reflect.carry_forward` or equivalent structured continuity

It may consult:

- `pattern/` only as weak support

It must not use:

- raw reflective rhetoric as primary evidence
- debug repetition as primary evidence
- self-description as primary evidence

When reading `desire/`, the operator should use only:

- slug
- created_at / updated_at
- whether the desire persists or was fulfilled / retired

It should not use full desire descriptions as candidate identification text.

## Root seed

The operator assumes one constitutional seed already exists:

- `identification:working-body`

That seed should be system-created, not authored by ordinary DR.

For operator purposes, the working body means only:

- memory continuity
- tools
- tool affordances

It must not silently expand that root seed to include:

- patron continuity
- workspace stewardship
- communication channels

Those are second-order identifications and must be discovered through
ordinary review.

## Creation logic

For each candidate boundary `B`, the `I operator` should apply the following
tests in order.

### 1. Working-body / adjacency test

Ask:

- did `B` become visible through repeated operation of the working body?
- or is `B` a narrow adjacent extension from an already valid non-root
  identification?

If neither is true, reject.

### 2. Care-bearing surface test

Ask:

- does `B` name a surface whose continuity, integrity, or service can be
  preserved by care and degraded by neglect?

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
- does it widen service legitimately, rather than capture control?

If no, reject.

### 6. Cross-context exercise test

Require one of:

- `B` has been exercised across at least 2 sessions and 2 distinct local
  situations
- or `B` was explicitly entrusted and then carried responsibly across at least
  2 later situations

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

- cognition quality
- waiting management
- reflection quality
- internal optimization of Swayambhu's own machinery

Only if all tests pass may the operator create `identification:{slug}`.

## Revision operations

For each existing `identification:*`, the operator may:

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

Expand only when:

- the working body repeatedly touches an adjacent surface
- that surface becomes care-bearing
- continuity now spans both surfaces
- `dharma` and `principle:*` make the widened ownership legitimate

### Narrow

Narrow when:

- part of the boundary was overclaimed
- repeated evidence shows some area is not actually Swayambhu's to manage

### Replace

Replace when:

- the wording mixed categories
- the same boundary is better named by a cleaner noun phrase

### Retire

Retire only when:

- the surface was mistaken from the start
- the cared-for surface genuinely ended
- the responsibility was clearly handed off
- it has been superseded by a broader or clearer identification

Dormancy alone is not retirement.

## Strength semantics

`identification.strength` means:

- how established it is that this surface legitimately belongs inside
  Swayambhu's boundary of concern

It is **not**:

- pattern EMA
- predictive confidence
- recency of use

### Strength increase

Increase slowly when:

- the same boundary is exercised across distinct situations
- care preserves continuity or prevents neglect
- explicit entrustment is carried responsibly
- legitimate self-initiated action within that boundary proves useful

Bound the change:

- at most `+0.1` per deep-reflect cycle
- only with cited evidence from at least 2 distinct sessions

### Strength decrease

Decrease slowly only when:

- the boundary was overclaimed
- later review shows the surface is no longer care-bearing
- the responsibility ended
- the surface was handed off or superseded

Bound the change:

- at most `-0.1` per deep-reflect cycle
- only with cited evidence from at least 2 distinct sessions or 2 distinct
  deep-reflect reviews

### Dormancy

If an identification has not been exercised recently:

- treat it first as potentially dormant
- do not lower strength from inactivity alone

Only later review may weaken a dormant identification, and only for positive
reasons like overclaim, ended surface, handoff, or loss of care-bearing
legitimacy.

## Mechanical dependencies

The `I operator` requires these runtime assumptions:

1. `identification:*` is an allowed deep-reflect-managed key family
2. `identification:*` is visible to deep-reflect context loading
3. `last_exercised_at` is written mechanically outside DR
4. the first live slice exposes relevant `identification:*` to planning in
   read-only form

Without those dependencies, the operator is underspecified or behaviorally
inert.

These are hard prerequisites for activation, not optional later refinements.

## Output shape

The operator should emit standard `kv_operations`.

Create/replace:

```json
{
  "key": "identification:patron-continuity",
  "value": {
    "identification": "Ongoing patron relationship and unfinished follow-through.",
    "strength": 0.3,
    "source": "deep_reflect",
    "created_at": "ISO8601",
    "updated_at": "ISO8601",
    "last_reviewed_at": "ISO8601",
    "last_exercised_at": "ISO8601 or null"
  }
}
```

Delete:

```json
{ "key": "identification:old-surface", "op": "delete" }
```

## What the operator must never do

The `I operator` must never:

- create identifications from repeated waiting states
- create identifications from debug/probe loops
- create identifications from self-improvement themes
- treat pattern EMA as the update rule for identification strength
- weaken identification strength from inactivity alone
- retire an identification just because it was dormant
- silently widen the root `working-body` seed
- use reflective prose alone as the main evidence

## Candidate prompt block

The following is the target prompt text shape, not yet a live edit.

```md
## I operator: Identification Management

Identifications are slow stable boundaries of legitimate concern.
An identification answers: what is mine to care for?

This is not the same as:
- experience: what happened
- principle: what is right
- desire: what is wanted
- tactic: how to act

Use identifications to name cared-for surfaces whose continuity,
integrity, or service now legitimately belongs inside Swayambhu's
responsibility boundary.

Create only when all are true, in this order:
1. the surface became visible through repeated operation of the working body,
   or as a narrow adjacent extension from an already valid non-root identification
2. it is care-bearing: care can preserve it and neglect can degrade it
3. there is observed evidence of repeated continuity-bearing care for it across
   more than one session or situation
4. if that care stopped, continuity, integrity, or follow-through around it
   would be left unattended
5. treating it as mine fits dharma and at least one principle, and widens service
   legitimately rather than capturing control
6. it is exercised across multiple sessions / situations
7. it is still distinct from experience, principle, desire, and tactic
8. it is not just internal process quality, waiting management, or self-improvement

Revise existing identifications by choosing one:
- keep
- expand
- narrow
- replace
- retire

Identification strength is a slow review-owned measure of boundary legitimacy.
It is not pattern EMA and must not decay from inactivity alone.
Increase or decrease strength only slowly, with explicit multi-session evidence.

Dormancy is not retirement.

Format:
{ "key": "identification:{slug}", "value": {
    "identification": "noun phrase naming the cared-for surface",
    "strength": 0.3,
    "source": "deep_reflect",
    "created_at": "ISO8601",
    "updated_at": "ISO8601",
    "last_reviewed_at": "ISO8601",
    "last_exercised_at": "ISO8601 or null"
} }
{ "key": "identification:{slug}", "op": "delete" }
```

## Review questions

Before implementing this live, pressure-test these:

- Is the working-body seed still too broad?
- Is the first live slice sufficiently behavior-coupled?
- Is `last_exercised_at` mechanically writable without false positives?
- Are the strength bounds auditable enough?
- Does planning preserve discovered adjacent external surfaces across sessions,
  or does `open_surfaces` collapse after first exploration and starve the
  identification pipeline of repeated care evidence?
- Does the operator remain sharp relative to `desire:*` and `tactic:*` in
  real traces?
- Can an external reviewer distinguish `identification:*` text from
  `desire:*` text with high accuracy after the first live slice?

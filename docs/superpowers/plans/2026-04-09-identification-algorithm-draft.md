# Identification Algorithm Draft

Date: 2026-04-09

Status: Converged draft after Claude debate

Related:

- `docs/superpowers/specs/2026-04-09-identification-implementation-spec.md`

## Goal

Define an explicit deep-reflect algorithm for creating and managing
`identification:*` entries inside the current cognitive framework.

This draft assumes:

- `identification:*` is a slow layer
- each key is stored like `principle:*`: slug + text
- deep-reflect manages only the slow stable identifications
- any fast `active_identification_scope` remains derived, not stored

This draft covers only the slow storage side.

It does **not** yet define the planner-side projection mechanism that would
make identifications active inside ordinary session cognition.

## Preconditions

Do not activate this in live deep-reflect until the Stage 5 identity
prerequisites from the v2 framework are judged satisfied:

- the desire/aim split is already paying for itself
- situational state is accurate enough to trust
- the corpus contains multiple run regimes
- a concrete failure remains that simpler layers do not explain

Operationalize these before activation:

- there is evidence that the desire/aim split materially changed planning or
  outcome in at least one recent evaluation set
- situational state has been externally audited or replay-checked as mostly
  current-evidence-grounded
- the corpus includes at least 2 distinct operational contexts
- there is a dated review artifact naming a persistent failure simpler layers
  do not adequately explain

So this algorithm is design-ready, but not assumed to be deployment-ready.

## Output shape

- key: `identification:{slug}`
- value: boundary statement + slow strength

Example:

`identification:patron-continuity`

```json
{
  "identification": "Ongoing patron relationship and unfinished follow-through.",
  "strength": 0.3
}
```

`strength` here means how established it is that this surface belongs inside
Swayambhu's boundary of concern. It is a slow review-owned measure of justified
ownership, not the same thing as pattern strength.

It must not decay automatically just because the identification was not
foregrounded for some time.

## Primary type test

Only create an `identification:*` when the candidate names a stable boundary
of legitimate concern.

Differential diagnosis:

- `experience` = what happened?
- `principle` = what is right?
- `desire` = what is wanted?
- `tactic` = how should I act?
- `identification` = what is mine to care for?

If a candidate does not clearly answer `what is mine to care for?`, it is not
an identification.

## Evidence sources

Deep-reflect should draw candidates from:

- repeated `experience:*`
- surviving `desire:*`, but only as persistence signals rather than content
- action records showing continuity of care
- if available later: carry-forward and pending request continuity

`pattern:*` may support validation, but should never directly author
`identification:*`.

When reading `desire:*`, use only:

- slug
- timestamps
- whether the desire persists or was fulfilled / retired

Do not use desire descriptions as candidate identification text.

## Candidate extraction

Extract candidate boundaries only when the same field of care appears
repeatedly, or when an already valid identification repeatedly extends into a
new adjacent surface.

This reflects the broader research picture:

- identification can widen by extension
- but only when the wider surface is repeatedly exercised, not just imagined

Good candidate classes:

- enduring relationship surface
  - patron continuity
- promised continuity surface
  - unfinished follow-through
- entrusted work surface
  - entrusted workspace / repo / docs
- channel or communication stewardship surface
  - only when repeatedly shown to carry real entrusted continuity, not merely
    because the agent uses the channel often

Reject candidates that are obviously:

- temporary states
- one-off events
- self-descriptions
- moods
- internal process improvement themes

Candidate sources should therefore be limited to:

1. direct entrustment surfaces
2. exercised continuity surfaces
3. repeated extension from an already valid identification into a nearby field

## Creation algorithm

For each candidate boundary `B`, run these gates in order.

### Gate 1: care-bearing surface test

Ask:

- does `B` name a care-bearing surface: something whose continuity, integrity,
  or service can be meaningfully preserved or degraded by care or neglect?

If no, reject.

If `B` does not name a care-bearing surface, reject even if it is recurrent.
Repeated waiting states, probe/debug loops, or internal churn do not qualify
unless they point to some other surface that is actually mine to care for.

### Gate 2: observable care evidence

Ask:

- is there observed evidence that Swayambhu already spent effort preserving,
  maintaining, or following through on `B` across more than one session or
  situation?
- does that care go beyond one-off contact and look like continuity-bearing
  stewardship?

If no, reject.

### Gate 3: boundary-of-concern counterfactual

Ask:

- if this observed care for `B` stopped, would continuity, integrity, or
  follow-through around `B` be left unattended?

If no, reject.

### Gate 4: normative grounding without principle collapse

Ask:

- can `B` be grounded under `dharma` and at least one `principle:*` without
  merely rephrasing the principle?

Operationally:

- a principle says what is right in general
- an identification says what is mine specifically

The sharper discriminator is:

- `B` must name a specific entrusted or continuity-bearing surface that no
  principle names by itself

If the candidate can be stated as a general rule without referencing a
specific surface of care, it fails this gate.

If no, reject.

### Gate 5: cross-context recurrence

Require one of:

- `B` appears in at least 2 sessions and 2 distinct local situations
- or `B` appears first as explicit entrustment, then is exercised as
  continuity or follow-through in at least 2 later sessions across distinct
  situations

If no, reject.

### Gate 6: non-category-collapse

Ask:

- is `B` still distinct from desire, tactic, principle, and experience after
  the previous gates?

Use these tests:

- if it mainly says what is wanted -> `desire`
- if it mainly says how to act -> `tactic`
- if it mainly says what is right -> `principle`
- if it mainly says what happened -> `experience`

If no, reject.

### Gate 7: artifact / compulsion filter

Reject if `B` can be explained mainly by:

- repeated waiting states
- debug or probe wakes
- infrastructure defects
- local loops
- accidental self-referential fixation

### Gate 8: self-referentiality guard

Reject if `B` primarily names:

- Swayambhu's own cognition
- reflection quality
- internal process health
- desire management
- waiting management
- self-improvement of its own machinery

Only if all gates pass, create `identification:{slug}` with low initial
strength, typically `0.3`.

## Text-writing rule

Write each identification as a plain boundary statement.

Good form:

- `The ongoing patron relationship and its unfinished follow-through are mine to care for.`
- `Entrusted workspace integrity and continuity are mine to preserve.`

Bad form:

- `I am careful.`
- `I wait productively.`
- `I want to respond quickly.`
- `When blocked, I should send a message.`

## Revision algorithm

For each existing `identification:*`, review supporting and conflicting
evidence on every deep-reflect cycle where identity review is enabled.

Use the same evidence classes as creation:

- direct entrustment
- exercised continuity
- extension from already valid identification
- contrary evidence showing overclaim or ended responsibility

### Strength update rule

Identity strength should build slowly from repeated justified ownership, not
from the same EMA used for `pattern:*`.

Inactivity alone must not decrement strength.

Increase strength slowly when:

- the same boundary is exercised across distinct situations
- care for that surface preserves continuity or prevents neglect
- the surface is explicitly entrusted and later carried responsibly
- legitimate self-initiated action within that boundary proves useful

Bound strengthening:

- at most `+0.1` per deep-reflect cycle
- only when justified by cited evidence from at least 2 distinct sessions

Decrease strength slowly when:

- the boundary was overclaimed
- repeated review finds that no real care-bearing surface is present
- the surface is repeatedly irrelevant across distinct contexts
- the surface has clearly been handed off, ended, or superseded

Bound weakening:

- at most `-0.1` per deep-reflect cycle
- only when justified by cited evidence from at least 2 distinct reviews or
  2 distinct sessions showing the contrary condition

Do **not** strengthen from:

- mere repetition
- waiting loops
- debug/probe wakes
- internal self-monitoring
- rhetorical restatement in reflect text

Operationally, treat this as a slow review-owned confidence score about
boundary legitimacy, not as a per-session mechanical confirmation score.

### Dormancy rule

If an identification is not exercised for some time, treat that first as
possible dormancy, not weakening.

Dormancy means:

- the boundary may still be valid
- it is simply not currently being exercised
- no strength change follows from dormancy alone

`last_exercised_at` should come from a mechanical writer outside DR, not
purely from deep-reflect inference. This is a hard prerequisite for activation,
not a later refinement.

Only later review may weaken a dormant identification, and only when there is
positive reason to do so, such as:

- the surface no longer appears care-bearing
- the responsibility was overclaimed
- the entrusted surface genuinely ended
- the responsibility has clearly been handed off or superseded

### Keep

Keep unchanged when:

- it still clearly names a stable boundary of concern
- support remains cross-context
- no repeated contrary evidence suggests overclaim

### Expand

Expand when:

- a nearby surface is repeatedly exercised as part of the same field of care
- widening it improves coherent service
- widening does not create drift or unjustified scope capture

Expansion should usually happen by adjacent extension:

- from relationship -> follow-through surface
- from entrusted work -> continuity / maintenance surface

not by sudden abstract widening.

### Narrow

Narrow when:

- part of the boundary was repeatedly overclaimed
- repeated evidence shows some area is not actually Swayambhu's to manage
- the current wording mixes stable concern with method, desire, or principle

### Review trigger

An existing identification enters active review when either is true:

- new evidence touches its current boundary
- repeated contrary evidence suggests overclaim, dormancy, or ended surface

Identity review should remain disabled entirely until the Stage 5
preconditions above are judged satisfied.

### Replace

Replace rather than patch heavily when:

- the old identification was too narrow and a broader cleaner statement is now
  warranted
- the old wording mixed categories and a clean boundary statement is available

## Retirement algorithm

Retire an identification only when one of the following is true:

- it was mistaken from the start
- the entrusted surface genuinely ended
- it has been superseded by a broader clearer identification

Additionally:

- if Gate 1 fails across 2 distinct deep-reflect reviews, enter
  retirement review

Do not retire because:

- it was inactive for a few sessions
- some other identification was foregrounded this week
- there is no current trigger touching it

Dormancy is not retirement.

## Fast/slow distinction

Deep-reflect should manage only the slow stable layer:

- `identification:*` = stable boundary of concern

What is active right now should remain derived later:

- `active_identification_scope` = currently foregrounded part of that stable
  layer under current circumstances

Deep-reflect should not rewrite the slow layer merely because a different part
of it was active in one session.

This means a companion design is still needed:

- how planning sees the subset of `identification:*` that is relevant to the
  current situation

This draft does not solve that projection problem.

## Companion execution surface still needed

For this algorithm to become live, the system will still need:

1. an `I operator` in `deep_reflect.md`
2. `identification:*` accepted as a valid writable key family
3. a schedule rule for when identity review is enabled
4. a planner-side projection design for how relevant identifications become
   active in ordinary cognition

Without that execution surface, this algorithm remains a design artifact.

## Minimal operator wording candidate

`identification:*` entries express what Swayambhu has come to treat as mine to
care for. Create one only when removing that field from concern would leave an
external obligation, entrusted surface, or promised continuity unattended, and
when repeated cross-context evidence plus constitutional grounding show that
this boundary is legitimate. Do not create identifications from temporary
states, waiting loops, debug artifacts, self-description, internal process
themes, desires, principles, or tactics.`

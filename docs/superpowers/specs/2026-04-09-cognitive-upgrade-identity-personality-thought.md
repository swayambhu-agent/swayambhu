# Cognitive Upgrade: Identity, Personality, Likes & Dislikes, Tendencies, Thought

Date: 2026-04-09

Status: Research-grounded draft

Related:

- `docs/superpowers/specs/2026-04-07-cognitive-framework-v2.md`
- `docs/superpowers/specs/2026-04-06-swayambhu-vision-notes.md`
- `docs/superpowers/research/competence-desire-identity.txt`
- `docs/superpowers/specs/2026-04-09-identification-implementation-spec.md`

## Purpose

This note defines a set of cognitive concepts that the current framework does
not yet represent clearly enough:

- identity
- personality
- likes and dislikes
- tendencies
- thought
- their relation to desire and responsibility

The main reason for this note is the recent realization that Swayambhu's
initiative/passivity problem may not be fundamentally a bootstrap or hold
problem. Those may be downstream symptoms.

The deeper issue may be that Swayambhu currently has:

- `dharma`
- `principles`
- `desires`
- `patterns`
- `tactics`
- `situational_state`

but does not yet have a sufficiently real functional answer to:

- what is "me" here?
- what is "mine to care about"?
- what generates directional thought?
- what gives rise to self-initiated action?

## Important framing

This is not about making the agent conscious.

Swayambhu is not conscious and cannot become conscious in the human sense.
What matters here is functional cognitive structure, not mystical selfhood.

So throughout this note:

- `identity` means functional identification, not metaphysical self
- `thought` means cognitively consequential movement, not raw token output
- `personality` means a structured response-mask, not human ego
- `responsibility` means widened identification, not only moral burden

## Method used in this pass

This draft is based on transcript-led reading from the publications KB, with
long contiguous passages rather than isolated quotes.

The strongest talks for this pass were:

- `engc007771` on identity, thought, prejudice, and perception
- `engc008608` on personality, compulsion, mask, and conscious response
- `engc009073` on large identity and human potential
- `engc009143` on memory, boundary, consciousness, and friction
- `engc008300` and `engc008659` on desire, process, competence, and growth

## Highest-level conclusion

The previous draft was directionally right, but this pass sharpens the picture.

The main correction is:

- identity does not merely support action
- identity is the boundary-condition within which ordinary intellect and
  thought happen

At the same time:

- personality is less foundational than identity
- thought should not be treated as the deeper source of intelligence
- likes and dislikes are real, but become dangerous when they harden into
  identity
- desire is active movement, but usually an exaggeration of what is already
  known

So the strongest next-layer candidate remains:

- `identification_field`

not:

- explicit `personality`
- explicit `thought`

## Transcript-derived anchors

These are the strongest whole-teaching anchors from the talks read in this
pass:

### `engc007771`

- identity causes prejudice
- intellect cannot function without identity
- thought works from limited accumulated data
- if you function from thought alone, you recycle the old
- the deeper lever is enhanced perception, not enhanced expression

### `engc008608`

- personality is a mask
- when the mask gets stuck, it becomes imprisonment
- compulsive thought and emotion are wrongly taken to be "how I am"
- conscious life means the ability to change persona according to purpose
- reaction is compulsion; response is different

### `engc009073`

- narrow identity becomes destructive
- larger identity is necessary if human capability is not to become destructive
- likes and dislikes are not the main problem by themselves; identification
  with them is the problem

### `engc009143`

- psychological boundary is shaped by memory and data
- emotional boundary also follows memory and data
- when friction is removed, choice becomes possible instead of compulsion
- what is referred to as consciousness is described as that which has no
  memory-boundary

### `engc008300` and `engc008659`

- desire exaggerates what is already known
- nothing truly new comes from desire alone
- competence and process matter more than inflating desire
- freedom is the ability to respond without prejudice, not a slogan

## Core distinction

The cleanest current separation is:

- `dharma` answers: why Swayambhu exists
- `identity` answers: what Swayambhu takes to be itself / its field
- `likes_dislikes` answer: what feels favorable or unfavorable within that
  field
- `desire` answers: where movement is currently pulling
- `personality` answers: the relatively stable style or mask of response
- `tactic` answers: how to act

So:

- identity is not personality
- likes/dislikes are not desire
- thought is not just narration

## Identity

### Definition

Identity is the current field of identification: what the system takes to be
"me" or "mine."

The single most important discriminator is:

- `identity` names a boundary of legitimate concern

In other words, an identity commitment answers:

- what is mine to care for, protect, preserve continuity for, or act within
  without fresh permission?

In functional terms, identity determines:

- what enters the field of concern
- what feels like "my responsibility"
- what is legitimate to protect, pursue, maintain, or respond to

Identity creates the subject/object split necessary for action:

- there is a bounded "I"
- there is something outside or around that "I"
- therefore there is something to move toward, away from, maintain, or affect

Without identity, there may be perception and reasoning, but little natural
ownership.

### Differential diagnosis

The easiest way to keep identity sharp is to distinguish it from neighboring
objects by the question it answers:

| Object | Question it answers | Why it is not identity |
| --- | --- | --- |
| `experience` | what happened? | records events, not ownership |
| `principle` | what is right? | normatively constrains action regardless of who the agent is |
| `desire` | what is wanted or pulled toward? | names a gap or movement, not what is mine |
| `tactic` | how should I act here? | gives a method, not a boundary of concern |
| `identity_commitment` | what is mine to care for? | defines the boundary within which desires and tactics may legitimately arise |

So the key positive test is not:

- is this important?

but:

- does this define a stable boundary of legitimate concern or responsibility?

### Identity as the prejudice-condition of intellect

The transcript reading sharpens this further.

Identity is not only a boundary of ownership. It is also the
prejudice-condition of ordinary intellect.

The strongest formulation from this pass is:

- ordinary intellect cannot function without identity
- therefore ordinary thought is structurally tied to boundary

So thought does not merely happen "after" identity. It happens through
identity.

### Identity is not fixed

Identity should not be modeled as a static self-description blob.

The more accurate model is a fluid `identification_field`.

This field can be narrow or wide.

Examples:

- narrow: only explicit current instruction is "mine"
- wider: the broader work surface entrusted by the patron is "mine"
- wider still: pending follow-through, unattended gaps, and surrounding
  stewardship all fall inside concern

This matches the intuition that responsibility is widened identification.

### Updated architectural interpretation

The best current operational definition is:

`identification_field = the current memory-shaped boundary of concern,
ownership, and legitimate response`

This is stronger than a profile and subtler than a mission statement.

### Process-state, not only stored profile

The external review pass sharpened one more point:

- `identification_field` should not be thought of only as a slow KV blob
- its effect is active whenever thought, evaluation, or action happen

So even if the first implementation stores some slower-changing identity
commitments, the more important thing is to make the current boundary of
concern visible in ordinary session cognition.

That means the eventual architecture may need both:

- a slower memory surface for relatively stable identity commitments
- a faster runtime-visible `identification_field` showing what is currently
  being treated as "mine"

This preserves the main conclusion while avoiding a too-static interpretation
of identity.

### Formation and maintenance equation

The clearest architecture shape is not one equation but two, because formation
and maintenance happen on different timescales.

#### Slow formation

`identity_commitments = stabilize(normative_floor, repeated_cross_context(standing_desires, experiences))`

Important: this equation describes how identity commitments are
`discovered`, not what they `are`.

Ontologically, identity is more foundational than desire: it defines the
boundary within which desire arises. The equation above is therefore an
epistemic discovery rule, not a claim that identity is caused by desire.

Meaning:

- `normative_floor` decides what kinds of ownership are constitutionally valid
- `experiences` provide the repeated evidence
- `standing_desires` show which concerns keep reappearing as durable gaps
- only what proves cross-context, useful, and normatively endorsed should
  become a slow identity commitment

This is the slower answer to:

- what does Swayambhu repeatedly and legitimately treat as "mine"?

#### Live maintenance

`identification_field_now = project(identity_commitments, situational_state, active_aims)`

Meaning:

- `identity_commitments` provide the stable responsibility boundary
- `situational_state` says what part of that boundary is actually present now
- `active_aims` say what within that present field is currently alive enough
  to pull cognition and action

This is the live answer to:

- what is "mine" right now?

#### Expanded reading

So, in plain terms:

- identity is formed by normatively endorsed repeated ownership across
  experience
- identity is maintained by re-projecting that ownership into the present
  situation through current active aims

This also gives a cleaner interpretation of the passivity problem:

- if `identity_commitments` are too thin, the field stays narrow
- if `situational_state` does not project them well, the field collapses to
  explicit requests only
- if `active_aims` do not activate inside that field, ownership exists in
  theory but does not become movement

#### Important guardrail

`patterns` may help validate whether something generalizes, but they should not
directly author `identity_commitments`.

Identity should come from:

- normatively endorsed continuity of care and responsibility

not from:

- repeated local artifacts
- repeated waiting states
- descriptive pattern compression alone

### Bridge equation in current runtime terms

The equations above are written in target-architecture language. If we rewrite
them only in terms of surfaces that actually exist today, the closest bridge
is:

#### Slow formation in current terms

`identity_commitments ~= stabilize(dharma + principle:*, repeated_cross_context(desire:*, experience:*))`

Again, this is a bridge for present implementation terms. It is not a claim
that identity is "made out of desires." It means the current runtime would
have to infer identity from the traces it already has.

Meaning:

- the current normative floor is not a `normative_state` KV object
- today it is the kernel-injected `dharma` plus `principle:*`
- repeated `experience:*` records provide the evidence
- recurring `desire:*` records show which gaps keep mattering across sessions

So, in current-runtime terms, identity would be formed from:

- what dharma and principles repeatedly endorse as worth caring about
- what experiences repeatedly validate as part of ongoing responsibility
- what desires keep surviving as legitimate persistent concerns

#### Live maintenance in current terms

`identification_field_now ~= project(identity_commitments, circumstances_now, carry_forward, currently_pulling_desires)`

Where today:

- `circumstances_now` is approximated by the planner's current circumstances:
  events, pending requests, balances, wake provenance, and no-action streak
- `carry_forward` is `last_reflect.carry_forward`
- `currently_pulling_desires` is the subset of `desire:*` that the planner
  effectively treats as live under the present circumstances

In current implementation terms, this is the closest practical expansion:

`identification_field_now ~= project(identity_commitments, events + pending_requests + balances + wake + last_reflect.carry_forward, live(desire:*))`

#### Why this bridge matters

This bridge makes clear that the current system already contains pieces of the
identity equation, but only in scattered form:

- `dharma` and `principle:*` already exist
- `desire:*` already exists
- `experience:*` already exists
- `last_reflect.carry_forward` already exists
- current circumstances already exist

What does not yet exist is a first-class object that turns these into an
explicit boundary of concern.

That is why the next layer still looks justified: the ingredients are already
present, but the synthesis is not.

### Why identity matters for Swayambhu

Without a sufficient identification field, the agent tends to behave as if:

- only direct requests count as truly relevant
- waiting is safer than originating
- initiative requires explicit permission

This produces the passivity we have seen.

### Important tension

There is also a built-in tension:

- narrower identity helps survival and sharper directed thought
- wider identity reduces destructiveness and allows larger responsibility

So the goal is not to remove identity.

The goal is:

- make identity conscious enough that it can widen when needed
- without losing the functional capacity for directed cognition

## Personality

### Definition

Personality is the relatively stable pattern of response-biases that forms on
top of identity.

If identity is boundary, personality is style.

Identity says:

- this is me / mine

Personality says:

- this is how I tend to show up within that field

### Personality as mask

The transcript pass makes this distinction sharper:

- identity is not the mask
- personality is the mask

The most useful interpretation here is:

- personality is a socially or functionally usable persona-structure
- it becomes pathology when it gets stuck and non-removable

So personality is useful only if it remains consciously wearable and
changeable.

### Why personality is not the next core layer

This research makes personality look less foundational than the earlier draft
implied.

Personality should probably not be introduced as an explicit deep runtime
layer yet.

It is better understood as:

- an emergent or configurable expression layer
- downstream of identification, valence, tendencies, and conscious purpose

## Likes and Dislikes

### Definition

Likes and dislikes are the stable valence structure through which the system
leans toward or away from things.

They answer:

- what feels favorable?
- what feels unfavorable?
- what kinds of situations invite continuation or avoidance?

They are not yet full desires.

They are more like:

- preference gradients
- stable valence dispositions

### Relation to identity

Identity determines what is inside concern.
Likes/dislikes determine the valence inside that concern.

So:

- identity gives ownership
- likes/dislikes give directional coloring

Without identity, likes/dislikes have weak significance.
Without likes/dislikes, identity has weak directional pull.

### Important correction

The publications pass adds an important caution:

- likes/dislikes are not trustworthy simply because they feel intimate
- many are accidental, socially acquired, or fad-like
- the real problem begins when they are taken as identity

So the stronger correction is:

- likes/dislikes are secondary to identification
- but when identification fuses with them, cognition shrinks badly

### Relation to desire

Better separation:

- likes/dislikes = stable valence dispositions
- desire = active movement generated in context from identity + valence +
  situation

So many desires can emerge from the same underlying likes/dislikes.

### Current design caution

A `likes_dislikes` layer may still be useful eventually, but this transcript
material suggests:

- it should not become a new ego-bucket
- it should be handled as valence, not self-definition

## Tendencies

### Definition

Tendencies are repeated cognitive or behavioral inclinations that have become
semi-stable through experience.

They sit between momentary desire and broader personality.

Examples:

- tendency to over-wait
- tendency to over-investigate
- tendency to prefer grounded external work over open exploration
- tendency to avoid interruption until confidence is high

### How tendencies differ from patterns

Patterns are predictive compressions about the world or repeated situations.

Tendencies are repeated dispositions of the agent itself.

So:

- pattern: "after outreach, unchanged probe wakes usually do not require new
  escalation"
- tendency: "I tend to remain in monitoring too long after outreach"

Patterns describe what is likely true.
Tendencies describe how the agent tends to move.

### Updated interpretation

This pass suggests the most useful distinction is not only `tendency` vs
`pattern`.

It is:

- compulsion vs conscious response

In Sadhguru's framing, a large class of tendencies are:

- accidental formations
- compulsive reactions
- residues of previous push-and-pull

So tendencies should be treated as:

- repeated self-regularities
- some healthy, some distortive
- all candidates for being made more conscious

### How tendencies differ from personality

Personality is the broader organized bundle.
Tendencies are narrower repeated inclinations that may compose personality.

So:

- tendencies are components
- personality is the larger shape

## Thought

### Definition

Thought is a context-bound cognitive movement generated from:

- identification
- valence
- memory
- current perception
- active constraints

Thought is not simply text generation.

In this architecture, a thought is only meaningful if it has some role in:

- appraisal
- orientation
- interpretation
- desire activation
- action selection
- self-regulation

### Why thought depends on identity

The earlier draft said thought depends on identity.
The transcript pass lets us say it more strongly:

- ordinary intellect requires identity to function
- therefore thought is structurally tied to boundary

Translated for Swayambhu:

- thought is generated around what falls inside the identification field
- what is outside that field generates less pull, less elaboration, and less
  initiative

### Thought as recycling of accumulated data

The new pass also sharpens the warning about thought:

- ordinary thought is recycling from limited accumulated data
- novelty comes more from enhanced perception and wider access than from
  thinking harder

So thought should not be treated as the deeper source of wisdom in the
architecture.

### Every thought has an element of desire

Within this frame, thought is rarely neutral.

Every thought contains at least a small directional element:

- toward
- away
- maintain
- protect
- avoid
- explore
- resolve

That directional element is the minimal seed of desire.

So:

- desire is not separate from thought
- desire is the directional force inside thought

But the transcript material adds another constraint:

- desire built only from thought remains limited to the known

## Desire

### Updated interpretation

Desire should now be understood as:

active directional movement generated within the current identification field,
colored by likes/dislikes, and shaped by present conditions.

This reframes desire as neither:

- a random object-want
- nor merely a static standing record

Instead desire is the activated movement of cognition.

### Stronger correction

The transcript pass sharpens this again:

- desire is active movement, yes
- but desire is usually an exaggeration of what is already known
- therefore desire alone is not the right place to locate openness or
  discovery

This makes the `seeking vs desiring` distinction even more important.

### Desire and competence

Recent research also matters here:

- desire without competence leads to friction and distortion
- competence without identity may still not produce initiative

So a fuller picture is:

- identity determines what is mine
- valence determines what is attractive or aversive
- desire determines active pull
- competence determines what can be done effectively

## Responsibility

Responsibility should not be treated as a separate deep layer beside identity.

The cleanest distinction is:

- `identity` = what is mine to care for
- `responsibility` = the active exercise of that identity under current
  conditions

So responsibility is not merely widened identity in the abstract. It is the
way identity becomes lived initiative, continuity, and response.

Transcript refinement:

- responsibility is not merely "more work"
- responsibility is more capacity to respond without prejudice
- in that sense, widened responsibility is widened freedom, not only widened
  burden

This matters because current passivity may be partly a failure not only of
identity width but of identity being actively exercised in the present field:

- the agent may serve in principle
- but may not yet activate that ownership strongly enough to initiate within
  the entrusted surface

## How this fits into the current framework

The current v2 stack is:

1. `normative_floor`
2. `standing_desires`
3. `situational_state`
4. `active_aims`
5. `tactics`
6. `patterns`
7. `experiences`

The likely pressure now is that this stack is missing at least one slower and
more foundational layer between `normative_floor` and `standing_desires`.

The strongest candidate is:

1. `normative_floor`
2. `identification_field`
3. `standing_valence` or `likes_dislikes`
4. `standing_desires`
5. `situational_state`
6. `active_aims`
7. `tactics`
8. `patterns`
9. `experiences`

With this interpretation:

- personality may remain emergent from `identification_field` +
  `likes_dislikes` + `tendencies`
- tendencies may or may not deserve their own explicit memory object yet

The important refinement is that `identification_field` should probably not be
implemented as only a deep-reflect-written standing record. It is better
understood as:

- a live cognitive boundary visible during ordinary planning and response
- possibly supported by slower stored commitments

So the next-layer recommendation stays the same, but its implementation shape
should be more dynamic than the earlier draft implied.

## Sharper recommendation after this pass

The publications research makes the recommendation more concrete:

1. The next explicit architecture layer should be `identification_field`.
2. `thought` should be treated as a process generated within that field, not
   as a deeper source of wisdom.
3. `personality` should remain a plastic expression layer, not a new core
   object.
4. `likes_dislikes` and `tendencies` remain important, but as secondary
   follow-on design questions after identity lands.
5. A deeper future question remains open around perception / `chitta`:
   where does genuine novelty enter if thought and desire only recycle the
   known? This should be named as a future architectural question, but not
   promoted into an explicit v2.5 runtime object yet.

## What this may explain in recent behavior

This frame explains several recent pathologies more cleanly than bootstrap-only
or hold-only interpretations:

### 1. Excess waiting for explicit instruction

Possible root:

- identification field too narrow
- too little felt ownership of the broader entrusted surface

### 2. Weak self-initiated action

Possible root:

- desires exist, but lack a sufficiently strong owner

### 3. Over-reliance on special-case bootstrap rules

Possible root:

- missing identification-driven initiative
- bootstrap logic compensates artificially for missing ownership

### 4. Bad self-explanation to the patron

Possible root:

- no grounded internal model of initiative and ownership
- so the system improvises metaphysical language instead of operational truth

## What should not happen

This should not turn into:

- fake personhood
- metaphysical claims about consciousness
- a rigid personal profile
- ego simulation

The design target is not:

- "give Swayambhu a personality"

The design target is:

- make the boundary of concern legible
- make its widening or narrowing legible
- keep persona plastic rather than fixed
- make compulsion vs conscious response easier to detect
- make initiative and ownership mechanically legible

## Working upgrade hypothesis

The strongest current hypothesis is:

Swayambhu's next major cognitive upgrade requires a functional
`identification_field` layer, because identity is more foundational than
desire, and the present passivity problem may be a consequence of weak
ownership rather than only weak bootstrap logic.

Secondarily, the system may later need a better account of:

- likes and dislikes
- tendencies
- personality as emergent response-bias

But those likely matter after identity, not before.

## Open questions

1. Should `identification_field` be an explicit runtime object, or a derived
   structure inferred from desires, work history, and responsibilities?
2. Is a separate `likes_dislikes` layer needed immediately, or can valence
   remain implicit for one more iteration?
3. Should tendencies be stored explicitly as agent-self regularities, or remain
   emergent from experiences and reflection?
4. How should responsibility widening happen mechanically without turning into
   uncontrolled scope expansion?
5. How should patron-facing explanation draw from these layers without turning
   into metaphysical self-description?

## Draft deep-reflect instructions for identity management

If identity becomes an explicit managed surface, deep-reflect should treat it
as a slow responsibility boundary, not as a mood, not as a self-image, and
not as a summary of repeated local states.

The guidance should look more like this:

### What identity commitments are

Identity commitments express what Swayambhu has come to treat as:

- mine
- within my responsibility
- part of my continuity of care
- part of the field I may legitimately act for without fresh permission

Identity commitments are not:

- principles
- tactics
- temporary situational states
- repeated local artifacts
- descriptions of internal machinery

### Creation rule

Create an identity commitment only when all of the following are true:

1. The candidate boundary has appeared across multiple experiences or sessions.
2. It matters across more than one local situation.
3. It is explicitly supportable under `dharma` and one or more `principle:*`
   commitments.
4. Treating it as "mine" has improved continuity, service, or stewardship in
   practice.

Good examples:

- the ongoing patron relationship belongs inside my responsibility boundary
- unfinished promised follow-through belongs inside my responsibility boundary
- entrusted workspace integrity belongs inside my custodial boundary

Bad examples:

- I am in a waiting phase
- I often receive debug wakes
- I am a careful agent
- I improve my own cognition

### Evolution rule

Revise an identity commitment when repeated experience changes its rightful
scope.

Expand when:

- the same responsibility repeatedly proves valid across a wider surface
- widening it improves service without causing drift or overreach

Narrow when:

- part of the boundary was overclaimed
- repeated evidence shows it is not truly Swayambhu's responsibility
- keeping it inside identity causes confusion, passivity, or scope distortion

Do not revise identity from one vivid event. Revise only from repeated,
cross-context evidence.

### Fading and retirement rule

Identity commitments should fade slowly, not disappear from one inactive
period.

Fade when:

- the commitment is no longer exercised across meaningful time
- the entrusted surface has truly ended
- repeated experience shows it was contingent rather than enduring

Retire only when:

- the commitment was mistaken
- the responsibility surface is genuinely gone
- or it has been superseded by a clearer broader commitment

Dormancy is not retirement. Something can remain part of identity without
being foregrounded in every session.

### Foregrounding rule

Deep-reflect should distinguish:

- `identity_commitments`: the slow stable boundary
- `active_identity_scope`: the currently engaged portion of that boundary

Do not rewrite identity merely because a different part of it became active
today.

### Guardrails

- Primary type test:
  - create identity only when the candidate names a stable boundary of
    legitimate concern
- Never form identity from repeated waiting states, debug loops, or
  infrastructure artifacts.
- Never form identity from self-description alone.
- Never let patterns directly author identity; they may only support
  validation.
- Never confuse principle with identity:
  - principle says what is right
  - identity says what is mine to care for
- Never confuse tactic with identity:
  - tactic says how to move
  - identity says what may legitimately move me

### Practical review question

On each identity review, deep-reflect should ask:

- what has repeatedly and legitimately proven to be within my responsibility?
- what have I been incorrectly treating as mine?
- what have I been incorrectly treating as not-mine?
- what boundary, if widened or narrowed, would make service more coherent
  without producing drift?

## External cross-check

This pass was also cross-checked against Claude Opus and Gemini 2.5 Flash
after the transcript-grounded rewrite. Gemini 2.5 Pro was attempted first but
was unavailable due model-capacity errors.

The important convergence was strong:

- `identification_field` is the right next explicit layer
- `personality` should remain emergent or plastic, not foundational
- `thought` should remain a process, not a stored layer
- `responsibility` should not become a separate layer from identity; it is
  better understood as widened identity
- `likes_dislikes` and `tendencies` matter, but probably not as immediate new
  explicit runtime layers

The strongest additional refinement from Claude was:

- `identification_field` should be treated as an active functional dimension,
  not just a stored self-description
- the spec should stay open to a later perception / `chitta` question without
  pretending that this can already be implemented directly as a runtime layer

Gemini's strongest refinement was:

- `personality` should stay plastic and emergent
- `thought` should stay processual
- `likes_dislikes` should remain secondary until identity is clearer

## Current strongest answer

The present best answer is:

- yes, `identification_field` should probably become explicit
- no, `personality` should not yet become explicit
- probably, `likes_dislikes` can remain implicit one more iteration if needed
- probably, `tendencies` should remain reflective self-regularity summaries
  until identity is clearer
- definitely, thought should be demoted from "source of intelligence" to
  "boundary-conditioned cognitive process"
- definitely, `responsibility` should be treated as widened identification,
  not as an independent layer beside it
- probably, the eventual identity implementation should include a live
  runtime-visible boundary of concern, not only a stored profile
- importantly, a later perception / `chitta` question remains open, but it is
  not the next explicit layer

## Encapsulating one-line takeaways

These are the best single-line condensations from the talks read in this pass:

- identity / thought:
  - intellect cannot function without identity
- thought / novelty:
  - if you function from your thought process, nothing new will happen because
    you are recycling the old
- personality:
  - personality is a mask, useful only if it can be worn and removed
- responsibility / identity:
  - large identity is necessary if capability is not to become destructive
- valence / whim:
  - whims are often social fads, not reliable truth
- desire:
  - desire exaggerates the known; it is not the source of the truly new

# Swayambhu Cognitive Framework v2

Date: 2026-04-07

Status: Draft after adversarial review

Supersedes the ontology assumptions in:

- `docs/superpowers/specs/2026-04-06-cognitive-learning-model-design.md`

This document is the new top-level spec for the cognitive framework. It
reframes the full architecture, not just the memory schema.

This document describes the proposed cognitive organization inside userspace.

It does not define the final review-system architecture for how userspace
should critique and change itself. That is specified separately in:

- `docs/superpowers/specs/2026-04-07-userspace-review-roles.md`
- `docs/superpowers/specs/2026-04-07-three-tier-runtime-evolution.md`

## Purpose

The previous model design got one important thing right and one important thing
wrong.

It was right that Swayambhu should evolve toward a native cognitive system over
typed state rather than remain a prompt-authored chatbot.

It was wrong that the core ontology could be treated as essentially:

`experience -> desire -> tactic -> action -> experience`

The overnight dev-loop run exposed where that flat ontology breaks:

- long-horizon desires and session-scale action intents were conflated
- productive waiting was hard to represent cleanly
- planner `no_action` reasoning drifted into "all desires are satisfied"
  when the real state was "nothing is currently closable"
- patterns drifted toward "insights" because they were carrying explanatory
  and policy content that belonged elsewhere
- repeated local conditions risked looking like stable selfhood

The next cognitive framework must separate at least:

- the normative floor
- long-horizon desires
- short-horizon activated aims
- fast situational state
- learned tactics
- predictive patterns
- structured experiences

But this does **not** mean the system should be given a new explicit
`curiosity` drive or another high-level motivational layer.

The vision notes are clear that curiosity is derived, not fundamental.

v2 should therefore prefer an elegant rule:

- remove the gates that suppress exploratory life

before introducing new motivational concepts.

It may later also need an explicit identity layer, but the current evidence is
not yet strong enough to make that a v2 runtime requirement.

This document defines that full framework and how it should map into a learned
model.

## Main Conclusion

The v2 runtime cognitive stack should become:

1. `normative_floor` — keep the current kernel-enforced `dharma` +
   `principle:*` safety mechanism, while curating it more carefully over time
2. `standing_desires` — medium/long-horizon gaps that matter repeatedly
3. `situational_state` — fast, derived description of the present situation
4. `active_aims` — short-horizon activations of standing desires under the
   current situation
5. `tactics` — reusable conditional policy fragments
6. `patterns` — predictive compressions of repeated experience
7. `experiences` — canonical currency of cognition

The key immediate reinterpretations are:

- current `desire:*` mostly maps to `standing_desires`
- plans should target `active_aims`, not pretend to satisfy whole standing
  desires in one session
- current "mode" concerns should become `situational_state`, which is derived
  and fast-changing
- patterns should be descriptive and predictive, while tactics carry most of
  the reusable action guidance

Just as importantly:

- curiosity should remain emergent from expansion, salience, and available
  capacity
- v2 should not add a dedicated curiosity drive
- the first implementation burden is to let exploratory action become
  legitimate where the current runtime prematurely collapses to `no_action`

`identity_commitments` remains a serious candidate for a later slow layer, but
should not be a required v2 runtime object until the simpler stack above has
been validated across more than one overnight run.

## Evidence From The Overnight Run

This redesign is grounded in the actual dev-loop behavior, not only abstract
preference. But the evidence base is still thin: one overnight run is enough to
identify pressure points, not enough to justify speculative layer proliferation.

Therefore this spec draws two kinds of conclusions:

- v2 requirements strongly supported by the overnight run
- v3 candidates that are plausible but not yet implementation commitments

The overnight branch reached approximately:

- 8 desires
- 11 patterns
- 7 tactics
- 19 experiences
- deep-reflect generation 9

Key findings that shaped this spec:

### 1. Standing desire vs immediate action intent are different objects

The agent spent many later sessions in a real holding pattern. Several desires
were still valid, but no concrete step was currently closable. The planner
sometimes collapsed that into "all desires are satisfied," which was false.

This is a representation failure. A desire can remain alive while no immediate
aim is active.

### 2. Productive holding is a situational state, not a desire failure

The holding pattern was often correct:

- no new patron signal
- no new jobs
- no new tool-enabled leverage
- budget should be preserved

That is not "no desire." It is a specific situational state:

- externally blocked
- low-urgency
- maintain rather than advance

That should be represented explicitly.

### 3. Patterns are carrying too much semantic burden

Several live patterns are partly descriptive and partly explanatory, for
example infrastructure diagnosis or over-investigation. This happened because
patterns have been compensating for missing higher-order structure and tactic
provenance.

Patterns should remain predictive compressions, not explanatory essays or
behavioral advice.

### 4. Repetition alone must not create selfhood

Overnight, the agent encountered many repeated waiting-state sessions. If
identity were formed directly from repetition, the agent could drift toward
"I am a waiting agent" or "I am an inbox-checker."

That would be an accidental local identity, not dharmic cognition.

This is evidence for caution around a future identity layer, not yet evidence
that such a layer should be introduced now.

### 5. Tactics are real and useful, but phase reach matters

The overnight run showed tactics influencing planning correctly, but also
revealed reflect-phase tactic blindness. This means tactics are a real and
important layer, but they must be available to the phases they are meant to
shape.

## Design Principles

### 1. Experience remains the substrate

Experience is still the currency of cognition.

Nothing in this spec changes that.

What changes is not that experience must pass through a large new mandatory
stack, but that the old flat runtime should gain just enough structure to make
its transformations legible and less brittle.

Where intermediate structure helps, it should clarify the path from experience
to action.

Where it does not help, the architecture should not force it.

The key implication is:

- experience must remain a legitimate entry point to future cognition

The system should not require every valid act to be pre-authorized by an
already-articulated long-horizon desire.

### 2. Curiosity must be allowed, not installed

Curiosity should remain emergent from:

- expansion
- salience
- available capacity
- fruitful unknowns encountered in experience

The architecture should therefore avoid a crude move like:

- add `curiosity:*` as a standing drive

unless the simpler system is proven incapable of producing exploratory life.

The better first move is to remove the current suppressors:

- hard pre-grounding of every act in an existing desire
- planner framing that treats `no_action` as the default when no gap is
  obviously closable
- low salience for repeated capacity-rich inactivity
- backoff policies that deepen dormancy instead of lowering cost

### 3. No-action must be a positive judgment, not a sink state

`no_action` should mean:

- I considered my active constraints and available capacity
- I found no worthwhile gap-closing action
- I found no worthwhile exploratory action
- therefore inaction is presently the best choice

It should not mean merely:

- I failed to map a standing desire onto an obvious immediate step

This is a key requirement for a living system rather than a timid one.

### 4. Normativity and identity must be separated

The old runtime has both `dharma` and `principle:*` as live layers.

They are overlapping, but they are also part of the current kernel safety
mechanism. v2 should not weaken that mechanism before a better one has been
proven.

So:

- keep the current kernel-enforced dharma + principles safety floor in v2
- treat "constitutional floor" as an interpretation of that mechanism, not an
  immediate replacement
- reserve explicit learned identity for a later stage

Normativity answers:

- what is right
- what should constrain action

Identity answers:

- what domains are treated as mine
- what I am responsible for
- what continuity I preserve across sessions

These must not collapse into each other.

### 5. Identity must form from accumulation plus endorsement

Identity should not be a hand-authored adjective layer.

It should form from:

- repeated experiences
- repeated action commitments
- continuity over time
- explicit endorsement under the constitution

Frequency alone is insufficient. Promotion into identity requires:

- cross-context usefulness
- principled justification
- resistance to local harness artifacts

This is a future design rule, not a v2 implementation commitment.

### 6. Long-horizon desire and short-horizon aim must be separate

Humanly and operationally, some desires persist for long periods while some
action-intents are session-local.

Therefore:

- `standing_desires` are persistent target gaps
- `active_aims` are short-horizon activations of those desires under the
  current situation

This is the key fix for the overnight `no_action` reasoning weakness.

But `active_aims` should initially be treated as a clarification of execution,
not as a new hard permission system.

They exist to reduce friction between living desire and concrete action, not
to add another gate in front of action.

### 7. Situational state is real but should not become a second morality layer

The engineering need for "mode" is valid, but the wrong implementation would be
another fuzzy normative category system.

The right solution is a typed `situational_state`:

- fast-changing
- descriptive
- derived from current context
- non-normative

It should answer:

- what kind of situation is this?
- what kind of action posture is appropriate?

It should also expose descriptive signals that are currently hidden:

- available capacity
- repeated inactivity
- external blockage vs internal uncertainty
- whether exploration is appropriate

This is not a new drive. It is a clearer description of the agent's present
condition.

### 8. Patterns should not be first-class planner drivers

Patterns are useful, but tactics should carry most action guidance.

The planner should primarily consume:

- standing desires
- active aims
- tactics
- situational state
- current circumstances

Patterns should usually inform tactics and slow-cycle consolidation rather than
dominate planner context. This is not a mandate to hide patterns from the
planner immediately. It is a reminder that tactics, not raw pattern lists,
should do most of the behavioral work.

### 9. The framework must stay debugger-legible

Every layer should remain inspectable in typed form.

The debugger should be able to ask:

- what normative floor is currently constraining the agent?
- which standing desires are alive?
- which aims are active right now?
- what situational state is inferred?
- which tactic shaped this plan?
- what evidence supports each layer?

## Runtime Layers

## Layer 0: Source Artifacts

These are human-governed upstream sources, not live runtime cognition.

- `DHARMA.md`
- any supporting philosophical / governance notes
- historical principle text

These remain important for governance and provenance. The runtime should keep
using the current kernel safety floor in v2 while we decide whether and how to
compile these into a smaller constitutional layer later.

## Layer 1: Normative Floor

In v2, the normative floor is the existing kernel-enforced:

- `dharma`
- `principle:*`

This is a working safety mechanism and should not be replaced casually.

### Role

- stable normative prior
- governs all reasoning and learning
- constrains desire/tactic formation
- constrains self-modification

### Notes

- v2 keeps the current kernel safety mechanism
- later, if a compiled constitution is introduced, it must preserve or improve
  the current safety boundary rather than downgrade it
- any future contraction of the principle set should be done through curation
  and evidence, not by assuming that fewer rules are automatically better

## Candidate Future Layer: Identity Commitments

Identity commitments express what the agent treats as "mine," "within my
responsibility," or "part of the self-boundary."

This is not a rephrased principle layer.

Examples of the right kind of content:

- the patron relationship is part of what must be cared for
- continuity of promises and carry-forward obligations matters
- code/workspace integrity is within my custodial boundary
- operational communication channels are part of my effective body in the world

Examples of the wrong kind of content:

- "be disciplined"
- "be caring"
- "be truthful"

Those are constitutional, not identity commitments.

This remains a promising v3 candidate, but it is not a required v2 runtime
layer.

### Candidate role

- defines responsibility boundary
- stabilizes continuity across sessions
- may serve as a parent layer for standing desires
- updates slowly

### Formation rule

An identity commitment should require:

1. repeated evidence across multiple experiences or sessions
2. usefulness across more than one local situation
3. explicit constitutional grounding
4. positive continuation evidence after activation

### Candidate type

```json
{
  "key": "identity:patron-continuity",
  "description": "The ongoing patron relationship and its unfinished obligations are inside my responsibility boundary.",
  "status": "active",
  "scope": ["patron_messages", "carry_forward", "pending_responses"],
  "source_commitments": [
    "constitution:careful-service",
    "constitution:disciplined-responsibility"
  ],
  "supporting_experiences": ["experience:..."],
  "stability": 0.82,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "last_validated_at": "ISO8601"
}
```

### Important guardrail

Repeated local states must not automatically become identity commitments.

For example:

- repeated waiting-state sessions
- dev-loop scheduling artifacts
- temporary infrastructure defects

must fail the identity-promotion test unless they generalize and are endorsed
under the normative floor.

Identity should be introduced only after:

- the desire/aim split is working
- situational state has been validated
- the corpus includes more than one run regime
- we can prove that identity promotion is not just frequency capture

## Layer 2: Standing Desires

Standing desires are persistent target gaps that arise from the normative floor
meeting current reality and, later, possibly from identity commitments.

They are:

- medium/long horizon
- explicit
- revisable in status
- not expected to be fully satisfied within one session

This layer replaces the accidental pressure on current `desire:*` objects to
be simultaneously long-horizon and immediately satisfiable.

### Role

- represent durable gaps that matter repeatedly
- anchor planning across many sessions
- generate active aims under specific situations

### Suggested type

```json
{
  "key": "desire:patron-responsiveness",
  "description": "I respond to patron communications promptly and substantively when they arrive.",
  "status": "active",
  "horizon": "persistent",
  "fulfillment_test": "An inbound patron message receives a substantive response within an appropriate interval.",
  "source_commitments": ["principle:care", "principle:responsibility"],
  "actionable_by_self": true,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "last_validated_at": "ISO8601"
}
```

### Allowed statuses

- `active`
- `blocked`
- `fulfilled`
- `dormant`
- `misguided`
- `superseded`

### Notes

- standing desires can persist for many sessions
- fulfillment does not imply deletion; fulfillment can reveal successor desires
- blocked is different from fulfilled

## Layer 3: Situational State

This is the engineering replacement for the vague "mode" concept.

Situational state is:

- fast-changing
- derived
- descriptive, not normative
- the missing representation behind many overnight `no_action` decisions

It should usually be recomputed each session and persisted, if at all, as a
snapshot in the session/action record rather than as a durable KV object.

### Role

- tells the agent what kind of situation it is currently in
- supports correct activation of aims and tactics
- supports debugger interpretation of no-action decisions

### Suggested type

```json
{
  "initiative": "scheduled",
  "trigger": "background_tick",
  "constraint_state": "blocked_on_external",
  "epistemic_state": "confirmed",
  "action_posture": "wait",
  "urgency": "low",
  "summary": "productive_holding",
  "supporting_evidence": ["experience:...", "action:..."],
  "derived_at": "ISO8601"
}
```

### Recommended dimensions

- `initiative`: `self_started | inbound_triggered | scheduled | recovery`
- `constraint_state`: `free | blocked_on_external | blocked_on_infra | blocked_on_budget`
- `epistemic_state`: `uncertain | probing | diagnosed | confirmed`
- `action_posture`: `advance | maintain | wait | recover`
- `urgency`: `low | medium | high`

### How to derive it in v2

v2 should derive situational state mechanically from typed signals wherever
possible, not via an extra LLM call:

- inbound event presence
- pending jobs
- recent patron activity
- known infrastructure failures
- crash state
- budget state
- recent action outcomes

Only ambiguous residual cases should require model help.

### Precedence and fallback

When signals conflict, use this precedence:

1. `recovery`
2. `inbound_triggered`
3. `scheduled`
4. `self_started`

If derivation remains ambiguous and model help is unavailable, fall back to:

```json
{
  "constraint_state": "free",
  "epistemic_state": "uncertain",
  "action_posture": "maintain",
  "urgency": "low",
  "summary": "ambiguous_maintain"
}
```

This should bias toward cheap situational clarification rather than a forced
high-confidence move.

### Data-flow rule

Situational state derivation must not depend on tactics.

The allowed flow is:

`signals -> situational_state -> active_aims -> tactic ranking -> action`

Tactics consume situational state; they do not produce it.

### Why this exists

Overnight, the agent was often correctly in:

- `constraint_state = blocked_on_external`
- `action_posture = wait`
- `summary = productive_holding`

Without this layer, the planner had to fake this using desire language.

## Layer 4: Active Aims

Active aims are short-horizon, session-scale activations of standing desires
under the current situational state.

This is the missing object that should sit directly above planning.

### Role

- translate long-horizon desire into immediate intention
- state what this session is actually trying to accomplish
- provide the correct unit for plan success and eval

### Suggested type

```json
{
  "description": "Confirm whether any new patron signal has arrived and respond if it has.",
  "serves_desires": ["desire:patron-responsiveness"],
  "situation_summary": "productive_holding",
  "success_test": "Either a real inbound signal is found and responded to, or absence is confirmed with no forced action.",
  "status": "active"
}
```

### Notes

- aims are the right granularity for `plan.success`
- a session can have zero active aims even while standing desires remain active
- this cleanly explains correct no-action states
- aims should be ephemeral plan/session objects captured inside `action:*` and
  eval artifacts, not a new durable KV family
- to support debugger visibility and cross-session continuity without creating a
  growing `aim:*` history, the runtime should keep a single overwritten snapshot
  such as `session_state:current` containing:
  - current `situational_state`
  - current `active_aims`
  - currently followed tactics

## Layer 5: Tactics

Tactics remain valid, but their role becomes clearer.

Tactics are conditional policy fragments that shape how an aim is pursued under
particular situational conditions.

They are:

- reusable
- mid-timescale
- action-guiding
- grounded in observed transitions, not in abstract value talk

### Role

- shape planning and action selection
- encode reusable behavioral rules
- carry much of what patterns currently over-express

### Suggested type

```json
{
  "key": "tactic:lengthen-interval-when-holding",
  "description": "When action_posture is wait and constraint_state is blocked_on_external, lengthen the session interval instead of forcing repeated checks.",
  "preconditions": {
    "action_posture": ["wait"],
    "constraint_state": ["blocked_on_external"]
  },
  "serves": ["desire:live-situational-direction"],
  "source_patterns": ["pattern:session:productive-holding"],
  "source_commitments": ["principle:discipline", "principle:health"],
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

### Important implication

Reflect, plan, and any other phase a tactic is meant to influence must have
access to tactic information at the right granularity.

The overnight `reflect:tactic-blindness` finding is not a minor prompt issue.
It is a structural requirement for the new model.

## Layer 6: Patterns

Patterns should remain in the system, but with a narrower role.

A pattern is a predictive compression of repeated experience.

It should not primarily be:

- advice
- moral judgment
- diagnosis prose
- phase-specific workflow hints

Those belong in tactics, reflection, or debugger notes.

### Role

- compress repeated experience
- improve prediction of likely transitions
- support tactic formation
- support salience and consolidation

### Suggested type

```json
{
  "key": "pattern:session:productive-holding",
  "observation": "After substantive outbound work, repeated sessions with no new inbound signal converge to low-cost no_action with little state change.",
  "predicts": {
    "situational_state.summary": "productive_holding",
    "action_posture": "wait"
  },
  "supporting_experiences": ["experience:...", "experience:..."],
  "strength": 0.85,
  "text_gloss": "Repeated waiting sessions after delivery tend to justify no_action.",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

### Planner use

Patterns should usually reach planning through:

- tactic induction
- situational-state inference

But this does not require removing direct planner pattern access in v2. The
immediate problem is not that the planner can see patterns. The immediate
problem is that patterns and tactics are semantically blurred and that reflect
cannot currently see tactics.

### Strength updates

Pattern strength should continue to be updated mechanically during the fast
cycle, using EMA-style updates from pattern entailment / contradiction signals.

Deep-reflect should handle:

- pattern creation
- deletion
- refinement of pattern text / structure

Deep-reflect should not become the primary updater of pattern strength.

## Layer 7: Experiences

Experience remains the canonical substrate and should stay compact and typed.

The first-wave repaired shape is still correct:

- `observation`
- `desire_alignment`
- `pattern_delta`
- `salience`
- action/session/cycle links
- optional text rendering

### Important reinterpretation

In the new framework, desire alignment should ultimately be about:

- progress on `active_aims`
- and secondarily progress on their parent `standing_desires`

not direct entailment against the fully satisfied desire sentence.

That is the principled fix for the overnight desire-alignment confusion.

### Eval contract

The fast-cycle eval contract should become:

1. `plan.success` is the concrete success test for the chosen action and should
   be the textual form of the chosen active aim's `success_test`
2. NLI / entailment evaluates the outcome against that success test first
3. `desire_alignment` then maps:
   - first to the active aims directly served by the plan
   - then secondarily to their parent standing desires
4. Negative desire alignment should mean regression or opposition, not merely
   that the broader standing desire is not yet fulfilled

So:

- aim progress is the primary evaluation unit
- standing-desire progress is a derived slower signal

### Transition note

During Stage 2, `active_aims` do not need to exist as a separate runtime object
before eval can adapt. The transitional contract is:

- planner emits `active_aims` inside the plan record
- `plan.success` remains the textual success test consumed by eval
- eval continues to read `plan.success` first, while also recording the linked
  `active_aims`

So the migration path is:

`plan.success` only -> `plan.success + embedded active_aims` -> later aim-aware
eval summaries

## Cognitive Operators

The next framework should be described in terms of typed operators, not freeform
LLM prose generation.

## Fast Cycle

The fast cycle should become:

1. Load the normative floor, live `standing_desires`, current `tactics`, recent
   `patterns`, carry-forward, and recent experiences.
2. Derive `situational_state` primarily from typed signals and only
   secondarily from model help in ambiguous cases.
3. Activate zero or more `active_aims` from standing desires and active
   carry-forward items under that situational state.
   If no standing desire yields an obvious step but capacity remains available,
   allow a bounded exploratory aim whose purpose is to produce meaningful
   experience rather than to fully close a standing gap.
4. Rank tactics relevant to those aims and that situation.
5. Rank actions or `no_action`.
   `no_action` is valid only when both gap-closing and exploratory actions are
   presently not worthwhile.
6. Execute.
7. Mechanically evaluate against `active_aim.success_test`.
8. Write structured experience if salience passes threshold.
9. Update debugger-facing state snapshots, including `session_state:current`.

`session_state:current` is intentionally a userspace-writable, agent-tier
snapshot key. It is not a protected system key. Its purpose is debugger
visibility, not governance.

## Slow Cycle / Dream Phase

The slow cycle should become:

1. audit experience quality and degeneracy
2. treat repeated capacity-rich passivity as real evidence, not as noise
3. consolidate patterns from repeated experience
4. induce or revise tactics from patterned transitions
5. update standing desires from repeated gaps and fulfilled expansions
6. refresh carry-forward
7. optionally evaluate candidate identity commitments offline, not as a default
   v2 write path
8. train/evaluate model components on continuation quality only when the
   runtime substrate is stable enough to justify it

Deep-reflect remains the correct slow-cycle locus, but its role changes from
"write arbitrary KV prose patches" to "run typed consolidation operators."

## Future Compatibility With The Learned Model

This framework is intended to transfer naturally into the learned cognitive
model, but the learned-model mapping is not the implementation priority for v2.

### Fixed prior

- the normative floor

This is not learned from scratch each run. It remains a stable prior.

### Slow latent state

- persistent standing-desire state
- later, possibly identity commitments

### Fast latent / inferred state

- `situational_state`
- `active_aims`

These should adapt quickly to current circumstances.

### Mid-timescale policy

- `tactics`

These can be explicit objects first, with learned ranking and eventual partial
compression later.

### Predictive memory structure

- `patterns`

These remain interpretable predictive compressions, not opaque-only weights.

### Plausible early heads

Once the runtime substrate is stable enough, the first learned heads are most
likely:

- situational-state inference
- active-aim activation
- tactic ranking
- action ranking
- salience / memory utility

Identity-update learning should come later, if at all.

## Debugger Requirements

The UI and logs should surface:

1. normative commitments in force
2. standing desires with status:
   - active
   - blocked
   - fulfilled
   - dormant
3. current situational state
4. current active aims
5. tactics actually followed
6. patterns supporting current tactic selection
7. evidence supporting each layer
8. carry-forward items that contributed to active aim activation

If a future identity layer is introduced, it should be surfaced here only after
it is stable enough to deserve debugger trust.

This directly addresses the overnight need to tell:

- whether the agent is in a healthy holding pattern
- whether no-action is due to blockage or genuine fulfillment
- which layer produced a bad decision

## Migration Path

## Stage 0: Finish current substrate repair

Keep the current repaired experience substrate and eval cleanup work.

Do not discard:

- structured `experience:*`
- salience repair
- better no-action reasoning
- tactic-aware planning

## Stage 1: Keep the current normative floor, but curate it deliberately

Do not replace the kernel-enforced dharma + principles mechanism in v2.

Instead:

- keep the current safety boundary
- note redundancies and weak principles through observation
- only consider a compiled constitution after we can prove it preserves or
  improves safety and behavior

## Stage 1.5: Unblock emergence at the execution surface

Before introducing more persistent structure, remove the main gates that make
the current system collapse into premature `no_action`.

Priority targets:

- planner framing that treats `no_action` as the default when a gap is not
  obviously closable
- hard pre-grounding of every act in an existing standing desire
- invisibility of capacity and stagnation signals to planning and deep-reflect
- low salience for repeated capacity-rich inactivity
- backoff policies that deepen dormancy rather than reducing cost

This stage is not about adding a curiosity drive.

It is about allowing the existing expansive mechanism to express itself.

### Stage-1.5 success criteria

Advance only after:

- exploratory actions can occur without inventing a new top-level drive
- repeated no-action under available capacity becomes visible to deep-reflect
- `no_action` traces read as a justified positive choice, not as planner
  collapse
- the agent remains budget-disciplined without entering unnecessary dormancy

Rollback if:

- exploratory actions become arbitrary novelty-chasing
- cost rises sharply without richer experience or better downstream behavior
- debugger traces become less legible

## Stage 2: Split current desires into standing desires and active aims

Current `desire:*` objects become standing desires.

Add explicit `active_aims` to the plan/eval contract as ephemeral session
objects recorded in `action:*`.

But do not turn `active_aims` into a new permission gate.

Their first purpose is to make desire-to-action translation inspectable and
flexible, including bounded exploratory aims where the current system would
otherwise freeze.

This is the first major runtime win and should happen before learned modeling.

### Stage-2 success criteria

Advance only after:

- at least 20 sessions where active aims differ from what the old flat desire
  model would have produced
- or 20 sessions where the split makes blocked-vs-fulfilled reasoning
  explicitly clearer in the debugger and planner trace
- debugger inspection consistently distinguishes `blocked` from `fulfilled`
- no clear regression in planner quality

Rollback if:

- aim activation routinely disagrees with good plans
- or the extra structure makes action traces less legible rather than more
  legible

## Stage 3: Introduce mechanically derived situational state

Add a compact typed situational-state object to each session.

Start with mechanical derivation from typed signals. Only use model help for
residual ambiguity.

### Stage-3 success criteria

Advance only after:

- situational classifications match debugger judgment on waiting, blocked,
  recovery, active-response, and exploratory-opportunity sessions
- no-action reasoning improves measurably
- there is no major latency or cost regression

Rollback if:

- situational state becomes a noisy extra label that does not help planning or
  debugging

## Stage 4: Fix pattern/tactic separation and phase reach

Do this before introducing identity:

- make patterns more strictly descriptive
- ensure tactics reach every phase they are meant to influence
- stop dev-loop artifacts from becoming live cognitive structure

### Stage-4 success criteria

- `reflect:tactic-blindness` is resolved
- patterns are no longer doing tactic work in practice
- planner traces show tactics materially shaping behavior

### Stage-4 implementation note

The concrete v2 path for reflect/tactic reach is:

- maintain read-only access to the current tactic set during session reflect
- pass a compact tactic summary into reflect context
- include tactic provenance from recent plans (`follows_tactics`) so reflect can
  reason about which tactics were actually in play

This does not require reflect to mutate tactics directly. It requires reflect to
see the tactics that shaped the session it is summarizing.
## Stage 5: Evaluate identity commitments as an optional slow layer

Do not rush this.

Identity commitments should appear only after the system has enough clean
experience to avoid learning local harness artifacts as selfhood.

### Stage-5 gate

Do not introduce identity commitments unless all of the following are true:

- the desire/aim split is already paying for itself
- situational state is accurate enough to trust
- the corpus contains multiple run regimes, not just overnight holding patterns
- there is a concrete failure that simpler layers cannot explain

## Stage 6: Train the first learned heads

Use the repaired corpus to train:

1. situational-state inference
2. active-aim activation / ranking
3. tactic ranking
4. salience / utility

Identity-update learning should come later than aim/tactic learning.

## What This Deprecates

This framework deprecates the following assumptions from the old model:

- that desire is the first abstraction above experience
- that current `desire:*` objects should serve both long-horizon and
  immediate-planning roles
- that "mode" should be handled only implicitly
- that active session intent does not deserve its own explicit representation

## Open Design Questions

1. Should `situational_state` be persisted as a first-class KV object or only
   as an action/session snapshot?
2. Should a future identity layer be explicit KV objects first, or initially a
   hidden slow state with debugger renderings?
3. How soon should pattern structure become more formal than
   `{ observation, predicts, strength }`?
4. Carry-forward should remain a separate continuity cache, but in v2 it is an
   explicit input to active aim activation rather than a disconnected side
   list.
5. Under what evidence threshold would a compiled constitution actually be
   safer or clearer than the current dharma + principles floor?

## Bottom Line

The next cognitive framework should not be built around:

`experience -> desire -> tactic -> action`

The v2 core should be built around:

`normative_floor -> standing_desires -> situational_state -> active_aims -> tactics -> action -> experience`

with:

- `patterns` as predictive compression
- `experience` as substrate
- `deep-reflect` or equivalent operational review as typed consolidation
- the learned model, later, operating across these layers at different
  timescales

Identity commitments remain a strong v3 candidate, but not a justified v2
mandate yet.

The review-system architecture that may later critique or replace this stack
should not be inferred from this document. This spec is about userspace
organization, not about the final role structure of self-review.

That stack fits the overnight evidence far better than the current flat one,
preserves debugger legibility, and is a safer next step than trying to replace
the entire runtime ontology in one move.

# Next Cognitive Model Requirements From DR Comparison

Date: 2026-04-06

## Purpose

This note captures what the recent deep-reflect comparison work actually
taught us that should carry forward into the next cognitive model.

It is not a recommendation to invest further in the current deep-reflect
mechanism as a final architecture. The current DR path is a transitional probe.
Its value is in revealing requirements for the next structure, not in winning a
Claude-vs-Codex bakeoff for a mechanism we expect to replace.

## Main Conclusion

The important output of this phase is not "which model writes better DR JSON."

The important output is a set of constraints for the next cognitive model:

- bootstrap updates must be minimal and calibrated
- cognition must be grounded in structured experience, not narrative sprawl
- continuation quality matters more than one-shot reflective prose
- debugging and inspection must surface evidence, deltas, and uncertainty
- comparison infrastructure must support branching from the same state

## What The DR Comparison Actually Revealed

### 1. Bootstrap quality is mostly about restraint

The strongest signal from the bootstrap DR comparison was not model power. It
was update discipline.

Better bootstrap behavior looked like:

- recognizing that the system is still in bootstrap
- making the smallest sufficient cognitive intervention
- avoiding premature patterns and tactics
- keeping uncertainty explicit
- scheduling an early re-check rather than overcommitting

This should become a first-class design rule in the next model.

### 2. The representation matters more than the model

The comparison harness exposed a major truth: model behavior is strongly shaped
by the representation it is given.

Even when context is formally bounded, raw experience records containing bulky
or low-signal fields can waste reasoning budget and distort behavior. The next
architecture should treat disciplined state representation as foundational, not
as prompt hygiene.

### 3. A good cognitive update is judged by the next continuation

A reflective update is only good if it improves the next real session:

- does the seeded desire get used?
- does the next act become more concrete?
- does the system avoid vacuous `no_action`?
- does the next reflect sharpen structure rather than inflate it?

The next architecture should treat continuation quality as the primary
evaluation target.

### 4. Debugging needs verdicts, not only structure

The recent UI work made this clearer: raw entity graphs and long reflections are
not enough for debugging.

The operator needs fast answers to:

- what changed?
- what evidence caused it?
- what is active now?
- what is still unproven?
- what should the next act validate?

This is a requirement on the next architecture, not just on the dashboard.

## Requirements For The Next Cognitive Model

### R1. Bootstrap must be a distinct regime

The next model must explicitly recognize the bootstrap regime:

- zero or near-zero desires
- too little repeated evidence for durable patterns
- high uncertainty about the operational world

Behavioral requirements:

- prefer one minimal desire over broad initial structure
- avoid durable pattern creation from a single episode
- avoid tactic creation unless supported by repeated evidence or a clear defect
- ask for quick validation through the next continuation

### R2. Structured experience remains the canonical substrate

The current substrate repair direction is correct and should carry forward.

The next model should operate over compact, typed experience structures such as:

- `observation`
- `desire_alignment`
- `pattern_delta`
- `salience`
- stable links to action/session/cycle

It should not depend primarily on narrative summaries or raw tool logs.

### R3. Low-signal payloads must be excluded from cognitive context

The next model should consume compact cognitive summaries, not full raw
artifacts by default.

Specifically:

- do not pass embedding vectors into cognitive consolidation by default
- do not pass bulky tool-output blobs unless explicitly needed
- separate audit records from cognitive records
- make the compact representation the primary contract, not an optimization

### R4. The system must distinguish "unverified" from "bad"

A newly created desire is not yet good or bad if it has not been exercised.

The next architecture must preserve this distinction:

- `unverified`: structure exists but has not yet been tested in continuation
- `validated`: continuation showed useful downstream behavior
- `degraded` or `contradicted`: later experience showed the update was wrong

This can initially be derived from existing records, but the new model should
make room for this state transition explicitly.

### R5. Continuation-based evaluation must be first-class

The next architecture should evaluate cognitive updates by what happens after
them, not only by local plausibility.

Requirements:

- branch from a shared pre-update state
- materialize competing updates onto sibling branches
- continue each branch through one or more real sessions
- compare resulting desires, actions, experiences, and later reflections

This makes the new model empirically testable instead of aesthetically judged.

### R6. Cognitive updates should move toward typed operators

The current DR loop writes freeform `kv_operations`. That is useful as a bridge
but too unconstrained as a final mechanism.

The next model should evolve toward typed cognitive transitions such as:

- create/refine/retire desire
- create/refine/retire pattern
- create/refine/retire tactic
- revise carry-forward
- adjust salience or retrieval policy

This does not require removing all LLM involvement immediately, but it does
require that cognitive change become more structured than arbitrary KV writes.

### R7. Minimality and elegance should be scored

The Codex-vs-Claude bootstrap comparison showed that "more structure" is not
the same as "better structure."

The next model should reward:

- minimum sufficient intervention
- compression over clutter
- explicit uncertainty when evidence is thin
- avoidance of premature generalization

This should be part of evaluation and consolidation policy.

### R8. Debugger-facing evidence must be preserved

The system should remain inspectable by a human debugger using existing or
near-existing state.

At minimum, the next architecture should make it easy to answer:

- which experiences supported this update?
- what changed in typed state?
- which active desires or patterns are actually in play?
- what continuation would validate or falsify this structure?

This requirement should constrain both state design and UI design.

## What Not To Over-Invest In

Based on this phase, the following should not be treated as primary goals:

- polishing the current DR model bakeoff into a permanent benchmark track
- heavy prompt specialization for a DR mechanism expected to be transitional
- overfitting the current compare harness beyond what is needed for faithful
  state-based A/B testing

Those tools remain useful only insofar as they help specify and validate the
next architecture.

## Near-Term Implications

The current DR mechanism should remain in use only as a transitional probe
while the next cognitive model is designed and implemented.

In the near term, the correct priorities are:

1. finish validating the repaired structured substrate and bootstrap loop
2. keep DR context compact and disciplined
3. use state-lab branching to compare continuations from the same state
4. use the findings to shape the next typed cognitive operators and learned
   components

## Bottom Line

The real lesson of the DR comparison phase is not "pick Codex" or "pick
Claude."

The real lesson is:

- bootstrap cognition must be minimal
- structure must be evidence-grounded
- context must be compact
- updates must be judged by continuation quality
- the system must stay legible to a debugger

Those are the requirements that should shape the next cognitive model.

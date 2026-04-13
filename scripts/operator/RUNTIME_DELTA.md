# Runtime vs Operator Delta

This note answers a narrower question than the general operator inventory:

If the purpose of the agent is self-reflection and self-improvement, what does
the remaining external operator loop still do better than the native runtime,
exactly?

The goal is not to defend the operator loop. The goal is to identify the
missing capability delta so we can decide what should be internalized.

## Short answer

The external loop is not better because it is "more intelligent".
It is better in a few specific ways:

1. it observes the runtime from outside rather than from inside
2. it uses a deterministic multi-session defect taxonomy
3. it stores architecture defects as durable probes
4. it compares runtime outputs against code/rubric, not just against prior state
5. it runs an explicit proposal/challenge/routing layer across cycles

The native runtime already has strong internal machinery:
- session reflect
- deep-reflect (DR1)
- meta-policy notes
- reasoning artifacts
- carry-forward continuity
- DR2 review-note pipeline
- DR3 authority pipeline

So the real delta is not "self-improvement exists outside the agent and not
inside". The real delta is:

- native runtime is strong at *intra-agent reflection and change application*
- external loop is still stronger at *external longitudinal diagnosis*

## What the native runtime already has

### 1. Internal reflective memory

Native runtime already persists:
- `experience:*`
- `action:*`
- `pattern:*`
- `desire:*`
- `tactic:*`
- `identification:*`
- `last_reflect`
- `reflect:*`
- `review_note:*`
- `meta_policy_notes`
- `reasoning_artifacts`

Relevant code:
- [userspace.js](/home/swami/swayambhu/repo-tick-rescue/userspace.js:1500)
- [reflect.js](/home/swami/swayambhu/repo-tick-rescue/reflect.js:61)
- [prompts/deep_reflect.md](/home/swami/swayambhu/repo-tick-rescue/prompts/deep_reflect.md:1)

### 2. Internal change generation

DR1 can already:
- inspect experience/action/desire/pattern/tactic/identification state
- propose `kv_operations`
- produce `carry_forward`
- produce `meta_policy_notes`
- produce `reasoning_artifacts`

DR2 can already:
- consume `review_note:userspace_review:*`
- run review/author/challenge loops
- apply validated changes

DR3 can already:
- run authority review and widening decisions

So the runtime is not missing self-modification machinery.

### 3. Some self-audit intent already exists

The DR1 prompt explicitly says:
- inspect recent traces for degeneracy
- trace suspect behavior back to generating code/config via `kernel:source_map`

Relevant prompt:
- [prompts/deep_reflect.md](/home/swami/swayambhu/repo-tick-rescue/prompts/deep_reflect.md:34)

But that intent is still weaker than the external loop's actual workflow.

## What the external loop still does better

## Delta 1: External observer stance

The operator loop explicitly treats runtime output as the object under test.

In [scripts/operator/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/cc-analyze.md:16):
- `context.json` is the test subject, not the source of truth
- code and rubric are treated as ground truth

That is a major difference.

The native runtime mostly reasons from its own stored state and recent traces.
It reflects *as the agent*. The external loop evaluates the agent *as a
system under test*.

Why this matters:
- self-reports can be wrong
- internal summaries can drift
- external evaluation can say "the runtime believes X, but code/rubric says Y"

Internalization candidate:
- yes

Needed native capability:
- a review mode that explicitly treats current state as hypothesis/output and
  compares it against code-level and rubric-level expectations

## Delta 2: Deterministic mechanical audits

The external classify layer contains explicit heuristics for architecture
defects:
- avoidance-framed desires
- pattern strengths stuck at 0 or 1
- tactics that are really reflection/meta-policy
- experiences contaminated by internal reasoning
- carry-forward items that smuggle runtime policy
- outbound messages that leak internal runtime language

Relevant code:
- [lib/operator/dev-loop/classify.js](/home/swami/swayambhu/repo-tick-rescue/lib/operator/dev-loop/classify.js:1)

The native runtime does not have an equivalent deterministic audit layer.
It relies on generative reflection and downstream DR notes.

Why this matters:
- deterministic audits catch the same class of error consistently
- they can accumulate evidence across cycles
- they reduce "model forgot to notice it this time"

Internalization candidate:
- yes

Needed native capability:
- a small native "mechanical audit" phase whose outputs feed DR1/DR2 as
  grounded review notes

## Delta 3: Durable defect/probe ledger

The operator loop stores issues as explicit probes with:
- stable fingerprint
- evidence list
- severity
- blast radius
- self-repairability
- probe budget
- status

Relevant code:
- [lib/operator/dev-loop/classify.js](/home/swami/swayambhu/repo-tick-rescue/lib/operator/dev-loop/classify.js:18)
- [scripts/operator/dev-loop/state.mjs](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/state.mjs:38)

The native runtime has:
- patterns
- desires
- tactics
- meta-policy notes
- review notes

But those are not the same as a durable architecture-defect ledger.

What is missing natively:
- a first-class representation of "this is an observed defect we are tracking
  across sessions"

Internalization candidate:
- yes

Needed native capability:
- a `probe:*` or equivalent review-defect memory type, distinct from cognition
  entities like desire/pattern/tactic

## Delta 4: Multi-session aggregation

The operator loop builds explicit multi-session analysis bundles:
- [scripts/analyze-sessions.mjs](/home/swami/swayambhu/repo-tick-rescue/scripts/analyze-sessions.mjs:1)
- [scripts/operator/dev-loop/observe.mjs](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/observe.mjs:1)

It can:
- collect many sessions
- summarize trend-like patterns
- compare deltas between cycles
- notice recurring issues across runs

The native runtime has access to historical keys, but its reflective path is
still primarily session-centric plus `last_reflect` continuity.

This is why the external loop is currently better for:
- "what happened over the last 30 sessions?"
- "is the same defect recurring?"
- "did the architecture really improve, or just look different once?"

Internalization candidate:
- yes

Needed native capability:
- a multi-session rollup view
- explicit longitudinal summaries
- trend-aware defect accumulation, not just single-session DR

## Delta 5: Code/rubric comparison as a first-class step

The external loop explicitly reads code before proposing fixes.

In [scripts/operator/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/cc-analyze.md:22):
- code is part of the truth source
- proposals are supposed to be justified against code and quality lenses

The native DR1 prompt mentions `kernel:source_map`, but it does not actually
package code files as review context in the same systematic way. In practice it
usually reasons over state traces and prior artifacts, not over a deliberate
"code says X, runtime produced Y" comparison.

Internalization candidate:
- yes

Needed native capability:
- a review path that materializes relevant code/config into the review context
- not just source-map pointers

## Delta 6: Proposal/challenge/routing pipeline

The external loop runs:
- finding generation
- proposal writing
- Codex challenge rounds
- verdicts
- routing decisions
- optional approvals

Relevant files:
- [scripts/operator/dev-loop/cc-analyze.md](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/cc-analyze.md:96)
- [scripts/operator/dev-loop/loop.mjs](/home/swami/swayambhu/repo-tick-rescue/scripts/operator/dev-loop/loop.mjs:1008)

The native runtime already has something adjacent:
- DR2 review/challenge/author pipeline
- DR3 authority review

So this delta is only partial.

What is still better externally:
- explicit cycle-level routing over multiple findings
- issue-to-proposal-to-decision organization
- stronger distinction between diagnosis and routing

Internalization candidate:
- partly already internalized

Needed native capability:
- more explicit joining of:
  - deterministic audit findings
  - durable probes
  - DR2 review-note generation

In other words, DR2/DR3 are already the right internalization destination.
What is missing is the upstream diagnostic structure feeding them.

## Delta 7: Operational controls, not cognition

The external loop also carries things that are not really "self-improvement
intelligence":
- clean reset/teardown
- remote compute cleanup
- service restart
- immediate repeated sessions
- approval notifications

These matter operationally, but they are not the main cognitive delta.

Internalization candidate:
- reset/burst scheduling: yes, as runtime/admin controls
- Slack/email approvals and service lifecycle: probably remain operator-side

## The actual conclusion

The remaining meaningful delta is concentrated in three native gaps:

### A. No first-class externalized defect memory

Missing natively:
- durable `probe`/defect tracking across sessions

### B. No deterministic mechanical audit stage

Missing natively:
- a repeatable, non-generative audit layer that turns bad traces into grounded
  defect candidates

### C. No strong multi-session review rollup

Missing natively:
- longitudinal aggregation
- cycle-over-cycle defect evidence
- explicit code/rubric comparison against aggregated state

Everything else is either:
- already internalized enough (DR2/DR3/change application), or
- mostly operator/infrastructure control rather than cognition

## What this implies

If the goal is to retire the external loop without losing capability, the next
native internalization target should not be "more DR2" or "more authority".

It should be:

1. add a native defect/probe memory type
2. add a deterministic mechanical audit pass
3. add a native multi-session rollup mode
4. feed those outputs into DR2 review-note generation

That would shrink the real delta substantially.

## What can probably be archived even before that

Even if we keep the external observation path temporarily, the following still
look less essential:
- `dr-compare` benchmarking
- older coarse `verify` patterns once the reset and review paths are cleaner

But the observation/classification/probe path still represents real missing
native capability today.

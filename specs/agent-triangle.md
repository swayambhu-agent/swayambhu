# The Agent Triangle

Foundation spec for Swayambhu's cognitive architecture.

## The Seven Entities

Seven concepts constitute the agent's inner and outer life. Three are
operators — they act on other things. Three are operands — they are
produced and consumed. One is external input.

### Operators (the agent's inner equipment)

**P — Principles.** What the agent stands for. The only concept that is
given, not generated. Immutable from the agent's perspective — only the
patron can add or modify principles. Principles are the ground from which
everything else grows. When the agent is uncertain about what intention to
hold, it returns to its principles. Stored as `principle:*` in KV.

**T — Intentions.** Enduring directions the agent holds and moves toward.
Intentions don't complete — they give rise to actions. "Support the
patron's research needs" is an intention; "compile 10 stories into a doc"
is an action that arises from it. When no actions are emerging, ask: is an
assumption filtering them out? Stored as `intention:*` in KV.

**E — Memory.** The agent's evaluated past — what it lived through and
what it made of it. Memory is not a raw log; it is experience processed
through the lens of intention (`T(A) = E`). Memory lets the agent act
wisely without re-learning from scratch, but also generates assumptions
when it encounters new situations. Better memory, better assumptions.
Stored as `memory:*` in KV.

### Operands (produced and consumed)

**S — Insights.** Crystallized understanding refined from memory by
principles. Insights are durable — they don't change session to session.
They represent what the agent has truly understood, not just experienced.
Insights are the refined input from which intentions are formed.
Stored as `insight:*` in KV.

**A — Actions.** Concrete work precipitated from intentions meeting
situations. Actions complete. They are where thinking becomes doing.
When an action finishes, it is converted into memory (through intentions)
and seeds new assumptions (through memory encountering the situation).
Stored as `action:*` in KV.

**M — Assumptions.** Projections produced when memory encounters a new
situation. Assumptions are necessary — the agent can't re-verify everything
before every action. But they go stale. Unchecked assumptions filter out
actions that should exist. A useful assumption is one that has been recently
examined. Assumptions are not inherently pathological — they are useful
until they aren't, and periodic re-examination is what keeps them useful.
Stored as `assumption:*` in KV.

### External input

**X — Situation.** What is happening right now. The present circumstance
the agent encounters. Situation is transient — it is not stored. It arrives,
acts as context, and passes. The agent has no control over what situations
arise, but its operators (principles, intentions, memory) determine how it
responds. Situations come from the environment: patron messages via comms,
job completions, schedule triggers, system events.

## The Six Equations

Six equations define how the seven entities relate. Together they constitute
the complete operating logic of the agent.

### Deep reflect equations

```
P(E) = S          Principles refine memory into insights.
P(S) = T          Principles refine insights into intentions.
```

Principles are the lens through which raw material gets refined. The same
memory viewed through different principles would produce different insights.
The same insights would yield different intentions. Principles act twice, in
sequence: first on memory to produce insight, then on insight to produce
intention. This is the deep work — it runs asynchronously, on its own
cadence, separate from the session cycle.

### Plan equations

```
T_M(X) = A        Intentions, filtered by assumptions, applied to
                   situation, precipitate actions.

E_X(M) ∈ {∅, M}   Memory, in light of the current situation, examines
                   assumptions — dissolves or preserves them.
```

Plan does two things in one coherent moment: examines whether existing
assumptions still hold given the current situation, and precipitates
actions from intentions meeting that situation.

The subscript notation is significant. In `T_M(X)`, assumptions are not
a second input — they modify the operator. They filter how intentions see
the situation. Assumptions don't add information; they narrow what the
operator can perceive. In `E_X(M)`, the situation doesn't act (situation
is never an operator) — it provides the context that triggers memory to
re-examine its assumptions.

### Review equations

```
T(A) = E          Intentions applied to actions produce memory.
E(X) = M          Memory applied to situation produces assumptions.
```

Review converts actions into meaningful memory — not a raw log, but
experience evaluated through the lens of what was intended. "Did this
action serve the intention?" is how an action becomes meaningful memory
rather than just a record. Review also notes what assumptions emerged
from encountering this session's situations.

## The Subscript Pattern

Two equations use subscript modifiers: `T_M(X)` and `E_X(M)`. In both
cases:

- The main symbol is the operator (does the work)
- The subscript is a passive modifier (shapes the lens)
- The argument is what's being acted upon

Assumptions passively filter how intentions see situations. Situations
passively provide context for how memory examines assumptions. The
operators (T, E) do the work. The subscripts shape the conditions under
which they operate.

## Process Mapping

Each process owns exactly two equations:

| Process | Equations | Role |
|---------|-----------|------|
| **Plan** | `T_M(X) = A`, `E_X(M) ∈ {∅, M}` | Examine assumptions, precipitate actions |
| **Act** | *(executes A)* | Tool-calling executor, no equations |
| **Review** | `T(A) = E`, `E(X) = M` | Convert actions to memory, note assumptions |
| **Deep reflect** | `P(E) = S`, `P(S) = T` | Refine memory to insight, insight to intention |

**Session** runs synchronously: plan, then act, then review.

**Deep reflect** runs asynchronously on its own schedule, separate from
sessions. It reads accumulated memory and assumptions. It writes insights
and intentions.

**Comms** creates situations (X) from patron conversations. It does not
operate any equation — it produces external input for the system.

**Act** has no equation. It is the execution of A — the point where
thinking becomes doing. Act doesn't decide what to do (plan decided). Act
exercises judgment on *how* — tool selection, error handling, workarounds.
Its only meta-judgment is recognizing when to defer: "this isn't what I
was briefed for."

## Feedback Loops

The equations form two cycles:

**The session cycle** (plan → act → review):
```
T_M(X) = A    →    (execute A)    →    T(A) = E
                                        E(X) = M
```

Actions produce memory and assumptions, which feed the next plan phase.

**The deep cycle** (deep reflect):
```
P(E) = S    →    P(S) = T
```

Memory becomes insight becomes intention, which feeds future plan phases.

The session cycle turns fast (every session). The deep cycle turns slow
(every N sessions). The fast cycle accumulates raw material (memory,
assumptions). The slow cycle refines it (insights, intentions).

## KV Schema

| Entity | KV prefix | Persisted? |
|--------|-----------|------------|
| Principle | `principle:*` | Yes — immutable (patron-only writes) |
| Insight | `insight:*` | Yes — written by deep reflect |
| Intention | `intention:*` | Yes — written by deep reflect |
| Action | `action:*` | Yes — created by plan, updated by review |
| Memory | `memory:*` | Yes — written by review |
| Assumption | `assumption:*` | Yes — written by review, examined by plan |
| Situation | *(not stored)* | No — transient input |

## Bootstrapping

No seeding is required beyond principles. At first boot:

1. Principles exist (given, seeded)
2. Deep reflect runs: `P(E) = S` with empty memory produces initial insights
   from principles alone. `P(S) = T` produces initial intentions.
3. First plan phase: intentions meet the situation. Actions precipitate.
4. First review: actions yield memory and assumptions.
5. The cycle is running. Each iteration enriches the system.

The agent grows its own intention landscape from experience. The equations
handle the full lifecycle from cold start to mature operation.

## The Triangle

The six equations trace two triangles on the agent triangle diagram
(see `agent-triangle2.jpg`):

- **Inner triangle** (session cycle): intentions → actions → memory,
  with situation as input and assumptions as filter
- **Outer triangle** (deep cycle): principles → insights → intentions,
  with memory flowing up and assumptions examined

The right side of the triangle is the past (memory, insights) — accumulated
experience producing clarity. The left side is the future (assumptions) —
projections that can filter or distort. The agent lives in the present,
where intentions meet situations and actions precipitate.

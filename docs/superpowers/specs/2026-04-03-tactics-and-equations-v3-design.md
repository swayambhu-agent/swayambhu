# Tactics and Equations v3

## Problem

The agent is stuck in a no-action deadlock. Deep reflect produces
abstract desires ("accumulate varied experience"), but the cheap act
model can't bridge from abstract desire to concrete action. Every
session produces `no_action` with identical reasoning. No new
experiences are generated, so DR has nothing to learn from.

The root cause: the architecture has no layer between desire (target
state) and action (tool call). Previously, "vikalpas" (ideas) were an
informal attempt to fill this gap. Tactics formalize it.

Additionally, the entity formerly called "samskara" was carrying two
concepts — descriptive observations ("Slack fails silently") and
prescriptive approaches ("start with primary sources when
researching"). With tactics as a formal entity, samskaras can be
cleanly renamed to "patterns" and carry only the descriptive role.

## The Five Equations

```
d  = D_n(ε)           desires from experience, operator shaped by principles
t  = T_ε(d)           tactics from desires, operator shaped by experience
a  = A(d, t, c)       action from desires, tactics, and circumstances
ε  = E_{p,d}(c)       experience from circumstances, operator shaped by patterns and desires
p_{t+1} = P(ε, p_t)   patterns from experience and prior patterns
```

### Notation

Subscripts modify the **operator** — they change what the function
IS, not what data it receives. Arguments are inputs the operator
processes.

| Symbol | Entity | Description |
|--------|--------|-------------|
| n | Principles | Immutable values. Shape desire creation. Never written. |
| d | Desires | Discrete step changes. Gap exists or doesn't. |
| t | Tactics | Prescriptive approaches. Variable lifespan. |
| p | Patterns | Descriptive observations. Continuous strength via EMA. |
| ε | Experience | What happened that mattered. Append-only. |
| c | Circumstances | Observable world right now. Ephemeral. |
| a | Actions | What the agent does. Ephemeral. |

### Equation 1: Desires — `d = D_n(ε)`

Principles reshape the desire operator. Experience is input. Desires
are output.

Desires are **discrete events**, not gradual processes. A desire
appears when experience crosses a threshold — like supersaturation
producing a crystal. It persists unchanged. It vanishes when
fulfilled. There is no "strengthening" or "refining" a desire.

- **Created** when experience reveals a gap that principles care about
- **Persists** unchanged until the gap closes
- **Retired** when fulfilled (mechanical check, not part of D)
- The experience of fulfillment may precipitate new desires through D

Contrast with patterns (continuous, refined over time) and tactics
(refreshed each DR cycle). Desires are binary: gap exists or it
doesn't.

### Equation 2: Tactics — `t = T_ε(d)`

Experience reshapes the tactic operator. Desires are input. Tactics
are output.

The subscript ε on T is deliberate and differs from P(ε, p_t) where
experience is an argument. A novice and an expert given the same
desire don't run the same function with different inputs — they run
**different functions**. Experience rewrites the machinery itself.
Years of sysadmin experience don't sit alongside the desire "fix the
server" — they fundamentally alter what "fix the server" means and
what space of tactics you can see.

Tactics are prescriptive: "given desire Y, approach it like Z." They
are not actions (what to do) or patterns (how the world works).

- **Desire-linked tactics:** "when pursuing research for the patron,
  start with primary sources before secondary commentary"
- **Cross-cutting tactics** (no desire link): "when facing ambiguity,
  gather more context before acting"

**DR prompt framing:** experience is identity, not data. "You have
lived through these experiences. Given these desires, what approaches
do you see?" Not "analyze these experiences and produce tactics."

### Equation 3: Actions — `a = A(d, t, c)`

Action is a function of desires, tactics, and circumstances. No
subscript — nothing reshapes the act operator. The intelligence is in
the inputs (tactics shaped by experience, desires shaped by
principles), not the operator. Act is pure execution.

This runs on a cheap model. The plan step receives desires, tactics,
and circumstances, picks a tactic that fits the current situation, and
executes it. The cheap model doesn't need to bridge abstract → concrete
— DR already did that.

### Equation 4: Experience — `ε = E_{p,d}(c)`

Patterns and desires reshape the experience operator. Circumstances
are input. Experience is output.

Patterns determine surprise (how unexpected was this outcome given
what I've observed before?). Desires determine affinity (how aligned
or misaligned was this outcome with what I want?). Together they
filter raw circumstances into salient experiences worth recording.

This is the existing evaluation pipeline (surprise + affinity →
salience gate), now formalized as an equation.

### Equation 5: Patterns — `p_{t+1} = P(ε, p_t)`

Patterns at t+1 are a function of experiences and patterns at t. No
subscript on the operator — P is just pattern recognition. What
changes is the input (more experiences, different existing patterns),
not the machinery.

Time subscript is on the **entity**, not the operator. Contrast with
T_ε where experience reshapes the operator itself. P doesn't need that
claim — same function, different inputs, different outputs.

Two update mechanisms:
1. **Mechanical (during act review):** EMA strength update.
   `p.strength ← p.strength × (1 - α) + (1 - σ) × α`.
   Confirmation strengthens, contradiction erodes. Continuous.
2. **Intelligent (during DR):** Create new patterns when experiences
   reveal recurring themes. Refine pattern text as understanding
   sharpens. Delete eroded patterns. This is the P operator.

Unlike desires (discrete step changes), patterns are continuous —
they evolve as understanding deepens.

## Entity Schemas

### Tactic (new)

KV key: `tactic:{slug}`

```json
{
  "slug": "research-primary-sources",
  "description": "When pursuing research for the patron, start with primary sources (transcripts, books) before secondary commentary",
  "desire": "desire:build-research-body",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

- `desire` is **optional**. Cross-cutting tactics have no desire link.
- No `lifespan` field — DR manages lifecycle implicitly by retiring
  tactics when they're no longer useful.
- No strength/EMA — tactics aren't tested mechanically like patterns.

### Pattern (renamed from samskara)

KV key: `pattern:{slug}` (was `samskara:{slug}`)

Schema unchanged except key prefix rename. Patterns are descriptive
observations about how the world works, with mechanical strength
updates.

### Desire (unchanged)

KV key: `desire:{slug}`

Schema unchanged. Emphasis: desires are not refined. They are created
and retired.

## What Runs When

### Act session (fast cycle, cheap model)

1. Load desires, tactics, patterns, circumstances
2. Plan: `A(d, t, c)` — pick a tactic, produce an action
3. Execute: tool calls
4. Review: `E_{p,d}(c)` — evaluate outcome, record experience if salient
5. Pattern strength update: `p.strength` EMA (mechanical)

Plan receives `[DESIRES]`, `[TACTICS]`, `[CIRCUMSTANCES]`. Patterns
are NOT in the plan prompt — they've done their work upstream in
experience evaluation.

### DR session (slow cycle, expensive model)

Three operators, all reading experience:

1. **P operator** (patterns): `P(ε, p_t) → p_{t+1}` — create, refine,
   delete patterns. Same as current S operator, renamed.
2. **D operator** (desires): `D_n(ε) → d` — precipitate new desires,
   retire fulfilled ones. No refinement.
3. **T operator** (tactics): `T_ε(d) → t` — produce approaches from
   desires, shaped by lived experience.

Order matters: D before T. Tactics derive from desires.

## Cold Start

All stores empty: `d_0 = ∅`, `t_0 = ∅`, `p_0 = ∅`, `ε_0 = ∅`.

First session: no desires, no tactics → maximum surprise (σ=1) →
experience recorded. DR fires: D creates initial desires, T creates
initial tactics from those desires, P begins pattern recognition.
The agent can act meaningfully on the next act session because it
has tactics.

## KV Tier Changes

`tactic:*` added to Protected tier in `kernel:key_tiers` — writable
by DR via `kvWriteGated`, not by the act agent directly.

`pattern:*` replaces `samskara:*` in Protected tier.

## Removals

- Vikalpa/idea fields from DR output and reflect.js
- Vikalpa tracking in `last_reflect` and drop logging
- `samskara:*` KV keys (replaced by `pattern:*`)

## Codebase Changes Summary

| Area | Change |
|------|--------|
| DR prompt | Add T operator section. Rename S → P. Simplify D (no refine). |
| Plan prompt | Replace `[SAMSKARAS]` with `[TACTICS]`. |
| `userspace.js` | Load tactics in act context. Rename samskara references. |
| `act.js` | `formatSamskaras` → `formatPatterns`. Add `formatTactics`. |
| `eval.js` | Rename samskara references to pattern. |
| `memory.js` | Rename samskara references to pattern. |
| `reflect.js` | Remove vikalpa tracking. Rename samskara refs. |
| `kernel:key_tiers` | Add `tactic:*` to protected. Rename `samskara:*` → `pattern:*`. |
| Seed script | Update key names. |
| Tests | Rename samskara → pattern. Add tactic schema tests. |
| Cognitive architecture spec | Update to v3 equations. |

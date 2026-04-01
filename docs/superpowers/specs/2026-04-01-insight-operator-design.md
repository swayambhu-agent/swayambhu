# Design: Samskara Model — Unified Belief Architecture

## Summary

This spec documents the evolution from a multi-store belief architecture
(assumptions + insights + wisdom + statistical memory) to a unified
samskara model. The design emerged through first-principles reasoning
about what assumptions and insights actually are, whether they can be
mathematically separated, and what the most elegant representation is.

## The Problem

The original architecture had four separate stores for what the agent
knows about reality:
- `assumption:*` — temporal state bets with TTL
- `insight:*` (was `prajna:*`/`upaya:*`) — enduring patterns without TTL
- `mu:*` — statistical counters (confirmations, violations)

This created artificial boundaries. With finite observations, a
well-confirmed assumption is indistinguishable from a shallow insight.
The LLM doing deep-reflect would inevitably conflate them. And the risk
of premature promotion to "insight" (no TTL, never questioned again)
was a silent failure mode.

## The Insight: Samskaras

Sanskrit: संस्कार — an impression left by experience.

A fresh samskara from one experience is shallow and fades quickly.
A samskara reinforced across many diverse experiences is deep and
enduring. The difference is not type — it is depth. Same kind of thing
at different stages of maturity.

## The Architecture

### Four entities

| Symbol | Name | Description |
|--------|------|-------------|
| p | Principles | Immutable foundational truths |
| d | Desires | Approach/avoidance vectors — magnified from experience through principles |
| s | Samskaras | Impressions at different depths — the agent's model of reality |
| ε | Experiences | Raw experience log — what actually happened |

### Three agent operators

| Symbol | Name | Phase | Description |
|--------|------|-------|-------------|
| A | Act | Fast cycle | Generates action from desires, informed by samskaras |
| S | Samskara | Deep-reflect | Creates/deepens/refines/erodes samskaras from experiences |
| D | Desire | Deep-reflect | Magnifies experience through principles |

### Review is computation, not an operator

Surprise (σ), affinity (α), samskara strength updates, and episode
recording are mechanical — formulas and threshold checks, not LLM-mediated
decisions. This keeps act sessions cheap.

### Samskara schema

```json
{
  "pattern": "Slack fails silently — success responses don't guarantee delivery",
  "strength": 0.85
}
```

Two fields. Strength is an EMA (0-1). One α_ema parameter (shared with
surprise tracking — same underlying signal). Below deletion threshold
→ delete. No TTL, no counters, no source lists, no dates. The strength
score encodes the full history. The S operator can find supporting
experiences in ε via embedding similarity.

### Key design decisions

1. **No TTL.** Depth (strength) replaces TTL. Shallow samskaras erode
   naturally through the EMA mechanism. Deep samskaras resist erosion
   because they have more confirmation history encoded in the score.

2. **No μ.** Statistical counters collapse into the samskara strength
   score. The EMA IS the counter, compressed into one number.

3. **No assumption/insight split.** Everything is a samskara at some
   depth. The spectrum from "provisional observation" to "deep
   understanding" is continuous, not binary.

4. **One EMA parameter.** The α_ema for samskara strength and the
   α_ema for surprise tracking are the same — they measure the same
   underlying signal (how much reality matches impressions).

5. **S operator creates, R updates.** Only the S operator (deep-reflect,
   LLM-mediated) can create new samskaras — articulating a pattern
   requires intelligence. The mechanical review phase only updates
   strengths on existing entries.

## KV Changes

- **New prefix:** `samskara:*` (protected tier)
- **Deleted prefixes:** `assumption:*`, `insight:*`, `prajna:*`, `upaya:*`, `mu:*`
- **Schema:** `{ pattern: string, strength: number }`

## Updated Equations

```
— Fast cycle —
A_{s_t, c_t}(d_t) = a_t

— Review (mechanical) —
σ_t = Surprise(s_t, c_{t+1})
α_t = Affinity(d_t, c_{t+1})
s_t' = EMA(s_t, σ_t, α_ema)
if salience(σ_t, α_t) > τ: ε ← ε ∪ {e_t}

— Deep-reflect —
S(ε, s_t') = s_{t+1}
D_p(ε, d_t) = d_{t+1}
```

## Design Lineage

This design evolved through several stages in one conversation:

1. Started with "add wisdom/insight operator" alongside assumptions
2. Discovered assumptions and insights can't be cleanly separated mathematically
3. Realized they're the same thing at different depths → samskaras
4. Realized μ (counters) can live on the entries themselves → no separate store
5. Realized R and E are computation, not operators → 3 operators instead of 7
6. Realized one EMA parameter handles both surprise and strength
7. Realized minimal schema is just {pattern, strength}

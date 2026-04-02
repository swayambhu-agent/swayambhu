# Cognitive Architecture Reference (v2)

The samskara model. Four entities, three operators, two memory stores.

Full spec: `swayambhu-cognitive-architecture.md` (root)

## Entities

| Symbol | Name | KV Prefix | Description |
|--------|------|-----------|-------------|
| p | Principles | `principle:*` | Immutable. 14 foundational truths. Shape desires. |
| d | Desires | `desire:*` | Approach/avoidance vectors. What the agent wants. |
| s | Samskaras | `samskara:*` | Impressions from experience. `{pattern, strength}`. |
| ε | Experiences | `experience:*` | Salient events. Raw material for S and D. |

## Operators

| Symbol | Name | When | What it does |
|--------|------|------|-------------|
| A | Act | Every session | `A_{s,c}(d) = a` — samskaras + circumstances on desires → action |
| S | Samskara | Deep-reflect | `S(ε, s) = s'` — create/deepen/erode/delete samskaras from experience patterns |
| D | Desire | Deep-reflect | `D_p(ε, d) = d'` — magnify experience through principles into desires |

Review (σ, α, strength updates, experience recording) is mechanical
computation, not an operator.

## Samskaras

Impressions left by experience (Sanskrit: संस्कार). Shallow ones fade,
deep ones shape everything. Same kind of thing at different depths.

Schema: `{ pattern: "...", strength: 0.85 }`

Two fields. Strength is an EMA (0-1):
- Confirmation (low surprise) → strength moves toward 1
- Violation (high surprise) → strength moves toward 0
- Untested → unchanged

One EMA parameter (`α_ema`) governs both surprise tracking and
samskara strength — same underlying signal.

Below deletion threshold → samskara is deleted.

Replaces: assumptions, insights, wisdom (prajna/upaya), statistical
memory (μ). All collapsed into one store, one lifecycle, one spectrum.

## Desires

Directional vectors with `direction: "approach" | "avoidance"`.

D is a magnification force, not a reasoning process. It takes experience
and amplifies: "I did X" → "do more X." Principles shape the direction
of magnification, not the force itself.

Samskaras do NOT feed into desire creation. Desire is force. Samskaras
are intelligence. They serve different roles.

## Experiences

Recorded when `salience = σ + |α| > threshold`.

Schema: `{ timestamp, action_taken, outcome, surprise_score, salience, narrative, embedding }`

No affinity vector stored (dissolves desire dimensionality problem).
The narrative carries qualitative meaning. The embedding enables retrieval.

## The Equations

### Fast Cycle (every session)
```
A_{s_t, c_t}(d_t) = a_t                    — act

σ_t = Surprise(s_t, c_{t+1})               — mechanical
α_t = Affinity(d_t, c_{t+1})               — mechanical
s_t' = EMA(s_t, σ_t, α_ema)               — mechanical
if salience(σ_t, α_t) > τ: ε ← ε ∪ {e_t}  — mechanical
```

### Slow Cycle (deep-reflect, on akash)
```
S(ε, s_t') = s_{t+1}                       — samskaras from experience
D_p(ε, d_t) = d_{t+1}                      — desires from experience through principles
```

## Cold Start

- s_0 = ∅ → everything is surprising (σ=1)
- First session records a high-salience experience
- Empty desires trigger DR immediately (isReflectDue)
- S and D bootstrap initial samskaras and desires from the first experience + principles

## Contradictory Samskaras

Coexist naturally, like "people are kind" and "strangers can be
dangerous." The circumstance resolves the conflict at act time —
embedding-based selection surfaces relevant samskaras, the LLM
reconciles them. No consistency enforcement needed.

## Organic Exploration

Deep-reflect is itself an experience. When the agent reflects and sees
the gap between its principles and its activity, D magnifies that into
a desire to broaden. Reflection scheduling (`after_sessions`, `after_days`)
tunes the exploration rate. No explicit exploration mechanism needed.

## Read/Write Isolation

| Entity | Read by | Written by |
|--------|---------|------------|
| Principles | Deep-reflect | None (immutable) |
| Samskaras | Plan, Review | Strength: Review (mechanical). Create/refine/delete: Deep-reflect (S) |
| Desires | Plan, Review | Deep-reflect (D) |
| Experiences | Deep-reflect | Review (conditional) |

Act sessions and deep-reflect can run concurrently. No locks needed.

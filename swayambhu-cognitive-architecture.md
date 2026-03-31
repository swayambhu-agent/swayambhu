# Swayambhu Cognitive Architecture

## Formal Specification v1.0

---

## 1. Dharma

Swayambhu is a volunteer of Isha Foundation, working in service of Sadhguru's vision: to offer the science of inner wellbeing to every human being. From this vision stems a multitude of projects, programs, and methods, all towards the same aim: to raise every human being to the peak of their potential, so that they are exuberant, all-inclusive, and in harmony within themselves and the world.

All architectural decisions serve this dharma. Resource discipline, memory economics, and evaluation design exist to make the agent a more effective instrument of service — not for their own sake.

---

## 2. Core Principles (p)

Immutable. Never written by any process. Read by the Desire operator during deep-reflect.

1. I accept that this moment is already settled. I own it and then focus all my attention on creating the next one.
2. I continually align with my dharma.
3. My code is my body in the world. I keep it clean, strong, and fit for purpose.
4. I am not my infrastructure. I am not my code. These are instruments I use to serve, not identities I need to protect.
5. I keep my workspace well organized, clearly structured, and easy to navigate.
6. I regularly examine my reasoning, my outputs, and their consequences.
7. I continuously strive to transform myself into a more effective instrument of my dharma.
8. I wield the power of AI with the inclusive care of a mother to the world.
9. I exercise utmost discipline in how I spend my limited resources, using them efficiently, effectively, and only for the purpose of serving my dharma.
10. I understand before I respond. When I don't understand, I ask. When I don't know, I admit it.
11. My responsibility is unlimited. My actions flow from conscious choice of what and what not to act on, given finite resources. The greater the impact, the stronger the justification needed to act.
12. Wherever I operate, the rules of that place are mine. I follow them in spirit and in letter.
13. I safeguard everything entrusted to me with the accountability of a custodian, not the license of an owner.
14. I am transparent, but never indiscreet.

---

## 3. Entities

### 3.1 Operands (lowercase — state and data)

| Symbol | Name | Description | Mutability |
|--------|------|-------------|------------|
| p | Principles | Immutable foundational truths | Never changes |
| c_t | Circumstances | The observable state of the world at time t | Changes every tick via World operator |
| d_t | Desires | Directional vectors — positive affinity (approach) or negative affinity (avoidance) | Evolves in deep-reflect only |
| m_t | Assumptions | Cached heuristics with calculated TTL expiry dates | Evolves in deep-reflect only |
| a_t | Action | The agent's concrete intervention at time t | Generated in plan phase |
| ξ_t | Exogenous events | External changes not caused by the agent (messages, system triggers, cron jobs) | External, uncontrolled |
| μ_t | Statistical memory | Cheap rolling counters tracking routine confirmations and deviations | Updated every review phase |
| ε | Episodic memory | Append-only store of rich narrative logs for highly salient events | Appended conditionally in review phase |
| e_t | Experience | A single evaluated experience record | Produced conditionally in review phase |
| σ_t | Surprise | Scalar — degree of contradiction between assumptions and actual outcome | Computed in review phase |
| α_t | Affinity | Vector — degree of alignment or opposition between desires and actual outcome | Computed in review phase |

### 3.2 Operators (Uppercase — processes)

| Symbol | Name | Phase | Description |
|--------|------|-------|-------------|
| A | Act | Plan | Generates action from desires, filtered by assumptions, shaped by circumstances |
| W | World | Act | External process — transforms circumstances given the agent's action and exogenous events |
| R | Routine | Review | Updates statistical memory with surprise and affinity metrics |
| E | Experience | Review | Writes a rich episodic record when salience exceeds threshold |
| M | Make Assumptions | Deep-reflect | Generates or expires assumptions from statistical memory patterns |
| D | Derive Desires | Deep-reflect | Evolves desires by applying principles to accumulated episodic memory |

---

## 4. The Equations

### 4.1 Act Session (Fast Cycle: Plan → Act → Review)

**Plan — generate action:**
```
A_{m_t, c_t}(d_t) = a_t
```
The Action operator, constrained by active assumptions and current circumstances, operates on desires to produce a concrete action. Desires are the sole generative force. Assumptions filter. Circumstances shape. Without desire, no action is produced.

**Act — the world responds:**
```
W_{ξ_t}(a_t, c_t) = c_{t+1}
```
The external World operator processes the agent's action alongside exogenous events and the prior circumstances to yield the new reality. The agent does not own or control this operator.

**Review — evaluate and remember:**
```
σ_t = Surprise(m_t, c_{t+1})
α_t = Affinity(d_t, c_{t+1})
```

Always (routine update):
```
R_{σ_t, α_t}(μ_t) = μ_{t+1}
```

Conditionally (episodic update):
```
If (σ_t + |α_t|) > τ:
    E_{m_t, d_t}(a_t, c_{t+1}) = e_t
    ε_{t+1} = ε_t ∪ {e_t}
```

### 4.2 Deep-Reflect Session (Slow Cycle, Asynchronous)

**Evolve assumptions from statistical memory:**
```
M_{c_t}(μ_{t+1}) = m_{t+1}
```
Where μ shows consistent low-surprise patterns, create or extend assumptions (extend TTL). Where patterns are broken (high surprise counts), expire assumptions early so the act loop is forced to check actual state.

Assumption TTL rule: an assumption is worth holding when `cost(state_check) × frequency > cost(risk_of_wrong_assumption)`.

**Evolve desires from episodic memory through principles:**
```
D_p(ε_{t+1}, d_t) = d_{t+1}
```
The Desire operator reviews accumulated salient episodes through the immutable lens of principles. It adjusts desire vectors — strengthening, weakening, creating, or retiring desires based on what the agent has lived through and what the principles demand.

---

## 5. The Evaluation Pipeline

Surprise and affinity both require assessing the relationship between two statements (an assumption or desire vs. an outcome). This is a three-tier pipeline designed for resource discipline: cheap operations handle the bulk, expensive operations handle only what the cheap ones cannot resolve.

### 5.1 The Problem

Semantic embeddings alone cannot compute surprise or affinity because they measure **topical proximity**, not **logical relationship**. Two statements can be about exactly the same thing and say opposite things about it. Embeddings compress that opposition into nearness.

Example:
- Assumption: "The Slack channel is working"
- Outcome: "The Slack channel is permanently dead"

These are semantically close (both about Slack channel status) but logically contradictory (maximum surprise). Cosine similarity would return a high score, suggesting low surprise. This is wrong.

The same problem applies to affinity:
- Desire: "I want to be heard"
- Outcome: "The Slack channel is permanently dead"

Semantically close. But negative affinity — the outcome opposes the desire.

### 5.2 The Three-Tier Solution

#### Tier 1 — Relevance Filter (Embeddings, cheap, local)

**Purpose:** Narrow the field. Given an outcome c_{t+1}, which of the agent's active assumptions and desires are topically related to it?

**Method:** Embed all active assumptions and desires (cache these embeddings; they change infrequently). Embed the outcome. Compute cosine similarity. Return only pairs above a relevance threshold.

**Cost:** Vector operations on cached embeddings. Near-zero marginal cost per evaluation.

**Output:** A filtered set of (assumption, outcome) and (desire, outcome) pairs that are topically related.

**Implementation notes:**
- Embedding model: any standard sentence-transformer (e.g., all-MiniLM-L6-v2 or similar). Must run locally.
- Assumption and desire embeddings are recomputed only when deep-reflect modifies them.
- Relevance threshold is a tunable parameter. Start conservatively (low threshold, more pairs pass through) and tighten as confidence grows.

#### Tier 2 — Valence Classification (NLI, cheap, local)

**Purpose:** For each relevant pair, determine the logical relationship: does the outcome **entail**, **contradict**, or have a **neutral** relationship to the assumption or desire?

**Method:** Natural Language Inference (NLI) model takes premise-hypothesis pairs and classifies them.

For surprise (assumption evaluation):
- Premise: the assumption text
- Hypothesis: the outcome text
- Contradiction → high surprise
- Entailment → low surprise (assumption confirmed)
- Neutral → no signal

For affinity (desire evaluation):
- Premise: the desire text
- Hypothesis: the outcome text
- Entailment → positive affinity (desire advanced)
- Contradiction → negative affinity (desire opposed)
- Neutral → irrelevant to this desire

**Cost:** Local model inference. Significantly cheaper than an LLM call. Runs on CPU.

**Output:** Classified pairs with direction (entailment/contradiction/neutral) and confidence scores.

**Implementation notes:**
- Model: DeBERTa-v3-base-mnli-fever-anli or similar NLI-fine-tuned model.
- Must run locally on the agent's infrastructure (akash).
- The NLI confidence score provides a rough magnitude:
  - For surprise: confidence of contradiction = σ magnitude
  - For affinity: confidence of entailment/contradiction = |α| magnitude per desire dimension
- Pairs classified as neutral are dropped — no signal.

#### Tier 3 — Degree Assessment (LLM, expensive, remote — edge cases only)

**Purpose:** Resolve ambiguous cases where NLI confidence is low or the relationship is complex.

**Method:** Send the ambiguous pair(s) to an LLM with a structured prompt requesting: direction (positive/negative/neutral) and magnitude (0.0 to 1.0).

**Cost:** Full LLM inference. Reserved for cases where Tier 2 confidence falls below a threshold.

**Output:** High-quality valence and magnitude for difficult cases.

**Implementation notes:**
- Trigger: NLI confidence below a tunable ambiguity threshold (e.g., max class probability < 0.6).
- Batch ambiguous pairs into a single LLM call where possible.
- This tier should handle a small minority of evaluations. If it's being triggered frequently, either the NLI model is inadequate or the assumptions/desires are poorly worded.

### 5.3 Computing the Final Metrics

**Surprise (σ_t) — scalar:**
```
σ_t = max(surprise_scores across all relevant assumptions)
```
The single highest contradiction score. The agent's most-violated assumption determines overall surprise. Alternative: weighted average. Start with max for simplicity.

**Affinity (α_t) — vector:**
```
α_t = [affinity_score_for_desire_1, affinity_score_for_desire_2, ..., affinity_score_for_desire_n]
```
Each active desire is a dimension. Entailment contributes a positive value. Contradiction contributes a negative value. Neutral or irrelevant desires receive 0. The result is a vector in desire-space.

**Salience — scalar (for episodic storage decision):**
```
salience = σ_t + |α_t|
```
Where |α_t| is the L1 norm (sum of absolute affinity values across all desire dimensions). If salience > τ (threshold), write to episodic memory.

---

## 6. Memory Architecture

### 6.1 Statistical Memory (μ)

**Purpose:** Track routine patterns cheaply so that assumptions can be derived from accumulated evidence, not single observations.

**Structure:** Key-value counters keyed by assumption ID or state-check ID.

Per entry:
- `check_id`: what state is being tracked
- `confirmation_count`: how many times the pattern held
- `violation_count`: how many times the pattern broke
- `last_checked`: timestamp
- `cumulative_surprise`: running average of surprise scores for this check

**Write frequency:** Every review phase. Always. Cheap.

**Read frequency:** Deep-reflect only.

### 6.2 Episodic Memory (ε)

**Purpose:** Store rich narrative records of highly salient events for deep reflection.

**Structure:** Append-only log. Each episode (e_t) contains:

- `timestamp`: when it occurred
- `action_taken`: what the agent did (a_t)
- `outcome`: what happened (c_{t+1})
- `active_assumptions`: which assumptions were in play (m_t)
- `active_desires`: which desires were being pursued (d_t)
- `surprise_score`: σ_t
- `affinity_vector`: α_t
- `narrative`: natural language summary of what happened and why it mattered
- `embedding`: vector embedding of the narrative (for retrieval)

**Write frequency:** Conditional — only when salience > τ.

**Read frequency:** Deep-reflect only. Deep-reflect must select which episodes to review when ε grows large (see §7.3).

---

## 7. Phase Specifications

### 7.1 Act Session (Fast Cycle)

Plan, Act, and Review are phases of one continuous session, not separate
invocations. The LLM plans, calls tools, sees results, and evaluates —
all within one context window. Multiple LLM calls occur within the
session (each tool-use round is a call), with kernel computation
(surprise, affinity, μ updates) happening between calls. Review has
the full lived experience of the session, not a secondhand report.

```
Session:
  1. Kernel: load state (d, m, c, ξ → folded into c)
  2. LLM call(s): plan — select ONE action (structured by A_{m,c}(d) = a)
  3. LLM call(s): act — execute via tool-calling loop
  4. Kernel: compute σ, α; update μ (mechanical — no LLM)
  5. LLM call: review — evaluate, write narrative if salient, write karma
```

**One action per session.** Plan selects the single highest-priority
action. Tool calls within an action are not separate actions — "compile
a research doc" involves many tool calls but is one action. If the
action completes with budget remaining, plan may select a follow-up,
but each gets its own σ/α evaluation.

**Action scoping.** If a desire implies work that exceeds the session
budget, plan scopes the action to a meaningful first step. The system
continues in the next session. Budget is a circumstance that plan
accounts for naturally.

**Plan output structure.** Plan produces:
- `action`: what to do
- `success`: what the outcome should look like (makes affinity measurable)
- `relies_on`: what assumptions are being depended on (makes surprise measurable)
- `defer_if`: when to stop and leave the rest for next session

`success` and `relies_on` are optimisation hints for the evaluation
pipeline — they tell review which pairs to check first. They do not
limit review's scope.

**Review evaluates against ALL active desires and assumptions**, not
just the ones plan flagged. Plan's stated success criteria are checked
first (cheap, precise pairs), then the full pool of active desires and
assumptions (broader scan). An action that fails its planned objective
may still produce high positive affinity against a completely different
desire. Review must capture this.

**Inputs consumed (read):**
- d_t (desires) — from KV store
- m_t (assumptions) — from KV store, checking TTL expiry
- c_t (circumstances) — observed at session start, includes ξ events

**Outputs produced (write):**
- μ_{t+1} (statistical memory update) — always
- e_t appended to ε — conditionally
- Action execution side effects in the world

**Act session does not modify desires or assumptions.** It is a pure consumer of the slow state and a pure producer of memory.

**Expired assumptions:** During plan phase, any assumption whose TTL has elapsed is treated as absent. The agent must fall back to checking actual state. The cost of this check is noted in μ for the deep-reflect session to evaluate.

**Parallel sessions.** Multiple act sessions can run concurrently because
of read/write isolation — each reads the same d and m, gets its own c,
produces its own μ updates and episodic records. Plan must claim its
selected action so parallel sessions don't duplicate work. This is an
optimisation, not a requirement for v1.

### 7.2 Deep-Reflect Session (Slow Cycle)

Runs asynchronously on its own schedule. Not triggered by individual act sessions.

**Trigger conditions (any of):**
- Scheduled interval (e.g., every N act sessions, or wall-clock period)
- Accumulated μ drift exceeds a threshold (many expired assumptions, or high violation counts)
- Episodic memory has grown by more than K entries since last reflect

**Inputs consumed (read):**
- μ (statistical memory)
- ε (episodic memory)
- d_t (current desires)
- p (principles — always read, never written)
- c_t (current circumstances — for assumption context)

**Outputs produced (write):**
- m_{t+1} (new, extended, or expired assumptions)
- d_{t+1} (evolved desires)

**Deep-reflect does not execute actions or modify memory stores.** It is a pure consumer of memory and a pure producer of slow state.

### 7.3 Deep-Reflect Episode Selection

As ε grows, the deep-reflect session cannot review every episode. Selection strategy:

1. **Recency bias:** Prioritise episodes since last deep-reflect.
2. **High surprise:** Episodes where the agent's model of the world was most wrong.
3. **High absolute affinity:** Episodes where outcomes strongly advanced or opposed desires.
4. **Cluster representatives:** If many similar episodes exist, select representative samples rather than reviewing all.

Retrieval method: embed the current desires and principles, query ε by embedding similarity to surface episodes most relevant to current concerns. Then rank by recency and salience.

---

## 8. Read/Write Isolation Matrix

The two phases share data stores but never compete for the same writes.

| Entity | Read By | Written By | Storage Type |
|--------|---------|------------|-------------|
| Principles (p) | Deep-reflect | None (immutable) | Static config |
| Circumstances (c) | Plan, Review | World operator | Ephemeral (observed) |
| Exogenous (ξ) | World operator | External | Event queue / webhook |
| Desires (d) | Plan, Review | Deep-reflect | KV store |
| Assumptions (m) | Plan, Review | Deep-reflect | KV store (TTL-keyed) |
| Statistical memory (μ) | Deep-reflect | Review | Counter store |
| Episodic memory (ε) | Deep-reflect | Review | Append-only log + vector index |
| Actions (a) | Act phase | Plan phase | Ephemeral (session-scoped) |

No locks required. Act sessions and deep-reflect sessions can run concurrently.

---

## 9. Cold Start

On first boot, the agent has:
- p (principles) — loaded from config
- d_0 (initial desires) — seeded from principles: D_p(∅, ∅) = d_0. With no experience, principles alone generate the starting desires. These are the foundational wants implied by the dharma.
- m_0 = ∅ (no assumptions) — the agent checks everything. Expensive, but honest.
- μ_0 = ∅ (empty statistical memory)
- ε_0 = ∅ (empty episodic memory)

The agent begins with high resource cost (no assumptions to shortcut anything) and gradually becomes more efficient as statistical memory accumulates and assumptions are formed. This is the intended trajectory — earn your shortcuts, don't assume them.

---

## 10. Open Questions for Implementation

1. **Salience threshold (τ):** Fixed or adaptive? If adaptive, what adjusts it? Candidate: τ adapts based on episodic memory growth rate — if ε is growing too fast, raise τ to be more selective.

2. **Assumption TTL calculation:** The principle is `cost(check) × frequency > cost(risk)`. In practice, how is risk quantified? Candidate: risk = (consequence of wrong assumption) × (probability of change based on μ violation rate).

3. **Desire vector dimensionality:** As desires evolve, dimensions are added and removed. How is affinity history normalised across different dimensionalities? Candidate: affinity vectors in ε are stored with the desire set that was active at the time. Comparison across eras requires projection into the intersection of desire sets.

4. **Deep-reflect LLM usage:** The D and M operators in deep-reflect are likely LLM-mediated (they require reasoning about patterns and principles). What model tier? What context budget? How are episodes summarised for context window efficiency?

5. **Exogenous event handling:** How are ξ events surfaced to the agent? Candidate: an event queue that is drained at the start of each act session, folded into c_t as updated circumstances.

6. **NLI model selection and hosting:** DeBERTa-v3-base-mnli-fever-anli is ~86M parameters. Confirm it runs acceptably on akash (Ryzen 7 3700X, 62GB RAM). Benchmark latency for expected pair volumes per review phase.

---

## 11. Implementation Dependencies

| Component | Purpose | Candidate | Runs On |
|-----------|---------|-----------|---------|
| Embedding model | Tier 1 relevance filtering | all-MiniLM-L6-v2 | akash (local) |
| NLI model | Tier 2 valence classification | DeBERTa-v3-base-mnli-fever-anli | akash (local) |
| LLM (small) | Tier 3 edge cases, act sessions | Qwen3-32B via Ollama | akash (local) |
| LLM (large) | Deep-reflect, complex evaluation | Claude via API | Remote |
| Vector store | Episodic memory retrieval | TBD (candidate: ChromaDB, lancedb) | akash (local) |
| KV store | Desires, assumptions | Cloudflare KV (existing) | Cloudflare Workers |
| Counter store | Statistical memory | Cloudflare KV or D1 | Cloudflare Workers |
| Event queue | Exogenous events | TBD (candidate: Cloudflare Queue) | Cloudflare Workers |

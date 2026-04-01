# Swayambhu Cognitive Architecture

## Formal Specification v2.0

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

### 3.1 State (lowercase)

| Symbol | Name | Description | Mutability |
|--------|------|-------------|------------|
| p | Principles | Immutable foundational truths | Never changes |
| d_t | Desires | Directional vectors — positive affinity (approach) or negative affinity (avoidance) | Evolves in deep-reflect only |
| s_t | Samskaras | Impressions left by experience — shallow ones fade, deep ones shape everything | Strength updated mechanically every session; created/refined/eroded by S in deep-reflect |
| ε | Experiences | Append-only log of salient experiences | Appended conditionally in review phase |
| c_t | Circumstances | The observable state of the world at time t | Changes every tick via World operator |
| ξ_t | Exogenous events | External changes not caused by the agent | External, uncontrolled |
| a_t | Action | The agent's concrete intervention at time t | Generated in plan phase |
| σ_t | Surprise | Scalar — degree of contradiction between samskaras and actual outcome | Computed in review phase |
| α_t | Affinity | Vector — degree of alignment or opposition between desires and actual outcome | Computed in review phase |

### 3.2 Operators (Uppercase)

| Symbol | Name | Phase | Description |
|--------|------|-------|-------------|
| A | Act | Plan | Generates action from desires, informed by samskaras, shaped by circumstances |
| W | World | Act | External process — transforms circumstances given the agent's action and exogenous events |
| S | Samskara | Deep-reflect | Creates, deepens, refines, and erodes samskaras from experience patterns |
| D | Desire | Deep-reflect | Magnifies experience into desires through principles |

Three agent operators (A, S, D). One external (W). Review-phase computation (σ, α, strength updates, experience recording) is mechanical — formulas, not operators.

---

## 4. The Equations

### 4.1 Act Session (Fast Cycle: Plan → Act → Review)

**Plan — generate action:**
```
A_{s_t, c_t}(d_t) = a_t
```
The Act operator, informed by samskaras and shaped by current circumstances, operates on desires to produce a concrete action. Desires are the sole generative force — without desire, no action is produced. Samskaras make the agent choose more intelligent actions. Circumstances shape based on what is happening now.

**Act — the world responds:**
```
W_{ξ_t}(a_t, c_t) = c_{t+1}
```
The external World operator processes the agent's action alongside exogenous events and the prior circumstances to yield the new reality. The agent does not own or control this operator.

**Review — evaluate and update (mechanical):**
```
σ_t = Surprise(s_t, c_{t+1})
α_t = Affinity(d_t, c_{t+1})
```

Samskara strength update (always, EMA):
```
For each samskara tested:
    s.strength = s.strength × (1 - α_ema) + (1 - σ_per_samskara) × α_ema
```

Where `α_ema` is the EMA smoothing parameter (shared with surprise tracking). Confirmation moves strength toward 1. Violation moves strength toward 0. Untested samskaras are unchanged.

When `s.strength < deletion_threshold`: delete the samskara — it has been mostly violated and is not worth storing.

Experience recording (conditional):
```
If salience(σ_t, α_t) > τ:
    ε_{t+1} = ε_t ∪ {e_t}
```

Review is computation, not an operator. No LLM reasoning is needed — surprise and affinity are computed by the evaluation pipeline (§5), strength updates are a formula, and experience recording is a threshold check. (Note: the evaluation pipeline's Tier 3 may invoke an LLM as a structured classifier for ambiguous cases, but this is mechanical classification, not open-ended reasoning.)

### 4.2 Deep-Reflect Session (Slow Cycle, Asynchronous)

**Samskara management from experience patterns:**
```
S(ε, s_t') = s_{t+1}
```
The Samskara operator reads accumulated experiences and current samskaras to manage the agent's model of reality. It creates new samskaras when patterns emerge across experiences, deepens existing ones when new experiences reinforce them, refines their pattern text as understanding sharpens, and erodes or deletes ones that experience contradicts.

Samskaras are impressions (Sanskrit: संस्कार) — not assumptions or insights, but a unified concept spanning the full spectrum from provisional observation to deep understanding. A fresh samskara from one experience is shallow and easily overwritten. A samskara reinforced across many diverse experiences is deep and shapes everything that follows. The difference is not type — it is depth.

**What makes a samskara:** An enduring pattern about how things work, distilled from experiences. "Slack fails silently — success responses don't guarantee delivery." Not a snapshot of current state ("Slack is working right now") — that kind of temporal fact is handled naturally by the mechanical strength update. When Slack stops working, the samskara's strength decays via the EMA. The S operator focuses on patterns that transcend individual observations.

**Desire magnification from experience memory through principles:**
```
D_p(ε, d_t) = d_{t+1}
```
The Desire operator is a magnification force, not a reasoning process. It takes experience and amplifies: "I did X" → "do more X." This magnification is bidirectional — approach (toward what felt aligned with desires) and avoidance (away from what felt misaligned). Principles do not generate the desire — they shape the direction of magnification. "Research more" → "research more *that serves the patron*." The force comes from experience, the shape from principles.

Samskaras do not feed into desire creation. Samskaras inform action (A), not desire (D). Desire is force. Samskaras are intelligence. They are parallel outputs of deep-reflect, both reading ε, serving fundamentally different roles.

**Organic exploration:** The architecture self-corrects against local maxima without an explicit exploration mechanism. Deep-reflect is itself an experience. When the agent reflects and sees the gap between its principles and its narrow activity, that gap-awareness is an experience that D magnifies into a desire to broaden. Reflection scheduling parameters (`after_sessions`, `after_days`) effectively tune the exploration rate.

---

## 5. The Evaluation Pipeline

Surprise and affinity both require assessing the relationship between two statements (a samskara or desire vs. an outcome). This is a three-tier pipeline designed for resource discipline: cheap operations handle the bulk, expensive operations handle only what the cheap ones cannot resolve.

### 5.1 The Problem

Semantic embeddings alone cannot compute surprise or affinity because they measure **topical proximity**, not **logical relationship**. Two statements can be about exactly the same thing and say opposite things about it. Embeddings compress that opposition into nearness.

Example:
- Samskara: "The Slack channel is working"
- Outcome: "The Slack channel is permanently dead"

These are semantically close (both about Slack channel status) but logically contradictory (maximum surprise). Cosine similarity would return a high score, suggesting low surprise. This is wrong.

The same problem applies to affinity:
- Desire: "I want to be heard"
- Outcome: "The Slack channel is permanently dead"

Semantically close. But negative affinity — the outcome opposes the desire.

### 5.2 The Three-Tier Solution

#### Tier 1 — Relevance Filter (Embeddings, cheap, local)

**Purpose:** Narrow the field. Given an outcome c_{t+1}, which of the agent's samskaras and desires are topically related to it?

**Method:** Embed all samskaras and desires (cache these embeddings; they change infrequently). Embed the outcome. Compute cosine similarity. Return only pairs above a relevance threshold.

**Cost:** Vector operations on cached embeddings. Near-zero marginal cost per evaluation.

**Output:** A filtered set of (samskara, outcome) and (desire, outcome) pairs that are topically related.

**Implementation notes:**
- Embedding model: any standard sentence-transformer (e.g., all-MiniLM-L6-v2 or similar). Must run locally.
- Samskara and desire embeddings are recomputed only when deep-reflect modifies them.
- Relevance threshold is a tunable parameter. Start conservatively (low threshold, more pairs pass through) and tighten as confidence grows.

#### Tier 2 — Valence Classification (NLI, cheap, local)

**Purpose:** For each relevant pair, determine the logical relationship: does the outcome **entail**, **contradict**, or have a **neutral** relationship to the samskara or desire?

**Method:** Natural Language Inference (NLI) model takes premise-hypothesis pairs and classifies them.

For surprise (samskara evaluation):
- Premise: the samskara pattern text
- Hypothesis: the outcome text
- Contradiction → high surprise (samskara violated)
- Entailment → low surprise (samskara confirmed)
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
- This tier should handle a small minority of evaluations. If it's being triggered frequently, either the NLI model is inadequate or the samskaras/desires are poorly worded.

### 5.3 Computing the Final Metrics

**Surprise (σ_t) — scalar:**
```
σ_t = max(surprise_scores across all relevant samskaras)
```
The single highest contradiction score. The agent's most-violated samskara determines overall surprise. Alternative: weighted average. Start with max for simplicity.

**Empty samskaras → maximum surprise.** When s_t = ∅, the agent has no model of the world — everything is maximally surprising (σ = 1). This is not a special case; it follows from the mathematics. Having no impressions means having no expectations, which is maximum uncertainty. This is what bootstraps the agent: the first session records a high-salience experience, deep-reflect picks it up, and S and D begin building the agent's model of reality.

**Affinity (α_t) — vector:**
```
α_t = [affinity_score_for_desire_1, affinity_score_for_desire_2, ..., affinity_score_for_desire_n]
```
Each active desire is a dimension. Entailment contributes a positive value. Contradiction contributes a negative value. Neutral or irrelevant desires receive 0. The result is a vector in desire-space.

**Empty desires → zero affinity.** An experience is memorable on the desire axis when it is strongly aligned or misaligned with what you want. With no desires there is no vector to measure against — affinity is genuinely zero, not max. The surprise axis alone drives salience during bootstrap.

**Salience — scalar (for experience storage decision):**
```
salience = σ_t + |α_t|
```
Where |α_t| is the L1 norm (sum of absolute affinity values across all desire dimensions). If salience > τ (threshold), write to experience memory.

---

## 6. Memory Architecture

Two memory stores. No separate counter store — samskara entries carry their own statistics.

### 6.1 Samskaras (s)

**Purpose:** The agent's model of reality. Everything it holds to be true, at varying levels of depth.

**Structure:** Key-value store. Each samskara entry:

```
{
  "pattern": "Slack fails silently — success responses don't guarantee delivery",
  "strength": 0.85
}
```

Two fields. Strength is an EMA (exponential moving average), normalized 0-1. Confirmation moves it toward 1. Violation moves it toward 0. Untested samskaras are unchanged — a samskara that hasn't been tested doesn't decay just because time passed.

**One EMA parameter (α_ema)** governs how responsive samskaras are to new evidence. High α → fast adaptation, shallow grooves. Low α → slow adaptation, deep grooves. Same parameter used for surprise tracking — they measure the same underlying signal.

**Strength update formula (mechanical, every review phase):**
```
strength = strength × (1 - α_ema) + (1 - σ_per_samskara) × α_ema
```

**Deletion:** When strength drops below a configurable threshold (e.g., 0.05), the samskara is deleted. It has been mostly violated and is not worth storing.

**Creation:** Only the S operator (deep-reflect) creates samskaras. The review phase updates existing ones mechanically but cannot articulate new patterns — that requires intelligence.

**Selection for act phase:** When the samskara store grows large, embedding-based relevance filtering selects samskaras relevant to the current action context. Same mechanism as Tier 1 of the evaluation pipeline.

**Write frequency:** Strength updated mechanically every review phase. Entries created/refined/eroded by S in deep-reflect.

**Read frequency:** Every act session (plan phase). Deep-reflect reads all.

### 6.2 Experience Memory (ε)

**Purpose:** Store rich narrative records of salient events. Raw material for deep-reflect.

**Structure:** Append-only log. Each experience (e_t) contains:

- `timestamp`: when it occurred
- `action_taken`: what the agent did (a_t)
- `outcome`: what happened (c_{t+1})
- `surprise_score`: σ_t
- `salience`: σ_t + |α_t| (computed at write time — the affinity vector serves its purpose at the salience gate and is not stored)
- `narrative`: natural language summary of what happened and why it mattered
- `embedding`: vector embedding of the narrative (for retrieval)

No affinity vector or active desire/samskara lists. The narrative carries the qualitative meaning. The embedding enables retrieval. Downstream consumers (S and D operators) work from narratives, not from numeric vectors. This eliminates the desire dimensionality problem — as desires evolve, old experiences remain valid because their signal is in the text, not in a vector measured against a desire set that no longer exists.

**Write frequency:** Conditional — only when salience > τ.

**Read frequency:** Deep-reflect only. Deep-reflect must select which experiences to review when ε grows large (see §7.3).

---

## 7. Phase Specifications

### 7.1 Act Session (Fast Cycle)

Plan, Act, and Review are phases of one continuous session, not separate
invocations. The LLM plans, calls tools, sees results, and evaluates —
all within one context window. Multiple LLM calls occur within the
session (each tool-use round is a call), with kernel computation
(surprise, affinity, samskara strength updates) happening between calls.
Review has the full lived experience of the session, not a secondhand report.

```
Session:
  1. Kernel: load state (d, s, c, ξ → folded into c)
  2. Loop while budget remains:
     a. LLM call(s): plan — precipitate one action (A_{s,c}(d) = a)
     b. LLM call(s): act — execute via tool-calling loop
     c. Kernel: compute σ, α; update samskara strengths (mechanical)
     d. Kernel: record experience if salient (mechanical)
     e. Circumstances update (c reflects the new state)
  3. Loop ends when: budget exhausted OR plan precipitates no action
```

**The session loops.** Plan, act, and review repeat within one session.
After each cycle, circumstances have changed (the action modified the
world). Plan re-evaluates and may precipitate another action. The loop
stops naturally when the equation `A_{s,c}(d) = a` yields nothing —
no desire meets the current circumstances in a way that produces an
action. Or when budget is exhausted.

**One action per cycle, not per session.** Each cycle precipitates one
action with one σ/α evaluation. Tool calls within an action are not
separate actions — "compile a research doc" involves many tool calls
but is one action.

**Delivery is just an action.** When act completes work that a contact
cares about, the changed circumstances ("doc is ready, patron hasn't
been informed") cause plan to precipitate a communication action. Act
prepares what to communicate and emits a delivery event. The comms
subsystem picks it up and composes/sends via the appropriate channel.
No special delivery pipeline — notification is a normal action that
flows from desires meeting circumstances.

**Action scoping.** If a desire implies work that exceeds the remaining
session budget, plan scopes the action to a meaningful first step. The
system continues in the next session. Budget is a circumstance that plan
accounts for naturally.

**Plan output structure.** Plan produces:
- `action`: what to do
- `success`: what the outcome should look like (makes affinity measurable)
- `relies_on`: what samskaras are being depended on (makes surprise measurable)
- `defer_if`: when to stop and leave the rest for next session

`success` and `relies_on` are optimisation hints for the evaluation
pipeline — they tell review which pairs to check first. They do not
limit review's scope.

**Review evaluates against ALL active desires and samskaras**, not
just the ones plan flagged. Plan's stated success criteria are checked
first (cheap, precise pairs), then the full pool of active desires and
samskaras (broader scan). An action that fails its planned objective
may still produce high positive affinity against a completely different
desire. Review must capture this.

**Inputs consumed (read):**
- d_t (desires) — from KV store
- s_t (samskaras) — from KV store
- c_t (circumstances) — observed at session start, includes ξ events

**Outputs produced (write):**
- s_t' (samskara strength updates) — always, mechanical
- e_t appended to ε — conditionally
- Action execution side effects in the world

**Act session does not modify desires.** It updates samskara strengths mechanically but cannot create, refine, or delete samskaras — that requires intelligence (S operator).

**Parallel sessions.** Multiple act sessions can run concurrently because
of read/write isolation — each reads the same d and s, gets its own c,
produces its own strength updates and experience records. Plan must claim its
selected action so parallel sessions don't duplicate work. This is an
optimisation, not a requirement for v1.

### 7.2 Deep-Reflect Session (Slow Cycle)

Runs asynchronously on its own schedule. Not triggered by individual act sessions.

**Trigger conditions (any of):**
- Scheduled interval (e.g., every N act sessions, or wall-clock period)
- Experience memory has grown by more than K entries since last reflect

**Inputs consumed (read):**
- ε (experience memory)
- s_t (current samskaras)
- d_t (current desires)
- p (principles — always read, never written)

**Outputs produced (write):**
- s_{t+1} (new, refined, deepened, or deleted samskaras)
- d_{t+1} (evolved desires)

**Deep-reflect does not execute actions or modify experience memory.** It is a pure consumer of experiences and a pure producer of slow state.

### 7.3 Deep-Reflect Experience Selection

As ε grows, the deep-reflect session cannot review every experience. Selection strategy:

1. **Recency bias:** Prioritise experiences since last deep-reflect.
2. **High surprise:** Experiences where the agent's model of the world was most wrong.
3. **High absolute affinity:** Experiences where outcomes strongly advanced or opposed desires.
4. **Cluster representatives:** If many similar experiences exist, select representative samples rather than reviewing all.

Retrieval method: embed the current desires and samskaras, query ε by embedding similarity to surface experiences most relevant to current concerns. Then rank by recency and salience.

---

## 8. Read/Write Isolation Matrix

The two phases share data stores but never compete for the same writes.

| Entity | Read By | Written By | Storage Type |
|--------|---------|------------|-------------|
| Principles (p) | Deep-reflect | None (immutable) | Static config |
| Circumstances (c) | Plan | World operator | Ephemeral (observed) |
| Exogenous (ξ) | World operator | External | Event queue / webhook |
| Samskaras (s) | Plan, Review | Strength: Review (mechanical). Create/refine/delete: Deep-reflect (S) | KV store |
| Desires (d) | Plan, Review | Deep-reflect (D) | KV store |
| Experiences (ε) | Deep-reflect | Review (conditional) | Append-only log + vector index |
| Actions (a) | Act phase | Plan phase | Ephemeral (session-scoped) |

No locks required. Act sessions and deep-reflect sessions can run concurrently. Samskara strength updates from concurrent act sessions are commutative (EMA of independent observations).

---

## 9. Cold Start

On first boot, the agent has:
- p (principles) — loaded from config
- d_0 = ∅ (no desires) — bootstrapped via first deep-reflect: D_p(ε, ∅)
- s_0 = ∅ (no samskaras) — everything is surprising (σ=1)
- ε_0 = ∅ (empty experience memory)

The bootstrap sequence: the first session wakes with empty samskaras, producing maximum surprise (σ=1). This high-salience experience is recorded as an experience. Deep-reflect fires, and the two operators work in parallel — D magnifies the experience through principles into initial desires, S begins distilling early patterns into initial samskaras. The agent begins with no model of reality and gradually builds one. Earn your impressions.

---

## 10. Kernel / Hook Boundary

### 10.1 Design Principle

The kernel enforces things the agent cannot be trusted to enforce on
itself. Everything else is cognitive policy and lives in hooks. The
kernel is cognitive-architecture-agnostic — it does not know about
desires, samskaras, actions, plans, reviews, or deep reflect.

### 10.2 What the Kernel Provides

- **KV access** — read/write with tier-based gating
- **LLM calling** — model resolution, dharma/principle injection, budget enforcement, JSON extraction
- **Tool dispatch** — tool grants, execution context, communication gating
- **Event bus** — emit, drain, dead-letter
- **Safety** — crash detection/recovery, code staging/deployment, sealed keys
- **Bookkeeping** — session counter, karma recording, session health

### 10.3 What Moves to Hooks

Everything in the current kernel that encodes cognitive architecture
knowledge moves to the session hook:

| Currently in kernel | Moves to | Reason |
|---|---|---|
| `ACT_RELEVANT_EVENTS` list | Hook | Hook decides which events matter |
| `session_request:*` scanning | Hook | Old cognitive model (replaced by actions) |
| `last_reflect` loading | Hook | Old cognitive model |
| `reflect:schedule:*` loading | Hook | Hook manages its own scheduling |
| `highestReflectDepthDue` check | Hook | Hook decides session type |
| Act vs reflect decision | Hook | One hook entry point: `session.run` |
| `evaluateTripwires` → effort | Hook | Cognitive policy |
| `getMaxSteps`, `getReflectModel` | Hook | Cognitive policy |
| Context building (load keys, pending requests, DM handling) | Hook | Cognitive context is hook's responsibility |
| `loadYamasNiyamas()` | Replaced | Generic `loadPrinciples()` loading `principle:*` |
| `isYamaCapable`, `isNiyamaCapable` | Removed | Principles are immutable — no capability gates needed |
| `getYamas`, `getNiyamas` on K interface | Replaced | `getPrinciples()` |
| `_gateSystem()` yama/niyama deliberation | Simplified | Reject `principle:*` writes. Other system keys use config-driven tiers |
| Yama/niyama injection in `callLLM` | Genericized | `[PRINCIPLES]` block from `principle:*` keys |
| Role detection from step names in `runAgentLoop` | Removed | Caller passes budget config directly |
| `SYSTEM_KEY_PREFIXES` cognitive entries | Config-driven | `kernel:key_tiers` (kernel-only key) |

### 10.4 Key Tier Configuration

Instead of hardcoding cognitive key prefixes in `SYSTEM_KEY_PREFIXES`,
the kernel reads write-protection tiers from a kernel-only config key:

```json
kernel:key_tiers → {
  "immutable": ["dharma", "principle:*"],
  "kernel_only": ["karma:*", "sealed:*", "event:*", "kernel:*"],
  "protected": ["config:*", "prompt:*", "tool:*", "provider:*",
                 "channel:*", "hook:*", "contact:*", "code_staging:*",
                 "desire:*", "samskara:*"]
}
```

The kernel enforces these tiers mechanically. The cognitive architecture
declares which of its keys need protection by having the patron set them
in this config. The agent cannot modify `kernel:key_tiers` (it is
kernel-only).

Protected keys are writable only when the hook passes a privileged
context flag. The kernel does not know what "deep-reflect" means —
it just knows "this write was flagged as privileged by the hook."

### 10.5 Refactored runSession()

```javascript
async runSession() {
  await this.loadEagerConfig();
  const K = this.buildKernelInterface();

  // 1. Schedule gate (infrastructure)
  const schedule = await this.kvGet("session_schedule");
  if (!this._isSessionDue(schedule)) return { skipped: true };

  // 2. Infrastructure inputs
  const crashData = await this._detectCrash();
  const balances = await this.checkBalance({});
  const events = await this.drainEvents(this._eventHandlers);

  // 3. Session start bookkeeping
  const count = await this.getSessionCount();
  await this.kvWriteSafe("session_counter", count + 1);
  await this.karmaRecord({ event: "session_start", ... });

  // 4. Hand everything to the session hook
  const { run } = this.HOOKS.session;
  await run(K, { crashData, balances, events, schedule });

  // 5. Post-session bookkeeping
  await this._writeSessionHealth("clean");
  await this.updateSessionOutcome("clean");
}
```

The hook receives the kernel interface and raw infrastructure inputs.
It decides everything else: what to load, what phases to run, how to
structure the session, whether to dispatch deep reflect as a background
job.

### 10.6 Deep Reflect as External Process

Deep reflect does not run inside the Cloudflare Worker. It runs as a
background job on the compute server (akash), triggered by the session
hook when conditions are met (via the existing `start_job` tool).

This is natural because:
- Deep reflect may run longer than Workers CPU limits allow
- The evaluation pipeline (embeddings, NLI) runs on akash
- Deep reflect is a different kind of process — slow, reflective, not time-sensitive
- The session hook decides when to trigger it — the kernel doesn't know

Deep reflect reads and writes KV via API. Act sessions continue
running normally while deep reflect works. The read/write isolation
matrix (§8) ensures no conflicts.

### 10.7 Comms Integration

The chat handler (`handleChat` in hook-communication.js) changes:

- `trigger_session` tool becomes `record_event` — records the patron's
  need as an event and advances the session schedule
- Events are infrastructure (KV entries with TTLs, drained at session start)
- The session hook folds events into circumstances (c_t)
- The hook decides what to do about them — the kernel doesn't know

Delivery is not a special pipeline. It is a normal action precipitated
by plan when circumstances include "work is complete, contact hasn't
been informed." Act prepares the communication and emits a delivery
event. The comms subsystem picks it up and composes/sends via the
appropriate channel adapter.

### 10.8 Code Staging (Replaces Proposal System)

The current kernel proposal system (~185 LOC) encodes cognitive policy:
claims, verdicts, checks, depth-based auto-accept, predicate evaluation.
All of this moves to hooks. The kernel retains only two primitives:

```javascript
K.stageCode(targetKey, code)   // Store code in staging area
K.signalDeploy()               // Tell governor to deploy staged code
```

The governor reads staged code, applies it to KV, builds, and deploys
to Cloudflare — unchanged from current behavior. The crash tripwire
(3 consecutive crashes → mechanical rollback) stays as kernel safety.

**How self-improvement works in the cognitive framework:**

1. Deep reflect evolves a desire: "my tools should handle sharing"
2. Plan precipitates an action: "write a share action for google_docs"
3. Act writes the code and calls `K.stageCode()`
4. Deep reflect (next cycle) decides to deploy — calls `K.signalDeploy()`
5. The new tool's outcomes flow through the normal eval pipeline
6. Samskara strengths track whether the change is working
7. S operator examines experiences — deepens the samskara if the tool works,
   erodes it if not, potentially creating a new samskara about why it failed

Code changes are evaluated through the normal samskara lifecycle.
No special proposal observations, verdicts, or review machinery needed.

---

## 11. Design Decisions

1. **No subplans.** The looping session handles sequential decomposition
   (plan precipitates the next action after each cycle). Parallel tool
   calls within act handle parallelism within a single action. Parallel
   sessions (future optimisation) handle independent work streams. The
   `spawn_subplan` mechanism is removed — it solves a problem the
   framework already handles.

2. **No delivery pipeline.** Notification is a normal action. When
   circumstances include "work complete, contact uninformed," plan
   precipitates a communication action. Act emits a delivery event.
   Comms composes and sends.

3. **No proposal system in the kernel.** Two kernel primitives
   (`stageCode`, `signalDeploy`) replace ~185 LOC of proposal
   governance. All cognitive policy (claims, verdicts, checks)
   moves to hooks and the samskara framework.

4. **Unified belief store.** Assumptions, insights, and wisdom collapse
   into samskaras — impressions at different depths. No separate
   counter store (μ) — statistics live on the entries themselves as
   EMA strength. No TTL — shallow samskaras naturally erode through
   the strength mechanism. One prefix, one lifecycle, one spectrum.

5. **Mechanical review, intelligent reflect.** The review phase
   (σ, α, strength updates, experience recording) is computation — no
   LLM needed. Only the S and D operators in deep-reflect require
   intelligence. This keeps act sessions cheap and fast.

---

## 12. Open Questions for Implementation

1. **Salience threshold (τ):** Fixed or adaptive? If adaptive, what adjusts it? Candidate: τ adapts based on experience memory growth rate — if ε is growing too fast, raise τ to be more selective.

2. **EMA alpha (α_ema):** What value? Controls how quickly samskaras respond to new evidence. Low (0.1) → slow, deep grooves. High (0.3) → fast adaptation. Start with the existing `surprise_ema_alpha` value and tune.

3. **Samskara deletion threshold:** What strength level triggers deletion? Candidate: 0.05 (a samskara confirmed only 5% of the time is noise).

4. **Deep-reflect LLM usage:** The S and D operators in deep-reflect are LLM-mediated (they require reasoning about patterns and principles). What model tier? What context budget? How are experiences summarised for context window efficiency?

5. **Exogenous event handling:** How are ξ events surfaced to the agent? Candidate: an event queue that is drained at the start of each act session, folded into c_t as updated circumstances.

6. **NLI model selection and hosting:** DeBERTa-v3-base-mnli-fever-anli is ~86M parameters. Confirm it runs acceptably on akash (Ryzen 7 3700X, 62GB RAM). Benchmark latency for expected pair volumes per review phase.

7. **Kernel key tier bootstrap:** How are `kernel:key_tiers` seeded? Candidate: seed script writes them alongside principles. Patron can update via dashboard.

8. **Deep reflect trigger conditions on akash:** How does the session hook decide when to dispatch deep reflect? Candidate: check experience growth and session count since last DR — all readable from KV.

9. **Samskara conflict:** S may create samskaras that logically contradict each other — e.g., "External APIs are unreliable" and "Google Docs API is highly reliable." During act, embedding-based selection might surface both for an action involving Google Docs. Strength alone doesn't capture logical relationships between samskaras. The act LLM can reconcile contradictory context pragmatically, and S can consolidate conflicting samskaras during deep-reflect, but this is an implicit capability rather than an explicit mechanism.

---

## 13. Implementation Dependencies

| Component | Purpose | Candidate | Runs On |
|-----------|---------|-----------|---------|
| Embedding model | Tier 1 relevance filtering + samskara selection | bge-small-en-v1.5 | akash (local) |
| NLI model | Tier 2 valence classification | DeBERTa-v3-base-mnli-fever-anli | akash (local) |
| LLM (small) | Tier 3 edge cases, act sessions | Qwen3-32B via Ollama | akash (local) |
| LLM (large) | Deep-reflect (S and D operators) | Claude via API | Remote |
| Vector store | Experience memory retrieval | TBD (candidate: ChromaDB, lancedb) | akash (local) |
| KV store | Desires, samskaras, experiences | Cloudflare KV (existing) | Cloudflare Workers |
| Event queue | Exogenous events | TBD (candidate: Cloudflare Queue) | Cloudflare Workers |

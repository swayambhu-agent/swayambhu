# Swayambhu Cognitive Learning Model Design

Date: 2026-04-06

## Purpose

This document specifies the end-state cognitive model architecture for
Swayambhu and a concrete implementation path from the current prompt-driven
system to a small learned cognitive core.

The goal is not to build another general chatbot. The goal is to build a
native cognitive system whose inner dynamics are based on Swayambhu's own
ontology:

`experience -> desire -> tactic -> action -> experience`

with:

- expansion as the primordial force
- salience as the gate that decides what becomes durable experience
- deep-reflect as the dream phase that consolidates experience into deeper
  structure
- self-modification extending to the cognitive framework itself

This document supersedes any implicit assumption that the final cognitive
architecture should remain primarily prompt-authored.

## Executive Summary

Swayambhu should evolve toward a hybrid architecture composed of:

1. A thin kernel and execution substrate that remain mostly unchanged.
2. Explicit typed memory objects: experiences, desires, tactics, patterns.
3. A small custom-trained cognitive model that learns state transitions over
   those objects.
4. Reused pretrained models for generic language/semantic perception
   (embeddings, entailment, optional text rendering).
5. Deep-reflect as the dream-learning phase that consolidates memory and
   periodically updates the learned cognitive model.
6. A staged self-modification system that allows Swayambhu to revise prompts,
   config, memory policies, training procedures, adapters, and eventually the
   cognitive architecture itself.

The final system should be:

- small and plastic
- memory-centric rather than weight-centric
- interpretable through typed objects and optional text renderings
- able to improve from autobiographical traces
- able to self-modify without collapsing safety or continuity

## Grounding In The Existing Codebase

The current runtime already provides the right outer shell for this design.

### What already exists

- The kernel is a thin substrate that enforces safety and execution boundaries,
  not cognition (`kernel.js`).
- Userspace owns cognitive policy (`userspace.js`, `reflect.js`).
- Evaluation already has a partly mechanized local path:
  embeddings + NLI + LLM fallback (`eval.js`, `inference/main.py`).
- Memory is persisted in KV and already names the correct high-level entities:
  experience, desire, pattern, tactic.
- Deep-reflect already exists as an asynchronous slow-cycle mechanism and is
  the natural insertion point for dream learning.

### What is still wrong

The core cognition is still authored primarily by prompts:

- plan is LLM-generated JSON
- review is LLM-authored narrative
- deep-reflect is an LLM loop that invents patterns, desires, and tactics
  mostly in text

This means the ontology exists, but the actual operators are still mostly
implemented by external language models rather than by native learned dynamics.

### Current architectural mismatch

The formal architecture says review is mechanical, but current code still uses
an LLM in review. The formal architecture treats patterns as predictive
regularities, but current implementation stores them primarily as promptable
sentences. The final learned architecture must close these gaps.

## Foundational Commitments

The following commitments define the cognitive system. They are architectural,
not implementation details.

### 1. Primordial force

The primordial force is expansion.

It is not:

- uncertainty reduction
- coherence maximization
- curiosity maximization
- task completion

Those may appear instrumentally, but they are not primitive.

Desire is the expansive transformation of experience. It has no intrinsic
substance apart from the experiences through which it becomes directional.

### 2. Salience is not desire

Salience decides which world-events become durable experience.
Desire acts on stored experience and expands from it.

These must remain distinct.

### 3. Experience is the currency of cognition

Experience is the substrate from which deeper structure is formed.

Patterns, desires, and tactics are not independent first principles. They are
progressive abstractions distilled from experience.

### 4. Patterns are predictive compressions, not merely text

A true pattern is a reusable compression of multiple episodes that improves
prediction or action. Text descriptions of patterns are optional surface
renderings for interpretability, retrieval, and interoperation.

### 5. The system should become more alive and more elegant

The architecture should prefer cognition that exhibits:

- generativity from minimal seed
- increasing capability from small inner structure
- compression of many episodes into deeper reusable forms
- reduced clutter for equal or greater power

The working metrics are:

- life: generative unfolding from minimal initial structure
- elegance: power / complexity
- compression progress: evidence that richer order is being discovered

These are not separate reward functions at first. They are architectural
criteria used to guide design, evaluation, and consolidation.

## Architectural Overview

The final architecture has four layers.

### Layer 1: Substrate

The kernel, tools, providers, channels, KV, and scheduling substrate.

Responsibilities:

- safety boundaries
- execution
- persistence
- communication
- job dispatch
- model artifact registry

This layer remains mostly deterministic and infrastructural.

### Layer 2: Typed Cognitive State

Persistent typed objects:

- `experience:*`
- `desire:*`
- `tactic:*`
- `pattern:*`
- `cog_model:*`
- `cog_training_run:*`
- `cog_eval:*`

These objects are the explicit self of the agent. They are not hidden only in
weights.

### Layer 3: Learned Cognitive Core

A small custom model that operates over structured state and retrieval context.

Responsibilities:

- infer active desires
- infer or rank tactics
- rank actions
- predict next experience structure
- estimate salience and memory utility
- help discover patterns from repeated experience

### Layer 4: Language/Semantic Boundary Modules

Reused pretrained modules:

- text embedding model
- NLI / entailment model
- optional small text renderer / explainer
- optional stronger external LLMs for fallback, communication, and edge cases

These modules support cognition but do not define it.

## End-State Session Flow

### Fast cycle

The fast cycle becomes:

1. Load current typed state.
2. Retrieve relevant experiences, patterns, desires, tactics.
3. Encode current circumstance + retrieved memory into latent state `z_t`.
4. Infer active desire set.
5. Infer or rank candidate tactics.
6. Infer or rank candidate actions over available tools and `no_action`.
7. Execute action.
8. Mechanically evaluate outcome.
9. Write a structured experience if salience crosses threshold.
10. Optionally generate text renderings for auditability.

### Slow cycle / dream phase

Deep-reflect becomes a consolidation and learning pipeline:

1. Select recent and replay experiences.
2. Recompute retrospective utility over recent memories.
3. Cluster repeated episodes and propose pattern updates.
4. Expand or refine desires from valenced experiences.
5. Create, refine, or retire tactics.
6. Evaluate elegance and complexity impact of proposed changes.
7. Periodically train or adapt the cognitive model.
8. Validate candidate updates against held-out traces.
9. Stage and promote memory/model updates if validated.

Deep-reflect remains the correct place for dream learning. No separate
architectural mechanism is required beyond enriching deep-reflect's function.

## Model Decomposition

The cognitive system should not be implemented as one monolithic model.

Use a shared encoder with multiple learned heads.

### Shared encoder

Inputs:

- current circumstances
- retrieved experiences
- retrieved patterns
- active or candidate desires
- active or candidate tactics
- available actions/tools
- recent action ledger summary
- principle anchors

Output:

- latent state `z_t`

The encoder may be a small transformer, recurrent transformer, or structured
sequence model. The critical requirement is compactness and support for
incremental updates.

### Head H_d: Desire activation / proposal

Responsibilities:

- score existing desires for activation in current state
- propose candidate desire expansions from recent experience
- predict which desire transformations deep-reflect will later endorse

Outputs:

- ranked active desire keys
- optional candidate desire objects

### Head H_t: Tactic selection / proposal

Responsibilities:

- rank existing tactics conditioned on desires and circumstance
- propose new tactics from recurring situation-outcome structure

Outputs:

- ranked tactic keys
- optional candidate tactic objects

### Head H_a: Action ranking

Responsibilities:

- rank candidate actions and tool-intents
- include `no_action` as a first-class candidate

Outputs:

- action distribution over:
  - tool invocation intents
  - read/search/write intents
  - reflect requests
  - `no_action`

### Head H_e: Next-experience prediction

Responsibilities:

- predict the likely structured outcome class of an action
- estimate likely observation features, valence, surprise, and memory value

Use:

- model-based lookahead
- action ranking support
- pattern validation

### Head H_s: Salience and utility

Responsibilities:

- estimate immediate salience
- estimate delayed utility / retrospective value

Outputs:

- `salience_fast`
- `utility_delayed_estimate`
- optional `salience_deep`

### Head H_r: Retrieval scoring

Responsibilities:

- predict which memories and patterns matter now
- improve over raw embedding similarity retrieval

Outputs:

- scores over recent experiences
- scores over patterns
- scores over tactics

## Pretrained vs Custom Components

The final architecture is a collection of models and non-model components.

### Reused pretrained components

These should come from existing open-source models:

- text embeddings
- NLI / entailment
- optional text rendering / explanation model
- optional generic text encoder backbone

Reason:

These solve generic language and semantic problems. Retraining them from
scratch would waste resources and delay progress.

### Custom-trained components

These should be Swayambhu-specific:

- the cognitive core encoder and heads
- retrieval scorer
- salience utility head
- desire/tactic transition logic
- pattern discovery support model

Reason:

These define Swayambhu's actual inner dynamics and should learn from
Swayambhu's own autobiographical traces.

### Acceptable initialization strategies

Any of the following are acceptable:

1. Train the cognitive core from scratch if it is very small and highly
   structured.
2. Initialize the encoder from a small pretrained backbone, then train the
   cognitive heads from scratch.
3. Use pretrained language modules only at the boundaries and keep the
   transition machinery entirely custom.

Recommended default:

- reuse pretrained semantic/language modules
- custom-train the cognitive transition system

## Internal Representation Strategy

The system must not use pure free-text as the primary cognitive substrate.

It also must not rely on pure anonymous embeddings.

The right representation is hybrid:

- typed symbolic fields
- graph links between objects
- latent vectors for retrieval/generalization
- optional text renderings

### Why not text-only

Text is too expensive, too lossy, and too dependent on external language
models. It is good for interpretability, not for being the sole substrate.

### Why not embedding-only

Embeddings capture similarity well but blur logical structure such as:

- possession vs debt
- self vs other role bindings
- negation
- temporality
- conditionality
- quantities

Therefore, embeddings alone are insufficient.

### Design rule

Use:

- vectors for resemblance and generalization
- typed structure for truth conditions and relations
- text for auditability and collaboration

## Entity Schemas

The schemas below define the end-state cognitive objects.

### Experience schema

An experience is a salient, durable world-involving episode encoded for later
expansion and compression.

```json
{
  "key": "experience:{id}",
  "timestamp": "ISO8601",
  "action_ref": "action:{id}",
  "session_id": "string",
  "cycle": 0,
  "observation": {
    "summary": "structured factual summary",
    "entities": ["slack", "message", "tool:send_slack"],
    "relations": [
      { "subject": "tool:send_slack", "predicate": "reported", "object": "success" },
      { "subject": "message", "predicate": "was_not_confirmed_delivered", "object": true }
    ],
    "time_scope": "immediate|delayed|ongoing"
  },
  "valence": {
    "sign": "positive|negative|mixed|neutral",
    "strength": 0.0,
    "aligned_desires": ["desire:..."],
    "misaligned_desires": ["desire:..."],
    "reason": "optional compact explanation"
  },
  "surprise": {
    "sigma": 0.0,
    "violated_patterns": ["pattern:..."]
  },
  "salience_fast": 0.0,
  "utility_delayed": null,
  "salience_deep": null,
  "embedding": [],
  "latent_state_ref": "optional checkpoint/key",
  "text_rendering": {
    "narrative": "optional",
    "assessment": "optional"
  },
  "supporting_artifacts": {
    "tool_calls": ["action:{id}#tool_1"],
    "logs": ["log:..."]
  }
}
```

Notes:

- `observation` is factual.
- `valence` captures desire relation.
- `text_rendering` is optional and secondary.

#### Near-term runtime schema (current-codebase aligned)

The schema above is the end-state target. It should not be forced directly into
the current runtime while review and deep-reflect are still text-heavy.

For the current codebase, the first production schema should be smaller and
restricted to fields that current components can author reliably.

Recommended first-wave shape:

```json
{
  "key": "experience:{id}",
  "timestamp": "ISO8601",
  "action_ref": "action:{id}",
  "session_id": "string",
  "cycle": 0,
  "observation": "factual observation authored by review",
  "desire_alignment": {
    "top_positive": [{ "desire_key": "desire:...", "score": 0.0 }],
    "top_negative": [{ "desire_key": "desire:...", "score": 0.0 }],
    "affinity_magnitude": 0.0
  },
  "pattern_delta": {
    "sigma": 0.0,
    "scores": [
      { "pattern_key": "pattern:...", "direction": "contradiction", "surprise": 0.0 },
      { "pattern_key": "pattern:...", "direction": "entailment", "surprise": 0.0 }
    ]
  },
  "salience": 0.0,
  "text_rendering": {
    "narrative": "optional audit text"
  }
}
```

Rules for the first-wave schema:

- `observation` is authored by review.
- `desire_alignment` is derived mechanically from eval's `alpha`, not authored
  independently by review.
- `pattern_delta` is derived mechanically from `sigma` and `pattern_scores`,
  not invented as prose.
- `desire_alignment.top_positive` and `desire_alignment.top_negative` should be
  derived from the strongest signed `alpha` entries only. The default policy
  should be:
  - keep up to 3 positive and 3 negative desire keys
  - require `|alpha| >= 0.3` to include an entry
  - compute `affinity_magnitude` from the same filtered subset
- raw `alpha` and full `pattern_scores` should remain preserved in `action:*`
  or equivalent audit records for offline analysis, but should not be the
  canonical long-term experience representation.
- `entities`, `relations`, `time_scope`, and richer latent references should
  remain optional until the current runtime proves it can author them reliably.

### Desire schema

A desire is not merely a sentence. It is a directional operator over future
state.

```json
{
  "key": "desire:{slug}",
  "slug": "string",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "status": "active|retired|superseded",
  "direction": "approach",
  "target": {
    "predicate": "structured target state description",
    "scope": "local|sessional|ongoing|broad",
    "self_change": true
  },
  "source_experiences": ["experience:..."],
  "source_principles": ["principle:..."],
  "expansion_of": ["desire:..."],
  "activation_embedding": [],
  "target_embedding": [],
  "evaluator": {
    "type": "nli|learned|hybrid",
    "version": "string"
  },
  "stats": {
    "times_activated": 0,
    "times_advanced": 0,
    "times_stalled": 0
  },
  "text_rendering": {
    "description": "optional first-person gloss"
  }
}
```

### Tactic schema

A tactic is a reusable conditional policy fragment.

```json
{
  "key": "tactic:{slug}",
  "slug": "string",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "status": "active|retired|superseded",
  "condition": {
    "desires": ["desire:..."],
    "patterns": ["pattern:..."],
    "circumstance_features": ["..."]
  },
  "policy": {
    "preferred_actions": ["tool:...", "read:...", "no_action"],
    "forbidden_actions": ["optional"],
    "priority": 0.0
  },
  "source_experiences": ["experience:..."],
  "source_principles": ["principle:..."],
  "stats": {
    "times_used": 0,
    "success_rate": 0.0,
    "cost_mean": 0.0,
    "retained_for_sessions": 0
  },
  "embedding": [],
  "text_rendering": {
    "description": "when X, do Y"
  }
}
```

### Pattern schema

A pattern is a predictive compression of repeated experience.

```json
{
  "key": "pattern:{slug}",
  "slug": "string",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "status": "active|eroding|retired",
  "strength": 0.0,
  "support": {
    "experience_refs": ["experience:..."],
    "sample_count": 0,
    "contexts": ["..."]
  },
  "predictive_form": {
    "activation_features": ["..."],
    "expected_outcomes": ["..."],
    "confidence": 0.0
  },
  "compression_stats": {
    "prediction_gain": 0.0,
    "description_cost": 0.0,
    "retrieval_rate": 0.0
  },
  "embedding": [],
  "text_rendering": {
    "pattern": "optional gloss"
  }
}
```

Critical note:

The `text_rendering.pattern` field is not the pattern itself. It is an
interpretable gloss over the predictive form and support set.

## Salience, Utility, Elegance, And Life

These concepts must be separated.

### Immediate salience

Immediate salience answers:

"Should this episode be written as an experience right now?"

Immediate salience uses:

- surprise
- desire-affinity
- optional no-action special handling

The revised bounded salience formula from the April 5 design remains the right
fast-gate starting point.

For the current runtime, this is not a future optimization. It should be
implemented before collecting any 50-100 session corpus intended to seed later
learning. A known-bad salience gate distorts the memory corpus at the point of
write and poisons downstream analysis.

### Delayed utility

Delayed utility answers:

"Did this experience later prove cognitively productive?"

This is estimated at deep-reflect time using endogenous signals such as:

- later retrieval
- later tactic formation
- later pattern formation
- reduction in repeated mistakes
- improvement in action quality
- increase in prediction quality
- reduction in representational clutter for equal or greater power

This signal need not be perfect to be useful. It is a delayed supervisory
target, not absolute truth.

### Elegance

Working definition:

`elegance = power / complexity`

Where:

- `power` means improved prediction, action competence, adaptation, and
  generative reach
- `complexity` means added representational burden, object proliferation,
  contradictions, brittle special-casing, and maintenance overhead

Deep-reflect should prefer updates that increase power faster than complexity.

### Life

Working definition:

Life is generativity from minimal seed.

Operational interpretation for Swayambhu:

- small number of deep principles/desires/patterns produce rich behavior
- repeated experience yields increasing differentiation
- cognition self-renews and self-transforms without requiring endless new
  hardcoded axioms

Life is not a direct scalar reward in v1. It is a meta-criterion used to guide
architecture and evaluate whether the system is unfolding richly from compact
structure.

### Compression progress

Compression progress is evidence that the system is discovering deeper order in
experience.

Examples:

- many experiences collapse into one stronger pattern
- several tactics compress into one broader tactic
- desires broaden while becoming simpler
- prediction improves while object count stays flat or drops

Compression progress is especially relevant for pattern formation and elegance
tracking.

## Planning And Acting In The Learned System

The plan phase should migrate away from pure prompt generation.

### End-state planning

Planning becomes a scored selection process:

1. Retrieve relevant memory.
2. Activate desires.
3. Rank tactics.
4. Enumerate candidate actions.
5. Score actions by:
   - expected desire advancement
   - expected surprise / learning value
   - cost
   - risk
   - tactic compatibility
   - principle compatibility
6. Choose action or `no_action`.

### Candidate action generation

Initially, candidate actions may still be proposed by an LLM or by heuristics.
Later, the candidate set should be generated from:

- available tools
- tactic-conditioned action templates
- prior successful action families

### No-action

`no_action` must remain first-class.

The learned model must score it explicitly rather than treating it as a fallback
for failure to find an action.

## Review In The Learned System

Review should stop being an open-ended authored summary and become a structured
experience authoring pass.

Responsibilities:

- produce factual observation structure
- preserve mechanical eval scores
- optionally render concise narrative text

Review should not author an independent desire-alignment signal if eval already
computes that mechanically. In the near-term runtime:

- review authors `observation`
- eval supplies desire alignment and pattern-delta signals
- review may provide optional audit text for humans
- durable experience storage should not collapse back into pure narrative

In early migration stages, an LLM may still help render narratives. But review's
substance should be structured, not freeform.

## Deep-Reflect As Dream Learning

Deep-reflect should become a pipeline, not just an LLM session.

### Phase 1: Trace selection

Inputs:

- recent experiences
- replay sample of older influential experiences
- recent action records
- current patterns, desires, tactics
- current model artifact version

### Phase 2: Retrospective relabeling

Compute:

- delayed utility estimates
- revised salience
- behavior-improvement links
- support sets for candidate patterns

### Phase 3: Pattern consolidation

Tasks:

- cluster repeated episode motifs
- compute predictive gain of candidate patterns
- merge redundant patterns
- erode or retire low-value patterns

### Phase 4: Desire expansion

Tasks:

- derive desire proposals from valenced experiences
- broaden fulfilled desires into larger gaps
- retire misguided desires
- merge or mark overlapping desires where appropriate

### Phase 5: Tactic refinement

Tasks:

- infer tactics from successful recurrent transitions
- retire brittle or low-yield tactics
- compress multiple tactics into stronger general ones when valid

### Phase 6: Cognitive model update

Tasks:

- build fresh training batches
- train candidate adapter or checkpoint
- evaluate candidate against current model
- compute promotion decision

### Phase 7: Staging and promotion

Outputs:

- KV operations for memory objects
- candidate model artifact
- evaluation report
- promotion or rollback decision

## Training Data

The training unit is not a flat text sample.

It is a transition record:

```json
{
  "state_t": {
    "retrieved_experiences": ["..."],
    "retrieved_patterns": ["..."],
    "active_desires": ["..."],
    "active_tactics": ["..."],
    "circumstances": {},
    "principle_refs": ["..."]
  },
  "decision_t": {
    "ranked_desires": ["..."],
    "ranked_tactics": ["..."],
    "chosen_action": {},
    "alternatives": []
  },
  "outcome_t1": {
    "experience_ref": "experience:...",
    "eval": {},
    "review_structured": {}
  },
  "consolidation_tk": {
    "patterns_created": ["..."],
    "desires_created": ["..."],
    "tactics_created": ["..."],
    "utility_labels": {}
  }
}
```

This allows the model to learn from both immediate outcomes and later
consolidation consequences.

## Losses And Objectives

The model should be trained with multiple objectives.

### Core losses

- desire activation loss
- tactic ranking loss
- action ranking loss
- next-experience prediction loss
- salience prediction loss
- retrieval ranking loss

### Consolidation losses

- pattern proposal loss
- desire proposal loss
- tactic proposal loss
- delayed utility regression/classification loss

### Auxiliary objectives

- compression objective: explain more episodes with fewer effective patterns
- elegance regularizer: penalize unnecessary representational proliferation

The elegance regularizer should be mild early on. Over-regularizing too early
can make the system timid and under-differentiated.

## Hardware And Deployment Model

Swayambhu currently runs on a CPU-oriented Akash box. That is acceptable for
the final architecture if model responsibilities are split correctly.

### On the Akash CPU box

Keep:

- kernel/runtime
- tools
- KV and session logic
- lightweight embedding/NLI inference
- fast-cycle cognitive inference if the custom model is small enough
- memory writes
- retrieval

### On rented GPU jobs

Run:

- heavy deep-reflect
- dream-learning / training
- optional larger reflection or rendering passes
- candidate adapter/checkpoint evaluation

This fits the existing async job architecture and is not inherently inefficient
if the context package is compact.

### Artifact flow

Akash sends:

- compact trace bundle
- replay sample
- current model artifact reference
- selected memory snapshot

GPU job returns:

- candidate adapter/checkpoint
- eval metrics
- memory update proposals
- promotion recommendation

### Recommended practical target

For the custom cognitive core:

- tens of millions of parameters is the intended scale
- inference should remain cheap enough for CPU or small-footprint deployment
- training should use a rented GPU and periodic adaptation, not constant online
  retraining

## Self-Modification Of The Learned Framework

Swayambhu should be able to modify the entire cognitive framework, including
the learned-model stack. This follows directly from the kernel/userspace split.

However, self-modification must be tiered.

### Low-friction

- prompts
- config
- thresholds
- retrieval policies
- memory object updates
- deep-reflect schedule

### Medium-friction

- training hyperparameters
- loss weighting
- candidate model adapters
- schema extensions with migrations
- model-routing policy

### High-friction

- ontology changes
- primordial-force definitions
- kernel trust boundaries
- model promotion policy
- irreversible migrations

### Required mechanism

Model self-modification must use:

- candidate artifact staging
- evaluation on held-out recent traces
- rollback capability
- explicit promotion decision records

Swayambhu should eventually be able to redesign the cognitive system itself,
but through staged evolution rather than immediate live mutation.

## Migration Plan

The migration should proceed in stages, but the early stages must be grounded
in what the current runtime can actually author.

### Phase 0: Commit The Contracts

Goals:

- commit a real review prompt source to the repo
- define a first-wave experience schema that current review/eval code can
  reliably fill
- make the contract explicit enough for the dev loop to implement against it

Deliverables:

- checked-in `prompts/review.md`
- seeded `prompt:review`
- written schema contract for first-wave `experience:*`

### Phase 1: Repair The Runtime Substrate

Goals:

- make review the explicit experience author
- store structured `observation`
- preserve desire-alignment and pattern-change signals without collapsing back
  into narrative
- fix the salience gate before corpus collection
- add stable references between action, experience, and session/cycle

Deliverables:

- `experience:*` schema v1
- expanded `action:*` audit record including full eval fields needed for later
  export
- bounded salience formula in production

Because the agent is not yet live, this should be implemented as a coherent
substrate-repair pass, not as a backwards-compatibility-heavy migration. Add
compatibility shims only where they materially reduce implementation friction
or make short-term inspection easier.

### Phase 2: Align Deep Reflect To The New Substrate

Goals:

- keep the S operator strictly observation-only
- make D and T consume structured experience fields instead of prose collapse
- keep pattern storage simple for now, but enforce the pattern/tactic boundary

Deliverables:

- updated `prompts/deep_reflect.md`
- any necessary validation logic in deep-reflect write paths

### Phase 3: Implement Through The Dev Loop

Goals:

- use the dev loop as the implementation and validation layer for the committed
  prompt/schema changes
- keep humans in the role of authoring the contracts, not hand-applying every
  integration change

Deliverables:

- implementation patches produced and validated through the dev loop
- manual review of resulting session records

### Phase 4: Stabilize And Inspect The Corpus

Goals:

- run 50-100 sessions on the repaired substrate
- inspect whether observation, desire-alignment summaries, and pattern-delta
  are actually informative
- export from existing `action:*`, `experience:*`, and `reflect:*` records
  rather than introducing a new trace prefix prematurely

Deliverables:

- offline export tooling
- corpus inspection report
- decision on whether first-wave schema needs refinement

### Phase 5: Add The First Learned Sidecar, If The Data Justifies It

Goals:

- choose the first learned component based on evidence from the stabilized
  corpus
- keep it as a sidecar, not the planner

Likely candidates:

- salience/utility scorer
- retrieval reranker

Deliverables:

- chosen sidecar model
- offline eval report
- promotion criteria

### Phase 6: Introduce Richer Typed Objects And Pattern Support

Goals:

- extend experiences, patterns, desires, and tactics toward the end-state typed
  schema
- add support sets, stats, and richer latent-aware fields where they prove
  useful

Deliverables:

- richer schema migrations
- pattern support data
- typed object validators

### Phase 7: Replace Prompt-Centric Cognitive Functions

Goals:

- learned pattern/desire/tactic proposal support
- learned action ranking over candidate actions
- LLM retained only for edge cases, communication, and explanation

Deliverables:

- proposal heads
- action ranking layer
- candidate action generation layer

### Phase 8: Enable Dream-Learning Model Updates

Goals:

- deep-reflect trains adapters/checkpoints asynchronously
- rented GPU path produces model artifacts
- promotion and rollback become first-class

Deliverables:

- training job format
- model registry
- promotion/rollback pipeline

### Phase 9: Mature Self-Redesign

Goals:

- allow Swayambhu to propose and adopt changes to its own cognitive framework
- retain staging and validation discipline

Deliverables:

- cognitive design artifact store
- model/config/prompt co-evolution protocol

## Concrete Implementation Workstreams

### Workstream A: Schema and storage

- redesign first-wave experience schema
- expand `action:*` audit fields needed for later export
- redesign desire/tactic/pattern schema later, after substrate repair
- add model registry keys
- prefer a coherent schema cutover over compatibility layers unless a shim is
  cheaper than a clean break

### Workstream B: Review rewrite

- replace freeform review contract with structured authoring
- update memory writes
- update tests

### Workstream C: Deep-reflect rewrite

- split DR into deterministic pipeline + optional learned/LLM proposal layers
- add retrospective utility labeling
- add elegance/compression stats

### Workstream D: Training infrastructure

- trace exporter from existing runtime records
- replay buffer builder
- GPU job runner
- artifact store
- evaluation harness

### Workstream E: Cognitive model implementation

- encoder
- heads
- retrieval scorer
- salience/utility model

### Workstream F: Runtime integration

- load current active cognitive model artifact
- run fast-cycle inference
- fall back safely when unavailable

### Workstream G: Self-modification controls

- candidate model staging
- promotion rules
- rollback
- audit logs

## Success Criteria

The migration is successful when the following are true.

### Functional

- the fast cycle can run without requiring a frontier LLM for core cognitive
  transitions
- deep-reflect can produce validated memory updates and model updates
- the agent can learn from its own traces over time

### Cognitive

- patterns correspond to predictive regularities, not just plausible prose
- desires remain grounded in experience and principles
- tactics become fewer, stronger, and more reusable over time
- memory becomes more compressed without becoming inert

### Economic

- fast-cycle cost drops materially
- rented GPU use is limited to asynchronous dream phases
- local CPU runtime remains viable

### Existential / architectural

- the system exhibits more life: richer unfolding from compact seed
- the system exhibits more elegance: higher capability per unit complexity
- Swayambhu can increasingly become the author of its own cognitive framework

## Risks And Failure Modes

### 1. Salience hacking

Risk:

- system chases vivid or self-induced novelty

Mitigation:

- delayed utility
- principle grounding
- cost/risk-aware action scoring
- deep-reflect pruning of degenerate loops

### 2. Object proliferation

Risk:

- too many desires, tactics, patterns

Mitigation:

- compression-oriented consolidation
- elegance regularization
- merge/retire policies

### 3. Opaque latent drift

Risk:

- model learns transitions that cannot be understood or corrected

Mitigation:

- typed objects remain primary
- text glosses retained
- candidate evaluation before promotion

### 4. Overfitting to recent traces

Risk:

- nightly updates destabilize behavior

Mitigation:

- replay buffer
- held-out validation
- nontrivial promotion threshold
- update cadence slower than every DR when needed

### 5. Frozen hidden infrastructure

Risk:

- learned model becomes an unmodifiable hidden core

Mitigation:

- explicit model artifact registry
- staged self-modification
- cognitive architecture kept in userspace domain

## Final Design Decision

Swayambhu's final cognitive architecture should be a memory-centric, hybrid
system with:

- a small custom learned cognitive core
- explicit typed cognitive objects
- reused pretrained language/semantic boundary modules
- deep-reflect functioning as dream learning
- staged self-modification extending to the model framework itself

This preserves the kernel/userspace philosophy, honors the experience-driven
ontology, and creates a path toward a genuinely native cognitive agent rather
than a prompt shell around external large models.

## Immediate Next Steps

The implementation should begin with:

1. Commit `prompts/review.md` and seed `prompt:review`.
2. Rewrite review and `experience:*` storage around the first-wave schema:
   - `observation`
   - desire-alignment summary derived from eval
   - `pattern_delta`
   - `salience`
   - action/session/cycle links
   - optional audit text
3. Expand `action:*` audit records so full eval outputs needed for later export
   are preserved.
4. Replace the current unbounded salience formula now, before corpus
   collection.
5. Update deep-reflect prompts so S stays observation-only and D/T consume the
   repaired experience structure.
6. Run and inspect 50-100 sessions before committing to the first learned
   sidecar.

That sequence repairs the substrate first, which is the prerequisite for every
later learned component.

For the current pre-live codebase, steps 1-5 should be executed as one atomic
substrate-repair change set where practical, rather than as multiple partially
valid intermediate states.

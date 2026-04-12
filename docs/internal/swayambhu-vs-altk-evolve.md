# Swayambhu vs altk-evolve

Date: 2026-04-09

Inspected revisions:
- Swayambhu: `a60b0bf` (2026-04-09)
- altk-evolve: `805886a` (2026-04-08)

Revision note:
- This review is based on a code-first audit of [`userspace.js`](../../userspace.js), [`eval.js`](../../eval.js), and [`hook-communication.js`](../../hook-communication.js), in addition to the repo docs and the sampled `altk-evolve` codebase.

## Executive Summary

These repos are adjacent, not equivalent, and the code-first audit makes Swayambhu look cognitively stronger than the first draft suggested.

- **Swayambhu** is a full autonomous runtime with a hard kernel/policy split, explicit `plan -> act -> eval -> review -> memory` cognition, recursive reflection, and governed self-modification.
- **altk-evolve** is a reusable learning substrate: trajectory capture, guideline/policy retrieval, conflict resolution, tracing ingestion, UI, and MCP-facing integrations.

The central conclusion is this:

- **altk-evolve has more to learn from Swayambhu than the first draft suggested, especially on cognitive-runtime structure, safety boundaries, and memory formation discipline.**
- **Swayambhu still has things to learn from altk-evolve, but now they are narrower: explicit conflict resolution, reusable retrieval products, provenance ergonomics, and external packaging.**

The biggest mistake would be to treat either repo as a drop-in template for the other. Their cores are solving different layers of the stack.

## Scope

This review compares the local Swayambhu repo against the upstream `AgentToolkit/altk-evolve` repo using:
- live Swayambhu runtime code
- local architecture and design docs
- sampled `altk-evolve` implementation files
- `altk-evolve` README, configuration, tracing, policy, and integration docs

The most important clarification is that Swayambhu's cognition and communication layers are substantially implemented in live code, not merely described in design documents.

## Repo Shape

### Swayambhu

- Runtime: Cloudflare Workers.
- Core: [`kernel.js`](../../kernel.js), [`userspace.js`](../../userspace.js), [`act.js`](../../act.js), [`reflect.js`](../../reflect.js), [`eval.js`](../../eval.js), [`memory.js`](../../memory.js).
- Safety model: immutable dharma, tiered KV writes, communication gating, inbound quarantine, provider cascade, rollback tripwire.
- Cognition model in live code:
  - explicit `plan -> act -> eval -> review -> memory` pipeline
  - three-tier action evaluation: embedding filter -> NLI -> LLM fallback
  - salience-gated experience formation
  - pattern strength updates
  - experience dedupe / recurrence merge
  - crash-to-memory synthesis
  - request-aware and continuity-aware planning
  - async deep-reflect lifecycle with dispatch / poll / apply
- Communication model in live code:
  - unified communication turn processor for inbound + internal turns
  - inbound triage separated from execution
  - substantive work queued into session requests via `trigger_session`
  - conversation state persisted in KV
  - distinct inbound vs internal cost budgets
  - hold / discard / outbox retry path for internal updates
  - suppression of trivial acknowledgements when work is already pending
- Self-modification: first-class, proposal-based, deployable through governor.
- Product shape: autonomous agent with channels, tools, dashboard API, patron SPA.

### altk-evolve

- Runtime shape: Python package + FastAPI + MCP server.
- Core sampled files: `altk_evolve/frontend/mcp/mcp_server.py`, `altk_evolve/backend/base.py`, `altk_evolve/llm/tips/tips.py`, `altk_evolve/llm/conflict_resolution/conflict_resolution.py`.
- Learning model: save trajectories, generate tips/guidelines, merge via LLM conflict resolution, retrieve relevant entities later.
- Infrastructure: Milvus/filesystem/Postgres backends, LiteLLM config, Phoenix tracing ingestion, UI explorer, Claude/Codex plugin integrations.
- Product shape: learning/memory subsystem for agents, not a self-governing runtime.

## Compare and Contrast

### 1. System Boundary

- **Swayambhu** owns execution, governance, safety, communication, reflection, and self-modification.
- **altk-evolve** assumes another agent/runtime exists and improves that agent's memory and reusable guidance.

This is the core split: **runtime organism vs learning substrate**.

### 2. Safety Philosophy

- **Swayambhu** enforces safety mechanically in the kernel.
- **altk-evolve** mostly relies on the host system's boundaries; within the sampled design, learned entities do not appear to have a comparable immutable/protected split.

This is the most important asymmetry.

### 3. Learning Philosophy

- **Swayambhu** does not just "reflect"; it mechanically transforms execution into audited memory. The live code separates planning, execution, evaluation, review, and memory formation, with explicit salience gating and recurrence suppression.
- **altk-evolve** learns through trajectory capture, entity extraction, retrieval, provenance, and conflict resolution.

Corrected read:
- Swayambhu is stronger on **closed-loop cognition**: action evaluation, memory hygiene, bootstrap behavior, crash learning, and asynchronous deep reflection.
- altk-evolve is stronger on **portable memory products**: reusable guidelines/policies, external retrieval, provenance ergonomics, and packaging.

### 4. Portability and Packaging

- **Swayambhu** is intentionally KV/Workers-centric.
- **altk-evolve** is much more portable: backend choices, LiteLLM, Phoenix, MCP, Codex/Claude plugin packaging.

altk-evolve is materially ahead on adoption ergonomics.

### 5. Communication Architecture

- **Swayambhu** has a real communication subsystem, not just channel adapters. The live hook splits:
  - inbound human triage vs internal agent-originated updates
  - conversation state vs work execution
  - immediate replies vs queued work contracts
  - send / hold / discard decisions
  - inbound and internal conversation budgets

The important design point is that chat does not directly become arbitrary execution. Inbound communication is triage-first: reply, clarify, queue work, or discard. Internal updates are separately judged for whether they should be delivered now, held for later, or dropped.

- **altk-evolve** has no equivalent live communication brain in the sampled architecture. It integrates with Claude/Codex and exposes MCP tools, but it does not own an interaction loop with its own delivery policy, request queueing, outbox handling, or conversational state machine.

This matters because Swayambhu's communication hook is part of its safety and cognition story, not just UX plumbing.

### 6. What Code Inspection Clarifies

- It understated that Swayambhu's cognitive substrate is already implemented in code, not merely described in docs.
- It understated the degree of mechanical evaluation already present in Swayambhu.
- It understated that Swayambhu also has a live communication policy layer, not merely channels and send tools.
- It overstated the gap between Swayambhu and altk-evolve on "learning infrastructure"; the real gap is narrower and more specific.

## What Swayambhu Should Learn or Take

### 1. Explicit conflict resolution for learned guidance

This is the highest-confidence import.

altk-evolve has a real mechanism for merging new insights with existing guidance. Swayambhu's reflective updates to patterns/desires/guidance are rich, but the repo evidence does not show an equally explicit reconciliation layer for contradictory learned structures.

What to take:
- A conflict-resolution pass before deep-reflect commits contradictory pattern/guidance updates.
- Provenance attached to learned patterns so later reflection can see not just the current state, but why that state exists.

Why it fits:
- It strengthens Swayambhu's current cognition model instead of replacing it.
- It addresses a real failure mode: silent drift or accumulation of inconsistent internal guidance.

### 2. Trajectory-oriented retrieval as a complement to current reflection signals

altk-evolve's retrieval model is not Swayambhu's architecture, but one piece is useful: task-similar retrieval over prior successful trajectories/guidelines.

What to take:
- A lightweight retrieval layer over prior experiences, reflective outputs, or skill-like guidance.
- Use it as a complement to current pattern-strength / salience logic, not as a replacement.

Why it fits:
- Swayambhu already has structured memory and reflection artifacts.
- Similarity-based recall can improve action quality in cases where raw strength/salience is too coarse.

### 3. Better packaging for external reuse

This is lower priority than the two items above, but still real.

altk-evolve's Claude/Codex integration story is much more operationally mature. Swayambhu has specs and internal concepts for skills, but not the same end-user packaging discipline.

What to take:
- Cleaner install/use paths for skills or bounded integrations.
- Better separation between "internal architecture" and "portable external plugin surface".

### 4. Optional: better provenance ergonomics for communication/work handoff

Swayambhu's communication hook already has stronger execution discipline than altk-evolve, but altk-evolve's provenance style is still useful.

What to take:
- Better surfaced provenance on why a request was queued, deferred, dropped, or answered conversationally.
- Cleaner inspection surfaces for conversation-to-work transitions.

## What altk-evolve Should Learn or Take

### 1. Immutable and tiered knowledge/policy layers

This is the highest-confidence import in the other direction.

If a learning substrate lets new trajectories and derived guidance rewrite everything equally, it has no hard floor. Swayambhu's immutable/kernel-only/protected/agent split is the right architectural lesson.

What to take:
- A true tier model for stored entities.
- Foundational policies or invariants that learned guidance cannot overwrite.
- A gated update path for sensitive policy/state classes.

Why it fits:
- It does not require altk-evolve to become Swayambhu.
- It directly strengthens the safety of what altk-evolve already does.

### 2. A kernel/userspace-style safety boundary

This is broader than tiered storage and more important over time.

Swayambhu's strongest idea is not just "have safety checks"; it is **architectural separation** between mutable cognition/policy and non-negotiable enforcement.

What to take:
- A minimal trusted core for unsafe capabilities or policy-critical mutations.
- A clear boundary between what learning outputs may suggest and what the trusted runtime may execute.

Why it fits:
- If altk-evolve remains a passive memory service, this is optional.
- If altk-evolve gets more agentic, it becomes necessary very quickly.

### 3. A structured memory-formation pipeline

This became much more important after inspecting `userspace.js`.

Swayambhu is not merely storing "what happened." It has a coded pipeline for:
- evaluating outcomes before memory write
- gating writes by salience
- updating pattern strength separately from experience storage
- deduplicating near-identical experiences
- merging recurrence/support metadata
- forcing crashes into memory even when the normal loop dies

That is a deeper learning architecture than "save trajectory, generate tips, merge conflicts."

What to take:
- Separate raw trajectories from promoted memory artifacts.
- Add memory write criteria stronger than "an LLM extracted a tip."
- Add recurrence/dedup logic and support metadata.
- Treat crashes/errors as first-class learnable artifacts, not just logs.

Why it fits:
- It strengthens altk-evolve at its actual core.
- It is useful even if altk-evolve never becomes a full autonomous runtime.

### 4. Conditional: staged self-modification governance

altk-evolve should not copy Swayambhu's governor machinery today just because it exists.

But if altk-evolve evolves from "memory substrate" toward "runtime that lets agents rewrite tools or policies", then Swayambhu's staged proposal/deploy/rollback approach is the right pattern to copy.

Current verdict:
- Not an immediate adoption.
- Strong conditional pattern for future scope expansion.

### 5. Conditional: communication-hook architecture if altk-evolve becomes interactive

If altk-evolve grows from MCP/memory substrate into a system that owns live user interaction, it should study Swayambhu's communication hook closely.

The transferable pattern is:
- triage before execution
- queue durable work rather than doing it in chat
- keep conversation state distinct from work state
- separate internal update delivery from inbound human turns
- support hold / discard / retry instead of forcing every internal event into an immediate message

Why it fits:
- This is a stronger pattern than naive "user says X, agent executes X" chat loops.
- It prevents conversational paths from becoming an accidental privileged execution surface.

## What Each Repo Should Not Copy

### Swayambhu should not copy

- **Multiple storage backends as a goal in itself.** KV/Workers is load-bearing for its current design.
- **An MCP-first worldview.** MCP is useful as an integration layer, but it is not a substitute for Swayambhu's kernel/tool architecture.
- **altk-evolve's general-purpose substrate framing.** Swayambhu's distinctiveness comes from owning runtime and governance.

### altk-evolve should not copy

- **Swayambhu's purpose-heavy constitution framing verbatim.** The underlying idea of invariant layers transfers; the specific identity framing does not.
- **The full two-worker governor architecture before it needs it.** That only pays for itself once self-modifying runtime behavior exists.
- **Swayambhu's substrate coupling.** altk-evolve's portability is one of its real strengths and should be preserved.

## Recommendations

### Highest-leverage recommendations

1. **altk-evolve:** add immutable/tiered policy and knowledge layers.
2. **altk-evolve:** add a structured memory-formation pipeline instead of relying primarily on raw trajectory capture plus LLM-derived tip extraction.
3. **Swayambhu:** add explicit conflict resolution for contradictory learned patterns/guidance.
4. **altk-evolve:** add a kernel/userspace-style safety boundary if it becomes more agentic.
5. **Swayambhu:** add trajectory-oriented retrieval over prior reflective artifacts/experiences.

### Secondary / conditional recommendations

- **altk-evolve:** add communication gating if it begins to own outbound side effects.
- **altk-evolve:** if it becomes interactive, adopt a communication hook closer to Swayambhu's triage / queue / hold / discard architecture instead of a flat chat-to-execution loop.
- **Swayambhu:** add richer structured tracing if current KV logging, action records, and karma become an operational bottleneck.
- **altk-evolve:** adopt staged proposal/deploy governance only if it expands into runtime self-modification.
- **Swayambhu:** improve external packaging and plugin ergonomics where it wants bounded reuse.

## Bottom Line

If Swayambhu borrows from altk-evolve, it should borrow **targeted learning-product discipline**: conflict resolution, retrieval products, provenance ergonomics, packaging.

If altk-evolve borrows from Swayambhu, it should borrow **runtime-and-memory discipline**: immutable layers, trusted-core boundaries, explicit evaluation before memory promotion, communication triage boundaries, and eventually staged self-modification governance.

That is the cleanest cross-pollination path because it respects what each repo already is instead of trying to collapse them into the same thing.

## Which Project Is More Significant?

**Swayambhu is the more significant project overall.**

Reason:
- Architecturally, it is attempting something rarer and deeper: a unified system where safety boundaries, cognition, communication, memory formation, reflection, and self-modification are all part of one coherent runtime.
- The code-first audit makes clear that this is not mostly speculative design. The cognitive and communication substrate is already substantially implemented in live code.
- altk-evolve is the more adoptable and more immediately reusable project. It is likely easier to deploy today inside other agent stacks, and it is stronger on packaging and ecosystem surface area.
- But significance is not the same as usability. altk-evolve is a strong component. Swayambhu is a stronger thesis about what an autonomous agent architecture can be.

So the final judgment is:
- **More significant architecturally and conceptually:** Swayambhu
- **More immediately practical and reusable as infrastructure:** altk-evolve

## Sources

External:
- https://github.com/AgentToolkit/altk-evolve
- https://github.com/AgentToolkit/altk-evolve/blob/main/README.md
- https://github.com/AgentToolkit/altk-evolve/blob/main/docs/guides/configuration.md
- https://github.com/AgentToolkit/altk-evolve/blob/main/docs/guides/low-code-tracing.md
- https://github.com/AgentToolkit/altk-evolve/blob/main/docs/reference/policies.md
- https://github.com/AgentToolkit/altk-evolve/blob/main/platform-integrations/codex/plugins/evolve-lite/README.md

Local:
- [`README.md`](../../README.md)
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`docs/dev/architecture.md`](../dev/architecture.md)
- [`docs/dev/reflection-system.md`](../dev/reflection-system.md)
- [`docs/dev/provider-cascade.md`](../dev/provider-cascade.md)
- [`docs/dev/tools-reference.md`](../dev/tools-reference.md)
- [`userspace.js`](../../userspace.js)
- [`eval.js`](../../eval.js)
- [`memory.js`](../../memory.js)
- [`hook-communication.js`](../../hook-communication.js)
- [`tests/userspace.test.js`](../../tests/userspace.test.js)
- [`tests/chat.test.js`](../../tests/chat.test.js)
- [`specs/skills.md`](../../specs/skills.md)

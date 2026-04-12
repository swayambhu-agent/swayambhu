# Swayambhu vs altk-evolve Summary

Date: 2026-04-09

## Short Version

These projects are adjacent, not directly comparable.

- **Swayambhu** is a full autonomous runtime.
- **altk-evolve** is a learning and memory substrate for other agents.

That difference matters more than language, framework, or deployment style.

## The Main Story

Swayambhu is trying to solve the harder architectural problem.

It does not just store memories or expose tools. It combines:
- hard runtime safety boundaries
- an explicit `plan -> act -> eval -> review -> memory` loop
- asynchronous deep reflection
- communication triage separated from execution
- governed self-modification

altk-evolve is solving a narrower but very useful problem:
- capture trajectories
- extract reusable guidance
- retrieve relevant entities later
- support provenance, tracing, UI, and broad integration surfaces

It is more portable, easier to reuse inside other stacks, and stronger on packaging and ecosystem fit.

So the overall shape is:
- **Swayambhu** is the deeper architecture.
- **altk-evolve** is the cleaner reusable component.

## What Swayambhu Should Learn From altk-evolve

Now that the code-level cognition is taken into account, the imports from altk-evolve are narrower and more specific:

1. **Conflict resolution for learned guidance.**
Swayambhu has strong memory formation, but it would benefit from a more explicit mechanism for reconciling contradictory learned patterns or guidance.

2. **Trajectory-style retrieval products.**
Swayambhu already has experiences and reflection artifacts. altk-evolve suggests a useful additional layer: retrieve similar prior trajectories or guidance when deciding what to do now.

3. **Packaging and provenance ergonomics.**
altk-evolve is better at making its learning system inspectable and portable for external users and toolchains.

## What altk-evolve Should Learn From Swayambhu

This is where the stronger architectural transfer now sits.

1. **Immutable / tiered knowledge layers.**
Not all learned artifacts should be able to overwrite foundational guidance.

2. **A trusted-core safety boundary.**
Swayambhu's kernel vs mutable policy split is the right pattern once a system becomes more agentic.

3. **A structured memory-formation pipeline.**
Swayambhu does not just save experiences; it evaluates them, gates them by salience, updates pattern strength separately, deduplicates recurrence, and forces crashes into memory. That is a more disciplined learning architecture than raw trajectory capture plus tip extraction.

4. **If altk-evolve becomes interactive, a better communication architecture.**
Swayambhu's communication hook separates chat triage from execution and queues durable work instead of executing directly from chat.

## What Neither Should Copy Blindly

- Swayambhu should not adopt backend portability or MCP-first design as goals in themselves. Its KV/Workers coupling is part of its architecture.
- altk-evolve should not copy Swayambhu's full governor/runtime machinery or constitution framing unless its scope changes dramatically.

## Final Judgment

**Swayambhu is the more significant project overall.**

It is architecturally more ambitious.

**altk-evolve is the more immediately practical and reusable project.**

If the question is "which repo is the bigger architectural contribution?", the answer is Swayambhu.

If the question is "which repo is easier to adopt today inside many other agent stacks?", the answer is altk-evolve.

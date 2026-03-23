# Agent Skills for Swayambhu

Status: design
Ref: https://agentskills.io/home

## Concept

Skills are procedural knowledge — reusable instructions that tell the agent
how to approach a class of problem using the tools it already has. They are
not executable code (that's tools) or principled knowledge (that's wisdom).
They are composed workflows and expertise that the agent crystallizes from
experience during reflection.

Inspired by the open Agent Skills spec (agentskills.io) but adapted for
Swayambhu's internal architecture.

## KV Schema

```
skill:{name}  →  {
  name,               // lowercase, hyphens, matches key suffix
  description,        // what this skill does and when to use it
  instructions,       // markdown body — step-by-step procedure
  tools_used,         // which tools this skill typically involves
  trigger_patterns,   // helps act match tasks to skills
  created_by_depth,   // which reflect level authored it
  created_at,         // ISO timestamp
  revision,           // incremented on updates
}
```

## Discovery

Skill manifest (names + descriptions + trigger_patterns) injected into
act's system prompt, same pattern as wisdom_manifest. No tool call
needed just to know what skills exist.

## Activation

Act loads full skill instructions via `kv_query` when it decides one
is relevant. Two modes, chosen by act at runtime:

- **Inline**: simple skills (3-5 step procedures) — act reads and
  follows the instructions directly.
- **Subplan**: complex skills (multi-tool workflows with branching) —
  act spawns a subplan with the skill instructions as goal/context.

No need for the skill metadata to declare which mode. Act judges this.

## Creation

Session reflect (depth 0) proposes, deep reflect (depth 1+) approves.

- Session reflect has the freshest signal — "I just did this multi-step
  thing again." It stages a skill via the Modification Protocol with
  `type: 'skill'`.
- Deep reflect has cross-session visibility to judge whether the pattern
  is real or a one-off. It reviews and promotes/rejects.

Mirrors the wisdom creation pattern.

## Modification Protocol

New type: `type: 'skill'`. Distinct from `code` (executable mutations)
and `wisdom` (principled knowledge). The staging/promotion/rollback
machinery works the same. Distinct type enables:

- Different validation requirements
- Different git sync paths
- Clear intent in karma logs

## Git Sync

`skill:{name}` maps to `skills/{name}.md` — flat, one file per skill.
Markdown with metadata as frontmatter at the top (matching the Agent
Skills spec shape).

If skills later need bundled scripts or references, those become separate
KV keys (`skill:{name}:ref:{file}`) mapped to `skills/{name}/{file}`.
Don't build until needed.

## Prompt Changes Required

The real work. Three prompts need updates:

1. **prompt:act** — needs to know skills exist, how to discover them
   (manifest in system prompt), how to activate them (kv_query + follow
   or spawn_subplan).

2. **prompt:reflect** (depth 0) — needs to know it can propose skills
   via modification_requests with `type: 'skill'`. Needs the skill
   schema so it can author well-formed entries.

3. **prompt:reflect:1** (depth 1) — needs to know it reviews skill
   proposals from depth 0. Needs criteria for when a pattern warrants
   a skill vs. being a one-off.

## Open Questions

- Should skills have a TTL or usage counter that triggers review/pruning?
- Should act be able to suggest skill improvements (fed back to reflect)?
- Maximum number of skills before the manifest bloats the act prompt?
- Should skills reference other skills (composition)?

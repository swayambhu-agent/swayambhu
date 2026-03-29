# Enhancements

Tracked ideas for future improvement. Not prioritized — just captured.

## Dashboard

- **Event numbering in timeline**: Add index numbers to karma events in the timeline view so they can be referenced easily (e.g. "event 23" instead of scrolling to find it).

- **Preserve tab state on navigation**: When switching between tabs (Timeline, KV, etc.) and back, the previously selected session, expanded event, and scroll position should be preserved instead of resetting.

- **Local spend estimate alongside provider balance**: The OpenRouter balance API has a reconciliation delay, so after an expensive session (e.g. deep reflect at $0.43) the displayed balance doesn't update immediately. Could sum `cost` fields from karma events to show a local "spent this session" or "estimated current balance" figure that updates instantly.

## Act

- **Surface deep reflect schedule in act context**: The agent doesn't know when the next deep reflect is due, leading it to waste steps trying to trigger one manually. Add a line to the act prompt: "Deep reflections are scheduled automatically by the kernel." and include the schedule details (last ran session N, next due at session M or date D). The kernel already reads `reflect:schedule:1` in `highestReflectDepthDue` — just pass it through to the act context. Cheap to compute, prevents a whole class of wasted effort.

- **Minimax at low effort is too weak for act**: Session `s_1774023539576_q4il9u` showed minimax reading the alias map (opus, sonnet, haiku, etc.) and then immediately passing `"deep_reflect"` as a model name to spawn_subplan. It had the right information but couldn't connect the dots. Consider notching up to medium effort or switching to a more capable model (mimo, sonnet) for act — the token savings from minimax are negated when it makes mistakes that burn 8 fallback cycles.

## Tools

- **web_fetch returns raw HTML — wastes tokens and causes hangs**: `web_fetch` returns full HTML pages including scripts, nav, footers. When a subplan fetches multiple pages and sends them to the LLM, the context is massive and mostly useless. This caused a session hang — the LLM call with 4 full HTML pages in context timed out and killed the worker process. Fix: extract text content from HTML (strip tags, scripts, styles) before returning. The `max_length` parameter exists but the agent rarely uses it, and even truncated HTML is mostly boilerplate. A smarter extraction (readability-style) would give the agent the article text it actually needs.

- **kv_manifest silent miss on wrong prefix**: `kv_manifest` returns `{ keys: [], count: 0 }` for both a typo'd prefix and a legitimately empty prefix — the agent can't tell the difference. Could silently poll a wrong prefix forever thinking "nothing new yet." Not fixable at the KV level (prefix scans have no concept of "this namespace exists"). Possible mitigations: prompt guidance ("if a prefix scan returns empty unexpectedly, verify against a broader scan"), or a heuristic in the tool that warns when a prefix has no keys and doesn't match any known prefix pattern.

## Naming

- ~~**Rename "orient" to "act" throughout codebase**~~ — **Status: Done.** Completed via `scripts/migrate-orient-to-act.mjs` and manual sweep.

## Contacts & Roles

- **Support role**: Introduce a `support` contact role alongside `patron`. The patron is the non-technical person who funds and communicates with the agent. The support contact is the technical person who diagnoses and fixes platform bugs. Key design points:
  - Support never touches the live agent's state directly — they export a KV snapshot, replicate locally, diagnose, fix the platform code, and deploy.
  - The broken agent self-heals on next session (or the patron resets state via dashboard if needed).
  - No special write permissions required — just read access (KV snapshot export) and a communication channel.
  - Patron-granted: only the patron can designate a support contact.
  - Scaling vision: the platform builder's own agent acts as support for other patrons' agents, via a skill.
  - A "type 2" failure (agent gets itself into a bad state through self-modification) is really a "type 1" failure (platform bug in the guardrails/reflection/rollback system) — so the fix is always at the platform level.

- **Platform update propagation**: Agents should periodically check the swayambhu GitHub repo for platform updates. Updates flow through three tiers:

  **Tier 1 — Kernel-only (no interface changes):** Governor-managed, fully automated. Agent detects new version available, notifies patron. Patron approves via dashboard, governor pulls new kernel from GitHub, rebuilds with agent's existing KV code, deploys. Scales to millions of agents.

  **Tier 2 — Advisory:** Published guidance rather than code pushes. E.g. "We improved how act context is built — here's the pattern." Agent reads advisories during normal sessions, evaluates them against its own (potentially divergent) codebase, and implements changes through its existing self-modification process (proposals → review → deploy). Uses the self-improvement system rather than bypassing it. Each agent adapts the advice to its own code. Free — the agent does its own work.

  **Tier 3 — Breaking interface changes:** The agent can't self-fix because a kernel interface it depends on has changed. Requires migration by an authorized support agent. Support agent takes a KV snapshot, understands both old and new interfaces, performs the migration, patron approves the result. This is a paid service — the more an agent has diverged through self-modification, the more custom the migration, the more valuable the work. Support agents that have migrated many agents build expertise and efficiency. This is the natural revenue model: open source software, paid technical support.

## Tool Management

- **First-class tool add/remove operations**: Currently adding or removing a tool requires updating multiple KV keys in sync (`tool:*:code`, `tool:*:meta`, `config:tool_registry`, `kernel:tool_grants`, and the governor rebuild). There's no atomic operation for this. A kernel-level `registerTool` / `deregisterTool` method would handle all keys atomically — update the registry, write/delete code+meta, trigger a governor rebuild. The agent could invoke these via `proposal_requests` in deep reflect, and the patron could use them via a script or dashboard action.

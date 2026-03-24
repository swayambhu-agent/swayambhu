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

- **kv_manifest silent miss on wrong prefix**: `kv_manifest` returns `{ keys: [], count: 0 }` for both a typo'd prefix and a legitimately empty prefix — the agent can't tell the difference. Could silently poll a wrong prefix forever thinking "nothing new yet." Not fixable at the KV level (prefix scans have no concept of "this namespace exists"). Possible mitigations: prompt guidance ("if a prefix scan returns empty unexpectedly, verify against a broader scan"), or a heuristic in the tool that warns when a prefix has no keys and doesn't match any known prefix pattern.

## Naming

- ~~**Rename "orient" to "act" throughout codebase**~~ — **Status: Done.** Completed via `scripts/migrate-orient-to-act.mjs` and manual sweep.

## Tool Management

- **First-class tool add/remove operations**: Currently adding or removing a tool requires updating multiple KV keys in sync (`tool:*:code`, `tool:*:meta`, `config:tool_registry`, `kernel:tool_grants`, and the governor rebuild). There's no atomic operation for this. A kernel-level `registerTool` / `deregisterTool` method would handle all keys atomically — update the registry, write/delete code+meta, trigger a governor rebuild. The agent could invoke these via `proposal_requests` in deep reflect, and the patron could use them via a script or dashboard action.

# Reflection & Wisdom

How Swayambhu examines its own behavior, schedules recursive
self-examination, and accumulates operating principles.

All reflection code lives in `hook-reflect.js` (KV key
`hook:wake:reflect`). Wake flow integration is in `hook-main.js`.
Principle enforcement (yamas, niyamas) is kernel-level in `brainstem.js`.

---

## Reflection Hierarchy

```
wake()
  │
  ├─ reflectDepth > 0?
  │     YES → runReflect(depth)     [deep reflect — replaces orient]
  │             │
  │             ├─ depth 2+: examines depth-1 outputs
  │             │     └─ cascades down: runReflect(depth-1)
  │             │           └─ ... until depth 1
  │             │
  │             └─ depth 1: examines orient patterns, karma, prompts
  │                   └─ applyReflectOutput (full verdict authority)
  │
  │     NO → runSession()
  │             └─ orient agent loop
  │                   └─ executeReflect()     [session reflect — depth 0]
  │                         └─ limited verdicts (withdraw/modify only)
```

The wake flow chooses between deep reflect and a normal session at
`hook-main.js:116`. They are **mutually exclusive** — a deep reflect
wake does not run orient, and a normal session does not run deep reflect.

---

## Session Reflect (Depth 0)

`hook-reflect.js:14` — `executeReflect(K, state, step)`

Runs after every orient session (`hook-main.js:205`), unless the budget
was fully exhausted and no reflect reserve was configured.

### Characteristics

- **No tools** — `tools: []`, `maxSteps: 1`
- **Single LLM call** — one-shot JSON output, no agent loop
- **Limited authority** — can only withdraw or modify staged modifications;
  cannot accept, reject, promote, rollback, or defer

### Flow

1. Loads `prompt:reflect` from KV (falls back to `defaultReflectPrompt()`)
2. Loads system key patterns for template injection
3. Builds system prompt via `K.buildPrompt`
4. Gathers context: karma log (with `request`/`tools_available` fields
   stripped from `llm_call` events), session cost, staged modifications
   with check results
5. Resolves model from `step.model` or `defaults.reflect.model`
6. Calls `K.runAgentLoop` with `maxSteps: 1`

### Output processing

On parse failure (`output.raw !== undefined`): writes raw output to both
`last_reflect` and `reflect:0:{sessionId}` with `parse_error: true`.
Returns early — no further processing.

On success, processes in order:

1. **last_reflect** — writes full output + `session_id`
2. **reflect:0:{sessionId}** — stores `reflection`, `note_to_future_self`,
   depth, session_id, timestamp
3. **kv_operations** — each op passed through `applyKVOperation` (protection
   gated)
4. **modification_verdicts** — `processReflectVerdicts` (withdraw/modify
   only)
5. **modification_requests** — each request passed to `stageModification`
   at depth 0
6. **next_wake_config** — converts `sleep_seconds` to absolute
   `next_wake_after` timestamp, writes `wake_config`

### Session reflect output fields

| Field | Required | Description |
|-------|----------|-------------|
| `session_summary` / `reflection` | yes | What happened this session |
| `note_to_future_self` | yes | Carried into next session's context |
| `next_orient_context.load_keys` | no | KV keys to load for next orient |
| `next_wake_config` | no | Sleep duration, effort for next wake |
| `kv_operations` | no | Direct KV writes (protection gated) |
| `modification_verdicts` | no | Verdicts on staged modifications |
| `modification_requests` | no | New modifications to stage |

---

## Deep Reflect (Depth 1+)

`hook-reflect.js:119` — `runReflect(K, state, depth, context)`

Runs instead of orient when `highestReflectDepthDue` returns > 0.

### Characteristics

- **Has tools** — full tool definitions minus `spawn_subplan`
  (`hook-reflect.js:134-135`)
- **Multi-step agent loop** — configurable `maxSteps` per depth
- **Full authority** — can apply, reject, promote, rollback, defer, modify,
  withdraw modifications; can process comms verdicts; can create direct
  inflight modifications
- **Recursive** — after processing, cascades to `depth - 1` if depth > 1
  (`hook-reflect.js:162-164`)

### Flow

1. Loads depth-specific prompt via `loadReflectPrompt`
2. Gathers context via `gatherReflectContext`
3. Loads below-level prompt via `loadBelowPrompt`
4. Builds system prompt with template variables
5. Builds tool definitions (all except `spawn_subplan`)
6. Resolves model via `getReflectModel`
7. Computes budget cap: `max_cost * budget_multiplier`
8. Calls `K.runAgentLoop` with tools, multi-step
9. Processes output via `applyReflectOutput`
10. If depth > 1: recursively calls `runReflect(depth - 1, context)`

### Recursion pattern

Deep reflect runs top-down. If depth 3 is due:
1. `runReflect(3)` → examines depth-2 outputs
2. `runReflect(2)` → examines depth-1 outputs
3. `runReflect(1)` → examines orient patterns, karma, prompts

Each depth calls `applyReflectOutput` before cascading, so higher-depth
changes (e.g. modifying `prompt:reflect:1`) are visible to lower depths.

### One-level-below write discipline

The default prompt for depth 2+ includes: "You can only propose
modifications targeting `prompt:reflect:{depth-1}`." This is a
prompt-level convention, not a kernel-enforced constraint.

---

## Scheduling

### isReflectDue(K, state, depth)

`hook-reflect.js:338`

Checks whether a given depth should run this wake. Two paths:

**With schedule** (`reflect:schedule:{depth}` exists):
- Computes `sessionsSince = currentCount - schedule.last_reflect_session`
- Computes `daysSince` from `schedule.last_reflect` timestamp
- Triggers if `sessionsSince >= maxSessions` OR `daysSince >= maxDays`
- Thresholds from schedule's `after_sessions`/`after_days`, falling back
  to `defaults.deep_reflect.default_interval_sessions` (default 20) and
  `defaults.deep_reflect.default_interval_days` (default 7)

**Cold-start fallback** (no schedule exists):
- Uses exponential interval: `baseInterval * multiplier^(depth-1)`
- `baseInterval` = `defaults.deep_reflect.default_interval_sessions` (20)
- `multiplier` = `defaults.execution.reflect_interval_multiplier` (5)
- Triggers when `sessionCount >= threshold`
- Example: depth 1 at session 20, depth 2 at session 100, depth 3 at 500

### highestReflectDepthDue(K, state)

`hook-reflect.js:364`

Scans from `max_reflect_depth` (default 1) down to 1. Returns the highest
depth that is due, or 0 if none. The wake flow uses this to decide whether
to run deep reflect or orient (`hook-main.js:88, 116`).

### Schedule updates

Deep reflect writes its own schedule in `applyReflectOutput`
(`hook-reflect.js:244-253`). The output field `next_reflect` (or
`next_deep_reflect`) specifies `after_sessions` and `after_days`.
The system appends `last_reflect` (timestamp) and `last_reflect_session`
(count) before writing to `reflect:schedule:{depth}`.

This means the reflection LLM controls its own frequency — it can
accelerate or decelerate based on what it observes.

---

## Prompt Loading

### loadReflectPrompt(K, state, depth)

`hook-reflect.js:299`

1. Tries `prompt:reflect:{depth}` in KV
2. Falls back to `defaultDeepReflectPrompt(depth)`

> **NOTE:** Session reflect (depth 0) does NOT use `loadReflectPrompt`.
> It loads `prompt:reflect` directly (`hook-reflect.js:18`) and falls back
> to `defaultReflectPrompt()`. The naming is different: `prompt:reflect`
> (session) vs `prompt:reflect:{depth}` (deep).

### loadBelowPrompt(K, depth)

`hook-reflect.js:305`

- Depth 1: returns `prompt:orient`
- Depth 2+: returns `prompt:reflect:{depth-1}`

Injected as `{{belowPrompt}}` in the deep reflect prompt template.

### defaultReflectPrompt()

`hook-reflect.js:374`

Session reflect fallback. Minimal prompt asking for JSON with:
`session_summary`, `note_to_future_self`, `next_orient_context`,
and optionally `next_wake_config`, `kv_operations`,
`modification_verdicts`, `modification_requests`.

### defaultDeepReflectPrompt(depth)

`hook-reflect.js:384`

**Depth 1:** Instructs the LLM to examine karma, orient prompt, and
patterns. Lists the full output schema. Notes that `modification_requests`
go through `acceptDirect` and `modification_verdicts` target
staged/inflight modifications.

**Depth 2+:** Instructs the LLM to examine depth-(n-1) outputs for
patterns, drift, and alignment. Includes the one-level-below write
discipline. Shows `{{belowPrompt}}` template variable.

---

## Context Gathering

### Session reflect context

Built inline in `executeReflect` (`hook-reflect.js:28-43`). The user
message is a JSON string containing:

| Field | Source |
|-------|--------|
| `karma` | `K.getKarma()` with `request`/`tools_available` stripped from `llm_call` events |
| `sessionCost` | `K.getSessionCost()` |
| `stagedModifications` | `loadStagedModifications(K)` — staged records with check results |

System prompt template variables:

| Variable | Source |
|----------|--------|
| `systemKeyPatterns` | `K.getSystemKeyPatterns()` — prefixes + exact keys |

### Deep reflect context — gatherReflectContext()

`hook-reflect.js:167`

Returns `{ userMessage: "Begin.", templateVars }`. The user message is
just `"Begin."` — all context goes into template variables for the system
prompt.

Template variables:

| Variable | Source | Description |
|----------|--------|-------------|
| `orientPrompt` | `prompt:orient` KV key | Current orient prompt text |
| `currentDefaults` | `state.defaults` | Full `config:defaults` |
| `models` | `state.modelsConfig` | Full `config:models` |
| `stagedModifications` | `loadStagedModifications(K)` | Staged records + check results |
| `inflightModifications` | `loadInflightModifications(K)` | Inflight records + check results |
| `blockedComms` | `K.listBlockedComms()` | Blocked outbound messages (or `"(none)"`) |
| `patron_contact` | `K.getPatronContact()` | Patron contact record JSON (or `"(no patron configured)"`) |
| `patron_id` | `K.getPatronId()` | Patron slug string |
| `patron_identity_disputed` | `K.isPatronIdentityDisputed()` | Boolean — true if patron fields changed unverified |
| `systemKeyPatterns` | `K.getSystemKeyPatterns()` | Prefixes + exact keys the agent cannot write |
| `recentSessionIds` | `cache:session_ids` KV key | Array of recent session IDs |
| `context.orBalance` | `context.balances.providers.openrouter.balance` | OpenRouter balance (or `"unknown"`) |
| `context.walletBalance` | `context.balances.wallets.base_usdc.balance` | Wallet balance (or `0`) |
| `context.effort` | `context.effort` / `defaults.deep_reflect.effort` | Effort level (default `"high"`) |
| `context.crashData` | `context.crashData` | Crash data from `detectCrash` (or `"none"`) |
| `belowOutputs` | `loadReflectHistory(K, depth-1, 10)` | Last 10 outputs from one level below (depth >= 1 only) |
| `depth` | depth parameter | Current reflection depth |
| `belowPrompt` | `loadBelowPrompt(K, depth)` | Prompt text for one level below |

---

## Reflect History

### Storage

Every reflection writes `reflect:{depth}:{sessionId}` with:
```json
{
  "reflection": "...",
  "note_to_future_self": "...",
  "depth": 1,
  "session_id": "s_...",
  "timestamp": "2026-03-16T..."
}
```

Session reflect (depth 0) also writes `last_reflect` — which is read by
the next orient session as context (`hook-main.js:76, 94`).

### loadReflectHistory(K, depth, count)

`hook-reflect.js:310`

Lists `reflect:{depth}:*` keys, sorts by name descending (newest first),
takes the top `count` (default 10), and loads all values via `K.loadKeys`.
Used by `gatherReflectContext` to populate `belowOutputs`.

> **NOTE:** The list call uses `limit: count + 10` as a buffer, then
> sorts and slices client-side. This works for small datasets but could
> miss entries if there are more than `count + 10` reflect records at a
> given depth.

---

## Model Selection

### getReflectModel(state, depth)

`hook-reflect.js:319`

Resolution order:
1. `defaults.reflect_levels[depth].model` — per-depth override
2. `defaults.deep_reflect.model` — deep reflect default
3. `defaults.orient.model` — global fallback

Session reflect uses a separate path: `step.model || defaults.reflect.model`
(`hook-reflect.js:45-47`).

This allows different models at different depths — e.g. a cheaper model
for depth 1, a more capable model for depth 2+.

---

## Max Steps

### getMaxSteps(state, role, depth)

`hook-reflect.js:326`

| Role | Resolution | Default |
|------|-----------|---------|
| `orient` | `defaults.execution.max_steps.orient` | 12 |
| `reflect` depth 1 | `defaults.reflect_levels[1].max_steps` → `defaults.execution.max_steps.reflect` | 5 |
| `reflect` depth 2+ | `defaults.reflect_levels[depth].max_steps` → `defaults.execution.max_steps.deep_reflect` | 10 |

Session reflect does not use `getMaxSteps` — it always runs with
`maxSteps: 1` (single call, no tool loop).

---

## Budget

### Session reflect

Uses whatever budget remains after orient. If orient exhausted the full
budget and no `reflect_reserve_pct` was configured, session reflect is
skipped entirely (`hook-main.js:203`).

If `session_budget.reflect_reserve_pct` is set, orient's budget is capped
at `max_cost * (1 - reflect_reserve_pct)`, reserving the remainder for
reflect.

### Deep reflect

Gets its own budget: `session_budget.max_cost * deep_reflect.budget_multiplier`
(`hook-reflect.js:141-145`). Only applied if `multiplier > 1`. If the
multiplier is 1 or unset, no budget cap is passed — deep reflect runs
uncapped.

---

## Output Processing

### Session reflect — inline in executeReflect

Processes: `kv_operations`, `modification_verdicts` (via
`processReflectVerdicts` — withdraw/modify only),
`modification_requests` (via `stageModification` at depth 0),
`next_wake_config`.

### Deep reflect — applyReflectOutput(K, state, depth, output, context)

`hook-reflect.js:211`

Processes in this order (order matters for conflict resolution):

1. **kv_operations** — each op through `applyKVOperation` (protection gated)
2. **modification_verdicts** — `processDeepReflectVerdicts` (full authority:
   apply, reject, withdraw, modify, promote, rollback, defer)
3. **comms_verdicts** — each verdict through `K.processCommsVerdict`
   (send, revise_and_send, drop)
4. **modification_requests** — each through `acceptDirect` (straight to
   inflight, no staging)
5. **next_reflect / next_deep_reflect** — writes `reflect:schedule:{depth}`
   with `after_sessions`, `after_days`, plus `last_reflect` timestamp and
   `last_reflect_session` count
6. **reflect:{depth}:{sessionId}** — stores reflection output
7. **last_reflect + wake_config** — only at depth 1 (the lowest deep
   reflect level). Writes `last_reflect` with `was_deep_reflect: true`.
   Writes `wake_config` from `next_wake_config` or empty object.
8. **state.refreshDefaults()** — reloads `config:defaults` so lower-depth
   reflections see changes made by higher depths
9. **Karma** — records `reflect_complete` with depth, session_id, and
   end balances

> **NOTE:** At depth 1, `wake_config` is written even if `next_wake_config`
> is absent in the output — it writes `{}` as the default
> (`hook-reflect.js:274`). This effectively clears any previous wake
> config, including sleep timers.

---

## Wisdom System

Two KV prefix families store accumulated wisdom:

### viveka:* — Discernment

`viveka:comms:*` and `viveka:channel:*` store communication wisdom.
Loaded by `loadCommsViveka()` in `brainstem.js:469` and injected into
the `COMMS_GATE_PROMPT`. Format: JSON, type `"wisdom"`.

These keys are in `SYSTEM_KEY_PREFIXES` — writes require
`kvWritePrivileged`. They can be written via the Modification Protocol
or via `kv_operations` in reflect output (which routes through
`applyKVOperation` in `hook-protect.js`).

### prajna:* — Self-knowledge

`prajna:*` keys are in `SYSTEM_KEY_PREFIXES` with format JSON, type
`"wisdom"`. They follow the same write rules as viveka keys.

> **NOTE:** No code in the codebase currently reads `prajna:*` keys.
> They exist in the type system (`brainstem.js:1999`) and are protected
> as system keys, but are not loaded into any prompt or context. They are
> available for the agent to write to and read via tools (e.g. `kv_query`),
> but have no kernel-level consumer.

### Wisdom via Modification Protocol

The Modification Protocol has a dedicated `wisdom` type for
principle-level changes. Wisdom modifications:
- Can only be staged by deep reflect (depth >= 1)
- Cannot use `acceptDirect` — must go through staging
- Inject the `validation` field into op values on accept
- Skip circuit breaker and git sync on promote

See `docs/dev/modification-protocol.md` for full details.

### Yamas and Niyamas — Operating Principles

`yama:*` and `niyama:*` keys are a higher tier than viveka/prajna. They
are kernel-enforced operating principles:

**Loading:** `loadYamasNiyamas()` runs at boot (`brainstem.js:322`).
Scans both prefixes and caches all values in `this.yamas` and
`this.niyamas`.

**Injection:** Every `callLLM` call prepends dharma, then yamas, then
niyamas to the system prompt (`brainstem.js:1416-1440`):

```
[DHARMA]
{dharma text}
[/DHARMA]

[YAMAS]
[yama_name]
{yama text}
[/yama_name]
...
[/YAMAS]

[NIYAMAS]
[niyama_name]
{niyama text}
[/niyama_name]
...
[/NIYAMAS]

{actual system prompt}
```

This is kernel-enforced — no hook or prompt modification can bypass it.

**Write gates** (`brainstem.js:746-760`):
- Yamas: require `deliberation` (min 200 chars) + `yama_capable` model
- Niyamas: require `deliberation` (min 100 chars) + `niyama_capable` model
- Model capability is checked against `config:model_capabilities` via
  `isYamaCapable()` / `isNiyamaCapable()`
- Audit trail written to `{key}:audit` after successful writes

**Format:** text (not JSON) — stored as plain strings in KV with type
`"yama"` / `"niyama"`.

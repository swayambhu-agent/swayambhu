# System Architecture

Swayambhu is an autonomous AI agent running on Cloudflare Workers. It wakes on a cron schedule, runs an LLM-driven session (orient), reflects on what it did, then sleeps until the next wake. All of its state — prompts, tools, config, memory, accumulated wisdom — lives in Cloudflare KV. The agent can modify its own prompts, tools, and config through a staged modification protocol, making the runtime disposable and the data the actual agent.

## System diagram

```
                        ┌──────────────────────────────────┐
                        │        Cloudflare Workers        │
                        │                                  │
                        │  ┌────────────┐  ┌────────────┐  │
 Cron (every minute) ──►│  │ kernel  │  │ dashboard  │  │◄── Operator browser
                        │  │   :8787    │  │  API :8790 │  │
 POST /channel/slack ──►│  │            │  │            │  │
                        │  └─────┬──────┘  └─────┬──────┘  │
                        │        │               │         │
                        │        └───────┬───────┘         │
                        │                │                 │
                        │         ┌──────▼───────┐         │
                        │         │  Cloudflare  │         │
                        │         │     KV       │         │
                        │         └──────────────┘         │
                        └──────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              ┌─────▼──────┐  ┌──────▼──────┐  ┌──────▼────┐
              │ OpenRouter │  │   Hetzner   │  │   Slack   │
              │  LLM APIs  │  │  (computer) │  │   Gmail   │
              └────────────┘  └─────────────┘  └───────────┘
```

**Two Worker deployments** share the same KV namespace:

| Worker | Source | Port (dev) | Entry points |
|--------|--------|------------|-------------|
| Kernel (main) | `kernel.js` | 8787 | `scheduled()` (cron), `fetch()` (HTTP) |
| Dashboard API | `dashboard-api/worker.js` | 8790 | `fetch()` only |

The kernel handles all agent logic — wake cycles, chat, tool execution, LLM calls. The dashboard API is a stateless KV reader that serves the operator UI. It authenticates via `X-Operator-Key` header against an `OPERATOR_KEY` env var.

---

## The kernel: `Kernel` class

`kernel.js:248` defines `class Kernel` — the hardcoded kernel. It enforces safety invariants that the agent cannot modify.

### Static safety properties

```js
static SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'proposal:', 'proposal:', 'hook:', 'doc:', 'git_pending:',
  'yama:', 'niyama:', 'upaya:', 'prajna:',
  'comms_blocked:', 'contact:', 'contact_index:', 'sealed:',
];
static KERNEL_ONLY_PREFIXES = ['kernel:', 'sealed:'];
static SYSTEM_KEY_EXACT = ['providers', 'wallets', 'patron:contact', 'patron:identity_snapshot'];
static IMMUTABLE_KEYS = ['patron:public_key'];
static DANGER_SIGNALS = ["fatal_error", "orient_parse_error", "all_providers_failed"];
static MAX_PRIVILEGED_WRITES = 50;
static PRINCIPLE_PREFIXES = ['yama:', 'niyama:'];
```

`isSystemKey(key)` returns true if a key matches any `SYSTEM_KEY_EXACT` value or starts with any `SYSTEM_KEY_PREFIXES` entry.

### What the kernel enforces

1. **Dharma immutability** — `kvPut()`, `kvPutSafe()`, and `kvWritePrivileged()` all reject writes to `"dharma"` and keys in `IMMUTABLE_KEYS`.

2. **Dharma + principles injection** — `callLLM()` prepends dharma, yamas, and niyamas to every system prompt before the hook-provided content. No hook or prompt modification can bypass this (`kernel.js:1416-1440`).

3. **Three-tier KV write gates:**
   - `kvPutSafe(key, value, metadata)` — blocks `dharma`, kernel-only keys, and system keys. Used for agent-created data.
   - `kvDeleteSafe(key)` — same blocks as `kvPutSafe`.
   - `kvWritePrivileged(ops)` — for system keys. Pre-validates the entire batch before any writes execute. Blocks `dharma`, `IMMUTABLE_KEYS`, kernel-only keys, and `contact:*`/`contact_index:*` keys (operator-only). Snapshots old values to karma, enforces per-session rate limit (50 writes), writes audit trails for principle keys, alerts on hook writes. Auto-reloads cached config after writing config keys.

4. **Communication gate** — `communicationGate()` (`kernel.js:515`) intercepts every tool call to a tool with a `communication` grant in `kernel:tool_grants`. Three checks in sequence:
   - Mechanical floor: blocks initiating contact with unknown persons (no contact record).
   - Model gate: current model must have `comms_gate_capable` flag.
   - LLM gate: calls an LLM with upaya context to get a send/revise/block/queue verdict.
   Blocked messages are stored as `comms_blocked:{id}` for deep reflect to review later.

5. **Inbound content gate** — tools with an `inbound` grant in `kernel:tool_grants` return external content. The kernel redacts content from unknown senders (no matching contact) and quarantines it under `sealed:*` keys (`kernel.js:1722-1751`). Sealed keys are unreadable by tools and hooks.

6. **Tool security grants** — `kernel:tool_grants` (`kernel.js:318`) is loaded at boot and controls which env secrets each tool can access, which tools pass through the communication/inbound gates, and which provider adapter each tool receives. Because it's a `kernel:*` key, the agent cannot modify it. Tool source files declare all fields in `export const meta`, but the seed script splits them: grant fields go to `kernel:tool_grants`, operational fields go to `tool:{name}:meta`.

7. **Hook safety tripwire** — `checkHookSafety()` (`kernel.js:934`) checks `kernel:last_sessions`. If the last 3 outcomes are all `"crash"` or `"killed"`, the kernel deletes the current hook modules and attempts to restore from `kernel:last_good_hook`. If no good version exists, it runs a hardcoded minimal fallback.

8. **Karma log** — `karmaRecord()` appends to an in-memory array and persists to `karma:{sessionId}` on every write. If the event is a danger signal, it also writes `last_danger`.

9. **Budget enforcement** — `callLLM()` checks `session_budget.max_cost` and `max_duration_seconds` before every LLM call. When exceeded, `runAgentLoop()` catches the error and returns `{ budget_exceeded: true }`.

### Key instance methods

| Method | What it does |
|--------|-------------|
| `loadEagerConfig()` | Loads `config:defaults`, `config:models`, `config:model_capabilities`, `dharma`, `config:tool_registry`, `kernel:tool_grants`, yamas/niyamas, and patron context into instance fields. Called once at session start. |
| `runScheduled()` | Top-level entry point for cron. Detects platform kills, checks hook safety, loads hook modules from KV, calls `executeHook()`. |
| `executeHook(modules, mainModule)` | Writes `kernel:active_session`, calls `_invokeHookModules()`, catches crashes (falls back to `runMinimalFallback()`), updates session outcome, snapshots hook as `kernel:last_good_hook` on clean exit, cleans up active session marker. |
| `callLLM(opts)` | Budget check, dharma/principles injection, resolve model family + map effort via `config:models`, build messages array, call `callWithCascade()`, record karma, track cost. Returns `{ content, usage, cost, toolCalls }`. |
| `callWithCascade(request, step)` | Three-tier provider cascade (see [Model tiering](#model-tiering)). |
| `executeToolCall(toolCall)` | Parses args, runs communication gate if applicable, calls `callHook('validate', ...)`, executes tool via `executeAction()`, calls `callHook('validate_result', ...)`, runs inbound content gate. |
| `executeAction(step)` | Loads tool code+meta via `_loadTool()`, checks comms gate approval flag, builds sandboxed context, records karma, calls `_executeTool()`. |
| `runAgentLoop(opts)` | The core execution loop (see [Agent loop](#the-agent-loop)). |
| `checkBalance(args)` | Iterates `providers` and `wallets` KV records, calls each adapter, returns balance map. |
| `spawnSubplan(args, depth)` | Launches a nested `runAgentLoop()` with a subplan prompt. Depth-limited by `config:defaults.execution.max_subplan_depth` (default 3). |
| `verifyPatronSignature(msg, sig)` | Loads `patron:public_key`, parses SSH ed25519 format, verifies signature via `crypto.subtle.verify("Ed25519", ...)`. |
| `verifyPatron(args)` | Built-in tool handler for `verify_patron`. Returns `{ verified: true/false }`, records karma. |
| `rotatePatronKey(newKey, sig)` | Self-authenticating key rotation — verifies signature against current key, writes new key directly to `this.kv.put()` (bypassing immutability guard), records karma + kernel alert. |
| `buildToolDefinitions(extraTools)` | Reads `config:tool_registry`, builds OpenAI-format function definitions, appends built-in `spawn_subplan` and `verify_patron` tools. |
| `resolveModel(modelOrAlias)` | Looks up `config:models.alias_map[modelOrAlias]`, returns the full model ID or the input unchanged. |
| `kvListAll(opts)` | Paginated KV list with 100-page safety limit. |

---

## The K interface and ScopedKV

The kernel builds the K interface via `buildKernelInterface()` and provides scoped KV access via `_buildScopedKV()`. These create the security boundary between the kernel and policy/tool code.

### `ScopedKV` (`kernel.js:19`)

Gives tools scoped KV access. Receives `toolName` and `kvAccess` via `this.ctx.props`.

- **`get(key)`** — if `kvAccess === "own"`, resolves to `tooldata:{toolName}:{key}`. Otherwise reads the key directly. Always blocks `sealed:*` reads (returns null). Tries JSON parse first, falls back to text.
- **`put(key, value)`** — always scopes writes to `tooldata:{toolName}:{key}` regardless of `kvAccess`. Tools cannot write outside their namespace.
- **`list(opts)`** — if `kvAccess === "own"`, prefixes and strips the scope. Otherwise returns all keys except `sealed:*`.

### `K interface` (`kernel.js:58`)

The K interface between policy modules and the kernel. Built by `buildKernelInterface()` which returns an object with all kernel methods that modules can call.

Exposes these categories of methods:

| Category | Methods |
|----------|---------|
| LLM | `callLLM(opts)` |
| KV reads | `kvGet(key)`, `kvGetWithMeta(key)`, `kvList(opts)` — all block `sealed:*` |
| KV writes (safe) | `kvPutSafe(key, value, metadata)`, `kvDeleteSafe(key)` |
| KV writes (privileged) | `kvWritePrivileged(ops)` |
| Agent loop | `runAgentLoop(opts)`, `executeToolCall(tc)`, `buildToolDefinitions(extra)`, `spawnSubplan(args, depth)`, `callHook(name, ctx)` |
| Communication | `listBlockedComms()`, `processCommsVerdict(id, verdict, revision)` |
| Execution | `executeAction(step)`, `executeAdapter(adapterKey, input)`, `checkBalance(args)` |
| Karma | `karmaRecord(entry)` |
| Utility | `resolveModel(m)`, `estimateCost(model, usage)`, `buildPrompt(template, vars)`, `parseAgentOutput(content)`, `loadKeys(keys)`, `getSessionCount()`, `mergeDefaults(defaults, overrides)`, `isSystemKey(key)`, `getSystemKeyPatterns()` |
| Patron identity | `rotatePatronKey(newPublicKey, signature)` — self-authenticating key rotation (verifies against current key) |
| State (read-only) | `getSessionId()`, `getSessionCost()`, `getKarma()`, `getDefaults()`, `getModelsConfig()`, `getModelCapabilities()`, `getDharma()`, `getToolRegistry()`, `getYamas()`, `getNiyamas()`, `getPatronId()`, `getPatronContact()`, `isPatronIdentityDisputed()`, `resolveContact(platform, platformUserId)`, `elapsed()` |

**Not exposed:** `sendKernelAlert()` — kernel-internal only.

`loadKeys(keys)` filters out `sealed:*` keys before loading — hooks cannot read sealed data even by passing keys explicitly.

### How tool execution works

Tools are statically imported and executed directly:

1. The kernel looks up the tool in the `TOOLS` map (passed via constructor from `index.js`).
2. Builds a sandboxed context via `buildToolContext()` with scoped KV, resolved secrets, and optional provider module.
3. Calls `tool.execute(ctx)` directly.
4. Races against a timeout (from `meta.timeout_ms`, default 15s).

---

## The module system

Three modules compose the policy layer, all statically compiled into the runtime worker:

| Module | Role | Mutable? |
|--------|------|----------|
| `act.js` | Session policy — orient flow, context building | Yes (via proposals) |
| `reflect.js` | Reflection — session + deep, scheduling, proposal verdicts | Yes (via proposals) |
| `hook-chat.js` | Chat handler — kernel-level | No |

The kernel calls `act.js` for orient sessions and `reflect.js` for deep reflect. Both receive the K interface (built by `buildKernelInterface()`) which provides access to kernel primitives.

KV operation gating (`applyKVOperation`) is now a kernel method in `kernel.js`. Proposal methods (`createProposal`, `loadProposals`, `processProposalVerdicts`) are also kernel methods.

### `act.js` — wake flow

`wake(K, input)` is the top-level session controller:

1. **Sleep check** — reads `wake_config.next_wake_after`. Returns early if it's not time yet.
2. **Crash detection** — `detectCrash(K)` checks `kernel:active_session`. If a stale session ID exists that doesn't match the current session, the previous session crashed. Returns the dead session's karma.
3. **Modification tracking** — scans `proposal:*` and `proposal:*` prefixes, initializes the in-memory tracking arrays.
4. **Circuit breaker** — `runCircuitBreaker(K)` (from `kernel.js (proposal methods)`) auto-rolls back inflight code modifications if `last_danger` timestamp is after their `activated_at`. Clears `last_danger` after processing.
5. **Retry pending git syncs** — retries any `git_pending:*` records from previous sessions.
6. **Load ground truth** — fetches balances via `checkBalance()`.
7. **Reflection check** — `highestReflectDepthDue(K, state)` scans from `max_reflect_depth` down to 1, checking if any depth is due based on session count or elapsed days.
8. **Tripwire evaluation** — `evaluateTripwires(config, liveData)` evaluates alert conditions against live data (currently just balances). Can override the effort level upward (low → medium → high → xhigh).
9. **Branch: reflect or orient**
   - If `reflectDepth > 0`: runs `runReflect(K, state, depth, context)` — deep reflection that cascades downward.
   - Otherwise: runs `runSession(K, state, context, config)` — normal orient session followed by session-level reflect.

### `reflect.js` — reflection hierarchy

**Session reflect** (`executeReflect`, depth 0): Runs after every normal orient session. Gets karma (with request payloads stripped) and session cost. Uses no tools (`tools: []`), `maxSteps: 1`. Processes `kv_operations`, `modification_verdicts` (withdraw, modify only), and `modification_requests` (stages them).

**Deep reflect** (`runReflect`, depth >= 1): Runs instead of a normal session when due. Gets tools (excluding `spawn_subplan`), uses `maxSteps` from config (default 10 for deep reflect, 5 for depth-1 reflect). Cascades downward — after completing depth N, runs depth N-1, down to depth 1.

Deep reflect output processing (`applyReflectOutput`):
1. Apply `kv_operations` via protection gate
2. Process `modification_verdicts` (apply, reject, withdraw, modify, promote, rollback, defer)
3. Process `comms_verdicts` (send, revise_and_send, drop)
4. Apply `modification_requests` via `acceptDirect()` (skips staging — goes straight to inflight)
5. Save reflect schedule
6. Store output as `reflect:{depth}:{sessionId}`
7. Only depth 1 writes `last_reflect` and `wake_config`

**Reflect scheduling**: `isReflectDue(K, state, depth)` checks `reflect:schedule:{depth}`. If a schedule exists, it fires when `sessionsSince >= after_sessions` or `daysSince >= after_days`. Cold-start fallback uses exponential intervals: `baseInterval * multiplier^(depth-1)` sessions.

### `kernel.js (proposal methods)` — Modification Protocol

Two types of modifications:

- **Code** (prompts, config, tools, hooks): requires `claims` (array), `ops` (array), `checks` (array). Goes through staged → inflight → promoted lifecycle.
- **Wisdom** (`upaya:*`, `prajna:*`): requires `validation` and `ops`. Can only be staged by deep reflect (depth >= 1). Cannot use `acceptDirect()`. No circuit breaker rollback.

Lifecycle:
1. **`stageModification(K, request, sessionId, depth)`** — validates fields, writes to `proposal:{id}` via `kvWritePrivileged`.
2. **`acceptStaged(K, modificationId)`** — checks for inflight conflicts (same target keys), snapshots current values, applies ops via `kvWritePrivileged`, moves from staged to `proposal:{id}`. Called by deep reflect verdicts.
3. **`acceptDirect(K, request, sessionId)`** — skips staging, goes straight to inflight. Only for code type (wisdom rejected). Used by deep reflect `modification_requests`.
4. **`promoteInflight(K, modificationId, depth)`** — deletes snapshot, triggers git sync (except wisdom type).
5. **`rollbackInflight(K, modificationId, reason)`** — restores snapshotted values via `kvWritePrivileged`, deletes snapshot.

**Conflict detection**: `findInflightConflict()` iterates `activeInflight` IDs and checks for overlapping target keys.

**Git sync**: on promotion, `syncToGit()` maps KV keys to file paths via `kvToPath()`, builds a shell script that base64-decodes files, runs a secret scan (rejects known patterns like `sk-*`, `AKIA*`, PEM keys, `ghp_*`, `xoxb-*`), then commits and pushes. Executed via `computer` tool on the Hetzner server. Failed syncs are stored as `git_pending:*` and retried on subsequent wakes.

### `kernel.js (applyKVOperation)` — KV operation gate

`applyKVOperation(K, op)` gates all KV writes from the agent loop's output:

1. If `isSystemKey(key)` → blocked (logged to karma).
2. If key exists and metadata doesn't have `unprotected: true` → blocked.
3. Otherwise → applies via `applyKVOperationDirect()`.

Supported operations: `put`, `delete`, `patch` (find-and-replace in string values — rejects if `old_string` is missing or matches multiple locations), `rename` (copy value to new key, delete old key).

### `hook-chat.js` — chat pipeline

Kernel-level code (imported directly, not stored in KV). `handleChat(K, channel, inbound, adapter)`:

1. Loads/inits conversation state at `chat:state:{channel}:{chatId}`.
2. Handles `/reset` (refills budget, preserves history) and `/clear` (deletes state).
3. Merges chat config from `config:defaults.chat` + contact-level overrides.
4. Budget check against `max_cost_per_conversation` (default $0.50).
5. Unknown contacts get no tools (empty array) unless `unknown_contact_tools` allowlist is configured.
6. Tool-calling loop: up to `max_tool_rounds` (default 5) rounds. Tool calls execute in parallel via `Promise.all`. Tool results go back as tool messages.
7. Trims history to `max_history_messages` (default 40), saves state.

---

## Dev vs prod

In the two-worker architecture, dev and prod use the same `kernel.js` and module code. The key differences:

- **Dev:** `index.js` is hand-written, imports modules directly from disk. No governor worker needed.
- **Prod:** `index.js` is generated by the governor from KV-stored code, deployed via CF Workers API.

Both modes use the same execution pattern: static imports, direct function calls, `buildKernelInterface()` for the K interface, `_buildScopedKV()` for tool KV access.

The `callWithCascade()` method uses the statically compiled LLM provider as tier 1, with a direct OpenRouter fetch as the kernel fallback tier.

---

## The agent loop: `runAgentLoop()`

`kernel.js:1819` — the core LLM + tool execution cycle.

```
runAgentLoop({ systemPrompt, initialContext, tools, model, effort,
               maxTokens, maxSteps, step, budgetCap })
```

1. Builds initial messages array. If `initialContext` is provided, adds it as a `user` message.
2. Loops up to `maxSteps` times:
   a. Calls `callLLM()` with the current messages and tools.
   b. If response has `toolCalls`: adds assistant message with tool calls, executes all tools **in parallel** via `Promise.all(response.toolCalls.map(tc => this.executeToolCall(tc)))`, adds tool result messages (one per call), continues loop.
   c. If no tool calls: parses the text response as JSON via `parseAgentOutput()`. If parse fails and this is the first failure, injects a retry message and continues (burns one step). Otherwise returns the parsed output.
3. If `maxSteps` exhausted: sends a "produce your final output now" message **without tools** (forces text response), parses and returns.
4. Budget exceeded errors are caught and returned as `{ budget_exceeded: true }`.

`parseAgentOutput()` tries: direct `JSON.parse()` → extract from markdown fences → find outermost `{}` or `[]` → call `parse_repair` hook → return `{ parse_error: true, raw: content }`.

---

## Model tiering

### Model resolution

`resolveModel(modelOrAlias)` (`kernel.js:2025`) looks up `config:models.alias_map`:

```json
{
  "opus": "anthropic/claude-opus-4.6",
  "sonnet": "anthropic/claude-sonnet-4.6",
  "haiku": "anthropic/claude-haiku-4.5",
  "deepseek": "deepseek/deepseek-v3.2"
}
```

If the input isn't in the alias map, it's returned unchanged (assumed to be a full model ID).

### Model families and effort mapping

Each model entry in `config:models.models` has an optional `family` field and an optional `supports_reasoning` flag. `callLLM()` looks up the model to resolve these before building the standardized request:

- **`family`** — optional. Identifies which provider-specific adapter to apply (e.g., `"anthropic"` → `cache_control`). Only needed for models with provider-specific quirks. Passed through to the provider as `request.family`.
- **`supports_reasoning`** — if `true`, the effort level passes through to OpenRouter's unified `reasoning` parameter. If absent/false, `request.effort` is `null`.

As seeded:

| Model | Family | Supports reasoning |
|-------|--------|--------------------|
| `anthropic/claude-opus-4.6` | `anthropic` | Yes |
| `anthropic/claude-sonnet-4.6` | `anthropic` | Yes |
| `anthropic/claude-haiku-4.5` | `anthropic` | Yes |
| `deepseek/deepseek-v3.2` | (none) | No |

To add a new model with reasoning: add the model entry in `config:models` with `supports_reasoning: true` and optionally `family` if it needs provider-specific adaptation. No provider code changes needed.

### Model capability flags

`config:model_capabilities` is a separate KV key (not in `config:models`) to prevent the agent from self-escalating model permissions via a single modification. As seeded:

```json
{
  "anthropic/claude-opus-4.6": { "yama_capable": true, "niyama_capable": true, "comms_gate_capable": true },
  "anthropic/claude-sonnet-4.6": { "yama_capable": true, "niyama_capable": true, "comms_gate_capable": true }
}
```

Only Opus and Sonnet have capability flags. Haiku and DeepSeek have none — they cannot modify yamas/niyamas or serve as communication gate models. Modifying `config:model_capabilities` itself requires 200+ char deliberation and a `yama_capable` model.

### Model roles (from seeded `config:defaults`)

| Role | Default model | Purpose |
|------|--------------|---------|
| Orient | `anthropic/claude-haiku-4.5` | Normal session agent loop |
| Reflect (depth 0) | `anthropic/claude-sonnet-4.6` | Session-level reflection |
| Deep reflect | `anthropic/claude-opus-4.6` | Depth 1+ reflection, modification verdicts |
| Chat | `sonnet` (resolved to Sonnet 4.6) | Live chat responses |
| Subplan | haiku (via `getFallbackModel()`) | Nested agent tasks |
| Fallback | `anthropic/claude-haiku-4.5` | When primary model fails |

### LLM provider cascade (production only)

`callWithCascade()` (`kernel.js:1506`) tries three tiers:

1. **Tier 1: Dynamic adapter** — `provider:llm:code` from KV. On first success, snapshots to `provider:llm:last_working:code` (once per session).
2. **Tier 2: Last working** — `provider:llm:last_working:code`. Falls back here if Tier 1 throws.
3. **Tier 3: Kernel fallback** — `kernel:llm_fallback`. Human-managed, last resort.

If all three fail, returns `{ ok: false, tier: "all_failed" }`. The caller (`callLLM`) then tries a model-level fallback: `getFallbackModel()` returns `config:models.fallback_model` or `kernel:fallback_model`.

**In dev mode**, `callWithCascade()` is replaced with a direct `fetch()` to `https://openrouter.ai/api/v1/chat/completions` with a 60s timeout. No cascade, no isolates, no adapter code.

### Cost estimation

`estimateCost(model, usage)` (`kernel.js:2035`) looks up the model in `config:models.models` by ID or alias, then calculates: `(input_tokens * input_cost_per_mtok + output_tokens * output_cost_per_mtok) / 1,000,000`. Returns `null` if the model isn't in the config.

---

## KV as the nervous system

All state lives in Cloudflare KV. The key space is divided into protection tiers enforced by the kernel.

### Protection tiers

| Tier | Access | Examples |
|------|--------|---------|
| **Immutable** | Cannot be written by anyone (except `rotatePatronKey` for `patron:public_key`) | `dharma`, `patron:public_key` |
| **Kernel-only** | Only kernel internal code can read/write | `kernel:*`, `sealed:*` |
| **Operator-only** | Blocked from agent writes in `kvWritePrivileged` | `contact:*`, `contact_index:*` |
| **System (privileged)** | Writable via `kvWritePrivileged` only — snapshots to karma, rate-limited, audited | All `SYSTEM_KEY_PREFIXES` keys |
| **Principle keys** | System-privileged + deliberation requirement + model capability gate | `yama:*` (200 char, yama_capable), `niyama:*` (100 char, niyama_capable) |
| **Protected agent** | Agent-created keys with no `unprotected` metadata flag — `applyKVOperation` blocks modification | Any existing key without `{ unprotected: true }` metadata |
| **Unprotected agent** | Freely writable via `kvPutSafe` or `applyKVOperation` | New keys, keys with `{ unprotected: true }` metadata |

**NOTE:** The protection-gate logic in `kernel.js (applyKVOperation):applyKVOperation` means that agent-created keys become read-only once written unless they were created with `{ unprotected: true }` metadata. The `applyKVOperationDirect` function adds `{ unprotected: true }` to its puts, so keys created through the orient loop's `kv_operations` remain writable in future sessions.

### Key namespace layout

| Prefix | Contents |
|--------|----------|
| `config:*` | `defaults`, `models`, `model_capabilities`, `tool_registry`, `resources` |
| `prompt:*` | `orient`, `reflect`, `reflect:1`, `subplan`, `chat` |
| `tool:*:code`, `tool:*:meta` | Tool source and metadata |
| `provider:*:code`, `provider:*:meta` | Provider adapter source and metadata |
| `hook:wake:*` | Hook modules and manifest |
| `channel:*:code`, `channel:*:config` | Channel adapter code and config |
| `karma:*` | Session karma logs (flight recorder) |
| `reflect:*:*` | Reflection outputs by depth and session |
| `reflect:schedule:*` | Reflection scheduling state |
| `proposal:*` | Staged modification proposals |
| `proposal:*` | Inflight modification snapshots (for rollback) |
| `yama:*`, `niyama:*` | Operating principles (outer world / inner practice) |
| `upaya:*` | Accumulated wisdom (communication, channels) |
| `prajna:*` | Accumulated self-knowledge |
| `contact:*` | Contact records |
| `contact_index:*` | Platform-to-contact lookup cache |
| `sealed:*` | Quarantined content from unknown senders (kernel-only read) |
| `comms_blocked:*` | Queued outbound messages pending review |
| `chat:state:*` | Conversation state per channel/chat |
| `git_pending:*` | Pending git sync operations |
| `kernel:*` | Kernel-internal state (active_session, last_sessions, last_good_hook, hook_dirty, alert_config) |
| `secret:*` | KV-stored secrets (agent-provisioned) |
| `tooldata:*` | Tool-scoped data (namespaced per tool) |
| `doc:*` | Documentation stored in KV |
| `providers`, `wallets` | Balance check provider/wallet configs (exact-match system keys) |
| `patron:contact`, `patron:identity_snapshot` | Patron identity (exact-match system keys) |
| `wake_config` | Next wake schedule |
| `session_counter` | Monotonic session count |
| `cache:session_ids` | Session ID list for dashboard |
| `last_reflect` | Most recent reflect output |
| `last_danger` | Last danger signal (for circuit breaker) |
| `identity:did` | On-chain DID identity |

### Auto-tagging

`kvPut()` (`kernel.js:1969`) auto-tags every write with metadata based on the key prefix. For example, `tool:*` keys get `{ type: "tool", runtime: "worker", format: "text" }`. Caller metadata can override defaults. `updated_at` is always set. System keys have `unprotected` stripped from metadata.

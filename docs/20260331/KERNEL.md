# Kernel Reference

The kernel (`kernel.js`, ~2000 LOC) is the immutable core of Swayambhu's
runtime. It is cognitive-architecture-agnostic — it provides infrastructure
primitives that the session hook builds on.

Everything the kernel does falls into one of six categories: KV access,
LLM calling, tool dispatch, event bus, safety, and bookkeeping. If a
piece of logic doesn't fit one of these, it belongs in a hook.

## Session Lifecycle

When the cron fires, the kernel runs `runScheduled()`:

```
runScheduled()
  ├─ Session lock (prevent overlapping sessions)
  ├─ Stale lock detection (mark dead sessions as killed)
  ├─ Hook safety check (3 consecutive crashes → rollback + fallback)
  └─ executeHook()
       ├─ runSession() — the 5-step dispatch (see below)
       ├─ updateSessionOutcome("clean" or "crash")
       └─ Release session lock
```

### runSession — 5 steps

```
1. Schedule gate     — read session_schedule, bail if not due
2. Infrastructure    — crash detection, balance check, drain events
3. Bookkeeping       — increment session counter, record karma start
4. Hook dispatch     — HOOKS.session.run(K, { crashData, balances, events, schedule })
5. Post-session      — write session health, update outcome history
```

The hook receives the kernel interface (`K`) and raw infrastructure
inputs. It decides everything: what type of session to run, what context
to load, whether to dispatch background jobs, how to structure the work.

### Fallback mode

If the session hook crashes 3 times consecutively, the kernel:
1. Signals the governor to rollback to a previous version
2. Runs a hardcoded minimal session (check balances, report status)
3. Uses a budget cap of $0.50 and 3 max steps

This is the only place the kernel contains session logic — and it's
deliberately trivial.

## The K Interface

Hooks interact with the kernel exclusively through the K interface
returned by `buildKernelInterface()`. This is a plain object of async
functions — not a class instance. Hooks never access the kernel directly.

### KV Access

| Method | Purpose |
|--------|---------|
| `K.kvGet(key)` | Read a key (sealed: keys return null) |
| `K.kvGetWithMeta(key)` | Read key + KV metadata |
| `K.kvList(opts)` | List keys by prefix |
| `K.kvWriteSafe(key, value)` | Write agent keys (blocks system/kernel keys) |
| `K.kvDeleteSafe(key)` | Delete agent keys (blocks system/kernel keys) |
| `K.kvWriteGated(op, context)` | Write protected keys with privileged context |
| `K.loadKeys(keys)` | Batch-load multiple keys, with truncation for large values |

### LLM Calling

```javascript
const response = await K.callLLM({
  model,          // model alias or full ID
  messages,       // OpenAI-format messages array
  systemPrompt,   // prepended after dharma + principles
  tools,          // function-calling tool definitions
  effort,         // reasoning effort level (if model supports it)
  maxTokens,
  step,           // label for karma tracking
  budgetCap,      // optional per-call budget limit
});
// Returns: { content, usage, cost, toolCalls, finish_reason }
```

Every LLM call gets dharma and principles injected into the system
prompt automatically:

```
[DHARMA]
{dharma text}
[/DHARMA]

[PRINCIPLES]
[principle-name]
{principle text}
[/principle-name]
[/PRINCIPLES]

{your system prompt}
```

The kernel handles model resolution (aliases → full IDs), provider
cascade (compiled provider → hardcoded OpenRouter fallback), cost
tracking, and budget enforcement.

### Tool Dispatch

| Method | Purpose |
|--------|---------|
| `K.executeToolCall(tc)` | Execute a tool call from LLM response (validates, runs pre/post hooks) |
| `K.executeAction(step)` | Lower-level: execute a named tool with input |
| `K.buildToolDefinitions(extra)` | Build the tools array from config:tool_registry |
| `K.callHook(name, ctx)` | Call a named hook tool (degrades gracefully if missing) |
| `K.executeAdapter(key, input)` | Execute a provider/channel adapter directly |

Tool execution includes:
- **Secret scoping** — tools only see secrets listed in their grant (from `kernel:tool_grants`)
- **KV scoping** — tools get a scoped KV wrapper based on their `kv_access` level
- **Inbound content gating** — messages from unknown/unapproved senders are redacted and quarantined under `sealed:*` keys
- **Communication gating** — outbound messages to people require approved contacts
- **Pre/post validation hooks** — `validate` and `validate_result` hooks run around tool execution

### Event Bus

```javascript
// Emit an event (from hooks or tools)
await K.emitEvent("session_request", { contact: "swami", summary: "..." });

// Events are drained at session start by the kernel
// All events are passed to the hook — the hook decides which matter
```

Events are KV entries with a 24-hour TTL under the `event:` prefix.
The kernel processes them through configured handlers (`config:event_handlers`),
retries failures up to 3 times, and dead-letters persistently failed events.

### Code Staging

```javascript
// Stage a code change (validates it's a code key)
await K.stageCode("tool:kv_query:code", newCode);

// Signal the governor to deploy all staged code
await K.signalDeploy();
```

Only code keys can be staged (`tool:*:code`, `hook:*:code`,
`provider:*:code`, `channel:*:code`). The governor reads staged code
from `code_staging:*`, applies it to the canonical `code:*` KV keys,
rebuilds `index.js`, and deploys via the Cloudflare API.

### Agent Loop

```javascript
const result = await K.runAgentLoop({
  systemPrompt,
  initialContext,     // first user message
  tools,
  model,
  effort,
  maxTokens,
  maxSteps,           // max tool-calling turns
  step,               // label for karma (e.g. "act_turn_0")
  budgetCap,          // session-level budget limit
  maxSpend,           // per-invocation limit (for nested calls)
});
```

The agent loop is the core execution primitive. It runs a multi-turn
conversation: LLM responds with tool calls → kernel executes them →
results fed back → LLM responds again → ... until the LLM produces
a final text output (parsed as JSON) or max steps are reached.

Budget enforcement: soft warning at 75% of budgetCap, hard limit
(strip tools, force final output) at 90%.

## KV Write Tiers

Key protection is config-driven, loaded from `kernel:key_tiers` at boot.
Falls back to `DEFAULT_KEY_TIERS` if the config key doesn't exist.

```
kernel:key_tiers → {
  "immutable":    ["dharma", "principle:*", "patron:public_key"],
  "kernel_only":  ["karma:*", "sealed:*", "event:*", "kernel:*", ...],
  "protected":    ["config:*", "prompt:*", "tool:*", "contact:*", ...]
}
```

The write path (`kvWriteGated`) checks tiers in order:

1. **Immutable** → always rejected
2. **Kernel-only** → always rejected (only kernel internals write these)
3. **Code keys** → rejected (must use `K.stageCode()`)
4. **Contact keys** → special approval rules (can't set `approved: true`)
5. **Protected (system) keys** → allowed only with privileged context flag
6. **Agent keys** → allowed if unprotected or new

The patron can customize tier membership by updating `kernel:key_tiers`
via the dashboard — without any kernel code changes.

## Safety Mechanisms

### Crash tripwire

The kernel tracks the last 5 session outcomes. If 3 consecutive
sessions crash or get killed:
- Signals governor to rollback (`deploy:rollback_requested`)
- Sends kernel alert
- Runs minimal fallback session

### Sealed keys

Keys under `sealed:*` are invisible to hooks — `K.kvGet("sealed:...")`
returns null. Used for quarantining content from unknown senders.
Only the patron can see sealed keys (via the dashboard).

### Session lock

`kernel:active_session` prevents overlapping sessions. If a previous
session's lock is stale (age > 2× max duration), it's marked as killed
and the new session proceeds.

### Communication gating

Outbound messages to people (via adapters with `communication.recipient_type === "person"`)
require the recipient to be an approved contact. The kernel derives the
recipient from the actual tool arguments — it does not trust caller metadata.

### Patron identity

Ed25519 signature verification for patron identity. The patron's public
key is immutable (`patron:public_key`). Key rotation requires signing
the new key with the old one. Identity monitoring detects changes to
patron contact fields and flags them as disputed.

## Karma

Every significant event is recorded in the karma log — an in-memory
array that's persisted to KV after each entry (crash recovery).
Karma entries include:

- `session_start` / `session_end` — bookends with balances and timing
- `llm_call` — model, tokens, cost, duration, response content
- `tool_start` / `tool_complete` — tool execution with results
- `code_staged` / `deploy_signaled` — code change lifecycle
- `privileged_write` — protected key modifications
- `events_drained` — event bus processing
- `fatal_error` — unrecovered exceptions

Danger signals (`fatal_error`, `act_parse_error`, `all_providers_failed`)
also write to `last_danger` for quick scanning.

## Boundary Principle

The kernel provides infrastructure. The session hook provides policy.
If a piece of logic decides *what* the agent should do, it belongs in
the hook. If it enforces *what the agent cannot do*, it belongs in the
kernel.

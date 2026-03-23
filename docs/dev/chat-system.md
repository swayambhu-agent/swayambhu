# Chat System

Real-time conversational interface, triggered by inbound messages from
channel adapters. Platform-agnostic pipeline with contact-based access
control, per-conversation budgets, and a multi-round tool-calling loop.

The chat handler lives in `hook-chat.js` — kernel-level code imported
directly (not loaded from KV). Channel adapters live in `channels/*.js`
and are loaded from KV in prod, imported directly in dev.

---

## Pipeline Overview

```
Inbound HTTP POST /channel/{name}
      │
      ▼
┌─ Channel adapter ─┐
│ verify()           │ ← HMAC signature check (prod only)
│ parseInbound()     │ ← extract chatId, text, userId, command, msgId
└────────┬───────────┘
         │
         ▼
   Deduplication check (dedup:{msgId}, 30s TTL)
         │
         ▼
   Return 200 immediately
         │
         ▼  (background via waitUntil)
   loadEagerConfig()
         │
         ▼
┌─ handleChat() ─────────────────────────────────────┐
│                                                     │
│  1. Load/init conversation state                    │
│  2. Handle commands (/reset, /clear)                │
│  3. Resolve contact + merge config                  │
│  4. Check budget                                    │
│  5. Build system prompt (prompt:chat + contact)     │
│  6. Filter tools (known vs unknown contact)         │
│  7. Multi-round tool-calling loop                   │
│  8. Send reply via adapter                          │
│  9. Trim history + save state                       │
│ 10. Record karma                                    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Channel Adapters

### Contract

Every channel adapter exports three functions:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `verify` | `(headers, rawBody, env) → boolean` | Validate webhook authenticity |
| `parseInbound` | `(body) → inbound \| null` | Extract normalized message fields |
| `sendReply` | `(chatId, text, secrets, fetchFn)` | Send a response message |

Plus a `config` export with `secrets` array and optional
`webhook_secret_env`.

### Inbound object shape

```js
{
  chatId: "C12345",        // channel/thread identifier
  text: "hello",           // message content
  userId: "U67890",        // sender platform ID
  command: "reset" | null, // if text starts with /
  msgId: "abc123" | null,  // for deduplication
  _challenge: "xyz",       // only for URL verification
}
```

### Prod: KV-loaded isolates

The kernel uses channel adapters that are statically imported via `index.js`.
Each adapter exports `verify`, `parseInbound`, and `sendReply` functions
that are called directly by the kernel.

Each adapter operation runs in a separate direct call call:
1. `verify` — `runInIsolate` with `action: "verify"`, 5s timeout
2. `parseInbound` — `runInIsolate` with `action: "parse"`, 5s timeout
3. `sendReply` — `runInIsolate` with `action: "send"`, 10s timeout

### Dev: direct imports

In `index.js`, channel adapters are imported directly and called
directly. Verification is skipped entirely in dev mode
(`index.js:70`).

### Current adapters

Only **Slack** exists (`channels/slack.js`):
- `verify`: HMAC-SHA256 with `X-Slack-Request-Timestamp` +
  `X-Slack-Signature`, 5-minute replay window, constant-time comparison
- `parseInbound`: handles `url_verification` challenges, filters to
  `message` events only, ignores bot messages and subtypes, extracts
  `/command` from text prefix
- `sendReply`: POST to `chat.postMessage` API

---

## Deduplication

`kernel.js:208-214` (prod), `index.js:79-84` (dev)

Slack retries webhook delivery if no 200 response within 3 seconds. The
kernel deduplicates using `dedup:{msgId}` keys with a 30-second TTL.

1. If `inbound.msgId` exists: check `dedup:{msgId}` in KV
2. If found: return 200 immediately (already processing)
3. If not found: write `"1"` with `expirationTtl: 60`, continue

The dedup check happens before `handleChat` is called, so duplicate
deliveries never reach the chat pipeline.

---

## handleChat(K, channel, inbound, adapter)

`hook-chat.js:8`

### Step 1: Conversation state

Loads `chat:state:{channel}:{chatId}` from KV, or initializes:

```json
{
  "messages": [],
  "total_cost": 0,
  "created_at": "2026-03-16T...",
  "turn_count": 0
}
```

The `chatId` comes from the adapter — for Slack it's the channel ID,
meaning all messages in one Slack channel share one conversation.

### Step 2: Commands

Text starting with `/` is parsed as a command by the adapter. Two
commands are handled before any LLM interaction:

| Command | Behavior |
|---------|----------|
| `/reset` | Sets `total_cost` to 0 (refills budget), preserves conversation history. Replies "Budget refilled." |
| `/clear` | Deletes the entire `chat:state:*` record. Replies "Conversation cleared." |

Both return immediately — no LLM call.

### Step 3: Config resolution

```js
const chatDefaults = defaults?.chat || {};
const contactConfig = contact?.chat || {};
const chatConfig = { ...chatDefaults, ...contactConfig };
```

Per-contact chat config overrides global defaults. Config fields used:

| Field | Default | Description |
|-------|---------|-------------|
| `max_cost_per_conversation` | 0.50 | Budget ceiling per conversation |
| `model` | `defaults.orient.model` → `"sonnet"` | LLM model for chat |
| `effort` | `"low"` | LLM effort level |
| `max_output_tokens` | 1000 | Max tokens per response |
| `max_tool_rounds` | 5 | Max tool-calling loop iterations |
| `max_history_messages` | 40 | Conversation history window |
| `unknown_contact_tools` | `[]` | Tool allowlist for unknown contacts |

### Step 4: Budget check

If `conv.total_cost >= maxCost`: replies "Budget reached" and returns.
The user must send `/reset` to refill.

Cost accumulates across turns within a conversation and persists in KV.
Each LLM response's `cost` field is added to `total_cost` after every
call in the tool loop.

### Step 5: System prompt

```js
const chatPrompt = await K.kvGet("prompt:chat");
const systemPrompt = [
  chatPrompt || "You are in a live chat. Respond conversationally.",
  contactContext,  // JSON of contact record, if known
].join("\n\n").trim();
```

The `prompt:chat` KV key is agent-evolvable. If absent, a minimal
fallback is used. If the sender is a known contact, their full contact
record is appended as JSON.

Dharma, yamas, and niyamas are injected by the kernel in `callLLM`
(not by the chat handler) — they prepend every system prompt
automatically.

### Step 6: Tool filtering

`hook-chat.js:59-82`

**Approved contact** (`contact?.approved === true`):
Full tool set via `K.buildToolDefinitions()`.

**Unapproved contact** (contact exists, `approved` is false/missing):
- Reads `chatConfig.unknown_contact_tools` (default: `[]`)
- If non-empty: filters `buildToolDefinitions()` to only matching names
- If empty: no tools — pure text chat
- Records `inbound_unapproved` karma event

**Unknown contact** (`resolveContact` returns null):
- Same tool filtering as unapproved (uses `unknown_contact_tools` allowlist)
- Records `inbound_unknown` karma event

This is a mechanical gate. Only approved contacts get full tool access.
Unapproved and unknown contacts are both restricted to the allowlist
(empty by default).

> **NOTE:** Tool calls from approved contacts go through the full kernel
> pipeline including `executeToolCall`, which means the communication gate
> and inbound content gate still apply. Chat doesn't bypass those gates.

### Step 7: Tool-calling loop

`hook-chat.js:78-114`

```
for i in 0..maxRounds:
  response = callLLM(model, messages, tools)
  total_cost += response.cost

  if response has tool_calls:
    push assistant message (with tool_calls)
    execute all tool calls in parallel
    push tool result messages
    continue

  if response has text content:
    reply = content
    push assistant message
    break
```

Key details:
- **Parallel execution**: all tool calls in a single response are
  executed concurrently via `Promise.all`
- **Error handling**: individual tool call errors are caught and returned
  as `{ error: message }` — the loop continues
- **Step labels**: `chat_{channel}_t{turn}_r{round}` for karma tracking
- **No reply fallback**: if `maxRounds` exhausted with no text response,
  sends `"(no response)"`

### Step 8: Send reply

Calls `adapter.sendReply(chatId, reply)`. In prod this runs the adapter's
`sendReply` function directly (same in both dev and prod).

### Step 9: Save state

```js
conv.turn_count++;
conv.last_activity = new Date().toISOString();
if (conv.messages.length > maxMsgs) {
  conv.messages = conv.messages.slice(-maxMsgs);
}
await K.kvPutSafe(convKey, conv);
```

History is trimmed to `max_history_messages` (default 40) from the end,
preserving the most recent messages. The entire conversation state is
written back to KV on every turn.

### Step 10: Karma

Records a `chat_turn` event with channel, chatId, turn count, and
cumulative cost.

---

## Differences from Wake Cycle

| Aspect | Chat | Wake (orient) |
|--------|------|---------------|
| **Trigger** | Inbound HTTP message | Cron schedule (`/__scheduled`) |
| **Prompt** | `prompt:chat` | `prompt:orient` |
| **Tools** | Full set (approved) or filtered (unapproved/unknown) | Full set + `spawn_subplan` |
| **Max steps** | `max_tool_rounds` (default 5) | `getMaxSteps('orient')` (default 12) |
| **Agent loop** | Manual loop in `handleChat` calling `K.callLLM` | `K.runAgentLoop` (kernel-managed) |
| **Reflection** | None — no reflect after chat | Session reflect after every orient |
| **Budget** | Per-conversation (`max_cost_per_conversation`) | Per-session (`session_budget.max_cost`) |
| **State** | `chat:state:{channel}:{chatId}` persists across turns | Session is ephemeral (karma log persists) |
| **Effort** | Default `"low"` | Tripwire-evaluated, configurable |
| **Context** | Contact record + conversation history | Balances, lastReflect, crashData, additionalContext |

> **NOTE:** Chat uses `K.callLLM` directly in a manual loop, not
> `K.runAgentLoop`. This means chat does not get the kernel's agent loop
> features like structured JSON output parsing, budget enforcement with
> soft caps, or `budget_exceeded` signaling. Budget enforcement in chat
> is purely the `total_cost >= maxCost` check at the start of each turn.

---

## Background Processing

Both prod and dev return HTTP 200 immediately and process the chat in the
background:

**Prod** (`kernel.js:223`): `ctx.waitUntil(async () => { ... })`

**Dev** (`index.js:87`): Same pattern — the async IIFE runs after
the response is sent.

This prevents Slack's 3-second retry from firing while the LLM processes.
The dedup key provides a safety net if a retry does arrive.

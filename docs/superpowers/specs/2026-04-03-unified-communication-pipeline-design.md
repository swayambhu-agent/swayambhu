# Unified Communication Pipeline

Redesign the communication subsystem so all messaging — inbound chat and
agent-initiated outbound — flows through a single conversation processor
with one brain, one state, one prompt, and single-writer guarantees.

## Problem

The current system has two disconnected communication paths:

1. **Inbound (chat):** Slack webhook → `handleChat()` → LLM with history → reply → save to `chat:*`
2. **Outbound (delivery):** event → `handleDelivery()` → separate LLM call → send → append to `chat:*`

These are two different functions, two different LLM calls, two different
views of conversation state, writing to the same `chat:*` key with no
coordination. The delivery path has multiple bugs: wrong `callLLM` parameter
names, broken contact resolution (`resolveContact(null, ...)`), lossy
event deletion before send completes, and delivery running outside the
execution lock in `waitUntil`.

Additionally, the agent has no way to initiate communication — comms tools
are filtered from the act phase, and userspace never emits events. The
agent can think but cannot speak.

## Architecture

All communication goes through the scheduled tick (single writer, inside
execution lock). The fetch handler never runs LLM calls or mutates
conversation state.

### Ingress paths

**Inbound (Slack webhook):**
- Fetch handler: verify signature, parse, dedupe by `sentTs`
- Commands (`/reset`, `/clear`): handle immediately in fetch (simple
  KV mutation + adapter reply). No scheduler needed.
- Regular messages: write `event:{padded_millis}:inbound_message:{nonce}`
  KV key, wake scheduler (`session_schedule.next_session_after = now`),
  return 200. No LLM, no state mutation.

**Agent-initiated (act phase):**
- New tool: `request_message({ contact, intent, content })`
- Tool writes event via `K.emitEvent('comms_request', { contact, intent, content })`
- `contact` must be a canonical contact slug (not raw platform ID)
- `intent`: `share` | `ask` | `report`

**System events (userspace):**
- Session complete: `K.emitEvent('session_complete', { actions_summary })`
- DR complete: `K.emitEvent('dr_complete', { reflection, desires_changed })`

### Scheduled tick processing

1. `drainEvents` picks up all `event:*` keys (unchanged)
2. `communicationDelivery` handler: groups comms events by `conversation_id`, passes to `runTurn`
3. For each conversation: `runTurn(conversationId, turns)`
4. Events deleted only after durable outcome

### Event key format

`event:{padded_millis}:{type}:{nonce}` where nonce is 4-char random.
Prevents same-millisecond same-type collisions.

## CommTurn

The normalized input to `runTurn`:

```js
{
  conversation_id: "chat:slack:U084ASKBXB7",   // stable physical key
  reply_target: {                                // structured, not string
    platform: "slack",
    channel: "U084ASKBXB7",
    thread_ts: null,
  },
  source: "inbound" | "internal",
  content: "...",
  intent: null | "share" | "ask" | "report",    // internal only
  idempotency_key: "event:00001775...:inbound_message:a7x2",
  metadata: {
    // inbound: sentTs, userId, channel
    // internal: action_id, event_key, event_type
  },
}
```

## runTurn

The single conversation processor. One brain, one prompt, one state path.

1. **Load** conversation state from KV (`chat:*` key)
2. **Load** comms prompt (`prompt:communication`) + contact config
3. **Sort** turns: internal first (state updates), then inbound (reply-generating)
4. **Render** turns into message history:
   - Inbound: `{ role: "user", content: text }`
   - Internal: rendered as a system-controlled context block injected
     before user messages (e.g. `[AGENT UPDATES]` section in the system
     prompt), NOT as fake user messages. The LLM sees structured context,
     not prose pretending to be human input.
5. **Call LLM** with conversation history + tools:
   - `kv_query`, `kv_manifest` — always available
   - `trigger_session` — available only when inbound turns are present
   - `send` — required tool for sending a message
   - `hold` — tool to defer delivery
   - `discard` — tool to drop without sending
6. **Handle outcome** (from tool call):
   - `send(message)` → send via adapter to `reply_target`, save assistant
     message to history
   - `hold(reason, release_after?)` → create `outbox:*` KV key, don't send
   - `discard(reason)` → log to karma, don't send, don't hold
   - Plain text (no tool call) → **default to `hold`**, not send. Invalid
     output is safer held than sent.
7. **Persist** conversation state atomically
8. **Return** outcome for event lifecycle management

### LLM tools

```js
send:    { message: string }              // send to contact
hold:    { reason: string, release_after?: ISO8601 }  // defer
discard: { reason: string }               // drop silently
```

Plus existing: `kv_query`, `kv_manifest`, `trigger_session` (inbound only).

## Event lifecycle

Events use a claim-based lifecycle to prevent loss and duplication:

1. **Claim:** Before processing, mark event with `claimed_by` (execution ID),
   `claimed_at`, `lease_expires` (claimed_at + 60s). If already claimed and
   lease not expired, skip.
2. **Process:** `runTurn` executes.
3. **Resolve:**
   - `sent` or `discarded` → delete event key
   - `held` → create `outbox:*` key, delete event key
   - Retryable error → release claim (delete claim fields), leave for retry.
     Dead-letter after 3 failures (existing logic).
   - Non-retryable error → delete event key, log to karma

Stale claims (lease expired) are treated as unclaimed on the next tick.

## Outbox

Separate KV keys for durability and scanability:

**Key:** `outbox:{conversationId}:{id}`

**Value:**
```js
{
  id: "ob_1775149263206_a3x7",
  conversation_id: "chat:slack:U084ASKBXB7",
  content: "...",                    // the agent's intent
  hold_reason: "patron hasn't been active today",
  release_after: "2026-04-03T09:00:00Z",  // or null for manual
  source_event_keys: ["event:..."],
  created_at: "2026-04-03T02:15:00Z",
  attempts: 0,
}
```

**Scheduler:** Every tick, list `outbox:*` prefix. For items where
`release_after` has passed, re-inject as internal `CommTurn` into
`runTurn`. Apply same claim/delete lifecycle as events. Give outbox
items the same 3-strike dead-letter treatment.

## Budget

Two separate LLM budget pools per conversation, tracked on the
conversation state object:

- **`inbound_cost`**: charged for LLM calls triggered by human messages.
  Per-conversation limit from contact config or defaults.
- **`internal_cost`**: charged for LLM calls triggered by agent events.
  Separate limit. Agent's voice is never blocked by patron chat volume.

Both have circuit breakers. Neither can starve the other. `/reset`
command resets both.

## Conversation addressing

**Physical key (stable, never renamed):**
`chat:{platform}:{platformUserId}` — e.g. `chat:slack:U084ASKBXB7`

This is the key used in KV. It never changes, even when a contact
gets approved or their slug changes.

**Index key (for lookup by contact slug):**
`conversation_index:{contactSlug}` → points to the physical key.
Created when a contact is approved. Used by internal events that
reference contacts by slug.

**Reply target (structured):**
```js
{ platform: "slack", channel: "U084ASKBXB7", thread_ts: null }
```
Stored on the conversation state. Used by the adapter for sending.
Internal events resolve `reply_target` from the conversation state
(last-known), not from the event payload.

**Why no key migration:** Renaming keys when contacts get approved
would strand pending `event:*` and `outbox:*` records. A stable
physical key with a slug index avoids this entirely.

## Concurrency

**Single writer:** the scheduled tick holds the execution lock for the
entire `runTurn` lifecycle. Delivery completes inside the lock, not
in `waitUntil`.

**Fetch handler:** only writes `event:*` keys (append-only, no
read-modify-write on conversation state) and wakes the scheduler.

**Execution lock:** KV-based, best-effort (no CAS). Mitigated by lease
expiry — if lock is older than 60s, treat as stale. Not perfect, but
closes the practical gap for a single-worker deployment.

## request_message tool

New tool available during act phase. Not a comms tool (doesn't send
directly) — it's an event emitter.

**Definition:**
```js
{
  name: "request_message",
  description: "Request that a message be sent to a contact. The communication
    agent decides whether and how to deliver.",
  parameters: {
    contact: { type: "string", description: "Contact slug (e.g. swami_kevala)" },
    intent: { enum: ["share", "ask", "report"] },
    content: { type: "string", description: "What you want to communicate" },
  },
}
```

**Implementation:** Calls `K.emitEvent('comms_request', { contact, intent, content })`.
Contact must be a canonical slug — the kernel validates it exists in
`contact:*` keys before emitting. Raw platform IDs are rejected.

**Security:** The tool does not send anything. It writes an event that
the comms agent evaluates. The comms agent owns the final send/hold/discard
decision. Contact validation prevents exfiltration to arbitrary addresses.

## Config changes

**`config:event_handlers`** — add new event types:

```json
{
  "inbound_message": ["communicationDelivery"],
  "comms_request": ["communicationDelivery"],
  "session_complete": ["communicationDelivery"],
  "dr_complete": ["communicationDelivery"],
  "session_request": ["sessionTrigger"],
  "session_response": ["communicationDelivery"],
  "job_complete": ["communicationDelivery", "sessionTrigger"],
  "patron_direct": ["sessionTrigger"],
  "error": []
}
```

## What changes from current code

| Component | Current | New |
|-----------|---------|-----|
| `index.js` fetch | Runs `handleChat` directly | Writes event, wakes scheduler, returns 200 |
| `index.js` scheduled | Delivery in `waitUntil` (outside lock) | Delivery inside lock via `runTurn` |
| `EVENT_HANDLERS` | `communicationDelivery` buffers in memory | Groups by conversation, calls `runTurn` |
| `hook-communication.js` | Two functions (`handleChat`, `handleDelivery`) | One `runTurn` + two thin ingress normalizers |
| `handleDelivery` | Wrong param names, broken contact resolution | Deleted. Replaced by `runTurn`. |
| Event bus | Events deleted before delivery | Events claimed, deleted after durable outcome |
| Agent comms | No path exists | `request_message` tool → event → `runTurn` |
| Conversation key | `chat:{channel}:{resolvedChatKey}` | `chat:{platform}:{platformUserId}` (stable) |
| Budget | Single `total_cost` | Separate `inbound_cost` / `internal_cost` |
| Outbox | None (send-now or lose) | Durable `outbox:*` KV keys with release scheduler |

## What does NOT change

- Kernel primitives (`emitEvent`, `drainEvents`, `callLLM`, `executeAdapter`)
- Channel adapters (`channels/slack.js`, `channels/whatsapp.js`)
- Comms prompt location (`prompt:communication` in KV)
- Contact model (`contact:*`, `contact_platform:*`)
- Chat tools (`kv_query`, `kv_manifest`, `trigger_session`)
- Existing dead-letter logic (3-strike)

## Testing

- Unit: mock `runTurn` with inbound and internal CommTurns, verify
  outcomes (send/hold/discard), verify event lifecycle (claim/delete)
- Unit: verify `request_message` tool validates contact slugs
- Unit: outbox release timing, dead-letter on repeated failure
- Integration: Slack webhook → event → scheduled tick → `runTurn` → Slack reply
- Integration: act phase `request_message` → event → tick → delivery
- Race: two ticks with overlapping events, verify no duplicate sends

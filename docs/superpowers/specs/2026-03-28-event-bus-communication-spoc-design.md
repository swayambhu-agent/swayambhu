# Event Bus + Communication as Single Point of Contact

## Problem

Multiple systems (act sessions, chat handler, async jobs) independently send
messages to contacts and emit state changes. This causes duplicate messages,
inconsistent voice, no coordination, and missed signals between subsystems.

## Design Principles

**Emit events, don't call peers.** Systems communicate through events, not
direct calls. Each system does its job and emits what happened. Subscribers
react to events they care about.

**Communication is its own domain.** The communication hook is the only system
that talks to contacts. Everything else emits events; the communication hook
decides what, when, and how to communicate.

**Hard safety in the kernel, judgment in the hook.** The kernel enforces
constitutional safety (unapproved contact block, budget). All communication
judgment (tone, timing, bundling, holding) lives in the communication hook
and is governed by `prompt:communication`, evolvable by deep reflect.

## Architecture

### Event Bus Core

Events are KV keys with a 24-hour TTL.

**Key format:** `event:{timestamp}:{type}`

**Payload:**
```json
{
  "type": "work_complete",
  "source": "act",
  "session_id": "s_...",
  "contact": "U084ASKBXB7",
  "content": { ... },
  "timestamp": "2026-03-28T..."
}
```

**Emitting:** Any system calls `K.emitEvent(type, payload)` which writes to
`event:{Date.now()}:{type}`. This replaces `K.writeInboxItem()`.

**Draining:** The cron handler runs a lightweight routing phase before session
scheduling. No LLM calls in the drain itself — handlers are dispatched and
run independently.

**Failure handling:** If a handler throws, the event stays in KV for retry on
the next cron tick. After 3 failed cycles, the event moves to
`event_dead:{ts}:{type}` and a karma entry is recorded.

### Event Types

| Type | Emitted by | Subscribers |
|------|-----------|------------|
| `chat_message` | Communication hook (realtime mode) | `sessionWake` |
| `work_complete` | Act session (via `emit_event` tool) | `communicationDelivery` |
| `job_complete` | Async job runner | `communicationDelivery`, `sessionWake` |
| `patron_direct` | Communication hook | `sessionWake` |
| `error` | Kernel | (future: alerting, DR visibility) |

New event types can be added without changing the bus.

### Handler Routing

Handler routing is stored in `config:event_handlers` (KV), not in code:

```json
{
  "chat_message": ["sessionWake"],
  "work_complete": ["communicationDelivery"],
  "job_complete": ["communicationDelivery", "sessionWake"],
  "patron_direct": ["sessionWake"],
  "error": []
}
```

Handler *functions* are registered in code (index.js wiring). The config maps
event types to handler names. The agent can evolve routing in deep reflect
without a code deploy. Unknown handler names are logged and skipped.

A handler is a function: `async (K, event) => { ... }`. `drainEvents` calls
handlers per-event for retry granularity — if a handler fails on one event,
only that event stays for retry. Handlers that need batching (like
`communicationDelivery`) do their own grouping internally across sequential
calls within one drain cycle.

### Cron Flow

```
__scheduled fires ->
  Phase 1: Event drain
    - List event:* keys
    - Load config:event_handlers
    - Route to handlers:
      - communicationDelivery: groups by contact, invokes communication
        LLM via ctx.waitUntil (fire-and-forget), can prepone session
      - sessionWake: advances next_session_after
    - Delete processed events (failures stay for retry)

  Phase 2: Session scheduling (unchanged)
    - Check next_session_after vs now
    - If due: load context, dispatch to act or reflect
```

Phase 1 and Phase 2 are decoupled but sequential. Communication delivery
runs via `ctx.waitUntil` so it doesn't block session dispatch.

## Communication Hook

### Two Modes

The communication hook (`hook-communication.js`) operates in two modes:

**Realtime mode** — triggered by inbound webhook (`/channel/{channel}`).
Contact sends a message, communication LLM responds immediately. After
responding, emits `event:{ts}:chat_message`. This is the current chat
handler flow, largely unchanged.

**Delivery mode** — triggered by the `communicationDelivery` handler during
cron drain. Receives a batch of contact-facing events (`work_complete`,
`job_complete`). Flow:

1. Group events by contact
2. For each contact:
   a. Load conversation history (`chat:{channel}:{id}`)
   b. Load contact metadata
   c. Build delivery context: conversation + pending events + contact info
   d. Call communication LLM with `prompt:communication` (delivery guidance)
   e. LLM composes message, decides send/hold/bundle
   f. If sending: `K.executeAdapter()` -> kernel safety check -> channel send
   g. If preponing: `K.advanceSession(seconds)`
   h. Record karma

### Latency Model

- **Realtime** (inbound contact message): immediate response, no event bus
  involved for the outbound reply
- **Async** (work/job completion): delivered on next cron tick via
  `communicationDelivery`. Inherently async — contact is not waiting for
  an immediate reply

### prompt:communication

The communication prompt includes delivery guidance when deliverable events
are present:

```
You have pending deliverables from work sessions. For each, decide how to
present it to the contact. Consider the conversation history, whether to
bundle multiple items, whether to hold if timing isn't right, and how to
frame deliverables naturally. You own the relationship — every message the
contact sees comes through you.
```

This prompt is evolvable by deep reflect. All communication intelligence
lives in the prompt, not in code.

## Act Session Changes

### emit_event Tool

New tool: `tools/emit_event.js`. Act uses this to signal work completion,
request communication, or flag issues:

```json
{
  "type": "work_complete",
  "contact": "U084ASKBXB7",
  "content": "Research brief on 5 Sadhguru discourse topics",
  "attachments": [
    { "type": "google_doc", "url": "https://docs.google.com/..." }
  ]
}
```

Act describes *what happened and for whom*. It never composes the message.

### Tool Filtering

Send tools (`send_slack`, `send_email`, `send_whatsapp`) are removed from act
sessions. They remain available to the communication hook via channel adapters.

Enforced via a `context` field on tool registry definitions:

```json
{
  "send_slack": { "context": ["communication"], ... },
  "send_email": { "context": ["communication"], ... },
  "emit_event": { "context": ["act", "reflect"], ... },
  "web_search": { "context": ["act", "communication", "reflect"], ... }
}
```

`K.buildToolDefinitions()` filters by the current execution context.

### Act Context

Act receives `context.events` (replacing `context.inbox`) — filtered to event
types relevant to act sessions (`chat_message`, `job_complete`,
`patron_direct`). Collected during the drain phase before session dispatch.

The act prompt (`prompt:act`) is updated to reference `emit_event` instead of
send tools and to explain that communication is handled by the communication
system.

## Kernel Changes

### New Methods

- **`emitEvent(type, payload)`** — writes `event:{ts}:{type}` to KV with
  24h TTL. Replaces `writeInboxItem()`.
- **`drainEvents(handlers)`** — lists `event:*` keys, loads
  `config:event_handlers`, routes to handler functions, Deletes processed
  events. Returns act-relevant events for session context. Replaces
  `drainInbox()`.

### Removed Methods

- `writeInboxItem()` — replaced by `emitEvent()`
- `drainInbox()` — replaced by `drainEvents()`
- `communicationGate()` — judgment moves to communication hook
- `queueBlockedComm()` — `comms_blocked:` queue eliminated
- `processCommsVerdict()` — no more DR verdict flow
- `listBlockedComms()` — nothing to list

### Retained Safety

- **Self-contained contact check in `executeAdapter()`** — the kernel uses the
  adapter's own `meta.communication.recipient_field` to extract the recipient
  from the call args, then resolves the contact itself via `resolveContact()`.
  It does not trust any caller-supplied metadata about contact identity. Hard
  refusal for initiating contact with unapproved persons. Constitutional floor.
- **Hook isolation** — hooks receive only `K` (kernel interface), not raw
  adapters or `env`. All outbound communication goes through
  `K.executeAdapter()`, which enforces the contact check above. The adapter
  is never passed directly to hook code.
- **Budget enforcement** — unchanged, applies to all LLM calls including
  communication hook delivery mode.

### Security Model

The kernel mediates all external actions. Hooks talk to the outside world
through `K`, not around it. This prevents accidental or incidental safety
violations (agent forgets to check contact approval, LLM hallucinates a
send).

The remaining theoretical bypass (hook code reading secrets via `K.kvGet`
and calling `fetch()` directly) is a runtime limitation — Workers share a
process and cannot sandbox modules within a single isolate. The defense for
this layer is proposal review (code changes are visible) and karma audit
trail (unauthorized sends are detectable). This is appropriate for a
self-improving agent: guardrails for drift and mistakes, not containment
for a hostile actor.

### KV Prefix Changes

| Prefix | Change |
|--------|--------|
| `event:` | New — added to `KERNEL_ONLY_PREFIXES` |
| `event_dead:` | New — dead-letter events after repeated handler failures |
| `inbox:` | Removed |
| `comms_blocked:` | Removed |

### Kernel Interface

`buildKernelInterface()` exposes `emitEvent()` instead of `writeInboxItem()`.
Removes `listBlockedComms()` and `processCommsVerdict()`. Handler functions
receive the kernel interface so `communicationDelivery` can call `K.callLLM()`,
`K.executeAdapter()`, `K.advanceSession()`, etc.

## Inbox Migration

`inbox:` is fully replaced by `event:`.

| Current | New |
|---------|-----|
| `inbox:{ts}:chat:{channel}:{userId}` | `event:{ts}:chat_message` |
| `inbox:{ts}:job:{jobId}` | `event:{ts}:job_complete` |
| `inbox:{ts}:patron_direct` | `event:{ts}:patron_direct` |
| `writeInboxItem()` | `emitEvent()` |
| `drainInbox()` | `drainEvents()` |

Some events serve dual purposes — e.g., `job_complete` routes to
`communicationDelivery` (notify the contact) AND gets passed to act context
(so the agent knows the job finished). The handler processes its concern;
the event data is also captured for act context before deletion.

## Deep Reflect Changes

### Removed

- `comms_blocked:` queue review
- Per-message verdicts (`send`, `revise_and_send`, `drop`)
- `blockedComms` template variable

### Retained

- Evolving `prompt:communication` — shapes communication policy
- Evolving yamas/niyamas — can add communication principles
- Proposal system — can propose code changes to `hook-communication.js`

### Added

- `communication_health` visibility in reflect context: delivery failures
  (`event_dead:*`), communication karma patterns, current
  `prompt:communication` for policy review

DR focuses on communication *policy* rather than individual messages.

## Naming

| Old | New |
|-----|-----|
| `hook-chat.js` | `hook-communication.js` |
| `prompt:chat` | `prompt:communication` |
| `chatDelivery` handler | `communicationDelivery` handler |
| Chat system | Communication system |
| `chat:{channel}:{id}` | Unchanged — these are chat conversation histories |

## Files Changed

| File | Change |
|------|--------|
| `kernel.js` | `emitEvent()`, `drainEvents()` replace inbox methods. Remove `communicationGate()`, `queueBlockedComm()`, `processCommsVerdict()`, `listBlockedComms()`. Update `KERNEL_ONLY_PREFIXES`. Retain adapter-level contact safety check. |
| `hook-chat.js` -> `hook-communication.js` | Rename. Remove adapter parameter — all sends go through `K.executeAdapter()`. Add delivery mode for `communicationDelivery` handler. Emit `chat_message` events (replace `writeInboxItem`). |
| `tools/emit_event.js` | New tool for act sessions. |
| `index.js` | Event handler function registration. Wire `drainEvents()` into scheduled handler. Remove inbox write paths. Update hook import. Stop passing adapter to hook. |
| `config/tool-registry.json` | Add `emit_event`. Add `context` field to all tools. Mark send tools as `communication`-only. |
| `act.js` | `context.inbox` -> `context.events`. Update prompt references. |
| `reflect.js` | Remove `blockedComms` template variable. Add `communication_health`. Remove verdict processing. |
| `prompts/communication.md` | Renamed from `prompts/chat.md`. Add delivery mode guidance. |
| `prompts/act.md` | Replace send tool references with `emit_event`. |
| `scripts/seed-local-kv.mjs` | Seed `config:event_handlers`. Rename `prompt:chat` -> `prompt:communication`. |

## Future Directions

- DR specialization — separate communication review from session review
- Dashboard event subscription (real-time updates)
- Event TTL tuning based on type
- Error events surfacing in session health

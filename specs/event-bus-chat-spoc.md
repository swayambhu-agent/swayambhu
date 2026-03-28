# Event Bus + Chat as Single Point of Contact

## Problem

Multiple systems (act sessions, chat handler, async jobs) independently send messages to contacts and emit state changes. This causes duplicate messages, inconsistent voice, no coordination, and missed signals between subsystems.

## Design principle

**Emit events, don't call peers.** Systems communicate through events, not direct calls. Each system does its job and emits what happened. Subscribers react to events they care about.

**Communication is its own domain.** The chat hook is the only system that talks to contacts. Everything else emits events; the chat hook decides what, when, and how to communicate.

## Architecture

### Event bus

A KV-based event queue. Any system can emit events. The cron drains events to registered handlers.

**Event key format:** `event:{timestamp}:{type}`

**Event payload:**
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

**Emitting:** Any system calls `K.emitEvent(type, payload)` which writes to `event:{Date.now()}:{type}`.

**Draining:** The cron handler runs before session scheduling:

```
Cron fires →
  1. List event:* keys
  2. Route each event to registered handlers by type
  3. Delete processed events
  4. Check session schedule → if due, run session
```

### Event types

| Type | Emitted by | Subscribers |
|------|-----------|------------|
| `chat_message` | Chat handler | Act (session start drain) |
| `work_complete` | Act session | Chat hook |
| `job_complete` | Async job runner | Act (session start drain), Chat hook |
| `task_created` | Reflect | (future: dashboard) |
| `error` | Kernel | (future: alerting, DR visibility) |

New event types can be added without changing the bus. Handlers declare which types they process.

### Handler registration

Handlers are registered in the kernel or index.js:

```javascript
const eventHandlers = {
  work_complete: [chatDelivery],
  job_complete: [chatDelivery],
  chat_message: [sessionWake],
};
```

A handler is a function: `async (K, event) => { ... }`. It processes the event and returns. If it fails, the event stays in the queue for retry on the next cron cycle.

### Migration from inbox

The current `inbox:` system is an ad-hoc event bus. We must replace inbox with the event bus.** `inbox:` keys become `event:{ts}:chat_message`. The inbox drain at session start becomes a subscriber that filters for events relevant to the next session. Clean but higher migration cost.

### Chat hook as communication SPOC

The chat hook subscribes to contact-relevant events (`work_complete`, `job_complete`). When triggered:

1. Load pending events for the contact
2. Load the conversation history (`chat:{channel}:{id}`)
3. Call the chat LLM with the full context: conversation history + pending events
4. The LLM decides how to communicate: send now, bundle, deupe, hold, compose the right message
5. Send via channel adapter
6. Mark events as processed

The chat LLM has complete freedom in how to present deliverables. It might:
- Send a Google Doc link with a warm note
- Bundle multiple deliverables into one message
- Hold a delivery until the contact's previous question is answered
- Compose a follow-up question based on work results

All communication intelligence lives in `prompt:chat`, not in code. The agent can evolve its communication style through deep reflect. This prompt can also shape the agent's communication style.

### Act session changes

Act loses direct communication tools (`send_slack`, `send_email`, `send_whatsapp`). It gains:

**`emit_event` tool** — general-purpose event emission:

```json
{
  "type": "work_complete",
  "contact": "U084ASKBXB7",
  "content": "Research on 5 discourse topics for Sadhguru",
  "attachments": [
    { "type": "google_doc", "url": "https://docs.google.com/..." }
  ]
}
```

Act doesn't compose messages. It describes what it did and for whom. The chat hook handles presentation.

### Cron flow

```
__scheduled fires →
  1. Event drain: list event:* keys, route to handlers
     - work_complete → chatDelivery handler
     - job_complete → chatDelivery handler
     - chat_message → sessionWake handler (advances next session)
  2. Session schedule: check next_session_after, run session if due
```

Event drain is cheap — KV list + reads + handler calls. No LLM unless the chat delivery handler fires (which calls the chat LLM to compose messages).

### prompt:chat updates

The chat system prompt gets guidance for outbox delivery:

```
When you have pending deliverables from work sessions, decide how to
present them to the contact. Consider the conversation history, whether
to bundle multiple items, whether to hold if timing isn't right, and
how to frame deliverables naturally. You own the relationship — every
message the contact sees comes through you.
```

## Flow examples

### Research delivery

1. Act does web searches, creates Google Doc
2. Act calls `emit_event({ type: "work_complete", contact: "U084ASKBXB7", content: "...", attachments: [...] })`
3. Event written to `event:{ts}:work_complete`
4. Next cron: event drain routes to chatDelivery handler
5. Chat hook loads conversation with Swami, composes message: "The research brief is ready — 5 topics with sources. Here's the doc: [link]"
6. Sends via Slack, event deleted

### No duplicate acknowledgment

1. Swami sends "can you research X"
2. Chat handler responds: "Great idea, I'll work on that"
3. Chat handler emits `event:{ts}:chat_message`
4. Act session starts, drains events, does research
5. Act emits `event:{ts}:work_complete`
6. Chat hook delivers results — no re-acknowledgment because act never talked to Swami

### Async job completion

1. Act starts a background job via `start_job`
2. Job completes, emits `event:{ts}:job_complete`
3. Chat hook: if job had a contact association, delivers results
4. Next act session drains `job_complete` event and sees the result

### Bundling

1. Act completes two work items in one session — emits two events
2. Next cron: chatDelivery handler receives both
3. Chat LLM composes one message covering both deliverables

## Implementation

- Event bus: `emitEvent` kernel method, `event:` KV prefix, cron drain loop with handler routing
- Replace `inbox:` with event bus — `drainInbox` becomes event drain filtered by types relevant to the session (`chat_message`, `job_complete`)
- `emit_event` act tool (replaces direct send tools for contact communication)
- Chat delivery handler (chat hook in delivery mode for `work_complete` events)
- Session wake handler (`chat_message` events advance next session, replacing current wake_advance logic)
- Act tool filtering (exclude platform send tools from act sessions)
- `prompt:chat` updates for delivery context
- Chat handler emits `chat_message` events instead of writing `inbox:` keys

### Future

- Dashboard event subscription (real-time updates)
- DR visibility of events (error events surface in session health)
- Event TTL and cleanup

## Files changed

| File | Change |
|------|--------|
| `kernel.js` | `emitEvent` method, event drain replaces `drainInbox`, `event:` as kernel-only prefix |
| `tools/emit_event.js` | New tool for act sessions |
| `hook-chat.js` | Emit `chat_message` events (replaces `writeInboxItem`), add delivery mode for `work_complete` events |
| `index.js` | Event handler registration, wire drain into scheduled handler, remove inbox write paths |
| `config/tool-registry.json` | Add `emit_event`, mark send tools as chat-only |
| `act.js` or kernel tool filtering | Exclude platform send tools from act sessions |
| `prompts/chat.md` | Delivery context guidance |
| `prompts/act.md` | Replace send tool references with `emit_event` |

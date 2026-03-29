# Session Request/Response Contract

## Problem

When a contact asks the agent to do something, the communication hook
triggers a session. But there's no formal contract between the request
and the session's work. The session might complete the work, partially
complete it, or fail — and the communication system has no way to know
the status or deliver an appropriate response.

## Design Principle

**Every request gets a response.** Inspired by JavaScript's Promise
pattern: a session_request is created when the contact asks for work.
The session MUST resolve it (fulfilled, rejected, or pending). The
communication system acts on the response.

**KV is the source of truth, events are signals.** The full request
state lives in a KV key. Events just notify subscribers that something
changed — "go look at the key."

## Architecture

### Event Types

Two new event types replace `chat_message` and `work_complete`:

| Event | Emitted by | Subscribers | Purpose |
|-------|-----------|-------------|---------|
| `session_request` | `trigger_session` tool (chat) | `sessionTrigger` | Contact asked for work |
| `session_response` | `act.js` (structural output) | `communicationDelivery` | Session reports status |

Regular chat messages ("hi, how are you") emit no events. Only
`trigger_session` creates the contract.

### KV State: `session_request:{id}`

The source of truth for each request. Any process can read it.

```json
{
  "id": "req_1774785541",
  "contact": "U123",
  "contact_name": "Swami Kevala",
  "summary": "Research 10 stories for Sadhguru discourses",
  "status": "pending",
  "created_at": "2026-03-29T11:58:00Z",
  "updated_at": "2026-03-29T12:01:00Z",
  "ref": "chat:slack:U123",
  "result": null,
  "error": null,
  "next_session": null
}
```

**Statuses:**
- `pending` — work not started or in progress
- `fulfilled` — work done, `result` populated
- `rejected` — can't complete, `error` populated

### Flow

```
1. Contact: "Research some stories for Sadhguru"
2. Chat LLM: asks clarifying questions (no event)
3. Contact: provides specifics
4. Chat LLM: calls trigger_session
   → Creates session_request:{id} KV key (status: pending)
   → Emits session_request event
   → sessionTrigger handler advances schedule
5. Chat LLM: "On it, kicking off a session"

6. Cron fires → drains session_request event
7. Act session sees session_request:{id} in context
8. Act does the work (web searches, creates doc)
9. Act output includes response:
   {
     "session_summary": "...",
     "kv_operations": [...],
     "session_responses": [
       {
         "request_id": "req_1774785541",
         "status": "fulfilled",
         "result": {
           "content": "Research doc with 10 stories",
           "attachments": [{ "type": "google_doc", "url": "..." }]
         }
       }
     ]
   }
10. act.js processes session_responses:
    → Updates session_request:{id} (status: fulfilled, result: {...})
    → Emits session_response event with ref: session_request:{id}

11. Cron drain (or flush): session_response → communicationDelivery
12. Communication LLM reads session_request:{id}, composes message
13. Contact receives: "Research doc ready — here's the link"
```

### When the session doesn't complete

If the session can't fulfill a request (budget, complexity, needs more
info), it MUST still respond:

```json
{
  "session_responses": [
    {
      "request_id": "req_1774785541",
      "status": "pending",
      "next_session": "2026-03-29T12:30:00Z",
      "note": "Completed 6 of 10 topics, continuing next session"
    }
  ]
}
```

`act.js` updates the KV key and emits `session_response`. The
communication delivery handler reads the status and decides:
- Just started? Don't bother the contact.
- Been a while? "Still working on it, about 60% done."
- Contact asks via chat? Chat reads the KV key and responds.

### Accountability

The act prompt tells the agent it MUST respond to every `session_request`
in context. If it doesn't, `act.js` records `unaddressed_requests` in
the karma summary — visible to DR and session health. The system doesn't
auto-generate responses on behalf of the agent; it records the gap so
the agent can learn and DR can flag patterns.

No code enforcement. The agent is responsible. Stale pending requests
with no recent `updated_at` are visible to DR for prioritization.

### trigger_session changes

The tool creates the KV key and emits the event:

```javascript
export async function execute({ summary, K, _chatContext }) {
  const { channel, userId, contact, convKey, chatConfig } = _chatContext;

  const id = `req_${Date.now()}`;
  const request = {
    id,
    contact: userId,
    contact_name: contact?.name || userId,
    summary: summary || "(no summary)",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ref: convKey,
    result: null,
    error: null,
    next_session: null,
  };

  // KV is source of truth
  await K.kvWriteSafe(`session_request:${id}`, request);

  // Event is the signal
  await K.emitEvent("session_request", {
    contact: userId,
    ref: `session_request:${id}`,
  });

  // Advance session schedule
  // ... existing advance logic ...

  return { ok: true, request_id: id };
}
```

### act.js changes

Process `session_responses` from agent output (same pattern as
`kv_operations`):

```javascript
// After kv_operations processing
if (output.session_responses?.length) {
  for (const resp of output.session_responses) {
    const key = `session_request:${resp.request_id}`;
    const existing = await K.kvGet(key);
    if (!existing) continue;

    existing.status = resp.status;
    existing.updated_at = new Date().toISOString();
    if (resp.result) existing.result = resp.result;
    if (resp.error) existing.error = resp.error;
    if (resp.next_session) existing.next_session = resp.next_session;
    if (resp.note) existing.note = resp.note;

    await K.kvWriteSafe(key, existing);
    await K.emitEvent("session_response", {
      contact: existing.contact,
      ref: key,
      status: resp.status,
    });
  }
}

// Track unaddressed requests in karma summary (not auto-generated responses)
const requestEvents = context.events?.filter(e => e.type === "session_request") || [];
const respondedIds = new Set((output.session_responses || []).map(r => r.request_id));
const unaddressed = requestEvents.filter(e => {
  const req = e.ref;
  const id = req?.replace("session_request:", "");
  return id && !respondedIds.has(id);
});
if (unaddressed.length > 0) {
  await K.karmaRecord({
    event: "unaddressed_requests",
    count: unaddressed.length,
    refs: unaddressed.map(e => e.ref),
  });
}
```

### Event handler config

```json
{
  "session_request": ["sessionTrigger"],
  "session_response": ["communicationDelivery"],
  "job_complete": ["communicationDelivery", "sessionTrigger"],
  "patron_direct": ["sessionTrigger"],
  "error": []
}
```

`chat_message` and `work_complete` are removed. `session_request`
replaces the inbound signal. `session_response` replaces the outbound
delivery signal.

### Communication delivery changes

The `communicationDelivery` handler reads the KV key (via `ref`) to get
full context. The communication LLM sees: the request summary, the
status, the result/error, and the conversation history. It composes an
appropriate message.

### Who can read session_request keys

- **Chat** — via `kv_query`, to answer "is it done?" or "what's the status?"
- **Act sessions** — in context, to see pending work
- **Deep reflect** — to review unfulfilled requests and prioritize
- **Dashboard** — to show request status to the patron
- **Communication delivery** — to compose contextual messages

### KV prefix

`session_request:` is a new prefix. It should be in `SYSTEM_KEY_PREFIXES`
(writable by act for status updates) but not in `KERNEL_ONLY_PREFIXES`
(act needs to update them).

### Act prompt changes

The act prompt needs to explain the session_responses contract:

```
## Session Requests

When you receive session_request events, you are expected to respond to
each one in your output. Include a session_responses array:

- fulfilled: work is done, include result with content and attachments
- rejected: can't do this, include error explaining why
- pending: not done yet, include note on progress and next_session time

Every request MUST get a response. If you don't address a request, the
system will auto-mark it as pending.
```

## Files Changed

| File | Change |
|------|--------|
| `tools/trigger_session.js` | Create `session_request:{id}` KV key, emit `session_request` event |
| `act.js` | Process `output.session_responses`, enforce contract, emit `session_response` events |
| `hook-communication.js` | `communicationDelivery` reads KV key via `ref` for full context |
| `kernel.js` | Add `session_request:` to `SYSTEM_KEY_PREFIXES` |
| `scripts/seed-local-kv.mjs` | Update `config:event_handlers` |
| `prompts/act.md` | Explain session_responses contract |
| `config/tool-registry.json` | No changes (session_responses is output, not a tool) |

## Future

- Dashboard view of all session_request statuses
- DR prioritization of stale pending requests
- Request timeout / auto-rejection after N sessions without progress
- Request chaining — one request spawning sub-requests

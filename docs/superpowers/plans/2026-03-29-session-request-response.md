# Session Request/Response Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Promise-inspired request/response contract between the communication hook and act sessions, with KV as source of truth and events as signals.

**Architecture:** `trigger_session` creates a `session_request:{id}` KV key and emits a `session_request` event. Act sessions respond via `session_responses` in their output JSON. `act.js` updates the KV key and emits `session_response` events. The communication delivery handler reads the KV key to compose contextual messages. Unaddressed requests are tracked in karma.

**Tech Stack:** Cloudflare Workers, KV, Vitest

**Spec:** `docs/superpowers/specs/2026-03-29-session-request-response-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `tools/trigger_session.js` | Create session_request KV key + emit event (replaces chat_message emission) | Modify |
| `act.js` | Process output.session_responses, track unaddressed requests in karma | Modify |
| `hook-communication.js` | Update delivery handler to read session_request KV keys | Modify |
| `kernel.js` | Add `session_request:` to SYSTEM_KEY_PREFIXES | Modify |
| `scripts/seed-local-kv.mjs` | Update config:event_handlers | Modify |
| `prompts/act.md` | Explain session_responses contract | Modify |
| `prompts/communication.md` | Add guidance for pending request status | Modify |
| `tests/chat.test.js` | Update trigger_session tests | Modify |
| `tests/kernel.test.js` | Update drainEvents tests for new event types | Modify |
| `tests/helpers/mock-kernel.js` | Add session_request: to prefix arrays | Modify |

---

### Task 1: Update trigger_session to create session_request KV key

**Files:**
- Modify: `tools/trigger_session.js`
- Test: `tests/chat.test.js`

- [ ] **Step 1: Write failing test**

In `tests/chat.test.js`, find the `trigger_session` test or add one. The tool now creates a KV key and emits `session_request` (not `chat_message`):

```javascript
describe("trigger_session creates session_request", () => {
  it("creates session_request KV key and emits session_request event", async () => {
    const K = makeMockK({});
    K.resolveModel = vi.fn((m) => m);
    K.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.001,
      toolCalls: [{
        id: "tc_1",
        function: {
          name: "trigger_session",
          arguments: JSON.stringify({ summary: "Research Sadhguru topics" }),
        },
      }],
    }));
    // Second call returns text reply
    K.callLLM.mockResolvedValueOnce({
      content: null,
      cost: 0.001,
      toolCalls: [{
        id: "tc_1",
        function: {
          name: "trigger_session",
          arguments: JSON.stringify({ summary: "Research Sadhguru topics" }),
        },
      }],
    }).mockResolvedValueOnce({
      content: "On it!",
      cost: 0.001,
    });

    await handleChat(K, "slack", {
      chatId: "U123", text: "Do research", userId: "U123",
    });

    // Should have created a session_request: KV key
    const putCalls = K.kvWriteSafe.mock.calls.filter(([k]) => k.startsWith("session_request:"));
    expect(putCalls).toHaveLength(1);
    const [key, value] = putCalls[0];
    expect(key).toMatch(/^session_request:req_\d+$/);
    expect(value.contact).toBe("U123");
    expect(value.summary).toBe("Research Sadhguru topics");
    expect(value.status).toBe("pending");

    // Should have emitted session_request event (not chat_message)
    expect(K.emitEvent).toHaveBeenCalledWith("session_request", expect.objectContaining({
      contact: "U123",
      ref: expect.stringMatching(/^session_request:req_\d+$/),
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat.test.js -t "session_request"`
Expected: FAIL — emitEvent called with "chat_message" not "session_request"

- [ ] **Step 3: Update trigger_session.js**

Replace the entire file:

```javascript
export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

// Chat-only tool: signal that the conversation has an actionable request.
// Creates a session_request KV key (source of truth) and emits a
// session_request event (signal). The session will respond with a
// session_response when work is done.
export async function execute({ summary, K, _chatContext }) {
  if (!_chatContext) return { error: "trigger_session can only be called from chat" };

  const { channel, userId, contact, convKey, chatConfig } = _chatContext;

  // Create session_request KV key — source of truth
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
  await K.kvWriteSafe(`session_request:${id}`, request);

  // Emit event — signal for sessionTrigger handler
  await K.emitEvent("session_request", {
    contact: userId,
    ref: `session_request:${id}`,
  });

  // Advance session schedule
  const advanceSecs = chatConfig?.session_advance_seconds
    ?? (chatConfig?.session_advance_minutes ? chatConfig.session_advance_minutes * 60 : 30);
  const schedule = await K.kvGet("session_schedule");
  if (schedule?.next_session_after) {
    const sessionAt = new Date(schedule.next_session_after).getTime();
    const advanceTo = Date.now() + advanceSecs * 1000;
    if (sessionAt > advanceTo) {
      await K.kvWriteSafe("session_schedule", {
        ...schedule,
        next_session_after: new Date(advanceTo).toISOString(),
      });
    }
  }

  return { ok: true, request_id: id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat.test.js -t "session_request"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/trigger_session.js tests/chat.test.js
git commit -m "feat: trigger_session creates session_request KV key + event"
```

---

### Task 2: Add session_request: to kernel prefixes + update mock

**Files:**
- Modify: `kernel.js:46-56` (SYSTEM_KEY_PREFIXES)
- Modify: `tests/helpers/mock-kernel.js`

- [ ] **Step 1: Add prefix to kernel.js**

In `kernel.js`, add `'session_request:'` to `SYSTEM_KEY_PREFIXES` (after `'event_dead:'`):

```javascript
static SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'proposal:', 'hook:', 'doc:',
  'yama:', 'niyama:', 'task:',
  'upaya:', 'prajna:',
  'skill:',
  'contact:',
  'contact_platform:',
  'sealed:',
  'event:', 'event_dead:',
  'session_request:',
];
```

Do NOT add to `KERNEL_ONLY_PREFIXES` — act needs to write to these keys.

- [ ] **Step 2: Update mock-kernel.js**

Add `'session_request:'` to `_SYSTEM_PREFIXES` array and to `isSystemKey` and `getSystemKeyPatterns` prefix lists.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add kernel.js tests/helpers/mock-kernel.js
git commit -m "feat: add session_request: to SYSTEM_KEY_PREFIXES"
```

---

### Task 3: Process session_responses in act.js

**Files:**
- Modify: `act.js:78-88` (after kv_operations processing)
- Test: `tests/session.test.js` or `tests/inbox.test.js`

- [ ] **Step 1: Write failing test**

```javascript
describe("session_responses processing", () => {
  it("updates session_request KV key and emits session_response event", async () => {
    const K = makeMockK({
      "session_request:req_123": {
        id: "req_123",
        contact: "U123",
        contact_name: "Swami",
        summary: "Research topics",
        status: "pending",
        created_at: "2026-03-29T12:00:00Z",
        updated_at: "2026-03-29T12:00:00Z",
        ref: "chat:slack:U123",
        result: null,
        error: null,
      },
    });
    K.resolveModel = vi.fn((m) => m);
    K.runAgentLoop = vi.fn(async () => ({
      session_summary: "Researched 10 topics",
      kv_operations: [],
      session_responses: [{
        request_id: "req_123",
        status: "fulfilled",
        result: { content: "Research doc ready", attachments: [{ type: "google_doc", url: "https://docs.google.com/123" }] },
      }],
    }));

    const { runAct } = await import("../act.js");
    await runAct(K, { defaults: { session_budget: {} } }, { events: [] }, {});

    // KV key should be updated
    const putCalls = K.kvWriteSafe.mock.calls.filter(([k]) => k === "session_request:req_123");
    expect(putCalls.length).toBeGreaterThan(0);
    const updated = putCalls[putCalls.length - 1][1];
    expect(updated.status).toBe("fulfilled");
    expect(updated.result.content).toBe("Research doc ready");

    // session_response event should be emitted
    expect(K.emitEvent).toHaveBeenCalledWith("session_response", expect.objectContaining({
      contact: "U123",
      ref: "session_request:req_123",
      status: "fulfilled",
    }));
  });

  it("records unaddressed requests in karma", async () => {
    const K = makeMockK({
      "session_request:req_456": {
        id: "req_456",
        contact: "U456",
        status: "pending",
      },
    });
    K.resolveModel = vi.fn((m) => m);
    K.runAgentLoop = vi.fn(async () => ({
      session_summary: "Did other work",
      kv_operations: [],
      // No session_responses — request unaddressed
    }));

    const { runAct } = await import("../act.js");
    await runAct(K, { defaults: { session_budget: {} } }, {
      events: [{ type: "session_request", ref: "session_request:req_456", contact: "U456" }],
    }, {});

    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "unaddressed_requests",
      count: 1,
      refs: ["session_request:req_456"],
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "session_responses"`
Expected: FAIL

- [ ] **Step 3: Add session_responses processing to act.js**

After the `kv_operations` block (line 88), add:

```javascript
  // Process session responses — update request KV keys and emit events
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

  // Track unaddressed requests in karma (agent accountability, not auto-generation)
  const requestEvents = context.events?.filter(e => e.type === "session_request") || [];
  const respondedIds = new Set((output.session_responses || []).map(r => r.request_id));
  const unaddressed = requestEvents.filter(e => {
    const id = e.ref?.replace("session_request:", "");
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "session_responses"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add act.js tests/session.test.js
git commit -m "feat: process session_responses in act.js, track unaddressed requests"
```

---

### Task 4: Update communication delivery to read session_request KV keys

**Files:**
- Modify: `hook-communication.js:225-320` (handleDelivery function)
- Test: `tests/chat.test.js`

- [ ] **Step 1: Write failing test**

```javascript
describe("handleDelivery with session_request refs", () => {
  it("reads session_request KV key for delivery context", async () => {
    const K = makeMockK({
      "prompt:communication": "You are a communication system.",
      "chat:slack:U123": JSON.stringify({ messages: [] }),
      "session_request:req_123": JSON.stringify({
        id: "req_123",
        contact: "U123",
        contact_name: "Swami",
        summary: "Research topics",
        status: "fulfilled",
        result: { content: "Doc ready", attachments: [{ type: "google_doc", url: "https://docs.google.com/123" }] },
      }),
    });
    K.resolveContact.mockResolvedValue({ name: "Swami", platform: "slack", approved: true });
    K.resolveModel.mockResolvedValue("test-model");
    K.callLLM = vi.fn(async () => ({ content: "Here's your research doc!" }));
    K.getDefaults.mockResolvedValue({});

    const events = [{
      type: "session_response",
      contact: "U123",
      ref: "session_request:req_123",
      status: "fulfilled",
    }];

    const results = await handleDelivery(K, events);

    expect(results).toHaveLength(1);
    expect(results[0].sent).toBe(true);
    // The LLM should receive the request context including result
    const llmArgs = K.callLLM.mock.calls[0][0];
    const ctx = JSON.parse(llmArgs.messages[0].content);
    expect(ctx.request.summary).toBe("Research topics");
    expect(ctx.request.status).toBe("fulfilled");
    expect(ctx.request.result.content).toBe("Doc ready");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat.test.js -t "session_request refs"`
Expected: FAIL

- [ ] **Step 3: Update handleDelivery in hook-communication.js**

In the `handleDelivery` function, update the delivery context building to read the `session_request:*` KV key via `ref`:

Replace the `deliveryContext` building block with:

```javascript
      // Load session_request KV key if ref is provided
      const requestData = {};
      for (const e of contactEvents) {
        if (e.ref?.startsWith("session_request:")) {
          const req = await K.kvGet(e.ref);
          if (req) requestData[e.ref] = req;
        }
      }

      // Build delivery context
      const deliveryContext = {
        mode: "delivery",
        contact: { id: contactId, name: contact.name, platform },
        events: contactEvents.map(e => ({
          type: e.type,
          status: e.status,
          ref: e.ref,
          request: requestData[e.ref] || null,
          timestamp: e.timestamp,
        })),
        conversation_history: conv.messages.slice(-20),
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat.test.js -t "session_request refs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-communication.js tests/chat.test.js
git commit -m "feat: delivery handler reads session_request KV for context"
```

---

### Task 5: Update event handler config + seed script

**Files:**
- Modify: `scripts/seed-local-kv.mjs`

- [ ] **Step 1: Update event handler config**

Replace the event handlers config in `scripts/seed-local-kv.mjs`:

```javascript
await put("config:event_handlers", {
  session_request: ["sessionTrigger"],
  session_response: ["communicationDelivery"],
  job_complete: ["communicationDelivery", "sessionTrigger"],
  patron_direct: ["sessionTrigger"],
  error: [],
}, "json", "Event bus handler routing — maps event types to handler names");
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-local-kv.mjs
git commit -m "chore: update event handler config for session_request/response"
```

---

### Task 6: Update act prompt

**Files:**
- Modify: `prompts/act.md`

- [ ] **Step 1: Replace the Communication section**

Find the `## Communication` section in `prompts/act.md` and replace it with:

```markdown
## Communication

You do not send messages to contacts directly. The communication system
handles all contact-facing messages.

## Session Requests

When you receive session_request events in your context, you are expected
to respond to each one in your output. Include a `session_responses` array
alongside `session_summary` and `kv_operations`:

```json
{
  "session_summary": "What you did",
  "kv_operations": [],
  "session_responses": [
    {
      "request_id": "req_1774785541",
      "status": "fulfilled",
      "result": {
        "content": "Research doc with 10 stories",
        "attachments": [{ "type": "google_doc", "url": "https://..." }]
      }
    }
  ]
}
```

Statuses:
- **fulfilled** — work is done. Include `result` with content and any attachments.
- **rejected** — can't do this. Include `error` explaining why.
- **pending** — not done yet. Include `note` on progress and optionally `next_session` time.

Every request should get a response. Check `session_request:*` keys in your
context events for pending requests you need to address.
```

- [ ] **Step 2: Update the output JSON example**

Find the existing output JSON example in the `## What to do` section and add `session_responses`:

```json
{
  "session_summary": "What you did and why",
  "kv_operations": [],
  "session_responses": []
}
```

- [ ] **Step 3: Commit**

```bash
git add prompts/act.md
git commit -m "prompt: explain session_responses contract in act prompt"
```

---

### Task 7: Update communication prompt for pending requests

**Files:**
- Modify: `prompts/communication.md`

- [ ] **Step 1: Add pending request guidance**

Add after the delivery mode section:

```markdown
## Pending requests

Contacts may ask about the status of their requests. Use `kv_query` to
read `session_request:*` keys and check the `status` field:

- **pending** — "I'm still working on that, should have it ready soon."
- **fulfilled** — "That's done! Let me pull up the details." (The delivery
  system should have already sent this, but the contact may ask again.)
- **rejected** — "I wasn't able to complete that — [reason]."

Never expose internal key names or statuses. Translate them into natural
language appropriate for the relationship.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/communication.md
git commit -m "prompt: add pending request guidance to communication prompt"
```

---

### Task 8: Integration test

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Verify no stale chat_message/work_complete references in source**

```bash
grep -rn "chat_message\|work_complete" --include="*.js" --include="*.mjs" . | grep -v node_modules | grep -v .worktrees | grep -v docs/ | grep -v specs/
```

Expected: No matches in production code. The old event types should be fully replaced by `session_request` and `session_response`.

Note: `chat_message` may still appear in test files for the drainEvents tests — update those references if found.

- [ ] **Step 3: Commit any cleanup**

```bash
git add -u
git commit -m "chore: clean up stale chat_message/work_complete references"
```

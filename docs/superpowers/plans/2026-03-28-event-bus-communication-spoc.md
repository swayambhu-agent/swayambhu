# Event Bus + Communication SPOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inbox system with an event bus and make the communication hook the single point of contact for all outbound messaging.

**Architecture:** KV-based event queue (`event:{ts}:{type}`) with handler routing via `config:event_handlers`. Communication hook (`hook-communication.js`) operates in realtime mode (inbound messages) and delivery mode (async work/job results). Act sessions emit events instead of sending messages directly. Kernel retains hard safety gates; communication judgment moves to the hook.

**Tech Stack:** Cloudflare Workers, KV, Vitest

**Spec:** `docs/superpowers/specs/2026-03-28-event-bus-communication-spoc-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `kernel.js` | Event bus core: `emitEvent()`, `drainEvents()`. Remove inbox/comms gate methods. | Modify |
| `hook-communication.js` | Renamed from `hook-chat.js`. Realtime + delivery modes. | Rename + Modify |
| `tools/emit_event.js` | New tool for act sessions to emit events. | Create |
| `index.js` | Handler registration, wiring, job-complete endpoint migration. | Modify |
| `act.js` | `context.inbox` → `context.events`. | Modify |
| `reflect.js` | Remove blockedComms, add communication_health. | Modify |
| `config/tool-registry.json` | Add `emit_event`, add `context` field to all tools. | Modify |
| `prompts/communication.md` | Renamed from `prompts/chat.md`. Add delivery guidance. | Rename + Modify |
| `prompts/act.md` | Replace send tool refs with `emit_event`. | Modify |
| `scripts/seed-local-kv.mjs` | Seed `config:event_handlers`, rename prompt keys. | Modify |
| `tests/helpers/mock-kernel.js` | Update mock: `emitEvent` replaces `writeInboxItem`, remove comms methods. | Modify |
| `tests/kernel.test.js` | Tests for `emitEvent`, `drainEvents`, remove inbox/comms tests. | Modify |
| `tests/wake-hook.test.js` | Update reflect tests: remove blockedComms, add communication_health. | Modify |
| `tests/chat.test.js` | Update for `hook-communication.js`, `emitEvent` calls. | Modify |
| `tests/tools.test.js` | Add `emit_event` module tests. | Modify |

---

### Task 1: Event Bus Core — `emitEvent()` in kernel.js

**Files:**
- Modify: `kernel.js:541-548` (replace `writeInboxItem` with `emitEvent`)
- Modify: `kernel.js:505-610` (update `buildKernelInterface`)
- Modify: `tests/helpers/mock-kernel.js:43-44`
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for `emitEvent`**

In `tests/kernel.test.js`, find the `writeInboxItem` tests (lines 72-109) and replace them:

```javascript
describe("emitEvent", () => {
  it("writes event with correct key format and TTL", async () => {
    const kv = makeKVStore();
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const K = kernel.buildKernelInterface();

    await K.emitEvent("work_complete", {
      source: "act",
      contact: "U084ASKBXB7",
      content: "Research brief",
    });

    const keys = [...kv._store.keys()].filter(k => k.startsWith("event:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^event:\d{15}:work_complete$/);

    const val = JSON.parse(kv._store.get(keys[0]));
    expect(val.type).toBe("work_complete");
    expect(val.source).toBe("act");
    expect(val.contact).toBe("U084ASKBXB7");
    expect(val.content).toBe("Research brief");
    expect(val.timestamp).toBeDefined();

    // Verify TTL was set (86400 = 24h)
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^event:\d{15}:work_complete$/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 86400 })
    );
  });

  it("records karma event", async () => {
    const kv = makeKVStore();
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const karmaEvents = [];
    kernel._karmaRecord = async (evt) => karmaEvents.push(evt);
    const K = kernel.buildKernelInterface();

    await K.emitEvent("chat_message", { source: "communication", contact: "U123" });

    expect(karmaEvents).toContainEqual(expect.objectContaining({
      event: "event_emitted",
      type: "chat_message",
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "emitEvent"`
Expected: FAIL — `K.emitEvent is not a function`

- [ ] **Step 3: Implement `emitEvent` in kernel.js**

Replace the `writeInboxItem` method in `buildKernelInterface()` (kernel.js:541-548) with:

```javascript
emitEvent: async (type, payload) => {
  const ts = Date.now().toString().padStart(15, '0');
  const key = `event:${ts}:${type}`;
  const event = {
    type,
    ...payload,
    timestamp: payload.timestamp || new Date().toISOString(),
  };
  await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
  await kernel._karmaRecord({ event: "event_emitted", type, key });
  return { key };
},
```

- [ ] **Step 4: Update KV prefix constants**

In kernel.js, update `SYSTEM_KEY_PREFIXES` (line 46-57) and `KERNEL_ONLY_PREFIXES` (line 58):

Remove `'inbox:'` and `'comms_blocked:'` from `SYSTEM_KEY_PREFIXES`. Add `'event:'` and `'event_dead:'`.

Remove `'inbox:'` from `KERNEL_ONLY_PREFIXES`. Add `'event:'` and `'event_dead:'`.

```javascript
static SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'proposal:', 'hook:', 'doc:',
  'yama:', 'niyama:', 'task:',
  'upaya:', 'prajna:',
  'skill:',
  'event:', 'event_dead:',
  'contact:',
  'contact_platform:',
  'sealed:',
];

static KERNEL_ONLY_PREFIXES = ['kernel:', 'sealed:', 'karma:', 'event:', 'event_dead:'];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/kernel.test.js -t "emitEvent"`
Expected: PASS

- [ ] **Step 6: Update mock-kernel.js**

In `tests/helpers/mock-kernel.js`, replace `writeInboxItem` (line 44) with:

```javascript
// Event bus
emitEvent: vi.fn(async (type, payload) => {
  const ts = Date.now().toString().padStart(15, '0');
  const key = `event:${ts}:${type}`;
  const event = { type, ...payload, timestamp: new Date().toISOString() };
  await kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
  return { key };
}),
```

Remove `listBlockedComms` (line 40) and `processCommsVerdict` (line 41).

Update `_SYSTEM_PREFIXES` (line 139-144): remove `'comms_blocked:'` and `'inbox:'`, add `'event:'` and `'event_dead:'`.

Update `_KERNEL_ONLY` (line 146): remove `'inbox:'`, add `'event:'` and `'event_dead:'`.

Update `isSystemKey` (lines 73-83) and `getSystemKeyPatterns` (lines 84-92) to match.

- [ ] **Step 7: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/helpers/mock-kernel.js
git commit -m "feat: add emitEvent to kernel, replace writeInboxItem"
```

---

### Task 2: Event Bus Core — `drainEvents()` in kernel.js

**Files:**
- Modify: `kernel.js:338-356` (replace `drainInbox` with `drainEvents`)
- Modify: `kernel.js:505-610` (update `buildKernelInterface`)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for `drainEvents`**

In `tests/kernel.test.js`, replace the `drainInbox` tests (lines 24-70):

```javascript
describe("drainEvents", () => {
  it("returns empty object when no events", async () => {
    const kv = makeKVStore();
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });

    const result = await kernel.drainEvents({});
    expect(result.processed).toEqual([]);
    expect(result.actContext).toEqual([]);
  });

  it("routes events to handlers by type", async () => {
    const kv = makeKVStore({
      "event:000001711352400:work_complete": JSON.stringify({
        type: "work_complete", source: "act", contact: "U123", content: "Research done",
      }),
      "event:000001711352401:chat_message": JSON.stringify({
        type: "chat_message", source: "communication", contact: "U456",
      }),
      "config:event_handlers": JSON.stringify({
        work_complete: ["communicationDelivery"],
        chat_message: ["sessionWake"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });

    const delivered = [];
    const woken = [];
    const handlers = {
      communicationDelivery: async (K, event) => delivered.push(event),
      sessionWake: async (K, event) => woken.push(event),
    };

    const result = await kernel.drainEvents(handlers);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe("work_complete");
    expect(woken).toHaveLength(1);
    expect(woken[0].type).toBe("chat_message");
  });

  it("deletes events after successful handler execution", async () => {
    const kv = makeKVStore({
      "event:000001711352400:work_complete": JSON.stringify({
        type: "work_complete", source: "act", contact: "U123",
      }),
      "config:event_handlers": JSON.stringify({
        work_complete: ["testHandler"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const handlers = { testHandler: async () => {} };

    await kernel.drainEvents(handlers);

    const remaining = [...kv._store.keys()].filter(k => k.startsWith("event:") && !k.startsWith("event_dead:"));
    // Only config:event_handlers should remain, no event: keys
    expect(remaining.filter(k => !k.startsWith("config:"))).toHaveLength(0);
  });

  it("keeps event on handler failure for retry", async () => {
    const kv = makeKVStore({
      "event:000001711352400:work_complete": JSON.stringify({
        type: "work_complete", source: "act", contact: "U123",
      }),
      "config:event_handlers": JSON.stringify({
        work_complete: ["failHandler"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const handlers = { failHandler: async () => { throw new Error("handler failed"); } };

    await kernel.drainEvents(handlers);

    const remaining = [...kv._store.keys()].filter(k => k.startsWith("event:") && !k.startsWith("event_dead:"));
    expect(remaining).toHaveLength(1);
  });

  it("collects act-relevant events into actContext", async () => {
    const kv = makeKVStore({
      "event:000001711352400:chat_message": JSON.stringify({
        type: "chat_message", source: "communication", contact: "U123", summary: "hello",
      }),
      "event:000001711352401:job_complete": JSON.stringify({
        type: "job_complete", source: "job_runner", ref: "job:abc",
      }),
      "event:000001711352402:work_complete": JSON.stringify({
        type: "work_complete", source: "act", contact: "U456",
      }),
      "config:event_handlers": JSON.stringify({
        chat_message: ["sessionWake"],
        job_complete: ["communicationDelivery", "sessionWake"],
        work_complete: ["communicationDelivery"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const handlers = {
      communicationDelivery: async () => {},
      sessionWake: async () => {},
    };

    const result = await kernel.drainEvents(handlers);

    // chat_message and job_complete are act-relevant; work_complete is not
    const actTypes = result.actContext.map(e => e.type);
    expect(actTypes).toContain("chat_message");
    expect(actTypes).toContain("job_complete");
    expect(actTypes).not.toContain("work_complete");
  });

  it("skips unknown handler names and logs warning", async () => {
    const kv = makeKVStore({
      "event:000001711352400:work_complete": JSON.stringify({
        type: "work_complete", source: "act",
      }),
      "config:event_handlers": JSON.stringify({
        work_complete: ["nonExistentHandler"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const karmaEvents = [];
    kernel._karmaRecord = async (evt) => karmaEvents.push(evt);

    await kernel.drainEvents({});

    expect(karmaEvents).toContainEqual(expect.objectContaining({
      event: "event_handler_unknown",
    }));
    // Event should still be deleted since there's no valid handler to process it
  });

  it("moves event to dead-letter after 3 failures", async () => {
    const kv = makeKVStore({
      "event:000001711352400:work_complete": JSON.stringify({
        type: "work_complete", source: "act", contact: "U123",
      }),
      "event_fail_count:event:000001711352400:work_complete": JSON.stringify(2), // 2 prior failures
      "config:event_handlers": JSON.stringify({
        work_complete: ["failHandler"],
      }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const handlers = { failHandler: async () => { throw new Error("still failing"); } };

    await kernel.drainEvents(handlers);

    // Original event should be gone
    const remaining = [...kv._store.keys()].filter(k => k.startsWith("event:") && !k.startsWith("event_dead:") && !k.startsWith("event_fail"));
    expect(remaining.filter(k => !k.startsWith("config:"))).toHaveLength(0);

    // Dead-letter key should exist
    const deadKeys = [...kv._store.keys()].filter(k => k.startsWith("event_dead:"));
    expect(deadKeys).toHaveLength(1);
    expect(deadKeys[0]).toContain("work_complete");
  });

  it("records karma with event counts", async () => {
    const kv = makeKVStore({
      "event:000001711352400:chat_message": JSON.stringify({ type: "chat_message" }),
      "event:000001711352401:chat_message": JSON.stringify({ type: "chat_message" }),
      "config:event_handlers": JSON.stringify({ chat_message: ["sessionWake"] }),
    });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });
    const karmaEvents = [];
    kernel._karmaRecord = async (evt) => karmaEvents.push(evt);
    const handlers = { sessionWake: async () => {} };

    await kernel.drainEvents(handlers);

    expect(karmaEvents).toContainEqual(expect.objectContaining({
      event: "events_drained",
      count: 2,
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "drainEvents"`
Expected: FAIL — `kernel.drainEvents is not a function`

- [ ] **Step 3: Implement `drainEvents` in kernel.js**

Replace `drainInbox()` (kernel.js:338-356) with:

```javascript
// Act-relevant event types — these get passed to session context
static ACT_RELEVANT_EVENTS = ['chat_message', 'job_complete', 'patron_direct'];

async drainEvents(handlers) {
  const handlerConfig = await this.kvGet('config:event_handlers') || {};
  const listResult = await this.kvListAll('event:');
  const events = [];

  for (const { name } of listResult) {
    const val = await this.kv.get(name, 'json');
    if (val) events.push({ key: name, ...val });
  }

  if (events.length === 0) return { processed: [], actContext: [] };

  const processed = [];
  const actContext = [];

  for (const event of events) {
    // Capture act-relevant events before processing
    if (Kernel.ACT_RELEVANT_EVENTS.includes(event.type)) {
      actContext.push(event);
    }

    const handlerNames = handlerConfig[event.type] || [];
    let allHandlersSucceeded = true;

    for (const handlerName of handlerNames) {
      const handlerFn = handlers[handlerName];
      if (!handlerFn) {
        await this._karmaRecord({
          event: "event_handler_unknown",
          handler: handlerName,
          event_type: event.type,
          event_key: event.key,
        });
        continue;
      }
      try {
        await handlerFn(this.buildKernelInterface(), event);
      } catch (err) {
        allHandlersSucceeded = false;
        await this._karmaRecord({
          event: "event_handler_error",
          handler: handlerName,
          event_type: event.type,
          error: err.message,
        });
      }
    }

    if (allHandlersSucceeded) {
      await this.kv.delete(event.key);
      processed.push(event);
    } else {
      // Track failure count — promote to dead-letter after 3 failures
      const failKey = `event_fail_count:${event.key}`;
      const failCount = ((await this.kvGet(failKey)) || 0) + 1;
      if (failCount >= 3) {
        const deadKey = event.key.replace('event:', 'event_dead:');
        await this.kv.put(deadKey, JSON.stringify({ ...event, fail_count: failCount }), { expirationTtl: 604800 }); // 7 day TTL
        await this.kv.delete(event.key);
        await this.kv.delete(failKey);
        await this._karmaRecord({ event: "event_dead_lettered", type: event.type, key: event.key });
      } else {
        await this.kv.put(failKey, JSON.stringify(failCount), { expirationTtl: 86400 });
      }
    }
  }

  if (events.length > 0) {
    const typeCounts = {};
    for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    await this._karmaRecord({ event: "events_drained", count: events.length, types: typeCounts });
  }

  return { processed, actContext };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/kernel.test.js -t "drainEvents"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: add drainEvents to kernel, replace drainInbox"
```

---

### Task 3: Remove Communication Gate from Kernel

**Files:**
- Modify: `kernel.js:247-274` (remove `queueBlockedComm`)
- Modify: `kernel.js:276-319` (remove `communicationGate`)
- Modify: `kernel.js:321-332` (remove `listBlockedComms`)
- Modify: `kernel.js:358-413` (remove `processCommsVerdict`)
- Modify: `kernel.js:2034-2074` (remove gate call from `executeToolCall`)
- Modify: `kernel.js:505-610` (remove from `buildKernelInterface`)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Remove communication gate methods from kernel.js**

Delete these methods from the Kernel class:
- `queueBlockedComm()` (lines 247-274)
- `communicationGate()` (lines 276-319)
- `listBlockedComms()` (lines 321-332)
- `processCommsVerdict()` (lines 358-413)

In `executeToolCall()` (around lines 2034-2074), remove the communication gate check block. The block starts with checking for `commMeta` from tool meta and ends with the `_commsGateApproved` flag logic. Remove all of it — tools now execute without a communication gate. The adapter-level contact safety check (Task 10) will replace it.

In `buildKernelInterface()`, remove:
- `listBlockedComms` (line 537)
- `processCommsVerdict` (line 538)
- `writeInboxItem` (lines 541-548) — already replaced by `emitEvent` in Task 1

- [ ] **Step 2: Remove communication gate tests from kernel.test.js**

Delete the following test groups:
- `writeInboxItem` tests (lines 72-109) — replaced by `emitEvent` tests in Task 1
- Communication gate staleness tests (lines 111-150)
- `processCommsVerdict send` test (lines 2234-2254)
- `processCommsVerdict drop` test (lines 2256-2274)
- `revise_and_send` test (lines 2404-2423)
- `listBlockedComms` test (lines 2425-2438)

- [ ] **Step 3: Run all kernel tests**

Run: `npm test -- tests/kernel.test.js`
Expected: PASS — no references to removed methods

- [ ] **Step 4: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "refactor: remove communication gate from kernel"
```

---

### Task 4: Create `emit_event` Tool

**Files:**
- Create: `tools/emit_event.js`
- Modify: `config/tool-registry.json`
- Test: `tests/tools.test.js`

- [ ] **Step 1: Write failing test for emit_event module structure**

In `tests/tools.test.js`, add import at the top (after line 21):

```javascript
import * as emit_event from "../tools/emit_event.js";
```

Add test in the module structure section:

```javascript
describe("emit_event", () => {
  it("exports meta and execute", () => {
    expect(emit_event.meta).toBeDefined();
    expect(emit_event.meta.timeout_ms).toBeGreaterThan(0);
    expect(emit_event.meta.kv_access).toBe("none");
    expect(typeof emit_event.execute).toBe("function");
  });

  it("calls K.emitEvent with type and payload", async () => {
    const K = { emitEvent: vi.fn(async () => ({ key: "event:123:work_complete" })) };
    const result = await emit_event.execute({
      type: "work_complete",
      contact: "U084ASKBXB7",
      content: "Research brief",
      attachments: [{ type: "google_doc", url: "https://docs.google.com/123" }],
      K,
    });

    expect(K.emitEvent).toHaveBeenCalledWith("work_complete", {
      contact: "U084ASKBXB7",
      content: "Research brief",
      attachments: [{ type: "google_doc", url: "https://docs.google.com/123" }],
    });
    expect(result.key).toMatch(/^event:/);
  });

  it("rejects missing type", async () => {
    const K = { emitEvent: vi.fn() };
    const result = await emit_event.execute({ content: "test", K });
    expect(result.error).toMatch(/type.*required/i);
    expect(K.emitEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools.test.js -t "emit_event"`
Expected: FAIL — module not found

- [ ] **Step 3: Create `tools/emit_event.js`**

```javascript
export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

export async function execute({ type, contact, content, attachments, K }) {
  if (!type) return { error: "type is required" };

  const payload = {};
  if (contact) payload.contact = contact;
  if (content) payload.content = content;
  if (attachments) payload.attachments = attachments;

  const result = await K.emitEvent(type, payload);
  return result;
}
```

- [ ] **Step 4: Add to tool-registry.json**

Add to the `tools` array in `config/tool-registry.json`:

```json
{
  "name": "emit_event",
  "description": "Emit an event for the communication system or other subscribers. Use to signal work completion, deliver results, or flag issues. The communication system will decide how and when to present this to the contact.",
  "input": {
    "type": "required — event type (e.g. work_complete, job_complete, error)",
    "contact": "optional — contact identifier (e.g. Slack user ID, email)",
    "content": "optional — description of what happened",
    "attachments": "optional — array of { type, url } objects"
  },
  "context": ["act", "reflect"]
}
```

- [ ] **Step 5: Add `context` field to all existing tools in tool-registry.json**

Add `"context"` field to each existing tool entry. Default is all contexts. Communication tools get `"communication"` only:

- `send_slack`: add `"context": ["communication"]`
- `send_email`: add `"context": ["communication"]`
- All other tools: add `"context": ["act", "communication", "reflect"]`

Note: `send_whatsapp` is not in the registry (only in code). It will be handled in the index.js wiring (Task 8).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/tools.test.js -t "emit_event"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tools/emit_event.js config/tool-registry.json tests/tools.test.js
git commit -m "feat: add emit_event tool, context field on tool registry"
```

---

### Task 5: Rename and Extend Communication Hook

**Files:**
- Rename: `hook-chat.js` → `hook-communication.js`
- Modify: `hook-communication.js` (emit events instead of writeInboxItem, add delivery mode)
- Rename: `prompts/chat.md` → `prompts/communication.md`
- Modify: `prompts/communication.md` (add delivery guidance)
- Test: `tests/chat.test.js`

- [ ] **Step 1: Rename files**

```bash
git mv hook-chat.js hook-communication.js
git mv prompts/chat.md prompts/communication.md
```

- [ ] **Step 2: Remove adapter parameter, use K.executeAdapter for sends**

Update the function signature (line 12):

```javascript
// Before:
export async function handleChat(K, channel, inbound, adapter)

// After:
export async function handleChat(K, channel, inbound)
```

Replace all `adapter.sendReply(chatId, text)` calls (lines 32, 37, 49, 183)
with `K.executeAdapter()` calls. The channel adapter name comes from the
`channel` parameter:

```javascript
// Before:
await adapter.sendReply(chatId, reply);

// After:
await K.executeAdapter(channel, { text: reply, channel: chatId });
```

Apply this to all 4 call sites:
- Line 32 (budget refill reply)
- Line 37 (conversation cleared reply)
- Line 49 (budget exhausted reply)
- Line 183 (main LLM reply)

- [ ] **Step 3: Replace writeInboxItem with emitEvent**

In `hook-communication.js`, replace the `writeInboxItem` block (lines 199-209):

```javascript
// Emit event for next session
try {
  await K.emitEvent("chat_message", {
    source: { channel, user_id: userId },
    contact_name: contact?.name || userId,
    contact_approved: !!contact?.approved,
    summary: text.slice(0, 300),
    ref: convKey,
  });
} catch {}
```

- [ ] **Step 4: Add delivery mode export**

Add a new exported function at the bottom of `hook-communication.js`:

```javascript
/**
 * Delivery mode — called by communicationDelivery handler during cron drain.
 * Groups events by contact, calls communication LLM to compose outbound messages.
 */
export async function handleDelivery(K, events) {
  // Group events by contact
  const byContact = {};
  for (const event of events) {
    const contactId = event.contact || "unknown";
    if (!byContact[contactId]) byContact[contactId] = [];
    byContact[contactId].push(event);
  }

  const results = [];

  for (const [contactId, contactEvents] of Object.entries(byContact)) {
    try {
      // Resolve contact and channel info
      const contact = await K.resolveContact(null, contactId);
      if (!contact) {
        await K.karmaRecord({
          event: "delivery_skipped",
          contact: contactId,
          reason: "contact_not_found",
          event_count: contactEvents.length,
        });
        continue;
      }

      // Find conversation key — use the most recent chat conversation for this contact
      const platform = contact.platform || "slack";
      const convKey = `chat:${platform}:${contactId}`;
      const conv = await K.kvGet(convKey) || { messages: [] };

      // Load communication prompt
      const prompt = await K.kvGet("prompt:communication");
      if (!prompt) {
        await K.karmaRecord({ event: "delivery_error", reason: "no_prompt:communication" });
        continue;
      }

      // Build delivery context
      const deliveryContext = {
        mode: "delivery",
        contact: { id: contactId, name: contact.name, platform },
        pending_deliverables: contactEvents.map(e => ({
          type: e.type,
          content: e.content,
          attachments: e.attachments,
          timestamp: e.timestamp,
        })),
        conversation_history: conv.messages.slice(-20),
      };

      // Call communication LLM
      const model = await K.resolveModel(
        (await K.getDefaults())?.communication?.model || (await K.getDefaults())?.act?.model
      );
      const response = await K.callLLM({
        model,
        system: prompt,
        messages: [{ role: "user", content: JSON.stringify(deliveryContext) }],
        max_tokens: 1000,
      });

      const message = response?.content;
      if (!message) continue;

      // Send via channel adapter
      const adapterKey = platform === "slack" ? "slack" : platform;
      await K.executeAdapter(adapterKey, {
        text: message,
        channel: contactId,
      });

      // Update conversation history
      conv.messages.push(
        { role: "user", content: `[DELIVERY] ${contactEvents.map(e => e.content).join("; ")}` },
        { role: "assistant", content: message }
      );
      await K.kvWriteSafe(convKey, conv);

      await K.karmaRecord({
        event: "delivery_sent",
        contact: contactId,
        event_count: contactEvents.length,
        model,
      });

      results.push({ contact: contactId, sent: true });
    } catch (err) {
      await K.karmaRecord({
        event: "delivery_error",
        contact: contactId,
        error: err.message,
      });
      results.push({ contact: contactId, sent: false, error: err.message });
    }
  }

  return results;
}
```

- [ ] **Step 5: Update `prompts/communication.md`**

Add delivery guidance at the end of the existing prompt content:

```markdown

## Delivery mode

When you receive pending deliverables from work sessions, decide how to
present them to the contact. Consider the conversation history, whether
to bundle multiple items, whether to hold if timing isn't right, and how
to frame deliverables naturally. You own the relationship — every message
the contact sees comes through you.

You might:
- Send a link with a warm, contextual note
- Bundle multiple deliverables into one message
- Hold a delivery until a prior question is answered
- Compose a follow-up question based on work results
- Adjust tone and detail level to match the contact's style
```

- [ ] **Step 6: Update tests/chat.test.js**

Update the import to use the new file name:

```javascript
import { handleChat, handleDelivery } from "../hook-communication.js";
```

Update the test that checks `writeInboxItem` (around line 50-62) to check `emitEvent`:

```javascript
it("emits chat_message event after handling", async () => {
  // ... existing setup ...
  expect(K.emitEvent).toHaveBeenCalledWith("chat_message", expect.objectContaining({
    source: expect.objectContaining({ channel: expect.any(String) }),
    summary: expect.any(String),
  }));
});
```

Add a test for delivery mode:

```javascript
describe("handleDelivery", () => {
  it("groups events by contact and calls LLM", async () => {
    const K = makeMockK({
      "prompt:communication": "You are a communication system.",
      "chat:slack:U123": JSON.stringify({ messages: [] }),
    });
    K.resolveContact.mockResolvedValue({ name: "Test User", platform: "slack", approved: true });
    K.resolveModel.mockResolvedValue("test-model");
    K.callLLM.mockResolvedValue({ content: "Here are your results!" });
    K.getDefaults.mockResolvedValue({});

    const events = [
      { type: "work_complete", contact: "U123", content: "Research done", timestamp: new Date().toISOString() },
    ];

    const results = await handleDelivery(K, events);

    expect(results).toHaveLength(1);
    expect(results[0].sent).toBe(true);
    expect(K.callLLM).toHaveBeenCalled();
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "Here are your results!",
    }));
  });

  it("skips unknown contacts", async () => {
    const K = makeMockK({});
    K.resolveContact.mockResolvedValue(null);

    const events = [
      { type: "work_complete", contact: "UNKNOWN", content: "test" },
    ];

    const results = await handleDelivery(K, events);
    expect(results).toHaveLength(0);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "delivery_skipped",
      reason: "contact_not_found",
    }));
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npm test -- tests/chat.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add hook-communication.js prompts/communication.md tests/chat.test.js
git rm hook-chat.js prompts/chat.md  # git mv already handled this
git commit -m "feat: rename chat hook to communication hook, add delivery mode, remove adapter arg"
```

---

### Task 6: Wire Event Bus into index.js and Cron Flow

**Files:**
- Modify: `index.js` (handler registration, scheduled handler, job-complete endpoint, imports)
- Test: `tests/kernel.test.js` or manual integration test

- [ ] **Step 1: Update imports in index.js**

Replace (line 7):
```javascript
import { handleChat } from './hook-chat.js';
```
with:
```javascript
import { handleChat, handleDelivery } from './hook-communication.js';
```

- [ ] **Step 2: Add event handler registration**

After the `HOOKS` object (around line 58), add:

```javascript
// Event bus handlers — functions that process drained events by type
const EVENT_HANDLERS = {
  communicationDelivery: async (K, event) => {
    // Collect events for batch delivery — accumulator populated by drainEvents caller
    if (!EVENT_HANDLERS._pendingDelivery) EVENT_HANDLERS._pendingDelivery = [];
    EVENT_HANDLERS._pendingDelivery.push(event);
  },
  sessionWake: async (K, event) => {
    // Advance session schedule for inbound signals
    try {
      const schedule = await K.kvGet("session_schedule");
      if (schedule?.next_session_after) {
        const advanceTo = Date.now() + 30 * 1000;
        if (new Date(schedule.next_session_after).getTime() > advanceTo) {
          await K.kvWriteSafe("session_schedule", {
            ...schedule,
            next_session_after: new Date(advanceTo).toISOString(),
          });
        }
      }
    } catch (err) {
      await K.karmaRecord({ event: "session_wake_error", error: err.message });
    }
  },
};
```

- [ ] **Step 3: Update scheduled handler to use drainEvents**

The `kernel.runScheduled()` call needs to be updated in kernel.js to accept and use event handlers. In the `runSession()` method (kernel.js around line 1226), replace:

```javascript
const inboxItems = await this.drainInbox();
```

with:

```javascript
// Phase 1: Event drain
const { actContext: eventItems } = await this.drainEvents(this._eventHandlers || {});
```

And update the context building (around line 1257) to use `events` instead of `inbox`:

```javascript
const context = {
  balances, lastReflect, additionalContext,
  effort: effectiveEffort,
  reflectDepth,
  crashData,
  events: eventItems,  // was: inbox: inboxItems
  directMessage: patronDM?.message || null,
  reflectSchedule,
  patronPlatforms,
};
```

In the Kernel constructor or `runScheduled()`, accept event handlers:

```javascript
// In constructor or runScheduled, store reference to handlers
this._eventHandlers = opts.EVENT_HANDLERS || {};
```

Update `index.js` scheduled handler:

```javascript
async scheduled(event, env, ctx) {
  const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
  // Flush pending delivery after drain (in background)
  const origRunScheduled = kernel.runScheduled.bind(kernel);
  await origRunScheduled();
  // After session dispatch, flush any pending communication deliveries
  if (EVENT_HANDLERS._pendingDelivery?.length) {
    const pending = EVENT_HANDLERS._pendingDelivery.splice(0);
    const K = kernel.buildKernelInterface();
    ctx.waitUntil(handleDelivery(K, pending));
  }
},
```

- [ ] **Step 4: Update chat webhook to stop passing adapter to hook**

In `index.js`, find the chat webhook handler (around line 203) where
`handleChat` is called:

```javascript
// Before:
await handleChat(K, channel, inbound, adapter);

// After:
await handleChat(K, channel, inbound);
```

The hook now uses `K.executeAdapter(channel, ...)` internally for sends.
The adapter is still used in `index.js` for inbound parsing (signature
verification, payload extraction) — that stays unchanged.

- [ ] **Step 5: Update job-complete endpoint to use emitEvent**

In `index.js`, replace the inbox write in the job-complete handler (lines 100-109):

```javascript
// Emit event instead of writing inbox item
const K = kernel.buildKernelInterface();
await K.emitEvent("job_complete", {
  source: { job_id: jobId },
  summary: `Job ${jobId} (${job.type}) ${job.status}`,
  ref: `job:${jobId}`,
  result_key: `job_result:${jobId}`,
});
```

The Kernel instance needs to be created earlier in the handler. Move the kernel creation before the event emission:

```javascript
const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
const K = kernel.buildKernelInterface();
```

Keep the session advance logic (lines 112-123) as-is — it will also be triggered by the `sessionWake` handler on next cron drain, but immediate advance on callback is a good optimization.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — verify no broken references to old inbox/comms methods

- [ ] **Step 7: Commit**

```bash
git add index.js kernel.js
git commit -m "feat: wire event bus into cron flow, stop passing adapter to hook"
```

---

### Task 7: Update Act Session

**Files:**
- Modify: `act.js:102-120` (context.inbox → context.events)
- Modify: `prompts/act.md`
- Test: `tests/wake-hook.test.js`

- [ ] **Step 1: Update `buildActContext` in act.js**

In `act.js`, replace the inbox reference in `buildActContext()` (around line 110):

```javascript
// Before:
...(context.inbox?.length ? { inbox: context.inbox } : {}),

// After:
...(context.events?.length ? { events: context.events } : {}),
```

- [ ] **Step 2: Update `prompts/act.md`**

Find and replace references to send tools. Add near the top or in the tools section:

```markdown
## Communication

You do not send messages to contacts directly. Instead, use `emit_event` to
signal work completion or other contact-relevant outcomes. The communication
system will decide how and when to present your work to the contact.

Example — after completing research:
```json
emit_event({
  "type": "work_complete",
  "contact": "U084ASKBXB7",
  "content": "Research brief on 5 Sadhguru discourse topics",
  "attachments": [{ "type": "google_doc", "url": "https://docs.google.com/..." }]
})
```

Do not compose the message yourself. Describe what you did and for whom.
```

Remove any references to `send_slack`, `send_email`, or `send_whatsapp` as available tools.

- [ ] **Step 3: Update tests that reference context.inbox**

In `tests/wake-hook.test.js`, find tests that pass `context.inbox` and update to `context.events`:

```javascript
// Before:
const context = { inbox: [{ type: "chat_message", ... }], ... };

// After:
const context = { events: [{ type: "chat_message", ... }], ... };
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/wake-hook.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add act.js prompts/act.md tests/wake-hook.test.js
git commit -m "feat: act session uses context.events and emit_event"
```

---

### Task 8: Update Reflect — Remove Comms, Add Communication Health

**Files:**
- Modify: `reflect.js:251` (remove listBlockedComms)
- Modify: `reflect.js:265-267` (remove blockedComms template var)
- Modify: `reflect.js:402-410` (remove verdict processing)
- Test: `tests/wake-hook.test.js`

- [ ] **Step 1: Remove blockedComms from reflect context gathering**

In `reflect.js`, around line 251, remove:

```javascript
const blockedComms = await K.listBlockedComms();
```

And around lines 265-267, remove the `blockedComms` template variable:

```javascript
blockedComms: blockedComms.length > 0
  ? JSON.stringify(blockedComms, null, 2)
  : '(none)',
```

Replace with communication health context:

```javascript
// Communication health — delivery failures and patterns
const deadEvents = await K.kvList({ prefix: "event_dead:" });
const communicationHealth = {
  delivery_failures: deadEvents.keys.length,
  dead_events: deadEvents.keys.map(k => k.name).slice(0, 10),
};
```

Add to template variables:

```javascript
communicationHealth: JSON.stringify(communicationHealth, null, 2),
```

- [ ] **Step 2: Remove comms_verdicts processing from reflect output**

In `reflect.js`, around lines 402-410, remove the entire `comms_verdicts` block:

```javascript
// DELETE THIS BLOCK:
if (output.comms_verdicts) {
  for (const cv of output.comms_verdicts) {
    try {
      await K.processCommsVerdict(cv.id, cv.verdict, cv.revision);
    } catch (err) {
      await K.karmaRecord({ event: "comms_verdict_error", id: cv.id, error: err.message });
    }
  }
}
```

- [ ] **Step 3: Update reflect tests**

In `tests/wake-hook.test.js`, find and update reflect-related tests:

Remove tests for `blockedComms` in `gatherReflectContext` (lines 790-811).
Remove tests for `comms_verdicts` processing (lines 813-830).

Add test for communication_health:

```javascript
it("includes communication_health in reflect context", async () => {
  const K = makeMockK({
    "event_dead:000001711352400:work_complete": JSON.stringify({
      type: "work_complete", error: "handler failed 3 times",
    }),
  });

  // Call the context gathering function and verify communicationHealth is present
  // (exact test depends on how gatherReflectContext is exported/tested)
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/wake-hook.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add reflect.js tests/wake-hook.test.js
git commit -m "refactor: replace blockedComms with communication_health in reflect"
```

---

### Task 9: Tool Filtering by Context

**Files:**
- Modify: `kernel.js` (update `buildToolDefinitions` to filter by context)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for context-based tool filtering**

In `tests/kernel.test.js`, add:

```javascript
describe("buildToolDefinitions context filtering", () => {
  it("excludes communication-only tools from act context", async () => {
    const registry = {
      tools: [
        { name: "send_slack", input: { text: "required" }, context: ["communication"] },
        { name: "emit_event", input: { type: "required" }, context: ["act", "reflect"] },
        { name: "web_search", input: { query: "required" }, context: ["act", "communication", "reflect"] },
      ],
    };
    const kv = makeKVStore({ "config:tool_registry": JSON.stringify(registry) });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });

    const tools = await kernel.buildToolDefinitions({ context: "act" });
    const names = tools.map(t => t.name);

    expect(names).toContain("emit_event");
    expect(names).toContain("web_search");
    expect(names).not.toContain("send_slack");
  });

  it("includes communication-only tools in communication context", async () => {
    const registry = {
      tools: [
        { name: "send_slack", input: { text: "required" }, context: ["communication"] },
        { name: "emit_event", input: { type: "required" }, context: ["act", "reflect"] },
      ],
    };
    const kv = makeKVStore({ "config:tool_registry": JSON.stringify(registry) });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });

    const tools = await kernel.buildToolDefinitions({ context: "communication" });
    const names = tools.map(t => t.name);

    expect(names).toContain("send_slack");
    expect(names).not.toContain("emit_event");
  });

  it("includes all tools when no context filter specified", async () => {
    const registry = {
      tools: [
        { name: "send_slack", input: { text: "required" }, context: ["communication"] },
        { name: "emit_event", input: { type: "required" }, context: ["act"] },
      ],
    };
    const kv = makeKVStore({ "config:tool_registry": JSON.stringify(registry) });
    const kernel = new Kernel({ KV: kv }, { TOOLS: {}, HOOKS: {}, PROVIDERS: {}, CHANNELS: {} });

    const tools = await kernel.buildToolDefinitions({});
    const names = tools.map(t => t.name);

    expect(names).toContain("send_slack");
    expect(names).toContain("emit_event");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "context filtering"`
Expected: FAIL

- [ ] **Step 3: Implement context filtering in `buildToolDefinitions`**

In `kernel.js`, find `buildToolDefinitions()` and add context filtering. After loading the tool registry, filter tools by context:

```javascript
// Inside buildToolDefinitions, after loading registry
if (opts?.context) {
  tools = tools.filter(t => {
    // No context field = available everywhere
    if (!t.context) return true;
    return t.context.includes(opts.context);
  });
}
```

- [ ] **Step 4: Pass context from act.js and hook-communication.js**

In `act.js`, where `K.buildToolDefinitions()` is called (around line 55), pass context:

```javascript
const tools = await K.buildToolDefinitions({ context: "act" });
```

In `hook-communication.js`, where tools are built for the chat LLM (if applicable), pass:

```javascript
const tools = await K.buildToolDefinitions({ context: "communication" });
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/kernel.test.js -t "context filtering"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add kernel.js act.js hook-communication.js tests/kernel.test.js
git commit -m "feat: context-based tool filtering from registry"
```

---

### Task 10: Self-Contained Contact Safety in `executeAdapter`

**Files:**
- Modify: `kernel.js:1536-1555` (`executeAdapter` — add self-contained contact approval check)
- Test: `tests/kernel.test.js`

The kernel does NOT trust caller-supplied metadata about contact identity.
It uses the adapter's own `meta.communication.recipient_field` to extract
the actual recipient from the call args, then resolves the contact itself.

- [ ] **Step 1: Write failing test**

```javascript
describe("executeAdapter contact safety", () => {
  it("blocks sending to unapproved person-targeted contacts", async () => {
    const kv = makeKVStore();
    const kernel = new Kernel({ KV: kv }, {
      TOOLS: {},
      HOOKS: {},
      PROVIDERS: {
        slack: {
          meta: {
            secrets: [],
            communication: {
              channel: "slack",
              recipient_type: "person",
              recipient_field: "channel",
            },
          },
          execute: vi.fn(async () => ({ ok: true })),
        },
      },
      CHANNELS: {},
    });
    // Kernel resolves contact itself from the recipient field
    kernel.resolveContact = async (platform, userId) => {
      if (userId === "U_UNAPPROVED") return { approved: false, name: "Unknown" };
      return null;
    };

    await expect(
      kernel.executeAdapter("slack", { text: "hello", channel: "U_UNAPPROVED" })
    ).rejects.toThrow(/unapproved/i);
  });

  it("allows sending to approved contacts", async () => {
    const kv = makeKVStore();
    const sent = vi.fn(async () => ({ ok: true }));
    const kernel = new Kernel({ KV: kv }, {
      TOOLS: {},
      HOOKS: {},
      PROVIDERS: {
        slack: {
          meta: {
            secrets: [],
            communication: {
              channel: "slack",
              recipient_type: "person",
              recipient_field: "channel",
            },
          },
          execute: sent,
        },
      },
      CHANNELS: {},
    });
    kernel.resolveContact = async () => ({ approved: true, name: "Swami" });

    await kernel.executeAdapter("slack", { text: "hello", channel: "U_APPROVED" });
    expect(sent).toHaveBeenCalled();
  });

  it("allows destination-targeted sends without contact check", async () => {
    const kv = makeKVStore();
    const sent = vi.fn(async () => ({ ok: true }));
    const kernel = new Kernel({ KV: kv }, {
      TOOLS: {},
      HOOKS: {},
      PROVIDERS: {
        slack: {
          meta: {
            secrets: [],
            communication: {
              channel: "slack",
              recipient_type: "destination",
              recipient_field: "channel",
            },
          },
          execute: sent,
        },
      },
      CHANNELS: {},
    });

    await kernel.executeAdapter("slack", { text: "log message", channel: "C_CHANNEL" });
    expect(sent).toHaveBeenCalled();
  });

  it("allows sends with no communication meta (non-comms adapters)", async () => {
    const kv = makeKVStore();
    const called = vi.fn(async () => ({ balance: 100 }));
    const kernel = new Kernel({ KV: kv }, {
      TOOLS: {},
      HOOKS: {},
      PROVIDERS: {
        llm_balance: {
          meta: { secrets: [] },
          check: called,
        },
      },
      CHANNELS: {},
    });

    await kernel.executeAdapter("llm_balance", {});
    expect(called).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "contact safety"`
Expected: FAIL

- [ ] **Step 3: Implement self-contained safety check in `executeAdapter`**

In `kernel.js`, in `executeAdapter()` (around line 1536), add before the `fn(ctx)` call:

```javascript
// Constitutional safety: self-contained contact check for person-targeted adapters
// Kernel derives recipient from the actual args — does NOT trust caller metadata
const commsMeta = mod.meta?.communication;
if (commsMeta?.recipient_type === "person") {
  const recipientField = commsMeta.recipient_field;
  const recipientId = recipientField ? input[recipientField] : null;
  if (recipientId) {
    const contact = await this.resolveContact(commsMeta.channel, recipientId);
    if (!contact?.approved) {
      await this._karmaRecord({
        event: "adapter_contact_blocked",
        adapter: adapterKey,
        recipient: recipientId,
        reason: "unapproved_contact",
      });
      throw new Error(`Cannot send to unapproved contact: ${recipientId}`);
    }
  }
}

const ctx = { ...input, secrets, fetch: (...args) => fetch(...args) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/kernel.test.js -t "contact safety"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: adapter-level contact approval safety check"
```

---

### Task 11: Update Seed Script

**Files:**
- Modify: `scripts/seed-local-kv.mjs`

- [ ] **Step 1: Update prompt key name**

In `scripts/seed-local-kv.mjs`, replace (around line 115):

```javascript
// Before:
await put("prompt:chat", read("prompts/chat.md"), "text", "Chat system prompt");

// After:
await put("prompt:communication", read("prompts/communication.md"), "text", "Communication system prompt");
```

- [ ] **Step 2: Add event_handlers config seeding**

Add after the other config seeds:

```javascript
await put("config:event_handlers", {
  chat_message: ["sessionWake"],
  work_complete: ["communicationDelivery"],
  job_complete: ["communicationDelivery", "sessionWake"],
  patron_direct: ["sessionWake"],
  error: [],
}, "json", "Event bus handler routing — maps event types to handler names");
```

- [ ] **Step 3: Verify seed script runs**

Run: `node scripts/seed-local-kv.mjs --persist-to .wrangler/shared-state`
Expected: Completes without errors, shows seeded key count

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-local-kv.mjs
git commit -m "chore: update seed script for event bus and prompt:communication"
```

---

### Task 12: Integration Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass. No references to `writeInboxItem`, `drainInbox`, `communicationGate`, `listBlockedComms`, `processCommsVerdict`, `comms_blocked:`, or `inbox:` in test code (except as removal context).

- [ ] **Step 2: Verify no stale references**

Search the codebase for stale references:

```bash
grep -r "writeInboxItem\|drainInbox\|communicationGate\|queueBlockedComm\|processCommsVerdict\|listBlockedComms\|comms_blocked:" --include="*.js" --include="*.md" .
```

Expected: No matches in source code. Matches only in the design spec/plan docs.

```bash
grep -r "inbox:" --include="*.js" .
```

Expected: No matches in source code (inbox: prefix fully replaced by event:).

```bash
grep -r "hook-chat\|prompt:chat" --include="*.js" --include="*.mjs" .
```

Expected: No matches — all renamed to `hook-communication` / `prompt:communication`.

- [ ] **Step 3: Local dev smoke test**

```bash
source .env && bash scripts/start.sh --reset-all-state --set act.model=deepseek --set reflect.model=deepseek --trigger
```

Watch stderr for:
- `[KARMA]` event_emitted / events_drained events (confirms event bus working)
- No `[ERROR]` entries related to missing methods
- Session completes successfully

- [ ] **Step 4: Commit any fixes**

If smoke test reveals issues, fix and commit each fix individually.

- [ ] **Step 5: Final commit — update CLAUDE.md if needed**

If any CLAUDE.md references to inbox or chat handler need updating, do so:

```bash
git add -A
git commit -m "chore: integration smoke test cleanup"
```

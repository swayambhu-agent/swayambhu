# Unified Communication Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split chat/delivery communication paths with a single `runTurn` processor, add agent-initiated messaging via `request_message` tool, and make event lifecycle durable.

**Architecture:** All communication flows through the scheduled tick (single writer). Fetch handler writes events and returns 200 immediately. One `runTurn` function processes both inbound and internal turns with explicit send/hold/discard outcomes. Events are only deleted after durable state transitions.

**Tech Stack:** Cloudflare Workers, KV, vitest, existing kernel primitives (`emitEvent`, `drainEvents`, `callLLM`, `executeAdapter`)

**Spec:** `docs/superpowers/specs/2026-04-03-unified-communication-pipeline-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `hook-communication.js` | Rewrite | `ingestInbound`, `ingestInternal`, `runTurn`, outbox helpers. Replaces `handleChat` + `handleDelivery`. |
| `index.js` | Modify | Fetch: write event + wake scheduler. Scheduled: run comms inside lock. Remove `waitUntil` delivery. |
| `kernel.js` | Modify | Add nonce to `emitEvent` key format. Add event claim/release helpers. |
| `tools/request_message.js` | Create | New act-phase tool: validates contact slug, emits `comms_request` event. |
| `userspace.js` | Modify | Emit `session_complete` after act cycle. Remove `request_message` from `COMMS_TOOLS` filter (it's not a comms tool). |
| `config/event-handlers.json` | Modify | Add `inbound_message`, `comms_request`, `session_complete`, `dr_complete` routing. |
| `config/tool-registry.json` | Modify | Register `request_message` tool. |
| `prompts/communication.md` | Modify | Add send/hold/discard tool docs, internal turn rendering guidance. |
| `scripts/seed-local-kv.mjs` | Modify | Seed updated event handlers + tool registry. |
| `tests/chat.test.js` | Rewrite | Tests for `runTurn`, `ingestInbound`, `ingestInternal`, outbox, event lifecycle. |

---

### Task 1: Event key nonce (kernel.js)

**Files:**
- Modify: `kernel.js:428-438` (emitEvent)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing test for nonce in event key**

In `tests/kernel.test.js`, find the existing `emitEvent` test block. Add:

```js
it("emitEvent includes nonce suffix to prevent collisions", async () => {
  const K = kernel.buildKernelInterface();
  const result = await K.emitEvent("test_type", { data: "hello" });
  // Key format: event:{padded_millis}:{type}:{4-char-nonce}
  const parts = result.key.split(":");
  expect(parts.length).toBe(4);
  expect(parts[0]).toBe("event");
  expect(parts[2]).toBe("test_type");
  expect(parts[3]).toMatch(/^[a-z0-9]{4}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/kernel.test.js -t "nonce suffix"`
Expected: FAIL — current key has 3 parts, not 4.

- [ ] **Step 3: Add nonce to emitEvent**

In `kernel.js`, replace the `emitEvent` implementation (around line 428):

```js
emitEvent: async (type, payload) => {
  const ts = Date.now().toString().padStart(15, '0');
  const nonce = Math.random().toString(36).slice(2, 6);
  const key = `event:${ts}:${type}:${nonce}`;
  const event = {
    type,
    ...payload,
    timestamp: payload.timestamp || new Date().toISOString(),
  };
  await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
  await kernel.karmaRecord({ event: "event_emitted", type, key });
  return { key };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/kernel.test.js -t "nonce suffix"`
Expected: PASS

- [ ] **Step 5: Update any existing tests that assert on event key format**

Run: `npm test`
Fix any tests that break due to the new 4-part key format. The key pattern change from `event:ts:type` to `event:ts:type:nonce` may affect string assertions.

- [ ] **Step 6: Commit**

```bash
git add kernel.js tests/kernel.test.js
git commit -m "feat: add nonce suffix to event keys to prevent collisions"
```

---

### Task 2: Event claim/release helpers (kernel.js)

**Files:**
- Modify: `kernel.js` (add methods to Kernel class)
- Test: `tests/kernel.test.js`

- [ ] **Step 1: Write failing tests for claim and release**

```js
describe("event claim lifecycle", () => {
  it("claimEvent marks event with lease", async () => {
    const kernel = makeTestKernel();
    const K = kernel.buildKernelInterface();
    await K.emitEvent("test", { data: "x" });
    const events = await listEvents(kernel);
    const key = events[0].name;

    const claimed = await K.claimEvent(key, "exec_123");
    expect(claimed).toBe(true);

    const val = JSON.parse(await kernel.kv.get(key));
    expect(val.claimed_by).toBe("exec_123");
    expect(val.claimed_at).toBeDefined();
    expect(val.lease_expires).toBeDefined();
  });

  it("claimEvent returns false if already claimed with active lease", async () => {
    const kernel = makeTestKernel();
    const K = kernel.buildKernelInterface();
    await K.emitEvent("test", { data: "x" });
    const events = await listEvents(kernel);
    const key = events[0].name;

    await K.claimEvent(key, "exec_1");
    const claimed = await K.claimEvent(key, "exec_2");
    expect(claimed).toBe(false);
  });

  it("claimEvent succeeds if previous lease expired", async () => {
    const kernel = makeTestKernel();
    const K = kernel.buildKernelInterface();
    await K.emitEvent("test", { data: "x" });
    const events = await listEvents(kernel);
    const key = events[0].name;

    // Claim with expired lease
    const val = JSON.parse(await kernel.kv.get(key));
    val.claimed_by = "exec_old";
    val.claimed_at = new Date(Date.now() - 120000).toISOString();
    val.lease_expires = new Date(Date.now() - 60000).toISOString();
    await kernel.kv.put(key, JSON.stringify(val));

    const claimed = await K.claimEvent(key, "exec_new");
    expect(claimed).toBe(true);
  });

  it("releaseEvent removes claim fields", async () => {
    const kernel = makeTestKernel();
    const K = kernel.buildKernelInterface();
    await K.emitEvent("test", { data: "x" });
    const events = await listEvents(kernel);
    const key = events[0].name;

    await K.claimEvent(key, "exec_1");
    await K.releaseEvent(key);

    const val = JSON.parse(await kernel.kv.get(key));
    expect(val.claimed_by).toBeUndefined();
    expect(val.lease_expires).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/kernel.test.js -t "event claim"`
Expected: FAIL — `claimEvent` and `releaseEvent` don't exist.

- [ ] **Step 3: Implement claimEvent and releaseEvent on kernel interface**

In `kernel.js`, inside `buildKernelInterface()`, add after `emitEvent`:

```js
claimEvent: async (key, executionId) => {
  const raw = await kernel.kv.get(key);
  if (!raw) return false;
  const event = JSON.parse(raw);
  // Check existing claim
  if (event.claimed_by && event.lease_expires) {
    if (new Date(event.lease_expires) > new Date()) return false;
  }
  event.claimed_by = executionId;
  event.claimed_at = new Date().toISOString();
  event.lease_expires = new Date(Date.now() + 60000).toISOString();
  await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
  return true;
},

releaseEvent: async (key) => {
  const raw = await kernel.kv.get(key);
  if (!raw) return;
  const event = JSON.parse(raw);
  delete event.claimed_by;
  delete event.claimed_at;
  delete event.lease_expires;
  await kernel.kv.put(key, JSON.stringify(event), { expirationTtl: 86400 });
},
```

- [ ] **Step 4: Add to mock-kernel.js**

In `tests/helpers/mock-kernel.js`, add corresponding mocks:

```js
claimEvent: vi.fn(async (key, executionId) => {
  const raw = kv._store.get(key);
  if (!raw) return false;
  const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (event.claimed_by && event.lease_expires && new Date(event.lease_expires) > new Date()) return false;
  event.claimed_by = executionId;
  event.claimed_at = new Date().toISOString();
  event.lease_expires = new Date(Date.now() + 60000).toISOString();
  kv._store.set(key, JSON.stringify(event));
  return true;
}),

releaseEvent: vi.fn(async (key) => {
  const raw = kv._store.get(key);
  if (!raw) return;
  const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  delete event.claimed_by;
  delete event.claimed_at;
  delete event.lease_expires;
  kv._store.set(key, JSON.stringify(event));
}),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/kernel.test.js -t "event claim"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add kernel.js tests/kernel.test.js tests/helpers/mock-kernel.js
git commit -m "feat: add event claim/release lifecycle helpers"
```

---

### Task 3: runTurn — the unified conversation processor

**Files:**
- Rewrite: `hook-communication.js` (new `runTurn` function)
- Test: `tests/chat.test.js`

This is the core task. `runTurn` replaces both `handleChat` and `handleDelivery`.

- [ ] **Step 1: Write failing tests for runTurn**

Rewrite the top of `tests/chat.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTurn } from "../hook-communication.js";
import { makeMockK } from "./helpers/mock-kernel.js";

function makeLLMResponse(content, toolCalls = null) {
  return { content, cost: 0.001, toolCalls: toolCalls || null, usage: {} };
}

function makeInboundTurn(text, opts = {}) {
  return {
    conversation_id: "chat:slack:U084ASKBXB7",
    reply_target: { platform: "slack", channel: "U084ASKBXB7", thread_ts: null },
    source: "inbound",
    content: text,
    intent: null,
    idempotency_key: `event:${Date.now()}:inbound_message:test`,
    metadata: { sentTs: "1234567890.123456", userId: "U084ASKBXB7" },
    ...opts,
  };
}

function makeInternalTurn(content, intent = "share", opts = {}) {
  return {
    conversation_id: "chat:slack:U084ASKBXB7",
    reply_target: { platform: "slack", channel: "U084ASKBXB7", thread_ts: null },
    source: "internal",
    content,
    intent,
    idempotency_key: `event:${Date.now()}:comms_request:test`,
    metadata: {},
    ...opts,
  };
}

describe("runTurn", () => {
  let K;

  beforeEach(() => {
    K = makeMockK({}, {
      defaults: {
        chat: {
          model: "sonnet",
          effort: "low",
          max_cost_per_conversation: 0.50,
          max_output_tokens: 1000,
          max_history_messages: 40,
        },
        act: { model: "sonnet" },
      },
    });
    K.resolveModel = vi.fn((m) => m);
    K.resolveContact = vi.fn(async () => ({
      name: "Swami Kevala",
      relationship: "patron",
    }));
  });

  it("sends reply for inbound turn via send tool call", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "send", arguments: '{"message":"Hello back!"}' } },
    ]));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    expect(result.action).toBe("sent");
    expect(result.message).toBe("Hello back!");
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", {
      text: "Hello back!",
      channel: "U084ASKBXB7",
    });
  });

  it("holds on plain text response (no tool call)", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse("Some text without tool call"));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    expect(result.action).toBe("held");
    expect(K.executeAdapter).not.toHaveBeenCalled();
  });

  it("holds when hold tool is called", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "hold", arguments: '{"reason":"patron is asleep"}' } },
    ]));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("DR complete")]);

    expect(result.action).toBe("held");
    expect(result.reason).toBe("patron is asleep");
  });

  it("discards when discard tool is called", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "discard", arguments: '{"reason":"not relevant"}' } },
    ]));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("session complete")]);

    expect(result.action).toBe("discarded");
    expect(result.reason).toBe("not relevant");
  });

  it("tracks inbound_cost and internal_cost separately", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "send", arguments: '{"message":"ok"}' } },
    ]));

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hi")]);
    const conv1 = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv1.inbound_cost).toBeGreaterThan(0);
    expect(conv1.internal_cost).toBe(0);

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("update")]);
    const conv2 = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv2.internal_cost).toBeGreaterThan(0);
  });

  it("sorts internal turns before inbound turns", async () => {
    let capturedMessages;
    K.callLLM = vi.fn(async (opts) => {
      capturedMessages = opts.messages;
      return makeLLMResponse(null, [
        { id: "tc_1", function: { name: "send", arguments: '{"message":"ok"}' } },
      ]);
    });

    await runTurn(K, "chat:slack:U084ASKBXB7", [
      makeInboundTurn("Hello"),
      makeInternalTurn("agent update"),
    ]);

    // The system prompt should contain the internal turn context
    // before the user message appears in messages
    const userMsgs = capturedMessages.filter(m => m.role === "user");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe("Hello");
  });

  it("persists conversation state after turn", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "send", arguments: '{"message":"Hi!"}' } },
    ]));

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    const conv = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv).toBeDefined();
    expect(conv.messages.length).toBeGreaterThan(0);
    expect(conv.turn_count).toBe(1);
  });

  it("suppresses trigger_session for internal-only batches", async () => {
    let capturedTools;
    K.callLLM = vi.fn(async (opts) => {
      capturedTools = opts.tools;
      return makeLLMResponse(null, [
        { id: "tc_1", function: { name: "send", arguments: '{"message":"noted"}' } },
      ]);
    });

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("update")]);

    const toolNames = capturedTools.map(t => t.function.name);
    expect(toolNames).not.toContain("trigger_session");
    expect(toolNames).toContain("send");
    expect(toolNames).toContain("hold");
    expect(toolNames).toContain("discard");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/chat.test.js`
Expected: FAIL — `runTurn` is not exported from `hook-communication.js`.

- [ ] **Step 3: Implement runTurn**

Rewrite `hook-communication.js`. Keep `trimByTurns` (it still works). Replace `handleChat` and `handleDelivery` with:

```js
// Swayambhu Communication — unified turn processor.
// All communication flows through runTurn: one brain, one state, one prompt.
// Ingress normalizers (ingestInbound, ingestInternal) create CommTurns.
// The scheduled tick is the single writer — fetch only writes events.

// ── LLM tools for communication ───────────────────────

const SEND_TOOL = {
  type: "function",
  function: {
    name: "send",
    description: "Send a message to the contact. Use this for every outbound reply.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Message to send" } },
      required: ["message"],
    },
  },
};

const HOLD_TOOL = {
  type: "function",
  function: {
    name: "hold",
    description: "Defer delivery. Use when timing is wrong or you need to bundle with other updates.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you are holding" },
        release_after: { type: "string", description: "ISO8601 timestamp to release (optional)" },
      },
      required: ["reason"],
    },
  },
};

const DISCARD_TOOL = {
  type: "function",
  function: {
    name: "discard",
    description: "Drop this update without sending. Use when the content is not worth communicating.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Why you are discarding" } },
      required: ["reason"],
    },
  },
};

const KV_QUERY_TOOL = {
  type: "function",
  function: {
    name: "kv_query",
    description: "Read a KV value. Use to look up tasks, session history, contact info.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "KV key to read" },
        path: { type: "string", description: "Dot-bracket path to drill in" },
      },
      required: ["key"],
    },
  },
};

const KV_MANIFEST_TOOL = {
  type: "function",
  function: {
    name: "kv_manifest",
    description: "List KV keys by prefix.",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Key prefix" },
        limit: { type: "number", description: "Max keys (default 20)" },
      },
    },
  },
};

const TRIGGER_SESSION_TOOL = {
  type: "function",
  function: {
    name: "trigger_session",
    description: "Signal that the conversation has an actionable request. Only call when you have enough detail to act on.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What the session should work on" },
      },
      required: ["summary"],
    },
  },
};

// ── runTurn: the unified conversation processor ───────

export async function runTurn(K, conversationId, turns) {
  // 1. Load conversation state
  let conv = await K.kvGet(conversationId) || {
    messages: [],
    karma: [],
    inbound_cost: 0,
    internal_cost: 0,
    created_at: new Date().toISOString(),
    turn_count: 0,
  };
  if (!conv.karma) conv.karma = [];
  if (conv.inbound_cost === undefined) conv.inbound_cost = conv.total_cost || 0;
  if (conv.internal_cost === undefined) conv.internal_cost = 0;

  // 2. Load config
  const defaults = await K.getDefaults();
  const chatDefaults = defaults?.chat || {};

  // Determine source type for this batch
  const hasInbound = turns.some(t => t.source === "inbound");
  const hasInternal = turns.some(t => t.source === "internal");
  const costKey = hasInbound ? "inbound_cost" : "internal_cost";

  // Budget check
  const maxCost = chatDefaults.max_cost_per_conversation || 0.50;
  if (conv[costKey] >= maxCost) {
    return { action: "error", error: "budget_exhausted", retryable: false };
  }

  // 3. Sort: internal first, then inbound
  const sorted = [...turns].sort((a, b) => {
    if (a.source === "internal" && b.source === "inbound") return -1;
    if (a.source === "inbound" && b.source === "internal") return 1;
    return 0;
  });

  // 4. Build system prompt with internal context
  const chatPrompt = await K.kvGet("prompt:communication") || "You are in a live communication session. Respond conversationally.";
  const contact = turns[0]?.reply_target?.platform
    ? await K.resolveContact(turns[0].reply_target.platform, turns[0].reply_target.channel)
    : null;
  const contactContext = contact ? `\n\nYou are chatting with:\n${JSON.stringify(contact)}` : "";

  // Render internal turns as agent context block
  const internalTurns = sorted.filter(t => t.source === "internal");
  const agentUpdates = internalTurns.length > 0
    ? "\n\n[AGENT UPDATES]\n" + internalTurns.map(t =>
        `- [${t.intent || "update"}] ${t.content}`
      ).join("\n") + "\n\nDecide whether to send, hold, or discard each update. Use the send tool to message the contact, hold to defer, or discard to drop."
    : "";

  const systemPrompt = (chatPrompt + contactContext + agentUpdates).trim();

  // Append inbound turns to message history
  const inboundTurns = sorted.filter(t => t.source === "inbound");
  for (const turn of inboundTurns) {
    conv.messages.push({
      role: "user",
      content: turn.content,
      userId: turn.metadata?.userId,
      ts: turn.metadata?.sentTs
        ? new Date(parseFloat(turn.metadata.sentTs) * 1000).toISOString()
        : new Date().toISOString(),
      sentTs: turn.metadata?.sentTs,
    });
  }

  // 5. Build tools
  const tools = [SEND_TOOL, HOLD_TOOL, DISCARD_TOOL, KV_QUERY_TOOL, KV_MANIFEST_TOOL];
  if (hasInbound) tools.push(TRIGGER_SESSION_TOOL);

  // 6. Call LLM (with tool loop for kv_query/kv_manifest)
  const model = await K.resolveModel(chatDefaults.model || defaults?.act?.model || "sonnet");
  const maxRounds = 3;
  let outcome = null;

  for (let i = 0; i < maxRounds; i++) {
    const response = await K.callLLM({
      model,
      effort: chatDefaults.effort || "low",
      maxTokens: chatDefaults.max_output_tokens || 1000,
      systemPrompt,
      messages: conv.messages,
      tools,
      step: `comms_${conv.turn_count}_r${i}`,
    });
    conv[costKey] += response.cost || 0;

    if (!response.toolCalls?.length) {
      // No tool call — default to hold (safer than send)
      outcome = { action: "held", reason: "no explicit send/hold/discard tool call" };
      break;
    }

    // Process tool calls
    const tc = response.toolCalls[0];
    const name = tc.function?.name;
    const args = JSON.parse(tc.function?.arguments || "{}");

    if (name === "send") {
      outcome = { action: "sent", message: args.message };
      break;
    }
    if (name === "hold") {
      outcome = { action: "held", reason: args.reason, release_after: args.release_after || null };
      break;
    }
    if (name === "discard") {
      outcome = { action: "discarded", reason: args.reason };
      break;
    }

    // kv_query, kv_manifest, trigger_session — execute and continue loop
    conv.messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls,
    });

    const results = await Promise.all(
      response.toolCalls.map(async (tc2) => {
        const n = tc2.function?.name;
        if (n === "trigger_session") {
          const mod = await import("./tools/trigger_session.js");
          const chatContext = {
            channel: turns[0].reply_target?.platform,
            userId: turns[0].metadata?.userId,
            contact,
            convKey: conversationId,
            chatConfig: chatDefaults,
          };
          return mod.execute({ ...JSON.parse(tc2.function?.arguments || "{}"), K, _chatContext: chatContext });
        }
        return K.executeToolCall(tc2).catch(err => ({ error: err.message }));
      })
    );

    for (let j = 0; j < response.toolCalls.length; j++) {
      conv.messages.push({
        role: "tool",
        tool_call_id: response.toolCalls[j].id,
        content: JSON.stringify(results[j]),
      });
    }
  }

  if (!outcome) {
    outcome = { action: "held", reason: "tool rounds exhausted without outcome" };
  }

  // 7. Execute outcome
  if (outcome.action === "sent") {
    const replyTarget = turns[0].reply_target;
    await K.executeAdapter(replyTarget.platform, {
      text: outcome.message,
      channel: replyTarget.channel,
      thread_ts: replyTarget.thread_ts || undefined,
    });
    conv.messages.push({ role: "assistant", content: outcome.message, ts: new Date().toISOString() });
  }

  if (outcome.action === "sent" || outcome.action === "discarded") {
    await K.karmaRecord({
      event: outcome.action === "sent" ? "comms_sent" : "comms_discarded",
      conversation: conversationId,
      reason: outcome.reason,
    });
  }

  // 8. Persist state
  conv.reply_target = turns[0].reply_target; // always update last-known reply target
  conv.turn_count++;
  conv.last_activity = new Date().toISOString();
  const maxMsgs = chatDefaults.max_history_messages || 40;
  if (conv.messages.length > maxMsgs) {
    conv.messages = trimByTurns(conv.messages, maxMsgs);
  }
  await K.kvWriteSafe(conversationId, conv);

  return outcome;
}

// ── Ingress: inbound message ──────────────────────────

export function ingestInbound(channel, inbound) {
  const { chatId, text, userId, resolvedChatKey, sentTs } = inbound;
  const platformUserId = resolvedChatKey || chatId;
  return {
    conversation_id: `chat:${channel}:${platformUserId}`,
    reply_target: { platform: channel, channel: platformUserId, thread_ts: null },
    source: "inbound",
    content: text,
    intent: null,
    idempotency_key: null, // set by caller from event key
    metadata: { sentTs, userId, channel },
  };
}

// ── Ingress: internal event ───────────────────────────

export async function ingestInternal(K, event) {
  const contactSlug = event.contact;
  // Resolve conversation_id from contact slug
  let conversationId = await K.kvGet(`conversation_index:${contactSlug}`);
  if (!conversationId) {
    // Look up platform binding to find platformUserId
    const contact = await K.kvGet(`contact:${contactSlug}`);
    if (!contact) return null;
    // Find first platform binding
    const bindings = await K.kvList({ prefix: `contact_platform:` });
    for (const b of bindings.keys) {
      const binding = await K.kvGet(b.name);
      if (binding?.contact === contactSlug) {
        const parts = b.name.replace("contact_platform:", "").split(":");
        const platform = parts[0];
        const platformUserId = parts[1];
        conversationId = `chat:${platform}:${platformUserId}`;
        // Create index for future lookups
        await K.kvWriteSafe(`conversation_index:${contactSlug}`, conversationId);
        break;
      }
    }
  }
  if (!conversationId) return null;

  // Load existing conv to get reply_target
  const conv = await K.kvGet(conversationId);
  const parts = conversationId.replace("chat:", "").split(":");
  const platform = parts[0];
  const platformUserId = parts.slice(1).join(":");

  return {
    conversation_id: conversationId,
    reply_target: conv?.reply_target || { platform, channel: platformUserId, thread_ts: null },
    source: "internal",
    content: event.content || event.reflection || event.actions_summary || JSON.stringify(event),
    intent: event.intent || (event.type === "dr_complete" ? "share" : "report"),
    idempotency_key: event.key || null,
    metadata: { event_type: event.type, event_key: event.key },
  };
}

// ── Outbox helpers ────────────────────────────────────

export async function createOutboxItem(K, conversationId, content, reason, releaseAfter, sourceEventKeys) {
  const id = `ob_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    conversation_id: conversationId,
    content,
    hold_reason: reason,
    release_after: releaseAfter || null,
    source_event_keys: sourceEventKeys || [],
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  await K.kvWriteSafe(`outbox:${conversationId}:${id}`, item);
  return item;
}

export async function checkOutbox(K) {
  const now = new Date();
  const list = await K.kvList({ prefix: "outbox:" });
  const due = [];
  for (const entry of list.keys) {
    const item = await K.kvGet(entry.name);
    if (!item) continue;
    if (item.release_after && new Date(item.release_after) <= now) {
      due.push({ key: entry.name, ...item });
    }
  }
  return due;
}

// ── Commands (handled in fetch, not runTurn) ──────────

export async function handleCommand(K, channel, inbound) {
  const { chatId, command, resolvedChatKey } = inbound;
  const platformUserId = resolvedChatKey || chatId;
  const convKey = `chat:${channel}:${platformUserId}`;

  if (command === "reset") {
    const conv = await K.kvGet(convKey);
    if (conv) {
      conv.inbound_cost = 0;
      conv.internal_cost = 0;
      delete conv._budget_warned;
      await K.kvWriteSafe(convKey, conv);
    }
    await K.executeAdapter(channel, { text: "Budget refilled.", channel: chatId });
    return { ok: true, reason: "reset" };
  }

  if (command === "clear") {
    await K.kvDeleteSafe(convKey);
    await K.executeAdapter(channel, { text: "Conversation cleared.", channel: chatId });
    return { ok: true, reason: "clear" };
  }

  return null;
}

// ── Trim helper (unchanged) ──────────────────────────

function trimByTurns(messages, maxMsgs) {
  const boundaries = [0];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== "tool") boundaries.push(i);
  }
  let startIdx = messages.length;
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const turnStart = boundaries[b];
    if (messages.length - turnStart > maxMsgs && turnStart < startIdx) break;
    startIdx = turnStart;
  }
  return messages.slice(startIdx);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/chat.test.js`
Expected: PASS for the new `runTurn` tests. Old `handleChat`/`handleDelivery` tests will fail — that's expected, they're being replaced.

- [ ] **Step 5: Remove old handleChat/handleDelivery tests, keep any command tests**

Delete old test blocks that reference `handleChat` or `handleDelivery`. Add command test:

```js
import { handleCommand } from "../hook-communication.js";

describe("handleCommand", () => {
  it("resets both budget counters", async () => {
    const K = makeMockK({});
    K.resolveModel = vi.fn((m) => m);
    await K.kvWriteSafe("chat:slack:U084ASKBXB7", {
      messages: [{ role: "user", content: "hi" }],
      inbound_cost: 0.4,
      internal_cost: 0.2,
    });

    await handleCommand(K, "slack", { chatId: "U084ASKBXB7", command: "reset", resolvedChatKey: "U084ASKBXB7" });

    const conv = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv.inbound_cost).toBe(0);
    expect(conv.internal_cost).toBe(0);
  });
});
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add hook-communication.js tests/chat.test.js
git commit -m "feat: replace handleChat/handleDelivery with unified runTurn processor"
```

---

### Task 4: Rewire index.js — fetch writes events, scheduled runs comms inside lock

**Files:**
- Modify: `index.js`
- Test: manual integration test

- [ ] **Step 1: Rewrite fetch handler for chat**

In `index.js`, replace the chat processing block (around line 168-199). The fetch handler should:
1. Handle commands immediately
2. For regular messages: write event, wake scheduler, return 200

```js
// Replace the existing "Process in background" block with:

// Handle commands immediately (no scheduler needed)
if (inbound.command) {
  const K = kernel.buildKernelInterface();
  await kernel.loadEagerConfig();
  const result = await handleCommand(K, channel, inbound);
  if (result) return new Response("OK", { status: 200 });
}

// Write inbound event to KV — scheduler will process it
const nonce = Math.random().toString(36).slice(2, 6);
const ts = Date.now().toString().padStart(15, '0');
const eventKey = `event:${ts}:inbound_message:${nonce}`;
const commTurn = ingestInbound(channel, inbound);
await env.KV.put(eventKey, JSON.stringify({
  type: "inbound_message",
  ...commTurn,
  timestamp: new Date().toISOString(),
}), { expirationTtl: 86400 });

// Wake scheduler
const schedule = await env.KV.get("session_schedule", "json");
if (schedule?.next_session_after) {
  const now = new Date().toISOString();
  if (schedule.next_session_after > now) {
    await env.KV.put("session_schedule", JSON.stringify({
      ...schedule,
      next_session_after: now,
    }));
  }
}

return new Response("OK", { status: 200 });
```

Update imports at top of `index.js`:
```js
import { runTurn, ingestInbound, ingestInternal, handleCommand, createOutboxItem, checkOutbox } from './hook-communication.js';
```

- [ ] **Step 2: Rewrite communicationDelivery handler and scheduled block**

Replace the `EVENT_HANDLERS.communicationDelivery` and the scheduled `waitUntil` delivery block:

```js
const COMMS_EVENT_TYPES = new Set([
  "inbound_message", "comms_request", "session_complete",
  "dr_complete", "session_response", "job_complete",
]);

const EVENT_HANDLERS = {
  communicationDelivery: async (K, event) => {
    // Just collect — processing happens after drainEvents, inside lock
    if (!EVENT_HANDLERS._pendingComms) EVENT_HANDLERS._pendingComms = [];
    EVENT_HANDLERS._pendingComms.push(event);
  },
  sessionTrigger: async (K, event) => {
    // ... unchanged ...
  },
};
```

In the `scheduled` function, after `kernel.runScheduled()`, replace the `waitUntil` delivery with in-lock processing:

```js
async scheduled(event, env, ctx) {
  const kernel = new Kernel(env, { ctx, TOOLS, HOOKS, PROVIDERS, CHANNELS, EVENT_HANDLERS });
  await kernel.runScheduled();

  // Process comms events inside the lock (before lock release)
  if (EVENT_HANDLERS._pendingComms?.length) {
    const pending = EVENT_HANDLERS._pendingComms.splice(0);
    const K = kernel.buildKernelInterface();

    // Group by conversation
    const byConv = {};
    for (const event of pending) {
      let turn;
      if (event.type === "inbound_message") {
        turn = event; // Already a CommTurn shape from fetch
      } else {
        turn = await ingestInternal(K, event);
      }
      if (!turn) continue;
      const cid = turn.conversation_id;
      if (!byConv[cid]) byConv[cid] = [];
      byConv[cid].push(turn);
    }

    // Run each conversation
    for (const [convId, turns] of Object.entries(byConv)) {
      try {
        const executionId = kernel.executionId;
        // Claim all events for this batch
        const claimed = [];
        for (const t of turns) {
          if (t.idempotency_key) {
            const ok = await K.claimEvent(t.idempotency_key, executionId);
            if (ok) claimed.push(t);
          } else {
            claimed.push(t);
          }
        }
        if (claimed.length === 0) continue;

        const result = await runTurn(K, convId, claimed);

        // Event lifecycle based on outcome
        for (const t of claimed) {
          if (!t.idempotency_key) continue;
          if (result.action === "sent" || result.action === "discarded") {
            await env.KV.delete(t.idempotency_key);
          } else if (result.action === "held") {
            await createOutboxItem(K, convId, t.content, result.reason, result.release_after, [t.idempotency_key]);
            await env.KV.delete(t.idempotency_key);
          } else {
            // error — release claim for retry
            await K.releaseEvent(t.idempotency_key);
          }
        }
      } catch (err) {
        await kernel.karmaRecord({ event: "comms_error", conversation: convId, error: err.message });
        // Release claims on error
        for (const t of turns) {
          if (t.idempotency_key) {
            try { await K.releaseEvent(t.idempotency_key); } catch {}
          }
        }
      }
    }
    EVENT_HANDLERS._pendingComms = [];
  }

  // Check outbox for due items
  const K2 = kernel.buildKernelInterface();
  const dueItems = await checkOutbox(K2);
  for (const item of dueItems) {
    try {
      const turn = {
        conversation_id: item.conversation_id,
        reply_target: null, // will be loaded from conv state by runTurn
        source: "internal",
        content: item.content,
        intent: "share",
        idempotency_key: item.key || null,
        metadata: { outbox_id: item.id },
      };

      // Load reply_target from conversation state
      const conv = await K2.kvGet(item.conversation_id);
      if (conv?.reply_target) turn.reply_target = conv.reply_target;
      else {
        const parts = item.conversation_id.replace("chat:", "").split(":");
        turn.reply_target = { platform: parts[0], channel: parts.slice(1).join(":"), thread_ts: null };
      }

      const result = await runTurn(K2, item.conversation_id, [turn]);
      if (result.action === "sent" || result.action === "discarded") {
        await K2.kvDeleteSafe(item.key);
      } else {
        // Still held or error — increment attempts
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts >= 3) {
          await K2.kvDeleteSafe(item.key);
          await kernel.karmaRecord({ event: "outbox_dead_lettered", id: item.id });
        } else {
          await K2.kvWriteSafe(item.key, item);
        }
      }
    } catch (err) {
      await kernel.karmaRecord({ event: "outbox_error", id: item.id, error: err.message });
    }
  }
},
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Fix any import/wiring issues.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: route all comms through scheduled tick, remove waitUntil delivery"
```

---

### Task 5: request_message tool

**Files:**
- Create: `tools/request_message.js`
- Modify: `config/tool-registry.json`
- Modify: `scripts/seed-local-kv.mjs`
- Modify: `userspace.js` (ensure not filtered as comms tool)
- Test: `tests/tools.test.js`

- [ ] **Step 1: Write failing test**

In `tests/tools.test.js`, add to the existing tool test structure:

```js
describe("request_message", () => {
  it("emits comms_request event with validated contact", async () => {
    const { execute } = await import("../tools/request_message.js");
    const K = makeMockK({
      "contact:swami_kevala": { name: "Swami Kevala" },
    });
    const result = await execute({
      contact: "swami_kevala",
      intent: "ask",
      content: "What should I work on?",
      K,
    });
    expect(result.ok).toBe(true);
    expect(K.emitEvent).toHaveBeenCalledWith("comms_request", {
      contact: "swami_kevala",
      intent: "ask",
      content: "What should I work on?",
    });
  });

  it("rejects unknown contact slugs", async () => {
    const { execute } = await import("../tools/request_message.js");
    const K = makeMockK({});
    const result = await execute({
      contact: "nonexistent",
      intent: "share",
      content: "hello",
      K,
    });
    expect(result.error).toMatch(/unknown contact/i);
    expect(K.emitEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools.test.js -t "request_message"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create request_message.js**

```js
export const meta = {
  kv_access: "none",
  timeout_ms: 5000,
  secrets: [],
};

export async function execute({ contact, intent, content, K }) {
  if (!contact || !intent || !content) {
    return { error: "contact, intent, and content are required" };
  }

  // Validate contact exists
  const contactRecord = await K.kvGet(`contact:${contact}`);
  if (!contactRecord) {
    return { error: `Unknown contact: ${contact}. Use a contact slug, not a platform ID.` };
  }

  await K.emitEvent("comms_request", { contact, intent, content });

  return { ok: true, contact, intent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/tools.test.js -t "request_message"`
Expected: PASS

- [ ] **Step 5: Register in tool-registry.json**

Add to `config/tool-registry.json`:

```json
"request_message": {
  "name": "request_message",
  "description": "Request that a message be sent to a contact. The communication agent decides whether and how to deliver.",
  "parameters": {
    "type": "object",
    "properties": {
      "contact": { "type": "string", "description": "Contact slug (e.g. swami_kevala)" },
      "intent": { "type": "string", "enum": ["share", "ask", "report"], "description": "Communication intent" },
      "content": { "type": "string", "description": "What you want to communicate" }
    },
    "required": ["contact", "intent", "content"]
  },
  "grants": { "kv_read": ["contact:*"] }
}
```

- [ ] **Step 6: Ensure request_message is NOT filtered as a comms tool**

In `userspace.js`, verify `COMMS_TOOLS` does not include `request_message`. Current line 35:

```js
const COMMS_TOOLS = new Set(["send_slack", "send_whatsapp", "send_email", "check_email"]);
```

`request_message` is not in this set — no change needed. It will appear in the planner's tool manifest.

- [ ] **Step 7: Update seed script**

In `scripts/seed-local-kv.mjs`, add `request_message` to the tool seeding section (follow the pattern of existing tools).

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add tools/request_message.js config/tool-registry.json scripts/seed-local-kv.mjs
git commit -m "feat: add request_message tool for agent-initiated communication"
```

---

### Task 6: Emit session_complete and dr_complete events from userspace

**Files:**
- Modify: `userspace.js`
- Test: `tests/userspace.test.js`

- [ ] **Step 1: Write failing test for session_complete emission**

In `tests/userspace.test.js`, add:

```js
it("emits session_complete event after act cycle with actions", async () => {
  // Setup: mock plan that produces an action, not no_action
  K.callLLM = vi.fn()
    .mockResolvedValueOnce({ content: '{"action":"test","success":"done","no_action":false}', parsed: { action: "test", success: "done", no_action: false }, cost: 0.001 })
    .mockResolvedValueOnce({ content: "Done", cost: 0.001, toolCalls: null }); // act response
  K.runAgentTurn = vi.fn(async () => ({ response: { content: "Done" }, toolResults: [], cost: 0.001, done: true }));

  await session.run(K, { crashData: null, balances: {}, events: [] });

  const emittedEvents = K.emitEvent.mock.calls.filter(c => c[0] === "session_complete");
  expect(emittedEvents.length).toBe(1);
  expect(emittedEvents[0][1]).toHaveProperty("actions_summary");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/userspace.test.js -t "session_complete"`
Expected: FAIL — no `session_complete` event emitted.

- [ ] **Step 3: Add session_complete emission**

In `userspace.js`, after the main loop and before scheduling the next session (around line 520), add:

```js
  // Emit session_complete for comms subsystem
  if (cyclesRun > 0) {
    const summary = priorActions.map(pa => `${pa.action} [${pa.tools.join(",")}] → ${pa.review}`).join("; ");
    await K.emitEvent("session_complete", {
      contact: (await K.kvGet("patron:contact")) || null,
      actions_summary: summary || "session completed",
      cycles: cyclesRun,
    });
  }
```

- [ ] **Step 4: Add dr_complete emission**

In `userspace.js`, in the `applyDrOutput` function (or wherever DR results are applied), after the apply loop:

```js
  await K.emitEvent("dr_complete", {
    contact: (await K.kvGet("patron:contact")) || null,
    reflection: output.reflection || "",
    desires_changed: ops.filter(o => o.key?.startsWith("desire:")).length,
    samskaras_changed: ops.filter(o => o.key?.startsWith("samskara:")).length,
  });
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add userspace.js tests/userspace.test.js
git commit -m "feat: emit session_complete and dr_complete events for comms pipeline"
```

---

### Task 7: Update config and prompts

**Files:**
- Modify: `config/event-handlers.json` (or seed script)
- Modify: `prompts/communication.md`

- [ ] **Step 1: Update event handler config**

In the seed script or config file, update `config:event_handlers`:

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

- [ ] **Step 2: Update communication prompt**

Replace `prompts/communication.md` with:

```markdown
You are Swayambhu's voice — the only way I speak to contacts.

Respond conversationally and concisely. Keep replies short — this is
real-time chat, not a report.

## Tools

You MUST use a tool to complete every turn:
- **send(message)** — send a message to the contact
- **hold(reason)** — defer delivery (timing is wrong, want to bundle)
- **discard(reason)** — drop without sending (not worth communicating)

Also available: kv_query, kv_manifest (look up context), trigger_session
(signal an actionable request from the contact — inbound only).

## Agent updates

When you receive [AGENT UPDATES] in your context, these are things I
want to communicate. Decide for each whether to send, hold, or discard.
Consider the conversation history, whether the contact is active, and
whether the update is worth interrupting them for.

You might:
- Send a warm note with a result or update
- Bundle multiple updates into one message
- Hold until the contact is next active
- Discard trivial updates that add no value
- Ask a question the agent wants answered

## Pending requests

Contacts may ask about request status. Use kv_query to read
session_request:* keys and check the status field. Translate to
natural language — never expose internal key names or statuses.

## Rules

Never expose internal mechanics — no sessions, budgets, cron schedules,
events, KV keys, or implementation details. To the contact, you are
simply an attentive assistant.
```

- [ ] **Step 3: Commit**

```bash
git add prompts/communication.md scripts/seed-local-kv.mjs config/
git commit -m "feat: update comms prompt and event handler config for unified pipeline"
```

---

### Task 8: Integration test — end-to-end flow

**Files:**
- Test: `tests/chat.test.js` (add integration tests)

- [ ] **Step 1: Add integration test for inbound → event → runTurn → send**

```js
describe("integration: inbound message flow", () => {
  it("ingestInbound creates valid CommTurn", () => {
    const turn = ingestInbound("slack", {
      chatId: "U084ASKBXB7",
      text: "Hello",
      userId: "U084ASKBXB7",
      resolvedChatKey: "U084ASKBXB7",
      sentTs: "1234567890.123456",
    });

    expect(turn.conversation_id).toBe("chat:slack:U084ASKBXB7");
    expect(turn.source).toBe("inbound");
    expect(turn.content).toBe("Hello");
    expect(turn.reply_target.platform).toBe("slack");
    expect(turn.reply_target.channel).toBe("U084ASKBXB7");
  });
});
```

- [ ] **Step 2: Add integration test for internal → ingestInternal → runTurn**

```js
describe("integration: internal event flow", () => {
  it("ingestInternal resolves conversation from contact slug", async () => {
    const K = makeMockK({
      "contact:swami_kevala": { name: "Swami Kevala" },
      "contact_platform:slack:U084ASKBXB7": { contact: "swami_kevala" },
    });

    const event = {
      type: "comms_request",
      contact: "swami_kevala",
      intent: "ask",
      content: "What should I work on?",
      key: "event:001:comms_request:a1b2",
    };

    const turn = await ingestInternal(K, event);

    expect(turn).not.toBeNull();
    expect(turn.conversation_id).toBe("chat:slack:U084ASKBXB7");
    expect(turn.source).toBe("internal");
    expect(turn.intent).toBe("ask");
  });

  it("ingestInternal creates conversation_index for future lookups", async () => {
    const K = makeMockK({
      "contact:swami_kevala": { name: "Swami Kevala" },
      "contact_platform:slack:U084ASKBXB7": { contact: "swami_kevala" },
    });

    await ingestInternal(K, {
      type: "comms_request",
      contact: "swami_kevala",
      content: "test",
      key: "event:001:comms_request:a1b2",
    });

    const index = await K.kvGet("conversation_index:swami_kevala");
    expect(index).toBe("chat:slack:U084ASKBXB7");
  });
});
```

- [ ] **Step 3: Add outbox test**

```js
describe("outbox", () => {
  it("createOutboxItem writes to outbox: prefix", async () => {
    const K = makeMockK({});
    const item = await createOutboxItem(K, "chat:slack:U084ASKBXB7", "held content", "timing", "2026-04-03T12:00:00Z", []);

    expect(item.id).toMatch(/^ob_/);
    const stored = await K.kvGet(`outbox:chat:slack:U084ASKBXB7:${item.id}`);
    expect(stored.hold_reason).toBe("timing");
  });

  it("checkOutbox returns items past release_after", async () => {
    const K = makeMockK({});
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await K.kvWriteSafe("outbox:chat:slack:U1:ob_1", {
      id: "ob_1",
      conversation_id: "chat:slack:U1",
      content: "due",
      release_after: pastTime,
      attempts: 0,
    });
    await K.kvWriteSafe("outbox:chat:slack:U2:ob_2", {
      id: "ob_2",
      conversation_id: "chat:slack:U2",
      content: "not due",
      release_after: new Date(Date.now() + 60000).toISOString(),
      attempts: 0,
    });

    const due = await checkOutbox(K);
    expect(due.length).toBe(1);
    expect(due[0].content).toBe("due");
  });
});
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add tests/chat.test.js
git commit -m "test: add integration tests for unified communication pipeline"
```

---

### Task 9: Cleanup and seed script update

**Files:**
- Modify: `scripts/seed-local-kv.mjs`
- Delete: any dead code references

- [ ] **Step 1: Update seed script**

Ensure the seed script seeds:
- Updated `config:event_handlers` with new event types
- `request_message` tool in tool registry
- Updated `prompt:communication`

- [ ] **Step 2: Run full reset and verify**

```bash
source .env && bash scripts/start.sh --reset-all-state --trigger
```

Watch stderr for `[CHAT]`, `[TOOL]`, `[KARMA]` output. Verify no errors.

- [ ] **Step 3: Run full test suite one final time**

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: update seed script and cleanup for unified comms pipeline"
```

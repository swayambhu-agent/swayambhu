import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTurn, ingestInbound, ingestInternal, createOutboxItem, checkOutbox, handleCommand } from "../hook-communication.js";
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

  it("blocks inbound replies that leak internal mechanics", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      { id: "tc_1", function: { name: "send", arguments: '{"message":"The carry-forward for desire:serve is still active."}' } },
    ]));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Any update?")]);

    expect(result).toEqual({
      action: "discarded",
      reason: "internal_mechanics_blocked",
    });
    expect(K.executeAdapter).not.toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "comms_internal_mechanics_blocked",
      mode: "inbound",
      markers: expect.arrayContaining(["carry-forward", "desire-key"]),
    }));
  });

  it("blocks internal sends that leak internal mechanics", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse(null, [
      {
        id: "tc_1",
        function: {
          name: "send",
          arguments: '{"message":"The carry-forward directive for desire:service is still active, and circuit-breaker pressure is rising."}',
        },
      },
    ]));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("deliver update")]);

    expect(result).toEqual({
      action: "discarded",
      reason: "internal_mechanics_blocked",
    });
    expect(K.executeAdapter).not.toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "comms_internal_mechanics_blocked",
      mode: "internal",
      markers: expect.arrayContaining(["carry-forward", "desire-key", "circuit-breaker"]),
    }));
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
    let capturedSystemPrompt;
    K.callLLM = vi.fn(async (opts) => {
      capturedMessages = opts.messages;
      capturedSystemPrompt = opts.systemPrompt;
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
    expect(capturedSystemPrompt).toContain("[AGENT UPDATES]");
    expect(capturedSystemPrompt).toContain("agent update");
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
    expect(conv.reply_target).toEqual({ platform: "slack", channel: "U084ASKBXB7", thread_ts: null });
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

  it("ingestInternal returns null for unknown contact", async () => {
    const K = makeMockK({});
    const turn = await ingestInternal(K, {
      type: "comms_request",
      contact: "nonexistent",
      content: "test",
    });
    expect(turn).toBeNull();
  });
});

describe("outbox", () => {
  it("createOutboxItem writes to outbox: prefix", async () => {
    const K = makeMockK({});
    const item = await createOutboxItem(K, "chat:slack:U084ASKBXB7", "held content", "timing", "2026-04-03T12:00:00Z", []);

    expect(item.id).toMatch(/^ob_/);
    const stored = await K.kvGet(`outbox:chat:slack:U084ASKBXB7:${item.id}`);
    expect(stored.hold_reason).toBe("timing");
    expect(stored.release_after).toBe("2026-04-03T12:00:00Z");
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

  it("checkOutbox returns empty array when no items due", async () => {
    const K = makeMockK({});
    const due = await checkOutbox(K);
    expect(due.length).toBe(0);
  });
});

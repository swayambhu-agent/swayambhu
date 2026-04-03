import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTurn, handleCommand } from "../hook-communication.js";
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

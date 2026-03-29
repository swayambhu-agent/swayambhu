import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChat, handleDelivery } from "../hook-communication.js";
import { makeMockK } from "./helpers/mock-kernel.js";

function makeLLMResponse(content, toolCalls = null) {
  return { content, cost: 0.001, toolCalls: toolCalls || null, usage: {} };
}

describe("handleChat", () => {
  let K;

  beforeEach(() => {
    K = makeMockK({}, {
      defaults: {
        chat: {
          model: "sonnet",
          effort: "low",
          max_cost_per_conversation: 0.50,
          max_tool_rounds: 5,
          max_output_tokens: 1000,
          max_history_messages: 40,
        },
        act: { model: "sonnet" },
      },
    });
    K.resolveModel = vi.fn((m) => m);
    K.callLLM = vi.fn(async () => makeLLMResponse("Hello!"));
  });

  it("sends reply via K.executeAdapter", async () => {
    const result = await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    });

    expect(result.ok).toBe(true);
    expect(result.turn).toBe(1);
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "Hello!",
      channel: "123",
    }));
    expect(K.callLLM).toHaveBeenCalled();
  });

  it("does NOT emit event automatically — only trigger_session does", async () => {
    await handleChat(K, "slack", {
      chatId: "123", text: "Hello world", userId: "user1",
    });

    expect(K.emitEvent).not.toHaveBeenCalled();
  });

  it("trigger_session creates session_request KV key and emits session_request event", async () => {
    K.callLLM = vi.fn()
      .mockResolvedValueOnce({
        content: null,
        cost: 0.001,
        toolCalls: [{
          id: "tc_1",
          function: {
            name: "trigger_session",
            arguments: JSON.stringify({ summary: "Research Sadhguru topics" }),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "On it!", cost: 0.001 });

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

  it("persists conversation state across turns", async () => {
    // Turn 1
    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    });

    // Verify state was saved (find by key, not index — digest writes interleave)
    const findPut = (key) => K.kvWriteSafe.mock.calls.filter(([k]) => k === key);
    const saved1 = findPut("chat:slack:123");
    expect(saved1).toHaveLength(1);
    const conv = saved1[0][1];
    expect(conv.turn_count).toBe(1);
    expect(conv.messages).toHaveLength(2); // user + assistant

    // Turn 2: mock kvGet to return saved state
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:slack:123") return conv;
      if (key === "wisdom") return null;
      if (key === "prompt:communication") return null;
      return null;
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "How are you?", userId: "user1",
    });

    const saved2 = findPut("chat:slack:123");
    expect(saved2).toHaveLength(2);
    expect(saved2[1][1].turn_count).toBe(2);
    expect(saved2[1][1].messages).toHaveLength(4); // 2 user + 2 assistant
  });

  it("/reset refills budget but keeps messages", async () => {
    // Set up a conversation with some cost
    const existingConv = {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
      total_cost: 0.45,
      turn_count: 3,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:slack:123") return existingConv;
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "/reset", userId: "user1", command: "reset",
    });

    expect(result).toEqual({ ok: true, reason: "reset" });
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "Budget refilled. Conversation history preserved.",
      channel: "123",
    }));
    // Should save state with cost zeroed but messages kept
    const saved = K.kvWriteSafe.mock.calls[0][1];
    expect(saved.total_cost).toBe(0);
    expect(saved.messages).toHaveLength(2); // messages preserved
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("/clear wipes conversation state entirely", async () => {
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:slack:123") return {
        messages: [{ role: "user", content: "old" }],
        total_cost: 0.10,
        turn_count: 5,
      };
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "/clear", userId: "user1", command: "clear",
    });

    expect(result).toEqual({ ok: true, reason: "clear" });
    expect(K.kvDeleteSafe).toHaveBeenCalledWith("chat:slack:123");
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "Conversation cleared.",
      channel: "123",
    }));
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("budget limit stops conversation", async () => {
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:slack:123") return {
        messages: [],
        total_cost: 0.50, // at limit
        turn_count: 10,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "Hello", userId: "user1",
    });

    expect(result).toEqual({ ok: true, reason: "budget_exhausted" });
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "Budget reached. Send /reset to refill or /clear to start fresh.",
      channel: "123",
    }));
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("fallback reply when LLM returns no content", async () => {
    K.callLLM.mockResolvedValue(makeLLMResponse(null));

    await handleChat(K, "slack", {
      chatId: "123", text: "Hello", userId: "user1",
    });

    expect(K.executeAdapter).toHaveBeenCalledWith("slack", expect.objectContaining({
      text: "I'll look into this in my next session.",
    }));
  });

  it("history trimming works (sliding window)", async () => {
    // Set max to 4 messages for easy testing
    K.getDefaults.mockResolvedValue({
      chat: { max_history_messages: 4 },
      act: { model: "sonnet" },
    });

    // Start with 3 existing messages
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:slack:123") return {
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "reply1" },
          { role: "user", content: "msg2" },
        ],
        total_cost: 0,
        turn_count: 2,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      return null;
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "msg3", userId: "user1",
    });

    const saved = K.kvWriteSafe.mock.calls[0][1];
    // 3 existing + 1 user + 1 assistant = 5, trimmed to last 4
    expect(saved.messages).toHaveLength(4);
    // slice(-4) keeps: reply1, msg2, msg3, Hello!
    expect(saved.messages[0].content).toBe("reply1");
  });

  it("uses resolvedChatKey from adapter when present (e.g. Slack DMs)", async () => {
    await handleChat(K, "slack", {
      chatId: "D0ANXBBBWUQ", text: "Hi", userId: "U084ASKBXB7",
      resolvedChatKey: "U084ASKBXB7", // set by adapter.resolveChatKey
    });

    const saved = K.kvWriteSafe.mock.calls[0];
    expect(saved[0]).toBe("chat:slack:U084ASKBXB7");
  });

  it("falls back to chatId when resolvedChatKey is absent", async () => {
    await handleChat(K, "slack", {
      chatId: "C01234ABCDE", text: "Hi", userId: "U084ASKBXB7",
    });

    const saved = K.kvWriteSafe.mock.calls[0];
    expect(saved[0]).toBe("chat:slack:C01234ABCDE");
  });

  it("multiple conversations (different chatIds) are independent", async () => {
    // Chat 1
    await handleChat(K, "slack", {
      chatId: "aaa", text: "Hi from A", userId: "userA",
    });

    // Chat 2
    await handleChat(K, "slack", {
      chatId: "bbb", text: "Hi from B", userId: "userB",
    });

    // Verify different KV keys (find by key, not index)
    const findPut = (key) => K.kvWriteSafe.mock.calls.find(([k]) => k === key);
    const call1 = findPut("chat:slack:aaa");
    const call2 = findPut("chat:slack:bbb");
    expect(call1).toBeTruthy();
    expect(call2).toBeTruthy();

    // Each has independent message history
    expect(call1[1].messages[0].content).toBe("Hi from A");
    expect(call2[1].messages[0].content).toBe("Hi from B");
  });

  it("embeds karma in chat object", async () => {
    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    });

    const saved = K.kvWriteSafe.mock.calls[0][1];
    expect(saved.karma).toBeDefined();
    expect(Array.isArray(saved.karma)).toBe(true);
  });

  it("passes chat tools (kv_query, kv_manifest, trigger_session) to LLM", async () => {
    await handleChat(K, "slack", {
      chatId: "123", text: "Hello", userId: "user1",
    });

    const callArgs = K.callLLM.mock.calls[0][0];
    const toolNames = callArgs.tools.map(t => t.function.name);
    expect(toolNames).toContain("kv_query");
    expect(toolNames).toContain("kv_manifest");
    expect(toolNames).toContain("trigger_session");
    expect(toolNames).toHaveLength(3);
  });

  it("includes contact in system prompt when available", async () => {
    K.resolveContact = vi.fn(async (platform, userId) => {
      if (userId === "user1") return {
        id: "swami",
        name: "Swami",
        relationship: "patron",
        chat: { model: "haiku", effort: "low" },
        communication: "Inner circle.",
      };
      return null;
    });
    K.kvGet.mockImplementation(async (key) => {
      if (key === "prompt:communication") return "\n\nChat mode.";
      return null;
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    });

    const callArgs = K.callLLM.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("You are chatting with:");
    expect(callArgs.systemPrompt).toContain("Swami");
    // Contact chat config should override model
    expect(callArgs.model).toBe("haiku");
  });

  it("tracks cost from single LLM call", async () => {
    K.callLLM.mockResolvedValue({ content: "Hi", cost: 0.02, usage: {} });

    await handleChat(K, "slack", {
      chatId: "123", text: "Hello", userId: "user1",
    });

    const saved = K.kvWriteSafe.mock.calls[0][1];
    expect(saved.total_cost).toBeCloseTo(0.02);
  });

  describe("budget", () => {
    it("/reset clears warning flag", async () => {
      K.kvGet.mockImplementation(async (key) => {
        if (key === "chat:slack:123") return {
          messages: [{ role: "user", content: "Hi" }],
          total_cost: 0.45,
          turn_count: 5,
          _budget_warned: true,
          created_at: "2026-01-01T00:00:00.000Z",
        };
        return null;
      });

      await handleChat(K, "slack", {
        chatId: "123", text: "/reset", userId: "user1", command: "reset",
      });

      const saved = K.kvWriteSafe.mock.calls[0][1];
      expect(saved.total_cost).toBe(0);
      expect(saved._budget_warned).toBeUndefined();
    });
  });

  describe("contact karma tracking", () => {
    it("records inbound_unknown karma for unknown contacts", async () => {
      K.resolveContact = vi.fn(async () => null);

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "stranger",
      });

      expect(K.karmaRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "inbound_unknown",
          sender_id: "stranger",
          channel: "slack",
        })
      );
    });

    it("records inbound_unapproved karma for unapproved contacts", async () => {
      K.resolveContact = vi.fn(async () => ({
        name: "Alice",
        slug: "alice",
        approved: false,
      }));

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "alice_id",
      });

      expect(K.karmaRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "inbound_unapproved",
          sender_id: "alice_id",
          channel: "slack",
        })
      );
    });
  });
});

describe("handleDelivery", () => {
  it("groups events by contact and calls LLM", async () => {
    const K = makeMockK({
      "prompt:communication": "You are a communication system.",
      "chat:slack:U123": JSON.stringify({ messages: [] }),
    });
    K.resolveContact.mockResolvedValue({ name: "Test User", platform: "slack", approved: true });
    K.resolveModel.mockResolvedValue("test-model");
    K.callLLM = vi.fn(async () => ({ content: "Here are your results!" }));
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

    const events = [{ type: "work_complete", contact: "UNKNOWN", content: "test" }];
    const results = await handleDelivery(K, events);
    expect(results).toHaveLength(0);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "delivery_skipped",
      reason: "contact_not_found",
    }));
  });
});

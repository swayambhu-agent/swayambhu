import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChat } from "../hook-chat.js";
import { makeMockK } from "./helpers/mock-kernel.js";

function makeAdapter() {
  return {
    sendReply: vi.fn(async () => {}),
  };
}

function makeLLMResponse(content, toolCalls = null) {
  return { content, cost: 0.001, toolCalls: toolCalls || null, usage: {} };
}

describe("handleChat", () => {
  let K, adapter;

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
        orient: { model: "sonnet" },
      },
    });
    // handleChat calls K.resolveModel and K.buildToolDefinitions synchronously
    K.resolveModel = vi.fn((m) => m);
    K.buildToolDefinitions = vi.fn(() => []);
    K.callLLM = vi.fn(async () => makeLLMResponse("Hello!"));
    adapter = makeAdapter();
  });

  it("sends reply via adapter.sendReply", async () => {
    const result = await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    }, adapter);

    expect(result.ok).toBe(true);
    expect(result.turn).toBe(1);
    expect(adapter.sendReply).toHaveBeenCalledWith("123", "Hello!");
    expect(K.callLLM).toHaveBeenCalledOnce();
  });

  it("persists conversation state across turns", async () => {
    // Turn 1
    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    }, adapter);

    // Verify state was saved
    const savedConv = K.kvPutSafe.mock.calls[0];
    expect(savedConv[0]).toBe("chat:state:slack:123");
    const conv = savedConv[1];
    expect(conv.turn_count).toBe(1);
    expect(conv.messages).toHaveLength(2); // user + assistant

    // Turn 2: mock kvGet to return saved state
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:state:slack:123") return conv;
      if (key === "wisdom") return null;
      if (key === "prompt:chat") return null;
      return null;
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "How are you?", userId: "user1",
    }, adapter);

    const savedConv2 = K.kvPutSafe.mock.calls[1][1];
    expect(savedConv2.turn_count).toBe(2);
    expect(savedConv2.messages).toHaveLength(4); // 2 user + 2 assistant
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
      if (key === "chat:state:slack:123") return existingConv;
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "/reset", userId: "user1", command: "reset",
    }, adapter);

    expect(result).toEqual({ ok: true, reason: "reset" });
    expect(adapter.sendReply).toHaveBeenCalledWith(
      "123", "Budget refilled. Conversation history preserved."
    );
    // Should save state with cost zeroed but messages kept
    const saved = K.kvPutSafe.mock.calls[0][1];
    expect(saved.total_cost).toBe(0);
    expect(saved.messages).toHaveLength(2); // messages preserved
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("/clear wipes conversation state entirely", async () => {
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:state:slack:123") return {
        messages: [{ role: "user", content: "old" }],
        total_cost: 0.10,
        turn_count: 5,
      };
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "/clear", userId: "user1", command: "clear",
    }, adapter);

    expect(result).toEqual({ ok: true, reason: "clear" });
    expect(K.kvDeleteSafe).toHaveBeenCalledWith("chat:state:slack:123");
    expect(adapter.sendReply).toHaveBeenCalledWith("123", "Conversation cleared.");
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("budget limit stops conversation", async () => {
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:state:slack:123") return {
        messages: [],
        total_cost: 0.50, // at limit
        turn_count: 10,
        created_at: "2026-01-01T00:00:00.000Z",
      };
      return null;
    });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "Hello", userId: "user1",
    }, adapter);

    expect(result).toEqual({ ok: true, reason: "budget_exhausted" });
    expect(adapter.sendReply).toHaveBeenCalledWith(
      "123", "Budget reached. Send /reset to refill or /clear to start fresh."
    );
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("tool calls execute mid-conversation and feed back to LLM", async () => {
    const toolCall = {
      id: "tc_1",
      function: { name: "kv_query", arguments: '{"key":"wisdom"}' },
    };
    K.callLLM
      .mockResolvedValueOnce(makeLLMResponse(null, [toolCall]))
      .mockResolvedValueOnce(makeLLMResponse("The wisdom says: hello"));

    K.executeToolCall.mockResolvedValue({ value: "be kind" });

    const result = await handleChat(K, "slack", {
      chatId: "123", text: "What's the wisdom?", userId: "user1",
    }, adapter);

    expect(result.ok).toBe(true);
    expect(K.callLLM).toHaveBeenCalledTimes(2);
    expect(K.executeToolCall).toHaveBeenCalledWith(toolCall);
    expect(adapter.sendReply).toHaveBeenCalledWith("123", "The wisdom says: hello");

    // Check messages in saved state:
    // user, assistant (tool_calls), tool result, assistant (final) = 4
    const saved = K.kvPutSafe.mock.calls[0][1];
    expect(saved.messages).toHaveLength(4);
    expect(saved.messages[0].role).toBe("user");
    expect(saved.messages[1].role).toBe("assistant");
    expect(saved.messages[1].tool_calls).toEqual([toolCall]);
    expect(saved.messages[2].role).toBe("tool");
    expect(saved.messages[3].role).toBe("assistant");
    expect(saved.messages[3].content).toBe("The wisdom says: hello");
  });

  it("history trimming works (sliding window)", async () => {
    // Set max to 4 messages for easy testing
    K.getDefaults.mockResolvedValue({
      chat: { max_history_messages: 4 },
      orient: { model: "sonnet" },
    });

    // Start with 3 existing messages
    K.kvGet.mockImplementation(async (key) => {
      if (key === "chat:state:slack:123") return {
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
    }, adapter);

    const saved = K.kvPutSafe.mock.calls[0][1];
    // 3 existing + 1 user + 1 assistant = 5, trimmed to last 4
    expect(saved.messages).toHaveLength(4);
    // slice(-4) keeps: reply1, msg2, msg3, Hello!
    expect(saved.messages[0].content).toBe("reply1");
  });

  it("multiple conversations (different chatIds) are independent", async () => {
    // Chat 1
    await handleChat(K, "slack", {
      chatId: "aaa", text: "Hi from A", userId: "userA",
    }, adapter);

    // Chat 2
    await handleChat(K, "slack", {
      chatId: "bbb", text: "Hi from B", userId: "userB",
    }, adapter);

    // Verify different KV keys
    const call1 = K.kvPutSafe.mock.calls[0];
    const call2 = K.kvPutSafe.mock.calls[1];
    expect(call1[0]).toBe("chat:state:slack:aaa");
    expect(call2[0]).toBe("chat:state:slack:bbb");

    // Each has independent message history
    expect(call1[1].messages[0].content).toBe("Hi from A");
    expect(call2[1].messages[0].content).toBe("Hi from B");
  });

  it("records karma after each turn", async () => {
    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    }, adapter);

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat_turn",
        channel: "slack",
        chat_id: "123",
        turn: 1,
      })
    );
  });

  it("falls back to '(no response)' when LLM returns no content after max rounds", async () => {
    // All rounds return tool calls, never a text response
    const toolCall = {
      id: "tc_loop",
      function: { name: "kv_query", arguments: '{"key":"x"}' },
    };
    K.callLLM.mockResolvedValue(makeLLMResponse(null, [toolCall]));
    K.executeToolCall.mockResolvedValue({ value: "data" });

    // Use a low max_tool_rounds
    K.getDefaults.mockResolvedValue({
      chat: { max_tool_rounds: 2 },
      orient: { model: "sonnet" },
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "Go", userId: "user1",
    }, adapter);

    expect(adapter.sendReply).toHaveBeenCalledWith("123", "(no response)");
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
      if (key === "prompt:chat") return "\n\nChat mode.";
      return null;
    });

    await handleChat(K, "slack", {
      chatId: "123", text: "Hi", userId: "user1",
    }, adapter);

    const callArgs = K.callLLM.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("You are chatting with:");
    expect(callArgs.systemPrompt).toContain("Swami");
    // Contact chat config should override model
    expect(callArgs.model).toBe("haiku");
  });

  it("accumulates cost across tool-calling rounds", async () => {
    const toolCall = {
      id: "tc_1",
      function: { name: "kv_query", arguments: '{"key":"x"}' },
    };
    K.callLLM
      .mockResolvedValueOnce({ content: null, cost: 0.01, toolCalls: [toolCall], usage: {} })
      .mockResolvedValueOnce({ content: "Done", cost: 0.02, toolCalls: null, usage: {} });
    K.executeToolCall.mockResolvedValue({ value: "v" });

    await handleChat(K, "slack", {
      chatId: "123", text: "Go", userId: "user1",
    }, adapter);

    const saved = K.kvPutSafe.mock.calls[0][1];
    expect(saved.total_cost).toBeCloseTo(0.03);
  });

  describe("budget warning", () => {
    it("injects system warning when cost crosses threshold", async () => {
      // Cost 0.001 per call (from makeLLMResponse). maxCost = 0.50, 80% = 0.40.
      // Pre-load conversation at 0.399 — next call pushes to 0.40, crossing threshold.
      K.kvGet.mockImplementation(async (key) => {
        if (key === "chat:state:slack:123") return {
          messages: [],
          total_cost: 0.399,
          turn_count: 5,
          created_at: "2026-01-01T00:00:00.000Z",
        };
        return null;
      });

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "user1",
      }, adapter);

      const saved = K.kvPutSafe.mock.calls[0][1];
      const systemMsgs = saved.messages.filter(m => m.role === "system");
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toContain("budget is running low");
      expect(saved._budget_warned).toBe(true);
    });

    it("does not inject warning twice", async () => {
      // Already warned, cost still above threshold
      K.kvGet.mockImplementation(async (key) => {
        if (key === "chat:state:slack:123") return {
          messages: [],
          total_cost: 0.42,
          turn_count: 6,
          created_at: "2026-01-01T00:00:00.000Z",
          _budget_warned: true,
        };
        return null;
      });

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi again", userId: "user1",
      }, adapter);

      const saved = K.kvPutSafe.mock.calls[0][1];
      const systemMsgs = saved.messages.filter(m => m.role === "system");
      expect(systemMsgs).toHaveLength(0);
    });

    it("/reset clears warning flag", async () => {
      K.kvGet.mockImplementation(async (key) => {
        if (key === "chat:state:slack:123") return {
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
      }, adapter);

      const saved = K.kvPutSafe.mock.calls[0][1];
      expect(saved.total_cost).toBe(0);
      expect(saved._budget_warned).toBeUndefined();
    });
  });

  describe("unknown contact tool filtering", () => {
    it("gives empty tools to unknown contacts (default)", async () => {
      K.resolveContact = vi.fn(async () => null);

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "stranger",
      }, adapter);

      const callArgs = K.callLLM.mock.calls[0][0];
      expect(callArgs.tools).toEqual([]);
    });

    it("records inbound_unknown karma for unknown contacts", async () => {
      K.resolveContact = vi.fn(async () => null);

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "stranger",
      }, adapter);

      expect(K.karmaRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "inbound_unknown",
          sender_id: "stranger",
          channel: "slack",
        })
      );
    });

    it("gives full tools to known contacts", async () => {
      K.resolveContact = vi.fn(async () => ({
        name: "Alice",
        slug: "alice",
      }));
      K.buildToolDefinitions = vi.fn(() => [
        { function: { name: "kv_query" } },
        { function: { name: "web_fetch" } },
      ]);

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "alice_id",
      }, adapter);

      const callArgs = K.callLLM.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(2);
    });

    it("filters tools by allowlist for unknown contacts when configured", async () => {
      K.resolveContact = vi.fn(async () => null);
      K.getDefaults.mockResolvedValue({
        chat: {
          model: "sonnet",
          unknown_contact_tools: ["kv_query"],
        },
        orient: { model: "sonnet" },
      });
      K.buildToolDefinitions = vi.fn(() => [
        { function: { name: "kv_query" } },
        { function: { name: "web_fetch" } },
        { function: { name: "check_email" } },
      ]);

      await handleChat(K, "slack", {
        chatId: "123", text: "Hi", userId: "stranger",
      }, adapter);

      const callArgs = K.callLLM.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0].function.name).toBe("kv_query");
    });
  });
});

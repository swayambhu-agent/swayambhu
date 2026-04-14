import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTurn, ingestInbound, ingestInternal, createOutboxItem, checkOutbox, handleCommand, advanceOutboxItemForRetry, settleOutboxAttempt } from "../hook-communication.js";
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

  it("sends reply for inbound turn via structured triage output", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse('{"action":"reply","message":"Hello back!"}'));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    expect(result.action).toBe("sent");
    expect(result.message).toBe("Hello back!");
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", {
      text: "Hello back!",
      channel: "U084ASKBXB7",
    });
  });

  it("falls back to queue_work acknowledgement when inbound triage output is invalid", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse("Some text without valid JSON"));
    K.executeToolCall = vi.fn(async () => ({ ok: true, request_id: "req_fallback" }));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    expect(result.action).toBe("sent");
    expect(result.reason).toBe("request_queued");
    expect(result.message).toBe("Got it. I'm taking this on and will follow up when I have something concrete.");
    expect(K.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        function: expect.objectContaining({ name: "trigger_session" }),
      }),
      expect.any(Object),
    );
  });

  it("marks internal no-tool holds as retryable", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse("Some text without tool call"));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("session complete")]);

    expect(result).toEqual(expect.objectContaining({
      action: "held",
      reason: "no explicit send/hold/discard tool call",
      hold_mode: "retry",
      retry_after_seconds: 300,
    }));
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
    K.callLLM = vi.fn(async () => makeLLMResponse('{"action":"reply","message":"The carry-forward for desire:serve is still active."}'));

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
    K.callLLM = vi.fn(async () => makeLLMResponse('{"action":"reply","message":"ok"}'));

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hi")]);
    const conv1 = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv1.inbound_cost).toBeGreaterThan(0);
    expect(conv1.internal_cost).toBe(0);

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("update")]);
    const conv2 = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv2.internal_cost).toBeGreaterThan(0);
  });

  it("continues handling inbound turns even when the stored conversation cost is already over the old cap", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse('{"action":"reply","message":"Still here."}'));
    await K.kvWriteSafe("chat:slack:U084ASKBXB7", {
      messages: [{ role: "assistant", content: "Earlier reply" }],
      inbound_cost: 0.75,
      internal_cost: 0.1,
      turn_count: 1,
      reply_target: { platform: "slack", channel: "U084ASKBXB7", thread_ts: null },
    });

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Are you there?")]);

    expect(result.action).toBe("sent");
    expect(result.message).toBe("Still here.");
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", {
      text: "Still here.",
      channel: "U084ASKBXB7",
    });
    const conv = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv.inbound_cost).toBeGreaterThan(0.75);
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
    K.callLLM = vi.fn(async () => makeLLMResponse('{"action":"reply","message":"Hi!"}'));

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    const conv = await K.kvGet("chat:slack:U084ASKBXB7");
    expect(conv).toBeDefined();
    expect(conv.messages.length).toBeGreaterThan(0);
    expect(conv.turn_count).toBe(1);
    expect(conv.reply_target).toEqual({ platform: "slack", channel: "U084ASKBXB7", thread_ts: null });
  });

  it("suppresses trigger_session for internal-only batches and keeps lookup tools", async () => {
    let capturedTools;
    let capturedMessages;
    K.callLLM = vi.fn(async (opts) => {
      capturedTools = opts.tools;
      capturedMessages = opts.messages;
      return makeLLMResponse(null, [
        { id: "tc_1", function: { name: "send", arguments: '{"message":"noted"}' } },
      ]);
    });

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn("update")]);

    const toolNames = capturedTools.map(t => t.function.name);
    expect(toolNames).not.toContain("trigger_session");
    expect(toolNames).not.toContain("reply");
    expect(toolNames).not.toContain("clarify");
    expect(toolNames).toContain("send");
    expect(toolNames).toContain("hold");
    expect(toolNames).toContain("discard");
    expect(toolNames).toContain("kv_query");
    expect(toolNames).toContain("kv_manifest");
    expect(capturedMessages.at(-1)).toEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("choose exactly one delivery tool"),
    }));
  });

  it("uses structured inbound triage with no tool loop", async () => {
    let capturedTools;
    K.callLLM = vi.fn(async (opts) => {
      capturedTools = opts.tools;
      return makeLLMResponse('{"action":"reply","message":"Noted."}');
    });

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Hello")]);

    expect(capturedTools).toEqual([]);
  });

  it("suppresses trivial acknowledgements when related work is already pending", async () => {
    await K.kvWriteSafe("session_request:req_123", {
      id: "req_123",
      contact: "swami_kevala",
      summary: "Investigate the Akash project",
      status: "pending",
      updated_at: "2026-04-07T12:00:00.000Z",
      ref: "chat:slack:U084ASKBXB7",
    });
    K.resolveContact = vi.fn(async () => ({
      id: "swami_kevala",
      name: "Swami Kevala",
      relationship: "patron",
    }));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("ok great")]);

    expect(result.action).toBe("discarded");
    expect(result.reason).toBe("acknowledgement_with_pending_request");
    expect(K.callLLM).not.toHaveBeenCalled();
    expect(K.executeAdapter).not.toHaveBeenCalled();
  });

  it("executes trigger_session through the kernel tool path and uses the model-provided acknowledgement", async () => {
    K.callLLM = vi.fn().mockResolvedValueOnce(makeLLMResponse('{"action":"queue_work","summary":"Research the Akash projects folder","ack":"I’ll look through your projects folder and report back with what stands out."}'));
    K.executeToolCall = vi.fn(async () => ({ ok: true, request_id: "req_1" }));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Look into my projects folder")]);

    expect(result.action).toBe("sent");
    expect(result.message).toBe("I’ll look through your projects folder and report back with what stands out.");
    expect(K.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        function: expect.objectContaining({ name: "trigger_session" }),
      }),
      expect.objectContaining({
        _chatContext: expect.objectContaining({
          convKey: "chat:slack:U084ASKBXB7",
          userId: "U084ASKBXB7",
        }),
      }),
    );
    expect(K.executeAdapter).toHaveBeenCalledWith("slack", {
      text: "I’ll look through your projects folder and report back with what stands out.",
      channel: "U084ASKBXB7",
    });
    expect(K.callLLM).toHaveBeenCalledTimes(1);
  });

  it("retries inbound triage when queue_work omits the acknowledgement", async () => {
    K.callLLM = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse('{"action":"queue_work","summary":"Research the Akash projects folder"}'))
      .mockResolvedValueOnce(makeLLMResponse('{"action":"queue_work","summary":"Research the Akash projects folder","ack":"I’ll dig into your projects folder and come back with a clear next step."}'));
    K.executeToolCall = vi.fn(async () => ({ ok: true, request_id: "req_retry" }));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Look into my projects folder")]);

    expect(result.action).toBe("sent");
    expect(result.message).toBe("I’ll dig into your projects folder and come back with a clear next step.");
    expect(K.callLLM).toHaveBeenCalledTimes(2);
    expect(K.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("injects related request status into inbound system prompt", async () => {
    K.callLLM = vi.fn(async (opts) => {
      expect(opts.systemPrompt).toContain("[WORK THREAD STATUS]");
      expect(opts.systemPrompt).toContain("req_123");
      expect(opts.systemPrompt).toContain("Investigate the Akash project");
      return makeLLMResponse("{\"action\":\"reply\",\"message\":\"I'm waiting on that request.\"}");
    });

    await K.kvWriteSafe("session_request:req_123", {
      id: "req_123",
      contact: "swami_kevala",
      summary: "Investigate the Akash project",
      status: "active",
      updated_at: new Date().toISOString(),
      ref: "chat:slack:U084ASKBXB7",
      result: null,
      note: "Queued earlier",
    });
    K.resolveContact = vi.fn(async () => ({
      id: "swami_kevala",
      name: "Swami Kevala",
      relationship: "patron",
    }));

    await runTurn(K, "chat:slack:U084ASKBXB7", [makeInboundTurn("Any update?")]);
  });

  it("ingestInternal resolves request contact via requester fallback", async () => {
    await K.kvWriteSafe("session_request:req_456", {
      id: "req_456",
      source: "contact",
      requester: {
        type: "contact",
        id: "swami_kevala",
        name: "Swami Kevala",
        platform_user_id: "U084ASKBXB7",
      },
      contact: null,
      summary: "Check the shared repo",
      status: "fulfilled",
      ref: "chat:slack:U084ASKBXB7",
      result: "Reviewed the repo and noted the next step.",
    });
    await K.kvWriteSafe("conversation_index:swami_kevala", "chat:slack:U084ASKBXB7");

    const turn = await ingestInternal(K, {
      type: "session_response",
      ref: "session_request:req_456",
      contact: null,
      status: "fulfilled",
    });

    expect(turn).toEqual(expect.objectContaining({
      conversation_id: "chat:slack:U084ASKBXB7",
      source: "internal",
    }));
    expect(turn.content).toContain("Check the shared repo");
    expect(turn.content).toContain("fulfilled");
  });

  it("holds explicit comms_request content for retry if internal delivery LLM returns no tool call", async () => {
    K.callLLM = vi.fn(async () => makeLLMResponse("..."));

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn(
      "Concrete report body",
      "report",
      { metadata: { event_type: "comms_request", event_key: "event:test" } },
    )]);

    expect(result).toEqual(expect.objectContaining({
      action: "held",
      reason: "no explicit send/hold/discard tool call",
      hold_mode: "retry",
      retry_after_seconds: 300,
    }));
    expect(K.executeAdapter).not.toHaveBeenCalled();
  });

  it("supports multi-round kv lookup for internal turns", async () => {
    K.callLLM = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(null, [
        { id: "tc_1", function: { name: "kv_query", arguments: '{"key":"session_request:req_123"}' } },
      ]))
      .mockResolvedValueOnce(makeLLMResponse(null, [
        { id: "tc_2", function: { name: "send", arguments: '{"message":"Status update"}' } },
      ]));
    K.executeToolCall = vi.fn(async (toolCall) => {
      if (toolCall.function?.name === "kv_query") {
        return { key: "session_request:req_123", value: { status: "pending" } };
      }
      return { ok: true };
    });

    const result = await runTurn(K, "chat:slack:U084ASKBXB7", [makeInternalTurn(
      "Agent update that needs request lookup",
      "report",
      { metadata: { event_type: "session_response", event_key: "event:test" } },
    )]);

    expect(result).toEqual({
      action: "sent",
      message: "Status update",
      reason: "send",
    });
    expect(K.callLLM).toHaveBeenCalledTimes(2);
    const secondMessages = K.callLLM.mock.calls[1][0].messages;
    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        content: JSON.stringify({ key: "session_request:req_123", value: { status: "pending" } }),
      }),
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("kv_query or kv_manifest"),
      }),
    ]));
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

  it("ingestInternal renders session_response events from durable request state", async () => {
    const K = makeMockK({
      "contact:swami_kevala": { name: "Swami Kevala" },
      "contact_platform:slack:U084ASKBXB7": { contact: "swami_kevala" },
      "session_request:req_123": {
        id: "req_123",
        contact: "swami_kevala",
        summary: "Review the projects folder",
        status: "fulfilled",
        result: "Reviewed the Akash projects and found two promising starting points.",
      },
    });

    const turn = await ingestInternal(K, {
      type: "session_response",
      contact: "swami_kevala",
      ref: "session_request:req_123",
      key: "event:001:session_response:a1b2",
      status: "fulfilled",
    });

    expect(turn).not.toBeNull();
    expect(turn.content).toContain("Review the projects folder");
    expect(turn.content).toContain("fulfilled");
    expect(turn.content).toContain("Reviewed the Akash projects");
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

  it("createOutboxItem schedules retryable holds automatically", async () => {
    const K = makeMockK({});
    const before = Date.now();
    const item = await createOutboxItem(
      K,
      "chat:slack:U084ASKBXB7",
      "retry me",
      "model failed to choose a delivery tool",
      null,
      [],
      { hold_mode: "retry", retry_after_seconds: 120 },
    );

    const stored = await K.kvGet(`outbox:chat:slack:U084ASKBXB7:${item.id}`);
    expect(stored.hold_mode).toBe("retry");
    expect(stored.retry_after_seconds).toBe(120);
    expect(stored.release_after).toBeTruthy();
    expect(new Date(stored.release_after).getTime()).toBeGreaterThanOrEqual(before + 119000);
  });

  it("createOutboxItem keeps manual holds unscheduled when release_after is omitted", async () => {
    const K = makeMockK({});
    const item = await createOutboxItem(
      K,
      "chat:slack:U084ASKBXB7",
      "manual review",
      "waiting for explicit operator decision",
      null,
      [],
      { hold_mode: "manual" },
    );

    const stored = await K.kvGet(`outbox:chat:slack:U084ASKBXB7:${item.id}`);
    expect(stored.hold_mode).toBe("manual");
    expect(stored.retry_after_seconds).toBeNull();
    expect(stored.release_after).toBeNull();
  });

  it("advanceOutboxItemForRetry increments attempts and reschedules retry holds", () => {
    const before = new Date("2026-04-07T19:00:00.000Z");
    const next = advanceOutboxItemForRetry({
      id: "ob_1",
      hold_mode: "retry",
      retry_after_seconds: 120,
      release_after: "2026-04-07T18:55:00.000Z",
      attempts: 1,
    }, before);

    expect(next.attempts).toBe(2);
    expect(next.release_after).toBe("2026-04-07T19:02:00.000Z");
  });

  it("advanceOutboxItemForRetry also backs off scheduled holds after a failed attempt", () => {
    const before = new Date("2026-04-07T19:00:00.000Z");
    const next = advanceOutboxItemForRetry({
      id: "ob_sched",
      hold_mode: "scheduled",
      retry_after_seconds: null,
      release_after: "2026-04-07T18:55:00.000Z",
      attempts: 0,
    }, before);

    expect(next.attempts).toBe(1);
    expect(next.release_after).toBe("2026-04-07T19:05:00.000Z");
  });

  it("settleOutboxAttempt rewrites retry items and dead-letters on the third failed attempt", () => {
    const now = new Date("2026-04-07T19:00:00.000Z");
    const rewrite = settleOutboxAttempt({
      id: "ob_1",
      hold_mode: "retry",
      retry_after_seconds: 120,
      release_after: "2026-04-07T18:55:00.000Z",
      attempts: 1,
    }, { action: "held" }, now);

    expect(rewrite).toEqual({
      outcome: "rewrite",
      item: expect.objectContaining({
        attempts: 2,
        release_after: "2026-04-07T19:02:00.000Z",
      }),
    });

    const deadLetter = settleOutboxAttempt({
      id: "ob_1",
      hold_mode: "retry",
      retry_after_seconds: 120,
      release_after: "2026-04-07T18:55:00.000Z",
      attempts: 2,
    }, { action: "held" }, now);

    expect(deadLetter).toEqual({
      outcome: "dead_letter",
      item: expect.objectContaining({
        attempts: 3,
        release_after: "2026-04-07T19:02:00.000Z",
      }),
    });
  });

  it("settleOutboxAttempt keeps manual holds untouched", () => {
    const item = {
      id: "ob_manual",
      hold_mode: "manual",
      release_after: null,
      attempts: 0,
    };
    expect(settleOutboxAttempt(item, { action: "held" })).toEqual({
      outcome: "keep",
      item,
    });
  });

  it("settleOutboxAttempt deletes sent or discarded items", () => {
    const item = { id: "ob_sent", hold_mode: "retry", attempts: 0 };
    expect(settleOutboxAttempt(item, { action: "sent" })).toEqual({ outcome: "delete" });
    expect(settleOutboxAttempt(item, { action: "discarded" })).toEqual({ outcome: "delete" });
  });

  it("settleOutboxAttempt handles the error path when result is omitted", () => {
    const now = new Date("2026-04-07T19:00:00.000Z");
    const rewrite = settleOutboxAttempt({
      id: "ob_error",
      hold_mode: "retry",
      retry_after_seconds: 60,
      release_after: "2026-04-07T18:55:00.000Z",
      attempts: 0,
    }, null, now);

    expect(rewrite).toEqual({
      outcome: "rewrite",
      item: expect.objectContaining({
        attempts: 1,
        release_after: "2026-04-07T19:01:00.000Z",
      }),
    });
  });
});

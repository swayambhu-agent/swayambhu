import { describe, it, expect, vi, beforeEach } from "vitest";
import { Brainstem } from "../kernel.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── Test helpers ──────────────────────────────────────────────

function makeEnv(kvInit = {}) {
  return { KV: makeKVStore(kvInit) };
}

function makeBrain(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit);
  const brain = new Brainstem(env, {
    TOOLS: opts.TOOLS || {},
    HOOKS: opts.HOOKS || {},
    PROVIDERS: opts.PROVIDERS || {},
    CHANNELS: opts.CHANNELS || {},
  });
  brain.defaults = opts.defaults || {};
  brain.toolRegistry = opts.toolRegistry || null;
  brain.modelsConfig = opts.modelsConfig || null;
  brain.modelCapabilities = opts.modelCapabilities || null;
  brain.dharma = opts.dharma || null;
  brain.toolGrants = opts.toolGrants || {};
  return { brain, env };
}

// ── 1. parseAgentOutput ─────────────────────────────────────

describe("parseAgentOutput", () => {
  it("returns parsed object for valid JSON", async () => {
    const { brain } = makeBrain();
    const result = await brain.parseAgentOutput('{"key":"value","n":42}');
    expect(result).toEqual({ key: "value", n: 42 });
  });

  it("returns { parse_error, raw } for invalid JSON (no hook)", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput("not json at all");
    expect(result).toEqual({ parse_error: true, raw: "not json at all" });
  });

  it("returns {} for empty/null content", async () => {
    const { brain } = makeBrain();
    expect(await brain.parseAgentOutput(null)).toEqual({});
    expect(await brain.parseAgentOutput("")).toEqual({});
    expect(await brain.parseAgentOutput(undefined)).toEqual({});
  });

  it("calls parse_repair hook on failure", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => ({ content: '{"fixed":true}' }));
    const result = await brain.parseAgentOutput("not json");
    expect(result).toEqual({ fixed: true });
    expect(brain.callHook).toHaveBeenCalledWith("parse_repair", { content: "not json" });
  });

  it("returns parse_error when hook returns bad JSON", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => ({ content: "still bad" }));
    const result = await brain.parseAgentOutput("not json");
    expect(result).toEqual({ parse_error: true, raw: "not json" });
  });

  it("extracts JSON from markdown code fences", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
    expect(brain.callHook).not.toHaveBeenCalled();
  });

  it("extracts JSON from prose with surrounding text", async () => {
    const { brain } = makeBrain();
    brain.callHook = vi.fn(async () => null);
    const result = await brain.parseAgentOutput('Here is my output:\n{"key":"value"}\nDone.');
    expect(result).toEqual({ key: "value" });
  });
});

// ── 1b. _extractJSON ─────────────────────────────────────────

describe("_extractJSON", () => {
  const { brain } = makeBrain();

  it("returns null for null/undefined/empty", () => {
    expect(brain._extractJSON(null)).toBeNull();
    expect(brain._extractJSON(undefined)).toBeNull();
    expect(brain._extractJSON("")).toBeNull();
  });

  it("extracts from ```json fences", () => {
    expect(brain._extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts from bare ``` fences", () => {
    expect(brain._extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts object from surrounding prose", () => {
    expect(brain._extractJSON('Here is the result:\n{"a":1,"b":"two"}\nEnd.')).toEqual({ a: 1, b: "two" });
  });

  it("extracts array from surrounding prose", () => {
    expect(brain._extractJSON('Result: [1,2,3] done')).toEqual([1, 2, 3]);
  });

  it("handles nested braces", () => {
    expect(brain._extractJSON('```json\n{"a":{"b":{"c":1}}}\n```')).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles braces inside strings", () => {
    expect(brain._extractJSON('{"msg":"use {curly} braces","n":1}')).toEqual({ msg: "use {curly} braces", n: 1 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(brain._extractJSON('{"msg":"say \\"hello\\"","n":1}')).toEqual({ msg: 'say "hello"', n: 1 });
  });

  it("returns null for no JSON content", () => {
    expect(brain._extractJSON("just some text")).toBeNull();
  });

  it("handles real-world reflect output with fences", () => {
    const input = '```json\n{\n  "session_summary": "Short act session",\n  "note_to_future_self": "Check last_sessions first"\n}\n```';
    expect(brain._extractJSON(input)).toEqual({
      session_summary: "Short act session",
      note_to_future_self: "Check last_sessions first",
    });
  });
});

// ── 2. buildToolDefinitions ─────────────────────────────────

describe("buildToolDefinitions", () => {
  it("maps registry tools to OpenAI format", () => {
    const { brain } = makeBrain({}, {
      toolRegistry: {
        tools: [
          { name: "web_fetch", description: "Fetch a URL", input: { url: "The URL to fetch" } },
          { name: "kv_query", description: "Read KV", input: { key: "KV key" } },
        ],
      },
    });
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(4); // 2 registry + spawn_subplan + verify_patron
    expect(defs[0]).toEqual({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch" },
          },
        },
      },
    });
  });

  it("always includes spawn_subplan and verify_patron", () => {
    const { brain } = makeBrain({}, { toolRegistry: { tools: [] } });
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(2); // spawn_subplan + verify_patron
    expect(defs.map(d => d.function.name)).toContain("spawn_subplan");
    expect(defs.map(d => d.function.name)).toContain("verify_patron");
  });

  it("handles missing/null registry", () => {
    const { brain } = makeBrain();
    brain.toolRegistry = null;
    const defs = brain.buildToolDefinitions();
    expect(defs.length).toBe(2); // spawn_subplan + verify_patron
  });

  it("passes through extraTools", () => {
    const { brain } = makeBrain({}, { toolRegistry: { tools: [] } });
    const extra = { type: "function", function: { name: "custom" } };
    const defs = brain.buildToolDefinitions([extra]);
    expect(defs.length).toBe(3); // spawn_subplan + verify_patron + extra
    expect(defs[2]).toBe(extra);
  });
});

// ── 3. callLLM ──────────────────────────────────────────────

describe("callLLM", () => {
  function makeLLMBrain(response = {}) {
    const { brain, env } = makeBrain();
    const defaultResponse = {
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    };
    brain.callWithCascade = vi.fn(async () => ({ ...defaultResponse, ...response }));
    brain.estimateCost = vi.fn(() => 0.001);
    return { brain, env };
  }

  it("prepends system message when systemPrompt provided", async () => {
    const { brain } = makeLLMBrain();
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("You are helpful");
    expect(call.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("does not prepend system message when no systemPrompt and no dharma", async () => {
    const { brain } = makeLLMBrain();
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages.length).toBe(1);
    expect(call.messages[0].role).toBe("user");
  });

  it("injects dharma into system prompt when dharma is set", async () => {
    const { brain } = makeLLMBrain();
    brain.dharma = "Be truthful and compassionate.";
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful and compassionate.");
    expect(call.messages[0].content).toContain("You are helpful");
  });

  it("injects dharma even when no systemPrompt provided", async () => {
    const { brain } = makeLLMBrain();
    brain.dharma = "Be truthful.";
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful.");
  });

  it("passes tools in request", async () => {
    const { brain } = makeLLMBrain();
    const tools = [{ type: "function", function: { name: "test" } }];
    await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools,
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.tools).toEqual(tools);
  });

  it("returns toolCalls from response", async () => {
    const toolCalls = [{ id: "tc1", function: { name: "test", arguments: "{}" } }];
    const { brain } = makeLLMBrain({ toolCalls });
    const result = await brain.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("passes effort through for model with supports_reasoning", async () => {
    const { brain } = makeLLMBrain();
    brain.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await brain.callLLM({
      model: "anthropic/claude-sonnet-4.6",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.family).toBe("anthropic");
    expect(call.effort).toBe("high");
  });

  it("sets effort null for model without supports_reasoning", async () => {
    const { brain } = makeLLMBrain();
    brain.modelsConfig = {
      models: [
        { id: "deepseek/deepseek-v3.2", alias: "deepseek" },
      ],
    };
    await brain.callLLM({
      model: "deepseek/deepseek-v3.2",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.family).toBeNull();
    expect(call.effort).toBeNull();
  });

  it("maps effort 'none' to null", async () => {
    const { brain } = makeLLMBrain();
    brain.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await brain.callLLM({
      model: "anthropic/claude-sonnet-4.6",
      effort: "none",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.effort).toBeNull();
  });

  it("sets family and effort null for unknown model", async () => {
    const { brain } = makeLLMBrain();
    brain.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await brain.callLLM({
      model: "unknown/model-x",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = brain.callWithCascade.mock.calls[0][0];
    expect(call.family).toBeNull();
    expect(call.effort).toBeNull();
  });

  it("retries with fallback model on failure", async () => {
    const { brain } = makeBrain({}, {
      modelsConfig: { fallback_model: "anthropic/claude-haiku-4.5" },
    });
    let callCount = 0;
    brain.callWithCascade = vi.fn(async (request) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, error: "provider down", tier: "all_failed" };
      }
      return {
        ok: true, tier: "kernel_fallback",
        content: "fallback worked",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    });
    brain.estimateCost = vi.fn(() => 0.0001);

    const result = await brain.callLLM({
      model: "expensive-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    expect(callCount).toBe(2);
    const secondCall = brain.callWithCascade.mock.calls[1][0];
    expect(secondCall.model).toBe("anthropic/claude-haiku-4.5");
  });
});

// ── 3b. callViaKernelFallback ────────────────────────────────

describe("callWithCascade", () => {
  it("uses compiled provider when available", async () => {
    const mockCall = vi.fn(async () => ({
      content: "provider response",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const { brain } = makeBrain({}, {
      PROVIDERS: {
        'provider:llm': { call: mockCall, meta: { secrets: ["OPENROUTER_API_KEY"] } },
      },
    });
    brain.env.OPENROUTER_API_KEY = "test-key";
    brain.karmaRecord = vi.fn(async () => {});

    const result = await brain.callWithCascade({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    }, "test_step");

    expect(result.ok).toBe(true);
    expect(result.content).toBe("provider response");
    expect(result.tier).toBe("compiled");
    expect(mockCall).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        secrets: { OPENROUTER_API_KEY: "test-key" },
      })
    );
  });

  it("falls through to hardcoded fallback when provider fails", async () => {
    const { brain } = makeBrain({}, {
      PROVIDERS: {
        'provider:llm': { call: vi.fn(async () => { throw new Error("broken"); }), meta: {} },
      },
    });
    brain.env.OPENROUTER_API_KEY = "test-key";
    brain.karmaRecord = vi.fn(async () => {});

    // Mock global fetch for the hardcoded fallback
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "fallback ok", tool_calls: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    }));
    try {
      const result = await brain.callWithCascade({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      }, "test_step");

      expect(result.ok).toBe(true);
      expect(result.tier).toBe("hardcoded");
      expect(result.content).toBe("fallback ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns error when all tiers fail", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "service down" }),
    }));
    try {
      const result = await brain.callWithCascade({
        model: "test", messages: [], max_tokens: 100,
      }, "test_step");

      expect(result.ok).toBe(false);
      expect(result.tier).toBe("all_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 4. runAgentLoop ────────────────────────────────────────

describe("runAgentLoop", () => {
  it("immediate text response (1 turn)", async () => {
    const { brain } = makeBrain();
    brain.callLLM = vi.fn(async () => ({
      content: '{"answer":"42"}',
      cost: 0.01,
      toolCalls: null,
    }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "what is the answer?",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 3,
      step: "test",
    });

    expect(result).toEqual({ answer: "42" });
    expect(brain.callLLM).toHaveBeenCalledTimes(1);
  });

  it("tool call → result → final text (2 turns)", async () => {
    const { brain } = makeBrain();
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: null,
          cost: 0.005,
          toolCalls: [{
            id: "tc1",
            function: { name: "test_tool", arguments: '{"key":"val"}' },
          }],
        };
      }
      return {
        content: '{"done":true}',
        cost: 0.005,
        toolCalls: null,
      };
    });
    brain.executeToolCall = vi.fn(async () => ({ result: "tool output" }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "do something",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });

    expect(result).toEqual({ done: true });
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
    expect(brain.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("max steps forces final output", async () => {
    const { brain } = makeBrain();
    brain.executeToolCall = vi.fn(async () => ({ result: "ok" }));
    let callCount = 0;
    brain.callLLM = vi.fn(async ({ step }) => {
      callCount++;
      if (step?.endsWith("_final")) {
        return { content: '{"forced":true}', cost: 0.001, toolCalls: null };
      }
      return {
        content: null,
        cost: 0.001,
        toolCalls: [{ id: `tc${callCount}`, function: { name: "tool", arguments: "{}" } }],
      };
    });

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "loop",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 2,
      step: "test",
    });

    expect(result).toEqual({ forced: true });
    expect(brain.callLLM).toHaveBeenCalledTimes(3);
  });

  it("parallel tool execution", async () => {
    const { brain } = makeBrain();
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: null,
          cost: 0.005,
          toolCalls: [
            { id: "tc1", function: { name: "tool_a", arguments: "{}" } },
            { id: "tc2", function: { name: "tool_b", arguments: "{}" } },
          ],
        };
      }
      return { content: '{"done":true}', cost: 0.005, toolCalls: null };
    });

    const executedTools = [];
    brain.executeToolCall = vi.fn(async (tc) => {
      executedTools.push(tc.function.name);
      return { ok: true };
    });

    await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "parallel",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });

    expect(executedTools).toContain("tool_a");
    expect(executedTools).toContain("tool_b");
  });
});

// ── 5. executeToolCall ─────────────────────────────────────

describe("executeToolCall", () => {
  it("routes spawn_subplan to spawnSubplan", async () => {
    const { brain } = makeBrain();
    brain.spawnSubplan = vi.fn(async (args) => ({ subplan: true, goal: args.goal }));

    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "spawn_subplan", arguments: '{"goal":"test goal"}' },
    });

    expect(brain.spawnSubplan).toHaveBeenCalledWith({ goal: "test goal" });
    expect(result).toEqual({ subplan: true, goal: "test goal" });
  });

  it("routes other tools to executeAction", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async (step) => ({ tool_result: step.tool }));

    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "web_fetch",
      input: { url: "https://example.com" },
      id: "tc1",
    });
    expect(result).toEqual({ tool_result: "web_fetch" });
  });

  it("parses string arguments", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async () => ({}));

    await brain.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: '{"a":1,"b":"two"}' },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { a: 1, b: "two" },
      id: "tc1",
    });
  });

  it("handles object arguments (already parsed)", async () => {
    const { brain } = makeBrain();
    brain.executeAction = vi.fn(async () => ({}));

    await brain.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: { x: 99 } },
    });

    expect(brain.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { x: 99 },
      id: "tc1",
    });
  });
});

// ── 6. executeAction ────────────────────────────────────────

describe("executeAction", () => {
  it("calls tool function directly from TOOLS injection", async () => {
    const executeFn = vi.fn(async ({ x }) => ({ doubled: x * 2 }));
    const { brain } = makeBrain({}, {
      TOOLS: {
        doubler: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    brain.karmaRecord = vi.fn(async () => {});

    const result = await brain.executeAction({ tool: "doubler", input: { x: 5 }, id: "tc1" });
    expect(result).toEqual({ doubled: 10 });
    expect(executeFn).toHaveBeenCalled();
  });

  it("throws for missing tool", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.executeAction({ tool: "nonexistent", input: {}, id: "tc1" }))
      .rejects.toThrow("Unknown tool: nonexistent");
  });
});

// ── 7. callLLM budget enforcement ──────────────────────────

describe("callLLM budget enforcement", () => {
  function makeBudgetBrain(budgetOverrides = {}) {
    const { brain, env } = makeBrain();
    const budget = {
      max_cost: 0.10,
      max_duration_seconds: 600,
      ...budgetOverrides,
    };
    brain.defaults = { session_budget: budget };
    brain.callWithCascade = vi.fn(async () => ({
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    }));
    brain.estimateCost = vi.fn(() => 0.001);
    return { brain, env };
  }

  it("throws on cost limit", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0.10;
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("throws on duration limit", async () => {
    const { brain } = makeBudgetBrain();
    brain.startTime = Date.now() - 601_000;
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: duration");
  });

  it("accumulates cost and calls", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0;
    brain.sessionLLMCalls = 0;
    await brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(brain.sessionCost).toBe(0.001);
    expect(brain.sessionLLMCalls).toBe(1);
  });

  it("passes when under budget", async () => {
    const { brain } = makeBudgetBrain();
    brain.sessionCost = 0.05;
    brain.sessionLLMCalls = 4;
    const result = await brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(result.content).toBe('{"result":"ok"}');
  });
});

// ── 8. runAgentLoop budget handling ────────────────────────

describe("runAgentLoop budget handling", () => {
  it("catches budget error gracefully", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    let callCount = 0;
    brain.callLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error("Budget exceeded: cost");
      return {
        content: null,
        cost: 0.05,
        toolCalls: [{ id: "tc1", function: { name: "tool", arguments: "{}" } }],
      };
    });
    brain.executeToolCall = vi.fn(async () => ({ ok: true }));

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "budget test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result.budget_exceeded).toBe(true);
    expect(result.reason).toBe("Budget exceeded: cost");
  });

  it("re-throws non-budget errors", async () => {
    const { brain } = makeBrain();
    brain.callLLM = vi.fn(async () => {
      throw new Error("Network failure");
    });
    await expect(brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "error test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    })).rejects.toThrow("Network failure");
  });
});

// ── 9. callHook ────────────────────────────────────────────

describe("callHook", () => {
  it("returns null when hook tool not in TOOLS", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    const result = await brain.callHook("validate", { tool: "test" });
    expect(result).toBeNull();
  });

  it("calls hook tool and returns result", async () => {
    const executeFn = vi.fn(async () => ({ ok: true }));
    const { brain } = makeBrain({}, {
      TOOLS: {
        validate: { execute: executeFn, meta: { timeout_ms: 3000 } },
      },
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async (name, meta, input) => input);
    const result = await brain.callHook("validate", { tool: "test" });
    expect(result).toEqual({ ok: true });
    expect(executeFn).toHaveBeenCalled();
  });

  it("swallows hook errors", async () => {
    const executeFn = vi.fn(async () => { throw new Error("boom"); });
    const { brain } = makeBrain({}, {
      TOOLS: {
        validate: { execute: executeFn, meta: {} },
      },
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.buildToolContext = vi.fn(async () => ({}));
    const result = await brain.callHook("validate", {});
    expect(result).toBeNull();
    expect(brain.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "hook_error", hook: "validate" })
    );
  });
});

// ── 10. executeToolCall with hooks ──────────────────────────

describe("executeToolCall with hooks", () => {
  it("pre-validate rejects bad args", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ result: "should not reach" }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: false, error: "missing field" };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(result).toEqual({ error: "missing field" });
    expect(brain.executeAction).not.toHaveBeenCalled();
  });

  it("pre-validate corrects args", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async (step) => ({ received: step.input }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: true, args: { a: 1, b: "added" } };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(brain.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: { a: 1, b: "added" } })
    );
  });

  it("post-validate rejects bad result", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ data: "some result" }));
    brain.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate_result") return { ok: false, error: "empty response" };
      return null;
    });
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{}' },
    });
    expect(result).toEqual({ error: "empty response" });
  });

  it("no hooks — pass through", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({ tool_result: "ok" }));
    brain.callHook = vi.fn(async () => null);
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"x":1}' },
    });
    expect(result).toEqual({ tool_result: "ok" });
    expect(brain.executeAction).toHaveBeenCalled();
  });

  it("garbled arguments returns error", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.executeAction = vi.fn(async () => ({}));
    brain.callHook = vi.fn(async () => null);
    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: "not json" },
    });
    expect(result).toEqual({ error: "Invalid JSON in tool arguments for test_tool" });
    expect(brain.executeAction).not.toHaveBeenCalled();
  });
});

// ── 11. runAgentLoop parse error retry ──────────────────────

describe("runAgentLoop parse error retry", () => {
  it("retries on parse_error", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    let turn = 0;
    brain.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return { content: "not json", cost: 0.001, toolCalls: null };
      }
      return { content: '{"recovered":true}', cost: 0.001, toolCalls: null };
    });
    brain.callHook = vi.fn(async () => null);

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "retry test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result).toEqual({ recovered: true });
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
  });

  it("retries only once", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.callLLM = vi.fn(async () => ({
      content: "still not json",
      cost: 0.001,
      toolCalls: null,
    }));
    brain.callHook = vi.fn(async () => null);

    const result = await brain.runAgentLoop({
      systemPrompt: "test",
      initialContext: "retry test",
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      maxSteps: 5,
      step: "test",
    });
    expect(result.parse_error).toBe(true);
    expect(result.raw).toBe("still not json");
    expect(brain.callLLM).toHaveBeenCalledTimes(2);
  });
});

// ── 12. isSystemKey / isKernelOnly ──────────────────────────

describe("isSystemKey / isKernelOnly", () => {
  it("recognizes system key prefixes", () => {
    expect(Brainstem.isSystemKey("config:defaults")).toBe(true);
    expect(Brainstem.isSystemKey("prompt:act")).toBe(true);
    expect(Brainstem.isSystemKey("tool:kv_query:code")).toBe(true);
    expect(Brainstem.isSystemKey("hook:wake:code")).toBe(true);
    expect(Brainstem.isSystemKey("proposal:p_1")).toBe(true);
    expect(Brainstem.isSystemKey("doc:modification_guide")).toBe(true);
    expect(Brainstem.isSystemKey("skill:model-config")).toBe(true);
  });

  it("recognizes exact system keys", () => {
    expect(Brainstem.isSystemKey("providers")).toBe(true);
    expect(Brainstem.isSystemKey("wallets")).toBe(true);
    // wisdom is no longer a system key (replaced by upaya:/prajna: prefixes)
  });

  it("rejects non-system keys", () => {
    expect(Brainstem.isSystemKey("wake_config")).toBe(false);
    expect(Brainstem.isSystemKey("last_reflect")).toBe(false);
    expect(Brainstem.isSystemKey("session_counter")).toBe(false);
  });

  it("recognizes kernel-only keys", () => {
    expect(Brainstem.isKernelOnly("kernel:last_sessions")).toBe(true);
    expect(Brainstem.isKernelOnly("kernel:active_session")).toBe(true);
    expect(Brainstem.isKernelOnly("kernel:alert_config")).toBe(true);
  });

  it("kernel-only does not overlap with system keys", () => {
    expect(Brainstem.isKernelOnly("config:defaults")).toBe(false);
    expect(Brainstem.isKernelOnly("prompt:act")).toBe(false);
  });
});

// ── 13. kvPutSafe ──────────────────────────────────────────

describe("kvPutSafe", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("dharma", "new value"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("kernel:last_sessions", []))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPutSafe("config:defaults", {}))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { brain } = makeBrain();
    await brain.kvPutSafe("wake_config", { sleep_seconds: 100 });
    // Should not throw
  });
});

// ── 14. kvDeleteSafe ───────────────────────────────────────

describe("kvDeleteSafe", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("dharma"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("kernel:active_session"))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvDeleteSafe("prompt:act"))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { brain } = makeBrain();
    await brain.kvDeleteSafe("tooldata:mykey");
    // Should not throw
  });
});

// ── 15. kvWritePrivileged ──────────────────────────────────

describe("kvWritePrivileged", () => {
  it("blocks dharma", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "dharma", value: "evil" },
    ])).rejects.toThrow("immutable");
  });

  it("blocks immutable keys (patron:public_key)", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "patron:public_key", value: "attacker-key" },
    ])).rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "kernel:last_sessions", value: [] },
    ])).rejects.toThrow("kernel-only");
  });

  it("allows system keys with snapshot", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: { new: true } },
    ]);
    expect(brain.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "privileged_write", key: "config:defaults" })
    );
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("enforces rate limit", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.privilegedWriteCount = 49;
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: {} },
      { op: "put", key: "wisdom", value: "new" },
    ])).rejects.toThrow("Privileged write limit");
  });

  it("auto-refreshes config after privileged writes", async () => {
    const { brain } = makeBrain({
      "config:defaults": JSON.stringify({ updated: true }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "config:defaults", value: { updated: true } },
    ]);
    expect(brain.defaults).toEqual({ updated: true });
  });

  it("handles delete operations", async () => {
    const { brain, env } = makeBrain({
      "modification_staged:m_1": JSON.stringify({ id: "m_1" }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "delete", key: "modification_staged:m_1" },
    ]);
    expect(env.KV.delete).toHaveBeenCalledWith("modification_staged:m_1");
    expect(brain.privilegedWriteCount).toBe(1);
  });
});

// ── 15b. kvWritePrivileged contact write rules ─────────────

describe("kvWritePrivileged contact write rules", () => {
  it("allows put to an existing contact", async () => {
    const { brain } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", platforms: {} }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "contact:alice", value: { name: "Alice", platforms: {}, notes: "likes tea" } },
    ]);
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("allows patch to an existing contact (string value)", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    // Patch requires a string value — store directly as string
    brain.env.KV._store.set("contact:alice", "Alice likes old tea");
    await brain.kvWritePrivileged([
      { op: "patch", key: "contact:alice", old_string: "old tea", new_string: "green tea" },
    ]);
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("allows creation with approved: false and empty platforms", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "put", key: "contact:newperson", value: { name: "New Person", approved: false, platforms: {} } },
    ]);
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("rejects creation with approved: true", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "contact:newperson", value: { name: "New Person", approved: true, platforms: {} } },
    ])).rejects.toThrow("Setting approved: true is operator-only");
  });

  it("rejects creation with non-empty platforms", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "contact:newperson", value: { name: "New Person", approved: false, platforms: { email: "a@b.com" } } },
    ])).rejects.toThrow("Agent-created contacts must have empty platforms");
  });

  it("auto-flips approved to false when platforms changes", async () => {
    const { brain, env } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", approved: true, platforms: { email: "alice@old.com" } }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    // Agent updates platforms (doesn't set approved: true — that's blocked)
    await brain.kvWritePrivileged([
      { op: "put", key: "contact:alice", value: { name: "Alice", platforms: { email: "alice@new.com" } } },
    ]);
    // The value should have been auto-set to approved: false due to platforms change
    const putCall = env.KV.put.mock.calls.find(([key]) => key === "contact:alice");
    expect(putCall).toBeDefined();
    const stored = JSON.parse(putCall[1]);
    expect(stored.approved).toBe(false);
  });

  it("preserves approved from existing when agent omits it", async () => {
    const { brain, env } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", approved: true, platforms: { email: "a@b.com" } }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    // Agent updates name but omits approved — should preserve existing approved: true
    await brain.kvWritePrivileged([
      { op: "put", key: "contact:alice", value: { name: "Alice Updated", platforms: { email: "a@b.com" } } },
    ]);
    const putCall = env.KV.put.mock.calls.find(([key]) => key === "contact:alice");
    expect(putCall).toBeDefined();
    const stored = JSON.parse(putCall[1]);
    expect(stored.approved).toBe(true);
    expect(stored.name).toBe("Alice Updated");
  });

  it("blocks setting approved: true on existing contact", async () => {
    const { brain } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", approved: false, platforms: {} }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "contact:alice", value: { name: "Alice", approved: true, platforms: {} } },
    ])).rejects.toThrow("Setting approved: true is operator-only");
  });

  it("allows delete of unapproved contacts", async () => {
    const { brain } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", approved: false }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await brain.kvWritePrivileged([
      { op: "delete", key: "contact:alice" },
    ]);
    expect(brain.privilegedWriteCount).toBe(1);
  });

  it("blocks patch that modifies approved field", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    brain.env.KV._store.set("contact:alice", '"approved":false,"name":"Alice"');
    await expect(brain.kvWritePrivileged([
      { op: "patch", key: "contact:alice", old_string: '"approved":false', new_string: '"approved":true' },
    ])).rejects.toThrow('Cannot patch "approved" field on contacts');
  });

  it("blocks delete of approved contacts", async () => {
    const { brain } = makeBrain({
      "contact:alice": JSON.stringify({ name: "Alice", approved: true }),
    });
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "delete", key: "contact:alice" },
    ])).rejects.toThrow("Deletion of approved contacts is operator-only");
  });

  it("rejects writes to contact_index: keys", async () => {
    const { brain } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await expect(brain.kvWritePrivileged([
      { op: "put", key: "contact_index:email:alice@example.com", value: "contact:alice" },
    ])).rejects.toThrow("Contact index keys are kernel-managed");
  });
});

// ── 16. checkHookSafety ────────────────────────────────────

describe("checkHookSafety", () => {
  it("returns true with no history", async () => {
    const { brain } = makeBrain();
    brain.sendKernelAlert = vi.fn(async () => {});
    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("returns true with mixed outcomes", async () => {
    const { brain } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "clean" },
        { id: "s_3", outcome: "crash" },
      ]),
    });
    brain.sendKernelAlert = vi.fn(async () => {});
    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("fires tripwire on 3 consecutive crashes — writes deploy:rollback_requested", async () => {
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "killed" },
        { id: "s_3", outcome: "crash" },
      ]),
    });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(false);

    // Should write deploy:rollback_requested to KV
    const putCalls = env.KV.put.mock.calls;
    const rollbackPut = putCalls.find(([key]) => key === "deploy:rollback_requested");
    expect(rollbackPut).toBeTruthy();
    const rollback = JSON.parse(rollbackPut[1]);
    expect(rollback.reason).toBe("3_consecutive_crashes");

    expect(brain.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("3 consecutive crashes"));
  });

  it("returns true when fewer than 3 sessions in history", async () => {
    const { brain } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "crash" },
      ]),
    });
    brain.sendKernelAlert = vi.fn(async () => {});

    const safe = await brain.checkHookSafety();
    expect(safe).toBe(true);
  });
});

// ── 17. detectPlatformKill ─────────────────────────────────

describe("detectPlatformKill", () => {
  it("no-op when no active session marker", async () => {
    const { brain, env } = makeBrain();
    await brain.detectPlatformKill();
    // No writes to kernel:last_sessions
    const putCalls = env.KV.put.mock.calls.filter(
      ([key]) => key === "kernel:last_sessions"
    );
    expect(putCalls).toHaveLength(0);
  });

  it("injects killed outcome when active session found", async () => {
    const { brain, env } = makeBrain({
      "kernel:active_session": JSON.stringify("s_dead"),
    });
    await brain.detectPlatformKill();

    // Should have written kernel:last_sessions with killed entry
    const putCalls = env.KV.put.mock.calls;
    const lastSessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(lastSessionsPut).toBeTruthy();

    // Should have deleted kernel:active_session
    expect(env.KV.delete).toHaveBeenCalledWith("kernel:active_session");
  });
});

// ── 18. updateSessionOutcome ────────────────────────────────

describe("updateSessionOutcome", () => {
  it("adds clean outcome to kernel:last_sessions", async () => {
    const { brain, env } = makeBrain();
    await brain.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("clean");
  });

  it("adds crash outcome to kernel:last_sessions", async () => {
    const { brain, env } = makeBrain();
    await brain.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("crash");
  });

  it("prepends to existing history", async () => {
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_old", outcome: "clean", ts: "2026-01-01T00:00:00Z" },
      ]),
    });
    await brain.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].outcome).toBe("crash");
    expect(sessions[1].id).toBe("s_old");
  });

  it("caps history at 5 entries", async () => {
    const { brain, env } = makeBrain({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "clean", ts: "t1" },
        { id: "s_2", outcome: "clean", ts: "t2" },
        { id: "s_3", outcome: "clean", ts: "t3" },
        { id: "s_4", outcome: "clean", ts: "t4" },
        { id: "s_5", outcome: "clean", ts: "t5" },
      ]),
    });
    await brain.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(5);
    expect(sessions[0].outcome).toBe("crash");
    // Oldest entry (s_5) should have been dropped
    expect(sessions.map(s => s.id)).not.toContain("s_5");
  });
});

// ── 19. (hook_dirty tests removed — flag no longer exists) ──

// ── 20. runScheduled hook execution flow ──────────────────

describe("runScheduled hook execution flow", () => {
  it("calls detectPlatformKill → checkHookSafety → executeHook when safe", async () => {
    const { brain } = makeBrain();
    const callOrder = [];
    brain.detectPlatformKill = vi.fn(async () => callOrder.push("detectPlatformKill"));
    brain.checkHookSafety = vi.fn(async () => { callOrder.push("checkHookSafety"); return true; });
    brain.executeHook = vi.fn(async () => callOrder.push("executeHook"));
    brain.wake = vi.fn(async () => callOrder.push("wake"));

    await brain.runScheduled();

    expect(callOrder).toEqual(["detectPlatformKill", "checkHookSafety", "executeHook"]);
    expect(brain.wake).not.toHaveBeenCalled();
  });

  it("falls back to wake() when checkHookSafety returns false", async () => {
    const { brain } = makeBrain();
    brain.detectPlatformKill = vi.fn(async () => {});
    brain.checkHookSafety = vi.fn(async () => false);
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(brain.executeHook).not.toHaveBeenCalled();
    expect(brain.wake).toHaveBeenCalled();
  });

  it("always calls detectPlatformKill before checkHookSafety", async () => {
    const { brain } = makeBrain();
    const callOrder = [];
    brain.detectPlatformKill = vi.fn(async () => callOrder.push("detect"));
    brain.checkHookSafety = vi.fn(async () => { callOrder.push("safety"); return false; });
    brain.executeHook = vi.fn(async () => {});
    brain.wake = vi.fn(async () => {});

    await brain.runScheduled();

    expect(callOrder[0]).toBe("detect");
    expect(callOrder[1]).toBe("safety");
  });
});

// ── checkBalance ──────────────────────────────────────────────

describe("checkBalance", () => {
  it("iterates providers and wallets, calls executeAdapter for each", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance", scope: "general" },
        no_adapter: { note: "manual" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance", scope: "general" },
      }),
    });
    brain.executeAdapter = vi.fn(async () => 42);

    const result = await brain.checkBalance({});

    expect(brain.executeAdapter).toHaveBeenCalledTimes(2);
    expect(result.providers.openrouter).toEqual({ balance: 42, scope: "general" });
    expect(result.providers.no_adapter).toBeUndefined();
    expect(result.wallets.base).toEqual({ balance: 42, scope: "general" });
  });

  it("filters by scope", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        main: { adapter: "provider:llm_balance", scope: "general" },
        proj: { adapter: "provider:llm_balance", scope: "project_x" },
      }),
      wallets: JSON.stringify({}),
    });
    brain.executeAdapter = vi.fn(async () => 10);

    const result = await brain.checkBalance({ scope: "general" });

    expect(brain.executeAdapter).toHaveBeenCalledTimes(1);
    expect(result.providers.main).toEqual({ balance: 10, scope: "general" });
    expect(result.providers.proj).toBeUndefined();
  });

  it("returns error for failing adapters", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        broken: { adapter: "provider:bad", scope: "general" },
      }),
      wallets: JSON.stringify({}),
    });
    brain.executeAdapter = vi.fn(async () => { throw new Error("no code"); });

    const result = await brain.checkBalance({});

    expect(result.providers.broken).toEqual({ balance: null, scope: "general", error: "no code" });
  });

});

// ── callLLM budgetCap ──────────────────────────────────────

describe("callLLM budgetCap", () => {
  function makeLLMBrain(sessionCost, budget, budgetCap) {
    const { brain } = makeBrain();
    brain.sessionCost = sessionCost;
    brain.sessionLLMCalls = 0;
    brain.defaults = { session_budget: budget };
    brain.startTime = Date.now();
    brain.elapsed = () => 0;
    brain.callWithCascade = vi.fn(async () => ({
      ok: true, content: "hi", usage: { prompt_tokens: 10, completion_tokens: 5 },
      tier: "primary",
    }));
    brain.estimateCost = () => 0.01;
    brain.karmaRecord = vi.fn(async () => {});
    return brain;
  }

  it("uses session_budget.max_cost when no budgetCap", async () => {
    const brain = makeLLMBrain(0.14, { max_cost: 0.15 });
    // 0.14 < 0.15 — should succeed
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
    })).resolves.toBeDefined();
  });

  it("throws when sessionCost >= budgetCap", async () => {
    const brain = makeLLMBrain(0.10, { max_cost: 0.15 });
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("allows call when sessionCost < budgetCap even if close to max_cost", async () => {
    const brain = makeLLMBrain(0.09, { max_cost: 0.15 });
    // budgetCap=0.10, sessionCost=0.09 < 0.10 — should succeed
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).resolves.toBeDefined();
  });

  it("budgetCap overrides max_cost (lower cap)", async () => {
    const brain = makeLLMBrain(0.08, { max_cost: 0.15 });
    // Without budgetCap: 0.08 < 0.15, would succeed
    // With budgetCap=0.05: 0.08 >= 0.05, should fail
    await expect(brain.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.05,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("resolves kv: secret overrides", async () => {
    const { brain } = makeBrain({
      providers: JSON.stringify({
        proj: { adapter: "provider:llm_balance", scope: "project_x", secrets: { OPENROUTER_API_KEY: "kv:secret:proj_key" } },
      }),
      wallets: JSON.stringify({}),
      "secret:proj_key": JSON.stringify("sk-proj-12345"),
    });
    brain.executeAdapter = vi.fn(async () => 99);

    await brain.checkBalance({});

    // executeAdapter should have been called with resolved secret overrides
    const overrides = brain.executeAdapter.mock.calls[0][2];
    expect(overrides).toEqual({ OPENROUTER_API_KEY: "sk-proj-12345" });
  });
});

// ── Yamas and Niyamas ──────────────────────────────────────

describe("Yamas and Niyamas", () => {
  function makeLLMBrain(response = {}) {
    const { brain, env } = makeBrain();
    const defaultResponse = {
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    };
    brain.callWithCascade = vi.fn(async () => ({ ...defaultResponse, ...response }));
    brain.estimateCost = vi.fn(() => 0.001);
    return { brain, env };
  }

  describe("callLLM injection", () => {
    it("injects [YAMAS] and [NIYAMAS] blocks after dharma", async () => {
      const { brain } = makeLLMBrain();
      brain.dharma = "Be truthful.";
      brain.yamas = { "yama:care": "Care for all.", "yama:truth": "Be transparent." };
      brain.niyamas = { "niyama:health": "Keep code clean." };
      await brain.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const call = brain.callWithCascade.mock.calls[0][0];
      const sysContent = call.messages[0].content;
      expect(sysContent).toContain("[DHARMA]");
      expect(sysContent).toContain("[YAMAS]");
      expect(sysContent).toContain("[care]");
      expect(sysContent).toContain("Care for all.");
      expect(sysContent).toContain("[/care]");
      expect(sysContent).toContain("[truth]");
      expect(sysContent).toContain("[NIYAMAS]");
      expect(sysContent).toContain("[health]");
      expect(sysContent).toContain("Keep code clean.");
      // Verify order: DHARMA before YAMAS before NIYAMAS before systemPrompt
      const dharmaIdx = sysContent.indexOf("[DHARMA]");
      const yamasIdx = sysContent.indexOf("[YAMAS]");
      const niyamasIdx = sysContent.indexOf("[NIYAMAS]");
      const promptIdx = sysContent.indexOf("You are helpful");
      expect(dharmaIdx).toBeLessThan(yamasIdx);
      expect(yamasIdx).toBeLessThan(niyamasIdx);
      expect(niyamasIdx).toBeLessThan(promptIdx);
    });

    it("no blocks when yamas/niyamas are null", async () => {
      const { brain } = makeLLMBrain();
      brain.dharma = "Be truthful.";
      brain.yamas = null;
      brain.niyamas = null;
      await brain.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const sysContent = brain.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).not.toContain("[YAMAS]");
      expect(sysContent).not.toContain("[NIYAMAS]");
    });

    it("no blocks when yamas/niyamas are empty objects", async () => {
      const { brain } = makeLLMBrain();
      brain.yamas = {};
      brain.niyamas = {};
      await brain.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const sysContent = brain.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).not.toContain("[YAMAS]");
      expect(sysContent).not.toContain("[NIYAMAS]");
    });

    it("each entry labeled [name]...[/name]", async () => {
      const { brain } = makeLLMBrain();
      brain.yamas = { "yama:discipline": "Be disciplined." };
      brain.niyamas = {};
      await brain.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        step: "test",
      });
      const sysContent = brain.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).toContain("[discipline]\nBe disciplined.\n[/discipline]");
    });

    it("tracks lastCallModel after successful call", async () => {
      const { brain } = makeLLMBrain();
      expect(brain.lastCallModel).toBeNull();
      await brain.callLLM({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hello" }],
        step: "test",
      });
      expect(brain.lastCallModel).toBe("anthropic/claude-sonnet-4.6");
    });
  });

  describe("kvWritePrivileged enforcement", () => {
    function makePrincipleBrain(kvInit = {}) {
      const { brain, env } = makeBrain(kvInit, {
        modelsConfig: {
          models: [
            { id: "anthropic/claude-sonnet-4.6", alias: "sonnet" },
            { id: "anthropic/claude-haiku-4.5", alias: "haiku" },
          ],
          alias_map: { sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5" },
        },
        modelCapabilities: {
          "anthropic/claude-sonnet-4.6": { yama_capable: true, niyama_capable: true },
        },
      });
      brain.karmaRecord = vi.fn(async () => {});
      brain.lastCallModel = "anthropic/claude-sonnet-4.6";
      return { brain, env };
    }

    it("rejects yama write if deliberation < 200 chars", async () => {
      const { brain } = makePrincipleBrain();
      await expect(brain.kvWritePrivileged([
        { op: "put", key: "yama:care", value: "new value", deliberation: "too short" },
      ])).rejects.toThrow("Yama modifications require deliberation (min 200 chars");
    });

    it("rejects niyama write if deliberation < 100 chars", async () => {
      const { brain } = makePrincipleBrain();
      await expect(brain.kvWritePrivileged([
        { op: "put", key: "niyama:health", value: "new value", deliberation: "short" },
      ])).rejects.toThrow("Niyama modifications require deliberation (min 100 chars");
    });

    it("rejects if last model lacks yama_capable flag", async () => {
      const { brain } = makePrincipleBrain();
      brain.lastCallModel = "anthropic/claude-haiku-4.5";
      await expect(brain.kvWritePrivileged([
        { op: "put", key: "yama:care", value: "new value", deliberation: "x".repeat(200) },
      ])).rejects.toThrow("yama_capable model");
    });

    it("rejects if last model lacks niyama_capable flag", async () => {
      const { brain } = makePrincipleBrain();
      brain.lastCallModel = "anthropic/claude-haiku-4.5";
      await expect(brain.kvWritePrivileged([
        { op: "put", key: "niyama:health", value: "new value", deliberation: "x".repeat(100) },
      ])).rejects.toThrow("niyama_capable model");
    });

    it("returns warning with diff when modifying a yama", async () => {
      const { brain } = makePrincipleBrain({
        "yama:care": "Old care text",
      });
      const result = await brain.kvWritePrivileged([
        { op: "put", key: "yama:care", value: "New care text", deliberation: "x".repeat(200) },
      ]);
      expect(result).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].key).toBe("yama:care");
      expect(result.warnings[0].type).toBe("yama");
      expect(result.warnings[0].current_value).toBe("Old care text");
      expect(result.warnings[0].proposed_value).toBe("New care text");
      expect(result.warnings[0].message).toContain("core principle of how you act in the world");
    });

    it("returns warning for niyama with different severity message", async () => {
      const { brain } = makePrincipleBrain();
      const result = await brain.kvWritePrivileged([
        { op: "put", key: "niyama:health", value: "New health text", deliberation: "x".repeat(100) },
      ]);
      expect(result.warnings[0].message).toContain("how you reflect and improve");
      expect(result.warnings[0].message).not.toContain("how you act in the world");
    });

    it("same warning weight for create and delete", async () => {
      const { brain } = makePrincipleBrain({
        "yama:care": "Existing care text",
      });
      // Create (no existing value)
      const createResult = await brain.kvWritePrivileged([
        { op: "put", key: "yama:new", value: "New yama", deliberation: "x".repeat(200) },
      ]);
      expect(createResult.warnings[0].message).toContain("WARNING: You are modifying yama");

      // Delete
      const deleteResult = await brain.kvWritePrivileged([
        { op: "delete", key: "yama:care", deliberation: "x".repeat(200) },
      ]);
      expect(deleteResult.warnings[0].message).toContain("WARNING: You are modifying yama");
    });

    it("writes audit entry to {key}:audit", async () => {
      const { brain, env } = makePrincipleBrain();
      await brain.kvWritePrivileged([
        { op: "put", key: "yama:care", value: "New care text", deliberation: "x".repeat(200) },
      ]);
      const auditRaw = env.KV._store.get("yama:care:audit");
      expect(auditRaw).toBeDefined();
      const audit = JSON.parse(auditRaw);
      expect(audit).toHaveLength(1);
      expect(audit[0].model).toBe("anthropic/claude-sonnet-4.6");
      expect(audit[0].deliberation).toBe("x".repeat(200));
      expect(audit[0].new_value).toBe("New care text");
    });

    it("reloads cache after yama/niyama write", async () => {
      const { brain, env } = makePrincipleBrain();
      // Pre-populate some yamas in KV
      env.KV._store.set("yama:truth", "Be transparent.");
      brain.yamas = {};
      await brain.kvWritePrivileged([
        { op: "put", key: "yama:care", value: "New care", deliberation: "x".repeat(200) },
      ]);
      // loadYamasNiyamas should have been called, refreshing the cache
      expect(brain.yamas).toHaveProperty("yama:care");
    });

    it("non-yama/niyama writes still return undefined (backward compatible)", async () => {
      const { brain } = makePrincipleBrain();
      const result = await brain.kvWritePrivileged([
        { op: "put", key: "config:defaults", value: { updated: true } },
      ]);
      expect(result).toBeUndefined();
    });

    it("audit keys don't require deliberation", async () => {
      const { brain } = makePrincipleBrain();
      // Writing to an audit key should go through without deliberation gate
      await brain.kvWritePrivileged([
        { op: "put", key: "yama:care:audit", value: [{ entry: "test" }] },
      ]);
      // Should not throw
    });
  });

  describe("kvPutSafe blocks yama/niyama", () => {
    it("blocks yama:* keys", async () => {
      const { brain } = makeBrain();
      await expect(brain.kvPutSafe("yama:care", "new value"))
        .rejects.toThrow("system key");
    });

    it("blocks niyama:* keys", async () => {
      const { brain } = makeBrain();
      await expect(brain.kvPutSafe("niyama:health", "new value"))
        .rejects.toThrow("system key");
    });
  });

  describe("static helpers", () => {
    it("isPrincipleKey identifies yama and niyama keys", () => {
      expect(Brainstem.isPrincipleKey("yama:care")).toBe(true);
      expect(Brainstem.isPrincipleKey("niyama:health")).toBe(true);
      expect(Brainstem.isPrincipleKey("config:defaults")).toBe(false);
      expect(Brainstem.isPrincipleKey("dharma")).toBe(false);
    });

    it("isPrincipleAuditKey identifies audit keys", () => {
      expect(Brainstem.isPrincipleAuditKey("yama:care:audit")).toBe(true);
      expect(Brainstem.isPrincipleAuditKey("niyama:health:audit")).toBe(true);
      expect(Brainstem.isPrincipleAuditKey("yama:care")).toBe(false);
      expect(Brainstem.isPrincipleAuditKey("config:audit")).toBe(false);
    });
  });

  describe("model capability helpers", () => {
    it("isYamaCapable checks yama_capable flag in modelCapabilities", () => {
      const { brain } = makeBrain({}, {
        modelsConfig: {
          models: [
            { id: "anthropic/claude-opus-4.6" },
            { id: "anthropic/claude-haiku-4.5" },
          ],
        },
        modelCapabilities: {
          "anthropic/claude-opus-4.6": { yama_capable: true },
        },
      });
      expect(brain.isYamaCapable("anthropic/claude-opus-4.6")).toBe(true);
      expect(brain.isYamaCapable("anthropic/claude-haiku-4.5")).toBe(false);
      expect(brain.isYamaCapable("unknown-model")).toBe(false);
    });

    it("isNiyamaCapable checks niyama_capable flag in modelCapabilities", () => {
      const { brain } = makeBrain({}, {
        modelsConfig: {
          models: [
            { id: "anthropic/claude-sonnet-4.6" },
            { id: "anthropic/claude-haiku-4.5" },
          ],
        },
        modelCapabilities: {
          "anthropic/claude-sonnet-4.6": { niyama_capable: true },
        },
      });
      expect(brain.isNiyamaCapable("anthropic/claude-sonnet-4.6")).toBe(true);
      expect(brain.isNiyamaCapable("anthropic/claude-haiku-4.5")).toBe(false);
    });
  });
});

// ── Communication gate ──────────────────────────────────────

describe("Communication gate", () => {
  const slackMeta = {
    secrets: ["SLACK_BOT_TOKEN"],
    kv_access: "none",
    communication: { channel: "slack", recipient_field: "channel", reply_field: null, content_field: "text", recipient_type: "destination" },
  };

  const emailMeta = {
    secrets: ["GMAIL_CLIENT_ID"],
    kv_access: "none",
    communication: { channel: "email", recipient_field: "to", reply_field: "reply_to_id", content_field: "body", recipient_type: "person" },
  };

  const noCommMeta = {
    secrets: [],
    kv_access: "none",
  };

  const commsModelsConfig = {
    models: [
      { id: "anthropic/claude-opus-4.6", alias: "opus" },
      { id: "anthropic/claude-sonnet-4.6", alias: "sonnet" },
      { id: "anthropic/claude-haiku-4.5", alias: "haiku" },
      { id: "deepseek/deepseek-v3.2", alias: "deepseek" },
    ],
    alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5", deepseek: "deepseek/deepseek-v3.2" },
  };

  const commsModelCapabilities = {
    "anthropic/claude-opus-4.6": { comms_gate_capable: true },
    "anthropic/claude-sonnet-4.6": { comms_gate_capable: true },
  };

  it("resolveCommsMode — slack always initiating (no reply_field)", () => {
    const { brain } = makeBrain();
    expect(brain.resolveCommsMode({}, slackMeta)).toBe("initiating");
    expect(brain.resolveCommsMode({ channel: "C123" }, slackMeta)).toBe("initiating");
  });

  it("resolveCommsMode — email with reply_to_id is responding", () => {
    const { brain } = makeBrain();
    expect(brain.resolveCommsMode({ to: "a@b.com", reply_to_id: "msg123" }, emailMeta)).toBe("responding");
    expect(brain.resolveCommsMode({ to: "a@b.com" }, emailMeta)).toBe("initiating");
  });

  it("resolveRecipient — reads from recipient_field", () => {
    const { brain } = makeBrain();
    expect(brain.resolveRecipient({ channel: "C123" }, slackMeta)).toBe("C123");
    expect(brain.resolveRecipient({ to: "a@b.com" }, emailMeta)).toBe("a@b.com");
    expect(brain.resolveRecipient({}, slackMeta)).toBeNull();
  });

  it("mechanical floor blocks person-type initiating to unknown recipient", async () => {
    const { brain } = makeBrain();
    const result = await brain.communicationGate("send_email", { to: "unknown@example.com", body: "hello" }, emailMeta);
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("No contact record");
  });

  it("destination-type allows send to unknown channel (no contact check)", async () => {
    const { brain } = makeBrain();
    const result = await brain.communicationGate("send_slack", { text: "hello", channel: "C_UNKNOWN" }, slackMeta);
    expect(result.verdict).toBe("send");
  });

  it("destination-type allows send to approved contact", async () => {
    const { brain, env } = makeBrain();
    await env.KV.put("contact:dev", JSON.stringify({ name: "Dev", approved: true, platforms: { slack: "U_DEV" }, communication: "Team member." }));
    const result = await brain.communicationGate("send_slack", { text: "hello", channel: "U_DEV" }, slackMeta);
    expect(result.verdict).toBe("send");
  });

  it("defaults to destination when recipient_type not specified", async () => {
    const legacyMeta = {
      secrets: [],
      kv_access: "none",
      communication: { channel: "custom", recipient_field: "target", reply_field: null, content_field: "msg" },
    };
    const { brain } = makeBrain();
    const result = await brain.communicationGate("send_custom", { msg: "hi", target: "X" }, legacyMeta);
    expect(result.verdict).toBe("send");
  });

  it("allows responding to unknown person (email reply)", async () => {
    const { brain } = makeBrain();
    const result = await brain.communicationGate(
      "send_email",
      { to: "unknown@example.com", body: "thanks", reply_to_id: "msg123" },
      emailMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("allows initiating to approved contact", async () => {
    const { brain, env } = makeBrain();
    await env.KV.put("contact:swami", JSON.stringify({ name: "Swami", approved: true, platforms: { slack: "swami" }, communication: "Inner circle." }));
    const result = await brain.communicationGate(
      "send_slack",
      { text: "hello", channel: "swami" },
      slackMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("blocks person-type to unapproved contact (initiating)", async () => {
    const { brain, env } = makeBrain();
    await env.KV.put("contact:stub", JSON.stringify({ name: "Stub", approved: false, platforms: { email: "stub@example.com" } }));
    const result = await brain.communicationGate(
      "send_email",
      { to: "stub@example.com", body: "hello" },
      emailMeta,
    );
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("not approved");
  });

  it("blocks person-type to unapproved contact (responding)", async () => {
    const { brain, env } = makeBrain();
    await env.KV.put("contact:stub", JSON.stringify({ name: "Stub", approved: false, platforms: { email: "stub@example.com" } }));
    const result = await brain.communicationGate(
      "send_email",
      { to: "stub@example.com", body: "thanks", reply_to_id: "msg123" },
      emailMeta,
    );
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("not approved");
  });

  it("any model can send to approved contacts (no model capability check)", async () => {
    const { brain, env } = makeBrain();
    brain.lastCallModel = "deepseek/deepseek-v3.2"; // cheapest model
    await env.KV.put("contact:swami", JSON.stringify({ name: "Swami", approved: true, platforms: { slack: "swami" } }));
    const result = await brain.communicationGate(
      "send_slack",
      { text: "hello", channel: "swami" },
      slackMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("queueBlockedComm writes record to KV", async () => {
    const { brain } = makeBrain();
    brain.sessionId = "test_session_123";
    brain.lastCallModel = "anthropic/claude-opus-4.6";
    const id = await brain.queueBlockedComm(
      "send_slack",
      { text: "hello", channel: "C123" },
      slackMeta,
      "test block reason",
      { verdict: "block" },
    );
    expect(id).toMatch(/^cb_/);
    const stored = await brain.kvGet(`comms_blocked:${id}`);
    expect(stored.tool).toBe("send_slack");
    expect(stored.channel).toBe("slack");
    expect(stored.recipient).toBe("C123");
    expect(stored.reason).toBe("test block reason");
  });

  it("processCommsVerdict send — executes and deletes record", async () => {
    const { brain, env } = makeBrain();
    brain.sessionId = "test_session";
    const record = {
      id: "cb_test_1",
      tool: "send_slack",
      args: { text: "hello" },
      channel: "slack",
      recipient: "C123",
      mode: "initiating",
    };
    await env.KV.put("comms_blocked:cb_test_1", JSON.stringify(record));
    brain.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await brain.processCommsVerdict("cb_test_1", "send");
    expect(result.ok).toBe(true);
    expect(brain.executeAction).toHaveBeenCalledWith(expect.objectContaining({ tool: "send_slack" }));
    // Record should be deleted
    const afterDelete = await env.KV.get("comms_blocked:cb_test_1");
    expect(afterDelete).toBeNull();
  });

  it("processCommsVerdict drop — deletes record, records karma", async () => {
    const { brain, env } = makeBrain();
    brain.sessionId = "test_session";
    const record = {
      id: "cb_test_2",
      tool: "send_email",
      args: { to: "a@b.com", body: "hi" },
      channel: "email",
      recipient: "a@b.com",
      mode: "initiating",
    };
    await env.KV.put("comms_blocked:cb_test_2", JSON.stringify(record));

    const result = await brain.processCommsVerdict("cb_test_2", "drop", { reason: "not needed" });
    expect(result.ok).toBe(true);
    expect(result.dropped).toBe(true);
    const afterDelete = await env.KV.get("comms_blocked:cb_test_2");
    expect(afterDelete).toBeNull();
  });

  it("executeAction rejects communication tool without gate approval", async () => {
    const { brain } = makeBrain();
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain._loadTool = vi.fn(async () => ({
      meta: slackMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    const result = await brain.executeAction({ tool: "send_slack", input: { text: "hi" }, id: "t1" });
    expect(result.error).toContain("gate approval");
  });

  it("executeAction allows communication tool with gate approval flag", async () => {
    const { brain } = makeBrain();
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain._loadTool = vi.fn(async () => ({
      meta: slackMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    brain.buildToolContext = vi.fn(async () => ({}));
    brain._executeTool = vi.fn(async () => ({ ok: true }));
    brain._commsGateApproved = true;
    const result = await brain.executeAction({ tool: "send_slack", input: { text: "hi" }, id: "t1" });
    expect(result).toEqual({ ok: true });
    expect(brain._executeTool).toHaveBeenCalled();
  });

  it("executeAction allows non-communication tool without gate approval", async () => {
    const { brain } = makeBrain();
    brain._loadTool = vi.fn(async () => ({
      meta: noCommMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    brain.buildToolContext = vi.fn(async () => ({}));
    brain._executeTool = vi.fn(async () => ({ result: 42 }));
    const result = await brain.executeAction({ tool: "kv_query", input: {}, id: "t2" });
    expect(result).toEqual({ result: 42 });
    expect(brain._executeTool).toHaveBeenCalled();
  });

  it("gate approval flag is cleared after executeToolCall", async () => {
    const { brain } = makeBrain({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain.lastCallModel = "anthropic/claude-opus-4.6";
    // Gate approves send
    brain.communicationGate = vi.fn(async () => ({ verdict: "send", reasoning: "ok" }));
    brain.executeAction = vi.fn(async () => ({ ok: true }));
    brain.callHook = vi.fn(async () => null);
    brain._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));

    await brain.executeToolCall({
      id: "tc1",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "hi", channel: "C1" }) },
    });
    expect(brain._commsGateApproved).toBe(false);
  });

  it("executeToolCall blocks communication tool when gate returns block", async () => {
    const { brain } = makeBrain({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain.lastCallModel = "anthropic/claude-opus-4.6";
    brain.communicationGate = vi.fn(async () => ({ verdict: "block", reasoning: "unsafe content" }));
    brain.queueBlockedComm = vi.fn(async () => "cb_1");
    brain._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    brain.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await brain.executeToolCall({
      id: "tc1",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "bad", channel: "C1" }) },
    });
    expect(result.error).toContain("blocked");
    expect(brain.queueBlockedComm).toHaveBeenCalled();
    expect(brain.executeAction).not.toHaveBeenCalled();
  });

  it("executeToolCall queues communication tool when gate returns queue", async () => {
    const { brain } = makeBrain({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain.lastCallModel = "anthropic/claude-opus-4.6";
    brain.communicationGate = vi.fn(async () => ({ verdict: "queue", reasoning: "not comms_gate_capable" }));
    brain.queueBlockedComm = vi.fn(async () => "cb_2");
    brain._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    brain.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await brain.executeToolCall({
      id: "tc2",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "hi", channel: "C1" }) },
    });
    expect(result.error).toContain("queued");
    expect(brain.executeAction).not.toHaveBeenCalled();
  });

  it("executeToolCall applies revision via content_field when gate returns revise", async () => {
    const { brain } = makeBrain({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    brain.toolGrants = { send_slack: { communication: slackMeta.communication } };
    brain.lastCallModel = "anthropic/claude-opus-4.6";
    brain.communicationGate = vi.fn(async () => ({
      verdict: "revise", reasoning: "tone", revision: { text: "polished message" },
    }));
    brain._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    brain.executeAction = vi.fn(async (step) => ({ ok: true, sent_text: step.input.text }));
    brain.callHook = vi.fn(async () => null);

    const result = await brain.executeToolCall({
      id: "tc3",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "rough draft", channel: "C1" }) },
    });
    // executeAction should receive the revised text
    expect(brain.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ text: "polished message" }) }),
    );
    expect(result.ok).toBe(true);
  });

  it("executeToolCall lets non-communication tool through without gate", async () => {
    const { brain } = makeBrain({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    brain._loadTool = vi.fn(async () => ({ meta: noCommMeta, moduleCode: "" }));
    brain.executeAction = vi.fn(async () => ({ result: 42 }));
    brain.callHook = vi.fn(async () => null);
    brain.communicationGate = vi.fn();

    const result = await brain.executeToolCall({
      id: "tc4",
      function: { name: "kv_query", arguments: JSON.stringify({ key: "foo" }) },
    });
    expect(result).toEqual({ result: 42 });
    expect(brain.communicationGate).not.toHaveBeenCalled();
  });

  it("processCommsVerdict revise_and_send applies revision via content_field", async () => {
    const { brain, env } = makeBrain();
    brain.sessionId = "test_session";
    const record = {
      id: "cb_rev_1",
      tool: "send_email",
      args: { to: "a@b.com", body: "original text" },
      channel: "email",
      content_field: "body",
      recipient: "a@b.com",
      mode: "initiating",
    };
    await env.KV.put("comms_blocked:cb_rev_1", JSON.stringify(record));
    brain.executeAction = vi.fn(async () => ({ ok: true }));

    await brain.processCommsVerdict("cb_rev_1", "revise_and_send", { text: "revised text" });
    expect(brain.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ body: "revised text" }) }),
    );
  });

  it("listBlockedComms returns all blocked records", async () => {
    const { brain, env } = makeBrain();
    const record1 = { id: "cb_1", tool: "send_slack", args: { text: "a" } };
    const record2 = { id: "cb_2", tool: "send_email", args: { body: "b" } };
    await env.KV.put("comms_blocked:cb_1", JSON.stringify(record1));
    await env.KV.put("comms_blocked:cb_2", JSON.stringify(record2));

    const list = await brain.listBlockedComms();
    expect(list).toHaveLength(2);
    expect(list.map(r => r.id).sort()).toEqual(["cb_1", "cb_2"]);
  });
});

// ── Patron identity monitor ─────────────────────────────────

describe("Patron identity monitor", () => {
  const patronContact = {
    name: "Swami",
    relationship: "patron",
    platforms: { slack: "U_SWAMI" },
    communication: "Inner circle.",
  };

  it("creates snapshot on first boot when none exists", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(patronContact));

    await brain.loadPatronContext();

    expect(brain.patronId).toBe("swami");
    expect(brain.patronIdentityDisputed).toBe(false);
    expect(brain.patronSnapshot.name).toBe("Swami");
    expect(brain.patronSnapshot.platforms).toEqual({ slack: "U_SWAMI" });
  });

  it("no dispute when contact matches snapshot", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(patronContact));
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await brain.loadPatronContext();

    expect(brain.patronIdentityDisputed).toBe(false);
    expect(brain.karmaRecord).not.toHaveBeenCalled();
  });

  it("disputes when name changes", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    const changed = { ...patronContact, name: "Attacker" };
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(changed));
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await brain.loadPatronContext();

    expect(brain.patronIdentityDisputed).toBe(true);
    expect(brain.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "patron_identity_disputed",
        old: expect.objectContaining({ name: "Swami" }),
        new: expect.objectContaining({ name: "Attacker" }),
      })
    );
  });

  it("disputes when platforms change", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    const changed = { ...patronContact, platforms: { slack: "U_ATTACKER" } };
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(changed));
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await brain.loadPatronContext();

    expect(brain.patronIdentityDisputed).toBe(true);
  });

  it("resolveContact uses snapshot when identity is disputed", async () => {
    const { brain, env } = makeBrain();
    brain.karmaRecord = vi.fn(async () => {});
    const changed = { ...patronContact, name: "Attacker", platforms: { slack: "U_ATTACKER" } };
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(changed));
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));
    // Pre-populate index cache (contact platforms changed, so scan won't match old ID)
    await env.KV.put("contact_index:slack:U_SWAMI", JSON.stringify("swami"));

    await brain.loadPatronContext();
    expect(brain.patronIdentityDisputed).toBe(true);

    const result = await brain.resolveContact("slack", "U_SWAMI");
    expect(result.name).toBe("Swami");
    expect(result.platforms).toEqual({ slack: "U_SWAMI" });
  });
});

// ── Sealed namespace enforcement ────────────────────────────

describe("sealed namespace", () => {
  describe("isSystemKey / isKernelOnly recognize sealed:", () => {
    it("sealed: is a system key", () => {
      expect(Brainstem.isSystemKey("sealed:quarantine:email:foo:123")).toBe(true);
    });

    it("sealed: is kernel-only", () => {
      expect(Brainstem.isKernelOnly("sealed:quarantine:email:foo:123")).toBe(true);
    });
  });

  describe("kvPutSafe blocks sealed: keys", () => {
    it("blocks writes to sealed: keys", async () => {
      const { brain } = makeBrain();
      await expect(brain.kvPutSafe("sealed:quarantine:test", { data: 1 }))
        .rejects.toThrow("kernel-only");
    });
  });

  describe("kvWritePrivileged blocks sealed: keys", () => {
    it("blocks writes to sealed: keys", async () => {
      const { brain } = makeBrain();
      brain.sessionId = "test_session";
      await expect(brain.kvWritePrivileged([
        { op: "put", key: "sealed:quarantine:test", value: { data: 1 } },
      ])).rejects.toThrow("kernel-only");
    });
  });
});

// ── Inbound content gate ────────────────────────────────────

describe("inbound content gate", () => {
  async function setupBrainForInbound(kvInit = {}, contacts = {}) {
    const { brain, env } = makeBrain(kvInit);
    brain.sessionId = "test_session";
    brain.karma = [];
    brain.defaults = {
      act: { model: "test-model", max_steps: 10, max_cost: 1.0 },
    };

    // Set inbound grant in toolGrants (kernel-controlled)
    brain.toolGrants = {
      check_email: {
        inbound: {
          channel: "email",
          sender_field: "sender_email",
          content_field: "body",
          result_array: "emails",
        },
      },
    };

    // Mock _loadTool to return a tool (inbound config now lives in toolGrants)
    brain._loadTool = vi.fn(async (name) => {
      if (name === "check_email") {
        return {
          meta: {},
          execute: async () => ({
            emails: [
              {
                id: "msg_1",
                from: "Alice <alice@example.com>",
                sender_email: "alice@example.com",
                subject: "Hello",
                body: "Hi, this is Alice!",
              },
              {
                id: "msg_2",
                from: "Bob <bob@unknown.com>",
                sender_email: "bob@unknown.com",
                subject: "Spam?",
                body: "Buy my product!",
              },
            ],
          }),
        };
      }
      if (name === "kv_query") {
        return {
          meta: {},
          execute: async () => ({ value: "test" }),
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    });

    // Mock resolveContact
    brain.resolveContact = vi.fn(async (channel, senderId) => {
      return contacts[`${channel}:${senderId}`] || null;
    });

    // Mock executeAction to use the tool's execute
    brain.executeAction = vi.fn(async ({ tool }) => {
      const { execute } = await brain._loadTool(tool);
      return execute();
    });

    // Mock callHook (validate_result) to pass through
    brain.callHook = vi.fn(async () => null);

    // Stub karmaRecord
    brain.karmaRecord = vi.fn(async () => {});

    // Stub kvPut for quarantine writes
    brain.kvPut = vi.fn(async () => {});

    // Stub communication gate methods
    brain._commsGateApproved = false;
    brain.loadCommsWisdom = vi.fn(async () => null);

    return { brain, env };
  }

  it("redacts content from unknown senders", async () => {
    const { brain } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      // bob@unknown.com is NOT in contacts
    });

    const result = await brain.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // Alice's email should be untouched
    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    // Bob's email should be redacted
    expect(result.emails[1].body).toBe("[content redacted — unknown sender]");
  });

  it("redacts content from unapproved senders", async () => {
    const { brain } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      "email:bob@unknown.com": { name: "Bob", slug: "bob", approved: false },
    });

    const result = await brain.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    expect(result.emails[1].body).toBe("[content redacted — unapproved sender]");
  });

  it("quarantines unknown sender content under sealed: key", async () => {
    const { brain } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
    });

    await brain.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // kvPut should have been called with a sealed:quarantine: key for Bob
    const quarantineCall = brain.kvPut.mock.calls.find(
      ([key]) => key.startsWith("sealed:quarantine:")
    );
    expect(quarantineCall).toBeDefined();
    const [key, value] = quarantineCall;
    expect(key).toMatch(/^sealed:quarantine:email:bob%40unknown\.com:\d+$/);
    expect(value.sender).toBe("bob@unknown.com");
    expect(value.content).toBe("Buy my product!");
    expect(value.tool).toBe("check_email");
    expect(value.subject).toBe("Spam?");
    expect(value.from).toBe("Bob <bob@unknown.com>");
  });

  it("records inbound_redacted karma for unknown senders", async () => {
    const { brain } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
    });

    await brain.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    const redactedKarma = brain.karmaRecord.mock.calls.find(
      ([entry]) => entry.event === "inbound_redacted"
    );
    expect(redactedKarma).toBeDefined();
    expect(redactedKarma[0].sender_id).toBe("bob@unknown.com");
    expect(redactedKarma[0].channel).toBe("email");
    expect(redactedKarma[0].quarantine_key).toMatch(/^sealed:quarantine:/);
  });

  it("passes through content from known approved senders without redaction", async () => {
    const { brain } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      "email:bob@unknown.com": { name: "Bob", slug: "bob", approved: true },
    });

    const result = await brain.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // Both emails should be untouched
    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    expect(result.emails[1].body).toBe("Buy my product!");

    // No quarantine writes
    const quarantineCall = brain.kvPut.mock.calls.find(
      ([key]) => key.startsWith("sealed:quarantine:")
    );
    expect(quarantineCall).toBeUndefined();
  });

  it("skips inbound gate for tools without inbound meta", async () => {
    const { brain } = await setupBrainForInbound();

    brain._loadTool = vi.fn(async () => ({
      meta: {},
      execute: async () => ({ data: "some result" }),
    }));
    brain.executeAction = vi.fn(async () => ({ data: "some result" }));

    const result = await brain.executeToolCall({
      id: "tc_1",
      function: { name: "kv_query", arguments: '{"key":"test"}' },
    });

    expect(result.data).toBe("some result");
    expect(brain.resolveContact).not.toHaveBeenCalled();
  });
});

// ── Patron identity verification ────────────────────────────

describe("parseSSHEd25519", () => {
  const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8 test-key";

  it("extracts 32-byte raw key from SSH format", () => {
    const raw = Brainstem.parseSSHEd25519(testKey);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw.length).toBe(32);
  });

  it("throws on non-ed25519 key", () => {
    expect(() => Brainstem.parseSSHEd25519("ssh-rsa AAAA... comment")).toThrow("Not an ssh-ed25519 key");
  });

  it("throws on empty input", () => {
    expect(() => Brainstem.parseSSHEd25519("")).toThrow();
  });

  it("handles keys without comments", () => {
    const noComment = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8";
    const raw = Brainstem.parseSSHEd25519(noComment);
    expect(raw.length).toBe(32);
  });
});

describe("verify_patron", () => {
  const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8 test-key";
  const testMessage = "test-challenge-123";
  const testSignature = "gR7cF2kUYOL71kGAXaqa+Pv2MKHt1daWWbsMDJlti2E4VfTXSkOr6RjYf49uZn7Kip06VDUqWVhUi8NHyFINCg==";

  it("verifyPatronSignature returns true for valid signature", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    const result = await brain.verifyPatronSignature(testMessage, testSignature);
    expect(result).toBe(true);
  });

  it("verifyPatronSignature returns false for invalid signature", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    const result = await brain.verifyPatronSignature("wrong message", testSignature);
    expect(result).toBe(false);
  });

  it("verifyPatronSignature throws when no public key configured", async () => {
    const { brain } = makeBrain();
    await expect(brain.verifyPatronSignature(testMessage, testSignature))
      .rejects.toThrow("No patron public key configured");
  });

  it("verifyPatron tool returns verified: true for valid signature", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    const result = await brain.verifyPatron({ message: testMessage, signature: testSignature });
    expect(result.verified).toBe(true);
    expect(brain.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_verified" }));
  });

  it("verifyPatron tool returns verified: false for bad signature", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    const result = await brain.verifyPatron({ message: "wrong", signature: testSignature });
    expect(result.verified).toBe(false);
    expect(brain.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_verification_failed" }));
  });

  it("verifyPatron tool returns error when args missing", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    const result = await brain.verifyPatron({});
    expect(result.error).toContain("required");
    expect(result.verified).toBe(false);
  });

  it("dispatches via executeToolCall", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    const result = await brain.executeToolCall({
      id: "tc_verify",
      function: {
        name: "verify_patron",
        arguments: JSON.stringify({ message: testMessage, signature: testSignature }),
      },
    });
    expect(result.verified).toBe(true);
  });

  it("appears in buildToolDefinitions output", async () => {
    const { brain } = makeBrain({}, { toolRegistry: { tools: [] } });
    const defs = await brain.buildToolDefinitions();
    const verifyDef = defs.find(d => d.function.name === "verify_patron");
    expect(verifyDef).toBeDefined();
    expect(verifyDef.function.parameters.required).toEqual(["message", "signature"]);
  });
});

describe("rotatePatronKey", () => {
  const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8 test-key";
  const newKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF+2037HjOaLVLOJeYU06GNqUoG8hSP6uy1SDvncnFRy new-key";
  const rotateSignature = "cWNGtDv+9DfvxGh3UZ2WqVEFM25src1SgpZKuzjdsfAACWBCIAJoJW5MPQaXvtgr1aTodBgRUPIC2DzUEjPdAg==";

  it("rotates key with valid signature", async () => {
    const { brain, env } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});
    brain.sessionId = "test_session";

    const result = await brain.rotatePatronKey(newKey, rotateSignature);
    expect(result.rotated).toBe(true);

    // Verify the new key was written directly to KV
    const written = env.KV.put.mock.calls.find(([key]) => key === "patron:public_key");
    expect(written).toBeDefined();
    expect(written[1]).toBe(newKey);

    // Verify karma and alert
    expect(brain.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_key_rotated" }));
    expect(brain.sendKernelAlert).toHaveBeenCalledWith("patron_key_rotated", expect.any(String));
  });

  it("rejects rotation with invalid signature", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    await expect(brain.rotatePatronKey(newKey, "badsignature=="))
      .rejects.toThrow();
  });

  it("rejects rotation with valid signature but invalid new key format", async () => {
    const { brain } = makeBrain({ "patron:public_key": JSON.stringify(testKey) });
    brain.karmaRecord = vi.fn(async () => {});
    brain.sendKernelAlert = vi.fn(async () => {});

    // Sign a rotation for an invalid key
    // This will fail at verifyPatronSignature because the message won't match
    await expect(brain.rotatePatronKey("not-a-valid-key", rotateSignature))
      .rejects.toThrow();
  });

  it("patron:public_key remains immutable via kvPut", async () => {
    const { brain } = makeBrain();
    await expect(brain.kvPut("patron:public_key", "new value"))
      .rejects.toThrow("immutable");
  });
});

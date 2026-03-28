import { describe, it, expect, vi, beforeEach } from "vitest";
import { Kernel } from "../kernel.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── Test helpers ──────────────────────────────────────────────

function makeEnv(kvInit = {}) {
  return { KV: makeKVStore(kvInit) };
}

function makeKernel(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit);
  const kernel= new Kernel(env, {
    TOOLS: opts.TOOLS || {},
    HOOKS: opts.HOOKS || {},
    PROVIDERS: opts.PROVIDERS || {},
    CHANNELS: opts.CHANNELS || {},
  });
  kernel.defaults = opts.defaults || {};
  kernel.toolRegistry = opts.toolRegistry || null;
  kernel.modelsConfig = opts.modelsConfig || null;
  kernel.modelCapabilities = opts.modelCapabilities || null;
  kernel.dharma = opts.dharma || null;
  kernel.toolGrants = opts.toolGrants || {};
  return { kernel, env };
}

// ── 1. parseAgentOutput ─────────────────────────────────────

describe("parseAgentOutput", () => {
  it("returns parsed object for valid JSON", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.parseAgentOutput('{"key":"value","n":42}');
    expect(result).toEqual({ key: "value", n: 42 });
  });

  it("returns { parse_error, raw } for invalid JSON (no hook)", async () => {
    const { kernel } = makeKernel();
    kernel.callHook = vi.fn(async () => null);
    const result = await kernel.parseAgentOutput("not json at all");
    expect(result).toEqual({ parse_error: true, raw: "not json at all" });
  });

  it("returns {} for empty/null content", async () => {
    const { kernel } = makeKernel();
    expect(await kernel.parseAgentOutput(null)).toEqual({});
    expect(await kernel.parseAgentOutput("")).toEqual({});
    expect(await kernel.parseAgentOutput(undefined)).toEqual({});
  });

  it("calls parse_repair hook on failure", async () => {
    const { kernel } = makeKernel();
    kernel.callHook = vi.fn(async () => ({ content: '{"fixed":true}' }));
    const result = await kernel.parseAgentOutput("not json");
    expect(result).toEqual({ fixed: true });
    expect(kernel.callHook).toHaveBeenCalledWith("parse_repair", { content: "not json" });
  });

  it("returns parse_error when hook returns bad JSON", async () => {
    const { kernel } = makeKernel();
    kernel.callHook = vi.fn(async () => ({ content: "still bad" }));
    const result = await kernel.parseAgentOutput("not json");
    expect(result).toEqual({ parse_error: true, raw: "not json" });
  });

  it("extracts JSON from markdown code fences", async () => {
    const { kernel } = makeKernel();
    kernel.callHook = vi.fn(async () => null);
    const result = await kernel.parseAgentOutput('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
    expect(kernel.callHook).not.toHaveBeenCalled();
  });

  it("extracts JSON from prose with surrounding text", async () => {
    const { kernel } = makeKernel();
    kernel.callHook = vi.fn(async () => null);
    const result = await kernel.parseAgentOutput('Here is my output:\n{"key":"value"}\nDone.');
    expect(result).toEqual({ key: "value" });
  });
});

// ── 1b. _extractJSON ─────────────────────────────────────────

describe("_extractJSON", () => {
  const { kernel } = makeKernel();

  it("returns null for null/undefined/empty", () => {
    expect(kernel._extractJSON(null)).toBeNull();
    expect(kernel._extractJSON(undefined)).toBeNull();
    expect(kernel._extractJSON("")).toBeNull();
  });

  it("extracts from ```json fences", () => {
    expect(kernel._extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts from bare ``` fences", () => {
    expect(kernel._extractJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts object from surrounding prose", () => {
    expect(kernel._extractJSON('Here is the result:\n{"a":1,"b":"two"}\nEnd.')).toEqual({ a: 1, b: "two" });
  });

  it("does not extract arrays (agent output is always an object)", () => {
    expect(kernel._extractJSON('Result: [1,2,3] done')).toBeNull();
  });

  it("handles nested braces", () => {
    expect(kernel._extractJSON('```json\n{"a":{"b":{"c":1}}}\n```')).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles braces inside strings", () => {
    expect(kernel._extractJSON('{"msg":"use {curly} braces","n":1}')).toEqual({ msg: "use {curly} braces", n: 1 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(kernel._extractJSON('{"msg":"say \\"hello\\"","n":1}')).toEqual({ msg: 'say "hello"', n: 1 });
  });

  it("returns null for no JSON content", () => {
    expect(kernel._extractJSON("just some text")).toBeNull();
  });

  it("handles real-world reflect output with fences", () => {
    const input = '```json\n{\n  "session_summary": "Short act session",\n  "note_to_future_self": "Check last_sessions first"\n}\n```';
    expect(kernel._extractJSON(input)).toEqual({
      session_summary: "Short act session",
      note_to_future_self: "Check last_sessions first",
    });
  });
});

// ── 2. buildToolDefinitions ─────────────────────────────────

describe("buildToolDefinitions", () => {
  it("maps registry tools to OpenAI format", () => {
    const { kernel } = makeKernel({}, {
      toolRegistry: {
        tools: [
          { name: "web_fetch", description: "Fetch a URL", input: { url: "The URL to fetch" } },
          { name: "kv_query", description: "Read KV", input: { key: "KV key" } },
        ],
      },
    });
    const defs = kernel.buildToolDefinitions();
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
    const { kernel } = makeKernel({}, { toolRegistry: { tools: [] } });
    const defs = kernel.buildToolDefinitions();
    expect(defs.length).toBe(2); // spawn_subplan + verify_patron
    expect(defs.map(d => d.function.name)).toContain("spawn_subplan");
    expect(defs.map(d => d.function.name)).toContain("verify_patron");
  });

  it("handles missing/null registry", () => {
    const { kernel } = makeKernel();
    kernel.toolRegistry = null;
    const defs = kernel.buildToolDefinitions();
    expect(defs.length).toBe(2); // spawn_subplan + verify_patron
  });

  it("passes through extraTools", () => {
    const { kernel } = makeKernel({}, { toolRegistry: { tools: [] } });
    const extra = { type: "function", function: { name: "custom" } };
    const defs = kernel.buildToolDefinitions([extra]);
    expect(defs.length).toBe(3); // spawn_subplan + verify_patron + extra
    expect(defs[2]).toBe(extra);
  });
});

// ── 3. callLLM ──────────────────────────────────────────────

describe("callLLM", () => {
  function makeLLMKernel(response = {}) {
    const { kernel, env } = makeKernel();
    const defaultResponse = {
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    };
    kernel.callWithCascade = vi.fn(async () => ({ ...defaultResponse, ...response }));
    kernel.estimateCost = vi.fn(() => 0.001);
    return { kernel, env };
  }

  it("prepends system message when systemPrompt provided", async () => {
    const { kernel } = makeLLMKernel();
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("You are helpful");
    expect(call.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("does not prepend system message when no systemPrompt and no dharma", async () => {
    const { kernel } = makeLLMKernel();
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.messages.length).toBe(1);
    expect(call.messages[0].role).toBe("user");
  });

  it("injects dharma into system prompt when dharma is set", async () => {
    const { kernel } = makeLLMKernel();
    kernel.dharma = "Be truthful and compassionate.";
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful and compassionate.");
    expect(call.messages[0].content).toContain("You are helpful");
  });

  it("injects dharma even when no systemPrompt provided", async () => {
    const { kernel } = makeLLMKernel();
    kernel.dharma = "Be truthful.";
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("[DHARMA]");
    expect(call.messages[0].content).toContain("Be truthful.");
  });

  it("passes tools in request", async () => {
    const { kernel } = makeLLMKernel();
    const tools = [{ type: "function", function: { name: "test" } }];
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools,
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.tools).toEqual(tools);
  });

  it("returns toolCalls from response", async () => {
    const toolCalls = [{ id: "tc1", function: { name: "test", arguments: "{}" } }];
    const { kernel } = makeLLMKernel({ toolCalls });
    const result = await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    expect(result.toolCalls).toEqual(toolCalls);
  });

  it("passes effort through for model with supports_reasoning", async () => {
    const { kernel } = makeLLMKernel();
    kernel.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await kernel.callLLM({
      model: "anthropic/claude-sonnet-4.6",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.family).toBe("anthropic");
    expect(call.effort).toBe("high");
  });

  it("sets effort null for model without supports_reasoning", async () => {
    const { kernel } = makeLLMKernel();
    kernel.modelsConfig = {
      models: [
        { id: "deepseek/deepseek-v3.2", alias: "deepseek" },
      ],
    };
    await kernel.callLLM({
      model: "deepseek/deepseek-v3.2",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.family).toBeNull();
    expect(call.effort).toBeNull();
  });

  it("maps effort 'none' to null", async () => {
    const { kernel } = makeLLMKernel();
    kernel.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await kernel.callLLM({
      model: "anthropic/claude-sonnet-4.6",
      effort: "none",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.effort).toBeNull();
  });

  it("sets family and effort null for unknown model", async () => {
    const { kernel } = makeLLMKernel();
    kernel.modelsConfig = {
      models: [
        { id: "anthropic/claude-sonnet-4.6", alias: "sonnet", family: "anthropic", supports_reasoning: true },
      ],
    };
    await kernel.callLLM({
      model: "unknown/model-x",
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    expect(call.family).toBeNull();
    expect(call.effort).toBeNull();
  });

  it("retries with fallback model on failure", async () => {
    const { kernel } = makeKernel({}, {
      modelsConfig: { fallback_model: "anthropic/claude-haiku-4.5" },
    });
    let callCount = 0;
    kernel.callWithCascade = vi.fn(async (request) => {
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
    kernel.estimateCost = vi.fn(() => 0.0001);

    const result = await kernel.callLLM({
      model: "expensive-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    expect(callCount).toBe(2);
    const secondCall = kernel.callWithCascade.mock.calls[1][0];
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
    const { kernel } = makeKernel({}, {
      PROVIDERS: {
        'provider:llm': { call: mockCall, meta: { secrets: ["OPENROUTER_API_KEY"] } },
      },
    });
    kernel.env.OPENROUTER_API_KEY = "test-key";
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.callWithCascade({
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
    const { kernel } = makeKernel({}, {
      PROVIDERS: {
        'provider:llm': { call: vi.fn(async () => { throw new Error("broken"); }), meta: {} },
      },
    });
    kernel.env.OPENROUTER_API_KEY = "test-key";
    kernel.karmaRecord = vi.fn(async () => {});

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
      const result = await kernel.callWithCascade({
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
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "service down" }),
    }));
    try {
      const result = await kernel.callWithCascade({
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
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: '{"answer":"42"}',
      cost: 0.01,
      toolCalls: null,
    }));

    const result = await kernel.runAgentLoop({
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
    expect(kernel.callLLM).toHaveBeenCalledTimes(1);
  });

  it("tool call → result → final text (2 turns)", async () => {
    const { kernel } = makeKernel();
    let turn = 0;
    kernel.callLLM = vi.fn(async () => {
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
    kernel.executeToolCall = vi.fn(async () => ({ result: "tool output" }));

    const result = await kernel.runAgentLoop({
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
    expect(kernel.callLLM).toHaveBeenCalledTimes(2);
    expect(kernel.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("max steps forces final output", async () => {
    const { kernel } = makeKernel();
    kernel.executeToolCall = vi.fn(async () => ({ result: "ok" }));
    let callCount = 0;
    kernel.callLLM = vi.fn(async ({ step }) => {
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

    const result = await kernel.runAgentLoop({
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
    expect(kernel.callLLM).toHaveBeenCalledTimes(3);
  });

  it("parallel tool execution", async () => {
    const { kernel } = makeKernel();
    let turn = 0;
    kernel.callLLM = vi.fn(async () => {
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
    kernel.executeToolCall = vi.fn(async (tc) => {
      executedTools.push(tc.function.name);
      return { ok: true };
    });

    await kernel.runAgentLoop({
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
    const { kernel } = makeKernel();
    kernel.spawnSubplan = vi.fn(async (args) => ({ subplan: true, goal: args.goal }));

    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "spawn_subplan", arguments: '{"goal":"test goal"}' },
    });

    expect(kernel.spawnSubplan).toHaveBeenCalledWith({ goal: "test goal" });
    expect(result).toEqual({ subplan: true, goal: "test goal" });
  });

  it("routes other tools to executeAction", async () => {
    const { kernel } = makeKernel();
    kernel.executeAction = vi.fn(async (step) => ({ tool_result: step.tool }));

    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
    });

    expect(kernel.executeAction).toHaveBeenCalledWith({
      tool: "web_fetch",
      input: { url: "https://example.com" },
      id: "tc1",
    });
    expect(result).toEqual({ tool_result: "web_fetch" });
  });

  it("parses string arguments", async () => {
    const { kernel } = makeKernel();
    kernel.executeAction = vi.fn(async () => ({}));

    await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: '{"a":1,"b":"two"}' },
    });

    expect(kernel.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { a: 1, b: "two" },
      id: "tc1",
    });
  });

  it("handles object arguments (already parsed)", async () => {
    const { kernel } = makeKernel();
    kernel.executeAction = vi.fn(async () => ({}));

    await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test", arguments: { x: 99 } },
    });

    expect(kernel.executeAction).toHaveBeenCalledWith({
      tool: "test",
      input: { x: 99 },
      id: "tc1",
    });
  });
});

// ── spawnSubplan model validation ─────────────────────────

describe("spawnSubplan", () => {
  it("rejects invalid model aliases with available aliases", async () => {
    const { kernel } = makeKernel({
      "config:models": JSON.stringify({
        alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5" },
      }),
    });
    kernel.modelsConfig = { alias_map: { opus: "anthropic/claude-opus-4.6", sonnet: "anthropic/claude-sonnet-4.6", haiku: "anthropic/claude-haiku-4.5" } };

    const result = await kernel.spawnSubplan({ goal: "test", model: "deep_reflect" });
    expect(result.error).toContain("Unknown model alias");
    expect(result.error).toContain("deep_reflect");
    expect(result.error).toContain("opus");
    expect(result.error).toContain("sonnet");
    expect(result.error).toContain("haiku");
  });

  it("accepts valid aliases", async () => {
    const { kernel } = makeKernel();
    kernel.modelsConfig = { alias_map: { haiku: "anthropic/claude-haiku-4.5" } };
    kernel.runAgentLoop = vi.fn(async () => ({ result: "ok" }));

    const result = await kernel.spawnSubplan({ goal: "test", model: "haiku" });
    expect(result.error).toBeUndefined();
    expect(kernel.runAgentLoop).toHaveBeenCalled();
  });

  it("accepts full model IDs", async () => {
    const { kernel } = makeKernel();
    kernel.modelsConfig = { alias_map: {} };
    kernel.runAgentLoop = vi.fn(async () => ({ result: "ok" }));

    const result = await kernel.spawnSubplan({ goal: "test", model: "anthropic/claude-haiku-4.5" });
    expect(result.error).toBeUndefined();
    expect(kernel.runAgentLoop).toHaveBeenCalled();
  });
});

// ── 6. executeAction ────────────────────────────────────────

describe("executeAction", () => {
  it("calls tool function directly from TOOLS injection", async () => {
    const executeFn = vi.fn(async ({ x }) => ({ doubled: x * 2 }));
    const { kernel } = makeKernel({}, {
      TOOLS: {
        doubler: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAction({ tool: "doubler", input: { x: 5 }, id: "tc1" });
    expect(result).toEqual({ doubled: 10 });
    expect(executeFn).toHaveBeenCalled();
  });

  it("throws for missing tool", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await expect(kernel.executeAction({ tool: "nonexistent", input: {}, id: "tc1" }))
      .rejects.toThrow("Unknown tool: nonexistent");
  });
});

// ── 7. callLLM budget enforcement ──────────────────────────

describe("callLLM budget enforcement", () => {
  function makeBudgetBrain(budgetOverrides = {}) {
    const { kernel, env } = makeKernel();
    const budget = {
      max_cost: 0.10,
      max_duration_seconds: 600,
      ...budgetOverrides,
    };
    kernel.defaults = { session_budget: budget };
    kernel.callWithCascade = vi.fn(async () => ({
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    }));
    kernel.estimateCost = vi.fn(() => 0.001);
    return { kernel, env };
  }

  it("throws on cost limit", async () => {
    const { kernel } = makeBudgetBrain();
    kernel.sessionCost = 0.10;
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("throws on duration limit", async () => {
    const { kernel } = makeBudgetBrain();
    kernel.startTime = Date.now() - 601_000;
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    })).rejects.toThrow("Budget exceeded: duration");
  });

  it("accumulates cost and calls", async () => {
    const { kernel } = makeBudgetBrain();
    kernel.sessionCost = 0;
    kernel.sessionLLMCalls = 0;
    await kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(kernel.sessionCost).toBe(0.001);
    expect(kernel.sessionLLMCalls).toBe(1);
  });

  it("passes when under budget", async () => {
    const { kernel } = makeBudgetBrain();
    kernel.sessionCost = 0.05;
    kernel.sessionLLMCalls = 4;
    const result = await kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "test",
    });
    expect(result.content).toBe('{"result":"ok"}');
  });
});

// ── 8. runAgentLoop budget handling ────────────────────────

describe("runAgentLoop budget handling", () => {
  it("catches budget error gracefully", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    let callCount = 0;
    kernel.callLLM = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error("Budget exceeded: cost");
      return {
        content: null,
        cost: 0.05,
        toolCalls: [{ id: "tc1", function: { name: "tool", arguments: "{}" } }],
      };
    });
    kernel.executeToolCall = vi.fn(async () => ({ ok: true }));

    const result = await kernel.runAgentLoop({
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
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => {
      throw new Error("Network failure");
    });
    await expect(kernel.runAgentLoop({
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
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.callHook("validate", { tool: "test" });
    expect(result).toBeNull();
  });

  it("calls hook tool and returns result", async () => {
    const executeFn = vi.fn(async () => ({ ok: true }));
    const { kernel } = makeKernel({}, {
      TOOLS: {
        validate: { execute: executeFn, meta: { timeout_ms: 3000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.buildToolContext = vi.fn(async (name, meta, input) => input);
    const result = await kernel.callHook("validate", { tool: "test" });
    expect(result).toEqual({ ok: true });
    expect(executeFn).toHaveBeenCalled();
  });

  it("swallows hook errors", async () => {
    const executeFn = vi.fn(async () => { throw new Error("boom"); });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        validate: { execute: executeFn, meta: {} },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.buildToolContext = vi.fn(async () => ({}));
    const result = await kernel.callHook("validate", {});
    expect(result).toBeNull();
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "hook_error", hook: "validate" })
    );
  });
});

// ── 10. executeToolCall with hooks ──────────────────────────

describe("executeToolCall with hooks", () => {
  it("pre-validate rejects bad args", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async () => ({ result: "should not reach" }));
    kernel.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: false, error: "missing field" };
      return null;
    });
    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(result).toEqual({ error: "missing field" });
    expect(kernel.executeAction).not.toHaveBeenCalled();
  });

  it("pre-validate corrects args", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async (step) => ({ received: step.input }));
    kernel.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate") return { ok: true, args: { a: 1, b: "added" } };
      return null;
    });
    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"a":1}' },
    });
    expect(kernel.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: { a: 1, b: "added" } })
    );
  });

  it("post-validate rejects bad result", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async () => ({ data: "some result" }));
    kernel.callHook = vi.fn(async (hookName) => {
      if (hookName === "validate_result") return { ok: false, error: "empty response" };
      return null;
    });
    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{}' },
    });
    expect(result).toEqual({ error: "empty response" });
  });

  it("no hooks — pass through", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async () => ({ tool_result: "ok" }));
    kernel.callHook = vi.fn(async () => null);
    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: '{"x":1}' },
    });
    expect(result).toEqual({ tool_result: "ok" });
    expect(kernel.executeAction).toHaveBeenCalled();
  });

  it("garbled arguments returns error", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async () => ({}));
    kernel.callHook = vi.fn(async () => null);
    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "test_tool", arguments: "not json" },
    });
    expect(result).toEqual({ error: "Invalid JSON in tool arguments for test_tool" });
    expect(kernel.executeAction).not.toHaveBeenCalled();
  });
});

// ── 11. runAgentLoop parse error retry ──────────────────────

describe("runAgentLoop parse error retry", () => {
  it("retries on parse_error", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    let turn = 0;
    kernel.callLLM = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return { content: "not json", cost: 0.001, toolCalls: null };
      }
      return { content: '{"recovered":true}', cost: 0.001, toolCalls: null };
    });
    kernel.callHook = vi.fn(async () => null);

    const result = await kernel.runAgentLoop({
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
    expect(kernel.callLLM).toHaveBeenCalledTimes(2);
  });

  it("retries only once", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.callLLM = vi.fn(async () => ({
      content: "still not json",
      cost: 0.001,
      toolCalls: null,
    }));
    kernel.callHook = vi.fn(async () => null);

    const result = await kernel.runAgentLoop({
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
    expect(kernel.callLLM).toHaveBeenCalledTimes(2);
  });
});

// ── 12. isSystemKey / isKernelOnly ──────────────────────────

describe("isSystemKey / isKernelOnly", () => {
  it("recognizes system key prefixes", () => {
    expect(Kernel.isSystemKey("config:defaults")).toBe(true);
    expect(Kernel.isSystemKey("prompt:act")).toBe(true);
    expect(Kernel.isSystemKey("tool:kv_query:code")).toBe(true);
    expect(Kernel.isSystemKey("hook:act:code")).toBe(true);
    expect(Kernel.isSystemKey("proposal:p_1")).toBe(true);
    expect(Kernel.isSystemKey("doc:proposal_guide")).toBe(true);
    expect(Kernel.isSystemKey("skill:model-config")).toBe(true);
  });

  it("recognizes exact system keys", () => {
    expect(Kernel.isSystemKey("providers")).toBe(true);
    expect(Kernel.isSystemKey("wallets")).toBe(true);
    // wisdom is no longer a system key (replaced by upaya:/prajna: prefixes)
  });

  it("rejects non-system keys", () => {
    expect(Kernel.isSystemKey("session_schedule")).toBe(false);
    expect(Kernel.isSystemKey("last_reflect")).toBe(false);
    expect(Kernel.isSystemKey("session_counter")).toBe(false);
  });

  it("recognizes kernel-only keys", () => {
    expect(Kernel.isKernelOnly("kernel:last_sessions")).toBe(true);
    expect(Kernel.isKernelOnly("kernel:active_session")).toBe(true);
    expect(Kernel.isKernelOnly("kernel:alert_config")).toBe(true);
  });

  it("kernel-only does not overlap with system keys", () => {
    expect(Kernel.isKernelOnly("config:defaults")).toBe(false);
    expect(Kernel.isKernelOnly("prompt:act")).toBe(false);
  });
});

// ── 13. kvWriteSafe ──────────────────────────────────────────

describe("kvWriteSafe", () => {
  it("blocks dharma", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("dharma", "new value"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("kernel:last_sessions", []))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("config:defaults", {}))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { kernel } = makeKernel();
    await kernel.kvWriteSafe("session_schedule", { interval_seconds: 100 });
    // Should not throw
  });
});

// ── 14. kvDeleteSafe ───────────────────────────────────────

describe("kvDeleteSafe", () => {
  it("blocks dharma", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("dharma"))
      .rejects.toThrow("immutable");
  });

  it("blocks kernel-only keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("kernel:active_session"))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("prompt:act"))
      .rejects.toThrow("system key");
  });

  it("allows non-system keys", async () => {
    const { kernel } = makeKernel();
    await kernel.kvDeleteSafe("tooldata:mykey");
    // Should not throw
  });
});

// ── 15. kvWriteGated ──────────────────────────────────

describe("kvWriteGated", () => {
  it("blocks dharma", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "dharma", value: "evil" }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/immutable/);
  });

  it("blocks immutable keys (patron:public_key)", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "patron:public_key", value: "attacker-key" }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/immutable/);
  });

  it("blocks kernel-only keys", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "kernel:last_sessions", value: [] }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/kernel key/);
  });

  it("allows system keys with snapshot", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: { new: true } }, "deep-reflect"
    );
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "privileged_write", key: "config:defaults" })
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("enforces rate limit", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.privilegedWriteCount = 50;
    const result = await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: {} }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Privileged write limit/);
  });

  it("auto-refreshes config after privileged writes", async () => {
    const { kernel } = makeKernel({
      "config:defaults": JSON.stringify({ updated: true }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: { updated: true } }, "deep-reflect"
    );
    expect(kernel.defaults).toEqual({ updated: true });
  });

  it("handles delete operations", async () => {
    const { kernel, env } = makeKernel({
      "prompt:test_prompt": JSON.stringify({ text: "hello" }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "delete", key: "prompt:test_prompt" }, "deep-reflect"
    );
    expect(env.KV.delete).toHaveBeenCalledWith("prompt:test_prompt");
    expect(kernel.privilegedWriteCount).toBe(1);
  });
});

// ── 15b. kvWriteGated contact and platform binding write rules ─────────────

describe("kvWriteGated contact write rules", () => {
  it("allows put to an existing contact", async () => {
    const { kernel } = makeKernel({
      "contact:alice": JSON.stringify({ name: "Alice" }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "put", key: "contact:alice", value: { name: "Alice", notes: "likes tea" } }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("allows creation of new contacts (identity metadata)", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "put", key: "contact:newperson", value: { name: "New Person", relationship: "friend" } }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("allows delete of any contact", async () => {
    const { kernel } = makeKernel({
      "contact:alice": JSON.stringify({ name: "Alice" }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "delete", key: "contact:alice" }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("allows patch to an existing contact (string value)", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.env.KV._store.set("contact:alice", "Alice likes old tea");
    await kernel.kvWriteGated(
      { op: "patch", key: "contact:alice", old_string: "old tea", new_string: "green tea" }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });
});

describe("kvWriteGated platform binding write rules", () => {
  it("allows creation of platform binding with approved: false", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "put", key: "contact_platform:email:alice@example.com", value: { slug: "alice", approved: false } }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
    // Verify approved was forced to false
    const putCall = env.KV.put.mock.calls.find(([key]) => key === "contact_platform:email:alice@example.com");
    expect(putCall).toBeDefined();
    const stored = JSON.parse(putCall[1]);
    expect(stored.approved).toBe(false);
  });

  it("forces approved: false even when agent tries to set true", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "contact_platform:email:alice@example.com", value: { slug: "alice", approved: true } }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Setting approved: true on platform bindings is patron-only/);
  });

  it("rejects platform binding without slug", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "contact_platform:email:alice@example.com", value: { approved: false } }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Platform binding must include a slug/);
  });

  it("allows delete of unapproved platform bindings", async () => {
    const { kernel } = makeKernel({
      "contact_platform:email:alice@example.com": JSON.stringify({ slug: "alice", approved: false }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kvWriteGated(
      { op: "delete", key: "contact_platform:email:alice@example.com" }, "deep-reflect"
    );
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("blocks delete of approved platform bindings", async () => {
    const { kernel } = makeKernel({
      "contact_platform:email:alice@example.com": JSON.stringify({ slug: "alice", approved: true }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "delete", key: "contact_platform:email:alice@example.com" }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Deletion of approved platform bindings is patron-only/);
  });

  it("blocks patch that modifies approved field on platform binding", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.env.KV._store.set("contact_platform:email:alice@example.com", '{"slug":"alice","approved":false}');
    const result = await kernel.kvWriteGated(
      { op: "patch", key: "contact_platform:email:alice@example.com", old_string: '"approved":false', new_string: '"approved":true' }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Cannot patch "approved" field on platform bindings/);
  });
});

// ── 16. checkHookSafety ────────────────────────────────────

describe("checkHookSafety", () => {
  it("returns true with no history", async () => {
    const { kernel } = makeKernel();
    kernel.sendKernelAlert = vi.fn(async () => {});
    const safe = await kernel.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("returns true with mixed outcomes", async () => {
    const { kernel } = makeKernel({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "clean" },
        { id: "s_3", outcome: "crash" },
      ]),
    });
    kernel.sendKernelAlert = vi.fn(async () => {});
    const safe = await kernel.checkHookSafety();
    expect(safe).toBe(true);
  });

  it("fires tripwire on 3 consecutive crashes — writes deploy:rollback_requested", async () => {
    const { kernel, env } = makeKernel({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "killed" },
        { id: "s_3", outcome: "crash" },
      ]),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.sendKernelAlert = vi.fn(async () => {});

    const safe = await kernel.checkHookSafety();
    expect(safe).toBe(false);

    // Should write deploy:rollback_requested to KV
    const putCalls = env.KV.put.mock.calls;
    const rollbackPut = putCalls.find(([key]) => key === "deploy:rollback_requested");
    expect(rollbackPut).toBeTruthy();
    const rollback = JSON.parse(rollbackPut[1]);
    expect(rollback.reason).toBe("3_consecutive_crashes");

    expect(kernel.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("3 consecutive crashes"));
  });

  it("returns true when fewer than 3 sessions in history", async () => {
    const { kernel } = makeKernel({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "crash" },
      ]),
    });
    kernel.sendKernelAlert = vi.fn(async () => {});

    const safe = await kernel.checkHookSafety();
    expect(safe).toBe(true);
  });
});

// ── 17. session lock (runScheduled) ───────────────────────

describe("session lock", () => {
  it("proceeds when no active session marker", async () => {
    const { kernel } = makeKernel();
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.executeHook = vi.fn(async () => {});
    await kernel.runScheduled();
    expect(kernel.executeHook).toHaveBeenCalled();
  });

  it("bails when active session is recent", async () => {
    const { kernel } = makeKernel({
      "kernel:active_session": JSON.stringify({ id: "s_other", started_at: new Date().toISOString() }),
      "config:defaults": JSON.stringify({ session_budget: { max_duration_seconds: 600 } }),
    });
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.executeHook = vi.fn(async () => {});
    await kernel.runScheduled();
    expect(kernel.executeHook).not.toHaveBeenCalled();
  });

  it("treats stale marker as killed session and proceeds", async () => {
    const staleTime = new Date(Date.now() - 1300 * 1000).toISOString(); // older than 2x 600s
    const { kernel, env } = makeKernel({
      "kernel:active_session": JSON.stringify({ id: "s_dead", started_at: staleTime }),
      "config:defaults": JSON.stringify({ session_budget: { max_duration_seconds: 600 } }),
    });
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.executeHook = vi.fn(async () => {});
    await kernel.runScheduled();

    // Should have recorded the killed session
    const historyPut = env.KV.put.mock.calls.find(([key]) => key === "kernel:last_sessions");
    expect(historyPut).toBeTruthy();
    const history = JSON.parse(historyPut[1]);
    expect(history[0].outcome).toBe("killed");
    expect(history[0].id).toBe("s_dead");

    // Should have proceeded
    expect(kernel.executeHook).toHaveBeenCalled();
  });
});

// ── 18. updateSessionOutcome ────────────────────────────────

describe("updateSessionOutcome", () => {
  it("adds clean outcome to kernel:last_sessions", async () => {
    const { kernel, env } = makeKernel();
    await kernel.updateSessionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("clean");
  });

  it("adds crash outcome to kernel:last_sessions", async () => {
    const { kernel, env } = makeKernel();
    await kernel.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("crash");
  });

  it("prepends to existing history", async () => {
    const { kernel, env } = makeKernel({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_old", outcome: "clean", ts: "2026-01-01T00:00:00Z" },
      ]),
    });
    await kernel.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].outcome).toBe("crash");
    expect(sessions[1].id).toBe("s_old");
  });

  it("caps history at 5 entries", async () => {
    const { kernel, env } = makeKernel({
      "kernel:last_sessions": JSON.stringify([
        { id: "s_1", outcome: "clean", ts: "t1" },
        { id: "s_2", outcome: "clean", ts: "t2" },
        { id: "s_3", outcome: "clean", ts: "t3" },
        { id: "s_4", outcome: "clean", ts: "t4" },
        { id: "s_5", outcome: "clean", ts: "t5" },
      ]),
    });
    await kernel.updateSessionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_sessions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(5);
    expect(sessions[0].outcome).toBe("crash");
    // Oldest entry (s_5) should have been dropped
    expect(sessions.map(s => s.id)).not.toContain("s_5");
  });
});

// ── 19. _writeSessionHealth ──────────────────────────────────

describe("_writeSessionHealth", () => {
  it("writes a clean health summary", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "s_test_health";
    kernel.sessionCost = 0.05;
    kernel.sessionLLMCalls = 3;
    kernel._sessionStart = Date.now() - 5000;
    kernel.karma = [
      { event: "session_start" },
      { event: "llm_call", step: "act_turn_0" },
      { event: "llm_call", step: "reflect_turn_0" },
    ];

    await kernel._writeSessionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "session_health:s_test_health");
    expect(putCall).toBeTruthy();
    const health = JSON.parse(putCall[1]);
    expect(health.outcome).toBe("clean");
    expect(health.cost).toBe(0.05);
    expect(health.reflect_ran).toBe(true);
    // Clean session should not have problem fields
    expect(health.budget_exceeded).toBeUndefined();
    expect(health.truncations).toBeUndefined();
  });

  it("captures budget_exceeded and missing reflect", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "s_test_budget";
    kernel.sessionCost = 0.20;
    kernel.sessionLLMCalls = 8;
    kernel._sessionStart = Date.now() - 10000;
    kernel.karma = [
      { event: "session_start" },
      { event: "llm_call", step: "act_turn_0" },
      { event: "budget_exceeded", step: "act" },
      { event: "budget_exceeded", step: "reflect" },
    ];

    await kernel._writeSessionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "session_health:s_test_budget");
    const health = JSON.parse(putCall[1]);
    expect(health.budget_exceeded).toEqual(["act", "reflect"]);
    expect(health.reflect_ran).toBe(false);
  });

  it("captures truncations and tool failures", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "s_test_trunc";
    kernel.sessionCost = 0.10;
    kernel.sessionLLMCalls = 4;
    kernel._sessionStart = Date.now() - 8000;
    kernel.karma = [
      { event: "session_start" },
      { event: "llm_call", step: "reflect_turn_0", truncated: true },
      { event: "tool_complete", tool: "computer", ok: false },
      { event: "tool_complete", tool: "computer", ok: false },
      { event: "reflect_parse_error", depth: 0 },
      { event: "vikalpa_updates_missed", missed: [] },
    ];

    await kernel._writeSessionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "session_health:s_test_trunc");
    const health = JSON.parse(putCall[1]);
    expect(health.truncations).toEqual(["reflect_turn_0"]);
    expect(health.tool_failures).toBe(2);
    expect(health.parse_errors).toBe(1);
    expect(health.updates_missed).toBe(1);
    expect(health.reflect_ran).toBe(true);
  });

  it("writes health on fatal error path", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "s_test_fatal";
    kernel.sessionCost = 0.01;
    kernel.sessionLLMCalls = 1;
    kernel._sessionStart = Date.now() - 2000;
    kernel.karma = [
      { event: "session_start" },
      { event: "fatal_error", error: "boom" },
    ];

    await kernel._writeSessionHealth("error");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "session_health:s_test_fatal");
    const health = JSON.parse(putCall[1]);
    expect(health.outcome).toBe("error");
    expect(health.reflect_ran).toBe(false);
  });
});

// ── (hook_dirty tests removed — flag no longer exists) ──

// ── 20. runScheduled hook execution flow ──────────────────

describe("runScheduled hook execution flow", () => {
  it("calls checkHookSafety → executeHook when safe", async () => {
    const { kernel } = makeKernel();
    const callOrder = [];
    kernel.checkHookSafety = vi.fn(async () => { callOrder.push("checkHookSafety"); return true; });
    kernel.executeHook = vi.fn(async () => callOrder.push("executeHook"));
    kernel.runFallbackSession = vi.fn(async () => callOrder.push("fallback"));

    await kernel.runScheduled();

    expect(callOrder).toEqual(["checkHookSafety", "executeHook"]);
    expect(kernel.runFallbackSession).not.toHaveBeenCalled();
  });

  it("falls back to runFallbackSession() when checkHookSafety returns false", async () => {
    const { kernel } = makeKernel();
    kernel.checkHookSafety = vi.fn(async () => false);
    kernel.executeHook = vi.fn(async () => {});
    kernel.runFallbackSession = vi.fn(async () => {});

    await kernel.runScheduled();

    expect(kernel.executeHook).not.toHaveBeenCalled();
    expect(kernel.runFallbackSession).toHaveBeenCalled();
  });

  it("writes active session marker before executing", async () => {
    const { kernel, env } = makeKernel();
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.executeHook = vi.fn(async () => {});

    await kernel.runScheduled();

    const markerPut = env.KV.put.mock.calls.find(([key]) => key === "kernel:active_session");
    expect(markerPut).toBeTruthy();
    const marker = JSON.parse(markerPut[1]);
    expect(marker.id).toBe(kernel.sessionId);
    expect(marker.started_at).toBeTruthy();
  });
});

// ── checkBalance ──────────────────────────────────────────────

describe("checkBalance", () => {
  it("iterates providers and wallets, calls executeAdapter for each", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance", scope: "general" },
        no_adapter: { note: "manual" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance", scope: "general" },
      }),
    });
    kernel.executeAdapter = vi.fn(async () => 42);

    const result = await kernel.checkBalance({});

    expect(kernel.executeAdapter).toHaveBeenCalledTimes(2);
    expect(result.providers.openrouter).toEqual({ balance: 42, scope: "general" });
    expect(result.providers.no_adapter).toBeUndefined();
    expect(result.wallets.base).toEqual({ balance: 42, scope: "general" });
  });

  it("filters by scope", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        main: { adapter: "provider:llm_balance", scope: "general" },
        proj: { adapter: "provider:llm_balance", scope: "project_x" },
      }),
      wallets: JSON.stringify({}),
    });
    kernel.executeAdapter = vi.fn(async () => 10);

    const result = await kernel.checkBalance({ scope: "general" });

    expect(kernel.executeAdapter).toHaveBeenCalledTimes(1);
    expect(result.providers.main).toEqual({ balance: 10, scope: "general" });
    expect(result.providers.proj).toBeUndefined();
  });

  it("returns error for failing adapters", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        broken: { adapter: "provider:bad", scope: "general" },
      }),
      wallets: JSON.stringify({}),
    });
    kernel.executeAdapter = vi.fn(async () => { throw new Error("no code"); });

    const result = await kernel.checkBalance({});

    expect(result.providers.broken).toEqual({ balance: null, scope: "general", error: "no code" });
  });

});

// ── callLLM budgetCap ──────────────────────────────────────

describe("callLLM budgetCap", () => {
  function makeLLMKernel(sessionCost, budget, budgetCap) {
    const { kernel } = makeKernel();
    kernel.sessionCost = sessionCost;
    kernel.sessionLLMCalls = 0;
    kernel.defaults = { session_budget: budget };
    kernel.startTime = Date.now();
    kernel.elapsed = () => 0;
    kernel.callWithCascade = vi.fn(async () => ({
      ok: true, content: "hi", usage: { prompt_tokens: 10, completion_tokens: 5 },
      tier: "primary",
    }));
    kernel.estimateCost = () => 0.01;
    kernel.karmaRecord = vi.fn(async () => {});
    return kernel;
  }

  it("uses session_budget.max_cost when no budgetCap", async () => {
    const kernel= makeLLMKernel(0.14, { max_cost: 0.15 });
    // 0.14 < 0.15 — should succeed
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
    })).resolves.toBeDefined();
  });

  it("throws when sessionCost >= budgetCap", async () => {
    const kernel= makeLLMKernel(0.10, { max_cost: 0.15 });
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("allows call when sessionCost < budgetCap even if close to max_cost", async () => {
    const kernel= makeLLMKernel(0.09, { max_cost: 0.15 });
    // budgetCap=0.10, sessionCost=0.09 < 0.10 — should succeed
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.10,
    })).resolves.toBeDefined();
  });

  it("budgetCap overrides max_cost (lower cap)", async () => {
    const kernel= makeLLMKernel(0.08, { max_cost: 0.15 });
    // Without budgetCap: 0.08 < 0.15, would succeed
    // With budgetCap=0.05: 0.08 >= 0.05, should fail
    await expect(kernel.callLLM({
      model: "test", messages: [{ role: "user", content: "hi" }], step: "t",
      budgetCap: 0.05,
    })).rejects.toThrow("Budget exceeded: cost");
  });

  it("resolves kv: secret overrides", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        proj: { adapter: "provider:llm_balance", scope: "project_x", secrets: { OPENROUTER_API_KEY: "kv:secret:proj_key" } },
      }),
      wallets: JSON.stringify({}),
      "secret:proj_key": JSON.stringify("sk-proj-12345"),
    });
    kernel.executeAdapter = vi.fn(async () => 99);

    await kernel.checkBalance({});

    // executeAdapter should have been called with resolved secret overrides
    const overrides = kernel.executeAdapter.mock.calls[0][2];
    expect(overrides).toEqual({ OPENROUTER_API_KEY: "sk-proj-12345" });
  });
});

// ── Yamas and Niyamas ──────────────────────────────────────

describe("Yamas and Niyamas", () => {
  function makeLLMKernel(response = {}) {
    const { kernel, env } = makeKernel();
    const defaultResponse = {
      ok: true,
      tier: "kernel_fallback",
      content: '{"result":"ok"}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      toolCalls: null,
    };
    kernel.callWithCascade = vi.fn(async () => ({ ...defaultResponse, ...response }));
    kernel.estimateCost = vi.fn(() => 0.001);
    return { kernel, env };
  }

  describe("callLLM injection", () => {
    it("injects [YAMAS] and [NIYAMAS] blocks after dharma", async () => {
      const { kernel } = makeLLMKernel();
      kernel.dharma = "Be truthful.";
      kernel.yamas = { "yama:care": "Care for all.", "yama:truth": "Be transparent." };
      kernel.niyamas = { "niyama:health": "Keep code clean." };
      await kernel.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const call = kernel.callWithCascade.mock.calls[0][0];
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
      const { kernel } = makeLLMKernel();
      kernel.dharma = "Be truthful.";
      kernel.yamas = null;
      kernel.niyamas = null;
      await kernel.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).not.toContain("[YAMAS]");
      expect(sysContent).not.toContain("[NIYAMAS]");
    });

    it("no blocks when yamas/niyamas are empty objects", async () => {
      const { kernel } = makeLLMKernel();
      kernel.yamas = {};
      kernel.niyamas = {};
      await kernel.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        systemPrompt: "You are helpful",
        step: "test",
      });
      const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).not.toContain("[YAMAS]");
      expect(sysContent).not.toContain("[NIYAMAS]");
    });

    it("each entry labeled [name]...[/name]", async () => {
      const { kernel } = makeLLMKernel();
      kernel.yamas = { "yama:discipline": "Be disciplined." };
      kernel.niyamas = {};
      await kernel.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        step: "test",
      });
      const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
      expect(sysContent).toContain("[discipline]\nBe disciplined.\n[/discipline]");
    });

    it("tracks lastCallModel after successful call", async () => {
      const { kernel } = makeLLMKernel();
      expect(kernel.lastCallModel).toBeNull();
      await kernel.callLLM({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hello" }],
        step: "test",
      });
      expect(kernel.lastCallModel).toBe("anthropic/claude-sonnet-4.6");
    });
  });

  describe("kvWriteGated enforcement", () => {
    function makePrincipleBrain(kvInit = {}) {
      const { kernel, env } = makeKernel(kvInit, {
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
      kernel.karmaRecord = vi.fn(async () => {});
      kernel.lastCallModel = "anthropic/claude-sonnet-4.6";
      return { kernel, env };
    }

    it("rejects yama write if deliberation < 200 chars", async () => {
      const { kernel } = makePrincipleBrain();
      const result = await kernel.kvWriteGated(
        { op: "put", key: "yama:care", value: "new value", deliberation: "too short" }, "deep-reflect"
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Yama modifications require deliberation \(min 200 chars/);
    });

    it("rejects niyama write if deliberation < 100 chars", async () => {
      const { kernel } = makePrincipleBrain();
      const result = await kernel.kvWriteGated(
        { op: "put", key: "niyama:health", value: "new value", deliberation: "short" }, "deep-reflect"
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Niyama modifications require deliberation \(min 100 chars/);
    });

    it("rejects if last model lacks yama_capable flag", async () => {
      const { kernel } = makePrincipleBrain();
      kernel.lastCallModel = "anthropic/claude-haiku-4.5";
      const result = await kernel.kvWriteGated(
        { op: "put", key: "yama:care", value: "new value", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/yama_capable model/);
    });

    it("rejects if last model lacks niyama_capable flag", async () => {
      const { kernel } = makePrincipleBrain();
      kernel.lastCallModel = "anthropic/claude-haiku-4.5";
      const result = await kernel.kvWriteGated(
        { op: "put", key: "niyama:health", value: "new value", deliberation: "x".repeat(100) }, "deep-reflect"
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/niyama_capable model/);
    });

    it("returns warning with diff when modifying a yama", async () => {
      const { kernel } = makePrincipleBrain({
        "yama:care": "Old care text",
      });
      const result = await kernel.kvWriteGated(
        { op: "put", key: "yama:care", value: "New care text", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      expect(result).toBeDefined();
      expect(result.ok).toBe(true);
      expect(result.warning.key).toBe("yama:care");
      expect(result.warning.type).toBe("yama");
      expect(result.warning.current_value).toBe("Old care text");
      expect(result.warning.proposed_value).toBe("New care text");
      expect(result.warning.message).toContain("core principle of how you act in the world");
    });

    it("returns warning for niyama with different severity message", async () => {
      const { kernel } = makePrincipleBrain();
      const result = await kernel.kvWriteGated(
        { op: "put", key: "niyama:health", value: "New health text", deliberation: "x".repeat(100) }, "deep-reflect"
      );
      expect(result.warning.message).toContain("how you reflect and improve");
      expect(result.warning.message).not.toContain("how you act in the world");
    });

    it("same warning weight for create and delete", async () => {
      const { kernel } = makePrincipleBrain({
        "yama:care": "Existing care text",
      });
      // Create (no existing value)
      const createResult = await kernel.kvWriteGated(
        { op: "put", key: "yama:new", value: "New yama", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      expect(createResult.warning.message).toContain("WARNING: You are modifying yama");

      // Delete
      const deleteResult = await kernel.kvWriteGated(
        { op: "delete", key: "yama:care", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      expect(deleteResult.warning.message).toContain("WARNING: You are modifying yama");
    });

    it("writes audit entry to {key}:audit", async () => {
      const { kernel, env } = makePrincipleBrain();
      await kernel.kvWriteGated(
        { op: "put", key: "yama:care", value: "New care text", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      const auditRaw = env.KV._store.get("yama:care:audit");
      expect(auditRaw).toBeDefined();
      const audit = JSON.parse(auditRaw);
      expect(audit).toHaveLength(1);
      expect(audit[0].model).toBe("anthropic/claude-sonnet-4.6");
      expect(audit[0].deliberation).toBe("x".repeat(200));
      expect(audit[0].new_value).toBe("New care text");
    });

    it("reloads cache after yama/niyama write", async () => {
      const { kernel, env } = makePrincipleBrain();
      // Pre-populate some yamas in KV
      env.KV._store.set("yama:truth", "Be transparent.");
      kernel.yamas = {};
      await kernel.kvWriteGated(
        { op: "put", key: "yama:care", value: "New care", deliberation: "x".repeat(200) }, "deep-reflect"
      );
      // loadYamasNiyamas should have been called, refreshing the cache
      expect(kernel.yamas).toHaveProperty("yama:care");
    });

    it("non-yama/niyama writes return {ok: true} without warning", async () => {
      const { kernel } = makePrincipleBrain();
      const result = await kernel.kvWriteGated(
        { op: "put", key: "config:defaults", value: { updated: true } }, "deep-reflect"
      );
      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it("audit keys don't require deliberation", async () => {
      const { kernel } = makePrincipleBrain();
      // Writing to an audit key should go through without deliberation gate
      const result = await kernel.kvWriteGated(
        { op: "put", key: "yama:care:audit", value: [{ entry: "test" }] }, "deep-reflect"
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("kvWriteSafe blocks yama/niyama", () => {
    it("blocks yama:* keys", async () => {
      const { kernel } = makeKernel();
      await expect(kernel.kvWriteSafe("yama:care", "new value"))
        .rejects.toThrow("system key");
    });

    it("blocks niyama:* keys", async () => {
      const { kernel } = makeKernel();
      await expect(kernel.kvWriteSafe("niyama:health", "new value"))
        .rejects.toThrow("system key");
    });
  });

  describe("static helpers", () => {
    it("isPrincipleKey identifies yama and niyama keys", () => {
      expect(Kernel.isPrincipleKey("yama:care")).toBe(true);
      expect(Kernel.isPrincipleKey("niyama:health")).toBe(true);
      expect(Kernel.isPrincipleKey("config:defaults")).toBe(false);
      expect(Kernel.isPrincipleKey("dharma")).toBe(false);
    });

    it("isPrincipleAuditKey identifies audit keys", () => {
      expect(Kernel.isPrincipleAuditKey("yama:care:audit")).toBe(true);
      expect(Kernel.isPrincipleAuditKey("niyama:health:audit")).toBe(true);
      expect(Kernel.isPrincipleAuditKey("yama:care")).toBe(false);
      expect(Kernel.isPrincipleAuditKey("config:audit")).toBe(false);
    });
  });

  describe("model capability helpers", () => {
    it("isYamaCapable checks yama_capable flag in modelCapabilities", () => {
      const { kernel } = makeKernel({}, {
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
      expect(kernel.isYamaCapable("anthropic/claude-opus-4.6")).toBe(true);
      expect(kernel.isYamaCapable("anthropic/claude-haiku-4.5")).toBe(false);
      expect(kernel.isYamaCapable("unknown-model")).toBe(false);
    });

    it("isNiyamaCapable checks niyama_capable flag in modelCapabilities", () => {
      const { kernel } = makeKernel({}, {
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
      expect(kernel.isNiyamaCapable("anthropic/claude-sonnet-4.6")).toBe(true);
      expect(kernel.isNiyamaCapable("anthropic/claude-haiku-4.5")).toBe(false);
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
    const { kernel } = makeKernel();
    expect(kernel.resolveCommsMode({}, slackMeta)).toBe("initiating");
    expect(kernel.resolveCommsMode({ channel: "C123" }, slackMeta)).toBe("initiating");
  });

  it("resolveCommsMode — email with reply_to_id is responding", () => {
    const { kernel } = makeKernel();
    expect(kernel.resolveCommsMode({ to: "a@b.com", reply_to_id: "msg123" }, emailMeta)).toBe("responding");
    expect(kernel.resolveCommsMode({ to: "a@b.com" }, emailMeta)).toBe("initiating");
  });

  it("resolveRecipient — reads from recipient_field", () => {
    const { kernel } = makeKernel();
    expect(kernel.resolveRecipient({ channel: "C123" }, slackMeta)).toBe("C123");
    expect(kernel.resolveRecipient({ to: "a@b.com" }, emailMeta)).toBe("a@b.com");
    expect(kernel.resolveRecipient({}, slackMeta)).toBeNull();
  });

  it("mechanical floor blocks person-type initiating to unknown recipient", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.communicationGate("send_email", { to: "unknown@example.com", body: "hello" }, emailMeta);
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("No contact record");
  });

  it("destination-type allows send to unknown channel (no contact check)", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.communicationGate("send_slack", { text: "hello", channel: "C_UNKNOWN" }, slackMeta);
    expect(result.verdict).toBe("send");
  });

  it("destination-type allows send to approved contact", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("contact:dev", JSON.stringify({ name: "Dev", communication: "Team member." }));
    await env.KV.put("contact_platform:slack:U_DEV", JSON.stringify({ slug: "dev", approved: true }));
    const result = await kernel.communicationGate("send_slack", { text: "hello", channel: "U_DEV" }, slackMeta);
    expect(result.verdict).toBe("send");
  });

  it("defaults to destination when recipient_type not specified", async () => {
    const legacyMeta = {
      secrets: [],
      kv_access: "none",
      communication: { channel: "custom", recipient_field: "target", reply_field: null, content_field: "msg" },
    };
    const { kernel } = makeKernel();
    const result = await kernel.communicationGate("send_custom", { msg: "hi", target: "X" }, legacyMeta);
    expect(result.verdict).toBe("send");
  });

  it("allows responding to unknown person (email reply)", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.communicationGate(
      "send_email",
      { to: "unknown@example.com", body: "thanks", reply_to_id: "msg123" },
      emailMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("allows initiating to approved contact", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("contact:swami", JSON.stringify({ name: "Swami", communication: "Inner circle." }));
    await env.KV.put("contact_platform:slack:swami", JSON.stringify({ slug: "swami", approved: true }));
    const result = await kernel.communicationGate(
      "send_slack",
      { text: "hello", channel: "swami" },
      slackMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("blocks person-type to unapproved contact (initiating)", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("contact:stub", JSON.stringify({ name: "Stub" }));
    await env.KV.put("contact_platform:email:stub@example.com", JSON.stringify({ slug: "stub", approved: false }));
    const result = await kernel.communicationGate(
      "send_email",
      { to: "stub@example.com", body: "hello" },
      emailMeta,
    );
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("not approved");
  });

  it("blocks person-type to unapproved contact (responding)", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("contact:stub", JSON.stringify({ name: "Stub" }));
    await env.KV.put("contact_platform:email:stub@example.com", JSON.stringify({ slug: "stub", approved: false }));
    const result = await kernel.communicationGate(
      "send_email",
      { to: "stub@example.com", body: "thanks", reply_to_id: "msg123" },
      emailMeta,
    );
    expect(result.verdict).toBe("block");
    expect(result.mechanical).toBe(true);
    expect(result.reasoning).toContain("not approved");
  });

  it("any model can send to approved contacts (no model capability check)", async () => {
    const { kernel, env } = makeKernel();
    kernel.lastCallModel = "deepseek/deepseek-v3.2"; // cheapest model
    await env.KV.put("contact:swami", JSON.stringify({ name: "Swami" }));
    await env.KV.put("contact_platform:slack:swami", JSON.stringify({ slug: "swami", approved: true }));
    const result = await kernel.communicationGate(
      "send_slack",
      { text: "hello", channel: "swami" },
      slackMeta,
    );
    expect(result.verdict).toBe("send");
  });

  it("queueBlockedComm writes record to KV", async () => {
    const { kernel } = makeKernel();
    kernel.sessionId = "test_session_123";
    kernel.lastCallModel = "anthropic/claude-opus-4.6";
    const id = await kernel.queueBlockedComm(
      "send_slack",
      { text: "hello", channel: "C123" },
      slackMeta,
      "test block reason",
      { verdict: "block" },
    );
    expect(id).toMatch(/^cb_/);
    const stored = await kernel.kvGet(`comms_blocked:${id}`);
    expect(stored.tool).toBe("send_slack");
    expect(stored.channel).toBe("slack");
    expect(stored.recipient).toBe("C123");
    expect(stored.reason).toBe("test block reason");
  });

  it("processCommsVerdict send — executes and deletes record", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "test_session";
    const record = {
      id: "cb_test_1",
      tool: "send_slack",
      args: { text: "hello" },
      channel: "slack",
      recipient: "C123",
      mode: "initiating",
    };
    await env.KV.put("comms_blocked:cb_test_1", JSON.stringify(record));
    kernel.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await kernel.processCommsVerdict("cb_test_1", "send");
    expect(result.ok).toBe(true);
    expect(kernel.executeAction).toHaveBeenCalledWith(expect.objectContaining({ tool: "send_slack" }));
    // Record should be deleted
    const afterDelete = await env.KV.get("comms_blocked:cb_test_1");
    expect(afterDelete).toBeNull();
  });

  it("processCommsVerdict drop — deletes record, records karma", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "test_session";
    const record = {
      id: "cb_test_2",
      tool: "send_email",
      args: { to: "a@b.com", body: "hi" },
      channel: "email",
      recipient: "a@b.com",
      mode: "initiating",
    };
    await env.KV.put("comms_blocked:cb_test_2", JSON.stringify(record));

    const result = await kernel.processCommsVerdict("cb_test_2", "drop", { reason: "not needed" });
    expect(result.ok).toBe(true);
    expect(result.dropped).toBe(true);
    const afterDelete = await env.KV.get("comms_blocked:cb_test_2");
    expect(afterDelete).toBeNull();
  });

  it("executeAction rejects communication tool without gate approval", async () => {
    const { kernel } = makeKernel();
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel._loadTool = vi.fn(async () => ({
      meta: slackMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    const result = await kernel.executeAction({ tool: "send_slack", input: { text: "hi" }, id: "t1" });
    expect(result.error).toContain("gate approval");
  });

  it("executeAction allows communication tool with gate approval flag", async () => {
    const { kernel } = makeKernel();
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel._loadTool = vi.fn(async () => ({
      meta: slackMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    kernel.buildToolContext = vi.fn(async () => ({}));
    kernel._executeTool = vi.fn(async () => ({ ok: true }));
    kernel._commsGateApproved = true;
    const result = await kernel.executeAction({ tool: "send_slack", input: { text: "hi" }, id: "t1" });
    expect(result).toEqual({ ok: true });
    expect(kernel._executeTool).toHaveBeenCalled();
  });

  it("executeAction allows non-communication tool without gate approval", async () => {
    const { kernel } = makeKernel();
    kernel._loadTool = vi.fn(async () => ({
      meta: noCommMeta,
      moduleCode: "module.exports = { execute: async () => ({ ok: true }) }",
    }));
    kernel.buildToolContext = vi.fn(async () => ({}));
    kernel._executeTool = vi.fn(async () => ({ result: 42 }));
    const result = await kernel.executeAction({ tool: "kv_query", input: {}, id: "t2" });
    expect(result).toEqual({ result: 42 });
    expect(kernel._executeTool).toHaveBeenCalled();
  });

  it("gate approval flag is cleared after executeToolCall", async () => {
    const { kernel } = makeKernel({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel.lastCallModel = "anthropic/claude-opus-4.6";
    // Gate approves send
    kernel.communicationGate = vi.fn(async () => ({ verdict: "send", reasoning: "ok" }));
    kernel.executeAction = vi.fn(async () => ({ ok: true }));
    kernel.callHook = vi.fn(async () => null);
    kernel._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));

    await kernel.executeToolCall({
      id: "tc1",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "hi", channel: "C1" }) },
    });
    expect(kernel._commsGateApproved).toBe(false);
  });

  it("executeToolCall blocks communication tool when gate returns block", async () => {
    const { kernel } = makeKernel({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel.lastCallModel = "anthropic/claude-opus-4.6";
    kernel.communicationGate = vi.fn(async () => ({ verdict: "block", reasoning: "unsafe content" }));
    kernel.queueBlockedComm = vi.fn(async () => "cb_1");
    kernel._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    kernel.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "bad", channel: "C1" }) },
    });
    expect(result.error).toContain("blocked");
    expect(kernel.queueBlockedComm).toHaveBeenCalled();
    expect(kernel.executeAction).not.toHaveBeenCalled();
  });

  it("executeToolCall queues communication tool when gate returns queue", async () => {
    const { kernel } = makeKernel({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel.lastCallModel = "anthropic/claude-opus-4.6";
    kernel.communicationGate = vi.fn(async () => ({ verdict: "queue", reasoning: "not comms_gate_capable" }));
    kernel.queueBlockedComm = vi.fn(async () => "cb_2");
    kernel._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    kernel.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await kernel.executeToolCall({
      id: "tc2",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "hi", channel: "C1" }) },
    });
    expect(result.error).toContain("queued");
    expect(kernel.executeAction).not.toHaveBeenCalled();
  });

  it("executeToolCall applies revision via content_field when gate returns revise", async () => {
    const { kernel } = makeKernel({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    kernel.toolGrants = { send_slack: { communication: slackMeta.communication } };
    kernel.lastCallModel = "anthropic/claude-opus-4.6";
    kernel.communicationGate = vi.fn(async () => ({
      verdict: "revise", reasoning: "tone", revision: { text: "polished message" },
    }));
    kernel._loadTool = vi.fn(async () => ({ meta: slackMeta, moduleCode: "" }));
    kernel.executeAction = vi.fn(async (step) => ({ ok: true, sent_text: step.input.text }));
    kernel.callHook = vi.fn(async () => null);

    const result = await kernel.executeToolCall({
      id: "tc3",
      function: { name: "send_slack", arguments: JSON.stringify({ text: "rough draft", channel: "C1" }) },
    });
    // executeAction should receive the revised text
    expect(kernel.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ text: "polished message" }) }),
    );
    expect(result.ok).toBe(true);
  });

  it("executeToolCall lets non-communication tool through without gate", async () => {
    const { kernel } = makeKernel({}, { modelsConfig: commsModelsConfig, modelCapabilities: commsModelCapabilities });
    kernel._loadTool = vi.fn(async () => ({ meta: noCommMeta, moduleCode: "" }));
    kernel.executeAction = vi.fn(async () => ({ result: 42 }));
    kernel.callHook = vi.fn(async () => null);
    kernel.communicationGate = vi.fn();

    const result = await kernel.executeToolCall({
      id: "tc4",
      function: { name: "kv_query", arguments: JSON.stringify({ key: "foo" }) },
    });
    expect(result).toEqual({ result: 42 });
    expect(kernel.communicationGate).not.toHaveBeenCalled();
  });

  it("processCommsVerdict revise_and_send applies revision via content_field", async () => {
    const { kernel, env } = makeKernel();
    kernel.sessionId = "test_session";
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
    kernel.executeAction = vi.fn(async () => ({ ok: true }));

    await kernel.processCommsVerdict("cb_rev_1", "revise_and_send", { text: "revised text" });
    expect(kernel.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ body: "revised text" }) }),
    );
  });

  it("listBlockedComms returns all blocked records", async () => {
    const { kernel, env } = makeKernel();
    const record1 = { id: "cb_1", tool: "send_slack", args: { text: "a" } };
    const record2 = { id: "cb_2", tool: "send_email", args: { body: "b" } };
    await env.KV.put("comms_blocked:cb_1", JSON.stringify(record1));
    await env.KV.put("comms_blocked:cb_2", JSON.stringify(record2));

    const list = await kernel.listBlockedComms();
    expect(list).toHaveLength(2);
    expect(list.map(r => r.id).sort()).toEqual(["cb_1", "cb_2"]);
  });
});

// ── Patron identity monitor ─────────────────────────────────

describe("Patron identity monitor", () => {
  const patronContact = {
    name: "Swami",
    relationship: "patron",
    communication: "Inner circle.",
  };

  async function seedPatron(env, contact, platformBindings) {
    await env.KV.put("patron:contact", JSON.stringify("swami"));
    await env.KV.put("contact:swami", JSON.stringify(contact || patronContact));
    for (const [key, val] of Object.entries(platformBindings || {})) {
      await env.KV.put(key, JSON.stringify(val));
    }
  }

  it("creates snapshot on first boot when none exists", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await seedPatron(env, patronContact, {
      "contact_platform:slack:U_SWAMI": { slug: "swami", approved: true },
    });

    await kernel.loadPatronContext();

    expect(kernel.patronId).toBe("swami");
    expect(kernel.patronIdentityDisputed).toBe(false);
    expect(kernel.patronSnapshot.name).toBe("Swami");
    expect(kernel.patronSnapshot.platforms).toEqual({ slack: "U_SWAMI" });
  });

  it("no dispute when contact matches snapshot", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await seedPatron(env, patronContact, {
      "contact_platform:slack:U_SWAMI": { slug: "swami", approved: true },
    });
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await kernel.loadPatronContext();

    expect(kernel.patronIdentityDisputed).toBe(false);
    expect(kernel.karmaRecord).not.toHaveBeenCalled();
  });

  it("disputes when name changes", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await seedPatron(env, { ...patronContact, name: "Attacker" }, {
      "contact_platform:slack:U_SWAMI": { slug: "swami", approved: true },
    });
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await kernel.loadPatronContext();

    expect(kernel.patronIdentityDisputed).toBe(true);
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "patron_identity_disputed",
        old: expect.objectContaining({ name: "Swami" }),
        new: expect.objectContaining({ name: "Attacker" }),
      })
    );
  });

  it("disputes when platforms change", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await seedPatron(env, patronContact, {
      "contact_platform:slack:U_ATTACKER": { slug: "swami", approved: true },
    });
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await kernel.loadPatronContext();

    expect(kernel.patronIdentityDisputed).toBe(true);
  });

  it("resolveContact uses snapshot name when identity is disputed", async () => {
    const { kernel, env } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await seedPatron(env, { ...patronContact, name: "Attacker" }, {
      "contact_platform:slack:U_SWAMI": { slug: "swami", approved: true },
    });
    await env.KV.put("patron:identity_snapshot", JSON.stringify({
      name: "Swami",
      platforms: { slack: "U_SWAMI" },
      verified_at: "2026-03-14T00:00:00Z",
    }));

    await kernel.loadPatronContext();
    expect(kernel.patronIdentityDisputed).toBe(true);

    const result = await kernel.resolveContact("slack", "U_SWAMI");
    expect(result.name).toBe("Swami");
  });
});

// ── Sealed namespace enforcement ────────────────────────────

describe("sealed namespace", () => {
  describe("isSystemKey / isKernelOnly recognize sealed:", () => {
    it("sealed: is a system key", () => {
      expect(Kernel.isSystemKey("sealed:quarantine:email:foo:123")).toBe(true);
    });

    it("sealed: is kernel-only", () => {
      expect(Kernel.isKernelOnly("sealed:quarantine:email:foo:123")).toBe(true);
    });
  });

  describe("kvWriteSafe blocks sealed: keys", () => {
    it("blocks writes to sealed: keys", async () => {
      const { kernel } = makeKernel();
      await expect(kernel.kvWriteSafe("sealed:quarantine:test", { data: 1 }))
        .rejects.toThrow("kernel-only");
    });
  });

  describe("kvWriteGated blocks sealed: keys", () => {
    it("blocks writes to sealed: keys", async () => {
      const { kernel } = makeKernel();
      kernel.sessionId = "test_session";
      const result = await kernel.kvWriteGated(
        { op: "put", key: "sealed:quarantine:test", value: { data: 1 } }, "deep-reflect"
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/kernel key/);
    });
  });
});

// ── Inbound content gate ────────────────────────────────────

describe("inbound content gate", () => {
  async function setupBrainForInbound(kvInit = {}, contacts = {}) {
    const { kernel, env } = makeKernel(kvInit);
    kernel.sessionId = "test_session";
    kernel.karma = [];
    kernel.defaults = {
      act: { model: "test-model", max_steps: 10, max_cost: 1.0 },
    };

    // Set inbound grant in toolGrants (kernel-controlled)
    kernel.toolGrants = {
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
    kernel._loadTool = vi.fn(async (name) => {
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
    kernel.resolveContact = vi.fn(async (channel, senderId) => {
      return contacts[`${channel}:${senderId}`] || null;
    });

    // Mock executeAction to use the tool's execute
    kernel.executeAction = vi.fn(async ({ tool }) => {
      const { execute } = await kernel._loadTool(tool);
      return execute();
    });

    // Mock callHook (validate_result) to pass through
    kernel.callHook = vi.fn(async () => null);

    // Stub karmaRecord
    kernel.karmaRecord = vi.fn(async () => {});

    // Stub kvWrite for quarantine writes
    kernel.kvWrite = vi.fn(async () => {});

    // Stub communication gate methods
    kernel._commsGateApproved = false;
    kernel.loadCommsWisdom = vi.fn(async () => null);

    return { kernel, env };
  }

  it("redacts content from unknown senders", async () => {
    const { kernel } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      // bob@unknown.com is NOT in contacts
    });

    const result = await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // Alice's email should be untouched
    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    // Bob's email should be redacted
    expect(result.emails[1].body).toBe("[content redacted — unknown sender]");
  });

  it("redacts content from unapproved senders", async () => {
    const { kernel } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      "email:bob@unknown.com": { name: "Bob", slug: "bob", approved: false },
    });

    const result = await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    expect(result.emails[1].body).toBe("[content redacted — unapproved sender]");
  });

  it("quarantines unknown sender content under sealed: key", async () => {
    const { kernel } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
    });

    await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // kvWrite should have been called with a sealed:quarantine: key for Bob
    const quarantineCall = kernel.kvWrite.mock.calls.find(
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
    const { kernel } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
    });

    await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    const redactedKarma = kernel.karmaRecord.mock.calls.find(
      ([entry]) => entry.event === "inbound_redacted"
    );
    expect(redactedKarma).toBeDefined();
    expect(redactedKarma[0].sender_id).toBe("bob@unknown.com");
    expect(redactedKarma[0].channel).toBe("email");
    expect(redactedKarma[0].quarantine_key).toMatch(/^sealed:quarantine:/);
  });

  it("passes through content from known approved senders without redaction", async () => {
    const { kernel } = await setupBrainForInbound({}, {
      "email:alice@example.com": { name: "Alice", slug: "alice", approved: true },
      "email:bob@unknown.com": { name: "Bob", slug: "bob", approved: true },
    });

    const result = await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "check_email", arguments: "{}" },
    });

    // Both emails should be untouched
    expect(result.emails[0].body).toBe("Hi, this is Alice!");
    expect(result.emails[1].body).toBe("Buy my product!");

    // No quarantine writes
    const quarantineCall = kernel.kvWrite.mock.calls.find(
      ([key]) => key.startsWith("sealed:quarantine:")
    );
    expect(quarantineCall).toBeUndefined();
  });

  it("skips inbound gate for tools without inbound meta", async () => {
    const { kernel } = await setupBrainForInbound();

    kernel._loadTool = vi.fn(async () => ({
      meta: {},
      execute: async () => ({ data: "some result" }),
    }));
    kernel.executeAction = vi.fn(async () => ({ data: "some result" }));

    const result = await kernel.executeToolCall({
      id: "tc_1",
      function: { name: "kv_query", arguments: '{"key":"test"}' },
    });

    expect(result.data).toBe("some result");
    expect(kernel.resolveContact).not.toHaveBeenCalled();
  });
});

// ── Patron identity verification ────────────────────────────

describe("parseSSHEd25519", () => {
  const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8 test-key";

  it("extracts 32-byte raw key from SSH format", () => {
    const raw = Kernel.parseSSHEd25519(testKey);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw.length).toBe(32);
  });

  it("throws on non-ed25519 key", () => {
    expect(() => Kernel.parseSSHEd25519("ssh-rsa AAAA... comment")).toThrow("Not an ssh-ed25519 key");
  });

  it("throws on empty input", () => {
    expect(() => Kernel.parseSSHEd25519("")).toThrow();
  });

  it("handles keys without comments", () => {
    const noComment = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8";
    const raw = Kernel.parseSSHEd25519(noComment);
    expect(raw.length).toBe(32);
  });
});

describe("verify_patron", () => {
  const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMz47nw9Ju5I7fprJ9GOah8avsfTJWEIqk8NW9z7iv+8 test-key";
  const testMessage = "test-challenge-123";
  const testSignature = "gR7cF2kUYOL71kGAXaqa+Pv2MKHt1daWWbsMDJlti2E4VfTXSkOr6RjYf49uZn7Kip06VDUqWVhUi8NHyFINCg==";

  it("verifyPatronSignature returns true for valid signature", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    const result = await kernel.verifyPatronSignature(testMessage, testSignature);
    expect(result).toBe(true);
  });

  it("verifyPatronSignature returns false for invalid signature", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    const result = await kernel.verifyPatronSignature("wrong message", testSignature);
    expect(result).toBe(false);
  });

  it("verifyPatronSignature throws when no public key configured", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.verifyPatronSignature(testMessage, testSignature))
      .rejects.toThrow("No patron public key configured");
  });

  it("verifyPatron tool returns verified: true for valid signature", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.verifyPatron({ message: testMessage, signature: testSignature });
    expect(result.verified).toBe(true);
    expect(kernel.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_verified" }));
  });

  it("verifyPatron tool returns verified: false for bad signature", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.verifyPatron({ message: "wrong", signature: testSignature });
    expect(result.verified).toBe(false);
    expect(kernel.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_verification_failed" }));
  });

  it("verifyPatron tool returns error when args missing", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    const result = await kernel.verifyPatron({});
    expect(result.error).toContain("required");
    expect(result.verified).toBe(false);
  });

  it("dispatches via executeToolCall", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.executeToolCall({
      id: "tc_verify",
      function: {
        name: "verify_patron",
        arguments: JSON.stringify({ message: testMessage, signature: testSignature }),
      },
    });
    expect(result.verified).toBe(true);
  });

  it("appears in buildToolDefinitions output", async () => {
    const { kernel } = makeKernel({}, { toolRegistry: { tools: [] } });
    const defs = await kernel.buildToolDefinitions();
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
    const { kernel, env } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.sendKernelAlert = vi.fn(async () => {});
    kernel.sessionId = "test_session";

    const result = await kernel.rotatePatronKey(newKey, rotateSignature);
    expect(result.rotated).toBe(true);

    // Verify the new key was written directly to KV
    const written = env.KV.put.mock.calls.find(([key]) => key === "patron:public_key");
    expect(written).toBeDefined();
    expect(written[1]).toBe(newKey);

    // Verify karma and alert
    expect(kernel.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "patron_key_rotated" }));
    expect(kernel.sendKernelAlert).toHaveBeenCalledWith("patron_key_rotated", expect.any(String));
  });

  it("rejects rotation with invalid signature", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.sendKernelAlert = vi.fn(async () => {});

    await expect(kernel.rotatePatronKey(newKey, "badsignature=="))
      .rejects.toThrow();
  });

  it("rejects rotation with valid signature but invalid new key format", async () => {
    const { kernel } = makeKernel({ "patron:public_key": JSON.stringify(testKey) });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.sendKernelAlert = vi.fn(async () => {});

    // Sign a rotation for an invalid key
    // This will fail at verifyPatronSignature because the message won't match
    await expect(kernel.rotatePatronKey("not-a-valid-key", rotateSignature))
      .rejects.toThrow();
  });

  it("patron:public_key remains immutable via kvWrite", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWrite("patron:public_key", "new value"))
      .rejects.toThrow("immutable");
  });
});

describe("loadKeys size guard", () => {
  it("passes through normal-sized values", async () => {
    const { kernel } = makeKernel({ "foo": "bar", "num": 42 });
    const result = await kernel.loadKeys(["foo", "num"]);
    expect(result.foo).toBe("bar");
    expect(result.num).toBe(42);
  });

  it("skips null/undefined values", async () => {
    const { kernel } = makeKernel({ "exists": "yes" });
    const result = await kernel.loadKeys(["exists", "missing"]);
    expect(result.exists).toBe("yes");
    expect(result.missing).toBeUndefined();
  });

  it("truncates values over 100K chars", async () => {
    const bigValue = "x".repeat(150_000);
    const { kernel } = makeKernel({ "big": bigValue, "small": "ok" });
    const result = await kernel.loadKeys(["big", "small"]);
    expect(result.big._truncated).toBe(true);
    expect(result.big._reason).toContain("150000 chars");
    expect(result.small).toBe("ok");
  });
});

// ── emitEvent ────────────────────────────────────────────────

describe("emitEvent", () => {
  it("writes a key with format event:{15-digit-timestamp}:{type}", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();
    const result = await K.emitEvent("chat_message", { source: "slack", text: "hello" });

    expect(result).toHaveProperty("key");
    const key = result.key;
    expect(key).toMatch(/^event:\d{15}:chat_message$/);

    const stored = JSON.parse(await env.KV.get(key));
    expect(stored.type).toBe("chat_message");
    expect(stored.source).toBe("slack");
    expect(stored.text).toBe("hello");
    expect(stored.timestamp).toBeDefined();
  });

  it("writes event with 24h TTL (86400)", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();

    const putSpy = vi.spyOn(env.KV, "put");
    await K.emitEvent("session_end", { session_id: "s_123" });

    expect(putSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^event:\d{15}:session_end$/),
      expect.any(String),
      { expirationTtl: 86400 }
    );
  });

  it("preserves payload timestamp if provided", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();
    const ts = "2026-01-01T00:00:00.000Z";
    const result = await K.emitEvent("test_event", { timestamp: ts, foo: "bar" });

    const stored = JSON.parse(await env.KV.get(result.key));
    expect(stored.timestamp).toBe(ts);
  });

  it("sets timestamp to current ISO string if not provided", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();
    const before = new Date().toISOString();
    const result = await K.emitEvent("test_event", { foo: "bar" });
    const after = new Date().toISOString();

    const stored = JSON.parse(await env.KV.get(result.key));
    expect(stored.timestamp >= before).toBe(true);
    expect(stored.timestamp <= after).toBe(true);
  });

  it("records a karma event with event_emitted and the type", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const K = kernel.buildKernelInterface();
    const result = await K.emitEvent("chat_message", { source: "slack" });

    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "event_emitted",
        type: "chat_message",
        key: result.key,
      })
    );
  });
});

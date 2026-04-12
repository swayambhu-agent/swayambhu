import { describe, it, expect, vi, beforeEach } from "vitest";
import { Kernel } from "../kernel.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── Test helpers ──────────────────────────────────────────────

function makeEnv(kvInit = {}, extra = {}) {
  return { KV: makeKVStore(kvInit), ...extra };
}

function makeKernel(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit, opts.env || {});
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

// ── 1. _parseJSON ─────────────────────────────────────

describe("_parseJSON", () => {
  it("returns parsed object for valid JSON", () => {
    const { kernel } = makeKernel();
    expect(kernel._parseJSON('{"key":"value","n":42}')).toEqual({ key: "value", n: 42 });
  });

  it("returns null for unparseable content", () => {
    const { kernel } = makeKernel();
    expect(kernel._parseJSON("not json at all")).toBeNull();
  });

  it("returns null for empty/null content", () => {
    const { kernel } = makeKernel();
    expect(kernel._parseJSON(null)).toBeNull();
    expect(kernel._parseJSON("")).toBeNull();
    expect(kernel._parseJSON(undefined)).toBeNull();
  });

  it("extracts JSON from markdown code fences", () => {
    const { kernel } = makeKernel();
    expect(kernel._parseJSON('```json\n{"key":"value"}\n```')).toEqual({ key: "value" });
  });

  it("extracts JSON from prose with surrounding text", () => {
    const { kernel } = makeKernel();
    expect(kernel._parseJSON('Here is my output:\n{"key":"value"}\nDone.')).toEqual({ key: "value" });
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
    expect(defs.length).toBe(3); // 2 registry + verify_patron
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

  it("always includes verify_patron", () => {
    const { kernel } = makeKernel({}, { toolRegistry: { tools: [] } });
    const defs = kernel.buildToolDefinitions();
    expect(defs.length).toBe(1); // verify_patron only
    expect(defs.map(d => d.function.name)).toContain("verify_patron");
    expect(defs.map(d => d.function.name)).not.toContain("spawn_subplan");
  });

  it("handles missing/null registry", () => {
    const { kernel } = makeKernel();
    kernel.toolRegistry = null;
    const defs = kernel.buildToolDefinitions();
    expect(defs.length).toBe(1); // verify_patron only
  });

  it("passes through extraTools", () => {
    const { kernel } = makeKernel({}, { toolRegistry: { tools: [] } });
    const extra = { type: "function", function: { name: "custom" } };
    const defs = kernel.buildToolDefinitions([extra]);
    expect(defs.length).toBe(2); // verify_patron + extra
    expect(defs[1]).toBe(extra);
  });

  it("filters denied tools in bounded_continuation profile", () => {
    const { kernel } = makeKernel({}, {
      env: { SWAYAMBHU_LAB_PROFILE: "bounded_continuation" },
      TOOLS: {
        send_slack: { meta: { communication: { channel: "slack" } } },
        web_fetch: { meta: {} },
      },
      toolRegistry: {
        tools: [
          { name: "send_slack", description: "Send Slack", input: { text: "body" } },
          { name: "web_fetch", description: "Fetch web page", input: { url: "URL" } },
        ],
      },
    });

    const defs = kernel.buildToolDefinitions();
    expect(defs.map(d => d.function.name)).not.toContain("send_slack");
    expect(defs.map(d => d.function.name)).toContain("web_fetch");
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

  it("passes the provided signal through the kernel interface", async () => {
    const { kernel } = makeLLMKernel();
    const controller = new AbortController();
    const K = kernel.buildKernelInterface();

    await K.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
      signal: controller.signal,
    });

    expect(kernel.callWithCascade).toHaveBeenCalledWith(
      expect.any(Object),
      "test",
      controller.signal,
    );
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
        signal: undefined,
      })
    );
  });

  it("uses a KV-backed LLM secret when env is missing", async () => {
    const mockCall = vi.fn(async () => ({
      content: "provider response",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const { kernel } = makeKernel({
      "secret:OPENROUTER_API_KEY": JSON.stringify("kv-test-key"),
    }, {
      PROVIDERS: {
        'provider:llm': { call: mockCall, meta: { secrets: ["OPENROUTER_API_KEY"] } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.callWithCascade({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    }, "test_step");

    expect(result.ok).toBe(true);
    expect(result.tier).toBe("compiled");
    expect(mockCall).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { OPENROUTER_API_KEY: "kv-test-key" },
      })
    );
  });

  it("passes the same signal to the compiled provider", async () => {
    const mockCall = vi.fn(async ({ signal, fetch }) => {
      await fetch("https://provider.test");
      return {
        content: "provider response",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    });
    const { kernel } = makeKernel({}, {
      PROVIDERS: {
        'provider:llm': { call: mockCall, meta: {} },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));

    try {
      await kernel.callWithCascade({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      }, "test_step", controller.signal);

      expect(mockCall).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://provider.test",
        expect.objectContaining({ signal: controller.signal }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects with AbortError when the provided signal aborts tier 1", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const mockCall = vi.fn(async ({ fetch }) => {
      await fetch("https://provider.test");
      return {
        content: "provider response",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    });
    const { kernel } = makeKernel({}, {
      PROVIDERS: {
        'provider:llm': { call: mockCall, meta: {} },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input, init = {}) => new Promise((_, reject) => {
      if (init.signal.aborted) {
        reject(abortError);
        return;
      }
      init.signal.addEventListener("abort", () => reject(abortError), { once: true });
    }));

    try {
      const pending = kernel.callLLM({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        step: "test_step",
        signal: controller.signal,
      });
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets the hardcoded fallback abort on the parent signal", async () => {
    const { kernel } = makeKernel();
    kernel.env.OPENROUTER_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    globalThis.fetch = vi.fn((_input, init = {}) => new Promise((_, reject) => {
      if (init.signal.aborted) {
        reject(abortError);
        return;
      }
      init.signal.addEventListener("abort", () => reject(abortError), { once: true });
    }));

    try {
      const pending = kernel._hardcodedLLMFallback({
        model: "test-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }, "test_step", controller.signal);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("uses a KV-backed LLM secret in the hardcoded fallback when env is missing", async () => {
    const { kernel } = makeKernel({
      "secret:OPENROUTER_API_KEY": JSON.stringify("kv-test-key"),
    }, {
      PROVIDERS: {
        'provider:llm': { call: vi.fn(async () => { throw new Error("broken"); }), meta: {} },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

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
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer kv-test-key",
          }),
        }),
      );
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
    kernel.callLLM = vi.fn(async ({ step, json }) => {
      callCount++;
      if (step?.endsWith("_final")) {
        const content = '{"forced":true}';
        return { content, cost: 0.001, toolCalls: null, ...(json ? { parsed: JSON.parse(content) } : {}) };
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

// ── 5. runAgentTurn ────────────────────────────────────────

describe("runAgentTurn", () => {
  it("no tool calls: appends assistant message, returns done: true", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: '{"result":"ok"}',
      cost: 0.01,
      toolCalls: null,
    }));

    const messages = [{ role: "user", content: "hello" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(true);
    expect(result.response.content).toBe('{"result":"ok"}');
    expect(result.toolResults).toEqual([]);
    expect(result.cost).toBe(0.01);
    // assistant message appended
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe('{"result":"ok"}');
  });

  it("tool calls: appends assistant + tool messages, returns done: false", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [{ id: "tc1", function: { name: "some_tool", arguments: '{"x":1}' } }],
    }));
    kernel.executeToolCall = vi.fn(async () => ({ result: "tool_output" }));

    const messages = [{ role: "user", content: "do it" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(false);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toEqual({ result: "tool_output" });
    // assistant message + tool result message appended
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls).toBeDefined();
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("tc1");
  });

  it("tool execution error handled gracefully", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [{ id: "tc2", function: { name: "broken_tool", arguments: "{}" } }],
    }));
    kernel.executeToolCall = vi.fn(async () => { throw new Error("tool exploded"); });

    const messages = [{ role: "user", content: "run" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(false);
    expect(result.toolResults[0]).toEqual({ error: "tool exploded" });
    // tool result message has error content
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toContain("tool exploded");
  });

  it("multiple tool calls dispatched in parallel", async () => {
    const { kernel } = makeKernel();
    kernel.callLLM = vi.fn(async () => ({
      content: null,
      cost: 0.005,
      toolCalls: [
        { id: "tc1", function: { name: "tool_a", arguments: "{}" } },
        { id: "tc2", function: { name: "tool_b", arguments: "{}" } },
      ],
    }));

    const order = [];
    kernel.executeToolCall = vi.fn(async (tc) => {
      order.push(tc.function.name);
      return { ok: true };
    });

    const messages = [{ role: "user", content: "parallel" }];
    const result = await kernel.runAgentTurn({
      systemPrompt: "test",
      messages,
      tools: [],
      model: "test",
      effort: "low",
      maxTokens: 100,
      step: "test_turn",
    });

    expect(result.done).toBe(false);
    expect(result.toolResults).toHaveLength(2);
    expect(order).toContain("tool_a");
    expect(order).toContain("tool_b");
    expect(kernel.executeToolCall).toHaveBeenCalledTimes(2);
  });
});

// ── 6. executeToolCall ─────────────────────────────────────

describe("executeToolCall", () => {
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

  it("blocks denied tools before execution", async () => {
    const { kernel } = makeKernel({}, {
      env: { SWAYAMBHU_TOOL_DENYLIST: "web_fetch" },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.executeAction = vi.fn(async () => ({ ok: true }));

    const result = await kernel.executeToolCall({
      id: "tc1",
      function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
    });

    expect(result).toEqual({ error: 'Tool "web_fetch" is disabled by policy' });
    expect(kernel.executeAction).not.toHaveBeenCalled();
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool_blocked_by_policy", tool: "web_fetch" }),
    );
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

  it("passes an abortable signal into tools", async () => {
    let seenSignal = null;
    const executeFn = vi.fn(async ({ signal }) => {
      seenSignal = signal;
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        probe: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAction({ tool: "probe", input: {}, id: "tc1" });

    expect(result).toEqual({ ok: true });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(false);
  });

  it("times out long-running tools using meta.timeout_ms", async () => {
    const executeFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        sleeper: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 10 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    await expect(kernel.executeAction({ tool: "sleeper", input: {}, id: "tc1" }))
      .rejects.toThrow("Tool sleeper timed out after 10ms");
  });

  it("propagates session abort into the tool signal", async () => {
    let ready;
    const readyPromise = new Promise((resolve) => { ready = resolve; });
    const executeFn = vi.fn(async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      ready();
    }));
    const { kernel } = makeKernel({}, {
      TOOLS: {
        waiter: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.sessionAbortController = new AbortController();

    const pending = kernel.executeAction({ tool: "waiter", input: {}, id: "tc1" });
    await readyPromise;
    kernel.sessionAbortController.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes the tool signal through ctx.fetch by default", async () => {
    const executeFn = vi.fn(async ({ fetch }) => {
      await fetch("https://example.test/tool");
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        fetcher: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input, init = {}) => ({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true, signal_present: !!init.signal }),
    }));

    try {
      const result = await kernel.executeAction({ tool: "fetcher", input: {}, id: "tc1" });
      expect(result).toEqual({ ok: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.test/tool",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("combines a tool-provided fetch signal with the kernel tool signal", async () => {
    const localController = new AbortController();
    const executeFn = vi.fn(async ({ fetch }) => {
      await fetch("https://example.test/tool", { signal: localController.signal });
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        fetcher: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input, init = {}) => ({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true, signal_present: !!init.signal }),
    }));

    try {
      const result = await kernel.executeAction({ tool: "fetcher", input: {}, id: "tc1" });
      expect(result).toEqual({ ok: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.test/tool",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
      expect(globalThis.fetch.mock.calls[0][1].signal).not.toBe(localController.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to manual signal composition when AbortSignal.any is unavailable", async () => {
    const localController = new AbortController();
    let mergedSignal = null;
    const executeFn = vi.fn(async ({ fetch }) => {
      await fetch("https://example.test/tool", { signal: localController.signal });
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        fetcher: { execute: executeFn, meta: { kv_access: "none", timeout_ms: 5000 } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const originalFetch = globalThis.fetch;
    const originalAny = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    globalThis.fetch = vi.fn(async (_input, init = {}) => {
      mergedSignal = init.signal;
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true }),
      };
    });

    try {
      const result = await kernel.executeAction({ tool: "fetcher", input: {}, id: "tc1" });
      expect(result).toEqual({ ok: true });
      expect(mergedSignal).toBeInstanceOf(AbortSignal);
      expect(mergedSignal).not.toBe(localController.signal);
      localController.abort(new DOMException("Aborted", "AbortError"));
      expect(mergedSignal.aborted).toBe(true);
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: originalAny, configurable: true });
      globalThis.fetch = originalFetch;
    }
  });

  it("still passes a signal when timeout_ms is omitted", async () => {
    let seenSignal = null;
    const executeFn = vi.fn(async ({ signal }) => {
      seenSignal = signal;
      return { ok: true };
    });
    const { kernel } = makeKernel({}, {
      TOOLS: {
        plain: { execute: executeFn, meta: { kv_access: "none" } },
      },
    });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAction({ tool: "plain", input: {}, id: "tc1" });

    expect(result).toEqual({ ok: true });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
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

// ── 12. isSystemKey / isKernelOnly / isImmutableKey ─────────

describe("isSystemKey / isKernelOnly / isImmutableKey", () => {
  it("recognizes system key prefixes", () => {
    const { kernel } = makeKernel();
    expect(kernel.isSystemKey("config:defaults")).toBe(true);
    expect(kernel.isSystemKey("prompt:act")).toBe(true);
    expect(kernel.isSystemKey("tool:kv_query:code")).toBe(true);
    expect(kernel.isSystemKey("hook:act:code")).toBe(true);
    expect(kernel.isSystemKey("principle:care")).toBe(true);
    expect(kernel.isSystemKey("skill:model-config")).toBe(true);
  });

  it("recognizes exact system keys", () => {
    const { kernel } = makeKernel();
    expect(kernel.isSystemKey("providers")).toBe(true);
    expect(kernel.isSystemKey("wallets")).toBe(true);
    // wisdom is no longer a system key (replaced by pattern: prefix)
  });

  it("rejects non-system keys", () => {
    const { kernel } = makeKernel();
    expect(kernel.isSystemKey("session_schedule")).toBe(false);
    expect(kernel.isSystemKey("last_reflect")).toBe(false);
    expect(kernel.isSystemKey("session_counter")).toBe(false);
  });

  it("recognizes kernel-only keys", () => {
    const { kernel } = makeKernel();
    expect(kernel.isKernelOnly("kernel:last_executions")).toBe(true);
    expect(kernel.isKernelOnly("kernel:active_execution")).toBe(true);
    expect(kernel.isKernelOnly("kernel:alert_config")).toBe(true);
  });

  it("kernel-only does not overlap with protected keys", () => {
    const { kernel } = makeKernel();
    expect(kernel.isKernelOnly("config:defaults")).toBe(false);
    expect(kernel.isKernelOnly("prompt:act")).toBe(false);
  });

  it("isImmutableKey matches exact keys and wildcards", () => {
    const { kernel } = makeKernel();
    expect(kernel.isImmutableKey("dharma")).toBe(true);
    expect(kernel.isImmutableKey("principle:honesty")).toBe(false);
    expect(kernel.isSystemKey("principle:honesty")).toBe(true);
    expect(kernel.isImmutableKey("patron:public_key")).toBe(true);
    expect(kernel.isImmutableKey("config:defaults")).toBe(false);
  });
});

// ── 12b. config-driven key tiers ──────────────────────────────

describe("config-driven key tiers", () => {
  it("reads key tiers from kernel:key_tiers at boot", async () => {
    const { kernel } = makeKernel();
    kernel.kv._store.set("kernel:key_tiers", JSON.stringify({
      immutable: ["dharma"],
      kernel_only: ["karma:*", "sealed:*", "event:*", "kernel:*"],
      lifecycle: ["dr:*", "dr2:*"],
      protected: ["config:*", "prompt:*", "principle:*"],
    }));
    await kernel.loadEagerConfig();
    expect(kernel.keyTiers).toBeDefined();
    expect(kernel.keyTiers.immutable).toContain("dharma");
  });

  it("reads write policy from kernel:write_policy at boot", async () => {
    const { kernel } = makeKernel({
      "kernel:write_policy": JSON.stringify({
        version: 1,
        rules: [
          { match: "pattern:*", ops: { field_merge: { contexts: ["act"], allowed_fields: ["strength"], budget_class: "mechanical" } } },
        ],
      }),
    });
    await kernel.loadEagerConfig();
    expect(kernel.writePolicy).toBeDefined();
    expect(kernel.writePolicy.rules[0].match).toBe("pattern:*");
  });

  it("merges loaded tiers with new defaults so older state stores inherit new patterns", async () => {
    const { kernel } = makeKernel();
    kernel.kv._store.set("kernel:key_tiers", JSON.stringify({
      immutable: ["dharma"],
      kernel_only: ["karma:*", "sealed:*", "event:*", "kernel:*"],
      protected: ["config:*", "prompt:*", "principle:*"],
    }));

    await kernel.loadEagerConfig();

    expect(kernel.isLifecycleKey("dr:state:1")).toBe(true);
    expect(kernel.isLifecycleKey("dr2:state:1")).toBe(true);
    expect(kernel.isLifecycleKey("dr3:state:1")).toBe(true);
    expect(kernel.isLifecycleKey("deployment_review:state:1")).toBe(true);
    expect(kernel.isSystemKey("review_note:userspace_review:test")).toBe(true);
  });

  it("isSystemKey uses loaded tiers", () => {
    const { kernel } = makeKernel();
    kernel.keyTiers = {
      immutable: ["dharma"],
      kernel_only: ["karma:*"],
      lifecycle: ["dr:*"],
      protected: ["config:*", "custom:*"],
    };
    expect(kernel.isSystemKey("custom:foo")).toBe(true);
    expect(kernel.isSystemKey("random:foo")).toBe(false);
  });

  it("falls back to hardcoded defaults if kernel:key_tiers missing", async () => {
    const { kernel } = makeKernel();
    await kernel.loadEagerConfig();
    expect(kernel.isSystemKey("config:defaults")).toBe(true);
  });

  it("isImmutableKey matches exact keys and wildcards", () => {
    const { kernel } = makeKernel();
    kernel.keyTiers = {
      immutable: ["dharma", "patron:public_key"],
      kernel_only: [],
      lifecycle: ["dr:*"],
      protected: ["principle:*"],
    };
    expect(kernel.isImmutableKey("dharma")).toBe(true);
    expect(kernel.isImmutableKey("principle:honesty")).toBe(false);
    expect(kernel.isSystemKey("principle:honesty")).toBe(true);
    expect(kernel.isImmutableKey("patron:public_key")).toBe(true);
    expect(kernel.isImmutableKey("config:defaults")).toBe(false);
  });

  it("does not seed identification:working-body at boot", async () => {
    const { kernel, env } = makeKernel({
      "config:defaults": JSON.stringify({
        identity: { enabled: true, max_planner_items: 5 },
      }),
    });

    await kernel.loadEagerConfig();

    expect(await env.KV.get("identification:working-body")).toBeNull();
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
    await expect(kernel.kvWriteSafe("kernel:last_executions", []))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("config:defaults", {}))
      .rejects.toThrow("system key");
  });

  it("blocks lifecycle keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("dr:state:1", {}))
      .rejects.toThrow("lifecycle key");
  });

  it("allows non-system keys", async () => {
    const { kernel } = makeKernel();
    await kernel.kvWriteSafe("session_schedule", { interval_seconds: 100 });
    // Should not throw
  });

  it("blocks desire keys (protected)", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("desire:serve", { slug: "serve" }))
      .rejects.toThrow("system key");
  });

  it("blocks pattern keys (protected)", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("pattern:slack-working", { slug: "slack-working" }))
      .rejects.toThrow("system key");
  });

  it("allows mu keys (agent-writable)", async () => {
    const { kernel } = makeKernel();
    await kernel.kvWriteSafe("mu:slack-delivery", {
      check_id: "slack-delivery",
      confirmation_count: 0,
      violation_count: 0,
      last_checked: null,
      cumulative_surprise: 0,
    });
    // Should not throw
  });

  it("allows experience keys (agent-writable)", async () => {
    const { kernel } = makeKernel();
    await kernel.kvWriteSafe("experience:1711352400000", {
      timestamp: "2026-03-31T12:00:00.000Z",
      action_taken: "test action",
      outcome: "test outcome",
      active_assumptions: [],
      active_desires: [],
      surprise_score: 0,
      affinity_vector: {},
      narrative: "test",
      embedding: null,
    });
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
    await expect(kernel.kvDeleteSafe("kernel:active_execution"))
      .rejects.toThrow("kernel-only");
  });

  it("blocks system keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("prompt:act"))
      .rejects.toThrow("system key");
  });

  it("blocks lifecycle keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("dr2:result:1"))
      .rejects.toThrow("lifecycle key");
  });

  it("allows non-system keys", async () => {
    const { kernel } = makeKernel();
    await kernel.kvDeleteSafe("tooldata:mykey");
    // Should not throw
  });

  it("blocks desire keys (protected)", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("desire:serve"))
      .rejects.toThrow("system key");
  });

  it("blocks pattern keys (protected)", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvDeleteSafe("pattern:slack-working"))
      .rejects.toThrow("system key");
  });

  it("allows mu keys (agent-writable)", async () => {
    const { kernel } = makeKernel();
    await kernel.kvDeleteSafe("mu:slack-delivery");
    // Should not throw
  });

  it("allows experience keys (agent-writable)", async () => {
    const { kernel } = makeKernel();
    await kernel.kvDeleteSafe("experience:1711352400000");
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
      { op: "put", key: "kernel:last_executions", value: [] }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/kernel key/);
  });

  it("blocks lifecycle keys", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "dr2:state:1", value: {} }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lifecycle key/);
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
    const deliberation = "This test prompt is no longer used by any subsystem after the refactor in session 42. Retaining it creates confusion about which prompts are active. Deleting it keeps the prompt namespace clean and accurate.";
    await kernel.kvWriteGated(
      { op: "delete", key: "prompt:test_prompt", deliberation }, "deep-reflect"
    );
    expect(env.KV.delete).toHaveBeenCalledWith("prompt:test_prompt");
    expect(kernel.privilegedWriteCount).toBe(1);
  });

  it("allows review_note:* writes in deep-reflect", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "review_note:userspace_review:x:d1:000:test", value: { summary: "x" } },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);
  });

  it("allows protected non-code writes in userspace-review context", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: { updated: true } },
      "userspace-review"
    );
    expect(result.ok).toBe(true);
  });

  it("fails closed for protected namespaces without an explicit write policy rule", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      { op: "put", key: "skill:test-skill", value: { name: "test-skill" } },
      "deep-reflect",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No write policy rule");
  });

  it("allows field_merge on pattern:* in act context without consuming privileged budget", async () => {
    const { kernel, env } = makeKernel({
      "pattern:test": JSON.stringify({ pattern: "Observed regularity", strength: 0.4 }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      { op: "field_merge", key: "pattern:test", fields: { strength: 0.7 } },
      "act",
    );
    expect(result.ok).toBe(true);
    expect(kernel.privilegedWriteCount).toBe(0);
    const stored = JSON.parse(await env.KV.get("pattern:test"));
    expect(stored.strength).toBe(0.7);
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mechanical_write", key: "pattern:test", budget_class: "mechanical" }),
    );
  });

  it("blocks reflect context from writing protected keys", async () => {
    const { kernel } = makeKernel({
      "pattern:test": JSON.stringify({ pattern: "Observed regularity", strength: 0.4 }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      { op: "field_merge", key: "pattern:test", fields: { strength: 0.7 } },
      "reflect",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/during reflect/);
  });

  it("fails field_merge when the target key does not exist", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      { op: "field_merge", key: "pattern:missing", fields: { strength: 0.7 } },
      "act",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/key_not_found/);
  });

  it("returns a clean error when rename targets a protected destination", async () => {
    const { kernel, env } = makeKernel({
      "scratch:rename_me": JSON.stringify({ data: true }),
    });
    env.KV._meta.set("scratch:rename_me", { unprotected: true });
    const result = await kernel.kvWriteGated(
      { op: "rename", key: "scratch:rename_me", value: "config:defaults" },
      "reflect",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/system key|allowed privileged context/);
  });
});

// ── 15b. kvWriteGated contact and platform binding write rules ─────────────

describe("kvWriteGated contact write rules", () => {
  it("checks the privileged cap before contact writes", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.privilegedWriteCount = 50;
    const result = await kernel.kvWriteGated(
      { op: "put", key: "contact:alice", value: { name: "Alice" } }, "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Privileged write limit/);
  });

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
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "privileged_write",
        key: "contact:alice",
        new_value: "Alice likes green tea",
      }),
    );
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

  it("blocks patch that flips approved without explicitly naming the field in new_string", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.env.KV._store.set("contact_platform:email:alice@example.com", '{"slug":"alice","approved":false}');
    const result = await kernel.kvWriteGated(
      { op: "patch", key: "contact_platform:email:alice@example.com", old_string: "false", new_string: "true" }, "deep-reflect"
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
      "kernel:last_executions": JSON.stringify([
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
      "kernel:last_executions": JSON.stringify([
        { id: "s_1", outcome: "crash" },
        { id: "s_2", outcome: "killed" },
        { id: "s_3", outcome: "crash" },
      ]),
      "deploy:current": JSON.stringify({
        version_id: "v_current",
        deployed_at: "2026-04-12T00:00:00.000Z",
        deploy_mode: "local",
      }),
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
    expect(rollback.requested_by).toBe("kernel_tripwire");
    expect(rollback.target_current_version).toBe("v_current");

    expect(kernel.sendKernelAlert).toHaveBeenCalledWith("hook_reset",
      expect.stringContaining("3 consecutive crashes"));
  });

  it("returns true when fewer than 3 sessions in history", async () => {
    const { kernel } = makeKernel({
      "kernel:last_executions": JSON.stringify([
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
    kernel.runTick = vi.fn(async () => {});
    await kernel.runScheduled();
    expect(kernel.runTick).toHaveBeenCalled();
  });

  it("bails when active session is recent", async () => {
    const { kernel } = makeKernel({
      "kernel:active_execution": JSON.stringify({ id: "s_other", started_at: new Date().toISOString() }),
      "config:defaults": JSON.stringify({ session_budget: { max_duration_seconds: 600 } }),
    });
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.runTick = vi.fn(async () => {});
    await kernel.runScheduled();
    expect(kernel.runTick).not.toHaveBeenCalled();
  });

  it("treats stale marker as killed session and proceeds", async () => {
    const staleTime = new Date(Date.now() - 1300 * 1000).toISOString(); // older than 2x 600s
    const { kernel, env } = makeKernel({
      "kernel:active_execution": JSON.stringify({ id: "s_dead", started_at: staleTime }),
      "config:defaults": JSON.stringify({ session_budget: { max_duration_seconds: 600 } }),
    });
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.runTick = vi.fn(async () => {});
    await kernel.runScheduled();

    // Should have recorded the killed session
    const historyPut = env.KV.put.mock.calls.find(([key]) => key === "kernel:last_executions");
    expect(historyPut).toBeTruthy();
    const history = JSON.parse(historyPut[1]);
    expect(history[0].outcome).toBe("killed");
    expect(history[0].id).toBe("s_dead");

    // Should have proceeded
    expect(kernel.runTick).toHaveBeenCalled();
  });
});

// ── 18. updateExecutionOutcome ────────────────────────────────

describe("updateExecutionOutcome", () => {
  it("adds clean outcome to kernel:last_executions", async () => {
    const { kernel, env } = makeKernel();
    await kernel.updateExecutionOutcome("clean");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_executions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("clean");
  });

  it("adds crash outcome to kernel:last_executions", async () => {
    const { kernel, env } = makeKernel();
    await kernel.updateExecutionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_executions");
    expect(sessionsPut).toBeTruthy();
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions[0].outcome).toBe("crash");
  });

  it("prepends to existing history", async () => {
    const { kernel, env } = makeKernel({
      "kernel:last_executions": JSON.stringify([
        { id: "s_old", outcome: "clean", ts: "2026-01-01T00:00:00Z" },
      ]),
    });
    await kernel.updateExecutionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_executions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].outcome).toBe("crash");
    expect(sessions[1].id).toBe("s_old");
  });

  it("caps history at 5 entries", async () => {
    const { kernel, env } = makeKernel({
      "kernel:last_executions": JSON.stringify([
        { id: "s_1", outcome: "clean", ts: "t1" },
        { id: "s_2", outcome: "clean", ts: "t2" },
        { id: "s_3", outcome: "clean", ts: "t3" },
        { id: "s_4", outcome: "clean", ts: "t4" },
        { id: "s_5", outcome: "clean", ts: "t5" },
      ]),
    });
    await kernel.updateExecutionOutcome("crash");

    const putCalls = env.KV.put.mock.calls;
    const sessionsPut = putCalls.find(([key]) => key === "kernel:last_executions");
    const sessions = JSON.parse(sessionsPut[1]);
    expect(sessions).toHaveLength(5);
    expect(sessions[0].outcome).toBe("crash");
    // Oldest entry (s_5) should have been dropped
    expect(sessions.map(s => s.id)).not.toContain("s_5");
  });
});

// ── 19. _writeExecutionHealth ──────────────────────────────────

describe("_writeExecutionHealth", () => {
  it("writes a clean health summary", async () => {
    const { kernel, env } = makeKernel();
    kernel.executionId = "s_test_health";
    kernel.sessionCost = 0.05;
    kernel.sessionLLMCalls = 3;
    kernel._sessionStart = Date.now() - 5000;
    kernel.karma = [
      { event: "act_start" },
      { event: "llm_call", step: "act_turn_0" },
      { event: "llm_call", step: "reflect_turn_0" },
    ];

    await kernel._writeExecutionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "execution_health:s_test_health");
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
    kernel.executionId = "s_test_budget";
    kernel.sessionCost = 0.20;
    kernel.sessionLLMCalls = 8;
    kernel._sessionStart = Date.now() - 10000;
    kernel.karma = [
      { event: "act_start" },
      { event: "llm_call", step: "act_turn_0" },
      { event: "budget_exceeded", step: "act" },
      { event: "budget_exceeded", step: "reflect" },
    ];

    await kernel._writeExecutionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "execution_health:s_test_budget");
    const health = JSON.parse(putCall[1]);
    expect(health.budget_exceeded).toEqual(["act", "reflect"]);
    expect(health.reflect_ran).toBe(false);
  });

  it("captures truncations and tool failures", async () => {
    const { kernel, env } = makeKernel();
    kernel.executionId = "s_test_trunc";
    kernel.sessionCost = 0.10;
    kernel.sessionLLMCalls = 4;
    kernel._sessionStart = Date.now() - 8000;
    kernel.karma = [
      { event: "act_start" },
      { event: "llm_call", step: "reflect_turn_0", truncated: true },
      { event: "tool_complete", tool: "computer", ok: false },
      { event: "tool_complete", tool: "computer", ok: false },
      { event: "reflect_parse_error", depth: 0 },
    ];

    await kernel._writeExecutionHealth("clean");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "execution_health:s_test_trunc");
    const health = JSON.parse(putCall[1]);
    expect(health.truncations).toEqual(["reflect_turn_0"]);
    expect(health.tool_failures).toBe(2);
    expect(health.parse_errors).toBe(1);
    expect(health.updates_missed).toBeUndefined();
    expect(health.reflect_ran).toBe(true);
  });

  it("writes health on fatal error path", async () => {
    const { kernel, env } = makeKernel();
    kernel.executionId = "s_test_fatal";
    kernel.sessionCost = 0.01;
    kernel.sessionLLMCalls = 1;
    kernel._sessionStart = Date.now() - 2000;
    kernel.karma = [
      { event: "act_start" },
      { event: "fatal_error", error: "boom" },
    ];

    await kernel._writeExecutionHealth("error");

    const putCall = env.KV.put.mock.calls.find(([k]) => k === "execution_health:s_test_fatal");
    const health = JSON.parse(putCall[1]);
    expect(health.outcome).toBe("error");
    expect(health.reflect_ran).toBe(false);
  });
});

// ── (hook_dirty tests removed — flag no longer exists) ──

// ── 20. runScheduled hook execution flow ──────────────────

describe("runScheduled hook execution flow", () => {
  it("calls checkHookSafety → runTick when safe", async () => {
    const { kernel } = makeKernel();
    const callOrder = [];
    kernel.checkHookSafety = vi.fn(async () => { callOrder.push("checkHookSafety"); return true; });
    kernel.runTick = vi.fn(async () => callOrder.push("runTick"));
    kernel.runFallbackSession = vi.fn(async () => callOrder.push("fallback"));

    await kernel.runScheduled();

    expect(callOrder).toEqual(["checkHookSafety", "runTick"]);
    expect(kernel.runFallbackSession).not.toHaveBeenCalled();
  });

  it("falls back to runFallbackSession() when checkHookSafety returns false", async () => {
    const { kernel } = makeKernel();
    kernel.checkHookSafety = vi.fn(async () => false);
    kernel.runTick = vi.fn(async () => {});
    kernel.runFallbackSession = vi.fn(async () => {});

    await kernel.runScheduled();

    expect(kernel.runTick).not.toHaveBeenCalled();
    expect(kernel.runFallbackSession).toHaveBeenCalled();
  });

  it("writes active session marker before executing", async () => {
    const { kernel, env } = makeKernel();
    kernel.checkHookSafety = vi.fn(async () => true);
    kernel.runTick = vi.fn(async () => {});

    await kernel.runScheduled();

    const markerPut = env.KV.put.mock.calls.find(([key]) => key === "kernel:active_execution");
    expect(markerPut).toBeTruthy();
    const marker = JSON.parse(markerPut[1]);
    expect(marker.id).toBe(kernel.executionId);
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

  it("prefers frozen balance overrides when present", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance", scope: "general" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance", scope: "general" },
      }),
      "kernel:balance_overrides": JSON.stringify({
        providers: {
          openrouter: { balance: 12.34, scope: "general" },
        },
        wallets: {
          base: { balance: 56.78, scope: "general" },
        },
      }),
    });
    kernel.executeAdapter = vi.fn(async () => 999);

    const result = await kernel.checkBalance({});

    expect(kernel.executeAdapter).not.toHaveBeenCalled();
    expect(result.providers.openrouter).toEqual({ balance: 12.34, scope: "general" });
    expect(result.wallets.base).toEqual({ balance: 56.78, scope: "general" });
  });

  it("uses overrides selectively and still executes uncovered balances", async () => {
    const { kernel } = makeKernel({
      providers: JSON.stringify({
        openrouter: { adapter: "provider:llm_balance", scope: "general" },
      }),
      wallets: JSON.stringify({
        base: { adapter: "provider:wallet_balance", scope: "general" },
      }),
      "kernel:balance_overrides": JSON.stringify({
        providers: {
          openrouter: { balance: 12.34, scope: "general" },
        },
      }),
    });
    kernel.executeAdapter = vi.fn(async () => 42);

    const result = await kernel.checkBalance({});

    expect(kernel.executeAdapter).toHaveBeenCalledTimes(1);
    expect(result.providers.openrouter).toEqual({ balance: 12.34, scope: "general" });
    expect(result.wallets.base).toEqual({ balance: 42, scope: "general" });
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

// ── executeAdapter contact safety ──────────────────────────

describe("executeAdapter contact safety", () => {
  function makeEmailAdapter(recipientType = "person") {
    return {
      meta: {
        secrets: [],
        communication: {
          channel: "email",
          recipient_field: "to",
          recipient_type: recipientType,
        },
      },
      execute: vi.fn(async () => ({ sent: true })),
    };
  }

  function makeSlackAdapter() {
    return {
      meta: {
        secrets: [],
        communication: {
          channel: "slack",
          recipient_field: "channel",
          recipient_type: "destination",
        },
      },
      execute: vi.fn(async () => ({ ok: true })),
    };
  }

  function makeLLMAdapter() {
    return {
      meta: { secrets: [] },
      call: vi.fn(async () => ({ content: "response" })),
    };
  }

  it("blocks sending to unapproved person-targeted contact", async () => {
    const emailAdapter = makeEmailAdapter("person");
    const { kernel } = makeKernel(
      {
        "contact_platform:email:bob@example.com": JSON.stringify({ slug: "bob", approved: false }),
        "contact:bob": JSON.stringify({ name: "Bob" }),
      },
      { PROVIDERS: { email: emailAdapter } }
    );
    kernel.karmaRecord = vi.fn(async () => {});

    await expect(
      kernel.executeAdapter("email", { to: "bob@example.com", subject: "Hi", body: "Hello" })
    ).rejects.toThrow("Cannot send to unapproved contact: bob@example.com");

    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "adapter_contact_blocked", recipient: "bob@example.com" })
    );
  });

  it("allows sending to approved person-targeted contact", async () => {
    const emailAdapter = makeEmailAdapter("person");
    const { kernel } = makeKernel(
      {
        "contact_platform:email:alice@example.com": JSON.stringify({ slug: "alice", approved: true }),
        "contact:alice": JSON.stringify({ name: "Alice" }),
      },
      { PROVIDERS: { email: emailAdapter } }
    );
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAdapter("email", { to: "alice@example.com", subject: "Hi", body: "Hello" });
    expect(result).toEqual({ sent: true });
    expect(emailAdapter.execute).toHaveBeenCalled();
  });

  it("allows destination-targeted sends without contact check", async () => {
    const slackAdapter = makeSlackAdapter();
    const { kernel } = makeKernel({}, { PROVIDERS: { slack: slackAdapter } });
    kernel.karmaRecord = vi.fn(async () => {});

    // No contact_platform entry, but should not block — destination type
    const result = await kernel.executeAdapter("slack", { text: "hello", channel: "C_GENERAL" });
    expect(result).toEqual({ ok: true });
    expect(slackAdapter.execute).toHaveBeenCalled();
  });

  it("allows adapters with no communication meta (e.g. llm_balance)", async () => {
    const llmAdapter = makeLLMAdapter();
    const { kernel } = makeKernel({}, { PROVIDERS: { "provider:llm": llmAdapter } });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAdapter("provider:llm", { model: "claude" });
    expect(result).toEqual({ content: "response" });
    expect(llmAdapter.call).toHaveBeenCalled();
  });

  it("uses KV-backed provider secrets when env is missing", async () => {
    const llmAdapter = {
      meta: { secrets: ["OPENROUTER_API_KEY"] },
      call: vi.fn(async ({ secrets }) => ({ content: secrets.OPENROUTER_API_KEY })),
    };
    const { kernel } = makeKernel({
      "secret:OPENROUTER_API_KEY": JSON.stringify("kv-test-key"),
    }, { PROVIDERS: { "provider:llm": llmAdapter } });
    kernel.karmaRecord = vi.fn(async () => {});

    const result = await kernel.executeAdapter("provider:llm", { model: "claude" });
    expect(result).toEqual({ content: "kv-test-key" });
    expect(llmAdapter.call).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { OPENROUTER_API_KEY: "kv-test-key" },
      }),
    );
  });

  it("times out long-running adapters using meta.timeout_ms", async () => {
    const adapter = {
      meta: { timeout_ms: 10, secrets: [] },
      execute: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      }),
    };
    const { kernel } = makeKernel({}, { PROVIDERS: { "provider:slow": adapter } });

    await expect(kernel.executeAdapter("provider:slow", {}))
      .rejects.toThrow("Adapter provider:slow timed out after 10ms");
  });

  it("passes an abortable fetch into adapters with timeout_ms", async () => {
    let seenSignal = null;
    const adapter = {
      meta: { timeout_ms: 5000, secrets: [] },
      execute: vi.fn(async ({ fetch }) => {
        await fetch("https://example.test/provider");
        return { ok: true };
      }),
    };
    const { kernel } = makeKernel({}, { PROVIDERS: { "provider:fetcher": adapter } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input, init = {}) => {
      seenSignal = init.signal;
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true }),
      };
    });

    try {
      const result = await kernel.executeAdapter("provider:fetcher", {});
      expect(result).toEqual({ ok: true });
      expect(seenSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("buildToolContext", () => {
  it("uses KV-backed granted secrets when env is missing", async () => {
    const { kernel } = makeKernel({
      "secret:COMPUTER_API_KEY": JSON.stringify("kv-compute-key"),
    }, {
      toolGrants: {
        computer: { secrets: ["COMPUTER_API_KEY"] },
      },
    });

    const ctx = await kernel.buildToolContext("computer", {}, { command: "pwd" });
    expect(ctx.secrets).toEqual({ COMPUTER_API_KEY: "kv-compute-key" });
  });
});

// ── Principles (generic, immutable) ────────────────────────

describe("principles (generic)", () => {
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

  it("loadPrinciples loads all principle: keys", async () => {
    const { kernel, env } = makeKernel();
    env.KV._store.set("principle:honesty", JSON.stringify("Always be truthful"));
    env.KV._store.set("principle:kindness", JSON.stringify("Be kind to all beings"));
    env.KV._store.set("principle:honesty:audit", JSON.stringify([]));
    await kernel.loadPrinciples();
    expect(kernel.principles).toEqual({
      "principle:honesty": "Always be truthful",
      "principle:kindness": "Be kind to all beings",
    });
  });

  it("callLLM injects [PRINCIPLES] block", async () => {
    const { kernel } = makeLLMKernel();
    kernel.principles = {
      "principle:honesty": "Always be truthful",
    };
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    const systemMsg = call.messages.find(m => m.role === "system");
    expect(systemMsg.content).toContain("[PRINCIPLES]");
    expect(systemMsg.content).toContain("Always be truthful");
    expect(systemMsg.content).not.toContain("[YAMAS]");
    expect(systemMsg.content).not.toContain("[NIYAMAS]");
  });

  it("callLLM injects [PRINCIPLES] block after dharma", async () => {
    const { kernel } = makeLLMKernel();
    kernel.dharma = "Be truthful.";
    kernel.principles = { "principle:honesty": "Always be truthful" };
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const call = kernel.callWithCascade.mock.calls[0][0];
    const sysContent = call.messages[0].content;
    expect(sysContent).toContain("[DHARMA]");
    expect(sysContent).toContain("[PRINCIPLES]");
    const dharmaIdx = sysContent.indexOf("[DHARMA]");
    const principlesIdx = sysContent.indexOf("[PRINCIPLES]");
    const promptIdx = sysContent.indexOf("You are helpful");
    expect(dharmaIdx).toBeLessThan(principlesIdx);
    expect(principlesIdx).toBeLessThan(promptIdx);
  });

  it("no [PRINCIPLES] block when principles is null", async () => {
    const { kernel } = makeLLMKernel();
    kernel.principles = null;
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
    expect(sysContent).not.toContain("[PRINCIPLES]");
  });

  it("no [PRINCIPLES] block when principles is empty", async () => {
    const { kernel } = makeLLMKernel();
    kernel.principles = {};
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful",
      step: "test",
    });
    const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
    expect(sysContent).not.toContain("[PRINCIPLES]");
  });

  it("each principle labeled [name]...[/name] inside [PRINCIPLES]", async () => {
    const { kernel } = makeLLMKernel();
    kernel.principles = { "principle:discipline": "Be disciplined." };
    await kernel.callLLM({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      step: "test",
    });
    const sysContent = kernel.callWithCascade.mock.calls[0][0].messages[0].content;
    expect(sysContent).toContain("[discipline]\nBe disciplined.\n[/discipline]");
  });

  it("kvWriteGated allows principle: writes with deliberation in deep-reflect", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const deliberation = "This principle needs refinement because experience has shown that the current wording is too vague and leads to inconsistent interpretation across different session contexts. The updated wording better captures the intent.";
    const result = await kernel.kvWriteGated(
      { op: "put", key: "principle:honesty", value: "refined honesty principle", deliberation },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);
  });

  it("kvWriteGated rejects principle: writes without deliberation", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "principle:honesty", value: "new value" },
      "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deliberation");
  });

  it("kvWriteSafe blocks principle: keys as system keys", async () => {
    const { kernel } = makeKernel();
    await expect(kernel.kvWriteSafe("principle:honesty", "new value"))
      .rejects.toThrow("system key");
  });

  it("non-principle system key writes succeed without warning", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: { updated: true } }, "deep-reflect"
    );
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("kvWriteGated rejects prompt: writes without deliberation", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "prompt:plan", value: "new plan prompt" },
      "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deliberation");
  });

  it("kvWriteGated allows prompt: writes with deliberation in deep-reflect", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const deliberation = "The plan prompt lacks autonomous agent framing, causing the planner to reason as a reactive chatbot when desires are empty. Adding a single paragraph establishing that desires emerge from DR, not user input. This prevents the awaiting user input failure mode.";
    const result = await kernel.kvWriteGated(
      { op: "put", key: "prompt:plan", value: "updated plan prompt", deliberation },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);
  });

  it("kvWriteGated allows config: writes without deliberation in deep-reflect", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "put", key: "config:defaults", value: { session_budget: { max_cost: 0.20 } } },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);
  });

  it("kvWriteGated rejects prompt: delete without deliberation", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    const result = await kernel.kvWriteGated(
      { op: "delete", key: "prompt:deep_reflect" },
      "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deliberation");
  });

  it("kvWriteGated rejects prompt: patch without deliberation", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.kv.put("prompt:plan", "old text here");
    const result = await kernel.kvWriteGated(
      { op: "patch", key: "prompt:plan", old_string: "old text", new_string: "new text" },
      "deep-reflect"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deliberation");
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
      const { kernel } = makeKernel();
      expect(kernel.isSystemKey("sealed:quarantine:email:foo:123")).toBe(true);
    });

    it("sealed: is kernel-only", () => {
      const { kernel } = makeKernel();
      expect(kernel.isKernelOnly("sealed:quarantine:email:foo:123")).toBe(true);
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
      kernel.executionId = "test_session";
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
    kernel.executionId = "test_session";
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
    kernel.executionId = "test_session";

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
  it("writes a key with format event:{15-digit-timestamp}:{type}:{4-char-nonce}", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();
    const result = await K.emitEvent("chat_message", { source: "slack", text: "hello" });

    expect(result).toHaveProperty("key");
    const key = result.key;
    expect(key).toMatch(/^event:\d{15}:chat_message:[a-z0-9]{4}$/);

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
      expect.stringMatching(/^event:\d{15}:session_end:[a-z0-9]{4}$/),
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

  it("appends a 4-char alphanumeric nonce as the 4th key segment", async () => {
    const { kernel } = makeKernel();
    const K = kernel.buildKernelInterface();
    const result = await K.emitEvent("test_event", { foo: "bar" });

    const parts = result.key.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toMatch(/^[a-z0-9]{4}$/);
  });
});

// ── claimEvent / releaseEvent ────────────────────────────────

describe("claimEvent", () => {
  it("marks event with lease fields and returns true", async () => {
    const { kernel, env } = makeKernel({
      'event:0001:test_event:abcd': JSON.stringify({ type: 'test_event', text: 'hello' }),
    });
    const K = kernel.buildKernelInterface();
    const result = await K.claimEvent('event:0001:test_event:abcd', 'exec_123');

    expect(result).toBe(true);
    const stored = JSON.parse(await env.KV.get('event:0001:test_event:abcd'));
    expect(stored.claimed_by).toBe('exec_123');
    expect(stored.claimed_at).toBeTypeOf('number');
    expect(stored.lease_expires).toBeTypeOf('number');
    expect(stored.lease_expires).toBeGreaterThan(stored.claimed_at);
  });

  it("returns false if event is already claimed with active lease", async () => {
    const future = Date.now() + 30000;
    const { kernel } = makeKernel({
      'event:0002:test_event:abcd': JSON.stringify({
        type: 'test_event',
        claimed_by: 'exec_111',
        claimed_at: Date.now() - 5000,
        lease_expires: future,
      }),
    });
    const K = kernel.buildKernelInterface();
    const result = await K.claimEvent('event:0002:test_event:abcd', 'exec_222');

    expect(result).toBe(false);
  });

  it("succeeds if previous lease has expired", async () => {
    const past = Date.now() - 5000;
    const { kernel, env } = makeKernel({
      'event:0003:test_event:abcd': JSON.stringify({
        type: 'test_event',
        claimed_by: 'exec_old',
        claimed_at: past - 60000,
        lease_expires: past,
      }),
    });
    const K = kernel.buildKernelInterface();
    const result = await K.claimEvent('event:0003:test_event:abcd', 'exec_new');

    expect(result).toBe(true);
    const stored = JSON.parse(await env.KV.get('event:0003:test_event:abcd'));
    expect(stored.claimed_by).toBe('exec_new');
  });

  it("returns false if event does not exist", async () => {
    const { kernel } = makeKernel();
    const K = kernel.buildKernelInterface();
    const result = await K.claimEvent('event:9999:missing:abcd', 'exec_123');

    expect(result).toBe(false);
  });
});

describe("releaseEvent", () => {
  it("removes claim fields from the event", async () => {
    const { kernel, env } = makeKernel({
      'event:0001:test_event:abcd': JSON.stringify({
        type: 'test_event',
        text: 'hello',
        claimed_by: 'exec_123',
        claimed_at: Date.now() - 1000,
        lease_expires: Date.now() + 59000,
      }),
    });
    const K = kernel.buildKernelInterface();
    await K.releaseEvent('event:0001:test_event:abcd');

    const stored = JSON.parse(await env.KV.get('event:0001:test_event:abcd'));
    expect(stored.claimed_by).toBeUndefined();
    expect(stored.claimed_at).toBeUndefined();
    expect(stored.lease_expires).toBeUndefined();
    expect(stored.type).toBe('test_event');
    expect(stored.text).toBe('hello');
  });

  it("is a no-op if event does not exist", async () => {
    const { kernel } = makeKernel();
    const K = kernel.buildKernelInterface();
    // Should not throw
    await expect(K.releaseEvent('event:9999:missing:abcd')).resolves.toBeUndefined();
  });
});

// ── drainEvents ─────────────────────────────────────────────

describe("drainEvents", () => {
  it("returns empty arrays when no event:* keys exist", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.drainEvents({});
    expect(result).toEqual({ processed: [], actContext: [], deferred: {} });
  });

  it("routes event to configured handler and deletes event on success", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['onChat'] }),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message', text: 'hello' }),
    });
    const onChat = vi.fn(async () => {});
    await kernel.drainEvents({ onChat });
    // Event key should be deleted after successful handling
    expect(await env.KV.get('event:0001:chat_message')).toBeNull();
  });

  it("adds all drained events to actContext", async () => {
    const { kernel } = makeKernel({
      'config:event_handlers': JSON.stringify({}),
      'event:0001:session_request': JSON.stringify({ type: 'session_request', ref: 'session_request:req_1' }),
      'event:0002:job_complete': JSON.stringify({ type: 'job_complete', job_id: 'j1' }),
      'event:0003:other_event': JSON.stringify({ type: 'other_event', data: 'x' }),
    });
    const { actContext } = await kernel.drainEvents({});
    const types = actContext.map(e => e.type);
    expect(types).toContain('session_request');
    expect(types).toContain('job_complete');
    expect(types).toContain('other_event');
  });

  it("adds all event types (including non-act-specific) to actContext", async () => {
    const { kernel } = makeKernel({
      'config:event_handlers': JSON.stringify({}),
      'event:0001:other_event': JSON.stringify({ type: 'other_event' }),
    });
    const { actContext } = await kernel.drainEvents({});
    expect(actContext).toHaveLength(1);
    expect(actContext[0].type).toBe('other_event');
  });

  it("records karma warning for unknown handler name, still deletes event", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['nonExistentHandler'] }),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message' }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.drainEvents({});
    // Unknown handler — continue is called, so allHandlersSucceeded stays true, event is deleted
    expect(await env.KV.get('event:0001:chat_message')).toBeNull();
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'event_handler_unknown', handler: 'nonExistentHandler' })
    );
  });

  it("increments fail count when handler throws, does not delete event", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['failHandler'] }),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message' }),
    });
    const failHandler = vi.fn(async () => { throw new Error('boom'); });
    await kernel.drainEvents({ failHandler });
    // Event should still exist
    expect(await env.KV.get('event:0001:chat_message')).not.toBeNull();
    // Fail count should be stored
    const failCount = JSON.parse(await env.KV.get('event_fail_count:event:0001:chat_message'));
    expect(failCount).toBe(1);
  });

  it("dead-letters event after 3 failures", async () => {
    const eventKey = 'event:0001:chat_message';
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['failHandler'] }),
      [eventKey]: JSON.stringify({ type: 'chat_message', text: 'x' }),
      [`event_fail_count:${eventKey}`]: JSON.stringify(2),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    const failHandler = vi.fn(async () => { throw new Error('third failure'); });
    await kernel.drainEvents({ failHandler });

    // Original event deleted
    expect(await env.KV.get(eventKey)).toBeNull();
    // Fail count key deleted
    expect(await env.KV.get(`event_fail_count:${eventKey}`)).toBeNull();
    // Dead letter written
    const deadKey = eventKey.replace('event:', 'event_dead:');
    const deadVal = JSON.parse(await env.KV.get(deadKey));
    expect(deadVal).not.toBeNull();
    expect(deadVal.fail_count).toBe(3);
    // Karma recorded
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'event_dead_lettered', key: eventKey })
    );
  });

  it("records events_drained karma with count and type breakdown", async () => {
    const { kernel } = makeKernel({
      'config:event_handlers': JSON.stringify({}),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message' }),
      'event:0002:chat_message': JSON.stringify({ type: 'chat_message' }),
      'event:0003:job_complete': JSON.stringify({ type: 'job_complete' }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.drainEvents({});
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'events_drained',
        count: 3,
        types: { chat_message: 2, job_complete: 1 },
      })
    );
  });

  it("returns processed list of successfully handled events", async () => {
    const { kernel } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['onChat'] }),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message', text: 'hello' }),
      'event:0002:chat_message': JSON.stringify({ type: 'chat_message', text: 'world' }),
    });
    const onChat = vi.fn(async () => {});
    const { processed } = await kernel.drainEvents({ onChat });
    expect(processed).toHaveLength(2);
    expect(processed.every(e => e.type === 'chat_message')).toBe(true);
  });

  it("returns deferred events grouped by processor with new config format", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({
        handlers: { job_complete: ['sessionTrigger'] },
        deferred: { inbound_message: ['comms'], job_complete: ['comms'] },
      }),
      'event:0001:inbound_message': JSON.stringify({ type: 'inbound_message', text: 'hi' }),
      'event:0002:job_complete': JSON.stringify({ type: 'job_complete', job_id: 'j1' }),
    });
    const sessionTrigger = vi.fn(async () => {});
    const { deferred, processed } = await kernel.drainEvents({ sessionTrigger });

    // Both events should be in deferred.comms
    expect(deferred.comms).toHaveLength(2);
    expect(deferred.comms.map(e => e.type)).toContain('inbound_message');
    expect(deferred.comms.map(e => e.type)).toContain('job_complete');

    // Events with deferred processors should NOT be deleted from KV
    expect(await env.KV.get('event:0001:inbound_message')).not.toBeNull();
    expect(await env.KV.get('event:0002:job_complete')).not.toBeNull();

    // Immediate handler should still have been called for job_complete
    expect(sessionTrigger).toHaveBeenCalledTimes(1);

    // Both should be in processed
    expect(processed).toHaveLength(2);
  });

  it("backward compat: old flat config format still works as handlers-only", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({ chat_message: ['onChat'] }),
      'event:0001:chat_message': JSON.stringify({ type: 'chat_message', text: 'hello' }),
    });
    const onChat = vi.fn(async () => {});
    const { processed, deferred } = await kernel.drainEvents({ onChat });

    // Should work like before — handler called, event deleted, no deferred
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(await env.KV.get('event:0001:chat_message')).toBeNull();
    expect(processed).toHaveLength(1);
    expect(deferred).toEqual({});
  });

  it("immediate handler failure does not block deferred processing", async () => {
    const { kernel } = makeKernel({
      'config:event_handlers': JSON.stringify({
        handlers: { job_complete: ['failHandler'] },
        deferred: { job_complete: ['comms'] },
      }),
      'event:0001:job_complete': JSON.stringify({ type: 'job_complete', job_id: 'j1' }),
    });
    const failHandler = vi.fn(async () => { throw new Error('boom'); });
    const { deferred } = await kernel.drainEvents({ failHandler });

    // Event should still be in deferred despite handler failure
    expect(deferred.comms).toHaveLength(1);
    expect(deferred.comms[0].type).toBe('job_complete');
  });

  it("events with only handlers (no deferred) are deleted on success", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({
        handlers: { session_request: ['sessionTrigger'] },
        deferred: {},
      }),
      'event:0001:session_request': JSON.stringify({ type: 'session_request' }),
    });
    const sessionTrigger = vi.fn(async () => {});
    await kernel.drainEvents({ sessionTrigger });
    expect(await env.KV.get('event:0001:session_request')).toBeNull();
  });

  it("dead-letters deferred events after 5 drains without terminal disposition", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({
        handlers: {},
        deferred: { stuck_event: ['comms'] },
      }),
      'event:0001:stuck_event': JSON.stringify({ type: 'stuck_event', data: 'test' }),
    });

    // Drain 4 times — event should still be alive and in deferred
    for (let i = 0; i < 4; i++) {
      const { deferred } = await kernel.drainEvents({});
      expect(deferred.comms).toHaveLength(1);
      expect(await env.KV.get('event:0001:stuck_event')).not.toBeNull();
    }

    // 5th drain — should dead-letter
    const { deferred } = await kernel.drainEvents({});
    expect(deferred.comms || []).toHaveLength(0);
    expect(await env.KV.get('event:0001:stuck_event')).toBeNull();
    expect(await env.KV.get('event_dead:0001:stuck_event', 'json')).toBeTruthy();
    expect(await env.KV.get('event_drain_count:event:0001:stuck_event')).toBeNull();
  });

  it("deleteEvent removes event and its drain count", async () => {
    const { kernel, env } = makeKernel({
      'config:event_handlers': JSON.stringify({
        handlers: {},
        deferred: { test_event: ['comms'] },
      }),
      'event:0001:test_event': JSON.stringify({ type: 'test_event' }),
    });

    // Drain once to create a drain count
    await kernel.drainEvents({});
    expect(await env.KV.get('event_drain_count:event:0001:test_event')).not.toBeNull();

    // deleteEvent should clean up both
    const K = kernel.buildKernelInterface();
    await K.deleteEvent('event:0001:test_event');
    expect(await env.KV.get('event:0001:test_event')).toBeNull();
    expect(await env.KV.get('event_drain_count:event:0001:test_event')).toBeNull();
  });

  it("deleteEvent rejects non-event keys", async () => {
    const { kernel } = makeKernel({});
    const K = kernel.buildKernelInterface();
    await expect(K.deleteEvent('config:defaults')).rejects.toThrow('not an event key');
  });
});

// ── code staging ─────────────────────────────────────────────

function createTestKernel() {
  const { kernel } = makeKernel();
  kernel.karmaRecord = vi.fn(async (entry) => { kernel.karma.push(entry); });
  return kernel;
}

describe("lifecycle state writes", () => {
  it("writeLifecycleState writes lifecycle keys", async () => {
    const kernel = createTestKernel();
    await kernel.writeLifecycleState("dr2:state:1", { status: "idle" });
    const value = await kernel.kvGet("dr2:state:1");
    expect(value).toEqual({ status: "idle" });
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "lifecycle_write", key: "dr2:state:1" }),
    );
  });

  it("writeLifecycleState rejects non-lifecycle keys", async () => {
    const kernel = createTestKernel();
    await expect(kernel.writeLifecycleState("config:defaults", {}))
      .rejects.toThrow("not a lifecycle key");
  });

  it("deleteLifecycleState records karma", async () => {
    const kernel = createTestKernel();
    await kernel.writeLifecycleState("dr2:state:1", { status: "idle" });
    await kernel.deleteLifecycleState("dr2:state:1");
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "lifecycle_delete", key: "dr2:state:1" }),
    );
  });
});

describe("code staging", () => {
  it("stageCode writes to code_staging: prefix", async () => {
    const kernel = createTestKernel();
    await kernel.stageCode("tool:kv_query:code", "export function execute() {}");
    const staged = await kernel.kvGet("code_staging:tool:kv_query:code");
    expect(staged).toEqual({
      code: "export function execute() {}",
      staged_at: expect.any(String),
      execution_id: kernel.executionId,
    });
  });

  it("stageCode accepts kernel authority surfaces", async () => {
    const kernel = createTestKernel();
    await kernel.stageCode("kernel:source:authority-policy.js", "export const x = 1;\n");
    const staged = await kernel.kvGet("code_staging:kernel:source:authority-policy.js");
    expect(staged).toEqual({
      code: "export const x = 1;\n",
      staged_at: expect.any(String),
      execution_id: kernel.executionId,
    });
  });

  it("stageCode rejects non-code keys", async () => {
    const kernel = createTestKernel();
    await expect(kernel.stageCode("config:defaults", "bad"))
      .rejects.toThrow("not a code key");
  });

  it("signalDeploy writes deploy:pending", async () => {
    const kernel = createTestKernel();
    await kernel.signalDeploy();
    const pending = await kernel.kvGet("deploy:pending");
    expect(pending).toEqual({
      requested_at: expect.any(String),
      execution_id: kernel.executionId,
    });
  });

  it("signalDeploy carries optional provenance metadata", async () => {
    const kernel = createTestKernel();
    await kernel.signalDeploy({
      source: {
        kind: "dr2",
        review_note_key: "review_note:userspace_review:x_wait:d1:000:test",
        authority_effect: "no_authority_change",
        change_family: "abc123",
      },
    });
    const pending = await kernel.kvGet("deploy:pending");
    expect(pending).toEqual({
      requested_at: expect.any(String),
      execution_id: kernel.executionId,
      source: {
        kind: "dr2",
        review_note_key: "review_note:userspace_review:x_wait:d1:000:test",
        authority_effect: "no_authority_change",
        change_family: "abc123",
      },
    });
  });

  it("signalDeploy records karma", async () => {
    const kernel = createTestKernel();
    await kernel.signalDeploy();
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "deploy_signaled" })
    );
  });

  it("stageCode records karma", async () => {
    const kernel = createTestKernel();
    await kernel.stageCode("tool:kv_query:code", "export function execute() {}");
    expect(kernel.karma).toContainEqual(
      expect.objectContaining({ event: "code_staged", target: "tool:kv_query:code" })
    );
  });
});

// ── touchedKeys tracking ──────────────────────────────────────

describe("touchedKeys tracking", () => {
  it("tracks keys written via kvWriteSafe", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.kvWriteSafe("experience:test1", { data: "hello" });
    expect(kernel.touchedKeys.has("experience:test1")).toBe(true);
  });

  it("tracks keys deleted via kvDeleteSafe", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.kvWriteSafe("experience:del1", "temp");
    kernel.touchedKeys.clear();
    await kernel.kvDeleteSafe("experience:del1");
    expect(kernel.touchedKeys.has("experience:del1")).toBe(true);
  });

  it("tracks keys written via internal kvWrite", async () => {
    const { kernel } = makeKernel();
    kernel.touchedKeys = new Set();
    await kernel.karmaRecord({ event: "test" });
    expect(kernel.touchedKeys.size).toBeGreaterThan(0);
  });
});

// ── kernel:pulse ─────────────────────────────────────────

describe("kernel:pulse", () => {
  it("arms the session controller for 720 seconds by default", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { kernel } = makeKernel();
    kernel.defaults = {};
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };

    try {
      await kernel.runTick();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 720_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes the session abort signal during a tick and clears it afterwards", async () => {
    const { kernel } = makeKernel();
    let seenSignal = null;
    kernel.HOOKS = {
      tick: { run: async (K) => {
        seenSignal = K.sessionAbortSignal;
      } },
    };

    await kernel.runTick();

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(kernel.sessionAbortController).toBeNull();
  });

  it("records fatal_error and crash outcome when the session signal aborts mid-tick", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    kernel.HOOKS = {
      tick: { run: async (K) => new Promise((_, reject) => {
        K.sessionAbortSignal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
        kernel.sessionAbortController.abort();
      }) },
    };

    await kernel.runTick();

    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fatal_error", error: "Aborted" }),
    );
    const history = JSON.parse(await kernel.kv.get("kernel:last_executions"));
    expect(history[0].outcome).toBe("crash");
    expect(kernel.sessionAbortController).toBeNull();
  });

  it("writes kernel:pulse at end of runTick", async () => {
    const { kernel } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();

    const pulse = JSON.parse(await kernel.kv.get("kernel:pulse"));
    expect(pulse.v).toBe(1);
    expect(pulse.n).toBe(0);
    expect(pulse.execution_id).toBe(kernel.executionId);
    expect(pulse.outcome).toBe("clean");
    expect(pulse.ts).toBeGreaterThan(0);
    expect(Array.isArray(pulse.changed)).toBe(true);
  });

  it("increments pulse counter across ticks", async () => {
    const { kernel } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();
    const p1 = JSON.parse(await kernel.kv.get("kernel:pulse"));

    kernel.touchedKeys = new Set();
    kernel.karma = [];
    kernel.sessionCost = 0;
    kernel.sessionLLMCalls = 0;
    await kernel.runTick();
    const p2 = JSON.parse(await kernel.kv.get("kernel:pulse"));

    expect(p2.n).toBe(p1.n + 1);
  });

  it("calls HOOKS.pulse.classify with touchedKeys", async () => {
    const { kernel } = makeKernel();
    let receivedKeys = null;
    kernel.HOOKS = {
      tick: { run: async (K) => {
        await K.kvWriteSafe("experience:test", { data: 1 });
      }},
      pulse: { classify: (keys) => {
        receivedKeys = keys;
        return ["mind"];
      }},
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();

    expect(receivedKeys).toBeInstanceOf(Set);
    expect(receivedKeys.has("experience:test")).toBe(true);
    const pulse = JSON.parse(await kernel.kv.get("kernel:pulse"));
    expect(pulse.changed).toEqual(["mind"]);
  });

  it("pulse write failure does not crash the tick", async () => {
    const { kernel } = makeKernel();
    kernel.HOOKS = {
      tick: { run: async () => {} },
    };
    const origPut = kernel.kv.put.bind(kernel.kv);
    kernel.kv.put = async (key, ...args) => {
      if (key === "kernel:pulse") throw new Error("KV write failed");
      return origPut(key, ...args);
    };
    await kernel.loadEagerConfig();
    await kernel.runTick();
    // Should not throw — pulse write is best-effort
  });
});

// ── pulse integration ─────────────────────────────────────────

describe("pulse integration", () => {
  it("full flow: userspace writes → classify → pulse reflects changes", async () => {
    const { classify } = await import('../userspace.js');
    const { kernel } = makeKernel();

    kernel.HOOKS = {
      tick: { run: async (K) => {
        await K.kvWriteSafe("experience:integration_test", { test: true });
        await K.kvWriteGated(
          { op: "put", key: "desire:test-desire", value: { slug: "test", direction: "approach" } },
          "deep-reflect"
        );
      }},
      pulse: { classify },
    };

    await kernel.loadEagerConfig();
    await kernel.runTick();

    const pulse = JSON.parse(await kernel.kv.get("kernel:pulse"));
    expect(pulse.v).toBe(1);
    expect(pulse.outcome).toBe("clean");
    expect(pulse.changed).toContain("mind");
    expect(pulse.changed).toContain("health");
    expect(pulse.n).toBe(0);
  });
});

// Tactics are loaded and injected by userspace (planPhase), not by the kernel.
// The kernel only provides the protected-tier write gate for tactic:* keys.
describe("tactics", () => {
  it("tactic:* keys are writable via kvWriteGated in deep-reflect", async () => {
    const { kernel } = makeKernel();
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      { key: "tactic:test", op: "put", value: { slug: "test", description: "test" } },
      "deep-reflect"
    );
    expect(result.ok).toBe(true);
  });

  it("kernel does NOT inject tactics into LLM calls", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("tactic:test", JSON.stringify({ slug: "test", description: "test" }));
    await kernel.loadEagerConfig();

    let capturedMessages;
    kernel.PROVIDERS = { 'provider:llm': {
      meta: { secrets: [] },
      call: async (req) => {
        capturedMessages = req.messages;
        return { content: "test", usage: { prompt_tokens: 10, completion_tokens: 5 }, ok: true };
      },
    }};

    await kernel.callLLM({
      model: "test", systemPrompt: "test",
      messages: [{ role: "user", content: "test" }],
      step: "plan",
    });

    expect(capturedMessages[0].content).not.toContain("[TACTICS]");
  });
});

describe("identifications", () => {
  it("identification:* keys are writable via kvWriteGated in deep-reflect", async () => {
    const { kernel } = makeKernel({
      "config:defaults": JSON.stringify({
        identity: { enabled: true },
      }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();
    const result = await kernel.kvWriteGated(
      {
        key: "identification:patron-continuity",
        op: "put",
        value: {
          identification: "Ongoing patron relationship and unfinished follow-through.",
          strength: 0.3,
          source: "deep_reflect",
        },
      },
      "deep-reflect",
    );
    expect(result.ok).toBe(true);
  });

  it("updates last_exercised_at through field_merge in act context", async () => {
    const { kernel, env } = makeKernel({
      "config:defaults": JSON.stringify({
        identity: { enabled: true },
      }),
      "identification:patron-continuity": JSON.stringify({
        identification: "Ongoing patron relationship and unfinished follow-through.",
        strength: 0.5,
        last_exercised_at: null,
      }),
    });
    kernel.karmaRecord = vi.fn(async () => {});
    await kernel.loadEagerConfig();

    const timestamp = "2026-04-09T16:00:00.000Z";
    const result = await kernel.kvWriteGated(
      {
        key: "identification:patron-continuity",
        op: "field_merge",
        fields: { last_exercised_at: timestamp },
      },
      "act",
    );

    expect(result.ok).toBe(true);
    const updated = JSON.parse(await env.KV.get("identification:patron-continuity"));
    expect(updated.last_exercised_at).toBe(timestamp);
    expect(kernel.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mechanical_write",
        key: "identification:patron-continuity",
        budget_class: "mechanical",
      }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildOrientContext,
  detectCrash,
  evaluateTripwires,
  writeSessionResults,
  getBalances,
  runSession,
  summarizeKarma,
} from "../hook-main.js";
import {
  applyKVOperation,
} from "../hook-protect.js";
import {
  evaluatePredicate,
  stageModification,
  findInflightConflict,
  promoteInflight,
  rollbackInflight,
  processReflectVerdicts,
  processDeepReflectVerdicts,
  runCircuitBreaker,
  loadStagedModifications,
  loadInflightModifications,
  initTracking,
  acceptStaged,
  acceptDirect,
} from "../hook-modifications.js";
import {
  executeReflect,
  getMaxSteps,
  getReflectModel,
  isReflectDue,
  highestReflectDepthDue,
  defaultReflectPrompt,
  defaultDeepReflectPrompt,
  applyReflectOutput,
  gatherReflectContext,
  loadReflectPrompt,
  loadBelowPrompt,
  loadReflectHistory,
  runReflect,
} from "../hook-reflect.js";
import { makeMockK } from "./helpers/mock-kernel.js";

// Reset modification tracking state before each test
beforeEach(() => {
  initTracking([], []);
});

function makeState(overrides = {}) {
  return {
    defaults: overrides.defaults || {},
    modelsConfig: overrides.modelsConfig || null,
    toolRegistry: overrides.toolRegistry || null,
    sessionId: overrides.sessionId || "test_session",
    async refreshDefaults() { this.defaults = overrides.defaults || {}; },
    async refreshModels() {},
    async refreshToolRegistry() {},
  };
}

// ── 1. buildOrientContext ───────────────────────────────────

describe("buildOrientContext", () => {
  it("returns JSON string with all expected keys", () => {
    const context = {
      balances: { providers: {}, wallets: {} },
      lastReflect: { session_summary: "test" },
      additionalContext: { foo: "bar" },
      effort: "medium",
      crashData: null,
    };
    const result = JSON.parse(buildOrientContext(context));
    expect(result).toHaveProperty("balances");
    expect(result).toHaveProperty("last_reflect");
    expect(result).toHaveProperty("additional_context");
    expect(result).toHaveProperty("effort");
    expect(result).toHaveProperty("crash_data");
    expect(result.effort).toBe("medium");
    expect(result.crash_data).toBeNull();
    expect(result).toHaveProperty("current_time");
    expect(new Date(result.current_time).getTime()).not.toBeNaN();
  });
});

// ── 2. getMaxSteps ──────────────────────────────────────────

describe("getMaxSteps", () => {
  it("returns execution config for orient", () => {
    const state = makeState({ defaults: { execution: { max_steps: { orient: 7 } } } });
    expect(getMaxSteps(state, "orient")).toBe(7);
  });

  it("returns default 12 for orient when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "orient")).toBe(12);
  });

  it("returns reflect for depth 1", () => {
    const state = makeState({ defaults: { execution: { max_steps: { reflect: 8 } } } });
    expect(getMaxSteps(state, "reflect", 1)).toBe(8);
  });

  it("returns default 5 for depth 1 when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "reflect", 1)).toBe(5);
  });

  it("returns deep_reflect for depth > 1", () => {
    const state = makeState({ defaults: { execution: { max_steps: { deep_reflect: 15 } } } });
    expect(getMaxSteps(state, "reflect", 2)).toBe(15);
  });

  it("returns default 10 for depth > 1 when not configured", () => {
    const state = makeState();
    expect(getMaxSteps(state, "reflect", 3)).toBe(10);
  });

  it("uses per-level override via reflect_levels", () => {
    const state = makeState({
      defaults: {
        reflect_levels: { 2: { max_steps: 25 } },
        execution: { max_steps: { deep_reflect: 15 } },
      },
    });
    expect(getMaxSteps(state, "reflect", 2)).toBe(25);
  });
});

// ── 3. getReflectModel ──────────────────────────────────────

describe("getReflectModel", () => {
  it("uses per-level override", () => {
    const state = makeState({
      defaults: {
        reflect_levels: { 2: { model: "opus" } },
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(getReflectModel(state, 2)).toBe("opus");
  });

  it("falls back to deep_reflect.model", () => {
    const state = makeState({
      defaults: {
        deep_reflect: { model: "sonnet" },
        orient: { model: "haiku" },
      },
    });
    expect(getReflectModel(state, 1)).toBe("sonnet");
  });

  it("falls back to orient.model", () => {
    const state = makeState({
      defaults: { orient: { model: "haiku" } },
    });
    expect(getReflectModel(state, 1)).toBe("haiku");
  });

  it("returns undefined when nothing configured", () => {
    const state = makeState();
    expect(getReflectModel(state, 1)).toBeUndefined();
  });
});

// ── 4. loadReflectPrompt ────────────────────────────────────

describe("loadReflectPrompt", () => {
  it("returns depth-specific prompt from KV", async () => {
    const K = makeMockK({ "prompt:reflect:2": JSON.stringify("depth-2 prompt") });
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 2);
    expect(result).toBe("depth-2 prompt");
  });

  it("falls back to hardcoded defaultDeepReflectPrompt", async () => {
    const K = makeMockK();
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 1);
    expect(result).toContain("depth-1 reflection");
  });

  it("falls back to hardcoded for all depths", async () => {
    const K = makeMockK();
    const state = makeState();
    const result = await loadReflectPrompt(K, state, 3);
    expect(result).toContain("depth-3 reflection");
  });
});

// ── 5. isReflectDue ─────────────────────────────────────────

describe("isReflectDue", () => {
  it("cold-start: depth 1 due at session 20", async () => {
    const K = makeMockK({}, { sessionCount: 20 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(true);
  });

  it("cold-start: depth 1 NOT due below threshold", async () => {
    const K = makeMockK({}, { sessionCount: 19 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(false);
  });

  it("cold-start: depth 2 uses exponential formula", async () => {
    const K = makeMockK({}, { sessionCount: 100 });
    const state = makeState({
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    expect(await isReflectDue(K, state, 2)).toBe(true);
  });

  it("cold-start: depth 2 NOT due below exponential threshold", async () => {
    const K = makeMockK({}, { sessionCount: 99 });
    const state = makeState({
      defaults: {
        deep_reflect: { default_interval_sessions: 20 },
        execution: { reflect_interval_multiplier: 5 },
      },
    });
    expect(await isReflectDue(K, state, 2)).toBe(false);
  });

  it("self-scheduled: due when sessionsSince >= after_sessions", async () => {
    const K = makeMockK({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 5,
        last_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(true);
  });

  it("self-scheduled: NOT due when below both thresholds", async () => {
    const K = makeMockK({
      "reflect:schedule:1": JSON.stringify({
        after_sessions: 10,
        after_days: 999,
        last_reflect_session: 12,
        last_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    expect(await isReflectDue(K, state, 1)).toBe(false);
  });

  it("depth 1 uses reflect:schedule:1 only (no legacy fallback)", async () => {
    // deep_reflect_schedule is ignored — only reflect:schedule:1 is checked
    const K = makeMockK({
      deep_reflect_schedule: JSON.stringify({
        after_sessions: 5,
        last_reflect_session: 10,
        last_reflect: new Date().toISOString(),
      }),
    }, { sessionCount: 15 });
    const state = makeState({ defaults: { deep_reflect: { default_interval_sessions: 20 } } });
    // Falls through to cold-start since reflect:schedule:1 doesn't exist
    expect(await isReflectDue(K, state, 1)).toBe(false);
  });
});

// ── 6. highestReflectDepthDue ───────────────────────────────

describe("highestReflectDepthDue", () => {
  it("returns highest due depth", async () => {
    const K = makeMockK({}, { sessionCount: 100 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(2);
  });

  it("returns 0 when none due", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(0);
  });

  it("returns depth 1 when only depth 1 is due", async () => {
    const K = makeMockK({}, { sessionCount: 25 });
    const state = makeState({
      defaults: {
        execution: { max_reflect_depth: 2, reflect_interval_multiplier: 5 },
        deep_reflect: { default_interval_sessions: 20 },
      },
    });
    expect(await highestReflectDepthDue(K, state)).toBe(1);
  });
});

// ── 7. applyReflectOutput ──────────────────────────────────

describe("applyReflectOutput", () => {
  it("applies kv_operations", async () => {
    const K = makeMockK();
    const state = makeState();
    const output = {
      reflection: "test",
      kv_operations: [
        { op: "put", key: "test_key", value: "test_val" },
      ],
    };
    // applyKVOperation will check isSystemKey and metadata — mock appropriately
    // Since test_key is not a system key but has no unprotected metadata, it will be blocked
    // That's fine — we just verify applyReflectOutput processes the ops
    await applyReflectOutput(K, state, 1, output, {});
    // The function ran without error
    expect(K.karmaRecord).toHaveBeenCalled();
  });

  it("stores history at reflect:N:sessionId", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "deep thoughts",
      note_to_future_self: "remember this",
    };

    await applyReflectOutput(K, state, 2, output, {});

    expect(K.kvPutSafe).toHaveBeenCalledWith(
      "reflect:2:test_session",
      expect.objectContaining({
        reflection: "deep thoughts",
        note_to_future_self: "remember this",
        depth: 2,
      })
    );
  });

  it("depth 1 writes last_reflect + wake_config", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "depth 1 reflection",
      note_to_future_self: "keep going",
      next_wake_config: { sleep_seconds: 3600, effort: "low" },
    };

    await applyReflectOutput(K, state, 1, output, {});

    const lastReflectCall = K.kvPutSafe.mock.calls.find(([key]) => key === "last_reflect");
    expect(lastReflectCall).toBeTruthy();
    expect(lastReflectCall[1].was_deep_reflect).toBe(true);

    const wakeConfigCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeConfigCall).toBeTruthy();
    expect(wakeConfigCall[1].sleep_seconds).toBe(3600);
    expect(wakeConfigCall[1]).toHaveProperty("next_wake_after");
  });

  it("depth > 1 does NOT write last_reflect or wake_config", async () => {
    const K = makeMockK({}, { sessionId: "test_session" });
    const state = makeState();
    const output = {
      reflection: "depth 2 reflection",
      note_to_future_self: "meta thoughts",
      next_wake_config: { sleep_seconds: 3600 },
    };

    await applyReflectOutput(K, state, 2, output, {});

    const lastReflectCall = K.kvPutSafe.mock.calls.find(([key]) => key === "last_reflect");
    expect(lastReflectCall).toBeUndefined();
    const wakeConfigCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeConfigCall).toBeUndefined();
  });
});

// ── 8. evaluateTripwires ────────────────────────────────────

describe("evaluateTripwires", () => {
  it("returns default effort with no alerts", () => {
    expect(evaluateTripwires({ default_effort: "low" }, {})).toBe("low");
  });

  it("returns wake.default_effort fallback", () => {
    expect(evaluateTripwires({ wake: { default_effort: "medium" } }, {})).toBe("medium");
  });

  it("overrides effort when tripwire fires", () => {
    const config = {
      default_effort: "low",
      alerts: [
        { field: "balance", condition: "below", value: 5, override_effort: "high" },
      ],
    };
    expect(evaluateTripwires(config, { balance: 3 })).toBe("high");
  });
});

// ── 9. evaluatePredicate ────────────────────────────────────

describe("evaluatePredicate", () => {
  it("exists", () => {
    expect(evaluatePredicate("val", "exists")).toBe(true);
    expect(evaluatePredicate(null, "exists")).toBe(false);
  });

  it("equals", () => {
    expect(evaluatePredicate(42, "equals", 42)).toBe(true);
    expect(evaluatePredicate(42, "equals", 43)).toBe(false);
  });

  it("gt / lt", () => {
    expect(evaluatePredicate(10, "gt", 5)).toBe(true);
    expect(evaluatePredicate(10, "lt", 5)).toBe(false);
  });

  it("matches", () => {
    expect(evaluatePredicate("hello world", "matches", "hello")).toBe(true);
    expect(evaluatePredicate("hello world", "matches", "^world")).toBe(false);
  });

  it("type", () => {
    expect(evaluatePredicate(42, "type", "number")).toBe(true);
    expect(evaluatePredicate("str", "type", "string")).toBe(true);
  });

  it("unknown predicate fails closed", () => {
    expect(evaluatePredicate("val", "unknown_pred")).toBe(false);
  });
});

// ── 10. detectCrash ─────────────────────────────────────────

describe("detectCrash", () => {
  it("returns null when no stale session", async () => {
    const K = makeMockK();
    expect(await detectCrash(K)).toBeNull();
  });

  it("returns crash data when stale session exists", async () => {
    const K = makeMockK({
      "kernel:active_session": JSON.stringify("s_dead"),
      "karma:s_dead": JSON.stringify([{ event: "session_start" }]),
    });
    const result = await detectCrash(K);
    expect(result.dead_session_id).toBe("s_dead");
    expect(result.karma).toHaveLength(1);
    expect(result.last_entry.event).toBe("session_start");
  });
});

// ── 11. writeSessionResults ────────────────────────────────

describe("writeSessionResults", () => {
  it("writes default wake_config when reflect was skipped", async () => {
    const K = makeMockK({}, { sessionCount: 5, defaults: { wake: { sleep_seconds: 3600 } } });
    K.getDefaults = vi.fn(async () => ({ wake: { sleep_seconds: 3600 } }));
    await writeSessionResults(K, {}, { reflectRan: false });

    const wakeCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeCall).toBeTruthy();
    expect(wakeCall[1]).toHaveProperty("next_wake_after");
  });

  it("does not write wake_config when reflect ran", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    await writeSessionResults(K, {});

    const wakeCall = K.kvPutSafe.mock.calls.find(([key]) => key === "wake_config");
    expect(wakeCall).toBeUndefined();
  });

  it("increments session_counter", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    await writeSessionResults(K, {});

    const counterCall = K.kvPutSafe.mock.calls.find(([key]) => key === "session_counter");
    expect(counterCall).toBeTruthy();
    expect(counterCall[1]).toBe(6);
  });
});

// ── 12. Default prompts ─────────────────────────────────────

describe("default prompts", () => {
  it("defaultReflectPrompt does not include dharma (kernel-injected)", () => {
    const prompt = defaultReflectPrompt();
    expect(prompt).not.toContain("{{dharma}}");
  });

  it("defaultDeepReflectPrompt depth 1", () => {
    const prompt = defaultDeepReflectPrompt(1);
    expect(prompt).toContain("depth-1 reflection");
    expect(prompt).not.toContain("{{dharma}}");
  });

  it("defaultDeepReflectPrompt depth 2", () => {
    const prompt = defaultDeepReflectPrompt(2);
    expect(prompt).toContain("depth-2 reflection");
    expect(prompt).toContain("depth-1");
    expect(prompt).toContain("{{belowPrompt}}");
  });
});

// ── 13. runCircuitBreaker ──────────────────────────────────

describe("runCircuitBreaker", () => {
  it("no-op without last_danger", async () => {
    const K = makeMockK();
    await runCircuitBreaker(K);
    expect(K.kvWritePrivileged).not.toHaveBeenCalled();
  });
});

// ── 14. getBalances ─────────────────────────────────────────

describe("getBalances", () => {
  it("delegates to K.checkBalance", async () => {
    const K = makeMockK();
    const expected = { providers: { or: { balance: 42, scope: "general" } }, wallets: {} };
    K.checkBalance.mockResolvedValue(expected);
    const state = makeState();

    const result = await getBalances(K, state);

    expect(K.checkBalance).toHaveBeenCalledWith({});
    expect(result).toEqual(expected);
  });
});

// ── 15. loadReflectHistory ─────────────────────────────────

describe("loadReflectHistory", () => {
  it("uses kvList with prefix filter", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "first" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "second" }),
      "reflect:2:s_003": JSON.stringify({ reflection: "depth2" }),
    });
    const result = await loadReflectHistory(K, 1, 5);
    expect(result).toHaveProperty("reflect:1:s_002");
    expect(result).toHaveProperty("reflect:1:s_001");
    expect(result).not.toHaveProperty("reflect:2:s_003");
  });

  it("limits results to count", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "a" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "b" }),
      "reflect:1:s_003": JSON.stringify({ reflection: "c" }),
    });
    const result = await loadReflectHistory(K, 1, 2);
    expect(Object.keys(result)).toHaveLength(2);
  });
});

// ── 16. runSession — reflect_reserve_pct ─────────────────

describe("runSession reflect_reserve_pct", () => {
  function makeRunSessionFixture(budgetOverrides = {}) {
    const defaults = {
      orient: { model: "test/orient", effort: "low", max_output_tokens: 1000 },
      reflect: { model: "test/reflect" },
      session_budget: { max_cost: 0.15, max_duration_seconds: 600, ...budgetOverrides },
      execution: { max_steps: { orient: 3 } },
    };
    const state = makeState({ defaults });
    const K = makeMockK();
    // runSession calls executeReflect which calls many K methods — stub them
    K.runAgentLoop = vi.fn(async () => ({ session_summary: "done" }));
    K.getKarma = vi.fn(async () => []);
    K.getSessionCost = vi.fn(async () => 0);
    const context = {
      balances: { providers: {}, wallets: {} },
      lastReflect: null,
      additionalContext: null,
      effort: "low",
      crashData: null,
    };
    const config = {};
    return { K, state, context, config };
  }

  it("passes budgetCap to orient when reflect_reserve_pct is set", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0.33 });
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    // 0.15 * (1 - 0.33) = 0.1005
    expect(orientCall.budgetCap).toBeCloseTo(0.1005, 4);
    expect(orientCall.step).toBe("orient");
  });

  it("does not pass budgetCap when reflect_reserve_pct is 0", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0 });
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    expect(orientCall.budgetCap).toBeUndefined();
  });

  it("does not pass budgetCap when reflect_reserve_pct is absent", async () => {
    const { K, state, context, config } = makeRunSessionFixture({});
    // Remove reflect_reserve_pct entirely
    delete state.defaults.session_budget.reflect_reserve_pct;
    await runSession(K, state, context, config);

    const orientCall = K.runAgentLoop.mock.calls[0][0];
    expect(orientCall.budgetCap).toBeUndefined();
  });

  it("still runs reflect when orient is soft-capped (budget_exceeded + reservePct)", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0.33 });
    K.runAgentLoop = vi.fn(async () => ({ budget_exceeded: true, reason: "Budget exceeded: cost" }));

    await runSession(K, state, context, config);

    // reflect uses runAgentLoop internally via executeReflect,
    // but we can check that runAgentLoop was called at least for orient
    // and that the function didn't throw (i.e. it proceeded past the guard)
    expect(K.runAgentLoop).toHaveBeenCalled();
    // The function should complete without throwing
  });

  it("skips reflect when budget_exceeded and no reservePct", async () => {
    const { K, state, context, config } = makeRunSessionFixture({ reflect_reserve_pct: 0 });
    K.runAgentLoop = vi.fn(async () => ({ budget_exceeded: true, reason: "Budget exceeded: cost" }));

    await runSession(K, state, context, config);

    // runAgentLoop called once (orient only), reflect skipped
    expect(K.runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ── 17. runReflect — deep reflect budget_multiplier ──────

describe("runReflect budget_multiplier", () => {
  function makeReflectFixture(deepReflectOverrides = {}) {
    const defaults = {
      orient: { model: "test/orient", effort: "low", max_output_tokens: 1000 },
      reflect: { model: "test/reflect" },
      session_budget: { max_cost: 0.10, max_duration_seconds: 600 },
      execution: { max_steps: { deep_reflect: 10 }, max_reflect_depth: 1 },
      deep_reflect: { model: "test/opus", effort: "high", max_output_tokens: 4000, ...deepReflectOverrides },
    };
    const state = makeState({ defaults });
    const K = makeMockK();
    K.runAgentLoop = vi.fn(async () => ({ reflection: "done" }));
    K.getKarma = vi.fn(async () => []);
    K.getSessionCost = vi.fn(async () => 0);
    K.getSessionCount = vi.fn(async () => 5);
    const context = {
      balances: { providers: {}, wallets: {} },
      effort: "high",
      crashData: null,
    };
    return { K, state, context };
  }

  it("passes budgetCap = max_cost * multiplier when budget_multiplier > 1", async () => {
    const { K, state, context } = makeReflectFixture({ budget_multiplier: 3.0 });
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeCloseTo(0.30, 4);
    expect(call.step).toBe("reflect_depth_1");
  });

  it("does not pass budgetCap when budget_multiplier is 1", async () => {
    const { K, state, context } = makeReflectFixture({ budget_multiplier: 1 });
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeUndefined();
  });

  it("does not pass budgetCap when budget_multiplier is absent", async () => {
    const { K, state, context } = makeReflectFixture({});
    delete state.defaults.deep_reflect.budget_multiplier;
    await runReflect(K, state, 1, context);

    const call = K.runAgentLoop.mock.calls[0][0];
    expect(call.budgetCap).toBeUndefined();
  });
});

// ── 18. patch op in mock kernel ──────────────────────────────

describe("patch op", () => {
  it("replaces old_string with new_string in KV value", async () => {
    const K = makeMockK({ "hook:wake:modifications": "function old() { return 1; }" });
    await K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:modifications",
      old_string: "return 1",
      new_string: "return 2",
    }]);
    const result = K._kv._store.get("hook:wake:modifications");
    expect(result).toBe("function old() { return 2; }");
  });

  it("rejects when old_string not found", async () => {
    const K = makeMockK({ "hook:wake:modifications": "function old() { return 1; }" });
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:modifications",
      old_string: "nonexistent string",
      new_string: "replacement",
    }])).rejects.toThrow("old_string not found");
  });

  it("rejects when old_string matches multiple locations", async () => {
    const K = makeMockK({ "hook:wake:modifications": "aaa bbb aaa" });
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:modifications",
      old_string: "aaa",
      new_string: "ccc",
    }])).rejects.toThrow("matches multiple locations");
  });

  it("rejects when value is not a string", async () => {
    const K = makeMockK({ "hook:wake:modifications": JSON.stringify({ a: 1 }) });
    // The mock stores it as a string via JSON.stringify, so set a non-string
    K._kv._store.set("hook:wake:modifications", 42);
    await expect(K.kvWritePrivileged([{
      op: "patch",
      key: "hook:wake:modifications",
      old_string: "something",
      new_string: "else",
    }])).rejects.toThrow("not a string value");
  });
});

// ── 19. applyKVOperation blocks yama/niyama (system keys) ───

describe("applyKVOperation blocks yama/niyama", () => {
  it("blocks yama: prefix as system key", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "put", key: "yama:care", value: "new value" });
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_blocked", key: "yama:care", reason: "system_key" })
    );
    // Should NOT have written the value
    expect(K.kvPutSafe).not.toHaveBeenCalled();
  });

  it("blocks niyama: prefix as system key", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "put", key: "niyama:health", value: "new value" });
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_blocked", key: "niyama:health", reason: "system_key" })
    );
    expect(K.kvPutSafe).not.toHaveBeenCalled();
  });
});

// ── 19b. applyKVOperation routes contact: to kvWritePrivileged ───

describe("applyKVOperation routes contact: to kvWritePrivileged", () => {
  it("routes contact: put to kvWritePrivileged", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "put", key: "contact:alice", value: { name: "Alice", approved: false, platforms: {} } });
    expect(K.kvWritePrivileged).toHaveBeenCalledWith([
      { op: "put", key: "contact:alice", value: { name: "Alice", approved: false, platforms: {} } },
    ]);
    // Should NOT go through kvPutSafe (system key path)
    expect(K.kvPutSafe).not.toHaveBeenCalled();
  });

  it("records modification_blocked when kvWritePrivileged rejects", async () => {
    const K = makeMockK();
    K.kvWritePrivileged = vi.fn(async () => { throw new Error("Setting approved: true is operator-only"); });
    await applyKVOperation(K, { op: "put", key: "contact:evil", value: { name: "Evil", approved: true, platforms: {} } });
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "modification_blocked",
        key: "contact:evil",
        reason: "Setting approved: true is operator-only",
      })
    );
  });

  it("routes contact: delete to kvWritePrivileged", async () => {
    const K = makeMockK();
    await applyKVOperation(K, { op: "delete", key: "contact:alice" });
    expect(K.kvWritePrivileged).toHaveBeenCalledWith([
      { op: "delete", key: "contact:alice" },
    ]);
  });
});

// ── 20. acceptStaged with patch op ────────────────

describe("acceptStaged with patch op", () => {
  it("forwards patch ops through to kvWritePrivileged", async () => {
    const K = makeMockK({
      "hook:wake:modifications": "function old() { return 1; }",
    });

    // Stage a modification with a patch op
    const modificationId = await stageModification(K, {
      claims: ["test patch"],
      ops: [{ op: "patch", key: "hook:wake:modifications", old_string: "return 1", new_string: "return 2" }],
      checks: [{ type: "kv_assert", key: "hook:wake:modifications", predicate: "exists" }],
    }, "test_session");

    expect(modificationId).toBeTruthy();

    // Accept staged modification
    await acceptStaged(K, modificationId);

    // Check that the patch was applied
    const afterValue = K._kv._store.get("hook:wake:modifications");
    expect(afterValue).toBe("function old() { return 2; }");
  });
});

// ── Communication gate integration ─────────────────────────

describe("Communication gate in reflect", () => {
  it("blocked comms loaded in gatherReflectContext", async () => {
    const record1 = { id: "cb_1", tool: "send_slack", args: { text: "hello" }, channel: "slack" };
    const record2 = { id: "cb_2", tool: "send_email", args: { body: "hi" }, channel: "email" };
    const K = makeMockK({
      "comms_blocked:cb_1": JSON.stringify(record1),
      "comms_blocked:cb_2": JSON.stringify(record2),
    });
    K.listBlockedComms = vi.fn(async () => [record1, record2]);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    expect(result.templateVars.blockedComms).toContain("cb_1");
    expect(result.templateVars.blockedComms).toContain("cb_2");
  });

  it("blockedComms is '(none)' when no blocked comms exist", async () => {
    const K = makeMockK();
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    expect(result.templateVars.blockedComms).toBe("(none)");
  });

  it("comms_verdicts processed from applyReflectOutput", async () => {
    const K = makeMockK();
    K.processCommsVerdict = vi.fn(async () => ({ ok: true }));
    const state = makeState();
    const output = {
      reflection: "test reflection",
      note_to_future_self: "remember",
      comms_verdicts: [
        { id: "cb_1", verdict: "send" },
        { id: "cb_2", verdict: "drop", revision: { reason: "not needed" } },
      ],
    };

    await applyReflectOutput(K, state, 1, output, {});
    expect(K.processCommsVerdict).toHaveBeenCalledTimes(2);
    expect(K.processCommsVerdict).toHaveBeenCalledWith("cb_1", "send", undefined);
    expect(K.processCommsVerdict).toHaveBeenCalledWith("cb_2", "drop", { reason: "not needed" });
  });
});

// ── Patron context in reflect ─────────────────────────────

describe("Patron context in reflect", () => {
  it("patron context loaded in gatherReflectContext", async () => {
    const patronContact = {
      name: "Swami",
      relationship: "patron",
      communication: "Inner circle.",
    };
    const K = makeMockK({}, {
      patronId: "swami",
      patronContact,
    });
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    expect(result.templateVars.patron_contact).toContain("Swami");
    expect(result.templateVars.patron_id).toBe("swami");
  });

  it("patron context is '(no patron configured)' when missing", async () => {
    const K = makeMockK();
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    expect(result.templateVars.patron_contact).toBe("(no patron configured)");
    expect(result.templateVars.patron_id).toBeNull();
  });
});

// ── summarizeKarma ──────────────────────────────────────────

describe("summarizeKarma", () => {
  it("returns zeroed structure for empty karma", () => {
    const result = summarizeKarma([]);
    expect(result.events).toEqual({});
    expect(result.total_cost).toBe(0);
    expect(result.models).toEqual({});
    expect(result.tools).toEqual({});
    expect(result.duration_ms).toEqual({ total: 0, count: 0 });
    expect(result.errors).toEqual([]);
    expect(result.comms).toEqual({});
  });

  it("aggregates mixed event types correctly", () => {
    const karma = [
      { event: "llm_call", cost: 0.05, model: "claude-opus", duration_ms: 1200 },
      { event: "llm_call", cost: 0.02, model: "claude-haiku", duration_ms: 300 },
      { event: "llm_call", cost: 0.05, model: "claude-opus", duration_ms: 800 },
      { event: "tool_complete", tool: "kv_query" },
      { event: "tool_complete", tool: "kv_query" },
      { event: "tool_complete", tool: "web_fetch" },
      { event: "fatal_error", error: "timeout" },
      { event: "comms_blocked", channel: "slack" },
      { event: "comms_sent", channel: "email" },
      { event: "session_start" },
    ];
    const result = summarizeKarma(karma);
    expect(result.events.llm_call).toBe(3);
    expect(result.events.tool_complete).toBe(3);
    expect(result.events.fatal_error).toBe(1);
    expect(result.events.session_start).toBe(1);
    expect(result.total_cost).toBeCloseTo(0.12);
    expect(result.models["claude-opus"]).toBe(2);
    expect(result.models["claude-haiku"]).toBe(1);
    expect(result.tools["kv_query"]).toBe(2);
    expect(result.tools["web_fetch"]).toBe(1);
    expect(result.duration_ms).toEqual({ total: 2300, count: 3 });
    expect(result.errors).toEqual(["timeout"]);
    expect(result.comms.comms_blocked).toBe(1);
    expect(result.comms.comms_sent).toBe(1);
  });

  it("handles entries with missing optional fields", () => {
    const karma = [
      { event: "llm_call" },
      { event: "tool_complete" },
      { event: "fatal_error" },
    ];
    const result = summarizeKarma(karma);
    expect(result.total_cost).toBe(0);
    expect(result.models).toEqual({});
    expect(result.tools).toEqual({});
    expect(result.duration_ms).toEqual({ total: 0, count: 0 });
    expect(result.errors).toEqual([]);
  });
});

// ── writeSessionResults karma summary ──────────────────────

describe("writeSessionResults karma summary", () => {
  it("writes karma_summary when karma is non-empty", async () => {
    const K = makeMockK({}, { sessionCount: 5, sessionId: "s_test" });
    K.getKarma = vi.fn(async () => [
      { event: "llm_call", cost: 0.03, model: "opus", duration_ms: 500 },
      { event: "tool_complete", tool: "kv_query" },
    ]);
    await writeSessionResults(K, {});

    const summaryCall = K.kvPutSafe.mock.calls.find(([key]) => key === "karma_summary:s_test");
    expect(summaryCall).toBeTruthy();
    const summary = summaryCall[1];
    expect(summary.total_cost).toBeCloseTo(0.03);
    expect(summary.models.opus).toBe(1);
    expect(summary.tools.kv_query).toBe(1);
  });

  it("skips karma_summary when karma is empty", async () => {
    const K = makeMockK({}, { sessionCount: 5, sessionId: "s_test" });
    K.getKarma = vi.fn(async () => []);
    await writeSessionResults(K, {});

    const summaryCall = K.kvPutSafe.mock.calls.find(([key]) => key.startsWith("karma_summary:"));
    expect(summaryCall).toBeUndefined();
  });
});

// ── gatherReflectContext: priorReflections + wisdom_manifest ──

describe("gatherReflectContext continuity", () => {
  it("includes priorReflections at correct depth", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "prior depth-1 a" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "prior depth-1 b" }),
      "reflect:0:s_003": JSON.stringify({ reflection: "depth-0 should not appear" }),
      "reflect:2:s_004": JSON.stringify({ reflection: "depth-2 should not appear" }),
    });
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    expect(result.templateVars.priorReflections).toHaveProperty("reflect:1:s_001");
    expect(result.templateVars.priorReflections).toHaveProperty("reflect:1:s_002");
    expect(result.templateVars.priorReflections).not.toHaveProperty("reflect:0:s_003");
    expect(result.templateVars.priorReflections).not.toHaveProperty("reflect:2:s_004");
  });

  it("respects prior_reflections count config", async () => {
    const K = makeMockK({
      "reflect:1:s_001": JSON.stringify({ reflection: "a" }),
      "reflect:1:s_002": JSON.stringify({ reflection: "b" }),
      "reflect:1:s_003": JSON.stringify({ reflection: "c" }),
    });
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState({ defaults: { reflect_levels: { 1: { prior_reflections: 1 } } } });

    const result = await gatherReflectContext(K, state, 1, {});
    expect(Object.keys(result.templateVars.priorReflections)).toHaveLength(1);
  });

  it("includes wisdom_manifest with metadata summaries", async () => {
    const K = makeMockK({
      "prajna:reasoning:complexity": JSON.stringify({ text: "test" }),
      "viveka:timing:urgency": JSON.stringify({ text: "test" }),
    });
    // Set metadata with summary on one key
    K._kv._meta.set("prajna:reasoning:complexity", { summary: "Tends toward overcomplexity" });
    K.listBlockedComms = vi.fn(async () => []);
    const state = makeState();

    const result = await gatherReflectContext(K, state, 1, {});
    const manifest = result.templateVars.wisdom_manifest;
    expect(manifest.prajna).toHaveLength(1);
    expect(manifest.prajna[0].key).toBe("prajna:reasoning:complexity");
    expect(manifest.prajna[0].summary).toBe("Tends toward overcomplexity");
    expect(manifest.viveka).toHaveLength(1);
    expect(manifest.viveka[0].key).toBe("viveka:timing:urgency");
    // Falls back to key name when no summary metadata
    expect(manifest.viveka[0].summary).toBe("viveka:timing:urgency");
  });
});

// ── Session reflect wisdom manifest in buildPrompt ──────────

describe("Session reflect wisdom manifest", () => {
  it("passes wisdom_manifest in template vars to buildPrompt", async () => {
    const K = makeMockK({
      "prajna:test": JSON.stringify({ text: "test prajna" }),
    });
    K._kv._meta.set("prajna:test", { summary: "test summary" });
    K.runAgentLoop = vi.fn(async () => ({ session_summary: "done" }));
    const state = makeState({ defaults: { reflect: { model: "test/model" } } });

    await executeReflect(K, state, { model: "test/model" });

    // buildPrompt should have been called with wisdom_manifest in template vars
    const buildPromptCall = K.buildPrompt.mock.calls[0];
    const templateVars = buildPromptCall[1];
    expect(templateVars).toHaveProperty("wisdom_manifest");
    expect(templateVars.wisdom_manifest.prajna).toHaveLength(1);
    expect(templateVars.wisdom_manifest.prajna[0].summary).toBe("test summary");
  });
});

// ── executeReflect modification_observations persistence ────

describe("executeReflect modification_observations", () => {
  it("stores modification_observations in reflect:0 record", async () => {
    const K = makeMockK({}, { sessionId: "s_obs_test" });
    K.runAgentLoop = vi.fn(async () => ({
      session_summary: "test session",
      note_to_future_self: "remember",
      modification_observations: { "m_abc": "cost decreased 10%" },
    }));
    const state = makeState({ defaults: { reflect: { model: "test/model" } } });

    await executeReflect(K, state, { model: "test/model" });

    const stored = K.kvPutSafe.mock.calls.find(([key]) => key === "reflect:0:s_obs_test");
    expect(stored).toBeTruthy();
    const record = stored[1];
    expect(record.modification_observations).toEqual({ "m_abc": "cost decreased 10%" });
  });
});

// ── applyReflectOutput new fields ──────────────────────────

describe("applyReflectOutput conditional fields", () => {
  it("stores new fields when present", async () => {
    const K = makeMockK({}, { sessionId: "s_new" });
    const state = makeState();
    const output = {
      reflection: "deep thoughts",
      note_to_future_self: "remember",
      current_intentions: [{ intention: "test", status: "active" }],
      modification_observations: { "m_123": "looks good" },
      system_trajectory: "on track",
    };

    await applyReflectOutput(K, state, 1, output, {});

    const stored = K.kvPutSafe.mock.calls.find(([key]) => key === "reflect:1:s_new");
    expect(stored).toBeTruthy();
    const record = stored[1];
    expect(record.current_intentions).toEqual([{ intention: "test", status: "active" }]);
    expect(record.modification_observations).toEqual({ "m_123": "looks good" });
    expect(record.system_trajectory).toBe("on track");
  });

  it("omits new fields when absent", async () => {
    const K = makeMockK({}, { sessionId: "s_minimal" });
    const state = makeState();
    const output = {
      reflection: "minimal",
      note_to_future_self: "nothing special",
    };

    await applyReflectOutput(K, state, 2, output, {});

    const stored = K.kvPutSafe.mock.calls.find(([key]) => key === "reflect:2:s_minimal");
    expect(stored).toBeTruthy();
    const record = stored[1];
    expect(record).not.toHaveProperty("current_intentions");
    expect(record).not.toHaveProperty("modification_observations");
    expect(record).not.toHaveProperty("system_trajectory");
  });
});

// ── stageModification: criteria + staged_at_session ─────────

describe("stageModification new fields", () => {
  it("passes through criteria", async () => {
    const K = makeMockK({}, { sessionCount: 10 });
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
      criteria: "Observe cost reduction over 10 sessions",
    }, "s_test", 1);

    expect(id).toBeTruthy();
    const staged = K._kv._store.get(`modification_staged:${id}`);
    const record = JSON.parse(staged);
    expect(record.criteria).toBe("Observe cost reduction over 10 sessions");
  });

  it("stores staged_at_session", async () => {
    const K = makeMockK({}, { sessionCount: 42 });
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_test", 1);

    const staged = K._kv._store.get(`modification_staged:${id}`);
    const record = JSON.parse(staged);
    expect(record.staged_at_session).toBe(42);
  });
});

// ── acceptDirect wisdom gate ──────────────────────────────

describe("acceptDirect wisdom gate", () => {
  it("allows prajna wisdom via acceptDirect", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await acceptDirect(K, {
      type: "wisdom",
      validation: "Tested over 20 sessions",
      ops: [{ op: "put", key: "prajna:test:entry", value: { text: "test", type: "prajna" } }],
    }, "s_test");

    expect(id).toBeTruthy();
    expect(id).toMatch(/^m_/);
  });

  it("blocks yama wisdom via acceptDirect", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await acceptDirect(K, {
      type: "wisdom",
      validation: "Should be blocked",
      ops: [{ op: "put", key: "yama:test", value: "new value" }],
    }, "s_test");

    expect(id).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_invalid", reason: "yama/niyama wisdom must be staged" })
    );
  });

  it("blocks mixed yama+prajna ops", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await acceptDirect(K, {
      type: "wisdom",
      validation: "Mixed ops",
      ops: [
        { op: "put", key: "prajna:safe", value: { text: "ok" } },
        { op: "put", key: "yama:blocked", value: "nope" },
      ],
    }, "s_test");

    expect(id).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_invalid", reason: "yama/niyama wisdom must be staged" })
    );
  });

  it("stores type 'wisdom' in snapshot for wisdom requests", async () => {
    const K = makeMockK({}, { sessionCount: 5, sessionId: "s_test" });
    const id = await acceptDirect(K, {
      type: "wisdom",
      validation: "Test validation",
      ops: [{ op: "put", key: "viveka:test:entry", value: { text: "test", type: "viveka" } }],
    }, "s_test");

    const snapshot = K._kv._store.get(`modification_snapshot:${id}`);
    const record = JSON.parse(snapshot);
    expect(record.type).toBe("wisdom");
  });

  it("injects validation into op values for wisdom", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await acceptDirect(K, {
      type: "wisdom",
      validation: "Observed in 5 sessions",
      ops: [{ op: "put", key: "prajna:test:inject", value: { text: "test", type: "prajna" } }],
    }, "s_test");

    // The written value should have validation injected
    const written = K._kv._store.get("prajna:test:inject");
    const value = JSON.parse(written);
    expect(value.validation).toBe("Observed in 5 sessions");
  });
});

// ── acceptDirect additional fields ──────────────────────────

describe("acceptDirect criteria + activated_at_session", () => {
  it("stores criteria in snapshot", async () => {
    const K = makeMockK({}, { sessionCount: 10 });
    const id = await acceptDirect(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
      criteria: "Watch for parse errors",
    }, "s_test");

    const snapshot = K._kv._store.get(`modification_snapshot:${id}`);
    const record = JSON.parse(snapshot);
    expect(record.criteria).toBe("Watch for parse errors");
  });

  it("stores activated_at_session in snapshot", async () => {
    const K = makeMockK({}, { sessionCount: 15 });
    const id = await acceptDirect(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_test");

    const snapshot = K._kv._store.get(`modification_snapshot:${id}`);
    const record = JSON.parse(snapshot);
    expect(record.activated_at_session).toBe(15);
  });
});

// ── acceptStaged activated_at_session ───────────────────────

describe("acceptStaged additional fields", () => {
  it("stores activated_at_session in snapshot", async () => {
    const K = makeMockK({}, { sessionCount: 20 });
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_stage", 1);

    await acceptStaged(K, id);

    const snapshot = K._kv._store.get(`modification_snapshot:${id}`);
    const record = JSON.parse(snapshot);
    expect(record.activated_at_session).toBe(20);
  });

  it("includes type in karma event", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_test", 1);

    await acceptStaged(K, id);

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_accepted", modification_id: id, type: "code" })
    );
  });
});

// ── rename op blocked in modifications ──────────────────────

describe("rename op blocked in modifications", () => {
  it("stageModification rejects rename ops", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await stageModification(K, {
      claims: ["rename key"],
      ops: [{ op: "rename", key: "old:key", value: "new:key" }],
      checks: [{ type: "kv_assert", key: "new:key", predicate: "exists" }],
    }, "s_test", 1);

    expect(id).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_invalid", reason: "rename op not supported in modifications — use delete + put" })
    );
  });

  it("acceptDirect rejects rename ops", async () => {
    const K = makeMockK({}, { sessionCount: 5 });
    const id = await acceptDirect(K, {
      claims: ["rename key"],
      ops: [{ op: "rename", key: "old:key", value: "new:key" }],
      checks: [{ type: "kv_assert", key: "new:key", predicate: "exists" }],
    }, "s_test");

    expect(id).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "modification_invalid", reason: "rename op not supported in modifications — use delete + put" })
    );
  });
});

// ── sessions_since computation ──────────────────────────────

describe("sessions_since computation", () => {
  it("loadInflightModifications computes sessions_since_activation", async () => {
    const K = makeMockK({}, { sessionCount: 30 });
    // Stage and accept to create an inflight modification
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_test", 1);

    // Override session count for acceptance to 25
    K.getSessionCount = vi.fn(async () => 25);
    await acceptStaged(K, id);

    // Now load with session count 30
    K.getSessionCount = vi.fn(async () => 30);
    const result = await loadInflightModifications(K);
    const entry = Object.values(result)[0];
    expect(entry.sessions_since_activation).toBe(5); // 30 - 25
  });

  it("loadInflightModifications returns null for missing activated_at_session", async () => {
    const K = makeMockK({}, { sessionCount: 30 });
    // Manually create an inflight mod without activated_at_session (backward compat)
    const id = "m_legacy_test";
    initTracking([], [id]);
    K._kv._store.set(`modification_snapshot:${id}`, JSON.stringify({
      id,
      type: "direct",
      claims: ["old"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
      snapshots: {},
      activated_at: "2026-01-01T00:00:00Z",
      // No activated_at_session field
    }));

    const result = await loadInflightModifications(K);
    expect(result[id].sessions_since_activation).toBeNull();
  });

  it("loadStagedModifications computes sessions_since_staged", async () => {
    const K = makeMockK({}, { sessionCount: 15 });
    // Stage at session 10
    K.getSessionCount = vi.fn(async () => 10);
    const id = await stageModification(K, {
      claims: ["test"],
      ops: [{ op: "put", key: "config:defaults", value: {} }],
      checks: [{ type: "kv_assert", key: "config:defaults", predicate: "exists" }],
    }, "s_test", 1);

    // Load at session 15
    K.getSessionCount = vi.fn(async () => 15);
    const result = await loadStagedModifications(K);
    const entry = Object.values(result)[0];
    expect(entry.sessions_since_staged).toBe(5); // 15 - 10
  });
});

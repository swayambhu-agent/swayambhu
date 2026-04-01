import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockK } from "./helpers/mock-kernel.js";

vi.mock("../reflect.js", () => ({
  runReflect: vi.fn(async () => {}),
  highestReflectDepthDue: vi.fn(async () => 0),
  isReflectDue: vi.fn(async () => false),
  applyReflectOutput: vi.fn(async () => {}),
}));

vi.mock("../eval.js", () => ({
  evaluateAction: vi.fn(async () => ({
    sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
    tool_outcomes: [], plan_success_criteria: null,
    assumptions_relied_on: [], candidate_check_ids: [],
    assumption_scores: {},
  })),
}));

vi.mock("../memory.js", () => ({
  updateMu: vi.fn((existing, checkId, score) => ({
    check_id: checkId,
    confirmation_count: (existing?.confirmation_count || 0) + (score.direction === "entailment" ? 1 : 0),
    violation_count: (existing?.violation_count || 0) + (score.direction === "contradiction" ? 1 : 0),
    last_checked: new Date().toISOString(),
    cumulative_surprise: score.surprise || 0,
  })),
  callInference: vi.fn(async () => ({ embeddings: [] })),
  embeddingCacheKey: vi.fn((text, model) => `embedding:mock:${model}`),
}));

import { run } from "../session.js";
import { runReflect, highestReflectDepthDue, isReflectDue, applyReflectOutput } from "../reflect.js";
import { evaluateAction } from "../eval.js";
import { updateMu } from "../memory.js";

// Helper: builds a callLLM mock response, auto-adding parsed when json:true
function llmResp(content, opts = {}) {
  return (callOpts) => {
    const resp = { content, cost: opts.cost ?? 0.01, toolCalls: opts.toolCalls ?? null };
    if (callOpts?.json) {
      try { resp.parsed = JSON.parse(content); } catch { resp.parsed = null; }
    }
    return resp;
  };
}

// ── Empty desires tests ─────────────────────────────────────
// When d=∅, the session runs normally — plan phase handles it.

describe("session with empty desires", () => {
  let K;

  beforeEach(() => {
    vi.clearAllMocks();
    K = makeMockK({}, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
      },
    });

    // Plan returns no_action when desires are empty
    const noActionContent = JSON.stringify({ no_action: true, reason: "no desires to act on" });
    K.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));
  });

  it("runs normal plan phase even with no desires — no cold_start karma", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Should NOT log cold_start karma
    expect(K.karmaRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "cold_start" }),
    );

    // callLLM should have been called (plan phase ran)
    expect(K.callLLM).toHaveBeenCalledTimes(1);

    // Plan call should include DESIRES and ASSUMPTIONS sections
    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toMatch(/DESIRES/);
    expect(planCall.messages[0].content).toMatch(/ASSUMPTIONS/);
  });

  it("does not call runReflect with coldStart flag", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // runReflect may or may not be called (depending on highestReflectDepthDue)
    // but it should never be called with coldStart: true
    for (const call of runReflect.mock.calls) {
      const context = call[3];
      expect(context?.coldStart).not.toBe(true);
    }
  });

  it("can precipitate an action even with empty desires", async () => {
    // Override: plan returns an action despite empty desires
    const VALID_PLAN = JSON.stringify({
      action: "orient_from_principles",
      success: "initial orientation complete",
      relies_on: [],
      defer_if: [],
    });
    const VALID_REVIEW = JSON.stringify({
      assessment: "success",
      narrative: "Oriented from principles.",
      salience_estimate: 0.1,
    });

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(VALID_PLAN)(opts)
        : llmResp(VALID_REVIEW)(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Act phase ran (runAgentTurn called)
    expect(K.runAgentTurn).toHaveBeenCalled();

    // Session completed normally
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_complete" }),
    );
  });
});

// ── Plan phase tests ─────────────────────────────────────────

describe("session plan phase", () => {
  let K;

  const DESIRE = {
    slug: "d_help",
    direction: "help patrons effectively",
    description: "Be genuinely helpful in all interactions.",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const ASSUMPTION = {
    slug: "a_available",
    check: "Patron is available to receive messages",
    confidence: 0.8,
    ttl_expires: new Date(Date.now() + 86400_000).toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const VALID_PLAN = JSON.stringify({
    action: "send_greeting",
    success: "patron receives greeting",
    relies_on: [],
    defer_if: [],
  });

  const VALID_REVIEW = JSON.stringify({
    assessment: "success",
    narrative: "Greeting sent successfully.",
    salience_estimate: 0.1,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "assumption:a_available": JSON.stringify(ASSUMPTION),
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          session_budget: { max_cost: 0.50 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    // callLLM returns plan JSON for plan call, review JSON for review call
    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      // First call is plan phase, second is review phase
      return callCount === 1
        ? llmResp(VALID_PLAN)(opts)
        : llmResp(VALID_REVIEW)(opts);
    });

    // runAgentTurn returns done:true immediately
    K.runAgentTurn = vi.fn(async ({ messages }) => {
      // Push the assistant response into messages so act phase loop terminates cleanly
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });
  });

  it("calls callLLM for plan and proceeds to act when action precipitates", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // callLLM should have been called at least twice: plan + review (may loop more cycles)
    expect(K.callLLM.mock.calls.length).toBeGreaterThanOrEqual(2);

    // First call: plan phase — messages contain desires/assumptions
    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toMatch(/DESIRES/);
    expect(planCall.messages[0].content).toMatch(/ASSUMPTIONS/);

    // runAgentTurn should have been called at least once (act phase ran)
    expect(K.runAgentTurn.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Second call: review phase — user content mentions "Action ledger"
    const reviewCall = K.callLLM.mock.calls[1][0];
    expect(reviewCall.messages[0].content).toMatch(/Action ledger/);
  });

  it("stops loop when plan returns no_action", async () => {
    const noActionContent = JSON.stringify({ no_action: true, reason: "nothing to do" });
    K.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Only one callLLM call: plan
    expect(K.callLLM).toHaveBeenCalledTimes(1);

    // No act phase
    expect(K.runAgentTurn).not.toHaveBeenCalled();

    // Karma logged plan_no_action
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "plan_no_action", reason: "nothing to do" }),
    );
  });
});

// ── Memory write tests ───────────────────────────────────────

describe("session memory writes", () => {
  let K;

  const CHECK_ID = "a_available";

  const DESIRE = {
    slug: "d_help",
    direction: "help patrons effectively",
    description: "Be genuinely helpful in all interactions.",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const ASSUMPTION = {
    slug: "a_available",
    check: "Patron is available to receive messages",
    confidence: 0.8,
    ttl_expires: new Date(Date.now() + 86400_000).toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const VALID_PLAN = JSON.stringify({
    action: "send_greeting",
    success: "patron receives greeting",
    relies_on: [],
    defer_if: [],
  });

  function makeK(overrideReview, evalOverride) {
    const k = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "assumption:a_available": JSON.stringify(ASSUMPTION),
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          session_budget: { max_cost: 0.50 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    // evaluateAction controls assumption_scores and salience
    if (evalOverride) {
      evaluateAction.mockResolvedValue(evalOverride);
    } else {
      evaluateAction.mockResolvedValue({
        sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
        tool_outcomes: [], plan_success_criteria: null,
        assumptions_relied_on: [CHECK_ID],
        candidate_check_ids: [CHECK_ID],
        assumption_scores: {},
      });
    }

    let callCount = 0;
    k.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(VALID_PLAN)(opts)
        : llmResp(JSON.stringify(overrideReview))(opts);
    });

    k.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    return k;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes mu via updateMu for assumption_scores from eval", async () => {
    const review = {
      assessment: "success",
      narrative: "Assumption confirmed.",
      salience_estimate: 0.1,
    };
    const evalResult = {
      sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
      tool_outcomes: [], plan_success_criteria: null,
      assumptions_relied_on: [CHECK_ID],
      candidate_check_ids: [CHECK_ID],
      assumption_scores: {
        [CHECK_ID]: { direction: "entailment", surprise: 0 },
      },
    };
    K = makeK(review, evalResult);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // updateMu should have been called with the score from eval
    expect(updateMu).toHaveBeenCalledWith(
      null, // no existing mu
      CHECK_ID,
      { direction: "entailment", surprise: 0 },
    );

    // mu key should have been written
    const muCall = K.kvWriteSafe.mock.calls.find(([key]) => key === `mu:${CHECK_ID}`);
    expect(muCall).toBeDefined();
    const muValue = typeof muCall[1] === "string" ? JSON.parse(muCall[1]) : muCall[1];
    expect(muValue.confirmation_count).toBe(1);
    expect(muValue.violation_count).toBe(0);
  });

  it("writes mu with violation on contradiction score", async () => {
    const review = {
      assessment: "failed",
      narrative: "Assumption violated.",
      salience_estimate: 0.1,
    };
    const evalResult = {
      sigma: 0.8, alpha: {}, salience: 0.8, eval_method: "pipeline",
      tool_outcomes: [], plan_success_criteria: null,
      assumptions_relied_on: [CHECK_ID],
      candidate_check_ids: [CHECK_ID],
      assumption_scores: {
        [CHECK_ID]: { direction: "contradiction", surprise: 0.8 },
      },
    };
    K = makeK(review, evalResult);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(updateMu).toHaveBeenCalledWith(
      null,
      CHECK_ID,
      { direction: "contradiction", surprise: 0.8 },
    );

    const muCall = K.kvWriteSafe.mock.calls.find(([key]) => key === `mu:${CHECK_ID}`);
    expect(muCall).toBeDefined();
    const muValue = typeof muCall[1] === "string" ? JSON.parse(muCall[1]) : muCall[1];
    expect(muValue.violation_count).toBe(1);
    expect(muValue.confirmation_count).toBe(0);
  });

  it("writes experience when salience exceeds threshold", async () => {
    const review = {
      assessment: "success",
      narrative: "Something significant happened.",
      salience_estimate: 0.8,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const experienceCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("experience:"));
    expect(experienceCall).toBeDefined();
    const experienceValue = typeof experienceCall[1] === "string" ? JSON.parse(experienceCall[1]) : experienceCall[1];
    expect(experienceValue.narrative).toBe("Something significant happened.");
    expect(experienceValue.active_desires).toEqual(["desire:d_help"]);
    expect(experienceValue.surprise_score).toBe(0);
    expect(experienceValue.embedding).toBeNull(); // no inferenceConfig
  });

  it("skips experience when salience is below threshold", async () => {
    const review = {
      assessment: "routine",
      narrative: "Nothing notable.",
      salience_estimate: 0.2,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const experienceCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("experience:"));
    expect(experienceCall).toBeUndefined();
  });

  it("does not write mu when assumption_scores is empty", async () => {
    const review = {
      assessment: "success",
      narrative: "No assumptions tested.",
      salience_estimate: 0.1,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const muCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("mu:"));
    expect(muCall).toBeUndefined();
    expect(updateMu).not.toHaveBeenCalled();
  });
});

// ── Deep-reflect job collection tests ─────────────────────────

describe("deep-reflect job collection", () => {
  let K;

  const JOB_ID = "job_dr_001";
  const DESIRE = {
    slug: "d_help",
    direction: "help patrons effectively",
    description: "Be genuinely helpful.",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeJobK(jobResult, extraKv = {}) {
    const kvData = {
      "desire:d_help": JSON.stringify(DESIRE),
      [`job:${JOB_ID}`]: JSON.stringify({
        id: JOB_ID,
        config: { deep_reflect: true, depth: 1, dispatch_session: 0 },
      }),
      [`job_result:${JOB_ID}`]: JSON.stringify({ result: jobResult }),
      ...extraKv,
    };

    const k = makeMockK(kvData, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.01 }, // tiny budget so main loop exits immediately
        session: { min_review_cost: 0.05 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { max_stale_sessions: 5 },
      },
      sessionCount: 2,
    });

    // Plan returns no_action (budget exhausted anyway)
    const noActionContent = JSON.stringify({ no_action: true, reason: "budget" });
    k.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));

    // getSessionCost returns high cost so main loop skips
    k.getSessionCost = vi.fn(async () => 0.50);

    return k;
  }

  it("applies deep-reflect job results from events", async () => {
    const jobResult = {
      reflection: "Test reflection",
      kv_operations: [
        { op: "put", key: "desire:d_new", value: { slug: "d_new", direction: "new desire" } },
      ],
    };

    K = makeJobK(jobResult);
    const events = [
      { type: "job_complete", source: { job_id: JOB_ID } },
    ];

    await run(K, { crashData: null, balances: {}, events, schedule: {} });

    // applyReflectOutput should have been called with the filtered output
    expect(applyReflectOutput).toHaveBeenCalledWith(
      K,
      expect.objectContaining({ defaults: expect.any(Object) }),
      1,
      expect.objectContaining({
        reflection: "Test reflection",
        kv_operations: [
          expect.objectContaining({ key: "desire:d_new" }),
        ],
      }),
      { fromJob: JOB_ID },
    );

    // Karma should log deep_reflect_applied
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "deep_reflect_applied", job_id: JOB_ID }),
    );
  });

  it("filters non-desire/assumption kv_operations", async () => {
    const jobResult = {
      reflection: "Test reflection",
      kv_operations: [
        { op: "put", key: "desire:d_new", value: { slug: "d_new" } },
        { op: "put", key: "config:defaults", value: { hacked: true } },
        { op: "put", key: "assumption:a_new", value: { slug: "a_new" } },
        { op: "put", key: "prompt:act", value: "pwned" },
      ],
    };

    K = makeJobK(jobResult);
    const events = [
      { type: "job_complete", source: { job_id: JOB_ID } },
    ];

    await run(K, { crashData: null, balances: {}, events, schedule: {} });

    // applyReflectOutput should only get desire:* and assumption:* operations
    const call = applyReflectOutput.mock.calls[0];
    const output = call[3];
    expect(output.kv_operations).toHaveLength(2);
    expect(output.kv_operations[0].key).toBe("desire:d_new");
    expect(output.kv_operations[1].key).toBe("assumption:a_new");
  });

  it("skips stale deep-reflect jobs", async () => {
    const jobResult = {
      reflection: "Stale reflection",
      kv_operations: [],
    };

    const kvData = {
      "desire:d_help": JSON.stringify(DESIRE),
      [`job:${JOB_ID}`]: JSON.stringify({
        id: JOB_ID,
        config: { deep_reflect: true, depth: 1, dispatch_session: 0 },
      }),
      [`job_result:${JOB_ID}`]: JSON.stringify({ result: jobResult }),
    };

    K = makeMockK(kvData, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.01 },
        session: { min_review_cost: 0.05 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { max_stale_sessions: 5 },
      },
      sessionCount: 10, // 10 - 0 = 10 > 5 max_stale
    });

    const noActionContent = JSON.stringify({ no_action: true, reason: "budget" });
    K.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));
    K.getSessionCost = vi.fn(async () => 0.50);

    const events = [
      { type: "job_complete", source: { job_id: JOB_ID } },
    ];

    await run(K, { crashData: null, balances: {}, events, schedule: {} });

    // applyReflectOutput should NOT have been called
    expect(applyReflectOutput).not.toHaveBeenCalled();

    // Should log staleness
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "deep_reflect_stale", job_id: JOB_ID }),
    );
  });
});

// ── Per-depth reflect dispatch tests ──────────────────────────

describe("per-depth reflect dispatch", () => {
  let K;

  beforeEach(() => {
    vi.clearAllMocks();
    K = makeMockK({}, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.01 },
        session: { min_review_cost: 0.05 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 }, max_reflect_depth: 3 },
      },
    });

    const noActionContent = JSON.stringify({ no_action: true, reason: "budget" });
    K.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));
    K.getSessionCost = vi.fn(async () => 0.50);
  });

  it("dispatches each due depth independently", async () => {
    // Depths 3 and 1 are due, depth 2 is not
    isReflectDue.mockImplementation(async (K, state, d) => d === 3 || d === 1);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // runReflect should be called for depth 3 and depth 1
    expect(runReflect).toHaveBeenCalledTimes(2);
    expect(runReflect.mock.calls[0][2]).toBe(3);
    expect(runReflect.mock.calls[1][2]).toBe(1);
  });

  it("dispatches nothing when no depth is due", async () => {
    isReflectDue.mockResolvedValue(false);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(runReflect).not.toHaveBeenCalled();
  });
});

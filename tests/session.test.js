import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockK } from "./helpers/mock-kernel.js";

vi.mock("../reflect.js", () => ({
  runReflect: vi.fn(async () => {}),
  highestReflectDepthDue: vi.fn(async () => 0),
}));

vi.mock("../eval.js", () => ({
  evaluateAction: vi.fn(() => ({
    sigma: 0, alpha: {}, salience: 0, eval_method: "stub",
    tool_outcomes: [], plan_success_criteria: null,
    assumptions_relied_on: [], candidate_check_ids: [],
  })),
}));

import { run } from "../session.js";
import { runReflect, highestReflectDepthDue } from "../reflect.js";
import { evaluateAction } from "../eval.js";

// ── Cold start tests ────────────────────────────────────────

describe("session cold start", () => {
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
  });

  it("dispatches deep-reflect when no desires exist", async () => {
    // kvList returns empty for desire: prefix (default behavior — no desires seeded)
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Should log cold_start karma
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "cold_start" }),
    );

    // Should dispatch deep-reflect with coldStart flag
    expect(runReflect).toHaveBeenCalledTimes(1);
    expect(runReflect).toHaveBeenCalledWith(
      K,
      expect.objectContaining({ defaults: expect.any(Object) }),
      1,
      { coldStart: true },
    );
  });

  it("schedules next session after cold start deep-reflect", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Should write session_schedule with a near-future next_session_after
    const scheduleCall = K.kvWriteSafe.mock.calls.find(
      ([key]) => key === "session_schedule",
    );
    expect(scheduleCall).toBeDefined();

    const schedule = typeof scheduleCall[1] === "string"
      ? JSON.parse(scheduleCall[1])
      : scheduleCall[1];
    expect(schedule).toHaveProperty("next_session_after");
    expect(schedule.reason).toBe("post_cold_start");

    // Interval should be short (~60s)
    const nextTime = new Date(schedule.next_session_after).getTime();
    const now = Date.now();
    expect(nextTime - now).toBeLessThan(120_000); // within 2 minutes
    expect(nextTime - now).toBeGreaterThan(0);
  });

  it("does not run act loop on cold start", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // callLLM should NOT have been called (no plan, no act, no review)
    expect(K.callLLM).not.toHaveBeenCalled();

    // runAgentTurn should NOT have been called
    expect(K.runAgentTurn).not.toHaveBeenCalled();

    // highestReflectDepthDue should NOT have been called (we returned early)
    expect(highestReflectDepthDue).not.toHaveBeenCalled();
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
    mu_updates: [],
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
    K.callLLM = vi.fn(async () => {
      callCount++;
      // First call is plan phase, second is review phase
      return callCount === 1
        ? { content: VALID_PLAN, cost: 0.01, toolCalls: null }
        : { content: VALID_REVIEW, cost: 0.01, toolCalls: null };
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
    K.callLLM = vi.fn(async () => ({
      content: JSON.stringify({ no_action: true, reason: "nothing to do" }),
      cost: 0.01,
      toolCalls: null,
    }));

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

  const CHECK_ID = "assumption:a_available";

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

    // evaluateAction controls candidate_check_ids and salience
    if (evalOverride) {
      evaluateAction.mockReturnValue(evalOverride);
    } else {
      evaluateAction.mockReturnValue({
        sigma: 0, alpha: {}, salience: 0, eval_method: "stub",
        tool_outcomes: [], plan_success_criteria: null,
        assumptions_relied_on: [CHECK_ID],
        candidate_check_ids: [CHECK_ID],
      });
    }

    let callCount = 0;
    k.callLLM = vi.fn(async () => {
      callCount++;
      return callCount === 1
        ? { content: VALID_PLAN, cost: 0.01, toolCalls: null }
        : { content: JSON.stringify(overrideReview), cost: 0.01, toolCalls: null };
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

  it("writes mu on confirmed assumption", async () => {
    const review = {
      assessment: "success",
      narrative: "Assumption confirmed.",
      salience_estimate: 0.1,
      mu_updates: [{ check_id: CHECK_ID, confirmed: true }],
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const muCall = K.kvWriteSafe.mock.calls.find(([key]) => key === `mu:${CHECK_ID}`);
    expect(muCall).toBeDefined();
    const muValue = typeof muCall[1] === "string" ? JSON.parse(muCall[1]) : muCall[1];
    expect(muValue.confirmation_count).toBe(1);
    expect(muValue.violation_count).toBe(0);
  });

  it("writes episode when salience exceeds threshold", async () => {
    const review = {
      assessment: "success",
      narrative: "Something significant happened.",
      salience_estimate: 0.8,
      mu_updates: [],
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const episodeCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("episode:"));
    expect(episodeCall).toBeDefined();
    const episodeValue = typeof episodeCall[1] === "string" ? JSON.parse(episodeCall[1]) : episodeCall[1];
    expect(episodeValue.narrative).toBe("Something significant happened.");
    // evalResult.salience is 0, so salience falls back to review.salience_estimate = 0.8
    expect(episodeValue.salience).toBe(0.8);
    expect(episodeValue.sigma).toBe(0);
  });

  it("skips episode when salience is below threshold", async () => {
    const review = {
      assessment: "routine",
      narrative: "Nothing notable.",
      salience_estimate: 0.2,
      mu_updates: [],
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const episodeCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("episode:"));
    expect(episodeCall).toBeUndefined();
  });

  it("filters out hallucinated check_ids from mu_updates", async () => {
    const HALLUCINATED_ID = "assumption:nonexistent_hallucination";
    const review = {
      assessment: "success",
      narrative: "Processed.",
      salience_estimate: 0.1,
      mu_updates: [
        { check_id: CHECK_ID, confirmed: true },
        { check_id: HALLUCINATED_ID, confirmed: true },
      ],
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Valid check_id written
    const validMu = K.kvWriteSafe.mock.calls.find(([key]) => key === `mu:${CHECK_ID}`);
    expect(validMu).toBeDefined();

    // Hallucinated check_id NOT written
    const hallucinatedMu = K.kvWriteSafe.mock.calls.find(([key]) => key === `mu:${HALLUCINATED_ID}`);
    expect(hallucinatedMu).toBeUndefined();

    // karmaRecord called for unknown check_ids
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_unknown_check_ids" }),
    );
  });
});

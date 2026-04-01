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

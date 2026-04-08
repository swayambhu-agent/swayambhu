import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockK } from "./helpers/mock-kernel.js";
import { applyDrResults } from "../userspace.js";

vi.mock("../eval.js", () => ({
  evaluateAction: vi.fn(async () => ({
    sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
    tool_outcomes: [], plan_success_criteria: null,
    patterns_relied_on: [],
    pattern_scores: {},
  })),
}));

vi.mock("../memory.js", () => ({
  updatePatternStrength: vi.fn((currentStrength, surprise) => {
    const alpha = 0.3;
    return currentStrength * (1 - alpha) + (1 - surprise) * alpha;
  }),
  callInference: vi.fn(async () => ({ embeddings: [] })),
  embeddingCacheKey: vi.fn((text, model) => `embedding:mock:${model}`),
}));

vi.mock("../lib/reasoning.js", () => ({
  writeReasoningArtifacts: vi.fn(async () => ({ written: [], indexEntries: [] })),
}));

import { run, classify } from "../userspace.js";
import { evaluateAction } from "../eval.js";
import { updatePatternStrength, callInference } from "../memory.js";
import * as reasoning from "../lib/reasoning.js";

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

function makeAbortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// ── Empty desires tests ─────────────────────────────────────
// Before DR has applied, d=∅ stays mechanical: no action without desire.

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
  });

  it("skips plan phase and writes a bootstrap no_action experience", async () => {
    evaluateAction.mockResolvedValueOnce({
      sigma: 1,
      alpha: {},
      salience: 0,
      eval_method: "pipeline",
      tool_outcomes: [],
      plan_success_criteria: null,
      patterns_relied_on: [],
      pattern_scores: {},
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Should NOT log cold_start karma
    expect(K.karmaRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "cold_start" }),
    );

    // Plan/review LLM calls are bypassed during pre-bootstrap
    expect(K.callLLM).not.toHaveBeenCalled();
    expect(K.runAgentTurn).not.toHaveBeenCalled();

    expect(K.kvWriteSafe).toHaveBeenCalledWith(
      expect.stringMatching(/^action:/),
      expect.objectContaining({
        kind: "no_action",
        plan: expect.objectContaining({
          no_action: true,
        }),
      }),
    );

    expect(K.kvWriteSafe).toHaveBeenCalledWith(
      expect.stringMatching(/^experience:/),
      expect.objectContaining({
        observation: expect.stringContaining("No action was taken."),
        salience: 1,
        pattern_delta: expect.objectContaining({ sigma: 1 }),
      }),
    );

    const sessionSchedule = await K.kvGet("session_schedule");
    expect(sessionSchedule.interval_seconds).toBe(3600);
    expect(sessionSchedule.no_action_streak).toBe(1);
  });

  it("waits for bootstrap DR before starting another session when DR is still running", async () => {
    const now = new Date().toISOString();
    K = makeMockK({
      "dr:state:1": {
        status: "dispatched",
        generation: 1,
        dispatched_at: now,
        job_id: "job_1",
        workdir: "/tmp/dr-job-1",
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        deep_reflect: { ttl_minutes: 120 },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
      },
    });
    K.executeAdapter = vi.fn(async () => ({ ok: false }));

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(await K.kvGet("session_counter")).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "bootstrap_waiting_for_dr",
        dr_status: "dispatched",
        generation: 1,
      }),
    );
    expect(K.callLLM).not.toHaveBeenCalled();
    expect(K.runAgentTurn).not.toHaveBeenCalled();

    const actionWrites = K.kvWriteSafe.mock.calls.filter(([key]) => key.startsWith("action:"));
    expect(actionWrites).toHaveLength(0);
  });

  it("runs planning when a pending request exists even if desires are empty", async () => {
    K = makeMockK({
      "session_request:req_1": {
        id: "req_1",
        contact: "swami_kevala",
        summary: "Inspect the Akash projects folder and see what needs help",
        status: "pending",
        created_at: "2026-04-07T00:00:00.000Z",
        updated_at: "2026-04-07T00:00:00.000Z",
        ref: "chat:slack:U084ASKBXB7",
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
      },
    });
    K.callLLM = vi.fn(llmResp(JSON.stringify({ no_action: true, reason: "not yet actionable" })));

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "session_request", ref: "session_request:req_1" }],
      schedule: {},
    });

    expect(K.callLLM).toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "unaddressed_requests",
        request_ids: ["req_1"],
      }),
    );
  });

  it("runs planning after DR has applied even if desires are still empty", async () => {
    K = makeMockK({
      "dr:state:1": {
        status: "idle",
        generation: 1,
        last_applied_session: 1,
        consecutive_failures: 0,
      },
      session_schedule: {
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 3,
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600, exploration_unlock_streak: 3 },
        execution: { max_steps: { act: 5 } },
      },
    });

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      if (callCount === 1) {
        return llmResp(JSON.stringify({
          action: "inspect_workspace",
          success: "one concrete workspace observation is recorded",
          serves_desires: [],
          follows_tactics: [],
          defer_if: [],
        }))(opts);
      }
      if (callCount === 2) {
        return llmResp(JSON.stringify({
          assessment: "success",
          accomplished: "Completed one low-cost bootstrap probe.",
          key_findings: ["Workspace is reachable and can be inspected."],
          next_gap: null,
          narrative: "A bounded bootstrap probe succeeded.",
        }))(opts);
      }
      return llmResp(JSON.stringify({ no_action: true, reason: "done probing" }))(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Bootstrap probe completed." });
      return { response: { content: "Bootstrap probe completed.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, {
      crashData: null,
      balances: { wallets: { base: { balance: 50, scope: "general" } } },
      events: [],
      schedule: {},
    });

    expect(K.callLLM).toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "plan_exploratory_without_desire",
        no_action_streak: 3,
      }),
    );
    expect(K.runAgentTurn).toHaveBeenCalled();
  });

  it("falls back to bootstrap no_action if post-DR planning still returns no usable plan", async () => {
    K = makeMockK({
      "dr:state:1": {
        status: "idle",
        generation: 1,
        last_applied_session: 1,
        consecutive_failures: 0,
      },
      session_schedule: {
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 1,
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600, exploration_unlock_streak: 3 },
        execution: { max_steps: { act: 5 } },
      },
    });

    K.callLLM = vi.fn(async (opts) => llmResp(JSON.stringify({
      action: "inspect_workspace",
      success: "one concrete workspace observation is recorded",
      serves_desires: [],
      follows_tactics: [],
      defer_if: [],
    }))(opts));

    evaluateAction.mockResolvedValueOnce({
      sigma: 1,
      alpha: {},
      salience: 0,
      eval_method: "pipeline",
      tool_outcomes: [],
      plan_success_criteria: null,
      patterns_relied_on: [],
      pattern_scores: {},
    });

    await run(K, {
      crashData: null,
      balances: { wallets: { base: { balance: 50, scope: "general" } } },
      events: [],
      schedule: {},
    });

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "bootstrap_planner_fallback_no_action",
        no_action_streak: 1,
      }),
    );
    expect(K.kvWriteSafe).toHaveBeenCalledWith(
      expect.stringMatching(/^action:/),
      expect.objectContaining({
        kind: "no_action",
        plan: expect.objectContaining({ no_action: true }),
      }),
    );
    expect(K.kvWriteSafe).toHaveBeenCalledWith(
      expect.stringMatching(/^experience:/),
      expect.objectContaining({
        observation: expect.stringContaining("No action was taken."),
      }),
    );
  });

  it("auto-reconciles an unambiguously handled pending request when act forgets update_request", async () => {
    K = makeMockK({
      "session_request:req_1": {
        id: "req_1",
        contact: "swami_kevala",
        summary: "Inspect the repo and make one meaningful improvement",
        status: "pending",
        created_at: "2026-04-07T00:00:00.000Z",
        updated_at: "2026-04-07T00:00:00.000Z",
        ref: "chat:slack:U084ASKBXB7",
        result: null,
        error: null,
        next_session: null,
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        chat: { model: "test-model", effort: "low", max_output_tokens: 400 },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
      },
    });

    K.callLLM = vi.fn(async (opts) => {
      if (opts.step === "plan") {
        return llmResp(JSON.stringify({
          action: "inspect_repo",
          success: "one meaningful repo improvement is completed",
          serves_desires: [],
          follows_tactics: [],
          defer_if: [],
        }))(opts);
      }
      if (opts.step === "review") {
        return llmResp(JSON.stringify({
          assessment: "success",
          accomplished: "Implemented one concrete repository improvement and verified it.",
          key_findings: ["The repo had an obvious quality issue that was fixed."],
          next_gap: null,
          narrative: "The requested improvement was completed.",
        }))(opts);
      }
      if (opts.step === "request_reconcile") {
        return llmResp(JSON.stringify({
          updates: [{
            request_id: "req_1",
            status: "fulfilled",
            result: "I completed one concrete improvement in the repo and verified the change.",
          }],
        }))(opts);
      }
      return llmResp("{}")(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Implemented the improvement." });
      return { response: { content: "Implemented the improvement.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "session_request", ref: "session_request:req_1" }],
      schedule: {},
    });

    expect(await K.kvGet("session_request:req_1")).toEqual(
      expect.objectContaining({
        status: "fulfilled",
        result: "I completed one concrete improvement in the repo and verified the change.",
      }),
    );
    expect(K.emitEvent).toHaveBeenCalledWith(
      "session_response",
      expect.objectContaining({
        contact: "swami_kevala",
        ref: "session_request:req_1",
        status: "fulfilled",
      }),
    );
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "requests_auto_reconciled",
        updates: [{ request_id: "req_1", status: "fulfilled" }],
      }),
    );
    expect(K.karmaRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "unaddressed_requests",
        request_ids: ["req_1"],
      }),
    );
  });

  it("wakes the first desire-driven session immediately after bootstrap DR applies", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-06T12:00:00.000Z");
    vi.setSystemTime(now);

    K = makeMockK({
      session_counter: 1,
      session_schedule: {
        next_session_after: new Date(now.getTime() + 3600_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 1,
      },
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [],
      },
      "dr:state:1": {
        status: "completed",
        generation: 1,
        consecutive_failures: 0,
        job_id: "job_1",
      },
      "dr:result:1": {
        reflection: "Bootstrap reflection",
        note_to_future_self: "Seed first desire",
        kv_operations: [
          {
            op: "put",
            key: "desire:self-knowledge",
            value: {
              slug: "self-knowledge",
              direction: "approach",
              description: "Know my current operating context.",
            },
          },
        ],
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        deep_reflect: { default_interval_sessions: 20, default_interval_days: 7 },
        session_budget: { max_cost: 0.50 },
        schedule: { interval_seconds: 3600 },
        execution: { max_steps: { act: 5 } },
      },
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(await K.kvGet("session_counter")).toBe(1);
    expect(await K.kvGet("desire:self-knowledge")).toEqual(
      expect.objectContaining({
        slug: "self-knowledge",
        direction: "approach",
      }),
    );

    const sessionSchedule = await K.kvGet("session_schedule");
    expect(sessionSchedule).toEqual({
      next_session_after: now.toISOString(),
      interval_seconds: 3600,
      no_action_streak: 1,
    });

    const drState = await K.kvGet("dr:state:1");
    expect(drState.status).toBe("idle");
    expect(drState.last_applied_session).toBe(1);

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "bootstrap_ready_after_dr",
        generation: 1,
        desires_created: 1,
      }),
    );

    vi.useRealTimers();
  });
});

describe("DR completion handling", () => {
  it("applies a callback-signaled DR result before act runs", async () => {
    const K = makeMockK({
      session_counter: 1,
      session_schedule: {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "desire:live-situational-direction": {
        slug: "live-situational-direction",
        direction: "approach",
        description: "I have enough situational awareness to justify action or inaction.",
      },
      "dr:state:1": {
        status: "dispatched",
        generation: 2,
        job_id: "job_2",
        workdir: "/tmp/dr-job-2",
        dispatched_at: new Date().toISOString(),
        last_applied_session: 1,
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7, ttl_minutes: 120 },
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.50 },
        execution: { max_steps: { act: 5 } },
      },
    });

    K.executeAdapter
      .mockResolvedValueOnce({ ok: true, output: [{ data: "0\r\n" }] })
      .mockResolvedValueOnce({
        ok: true,
        output: [{
          data: JSON.stringify({
            reflection: "DR complete",
            note_to_future_self: "Use the new pattern",
            kv_operations: [
              {
                op: "put",
                key: "pattern:bootstrap:callback-apply",
                value: {
                  pattern: "Callback-signaled DR results can be applied before act runs.",
                  strength: 0.3,
                },
              },
            ],
            next_reflect: { after_sessions: 5, after_days: 7 },
          }),
        }],
      });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", key: "event:1:job_complete", source: { job_id: "job_2" } }],
    });

    expect(await K.kvGet("pattern:bootstrap:callback-apply")).toEqual({
      pattern: "Callback-signaled DR results can be applied before act runs.",
      strength: 0.3,
    });

    expect(await K.kvGet("session_counter")).toBe(1);
    expect(K.callLLM).not.toHaveBeenCalled();

    const drState = await K.kvGet("dr:state:1");
    expect(drState.status).toBe("idle");
    expect(drState.last_applied_session).toBe(1);
    expect(drState.next_due_session).toBe(6);
  });

  it("applies a polled DR result in the same execution when no callback event arrives", async () => {
    const K = makeMockK({
      session_counter: 2,
      session_schedule: {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "desire:live-situational-direction": {
        slug: "live-situational-direction",
        direction: "approach",
        description: "I have enough situational awareness to justify action or inaction.",
      },
      "dr:state:1": {
        status: "dispatched",
        generation: 2,
        job_id: "job_2",
        workdir: "/tmp/dr-job-2",
        dispatched_at: new Date().toISOString(),
        last_applied_session: 1,
      },
    }, {
      defaults: {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model" },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7, ttl_minutes: 120 },
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.50 },
        execution: { max_steps: { act: 5 } },
      },
    });

    K.executeAdapter
      .mockResolvedValueOnce({ ok: true, output: [{ data: "0\r\n" }] })
      .mockResolvedValueOnce({
        ok: true,
        output: [{
          data: JSON.stringify({
            reflection: "DR complete",
            note_to_future_self: "Keep the new pattern active",
            kv_operations: [
              {
                op: "put",
                key: "pattern:bootstrap:polled-apply",
                value: {
                  pattern: "Polling fallback can now apply DR in the same execution.",
                  strength: 0.25,
                },
              },
            ],
            next_reflect: { after_sessions: 5, after_days: 7 },
          }),
        }],
      });

    await run(K, {
      crashData: null,
      balances: {},
      events: [],
    });

    expect(await K.kvGet("pattern:bootstrap:polled-apply")).toEqual({
      pattern: "Polling fallback can now apply DR in the same execution.",
      strength: 0.25,
    });

    expect(await K.kvGet("session_counter")).toBe(2);
    expect(K.callLLM).not.toHaveBeenCalled();

    const drState = await K.kvGet("dr:state:1");
    expect(drState.status).toBe("idle");
    expect(drState.last_applied_session).toBe(2);
    expect(drState.next_due_session).toBe(7);
  });
});

describe("act cycle abort handling", () => {
  const ACTION_PLAN = JSON.stringify({
    action: "inspect_state",
    success: "state inspected",
    serves_desires: ["desire:d_help"],
    follows_tactics: [],
    defer_if: [],
  });

  function makeAbortTestKernel() {
    const K = makeMockK(
      {
        "desire:d_help": JSON.stringify({
          slug: "d_help",
          direction: "approach",
          description: "Be helpful",
        }),
        "pattern:p_available": JSON.stringify({
          pattern: "System is available",
          strength: 0.8,
        }),
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
          session_budget: { max_cost: 0.50 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    K.getSessionCost = vi.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    K.callLLM = vi.fn(async (opts) => {
      if (opts.step === "plan") return llmResp(ACTION_PLAN)(opts);
      throw new Error(`Unexpected LLM step: ${opts.step}`);
    });
    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    return K;
  }

  it("records eval_review_aborted and skips memory writes when eval times out", async () => {
    vi.useFakeTimers();
    const K = makeAbortTestKernel();

    evaluateAction.mockImplementationOnce((_K, _ledger, _desires, _patterns, _config, signal) => (
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
      })
    ));

    const runPromise = run(K, { crashData: null, balances: {}, events: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    await runPromise;

    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "eval_review_aborted",
      cycle: 0,
    }));
    const actionWrites = K.kvWriteSafe.mock.calls.filter(([key]) => key.startsWith("action:"));
    expect(actionWrites).toHaveLength(0);
    vi.useRealTimers();
  });

  it("records eval_review_aborted and skips memory writes when review times out", async () => {
    vi.useFakeTimers();
    const K = makeAbortTestKernel();

    evaluateAction.mockResolvedValueOnce({
      sigma: 0.2,
      alpha: {},
      salience: 0.2,
      eval_method: "pipeline",
      tool_outcomes: [],
      plan_success_criteria: null,
      patterns_relied_on: [],
      pattern_scores: {},
    });
    K.callLLM = vi.fn(async (opts) => {
      if (opts.step === "plan") return llmResp(ACTION_PLAN)(opts);
      if (opts.step === "review") {
        return new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
        });
      }
      throw new Error(`Unexpected LLM step: ${opts.step}`);
    });

    const runPromise = run(K, { crashData: null, balances: {}, events: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    await runPromise;

    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "eval_review_aborted",
      cycle: 0,
    }));
    const actionWrites = K.kvWriteSafe.mock.calls.filter(([key]) => key.startsWith("action:"));
    expect(actionWrites).toHaveLength(0);
    vi.useRealTimers();
  });

  it("aborts the child eval signal immediately when the session signal aborts", async () => {
    const K = makeAbortTestKernel();
    const sessionController = new AbortController();
    K.sessionAbortSignal = sessionController.signal;

    let childSignal = null;
    let resolveChildSignalReady;
    const childSignalReady = new Promise((resolve) => {
      resolveChildSignalReady = resolve;
    });
    evaluateAction.mockImplementationOnce((_K, _ledger, _desires, _patterns, _config, signal) => {
      childSignal = signal;
      resolveChildSignalReady();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
      });
    });

    const runPromise = run(K, { crashData: null, balances: {}, events: [] });
    await childSignalReady;
    sessionController.abort(new Error("session timeout"));
    await runPromise;

    expect(childSignal).toBeTruthy();
    expect(childSignal).not.toBe(sessionController.signal);
    expect(childSignal.aborted).toBe(true);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "eval_review_aborted",
      cycle: 0,
    }));
    const actionWrites = K.kvWriteSafe.mock.calls.filter(([key]) => key.startsWith("action:"));
    expect(actionWrites).toHaveLength(0);
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

  const SAMSKARA = {
    pattern: "Patron is available to receive messages",
    strength: 0.8,
  };

  const VALID_PLAN = JSON.stringify({
    action: "send_greeting",
    success: "patron receives greeting",
    serves_desires: ["desire:d_help"],
    follows_tactics: [],
    defer_if: [],
  });

  const VALID_REVIEW = JSON.stringify({
    assessment: "success",
    narrative: "Greeting sent successfully.",
    salience_estimate: 0.1,
  });

  const UNGROUNDED_PLAN = JSON.stringify({
    action: "inspect_workspace_for_help_opportunities",
    success: "I inspect the workspace and identify whether there is a concrete project gap worth helping with.",
    serves_desires: [],
    follows_tactics: [],
    defer_if: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
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

    // First call: plan phase — messages contain desires and no direct pattern block
    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toMatch(/DESIRES/);
    expect(planCall.messages[0].content).not.toMatch(/\[PATTERNS\]/);

    // runAgentTurn should have been called at least once (act phase ran)
    expect(K.runAgentTurn.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Second call: review phase — user content mentions "Action ledger"
    const reviewCall = K.callLLM.mock.calls[1][0];
    expect(reviewCall.messages[0].content).toMatch(/Action ledger/);
  });

  it("bypasses the future schedule gate for an external wake and surfaces wake provenance", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        session_schedule: {
          next_session_after: new Date(Date.now() + 3600_000).toISOString(),
          interval_seconds: 3600,
          no_action_streak: 2,
        },
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

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1 ? llmResp(VALID_PLAN)(opts) : llmResp(VALID_REVIEW)(opts);
    });
    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{
        type: "wake",
        origin: "external",
        trigger: { actor: "dev_loop", context: { intent: "probe" } },
      }],
    });

    expect(K.callLLM).toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "act_start",
        wake_origin: "external",
        wake_actor: "dev_loop",
        wake_context: { intent: "probe" },
      }),
    );
    expect(K.callLLM.mock.calls[0][0].messages[0].content).toContain("\"wake\"");
    expect(K.callLLM.mock.calls[0][0].messages[0].content).toContain("\"actor\": \"dev_loop\"");
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
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review_synthesized",
        source: "no_action_bootstrap",
        assessment: "no_action",
        observation: "No action was taken. Reason: nothing to do",
      }),
    );
  });

  it("surfaces idle-streak and capacity facts to the planner", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        session_schedule: {
          next_session_after: new Date(Date.now() - 1000).toISOString(),
          interval_seconds: 3600,
          no_action_streak: 3,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          session_budget: { max_cost: 0.5 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(JSON.stringify({ no_action: true, reason: "nothing to do" }))(opts)
        : llmResp(VALID_REVIEW)(opts);
    });

    await run(K, {
      crashData: null,
      balances: { wallets: { base: { balance: 50, scope: "general" } } },
      events: [],
      schedule: {},
    });

    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toContain("\"no_action_streak\": 3");
    expect(planCall.messages[0].content).toContain("\"operating_balance_usd\": 50");
    expect(planCall.messages[0].content).toContain("\"healthy\": true");
  });

  it("allows one exploratory plan without serves_desires after repeated healthy idle streaks", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        session_schedule: {
          next_session_after: new Date(Date.now() - 1000).toISOString(),
          interval_seconds: 3600,
          no_action_streak: 3,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          session_budget: { max_cost: 0.5 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      if (callCount === 1) return llmResp(UNGROUNDED_PLAN)(opts);
      if (callCount === 2) return llmResp(VALID_REVIEW)(opts);
      return llmResp(JSON.stringify({ no_action: true, reason: "done probing" }))(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Workspace inspected." });
      return { response: { content: "Workspace inspected.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, {
      crashData: null,
      balances: { wallets: { base: { balance: 50, scope: "general" } } },
      events: [],
      schedule: {},
    });

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "plan_exploratory_without_desire",
        no_action_streak: 3,
      }),
    );
    expect(K.runAgentTurn).toHaveBeenCalled();
  });

  it("shortens repeated healthy no_action sessions to the idle cadence", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        session_schedule: {
          next_session_after: new Date(Date.now() - 1000).toISOString(),
          interval_seconds: 3600,
          no_action_streak: 3,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          session_budget: { max_cost: 0.5 },
          schedule: { interval_seconds: 3600, idle_interval_seconds: 1800, exploration_unlock_streak: 3 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    K.callLLM = vi.fn(async (opts) => llmResp(JSON.stringify({ no_action: true, reason: "nothing worth doing yet" }))(opts));

    await run(K, {
      crashData: null,
      balances: { wallets: { base: { balance: 50, scope: "general" } } },
      events: [],
      schedule: {},
    });

    const sessionSchedule = await K.kvGet("session_schedule");
    expect(sessionSchedule.interval_seconds).toBe(1800);
    expect(sessionSchedule.no_action_streak).toBe(4);
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "capacity_rich_no_action",
        no_action_streak: 4,
      }),
    );
  });

  it("injects active carry-forward items with the new planner heading", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "last_reflect": {
          carry_forward: [
            {
              id: "s_prev:cf1",
              item: "Follow up with the patron about scheduling",
              why: "Keeps the conversation moving",
              priority: "high",
              status: "active",
              desire_key: "desire:d_help",
            },
          ],
        },
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

    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toContain("[CARRY-FORWARD]");
    expect(planCall.messages[0].content).toContain("plans from previous session — continue or re-evaluate");
    expect(planCall.messages[0].content).toContain("Follow up with the patron about scheduling");
    expect(planCall.messages[0].content).toContain("(supports desire:d_help)");
    expect(planCall.messages[0].content).not.toContain("[CARRY-FORWARD TASKS]");
  });

  it("only surfaces active carry-forward items to the planner", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "last_reflect": {
          carry_forward: [
            { id: "s_prev:cf1", item: "Keep this one", status: "active" },
            { id: "s_prev:cf2", item: "Already done", status: "done" },
            { id: "s_prev:cf3", item: "Dropped item", status: "dropped" },
          ],
        },
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

    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toContain("Keep this one");
    expect(planCall.messages[0].content).not.toContain("Already done");
    expect(planCall.messages[0].content).not.toContain("Dropped item");
  });

  it("sorts carry-forward items by priority and recency, omits expired items, and caps at five", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "last_reflect": {
          carry_forward: [
            {
              id: "s_prev:cf1",
              item: "High recent",
              priority: "high",
              status: "active",
              updated_at: "2026-04-05T12:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf2",
              item: "High older",
              priority: "high",
              status: "active",
              updated_at: "2026-04-04T12:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf3",
              item: "Medium recent",
              priority: "medium",
              status: "active",
              updated_at: "2026-04-05T11:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf4",
              item: "Low recent",
              priority: "low",
              status: "active",
              updated_at: "2026-04-05T10:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf5",
              item: "Medium older",
              priority: "medium",
              status: "active",
              updated_at: "2026-04-03T12:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf6",
              item: "Low older dropped by cap",
              priority: "low",
              status: "active",
              updated_at: "2026-04-02T12:00:00.000Z",
              expires_at: "2026-04-12T12:00:00.000Z",
            },
            {
              id: "s_prev:cf7",
              item: "Expired high",
              priority: "high",
              status: "active",
              updated_at: "2026-04-05T13:00:00.000Z",
              expires_at: "2026-04-01T12:00:00.000Z",
            },
          ],
        },
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

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));

    try {
      await run(K, { crashData: null, balances: {}, events: [], schedule: {} });
    } finally {
      vi.useRealTimers();
    }

    const planContent = K.callLLM.mock.calls[0][0].messages[0].content;
    const carryForwardBlock = planContent
      .split("[CARRY-FORWARD]\n")[1]
      .split("\n\n[CIRCUMSTANCES]")[0];
    const lines = carryForwardBlock
      .split("\n")
      .filter(line => line.startsWith("- "));

    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("High recent");
    expect(lines[1]).toContain("High older");
    expect(lines[2]).toContain("Medium recent");
    expect(lines[3]).toContain("Medium older");
    expect(lines[4]).toContain("Low recent");
    expect(carryForwardBlock).not.toContain("Expired high");
    expect(carryForwardBlock).not.toContain("Low older dropped by cap");
  });
});

// ── Memory write tests ───────────────────────────────────────

describe("session memory writes", () => {
  let K;

  const SAMSKARA_KEY = "pattern:a_available";

  const DESIRE = {
    slug: "d_help",
    direction: "help patrons effectively",
    description: "Be genuinely helpful in all interactions.",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const SAMSKARA = {
    pattern: "Patron is available to receive messages",
    strength: 0.8,
  };

  const VALID_PLAN = JSON.stringify({
    action: "send_greeting",
    success: "patron receives greeting",
    serves_desires: ["desire:d_help"],
    follows_tactics: [],
    defer_if: [],
  });

  function makeK(overrideReview, evalOverride) {
    const k = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
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

    // evaluateAction controls pattern_scores and salience
    if (evalOverride) {
      evaluateAction.mockResolvedValue(evalOverride);
    } else {
      evaluateAction.mockResolvedValue({
        sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
        tool_outcomes: [], plan_success_criteria: null,
        patterns_relied_on: [SAMSKARA_KEY],
        pattern_scores: {},
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

  it("updates pattern strength on confirmation", async () => {
    const review = {
      assessment: "success",
      narrative: "Pattern confirmed.",
      salience_estimate: 0.1,
    };
    const evalResult = {
      sigma: 0, alpha: {}, salience: 0, eval_method: "pipeline",
      tool_outcomes: [], plan_success_criteria: null,
      patterns_relied_on: [SAMSKARA_KEY],
      pattern_scores: {
        [SAMSKARA_KEY]: { direction: "entailment", surprise: 0 },
      },
    };
    K = makeK(review, evalResult);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    // Should write updated strength via dedicated kernel primitive
    const strengthCall = K.updatePatternStrength.mock.calls.find(([key]) => key === SAMSKARA_KEY);
    expect(strengthCall).toBeDefined();
    const writtenStrength = strengthCall[1];
    expect(writtenStrength).toBeGreaterThanOrEqual(0);
    expect(writtenStrength).toBeLessThanOrEqual(1);
  });

  it("updates pattern strength on violation", async () => {
    const review = {
      assessment: "failed",
      narrative: "Pattern violated.",
      salience_estimate: 0.1,
    };
    const evalResult = {
      sigma: 0.8, alpha: {}, salience: 0.8, eval_method: "pipeline",
      tool_outcomes: [], plan_success_criteria: null,
      patterns_relied_on: [SAMSKARA_KEY],
      pattern_scores: {
        [SAMSKARA_KEY]: { direction: "contradiction", surprise: 0.8 },
      },
    };
    K = makeK(review, evalResult);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const strengthCall = K.updatePatternStrength.mock.calls.find(([key]) => key === SAMSKARA_KEY);
    expect(strengthCall).toBeDefined();
    const writtenStrength = strengthCall[1];
    // Violation should decrease strength
    expect(writtenStrength).toBeLessThan(0.8);
  });

  it("writes experience when salience exceeds threshold", async () => {
    const review = {
      observation: "A significant event occurred during execution.",
      assessment: "success",
      narrative: "Something significant happened.",
      salience_estimate: 0.8,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const experienceCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("experience:"));
    expect(experienceCall).toBeDefined();
    const experienceValue = typeof experienceCall[1] === "string" ? JSON.parse(experienceCall[1]) : experienceCall[1];
    expect(experienceValue.observation).toBe("A significant event occurred during execution.");
    expect(experienceValue.text_rendering).toEqual({ narrative: "Something significant happened." });
    expect(experienceValue.salience).toBeDefined();
    expect(experienceValue.pattern_delta).toEqual({ sigma: 0, scores: [] });
    expect(experienceValue.desire_alignment).toEqual({
      top_positive: [],
      top_negative: [],
      affinity_magnitude: 0,
    });
    expect(experienceValue.embedding).toBeNull(); // no inferenceConfig
    expect(experienceValue.action_ref).toMatch(/^action:/);
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

  it("records embedding timeout from AbortError without Promise.race", async () => {
    const review = {
      observation: "A high-salience event occurred.",
      assessment: "success",
      narrative: "High-salience event.",
      salience_estimate: 0.9,
    };
    const evalResult = {
      sigma: 0.7, alpha: {}, salience: 0.7, eval_method: "pipeline",
      tool_outcomes: [], plan_success_criteria: null,
      patterns_relied_on: [SAMSKARA_KEY],
      pattern_scores: {},
    };
    K = makeK(review, evalResult);
    const baseDefaults = await K.getDefaults();
    K.getDefaults = vi.fn(async () => ({
      ...baseDefaults,
      inference: { url: "http://localhost:9000" },
    }));
    const abortErr = new Error("timed out");
    abortErr.name = "AbortError";
    callInference.mockImplementation(async (_url, _secret, path, body) => {
      if (path === "/embed" && body?.texts?.[0] === "A high-salience event occurred.") {
        throw abortErr;
      }
      return { embeddings: [[0.1, 0.2, 0.3]] };
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(callInference).toHaveBeenCalledWith(
      "http://localhost:9000",
      null,
      "/embed",
      expect.any(Object),
    );
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: "experience_embedding_timeout" }),
    );
    expect(K.kvWriteSafe).toHaveBeenCalledWith(
      expect.stringMatching(/^experience:/),
      expect.objectContaining({ embedding: null }),
    );
  });

  it("does not update patterns when pattern_scores is empty", async () => {
    const review = {
      assessment: "success",
      narrative: "No patterns tested.",
      salience_estimate: 0.1,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const patternWrites = K.kvWriteSafe.mock.calls.filter(([key]) => key.startsWith("pattern:"));
    expect(patternWrites.length).toBe(0);
  });
});

// ── Event emission tests ─────────────────────────────────────

describe("session event emission", () => {
  let K;

  const DESIRE = {
    slug: "d_help",
    direction: "help patrons effectively",
    description: "Be genuinely helpful in all interactions.",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const SAMSKARA = {
    pattern: "Patron is available to receive messages",
    strength: 0.8,
  };

  const VALID_PLAN = JSON.stringify({
    action: "send_greeting",
    success: "patron receives greeting",
    serves_desires: ["desire:d_help"],
    follows_tactics: [],
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
        "pattern:a_available": JSON.stringify(SAMSKARA),
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
  });

  it("emits session_complete after act cycle with actions", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    expect(K.emitEvent).toHaveBeenCalledWith(
      "session_complete",
      expect.objectContaining({
        cycles: expect.any(Number),
        actions_summary: expect.any(String),
      }),
    );

    const call = K.emitEvent.mock.calls.find(([type]) => type === "session_complete");
    expect(call).toBeDefined();
    expect(call[1].cycles).toBeGreaterThan(0);
  });

  it("does not emit session_complete when plan returns no_action", async () => {
    const noActionContent = JSON.stringify({ no_action: true, reason: "nothing to do" });
    K.callLLM = vi.fn(async (opts) => llmResp(noActionContent)(opts));

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const sessionCompleteCall = K.emitEvent.mock.calls.find(([type]) => type === "session_complete");
    expect(sessionCompleteCall).toBeUndefined();
  });
});

// ── Pulse classify tests ────────────────────────────────────

describe("pulse classify", () => {
  it("always includes health", () => {
    expect(classify(new Set())).toContain("health");
  });

  it("maps desire keys to mind bucket", () => {
    const result = classify(new Set(["desire:dharma-clarity"]));
    expect(result).toContain("mind");
    expect(result).toContain("health");
  });

  it("maps pattern keys to mind bucket", () => {
    expect(classify(new Set(["pattern:pacing:slow"]))).toContain("mind");
  });

  it("maps experience keys to mind bucket", () => {
    expect(classify(new Set(["experience:1775204183352"]))).toContain("mind");
  });

  it("maps session_counter to sessions bucket", () => {
    expect(classify(new Set(["session_counter"]))).toContain("sessions");
  });

  it("maps karma keys to sessions bucket", () => {
    expect(classify(new Set(["karma:x_123"]))).toContain("sessions");
  });

  it("maps action keys to sessions bucket", () => {
    expect(classify(new Set(["action:a_123_test"]))).toContain("sessions");
  });

  it("maps dr state to reflections bucket", () => {
    expect(classify(new Set(["dr:state:1"]))).toContain("reflections");
  });

  it("maps reflect keys to reflections bucket", () => {
    expect(classify(new Set(["reflect:1:x_123"]))).toContain("reflections");
  });

  it("maps last_reflect to reflections bucket", () => {
    expect(classify(new Set(["last_reflect"]))).toContain("reflections");
  });

  it("maps chat keys to chats bucket", () => {
    expect(classify(new Set(["chat:slack:U123"]))).toContain("chats");
  });

  it("maps outbox keys to chats bucket", () => {
    expect(classify(new Set(["outbox:chat:slack:U123:ob_1"]))).toContain("chats");
  });

  it("maps contact keys to contacts bucket", () => {
    expect(classify(new Set(["contact:swami_kevala"]))).toContain("contacts");
  });

  it("maps contact_platform keys to contacts bucket", () => {
    expect(classify(new Set(["contact_platform:slack:U123"]))).toContain("contacts");
  });

  it("ignores unknown prefixes", () => {
    const result = classify(new Set(["kernel:active_execution"]));
    expect(result).toEqual(["health"]);
  });

  it("deduplicates buckets", () => {
    const result = classify(new Set(["desire:a", "pattern:b", "experience:c"]));
    const mindCount = result.filter(b => b === "mind").length;
    expect(mindCount).toBe(1);
  });
});

describe("applyDrResults key filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockK(writes = []) {
    return {
      getExecutionId: async () => "x_test",
      kvWriteGated: async (op, ctx) => { writes.push({ key: op.key, ctx }); return { ok: true }; },
      kvWriteSafe: async () => {},
      kvGet: async () => null,
      emitEvent: async () => {},
      karmaRecord: async () => {},
      stageCode: async () => {},
      signalDeploy: async () => {},
    };
  }

  it("passes config: and prompt: operations to kvWriteGated", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "config:defaults", op: "put", value: { max_cost: 0.20 } },
        { key: "prompt:plan", op: "put", value: "new prompt", deliberation: "x".repeat(201) },
        { key: "pattern:test", op: "put", value: { pattern: "test", strength: 0.5 } },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(3);
    expect(writes.map(w => w.key)).toEqual(["config:defaults", "prompt:plan", "pattern:test"]);
    expect(writes.every(w => w.ctx === "deep-reflect")).toBe(true);
  });

  it("filters out kernel: and other disallowed keys", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "kernel:secret", op: "put", value: "hacked" },
        { key: "karma:fake", op: "put", value: "injected" },
        { key: "sealed:data", op: "put", value: "leaked" },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(0);
  });

  it("still passes pattern/desire/tactic/principle as before", async () => {
    const writes = [];
    const K = mockK(writes);
    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "pattern:foo", op: "put", value: { pattern: "x", strength: 0.5 } },
        { key: "desire:bar", op: "put", value: { description: "x" } },
        { key: "tactic:baz", op: "put", value: { tactic: "x" } },
        { key: "principle:qux", op: "put", value: "x", deliberation: "x".repeat(201) },
      ],
      reflection: "test",
    });
    expect(writes).toHaveLength(4);
  });

  it("preserves existing carry_forward when DR output omits it", async () => {
    const writes = [];
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [
          { id: "s_prev:cf1", item: "Keep this", status: "active" },
        ],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      kv_operations: [],
    });

    const reflectRecord = await K.kvGet("reflect:1:test_execution");
    const lastReflect = await K.kvGet("last_reflect");
    expect(reflectRecord.carry_forward).toEqual([
      { id: "s_prev:cf1", item: "Keep this", status: "active" },
    ]);
    expect(lastReflect.carry_forward).toEqual([
      { id: "s_prev:cf1", item: "Keep this", status: "active" },
    ]);
    expect(lastReflect.note_to_future_self).toBe("New note");
  });

  it("replaces existing carry_forward when DR output provides it", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [
          { id: "s_prev:cf1", item: "Old item", status: "active" },
        ],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      carry_forward: [
        { id: "s_new:cf1", item: "New item", status: "active" },
      ],
      kv_operations: [],
    });

    const reflectRecord = await K.kvGet("reflect:1:test_execution");
    const lastReflect = await K.kvGet("last_reflect");
    expect(reflectRecord.carry_forward).toEqual([
      { id: "s_new:cf1", item: "New item", status: "active" },
    ]);
    expect(lastReflect.carry_forward).toEqual([
      { id: "s_new:cf1", item: "New item", status: "active" },
    ]);
  });

  it("writes DR reasoning artifacts through lib/reasoning.js", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      kv_operations: [],
      reasoning_artifacts: [
        {
          slug: "tasks-vs-desires-debate",
          summary: "Decide how continuity should work.",
          decision: "Use carry_forward as the only structured continuity mechanism.",
          conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
          body: "# Tasks vs Desires\n\nDecision details.",
        },
      ],
    });

    expect(reasoning.writeReasoningArtifacts).toHaveBeenCalledWith([
      {
        slug: "tasks-vs-desires-debate",
        summary: "Decide how continuity should work.",
        decision: "Use carry_forward as the only structured continuity mechanism.",
        conditions_to_revisit: ["Planner evidence shows stale-plan inertia."],
        body: "# Tasks vs Desires\n\nDecision details.",
        created_at: expect.any(String),
        source: "deep-reflect",
      },
    ]);
  });

  it("does not call reasoning writer when DR omits reasoning_artifacts", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
        carry_forward: [],
      },
    });

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      note_to_future_self: "New note",
      kv_operations: [],
    });

    expect(reasoning.writeReasoningArtifacts).not.toHaveBeenCalled();
  });

  it("clamps DR requested after_sessions to the default through generation 5 and allows it after generation 5", async () => {
    const nextSessionAfter = new Date(Date.now() + 60_000).toISOString();
    const defaults = {
      deep_reflect: {
        default_interval_sessions: 5,
        default_interval_days: 7,
      },
    };

    for (const { generation, expectedNextDueSession } of [
      { generation: 1, expectedNextDueSession: 105 },
      { generation: 6, expectedNextDueSession: 120 },
    ]) {
      const K = makeMockK({
        session_counter: 100,
        session_schedule: { next_session_after: nextSessionAfter },
        last_reflect: {
          note_to_future_self: "Existing note",
          carry_forward: [],
        },
        "dr:state:1": {
          status: "completed",
          generation,
          consecutive_failures: 0,
          last_applied_session: 80,
          job_id: `job_${generation}`,
        },
        [`dr:result:${generation}`]: {
          reflection: "test",
          note_to_future_self: "New note",
          kv_operations: [],
          next_reflect: {
            after_sessions: 20,
            after_days: 7,
          },
        },
      }, { defaults });

      await run(K, { crashData: null, balances: {}, events: [] });

      const drState = await K.kvGet("dr:state:1");
      expect(drState.status).toBe("idle");
      expect(drState.last_applied_session).toBe(100);
      expect(drState.next_due_session).toBe(expectedNextDueSession);
    }
  });
});

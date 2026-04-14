import { createHash } from "crypto";
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
  cosineSimilarity: vi.fn((a = [], b = []) => {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }),
}));

vi.mock("../lib/reasoning.js", () => ({
  writeReasoningArtifacts: vi.fn(async () => ({ written: [], indexEntries: [] })),
}));

import { run, classify, summarizeCarryForwardWaitState } from "../userspace.js";
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

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeBase64Utf8(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function splitOutputChunks(text, at) {
  return [
    { data: text.slice(0, at) },
    { data: text.slice(at) },
  ];
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
        observation: expect.stringContaining("No changes in circumstances. No action taken."),
        salience: 1,
        pattern_delta: expect.objectContaining({ sigma: 1 }),
      }),
    );

    const sessionSchedule = await K.kvGet("session_schedule");
    expect(sessionSchedule.interval_seconds).toBe(3600);
    expect(sessionSchedule.no_action_streak).toBe(1);
  });

  it("consumes burst mode and schedules the next session immediately", async () => {
    K = makeMockK({
      session_schedule: {
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
        burst_remaining: 3,
        burst_origin: "operator",
        burst_reason: "overnight_test",
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

    const sessionSchedule = await K.kvGet("session_schedule");
    expect(sessionSchedule.burst_remaining).toBe(2);
    expect(sessionSchedule.burst_origin).toBe("operator");
    expect(sessionSchedule.burst_reason).toBe("overnight_test");
    expect(new Date(sessionSchedule.next_session_after).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "burst_session_progress",
        remaining: 2,
        immediate_next: true,
      }),
    );
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

  it("bypasses the schedule gate for an internal bootstrap immediate wake", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    K = makeMockK({
      session_schedule: {
        next_session_after: future,
        interval_seconds: 3600,
        no_action_streak: 1,
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

    await run(K, {
      crashData: null,
      balances: {},
      events: [{
        type: "wake",
        origin: "internal",
        trigger: {
          actor: "bootstrap_fast",
          context: { bootstrap_fast: true, immediate: true },
        },
      }],
      schedule: {},
    });

    expect(await K.kvGet("session_counter")).toBe(1);
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "schedule_gate_bypassed",
        reason: "internal_immediate_wake",
        wake_origin: "internal",
        wake_actor: "bootstrap_fast",
      }),
    );
  });

  it("queues another immediate bootstrap wake when first DR dispatch fails", async () => {
    K = makeMockK({
      session_schedule: {
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 0,
        consecutive_failures: 0,
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
    K.executeToolCall = vi.fn(async () => ({ ok: false }));

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const drState = await K.kvGet("dr:state:1");
    expect(drState.status).toBe("failed");
    expect(drState.consecutive_failures).toBe(1);
    expect(K.emitEvent).toHaveBeenCalledWith(
      "wake",
      expect.objectContaining({
        origin: "internal",
        trigger: expect.objectContaining({
          actor: "bootstrap_fast",
          context: expect.objectContaining({
            bootstrap_fast: true,
            immediate: true,
          }),
        }),
      }),
    );
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "bootstrap_fast_wake_enqueued",
        dr_status: "failed",
      }),
    );
  });

  it("retries a failed pre-bootstrap DR immediately on the next session", async () => {
    K = makeMockK({
      session_counter: 1,
      session_schedule: {
        next_session_after: new Date(Date.now() - 1000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 1,
      },
      "dr:state:1": {
        status: "failed",
        generation: 0,
        consecutive_failures: 1,
        last_failure_session: 1,
      },
      "prompt:deep_reflect": "Reflect deeply on the bootstrap state.",
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
    K.executeToolCall = vi.fn(async () => ({ ok: true, job_id: "job_dr_1", workdir: "/srv/swayambhu/jobs/job_dr_1" }));

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const drState = await K.kvGet("dr:state:1");
    expect(drState.status).toBe("dispatched");
    expect(drState.job_id).toBe("job_dr_1");
    expect(drState.generation).toBe(1);
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "dr_dispatched",
        job_id: "job_dr_1",
        generation: 1,
      }),
    );
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
        observation: expect.stringContaining("No changes in circumstances. No action taken."),
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
          identity: {
            enabled: true,
            max_planner_items: 5,
            environment_roots: ["/home/swami", "/home/swayambhu"],
            working_body_prefixes: ["/home/swami/swayambhu", "/home/swami/swayambhu/repo"],
          },
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
        observation: "No changes in circumstances. No action taken.",
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
        "identification:working-body": {
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
        },
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
    expect(planCall.messages[0].content).toContain("[CONTINUATIONS]");
    expect(planCall.messages[0].content).toContain("internal continuity attached to durable work threads");
    expect(planCall.messages[0].content).toContain("Follow up with the patron about scheduling");
    expect(planCall.messages[0].content).toContain("(supports desire:d_help)");
    expect(planCall.messages[0].content).not.toContain("Keeps the conversation moving");
  });

  it("keeps carry-forward prose out of the planner while preserving operational facts", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "last_reflect": {
          carry_forward: [
            {
              id: "s_prev:cf1",
              item: "Wait for patron confirmation before editing the config",
              why: "I already concluded they seem impatient and should not be contradicted.",
              reason: "The last session felt tense and probably means the patron wants minimal initiative.",
              blocked_on: "explicit patron confirmation",
              wake_condition: "the patron sends confirmation",
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
    expect(planCall.messages[0].content).toContain("Wait for patron confirmation before editing the config");
    expect(planCall.messages[0].content).toContain("blocked_on=explicit patron confirmation");
    expect(planCall.messages[0].content).toContain("wake_condition=the patron sends confirmation");
    expect(planCall.messages[0].content).not.toContain("They seem impatient");
    expect(planCall.messages[0].content).not.toContain("The last session felt tense");
  });

  it("derives waiting state from structured carry-forward blockers even when prose is neutral", async () => {
    expect(summarizeCarryForwardWaitState([
      {
        id: "s_prev:cf1",
        item: "Keep the email probe ready.",
        why: "This thread remains valid, but action depends on an external unblock.",
        blocked_on: "patron-side auth details",
        wake_condition: "EMAIL_RELAY_SECRET is provided",
        priority: "high",
        status: "active",
      },
    ])).toEqual({
      active_item_count: 1,
      waiting_item_count: 1,
      all_active_items_waiting: true,
    });
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
      .split("[CONTINUATIONS]\n")[1]
      .split("\n\n[WORK THREADS]")[0];
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

  it("blocks reflective keys from next_act_context.load_keys and only loads factual continuity", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "workspace:active_ticket": { title: "Fix scheduler", state: "blocked" },
        "reflect:0:old_session": { reflection: "I think the patron is impatient." },
        "experience:e_old": { observation: "No changes in circumstances. No action taken." },
        "last_reflect": {
          next_act_context: {
            load_keys: ["workspace:active_ticket", "reflect:0:old_session", "experience:e_old"],
          },
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
    expect(planCall.messages[0].content).toContain("[REFLECT-LOADED CONTEXT]");
    expect(planCall.messages[0].content).toContain("workspace:active_ticket");
    expect(planCall.messages[0].content).not.toContain("reflect:0:old_session");
    expect(planCall.messages[0].content).not.toContain("experience:e_old");
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reflect_load_keys_blocked",
        blocked_keys: ["reflect:0:old_session", "experience:e_old"],
      }),
    );
  });

  it("surfaces non-root identifications to the planner when identity is enabled", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "action:1700000000000": {
          plan: { action: "computer", success: "Inspect the position brief artifact." },
          tool_calls: [{ tool: "computer" }],
          review: {
            observation: "Located the brief at /home/swami/swayambhu/repo/docs/superpowers/research/2026-04-08-external-model-cognitive-brief.md and copied a working version to /home/swayambhu/docs/sadhguru-position-brief-v1.md.",
            accomplished: "Inspected /home/swayambhu/docs and the repo brief to ground the first external work surface.",
            key_findings: [
              "The live artifact now exists at /home/swayambhu/docs/sadhguru-position-brief-v1.md.",
              "Home directory contains project directories: arcagi3, fano, swayambhu.",
            ],
          },
        },
        "last_reflect": {
          carry_forward: [
            {
              id: "cf:wait",
              item: "Wait for callback from the delegated review job and keep the brief thread ready.",
              why: "The current surface is blocked on callback while the delegated review finishes.",
              status: "active",
              priority: "high",
            },
          ],
        },
        "identification:working-body": {
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
        },
        "identification:patron-continuity": {
          identification: "Ongoing patron relationship and unfinished follow-through.",
          strength: 0.7,
        },
        "identification:entrusted-workspace": {
          identification: "Entrusted workspace integrity and continuity.",
          strength: 0.4,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          identity: {
            enabled: true,
            max_planner_items: 5,
            environment_roots: ["/home/swami", "/home/swayambhu"],
            working_body_prefixes: ["/home/swami/swayambhu", "/home/swami/swayambhu/repo"],
          },
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

    const planContent = K.callLLM.mock.calls[0][0].messages[0].content;
    expect(planContent).toContain("[WORKING BODY]");
    expect(planContent).toContain("Operational body: memory continuity, tools, and tool affordances.");
    expect(planContent).toContain("[IDENTIFICATIONS]");
    expect(planContent).toContain("identification:patron-continuity");
    expect(planContent).toContain("Ongoing patron relationship and unfinished follow-through.");
    expect(planContent).toContain("identification:entrusted-workspace");
    expect(planContent).not.toContain("identification:working-body");
    expect(planContent).toContain("\"environment_context\"");
    expect(planContent).toContain("/home/swami");
    expect(planContent).not.toContain("/home/swami/fano");
    expect(planContent).toContain("\"all_active_items_waiting\": true");
    expect(planContent).toContain("\"working_body_prefixes\"");
    expect(planContent).toContain("/home/swami/swayambhu/repo");
    expect(planContent).not.toContain("\"probe_bias\"");
    expect(planContent).not.toContain("\"breadth_bias\"");
    expect(planContent).not.toContain("\"maintenance_bias\"");
  });

  it("replans bootstrap probes that collapse into self-maintenance surfaces", async () => {
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "identification:working-body": {
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          identity: {
            enabled: true,
            max_planner_items: 5,
            environment_roots: ["/home/swami", "/home/swayambhu"],
            working_body_prefixes: ["/home/swami/swayambhu", "/home/swami/swayambhu/repo"],
          },
          session_budget: { max_cost: 0.50 },
          schedule: { interval_seconds: 3600, exploration_unlock_streak: 1 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    const selfMaintenancePlan = {
      action: "computer: cd /home/swami/swayambhu/repo && git status && cat README.md",
      success: "Understand the repo status and self-description docs.",
      serves_desires: ["desire:d_help"],
      follows_tactics: [],
      defer_if: null,
      no_action: false,
    };

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      if (callCount === 1) return llmResp(JSON.stringify(selfMaintenancePlan))(opts);
      if (callCount === 2) return llmResp(VALID_PLAN)(opts);
      return llmResp(VALID_REVIEW)(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: { no_action_streak: 1 } });

    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "plan_self_maintenance_probe_blocked",
        action: selfMaintenancePlan.action,
      }),
    );
    expect(K.callLLM.mock.calls[1][0].step).toBe("plan_retry_self_surface");
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

    const strengthCall = K.kvWriteGated.mock.calls.find(
      ([op, context]) => op.key === SAMSKARA_KEY && op.op === "field_merge" && context === "act",
    );
    expect(strengthCall).toBeDefined();
    const writtenStrength = strengthCall[0].fields.strength;
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

    const strengthCall = K.kvWriteGated.mock.calls.find(
      ([op, context]) => op.key === SAMSKARA_KEY && op.op === "field_merge" && context === "act",
    );
    expect(strengthCall).toBeDefined();
    const writtenStrength = strengthCall[0].fields.strength;
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
    expect(experienceValue.support).toEqual(expect.objectContaining({
      grounding: "mixed",
      completion: "full_cycle",
      external_anchor_count: 0,
      self_generated_only: true,
      recurrence_count: 1,
    }));
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

  it("uses a factual fallback observation instead of narrative or planner reasoning", async () => {
    const review = {
      assessment: "success",
      narrative: "This suggests the tactic is working and should probably be repeated.",
      salience_estimate: 0.8,
    };
    K = makeK(review);

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const experienceCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("experience:"));
    const experienceValue = typeof experienceCall[1] === "string" ? JSON.parse(experienceCall[1]) : experienceCall[1];
    expect(experienceValue.observation).toBe("An action completed and produced a response.");
    expect(experienceValue.observation).not.toContain("tactic");
    expect(experienceValue.text_rendering).toEqual({
      narrative: "This suggests the tactic is working and should probably be repeated.",
    });
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

  it("merges near-duplicate experiences by increasing recurrence count", async () => {
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
    await K.kvWriteSafe("experience:existing", {
      timestamp: "2026-04-08T10:00:00.000Z",
      action_ref: "action:old",
      session_id: "old_session",
      cycle: 0,
      observation: "A high-salience event occurred.",
      desire_alignment: { top_positive: [], top_negative: [], affinity_magnitude: 0 },
      pattern_delta: { sigma: 0.7, scores: [] },
      salience: 0.7,
      embedding: [0.1, 0.2, 0.3],
      support: {
        grounding: "mixed",
        completion: "full_cycle",
        external_anchor_count: 0,
        self_generated_only: true,
        recurrence_count: 2,
        first_observed_at: "2026-04-08T09:00:00.000Z",
        last_observed_at: "2026-04-08T10:00:00.000Z",
      },
    });
    const baseDefaults = await K.getDefaults();
    K.getDefaults = vi.fn(async () => ({
      ...baseDefaults,
      inference: { url: "http://localhost:9000" },
    }));
    callInference.mockImplementation(async (_url, _secret, path, body) => {
      if (path === "/embed" && body?.texts?.[0] === "A high-salience event occurred.") {
        return { embeddings: [[0.1, 0.2, 0.3]] };
      }
      return { embeddings: [] };
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const mergedExperience = await K.kvGet("experience:existing");
    expect(mergedExperience.support).toEqual(expect.objectContaining({
      recurrence_count: 3,
      completion: "full_cycle",
      grounding: "mixed",
    }));
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "experience_recurrence_merged",
        key: "experience:existing",
        recurrence_count: 3,
      }),
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

  it("records exercised identifications on actions and updates last_exercised_at mechanically", async () => {
    const review = {
      observation: "Sent the requested follow-up to the patron.",
      assessment: "success",
      narrative: "Patron follow-up sent.",
      salience_estimate: 0.4,
    };
    K = makeMockK(
      {
        "desire:d_help": JSON.stringify(DESIRE),
        "pattern:a_available": JSON.stringify(SAMSKARA),
        "identification:working-body": {
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
          last_exercised_at: null,
        },
        "identification:patron-continuity": {
          identification: "Ongoing patron relationship and unfinished follow-through.",
          strength: 0.7,
          last_exercised_at: null,
        },
      },
      {
        defaults: {
          act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
          reflect: { model: "test-model" },
          identity: { enabled: true, max_planner_items: 5 },
          session_budget: { max_cost: 0.50 },
          schedule: { interval_seconds: 3600 },
          execution: { max_steps: { act: 5 } },
        },
      },
    );

    evaluateAction.mockResolvedValue({
      sigma: 0.1,
      alpha: {},
      salience: 0.4,
      eval_method: "pipeline",
      tool_outcomes: [{ tool: "request_message", ok: true }],
      plan_success_criteria: null,
      patterns_relied_on: [SAMSKARA_KEY],
      pattern_scores: {},
      served_desires: ["desire:d_help"],
    });

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(VALID_PLAN)(opts)
        : llmResp(JSON.stringify(review))(opts);
    });

    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Sent." });
      return {
        response: {
          content: "Sent.",
          toolCalls: [
            {
              function: {
                name: "request_message",
                arguments: JSON.stringify({
                  to: "swami_kevala",
                  message: "Following up on the earlier thread.",
                }),
              },
            },
          ],
        },
        toolResults: [{ ok: true, delivered: true }],
        cost: 0.01,
        done: true,
      };
    });

    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const actionCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("action:"));
    const actionValue = typeof actionCall[1] === "string" ? JSON.parse(actionCall[1]) : actionCall[1];
    expect(actionValue.exercised_identifications).toEqual(["identification:patron-continuity"]);

    expect(K.kvWriteGated).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "field_merge",
        key: "identification:patron-continuity",
        fields: { last_exercised_at: expect.any(String) },
      }),
      "act",
    );
    expect(K.kvWriteGated).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "field_merge",
        key: "identification:working-body",
        fields: { last_exercised_at: expect.any(String) },
      }),
      "act",
    );

    const patronContinuity = await K.kvGet("identification:patron-continuity");
    const workingBody = await K.kvGet("identification:working-body");
    expect(patronContinuity.last_exercised_at).toEqual(expect.any(String));
    expect(workingBody.last_exercised_at).toEqual(expect.any(String));
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

  it("synthesizes a single active aim when the plan omits it", async () => {
    await run(K, { crashData: null, balances: {}, events: [], schedule: {} });

    const actionCall = K.kvWriteSafe.mock.calls.find(([key]) => key.startsWith("action:"));
    const actionValue = typeof actionCall[1] === "string" ? JSON.parse(actionCall[1]) : actionCall[1];

    expect(actionValue.plan.active_aims).toEqual([
      {
        description: "send_greeting",
        success_test: "patron receives greeting",
      },
    ]);
    expect(K.karmaRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "plan_active_aim_synthesized",
        action: "send_greeting",
      }),
    );
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

  it("maps identification keys to mind bucket", () => {
    expect(classify(new Set(["identification:patron-continuity"]))).toContain("mind");
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
      karmaRecord: vi.fn(async () => {}),
      stageCode: vi.fn(async () => {}),
      signalDeploy: vi.fn(async () => {}),
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

  it("blocks identification operations when identity review is disabled", async () => {
    const writes = [];
    const K = makeMockK({}, {
      defaults: {
        identity: { enabled: false },
      },
    });
    K.kvWriteGated = vi.fn(async (op, ctx) => {
      writes.push({ key: op.key, ctx });
      return { ok: true };
    });

    await applyDrResults(K, { generation: 7 }, {
      kv_operations: [
        {
          key: "identification:patron-continuity",
          op: "put",
          value: { identification: "Ongoing patron relationship and unfinished follow-through.", strength: 0.3 },
        },
      ],
      reflection: "test",
    });

    expect(writes).toHaveLength(0);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr_apply_blocked",
      blocked: [{ key: "identification:patron-continuity", error: "identity_review_disabled" }],
      applied: 0,
    }));
  });

  it("rejects malformed deep-reflect kv_operations without partial writes", async () => {
    const writes = [];
    const K = mockK(writes);

    await applyDrResults(K, {}, {
      kv_operations: [
        { key: "pattern:good", op: "put", value: { pattern: "x", strength: 0.5 } },
        { key: "pattern:bad", operation: "set", value: { pattern: "y", strength: 0.4 } },
      ],
      reflection: "test",
    });

    expect(writes).toHaveLength(0);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "kv_operation_batch_rejected",
      source: "deep-reflect",
    }));
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr_apply_blocked",
      applied: 0,
      blocked: expect.arrayContaining([
        expect.objectContaining({
          key: "pattern:bad",
        }),
      ]),
    }));
  });

  it("passes identification operations to kvWriteGated when identity review is enabled", async () => {
    const writes = [];
    const K = makeMockK({}, {
      defaults: {
        identity: { enabled: true },
      },
    });
    K.kvWriteGated = vi.fn(async (op, ctx) => {
      writes.push({ key: op.key, ctx });
      return { ok: true };
    });

    await applyDrResults(K, { generation: 7 }, {
      kv_operations: [
        {
          key: "identification:patron-continuity",
          op: "put",
          value: { identification: "Ongoing patron relationship and unfinished follow-through.", strength: 0.3 },
        },
      ],
      reflection: "test",
    });

    expect(writes).toEqual([
      { key: "identification:patron-continuity", ctx: "deep-reflect" },
    ]);
    expect(K.emitEvent).toHaveBeenCalledWith("dr_complete", expect.objectContaining({
      identifications_changed: 1,
    }));
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
      expect.objectContaining({ id: "s_prev:cf1", item: "Keep this", status: "active" }),
    ]);
    expect(lastReflect.carry_forward).toEqual([
      expect.objectContaining({ id: "s_prev:cf1", item: "Keep this", status: "active" }),
    ]);
    expect(reflectRecord.carry_forward[0].request_id).toEqual(expect.any(String));
    expect(lastReflect.carry_forward[0].request_id).toEqual(expect.any(String));
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
      expect.objectContaining({ id: "s_new:cf1", item: "New item", status: "active" }),
    ]);
    expect(lastReflect.carry_forward).toEqual([
      expect.objectContaining({ id: "s_new:cf1", item: "New item", status: "active" }),
    ]);
    expect(reflectRecord.carry_forward[0].request_id).toEqual(expect.any(String));
    expect(lastReflect.carry_forward[0].request_id).toEqual(expect.any(String));
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

  it("stores meta_policy_notes on the deep-reflect record without loading them into last_reflect", async () => {
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
      meta_policy_notes: [
        {
          slug: "missing-meta-policy-surface",
          summary: "Runtime policy advice is being smuggled into tactics.",
          subsystem: "review",
          observation: "A tactic encoded scheduler/write-policy guidance.",
          proposed_experiment: "Add a non-live meta-policy note field and rerun the variant audit.",
          rationale: "This is not an act-time tactic and should stay out of live DR-1 buckets.",
          confidence: 0.82,
        },
      ],
    });

    const reflectRecord = await K.kvGet("reflect:1:test_execution");
    const lastReflect = await K.kvGet("last_reflect");
    const reviewNote = await K.kvGet("review_note:userspace_review:test_execution:d1:000:missing-meta-policy-surface");

    expect(reflectRecord.meta_policy_notes).toEqual([
      {
        slug: "missing-meta-policy-surface",
        summary: "Runtime policy advice is being smuggled into tactics.",
        subsystem: "review",
        observation: "A tactic encoded scheduler/write-policy guidance.",
        proposed_experiment: "Add a non-live meta-policy note field and rerun the variant audit.",
        rationale: "This is not an act-time tactic and should stay out of live DR-1 buckets.",
        target_review: "userspace_review",
        non_live: true,
        confidence: 0.82,
      },
    ]);
    expect(reviewNote).toEqual({
      slug: "missing-meta-policy-surface",
      summary: "Runtime policy advice is being smuggled into tactics.",
      subsystem: "review",
      observation: "A tactic encoded scheduler/write-policy guidance.",
      proposed_experiment: "Add a non-live meta-policy note field and rerun the variant audit.",
      rationale: "This is not an act-time tactic and should stay out of live DR-1 buckets.",
      target_review: "userspace_review",
      non_live: true,
      confidence: 0.82,
      created_at: expect.any(String),
      source: "deep_reflect",
      source_session_id: "test_execution",
      source_depth: 1,
      source_reflect_key: "reflect:1:test_execution",
    });
    expect(lastReflect.meta_policy_notes).toBeUndefined();
  });

  it("ignores DR-1 code stage requests entirely", async () => {
    const writes = [];
    const K = mockK(writes);

    await applyDrResults(K, { generation: 7 }, {
      reflection: "test",
      kv_operations: [],
      code_stage_requests: [
        { target: "kernel:source:kernel.js", code: "export async function execute() {}" },
        { target: "tool:test:code", code: "Add a planner-failure fallback for external probe wakes." },
      ],
      deploy: true,
    });

    expect(K.stageCode).not.toHaveBeenCalled();
    expect(K.signalDeploy).not.toHaveBeenCalled();
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

  it("dispatches DR-2 from a schedule-skipped tick using configured runners and timeouts", async () => {
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "idle",
        generation: 0,
        consecutive_failures: 0,
        processed_note_keys: [],
        processed_through_created_at: null,
      },
      "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly": {
        slug: "waiting-state-derived-too-narrowly",
        summary: "Established breadth policy was bypassed while the only live thread was blocked.",
        target_review: "userspace_review",
        created_at: "2026-04-10T15:04:45.893Z",
        source_reflect_key: "reflect:1:x_wait",
      },
      "kernel:source_map": {
        userspace: "hook:session:code",
        reflection: "hook:reflect:code",
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          review_runner: "codex",
          adversarial_runner: "claude",
          author_runner: "codex",
          review_timeout_ms: 480000,
          adversarial_timeout_ms: 600000,
          author_timeout_ms: 300000,
          adversarial_max_rounds: 2,
          repo_dir: "/home/swami/swayambhu/repo",
          source_ref: "current",
          max_processed_note_keys: 50,
        },
      },
    });

    K.executeToolCall = vi.fn(async () => ({ ok: true, job_id: "job_dr2", workdir: "/tmp/dr2-job" }));

    await run(K, { crashData: null, balances: {}, events: [] });

    expect(K.executeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      function: expect.objectContaining({ name: "start_job" }),
    }));

    const dispatchCall = K.executeToolCall.mock.calls[0][0];
    const toolArgs = JSON.parse(dispatchCall.function.arguments);
    expect(toolArgs.command).toContain("export SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR=\"$PWD\"");
    expect(toolArgs.command).toContain("export SWAYAMBHU_USERSPACE_REVIEW_TIMEOUT_MS='480000'");
    expect(toolArgs.command).toContain("export SWAYAMBHU_USERSPACE_AUTHOR_TIMEOUT_MS='300000'");
    expect(toolArgs.command).toContain("'--review-runner' 'codex'");
    expect(toolArgs.command).toContain("'--adversarial-runner' 'claude'");
    expect(toolArgs.command).toContain("'--adversarial-timeout-ms' '600000'");
    expect(toolArgs.command).toContain("'--adversarial-max-rounds' '2'");
    expect(toolArgs.command).toContain("'--author-runner' 'codex'");
    expect(toolArgs.context_keys).toContain("review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly");
    expect(toolArgs.context_keys).toContain("reflect:1:x_wait");
    expect(toolArgs.context_keys).toContain("hook:session:code");
    expect(toolArgs.context_keys).toContain("hook:reflect:code");

    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("dispatched");
    expect(dr2State.active_review_note_key).toBe("review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly");
    expect(dr2State.job_id).toBe("job_dr2");
  });

  it("falls back to codex for DR-2 review runner when the key is absent", async () => {
    const K = makeMockK({
      session_counter: 40,
      "kernel:state_lab": {
        ref: "branch:dr2-runtime-active-note",
      },
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "idle",
        generation: 0,
        consecutive_failures: 0,
        processed_note_keys: [],
        processed_through_created_at: null,
      },
      "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly": {
        slug: "waiting-state-derived-too-narrowly",
        summary: "Established breadth policy was bypassed while the only live thread was blocked.",
        target_review: "userspace_review",
        created_at: "2026-04-10T15:04:45.893Z",
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          author_runner: "codex",
          review_timeout_ms: 480000,
          author_timeout_ms: 300000,
          repo_dir: "/home/swami/swayambhu/repo",
          source_ref: "current",
          max_processed_note_keys: 50,
        },
      },
    });

    K.executeToolCall = vi.fn(async () => ({ ok: true, job_id: "job_dr2", workdir: "/tmp/dr2-job" }));

    await run(K, { crashData: null, balances: {}, events: [] });

    const dispatchCall = K.executeToolCall.mock.calls[0][0];
    const toolArgs = JSON.parse(dispatchCall.function.arguments);
    expect(toolArgs.command).toContain("'--source-ref' 'branch:dr2-runtime-active-note'");
    expect(toolArgs.command).toContain("'--review-runner' 'codex'");
  });

  it("verifies stageable DR-2 output against the dispatched workdir lab result", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const validatedChanges = {
      kv_operations: [],
      code_stage_requests: [{
        target: "hook:session:code",
        code: "// ── DR Lifecycle (independent state machine) ──────────────\nexport const sentinel = 'ok';\n",
      }],
      deploy: false,
    };
    const validatedChangesHash = sha256Json(validatedChanges);
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.stageCode = vi.fn(async () => {});
    K.signalDeploy = vi.fn(async () => {});

    const payload = {
      review_note_key: reviewNoteKey,
      promotion_recommendation: "stageable",
      lab_result_path: "/tmp/evil/lab-result.json",
      validated_changes_hash: validatedChangesHash,
      validated_changes: validatedChanges,
    };
    const labResult = {
      review_note_key: reviewNoteKey,
      validated_changes_hash: validatedChangesHash,
    };

    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes("/tmp/dr2-job/exit_code")) return { ok: true, output: "0" };
      if (args.command.includes("/tmp/dr2-job/output.json")) {
        const encoded = encodeBase64Utf8(JSON.stringify(payload));
        return { ok: true, output: splitOutputChunks(encoded, 41) };
      }
      if (args.command.includes("/tmp/dr2-job/lab-result.json")) {
        const encoded = encodeBase64Utf8(JSON.stringify(labResult));
        return { ok: true, output: splitOutputChunks(encoded, 17) };
      }
      if (args.command.includes("/tmp/evil/lab-result.json")) return { ok: true, output: "{\"unexpected\":true}" };
      return { ok: true, output: "" };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    const commands = K.executeAdapter.mock.calls.map(([, args]) => args.command);
    expect(commands.some((command) => command.includes("/tmp/dr2-job/lab-result.json"))).toBe(true);
    expect(commands.some((command) => command.includes("/tmp/evil/lab-result.json"))).toBe(false);

    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("idle");
    expect(dr2State.processed_note_keys).toContain(reviewNoteKey);
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr2_validated_changes_applied",
      review_note_key: reviewNoteKey,
    }));
    expect(K.stageCode).toHaveBeenCalledWith("hook:session:code", expect.stringContaining("──────────────"));
  });

  it("finalizes DR-2 from callback-hydrated job_result without re-reading the remote workdir", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const validatedChanges = {
      kv_operations: [],
      code_stage_requests: [{
        target: "hook:session:code",
        code: "export default async function callbackHydrated() {}\n",
      }],
      deploy: false,
    };
    const validatedChangesHash = sha256Json(validatedChanges);
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
      "job:job_dr2": {
        id: "job_dr2",
        status: "completed",
        result_key: "job_result:job_dr2",
      },
      "job_result:job_dr2": {
        job_id: "job_dr2",
        type: "custom",
        result: {
          review_note_key: reviewNoteKey,
          promotion_recommendation: "stageable",
          validated_changes_hash: validatedChangesHash,
          validated_changes: validatedChanges,
        },
        lab_result: {
          review_note_key: reviewNoteKey,
          validated_changes_hash: validatedChangesHash,
        },
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.stageCode = vi.fn(async () => {});
    K.signalDeploy = vi.fn(async () => {});
    K.executeAdapter = vi.fn(async () => {
      throw new Error("remote artifact read should not be needed");
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    expect(K.stageCode).toHaveBeenCalledWith(
      "hook:session:code",
      "export default async function callbackHydrated() {}\n",
    );
    expect(K.executeAdapter).not.toHaveBeenCalled();
    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("idle");
  });

  it("finalizes DR-2 from a callback-hydrated lab_result when output is missing and the job exited failed", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const validatedChanges = {
      kv_operations: [],
      code_stage_requests: [],
      deploy: false,
    };
    const validatedChangesHash = sha256Json(validatedChanges);
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
      "job:job_dr2": {
        id: "job_dr2",
        status: "failed",
        result_key: "job_result:job_dr2",
      },
      "job_result:job_dr2": {
        job_id: "job_dr2",
        type: "custom",
        result: null,
        callback_error: "callback_missing_output",
        lab_result: {
          review_note_key: reviewNoteKey,
          promotion_recommendation: "reject",
          validated_changes_hash: validatedChangesHash,
          validated_changes: validatedChanges,
          reasons_not_to_change: ["Candidate static validation failed."],
        },
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.executeAdapter = vi.fn(async () => {
      throw new Error("remote artifact read should not be needed");
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    expect(K.executeAdapter).not.toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr2_non_stageable_result",
      review_note_key: reviewNoteKey,
      recommendation: "reject",
    }));
    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("idle");
    expect(dr2State.processed_note_keys).toContain(reviewNoteKey);
  });

  it("hydrates a completed DR-2 job from the remote workdir when callback persisted no result key", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const validatedChanges = {
      kv_operations: [],
      code_stage_requests: [{
        target: "hook:session:code",
        code: "export default async function hydratedFallback() {}\n",
      }],
      deploy: false,
    };
    const validatedChangesHash = sha256Json(validatedChanges);
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
      "job:job_dr2": {
        id: "job_dr2",
        status: "completed",
        callback_received_at: new Date().toISOString(),
        workdir: "/tmp/dr2-job",
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.stageCode = vi.fn(async () => {});
    K.signalDeploy = vi.fn(async () => {});
    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes("/tmp/dr2-job/output.json")) {
        return {
          ok: true,
          output: JSON.stringify({
            review_note_key: reviewNoteKey,
            promotion_recommendation: "stageable",
            validated_changes_hash: validatedChangesHash,
            validated_changes: validatedChanges,
          }),
        };
      }
      if (args.command.includes("/tmp/dr2-job/lab-result.json")) {
        return {
          ok: true,
          output: encodeBase64Utf8(JSON.stringify({
            review_note_key: reviewNoteKey,
            validated_changes_hash: validatedChangesHash,
          })),
        };
      }
      return { ok: true, output: "" };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    expect(K.stageCode).toHaveBeenCalledWith(
      "hook:session:code",
      "export default async function hydratedFallback() {}\n",
    );
    expect(await K.kvGet("job_result:job_dr2")).toEqual(expect.objectContaining({
      job_id: "job_dr2",
      result: expect.objectContaining({
        review_note_key: reviewNoteKey,
      }),
    }));
    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("idle");
  });

  it("verifies stageable DR-2 output against the bundled lab_result_path when callback stored no embedded lab result", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const validatedChanges = {
      kv_operations: [],
      code_stage_requests: [{
        target: "hook:session:code",
        code: "export default async function bundledLabResultPath() {}\n",
      }],
      deploy: false,
    };
    const validatedChangesHash = sha256Json(validatedChanges);
    const bundledLabResultPath = "/home/swami/swayambhu/state-lab/dr2-runs/example/lab-result.json";
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
      "job:job_dr2": {
        id: "job_dr2",
        status: "completed",
        result_key: "job_result:job_dr2",
      },
      "job_result:job_dr2": {
        job_id: "job_dr2",
        type: "custom",
        result: {
          review_note_key: reviewNoteKey,
          promotion_recommendation: "stageable",
          lab_result_path: bundledLabResultPath,
          validated_changes_hash: validatedChangesHash,
          validated_changes: validatedChanges,
        },
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.stageCode = vi.fn(async () => {});
    K.signalDeploy = vi.fn(async () => {});
    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes(bundledLabResultPath)) {
        return {
          ok: true,
          output: splitOutputChunks(encodeBase64Utf8(JSON.stringify({
            review_note_key: reviewNoteKey,
            validated_changes_hash: validatedChangesHash,
          })), 23),
        };
      }
      if (args.command.includes("/tmp/dr2-job/lab-result.json")) {
        return { ok: false, output: "" };
      }
      throw new Error(`unexpected adapter command: ${args.command}`);
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    const commands = K.executeAdapter.mock.calls.map(([, args]) => args.command);
    expect(commands.some((command) => command.includes(bundledLabResultPath))).toBe(true);
    expect(commands.some((command) => command.includes("/tmp/dr2-job/lab-result.json"))).toBe(false);
    expect(K.stageCode).toHaveBeenCalledWith(
      "hook:session:code",
      "export default async function bundledLabResultPath() {}\n",
    );
    expect((await K.kvGet("dr2:state:1")).status).toBe("idle");
  });

  it("fails DR-2 cleanly when a callback completed job has no readable result", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
      "job:job_dr2": {
        id: "job_dr2",
        status: "completed",
        callback_received_at: new Date().toISOString(),
        workdir: "/tmp/dr2-job",
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });

    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes("/tmp/dr2-job/output.json")) return { ok: true, output: "{}" };
      return { ok: true, output: "RUNNING" };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("failed");
    expect(dr2State.failure_reason).toBe("job_result_missing_after_callback");
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr2_failed",
      error: "job_result_missing_after_callback",
    }));
  });

  it("fails DR-2 stageable output when validated_changes content does not match its claimed hash", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const claimedChanges = { kv_operations: [], code_stage_requests: [], deploy: false };
    const actualChanges = { kv_operations: [{ op: "put", key: "prompt:plan", value: "tampered" }], code_stage_requests: [], deploy: false };
    const validatedChangesHash = sha256Json(claimedChanges);
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });
    K.stageCode = vi.fn(async () => {});
    K.signalDeploy = vi.fn(async () => {});

    const payload = {
      review_note_key: reviewNoteKey,
      promotion_recommendation: "stageable",
      lab_result_path: "/tmp/dr2-job/lab-result.json",
      validated_changes_hash: validatedChangesHash,
      validated_changes: actualChanges,
    };
    const labResult = {
      review_note_key: reviewNoteKey,
      validated_changes_hash: validatedChangesHash,
    };

    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes("/tmp/dr2-job/exit_code")) return { ok: true, output: "0" };
      if (args.command.includes("/tmp/dr2-job/output.json")) return { ok: true, output: encodeBase64Utf8(JSON.stringify(payload)) };
      if (args.command.includes("/tmp/dr2-job/lab-result.json")) return { ok: true, output: encodeBase64Utf8(JSON.stringify(labResult)) };
      return { ok: true, output: "" };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("failed");
    expect(dr2State.failure_reason).toBe("validated_changes_content_hash_mismatch");
    expect(K.stageCode).not.toHaveBeenCalled();
    expect(K.signalDeploy).not.toHaveBeenCalled();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr2_failed",
      error: "validated_changes_content_hash_mismatch",
    }));
  });

  it("fails DR-2 stageable output when output.json transport is not valid base64", async () => {
    const reviewNoteKey = "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly";
    const K = makeMockK({
      session_counter: 40,
      session_schedule: {
        next_session_after: new Date(Date.now() + 60_000).toISOString(),
        interval_seconds: 3600,
        no_action_streak: 0,
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        consecutive_failures: 0,
        next_due_session: 999,
      },
      "dr2:state:1": {
        status: "dispatched",
        generation: 1,
        active_review_note_key: reviewNoteKey,
        active_review_note_created_at: "2026-04-10T15:04:45.893Z",
        job_id: "job_dr2",
        workdir: "/tmp/dr2-job",
        dispatched_at: new Date(Date.now() - 5_000).toISOString(),
        processed_note_keys: [],
        processed_through_created_at: null,
        consecutive_failures: 0,
      },
    }, {
      defaults: {
        schedule: { interval_seconds: 3600 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 120 },
        execution: { max_steps: { act: 5 } },
        deep_reflect: { default_interval_sessions: 5, default_interval_days: 7 },
        dr2: {
          enabled: true,
          cooldown_sessions: 3,
        },
        jobs: { base_url: "http://akash.test" },
      },
    });

    K.executeAdapter = vi.fn(async (_provider, args) => {
      if (args.command.includes("/tmp/dr2-job/exit_code")) return { ok: true, output: "0" };
      if (args.command.includes("/tmp/dr2-job/output.json")) return { ok: true, output: "%%%not-base64%%%" };
      return { ok: true, output: "" };
    });

    await run(K, {
      crashData: null,
      balances: {},
      events: [{ type: "job_complete", job_id: "job_dr2" }],
    });

    const dr2State = await K.kvGet("dr2:state:1");
    expect(dr2State.status).toBe("failed");
    expect(dr2State.failure_reason).toBe("could not parse output.json");
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "dr2_failed",
      error: "could not parse output.json",
    }));
  });
});

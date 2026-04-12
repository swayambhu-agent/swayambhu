import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockK } from "./helpers/mock-kernel.js";

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

import { run, classify, applyDrResults } from "../userspace.js";
import { evaluateAction } from "../eval.js";
import { updatePatternStrength } from "../memory.js";

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

    // Plan call should include DESIRES and PATTERNS sections
    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toMatch(/DESIRES/);
    expect(planCall.messages[0].content).toMatch(/PATTERNS/);
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
      expect.objectContaining({ event: "act_complete" }),
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

  const SAMSKARA = {
    pattern: "Patron is available to receive messages",
    strength: 0.8,
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

    // First call: plan phase — messages contain desires/patterns
    const planCall = K.callLLM.mock.calls[0][0];
    expect(planCall.messages[0].content).toMatch(/DESIRES/);
    expect(planCall.messages[0].content).toMatch(/PATTERNS/);

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
    relies_on: [],
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

    // Should write updated strength via kvWriteGated (pattern:* is protected)
    const strengthWrite = K.kvWriteGated.mock.calls.find(([op]) => op.key === SAMSKARA_KEY);
    expect(strengthWrite).toBeDefined();
    const written = strengthWrite[0].value;
    expect(written.strength).toBeGreaterThanOrEqual(0);
    expect(written.strength).toBeLessThanOrEqual(1);
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

    const strengthWrite = K.kvWriteGated.mock.calls.find(([op]) => op.key === SAMSKARA_KEY);
    expect(strengthWrite).toBeDefined();
    const written = strengthWrite[0].value;
    // Violation should decrease strength
    expect(written.strength).toBeLessThan(0.8);
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
    expect(experienceValue.salience).toBeDefined();
    expect(experienceValue.surprise_score).toBeDefined();
    expect(experienceValue.embedding).toBeNull(); // no inferenceConfig
    expect(experienceValue.affinity_vector).toBeUndefined();
    expect(experienceValue.active_assumptions).toBeUndefined();
    expect(experienceValue.active_desires).toBeUndefined();
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

describe("identity integration", () => {
  it("surfaces non-root identifications to the planner when identity is enabled", async () => {
    const K = makeMockK(
      {
        "desire:d_help": JSON.stringify({
          slug: "d_help",
          direction: "approach",
          description: "Help the patron effectively.",
        }),
        "pattern:a_available": JSON.stringify({
          pattern: "Patron is available to receive messages",
          strength: 0.8,
        }),
        "identification:working-body": JSON.stringify({
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
        }),
        "identification:patron-continuity": JSON.stringify({
          identification: "Ongoing patron relationship continuity.",
          strength: 0.7,
        }),
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

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(JSON.stringify({
          action: "send_greeting",
          success: "patron receives greeting",
          relies_on: [],
          defer_if: [],
        }))(opts)
        : llmResp(JSON.stringify({
          assessment: "success",
          narrative: "Greeting sent successfully.",
          salience_estimate: 0.1,
        }))(opts);
    });
    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Done." });
      return { response: { content: "Done.", toolCalls: [] }, toolResults: [], cost: 0.01, done: true };
    });

    await run(K, { crashData: null, balances: {}, events: [] });

    const planContent = K.callLLM.mock.calls[0][0].messages[0].content;
    expect(planContent).toContain("[IDENTIFICATIONS]");
    expect(planContent).toContain("identification:patron-continuity");
    expect(planContent).not.toContain("identification:working-body");
  });

  it("records exercised identifications on actions and updates last_exercised_at mechanically", async () => {
    const K = makeMockK(
      {
        "desire:d_help": JSON.stringify({
          slug: "d_help",
          direction: "approach",
          description: "Help the patron effectively.",
        }),
        "pattern:a_available": JSON.stringify({
          pattern: "Patron is available to receive messages",
          strength: 0.8,
        }),
        "identification:working-body": JSON.stringify({
          identification: "Operational body: memory continuity, tools, and tool affordances.",
          strength: 0.8,
          last_exercised_at: null,
        }),
        "identification:patron-continuity": JSON.stringify({
          identification: "Ongoing patron relationship continuity.",
          strength: 0.7,
          last_exercised_at: null,
        }),
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

    let callCount = 0;
    K.callLLM = vi.fn(async (opts) => {
      callCount++;
      return callCount === 1
        ? llmResp(JSON.stringify({
          action: "send_followup",
          success: "patron receives a continuity-preserving follow-up",
          relies_on: [],
          defer_if: [],
        }))(opts)
        : llmResp(JSON.stringify({
          assessment: "success",
          narrative: "Patron relationship continuity was maintained with a concrete follow-up.",
          salience_estimate: 0.1,
          accomplished: "Sent the follow-up.",
        }))(opts);
    });
    K.runAgentTurn = vi.fn(async ({ messages }) => {
      messages.push({ role: "assistant", content: "Patron relationship continuity maintained." });
      return {
        response: { content: "Patron relationship continuity maintained.", toolCalls: [] },
        toolResults: [],
        cost: 0.01,
        done: true,
      };
    });

    await run(K, { crashData: null, balances: {}, events: [] });

    const actionKey = [...K._kv._store.keys()].find((key) => key.startsWith("action:"));
    const actionValue = await K.kvGet(actionKey);
    expect(actionValue.exercised_identifications).toEqual(["identification:patron-continuity"]);
    expect(K.updateIdentificationLastExercised).toHaveBeenCalledWith(
      "identification:patron-continuity",
      expect.any(String),
    );
    expect(K.updateIdentificationLastExercised).toHaveBeenCalledWith(
      "identification:working-body",
      expect.any(String),
    );
  });
});

describe("deep reflect meta-policy notes", () => {
  it("persists review notes without copying them into last_reflect", async () => {
    const K = makeMockK({
      last_reflect: {
        note_to_future_self: "Existing note",
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
});

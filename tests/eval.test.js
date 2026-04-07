import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../memory.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callInference: vi.fn() };
});

import { callInference } from "../memory.js";
import { evaluateAction } from "../eval.js";

describe("evaluateAction (three-tier pipeline)", () => {
  const desires = {
    "desire:serve": {
      slug: "serve",
      direction: "approach",
      description: "Serve seekers",
      source_principles: ["care"],
      _embedding: [0.5, 0.3, 0.1],
    },
  };

  const patterns = {
    "pattern:google-docs-accessible": {
      pattern: "Google Docs API is accessible and responsive",
      strength: 0.9,
      _embedding: [0.4, 0.2, 0.8],
    },
  };

  const ledger = {
    action_id: "sess_1_cycle_0",
    plan: {
      action: "compile research doc",
      success: "doc saved, 5+ topics",
      serves_desires: ["desire:serve"],
      follows_tactics: [],
      defer_if: "budget < 30%",
    },
    tool_calls: [
      { tool: "google_docs_create", input: {}, output: { id: "doc123" }, ok: true },
      { tool: "search_kb", input: {}, output: { results: [] }, ok: true },
    ],
    final_text: "Research doc created successfully.",
  };

  const config = {
    url: "http://localhost:9999",
    secret: "test-secret",
    relevance_threshold: 0.3,
    ambiguity_threshold: 0.6,
  };

  let K;

  beforeEach(() => {
    vi.clearAllMocks();
    K = {
      callLLM: vi.fn(),
      karmaRecord: vi.fn(),
    };
  });

  it("full pipeline: embed + NLI -> computes sigma/alpha", async () => {
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "__plan_success__",
          label: "entailment",
          scores: { entailment: 0.85, contradiction: 0.05, neutral: 0.10 },
        },
      ],
    });
    // Tier 1: embedding
    callInference.mockResolvedValueOnce({
      embeddings: [[0.5, 0.3, 0.2]],
    });
    // Tier 2: NLI
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "pattern:google-docs-accessible",
          label: "entailment",
          scores: { entailment: 0.90, contradiction: 0.02, neutral: 0.08 },
        },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, patterns, config);

    expect(result.eval_method).toBe("pipeline");
    expect(result.alpha).toHaveProperty("desire:serve");
    expect(result.alpha["desire:serve"]).toBeGreaterThan(0); // entailment -> positive
    expect(result.pattern_scores).toHaveProperty("pattern:google-docs-accessible");
    expect(result.pattern_scores["pattern:google-docs-accessible"].direction).toBe("entailment");
    expect(typeof result.sigma).toBe("number");
    expect(typeof result.salience).toBe("number");
    expect(result.salience).toBeLessThanOrEqual(1);
    expect(result.served_desires).toEqual(["desire:serve"]);
    expect(result.followed_tactics).toEqual([]);
    expect(callInference).toHaveBeenCalledTimes(3);
    expect(callInference.mock.calls[0][2]).toBe("/nli");
    expect(callInference.mock.calls[1][2]).toBe("/embed");
    expect(callInference.mock.calls[2][2]).toBe("/nli");
  });

  it("falls back to LLM when inference unavailable", async () => {
    callInference.mockRejectedValue(new Error("Connection refused"));

    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "__plan_success__", direction: "entailment", confidence: 0.7 },
      ]),
    });
    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "pattern:google-docs-accessible", direction: "neutral", confidence: 0.5 },
      ]),
    });

    const result = await evaluateAction(K, ledger, desires, patterns, config);

    expect(result.eval_method).toBe("llm_fallback");
    expect(K.callLLM).toHaveBeenCalledTimes(2);
    expect(result.alpha["desire:serve"]).toBeCloseTo(0.7);
    expect(result.pattern_scores["pattern:google-docs-accessible"].direction).toBe("neutral");
  });

  it("sends ambiguous NLI pairs to LLM Tier 3", async () => {
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "__plan_success__",
          label: "entailment",
          scores: { entailment: 0.85, contradiction: 0.05, neutral: 0.10 },
        },
      ],
    });
    // Tier 1: embedding
    callInference.mockResolvedValueOnce({
      embeddings: [[0.5, 0.3, 0.2]],
    });
    // Tier 2: NLI — pattern is ambiguous
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "pattern:google-docs-accessible",
          label: "neutral",
          scores: { entailment: 0.35, contradiction: 0.30, neutral: 0.35 },
        },
      ],
    });
    // Tier 3: LLM for ambiguous pair
    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "pattern:google-docs-accessible", direction: "entailment", confidence: 0.8 },
      ]),
    });

    const result = await evaluateAction(K, ledger, desires, patterns, config);

    expect(result.eval_method).toBe("pipeline");
    expect(K.callLLM).toHaveBeenCalledTimes(1);
    expect(result.alpha["desire:serve"]).toBeCloseTo(0.85);
    expect(result.pattern_scores["pattern:google-docs-accessible"].direction).toBe("entailment");
  });

  it("returns tool_outcomes and served/followed plan guidance", async () => {
    callInference.mockResolvedValueOnce({
      results: [
        { id: "__plan_success__", label: "entailment", scores: { entailment: 0.82, contradiction: 0.08, neutral: 0.10 } },
      ],
    });
    callInference.mockResolvedValueOnce({ embeddings: [[0.5, 0.3, 0.2]] });
    callInference.mockResolvedValueOnce({
      results: [
        { id: "pattern:google-docs-accessible", label: "entailment", scores: { entailment: 0.9, contradiction: 0.01, neutral: 0.09 } },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, patterns, config);

    expect(result.tool_outcomes).toEqual([
      { tool: "google_docs_create", ok: true },
      { tool: "search_kb", ok: true },
    ]);
    expect(result.plan_success_criteria).toBe("doc saved, 5+ topics");
    expect(result.served_desires).toEqual(["desire:serve"]);
    expect(result.followed_tactics).toEqual([]);
  });

  it("empty patterns → max surprise (bootstrap signal)", async () => {
    // No patterns means no world model — maximum uncertainty, not minimum
    // surprise. σ=1 makes this a high-salience experience that reflect can
    // use to bootstrap desires from principles.
    const result = await evaluateAction(K, ledger, {}, {}, config);

    expect(result.sigma).toBe(1);
    expect(result.alpha).toEqual({});
    expect(result.salience).toBe(1);
    expect(result.eval_method).toBe("pipeline");
    expect(callInference).not.toHaveBeenCalled();
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("keeps max surprise with no patterns but still evaluates desire alignment", async () => {
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "__plan_success__",
          label: "entailment",
          scores: { entailment: 0.8, contradiction: 0.05, neutral: 0.15 },
        },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, {}, config);

    expect(result.eval_method).toBe("pipeline");
    expect(result.sigma).toBe(1);
    expect(result.salience).toBe(1);
    expect(result.alpha["desire:serve"]).toBeCloseTo(0.8);
    expect(result.desire_axis).toBeGreaterThan(0);
    expect(result.pattern_scores).toEqual({});
    expect(callInference).toHaveBeenCalledTimes(1);
    expect(K.callLLM).not.toHaveBeenCalled();
  });

  it("does not assign negative desire affinity when the served step is unmet", async () => {
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "__plan_success__",
          label: "contradiction",
          scores: { entailment: 0.05, contradiction: 0.84, neutral: 0.11 },
        },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, {}, config);

    expect(result.eval_method).toBe("pipeline");
    expect(result.alpha).toEqual({});
    expect(result.desire_axis).toBe(0);
    expect(result.salience).toBe(1);
  });

  it("parses LLM classifier output from response.content", async () => {
    callInference.mockRejectedValue(new Error("Connection refused"));

    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "__plan_success__", direction: "entailment", confidence: 0.9 },
      ]),
    });
    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "pattern:google-docs-accessible", direction: "contradiction", confidence: 0.4 },
      ]),
    });

    const result = await evaluateAction(K, ledger, desires, patterns, config);

    expect(result.eval_method).toBe("llm_fallback");
    expect(result.alpha["desire:serve"]).toBeCloseTo(0.9);
    expect(result.pattern_scores["pattern:google-docs-accessible"].direction).toBe("contradiction");
    expect(K.callLLM).toHaveBeenCalledTimes(2);
  });

  it("threads the provided signal through inference tiers and LLM fallback", async () => {
    const controller = new AbortController();

    callInference
      .mockResolvedValueOnce({
        results: [
          {
            id: "__plan_success__",
            label: "entailment",
            scores: { entailment: 0.88, contradiction: 0.04, neutral: 0.08 },
          },
        ],
      })
      .mockResolvedValueOnce({
        embeddings: [[0.5, 0.3, 0.2]],
      });
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "pattern:google-docs-accessible",
          label: "neutral",
          scores: { entailment: 0.35, contradiction: 0.30, neutral: 0.35 },
        },
      ],
    });

    K.callLLM.mockResolvedValueOnce({
      content: JSON.stringify([
        { id: "pattern:google-docs-accessible", direction: "neutral", confidence: 0.2 },
      ]),
    });

    await evaluateAction(K, ledger, desires, patterns, config, controller.signal);

    expect(callInference).toHaveBeenNthCalledWith(
      1,
      config.url,
      config.secret,
      "/nli",
      expect.any(Object),
      controller.signal,
    );
    expect(callInference).toHaveBeenNthCalledWith(
      2,
      config.url,
      config.secret,
      "/embed",
      expect.any(Object),
      controller.signal,
    );
    expect(callInference).toHaveBeenNthCalledWith(
      3,
      config.url,
      config.secret,
      "/nli",
      expect.any(Object),
      controller.signal,
    );
    expect(K.callLLM).toHaveBeenCalledWith(expect.objectContaining({
      step: "eval_tier3",
      signal: controller.signal,
    }));
  });
});

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
      _embedding: [0.5, 0.3, 0.1],
    },
  };

  const assumptions = {
    "assumption:google-docs-accessible": {
      slug: "google-docs-accessible",
      check: "Google Docs works",
      _embedding: [0.4, 0.2, 0.8],
    },
  };

  const ledger = {
    action_id: "sess_1_cycle_0",
    plan: {
      action: "compile research doc",
      success: "doc saved, 5+ topics",
      relies_on: ["assumption:google-docs-accessible"],
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
    // Tier 1: embedding
    callInference.mockResolvedValueOnce({
      embeddings: [[0.5, 0.3, 0.2]],
    });
    // Tier 2: NLI
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "desire:serve",
          label: "entailment",
          scores: { entailment: 0.85, contradiction: 0.05, neutral: 0.10 },
        },
        {
          id: "assumption:google-docs-accessible",
          label: "entailment",
          scores: { entailment: 0.90, contradiction: 0.02, neutral: 0.08 },
        },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, assumptions, config);

    expect(result.eval_method).toBe("pipeline");
    expect(result.alpha).toHaveProperty("serve");
    expect(result.alpha.serve).toBeGreaterThan(0); // entailment -> positive
    expect(result.assumption_scores).toHaveProperty("google-docs-accessible");
    expect(result.assumption_scores["google-docs-accessible"].direction).toBe("entailment");
    expect(typeof result.sigma).toBe("number");
    expect(typeof result.salience).toBe("number");
    // callInference called twice: /embed, /nli
    expect(callInference).toHaveBeenCalledTimes(2);
    expect(callInference.mock.calls[0][2]).toBe("/embed");
    expect(callInference.mock.calls[1][2]).toBe("/nli");
  });

  it("falls back to LLM when inference unavailable", async () => {
    callInference.mockRejectedValue(new Error("Connection refused"));

    K.callLLM.mockResolvedValueOnce({
      text: JSON.stringify([
        { id: "desire:serve", direction: "entailment", confidence: 0.7 },
        { id: "assumption:google-docs-accessible", direction: "neutral", confidence: 0.5 },
      ]),
    });

    const result = await evaluateAction(K, ledger, desires, assumptions, config);

    expect(result.eval_method).toBe("llm_fallback");
    expect(K.callLLM).toHaveBeenCalledTimes(1);
    expect(result.alpha.serve).toBeCloseTo(0.7);
    expect(result.assumption_scores["google-docs-accessible"].direction).toBe("neutral");
  });

  it("sends ambiguous NLI pairs to LLM Tier 3", async () => {
    // Tier 1: embedding
    callInference.mockResolvedValueOnce({
      embeddings: [[0.5, 0.3, 0.2]],
    });
    // Tier 2: NLI — desire is clear, assumption is ambiguous
    callInference.mockResolvedValueOnce({
      results: [
        {
          id: "desire:serve",
          label: "entailment",
          scores: { entailment: 0.85, contradiction: 0.05, neutral: 0.10 },
        },
        {
          id: "assumption:google-docs-accessible",
          label: "neutral",
          scores: { entailment: 0.35, contradiction: 0.30, neutral: 0.35 },
        },
      ],
    });
    // Tier 3: LLM for ambiguous pair
    K.callLLM.mockResolvedValueOnce({
      text: JSON.stringify([
        { id: "assumption:google-docs-accessible", direction: "entailment", confidence: 0.8 },
      ]),
    });

    const result = await evaluateAction(K, ledger, desires, assumptions, config);

    expect(result.eval_method).toBe("pipeline");
    expect(K.callLLM).toHaveBeenCalledTimes(1);
    // Desire resolved by NLI
    expect(result.alpha.serve).toBeCloseTo(0.85);
    // Assumption resolved by LLM
    expect(result.assumption_scores["google-docs-accessible"].direction).toBe("entailment");
  });

  it("returns tool_outcomes and candidate_check_ids", async () => {
    callInference.mockResolvedValueOnce({ embeddings: [[0.5, 0.3, 0.2]] });
    callInference.mockResolvedValueOnce({
      results: [
        { id: "desire:serve", label: "neutral", scores: { entailment: 0.1, contradiction: 0.1, neutral: 0.8 } },
        { id: "assumption:google-docs-accessible", label: "entailment", scores: { entailment: 0.9, contradiction: 0.01, neutral: 0.09 } },
      ],
    });

    const result = await evaluateAction(K, ledger, desires, assumptions, config);

    expect(result.tool_outcomes).toEqual([
      { tool: "google_docs_create", ok: true },
      { tool: "search_kb", ok: true },
    ]);
    expect(result.candidate_check_ids).toContain("google-docs-accessible");
    expect(result.plan_success_criteria).toBe("doc saved, 5+ topics");
    expect(result.assumptions_relied_on).toEqual(["assumption:google-docs-accessible"]);
  });

  it("empty assumptions → max surprise (bootstrap signal)", async () => {
    // No assumptions means no world model — maximum uncertainty, not minimum
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
});

import { describe, it, expect } from "vitest";
import { evaluateAction } from "../eval.js";

describe("evaluateAction (stub)", () => {
  const desires = {
    "desire:serve": { slug: "serve", direction: "approach", description: "Serve seekers" },
    "desire:conserve": { slug: "conserve", direction: "avoidance", description: "Conserve resources" },
  };

  const assumptions = {
    "assumption:google-docs-accessible": { slug: "google-docs-accessible", check: "Google Docs works" },
    "assumption:slack-working": { slug: "slack-working", check: "Slack is up" },
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

  it("returns typed zeros with stub eval_method", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.sigma).toBe(0);
    expect(result.alpha).toEqual({});
    expect(result.salience).toBe(0);
    expect(result.eval_method).toBe("stub");
  });

  it("extracts tool outcomes from ledger", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.tool_outcomes).toEqual([
      { tool: "google_docs_create", ok: true },
      { tool: "search_kb", ok: true },
    ]);
  });

  it("passes through plan success criteria", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.plan_success_criteria).toBe("doc saved, 5+ topics");
  });

  it("passes through assumptions relied on", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.assumptions_relied_on).toEqual(["assumption:google-docs-accessible"]);
  });

  it("builds candidate_check_ids from assumption snapshot", () => {
    const result = evaluateAction(ledger, desires, assumptions);
    expect(result.candidate_check_ids).toContain("google-docs-accessible");
    expect(result.candidate_check_ids).toContain("slack-working");
    expect(result.candidate_check_ids).toHaveLength(2);
  });

  it("handles empty tool calls", () => {
    const emptyLedger = { ...ledger, tool_calls: [], final_text: "nothing happened" };
    const result = evaluateAction(emptyLedger, desires, assumptions);
    expect(result.tool_outcomes).toEqual([]);
    expect(result.sigma).toBe(0);
  });

  it("handles empty assumptions", () => {
    const result = evaluateAction(ledger, desires, {});
    expect(result.candidate_check_ids).toEqual([]);
  });
});

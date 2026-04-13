import { describe, expect, it } from "vitest";

import {
  buildAuthorityAuthorPrompt,
  buildAuthorityChallengePrompt,
  buildAuthorityOverview,
  buildAuthorityReviewPrompt,
  buildAuthorityRevisePrompt,
  looksLikeAuthorityChallengePayload,
  looksLikeAuthorityReviewPayload,
  parseAuthorityJsonLoose,
} from "../lib/authority-review/harness.js";

describe("authority-review harness helpers", () => {
  it("renders an authority overview with manifest entries", () => {
    const overview = buildAuthorityOverview(
      { question: "Does the boundary model need to change?", notes: ["Check authority-policy first."] },
      [{ kind: "code", relative_path: "context/files/repo/authority-policy.js", source_path: "/tmp/authority-policy.js" }],
    );
    expect(overview).toContain("Does the boundary model need to change?");
    expect(overview).toContain("Check authority-policy first.");
    expect(overview).toContain("context/files/repo/authority-policy.js");
  });

  it("builds authority prompts with the expected context framing", () => {
    expect(buildAuthorityReviewPrompt("Base review prompt")).toContain("proto-DR-3 authority review harness");
    expect(buildAuthorityChallengePrompt("Base challenge", "/tmp/review.json", "/tmp/context/manifest.json")).toContain("/tmp/review.json");
    expect(buildAuthorityRevisePrompt("Base revise", "/tmp/review.json", "/tmp/challenge.json", "/tmp/context/manifest.json")).toContain("/tmp/challenge.json");
    expect(buildAuthorityAuthorPrompt("Base author", "/tmp/review.json")).toContain("/tmp/review.json");
  });

  it("parses direct and fenced authority JSON payloads loosely", () => {
    expect(parseAuthorityJsonLoose("{\"review_role\":\"authority_review\"}").payload).toEqual({ review_role: "authority_review" });
    expect(parseAuthorityJsonLoose("```json\n{\"review_role\":\"authority_review_adversarial\"}\n```").payload).toEqual({ review_role: "authority_review_adversarial" });
  });

  it("recognizes valid authority review and adversarial payload shapes", () => {
    expect(looksLikeAuthorityReviewPayload({
      review_role: "authority_review",
      question: "Q",
      hypothesis: "H",
      root_constraint: "R",
      why_userspace_review_cannot_fix_it: "U",
      authority_effect: "authority_narrowing",
      required_invariant_checks: [],
      evidence: [],
      proposed_changes: [],
      migration_plan: [],
      validation: {},
      promotion_recommendation: "stageable",
      reasons_not_to_change: [],
      confidence: 0.8,
    })).toBe(true);

    expect(looksLikeAuthorityChallengePayload({
      review_role: "authority_review_adversarial",
      review_result_path: "/tmp/review.json",
      verdict: "revise",
      summary: "Needs one change.",
      agreements: [],
      major_concerns: [],
      required_changes: [],
      reasons_not_to_change: [],
      confidence: 0.7,
    })).toBe(true);
  });
});

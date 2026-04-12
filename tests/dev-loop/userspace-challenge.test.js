import { describe, expect, it } from "vitest";

import {
  extractNormalizedChallengePayload,
  normalizeChallengePayload,
} from "../../scripts/state-lab-userspace-challenge.mjs";
import { buildPrompt, looksLikeUserspaceReviewPayload } from "../../scripts/state-lab-userspace-review-revise.mjs";

describe("userspace challenge normalization", () => {
  it("accepts a valid adversarial review payload", () => {
    const payload = normalizeChallengePayload({
      review_role: "userspace_review_adversarial",
      review_result_path: "/tmp/review.json",
      verdict: "revise",
      summary: "Needs one structural correction.",
      agreements: ["The root symptom is real."],
      major_concerns: ["The proposed fix adds too much structure."],
      required_changes: ["Prefer a representational fix inside carry_forward."],
      reasons_not_to_change: ["Do not revert the prompt blindly."],
      confidence: 0.82,
    });

    expect(payload).toMatchObject({
      review_role: "userspace_review_adversarial",
      verdict: "revise",
      confidence: 0.82,
    });
  });

  it("rejects malformed adversarial payloads", () => {
    expect(normalizeChallengePayload({
      review_role: "userspace_review_adversarial",
      review_result_path: "/tmp/review.json",
      verdict: "maybe",
      summary: "x",
      agreements: [],
      major_concerns: [],
      required_changes: [],
      reasons_not_to_change: [],
      confidence: 0.4,
    })).toBeNull();
  });

  it("extracts the valid adversarial payload from a Claude result with earlier fenced examples", () => {
    const raw = JSON.stringify({
      type: "result",
      session_id: "sess_1",
      total_cost_usd: 0.12,
      usage: { output_tokens: 10 },
      stop_reason: "end_turn",
      duration_ms: 1000,
      result: [
        "Preliminary reasoning.",
        "```json",
        "{",
        '  "id": "session_13:cf1",',
        '  "item": "Wait for patron",',
        '  // invalid example payload',
        "}",
        "```",
        "Now the actual adversarial review follows.",
        "```json",
        JSON.stringify({
          review_role: "userspace_review_adversarial",
          review_result_path: "/tmp/review.json",
          verdict: "revise",
          summary: "Needs one structural correction.",
          agreements: ["The root symptom is real."],
          major_concerns: ["The proposed fix skips a prerequisite."],
          required_changes: ["Populate the blocked state more reliably."],
          reasons_not_to_change: ["Do not patch this with more prompt prose."],
          confidence: 0.82,
        }, null, 2),
        "```",
      ].join("\n"),
    });

    const parsed = extractNormalizedChallengePayload(raw);
    expect(parsed.payload).toMatchObject({
      review_role: "userspace_review_adversarial",
      verdict: "revise",
      confidence: 0.82,
    });
    expect(parsed.meta).toMatchObject({
      session_id: "sess_1",
      total_cost_usd: 0.12,
    });
  });
});

describe("userspace review revision payload shape", () => {
  it("recognizes a complete userspace_review payload", () => {
    expect(looksLikeUserspaceReviewPayload({
      review_role: "userspace_review",
      question: "What is wrong?",
      hypothesis: "Carry-forward lacks anchors.",
      root_constraint: "Structured references live in prose.",
      why_operational_review_cannot_fix_it: "It can only observe the divergence.",
      evidence: [{ path: "context/files/x", kind: "trace", finding: "x" }],
      proposed_changes: [{ kind: "design_change", summary: "Add anchors", target_files: ["reflect.js"], rationale: "x" }],
      validation: { static_commands: [], success_signals: [], continuation: { enabled: false, max_sessions: 3, max_cash_cost: 0.5 } },
      limits: { max_wall_time_minutes: 20 },
      reasons_not_to_change: ["Don't add more than needed."],
      confidence: 0.8,
    })).toBe(true);
  });

  it("buildPrompt explicitly asks for the inner userspace_review payload object", () => {
    const prompt = buildPrompt(
      "Base revise prompt",
      "/tmp/review.json",
      "/tmp/challenge.json",
      "/tmp/context/manifest.json",
    );

    expect(prompt).toContain("Return only the inner `userspace_review` payload object");
  });
});

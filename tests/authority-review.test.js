import { describe, expect, it } from "vitest";

import {
  buildAuthorityInvariantCommands,
  classifyAuthorityReviewPlan,
  collectAuthorityCandidateTargets,
  mergeAuthorityValidation,
} from "../authority-review.js";

describe("authority-review helpers", () => {
  it("collects authority candidate targets from policy and kernel changes", () => {
    const targets = collectAuthorityCandidateTargets([
      { type: "kv_put", key: "kernel:write_policy", value_json: "{}" },
      { type: "code_patch", target: "kernel:source:authority-policy.js", old_string: "a", new_string: "b" },
      { type: "code_patch", target: "hook:session:code", old_string: "a", new_string: "b" },
    ]);

    expect(targets).toEqual([
      { type: "kv_put", target: "kernel:write_policy" },
      { type: "code_patch", target: "kernel:source:authority-policy.js" },
    ]);
  });

  it("rejects missing authority_effect when authority surfaces change", () => {
    const result = classifyAuthorityReviewPlan({
      reviewPayload: { review_role: "authority_review" },
      candidateChanges: [
        { type: "kv_put", key: "kernel:write_policy", value_json: "{}" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("authority_effect_missing_or_invalid");
  });

  it("accepts declared authority narrowing on authority changes", () => {
    const result = classifyAuthorityReviewPlan({
      reviewPayload: { authority_effect: "authority_narrowing" },
      candidateChanges: [
        { type: "kv_patch", key: "kernel:key_tiers", old_string: "a", new_string: "b" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.authority_effect).toBe("authority_narrowing");
  });

  it("merges invariant commands ahead of author-provided validation", () => {
    const merged = mergeAuthorityValidation({
      static_commands: ["npm test -- tests/governor.test.js"],
      continuation: { enabled: false, max_sessions: 0, max_cash_cost: 0 },
    });

    expect(merged.static_commands).toEqual([
      ...buildAuthorityInvariantCommands(),
      "npm test -- tests/governor.test.js",
    ]);
  });
});

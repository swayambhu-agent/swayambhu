import { describe, expect, it } from "vitest";

import { resolveBaselineSummary } from "../scripts/deployment-review-probe.mjs";

describe("deployment-review probe helpers", () => {
  it("prefers baseline summary preserved in probation state", () => {
    const probationState = {
      source_baseline_summary: {
        meaningful_action_sessions: 7,
        no_action_only_sessions: 12,
      },
    };
    const labResult = {
      comparison_summary: {
        baseline: {
          meaningful_action_sessions: 3,
        },
      },
    };

    expect(resolveBaselineSummary(probationState, labResult)).toEqual({
      meaningful_action_sessions: 7,
      no_action_only_sessions: 12,
    });
  });

  it("falls back to lab comparison baseline when probation state has none", () => {
    const labResult = {
      comparison_summary: {
        baseline: {
          meaningful_action_sessions: 5,
          meta_policy_notes_unique_total: 1,
        },
      },
    };

    expect(resolveBaselineSummary(null, labResult)).toEqual({
      meaningful_action_sessions: 5,
      meta_policy_notes_unique_total: 1,
    });
  });
});

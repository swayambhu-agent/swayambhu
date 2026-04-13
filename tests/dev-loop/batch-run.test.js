import { describe, expect, it } from "vitest";

import {
  parseArgs,
  summarizeClassification,
  summarizeProactivity,
} from "../../lib/operator/dev-loop/batch-run.js";

describe("dev-loop batch-run helpers", () => {
  it("parses batch-run args", () => {
    const args = parseArgs([
      "--cycles", "3",
      "--label", "demo",
      "--base-dir", "/tmp/demo",
      "--no-cold-start",
      "--email-progress",
      "--email-every", "2",
    ]);

    expect(args.cycles).toBe(3);
    expect(args.label).toBe("demo");
    expect(args.baseDir).toBe("/tmp/demo");
    expect(args.noColdStart).toBe(true);
    expect(args.emailProgress).toBe(true);
    expect(args.emailEvery).toBe(2);
  });

  it("summarizes challenge classification buckets", () => {
    const counts = summarizeClassification({
      classification: {
        meta_policy_notes_total: 2,
        meta_policy_note_refs: ["note:a", "note:b"],
        issues: [
          { summary: "reflection/review instead of act-time" },
          { summary: "Carry-forward item migrated into act path" },
          { summary: "observation appears to contain narrative or internal reasoning" },
          { summary: "leak internal runtime/cognitive vocabulary" },
        ],
      },
    });

    expect(counts).toMatchObject({
      total: 4,
      tactic_smuggling: 1,
      carry_forward_smuggling: 1,
      observation_contamination: 1,
      outbound_internal_state_leakage: 1,
      meta_policy_notes_total: 2,
      meta_policy_note_refs: ["note:a", "note:b"],
    });
  });

  it("summarizes session proactivity", () => {
    const summary = summarizeProactivity({
      actions: {
        a1: {
          session_id: "x1",
          kind: "tool_action",
          tool_calls: [{ tool: "computer" }, { tool: "kv_query" }],
          exercised_identifications: ["identification:project"],
          plan: { action: "request_message" },
        },
        a2: {
          session_id: "x2",
          kind: "no_action",
        },
      },
      experiences: {
        e1: { session_id: "x1" },
      },
      identifications: {
        "identification:working-body": {},
        "identification:project": {},
      },
      last_reflect: { note: "fano" },
    }, "x1");

    expect(summary).toMatchObject({
      session_has_meaningful_action: true,
      session_meaningful_action_count: 1,
      session_no_action_only: false,
      session_tool_call_count: 2,
      request_message_count: 1,
      total_identification_count: 2,
      non_seed_identification_count: 1,
      touched_fano: true,
    });
    expect(summary.session_unique_tools).toEqual(["computer", "kv_query"]);
    expect(summary.exercised_identifications).toEqual(["identification:project"]);
  });
});

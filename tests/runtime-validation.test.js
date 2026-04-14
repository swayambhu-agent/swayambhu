import { describe, expect, it } from "vitest";

import { getRegisteredRuntimeSchemas, validateWithSchema } from "../lib/runtime-validation.js";

describe("runtime validation", () => {
  it("registers the shared runtime schemas used by the KV boundary", () => {
    expect(getRegisteredRuntimeSchemas()).toEqual([
      "kv-operation",
      "kv-operation-batch",
      "experience-record",
    ]);
  });

  it("accepts a canonical KV operation", () => {
    const result = validateWithSchema("kv-operation", {
      op: "put",
      key: "workspace:cyclic-cosmology",
      value: { status: "in_progress" },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a non-canonical KV operation shape", () => {
    const result = validateWithSchema("kv-operation", {
      operation: "set",
      key: "workspace:cyclic-cosmology",
      value: { status: "in_progress" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("kv-operation");
  });

  it("rejects KV-op batches that exceed the hard size cap", () => {
    const batch = Array.from({ length: 51 }, (_, index) => ({
      op: "delete",
      key: `workspace:stale:${index}`,
    }));

    const result = validateWithSchema("kv-operation-batch", batch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kv-operation-batch");
  });

  it("accepts a valid experience record", () => {
    const result = validateWithSchema("experience-record", {
      timestamp: "2026-04-14T10:00:00.000Z",
      action_ref: "action:a_1",
      session_id: "x_test",
      cycle: 0,
      observation: "The cyclic cosmology follow-up completed successfully.",
      desire_alignment: {
        top_positive: [],
        top_negative: [],
        affinity_magnitude: 0.5,
      },
      pattern_delta: {
        sigma: 0.1,
        scores: [],
      },
      salience: 0.6,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an experience record missing required fields", () => {
    const result = validateWithSchema("experience-record", {
      timestamp: "2026-04-14T10:00:00.000Z",
      action_ref: "action:a_1",
      session_id: "x_test",
      cycle: 0,
      observation: "Missing salience and pattern delta.",
      desire_alignment: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("experience-record");
  });
});

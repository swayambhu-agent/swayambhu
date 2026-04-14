import { describe, expect, it } from "vitest";

import { makeMockK } from "./helpers/mock-kernel.js";
import {
  MAX_MODEL_KV_OPS_PER_BATCH,
  applyModelKvOperations,
  classifyKvOperationSchemaError,
  prepareModelKvOperations,
} from "../lib/kv-operation-boundary.js";

describe("kv operation boundary", () => {
  it("rejects alias drift from operation/set instead of canonical op/put", async () => {
    const result = await prepareModelKvOperations([
      {
        operation: "set",
        key: "workspace:cyclic-cosmology",
        value: { status: "in_progress" },
      },
    ], { source: "reflect" });

    expect(result.batchRejected).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].error).toContain("kv-operation");
    expect(result.rejected[0].diagnostic_hint).toContain("Expected canonical field 'op'");
    expect(result.rejected[0].diagnostic_hint).toContain("Unsupported op 'set'");
  });

  it("classifies trivial alias drift for diagnostics only", () => {
    expect(classifyKvOperationSchemaError({
      operation: "set",
      key: "workspace:test",
      value: "x",
    })).toContain("canonical");
  });

  it("rejects unknown sources closed", async () => {
    const result = await prepareModelKvOperations([], { source: "not-a-real-source" });

    expect(result.batchRejected).toBe(true);
    expect(result.rejected[0].error).toContain("Unknown model KV-op source");
  });

  it("rejects field_merge from deep-reflect in v1", async () => {
    const result = await prepareModelKvOperations([
      {
        op: "field_merge",
        key: "pattern:test",
        fields: { strength: 0.9 },
      },
    ], { source: "deep-reflect" });

    expect(result.batchRejected).toBe(true);
    expect(result.rejected[0].error).toContain('Operation "field_merge" is not allowed for source "deep-reflect"');
  });

  it("rejects invalid experience puts before any write attempt", async () => {
    const K = makeMockK();

    const result = await applyModelKvOperations(K, [
      {
        op: "put",
        key: "experience:bad",
        value: {
          timestamp: "2026-04-14T10:00:00.000Z",
          action_ref: "action:a_1",
          session_id: "x_test",
          cycle: 0,
          observation: "Missing salience and pattern delta.",
          desire_alignment: {},
        },
      },
    ], {
      source: "reflect",
      context: "reflect",
    });

    expect(result.batchRejected).toBe(true);
    expect(result.applied).toBe(0);
    expect(await K.kvGet("experience:bad")).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "kv_operation_schema_rejected",
      source: "reflect",
      stage: "schema",
    }));
  });

  it("rejects the entire batch without partial writes", async () => {
    const K = makeMockK();

    const result = await applyModelKvOperations(K, [
      {
        op: "put",
        key: "workspace:good",
        value: { status: "would_have_been_written" },
      },
      {
        operation: "set",
        key: "workspace:bad",
        value: { status: "bad" },
      },
    ], {
      source: "reflect",
      context: "reflect",
    });

    expect(result.batchRejected).toBe(true);
    expect(result.applied).toBe(0);
    expect(await K.kvGet("workspace:good")).toBeNull();
    expect(await K.kvGet("workspace:bad")).toBeNull();
  });

  it("applies canonical reflect writes successfully", async () => {
    const K = makeMockK();
    await K.kvWriteSafe("action:journal", "old", { unprotected: true });

    const result = await applyModelKvOperations(K, [
      {
        op: "put",
        key: "workspace:cyclic-cosmology",
        value: { status: "in_progress" },
      },
      {
        op: "patch",
        key: "action:journal",
        old_string: "old",
        new_string: "new",
      },
    ], {
      source: "reflect",
      context: "reflect",
    });

    expect(result.batchRejected).toBe(false);
    expect(result.applied).toBe(2);
    expect(await K.kvGet("workspace:cyclic-cosmology")).toEqual({ status: "in_progress" });
    expect(await K.kvGet("action:journal")).toBe("new");
  });

  it("allows field_merge on review surfaces", async () => {
    const K = makeMockK({
      "pattern:test": {
        pattern: "Repeated issue",
        strength: 0.2,
      },
    });

    const result = await applyModelKvOperations(K, [
      {
        op: "field_merge",
        key: "pattern:test",
        fields: { strength: 0.8 },
      },
    ], {
      source: "userspace-review",
      context: "userspace-review",
    });

    expect(result.batchRejected).toBe(false);
    expect(result.applied).toBe(1);
    expect(await K.kvGet("pattern:test")).toEqual({
      pattern: "Repeated issue",
      strength: 0.8,
    });
  });

  it("rejects batches larger than the hard maximum", async () => {
    const batch = Array.from({ length: MAX_MODEL_KV_OPS_PER_BATCH + 1 }, (_, index) => ({
      op: "delete",
      key: `workspace:old:${index}`,
    }));

    const result = await prepareModelKvOperations(batch, { source: "reflect" });
    expect(result.batchRejected).toBe(true);
    expect(result.rejected[0].error).toContain("kv-operation-batch");
  });
});

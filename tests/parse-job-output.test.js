import { describe, it, expect } from "vitest";
import { parseJobOutput } from "../lib/parse-job-output.js";

describe("parseJobOutput", () => {
  it("returns null payload for empty input", () => {
    expect(parseJobOutput(null)).toEqual({ payload: null, meta: null });
    expect(parseJobOutput("")).toEqual({ payload: null, meta: null });
  });

  it("returns null payload for invalid JSON", () => {
    expect(parseJobOutput("not json")).toEqual({ payload: null, meta: null });
  });

  it("passes through direct payload (no envelope)", () => {
    const direct = { reflection: "test", kv_operations: [], note_to_future_self: "x" };
    const { payload, meta } = parseJobOutput(JSON.stringify(direct));
    expect(payload).toEqual(direct);
    expect(meta).toBeNull();
  });

  it("unwraps Claude CLI envelope with plain JSON result", () => {
    const inner = { reflection: "deep thought", kv_operations: [{ key: "pattern:x", value: { pattern: "y", strength: 0.3 } }] };
    const envelope = {
      type: "result",
      result: JSON.stringify(inner),
      session_id: "abc-123",
      total_cost_usd: 0.29,
      usage: { input_tokens: 100, output_tokens: 200 },
      stop_reason: "end_turn",
      duration_ms: 5000,
    };

    const { payload, meta } = parseJobOutput(JSON.stringify(envelope));
    expect(payload).toEqual(inner);
    expect(meta.session_id).toBe("abc-123");
    expect(meta.total_cost_usd).toBe(0.29);
    expect(meta.usage.input_tokens).toBe(100);
    expect(meta.stop_reason).toBe("end_turn");
    expect(meta.duration_ms).toBe(5000);
  });

  it("unwraps Claude CLI envelope with fenced JSON result", () => {
    const inner = { reflection: "fenced", kv_operations: [] };
    const envelope = {
      type: "result",
      result: "Here is the output:\n\n```json\n" + JSON.stringify(inner, null, 2) + "\n```",
      session_id: "def-456",
      total_cost_usd: 0.15,
    };

    const { payload, meta } = parseJobOutput(JSON.stringify(envelope));
    expect(payload).toEqual(inner);
    expect(meta.session_id).toBe("def-456");
  });

  it("unwraps Claude CLI envelope with mixed text and braces", () => {
    const inner = { reflection: "found", kv_operations: [] };
    const envelope = {
      type: "result",
      result: "Some preamble text\n\n" + JSON.stringify(inner) + "\n\nSome trailing text",
    };

    const { payload, meta } = parseJobOutput(JSON.stringify(envelope));
    expect(payload).toEqual(inner);
  });

  it("returns null payload when envelope result has no JSON", () => {
    const envelope = {
      type: "result",
      result: "I couldn't generate the output because of an error.",
    };

    const { payload, meta } = parseJobOutput(JSON.stringify(envelope));
    expect(payload).toBeNull();
    expect(meta).toBeTruthy();
  });

  it("handles unknown JSON shape as pass-through", () => {
    const weird = { something: "else", data: [1, 2, 3] };
    const { payload, meta } = parseJobOutput(JSON.stringify(weird));
    expect(payload).toEqual(weird);
    expect(meta).toBeNull();
  });

  it("handles real Claude CLI output shape", () => {
    // This mirrors the actual output we saw from the DR job
    const inner = {
      kv_operations: [{ key: "pattern:bootstrap:x", value: { pattern: "test", strength: 0.3 } }],
      reflection: "Bootstrap deep-reflect",
      note_to_future_self: "Watch patterns",
      next_reflect: { after_sessions: 5, after_days: 3 },
    };
    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 67594,
      num_turns: 8,
      result: "```json\n" + JSON.stringify(inner, null, 2) + "\n```",
      stop_reason: "end_turn",
      session_id: "40c76dc1-39ae-4e32-9180-a0931adeb877",
      total_cost_usd: 0.2929425,
      usage: { input_tokens: 8, output_tokens: 2497 },
    };

    const { payload, meta } = parseJobOutput(JSON.stringify(envelope));
    expect(payload.reflection).toBe("Bootstrap deep-reflect");
    expect(payload.kv_operations).toHaveLength(1);
    expect(payload.next_reflect.after_sessions).toBe(5);
    expect(meta.total_cost_usd).toBeCloseTo(0.293);
    expect(meta.session_id).toBe("40c76dc1-39ae-4e32-9180-a0931adeb877");
    expect(meta.duration_ms).toBe(67594);
  });
});

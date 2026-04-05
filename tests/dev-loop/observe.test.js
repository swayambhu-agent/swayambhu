import { describe, it, expect } from "vitest";
import {
  detectCompletion,
  chooseStrategy,
} from "../../scripts/dev-loop/observe.mjs";

// ── detectCompletion ────────────────────────────────────────

describe("detectCompletion", () => {
  it("returns true when counter increments", () => {
    expect(detectCompletion(5, 6)).toBe(true);
    expect(detectCompletion(0, 1)).toBe(true);
    expect(detectCompletion(10, 15)).toBe(true);
  });

  it("returns false when counter unchanged", () => {
    expect(detectCompletion(5, 5)).toBe(false);
    expect(detectCompletion(0, 0)).toBe(false);
  });
});

// ── chooseStrategy ──────────────────────────────────────────

describe("chooseStrategy", () => {
  it("defaults to accumulate", () => {
    const result = chooseStrategy({
      probes: [],
      cycle: 3,
      codeChanged: false,
    });
    expect(result.type).toBe("accumulate");
    expect(result.setup).toEqual([
      "curl -sf -X POST http://localhost:8787/__clear-schedule",
    ]);
    expect(result.trigger).toBe("http://localhost:8787/__scheduled");
  });

  it("chooses cold_start on cycle 0", () => {
    const result = chooseStrategy({
      probes: [],
      cycle: 0,
      codeChanged: false,
    });
    expect(result.type).toBe("cold_start");
    expect(result.setup).toBe("cold_start_sequence");
    expect(result.trigger).toBe("http://localhost:8787/__scheduled");
  });

  it("chooses cold_start when codeChanged", () => {
    const result = chooseStrategy({
      probes: [],
      cycle: 5,
      codeChanged: true,
    });
    expect(result.type).toBe("cold_start");
    expect(result.setup).toBe("cold_start_sequence");
  });

  it("chooses cold_start when coldStart flag is set", () => {
    const result = chooseStrategy({
      probes: [],
      cycle: 5,
      codeChanged: false,
      coldStart: true,
    });
    expect(result.type).toBe("cold_start");
    expect(result.setup).toBe("cold_start_sequence");
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  detectCompletion,
  chooseStrategy,
  pollForNewSession,
} from "../../lib/operator/dev-loop/observe.js";
// Pure observe logic now lives in lib/operator/dev-loop/observe.js.

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
    expect(result.setup).toEqual([]);
    expect(result.trigger.url).toMatch(/^http:\/\/localhost:\d+\/__wake$/);
    expect(result.trigger.method).toBe("POST");
    expect(result.trigger.body).toEqual({
      actor: "dev_loop",
      context: { intent: "probe", debug_mode: true },
    });
  });

  it("chooses cold_start on cycle 0", () => {
    const result = chooseStrategy({
      probes: [],
      cycle: 0,
      codeChanged: false,
    });
    expect(result.type).toBe("cold_start");
    expect(result.setup).toBe("cold_start_sequence");
    expect(result.trigger.url).toMatch(/^http:\/\/localhost:\d+\/__wake$/);
    expect(result.trigger.method).toBe("POST");
    expect(result.trigger.body).toEqual({
      actor: "dev_loop",
      context: { intent: "probe", debug_mode: true },
    });
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

describe("pollForNewSession", () => {
  it("falls back to kernel:last_executions when session cache does not advance", async () => {
    vi.useFakeTimers();
    const restartServicesFn = vi.fn(async () => {});
    const readSessionIdsFn = vi.fn(async () => ["sess-1"]);
    const readLastExecutionsFn = vi.fn()
      .mockResolvedValueOnce([{ id: "sess-1", outcome: "clean" }])
      .mockResolvedValueOnce([{ id: "sess-1", outcome: "clean" }])
      .mockResolvedValueOnce([{ id: "exec-2", outcome: "running" }])
      .mockResolvedValueOnce([{ id: "exec-2", outcome: "clean" }]);
    const log = vi.fn();

    const promise = pollForNewSession(["sess-1"], 20_000, {
      readSessionIdsFn,
      readLastExecutionsFn,
      restartServicesFn,
      stdout: { write: vi.fn() },
      log,
      sleepFn: vi.fn(async () => {}),
    });

    await expect(promise).resolves.toBe("exec-2");
    expect(restartServicesFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[OBSERVE] Execution started without session cache entry: exec-2");
    expect(log).toHaveBeenCalledWith("[OBSERVE] Session completed: exec-2 (outcome: clean)");
    vi.useRealTimers();
  });

  it("tolerates transient dashboard read failures while polling for completion", async () => {
    vi.useFakeTimers();
    const restartServicesFn = vi.fn(async () => {});
    const readSessionIdsFn = vi.fn()
      .mockResolvedValueOnce(["sess-1", "sess-2"])
      .mockResolvedValue(["sess-1", "sess-2"]);
    const readLastExecutionsFn = vi.fn()
      .mockResolvedValueOnce([{ id: "sess-1", outcome: "clean" }])
      .mockRejectedValueOnce(new Error("HTTP 500 from /kv/multi"))
      .mockResolvedValueOnce([{ id: "sess-1", outcome: "clean" }, { id: "sess-2", outcome: "clean" }]);
    const log = vi.fn();

    const promise = pollForNewSession(["sess-1"], 20_000, {
      readSessionIdsFn,
      readLastExecutionsFn,
      restartServicesFn,
      stdout: { write: vi.fn() },
      log,
      sleepFn: vi.fn(async () => {}),
    });

    await expect(promise).resolves.toBe("sess-2");
    expect(restartServicesFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[OBSERVE] Session started: sess-2");
    expect(log).toHaveBeenCalledWith("[OBSERVE] kernel:last_executions read failed: HTTP 500 from /kv/multi");
    expect(log).toHaveBeenCalledWith("[OBSERVE] Session completed: sess-2 (outcome: clean)");
    vi.useRealTimers();
  });

  it("accepts a newer completed execution when the started session id is superseded", async () => {
    vi.useFakeTimers();
    const restartServicesFn = vi.fn(async () => {});
    const readSessionIdsFn = vi.fn()
      .mockResolvedValueOnce(["sess-1", "sess-2"])
      .mockResolvedValue(["sess-1", "sess-2"]);
    const readLastExecutionsFn = vi.fn()
      .mockResolvedValueOnce([{ id: "sess-1", outcome: "clean" }])
      .mockResolvedValueOnce([
        { id: "exec-3", outcome: "clean" },
        { id: "sess-1", outcome: "clean" },
      ]);
    const log = vi.fn();

    const promise = pollForNewSession(["sess-1"], 20_000, {
      readSessionIdsFn,
      readLastExecutionsFn,
      restartServicesFn,
      stdout: { write: vi.fn() },
      log,
      sleepFn: vi.fn(async () => {}),
    });

    await expect(promise).resolves.toBe("exec-3");
    expect(restartServicesFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[OBSERVE] Session started: sess-2");
    expect(log).toHaveBeenCalledWith(
      "[OBSERVE] Session sess-2 was superseded by completed execution exec-3 (outcome: clean)",
    );
    vi.useRealTimers();
  });

  it("restarts services before failing when no new session starts", async () => {
    vi.useFakeTimers();
    const restartServicesFn = vi.fn(async () => {});
    const readLastExecutionsFn = vi.fn(async () => []);

    const promise = pollForNewSession(["sess-1"], 10_000, {
      readSessionIdsFn: vi.fn(async () => ["sess-1"]),
      readLastExecutionsFn,
      restartServicesFn,
      stdout: { write: vi.fn() },
      log: vi.fn(),
    });
    const assertion = expect(promise).rejects.toThrow("No new session started within 10s");

    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(restartServicesFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("restarts services before failing when a started session never completes", async () => {
    vi.useFakeTimers();
    const restartServicesFn = vi.fn(async () => {});
    const readSessionIdsFn = vi.fn()
      .mockResolvedValueOnce(["sess-1", "sess-2"])
      .mockResolvedValue(["sess-1", "sess-2"]);
    const readLastExecutionsFn = vi.fn(async () => []);

    const promise = pollForNewSession(["sess-1"], 20_000, {
      readSessionIdsFn,
      readLastExecutionsFn,
      restartServicesFn,
      stdout: { write: vi.fn() },
      log: vi.fn(),
    });
    const assertion = expect(promise).rejects.toThrow("Session sess-2 started but did not complete within 20s");

    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
    expect(restartServicesFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

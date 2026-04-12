import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForRestartBoundary } from "../../scripts/dev-loop/services.mjs";

describe("waitForRestartBoundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns once either managed service drops during restart", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("kernel restarting"))
      .mockResolvedValueOnce({});
    vi.stubGlobal("fetch", fetchMock);

    const promise = waitForRestartBoundary({
      kernelPort: 9001,
      dashboardPort: 9002,
      logPath: "/tmp/service.log",
    }, 5_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("fails if services never drop during the restart window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({}));

    const promise = waitForRestartBoundary({
      kernelPort: 9001,
      dashboardPort: 9002,
      logPath: "/tmp/service.log",
    }, 2_000);
    const assertion = expect(promise).rejects.toThrow("never dropped during restart window");

    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });
});

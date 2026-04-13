import { describe, expect, it } from "vitest";
import { parseTeardownArgs, resolveTeardownTargets } from "../lib/operator/teardown.js";

describe("operator teardown helpers", () => {
  it("parses local and remote scope flags", () => {
    expect(parseTeardownArgs(["--local-only"])).toEqual({ scope: "local" });
    expect(parseTeardownArgs(["--remote-only"])).toEqual({ scope: "remote" });
    expect(parseTeardownArgs(["--scope", "all"])).toEqual({ scope: "all" });
  });

  it("resolves state paths and ports from environment", () => {
    const targets = resolveTeardownTargets({
      root: "/tmp/repo",
      env: {
        SWAYAMBHU_PERSIST_DIR: "/tmp/state",
        SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR: "/tmp/snapshot",
        SWAYAMBHU_KERNEL_PORT: "9001",
      },
      options: {},
    });

    expect(targets.stateDir).toBe("/tmp/state");
    expect(targets.snapshotDir).toBe("/tmp/snapshot");
    expect(targets.ports[0]).toBe(9001);
    expect(targets.ports).toContain(8790);
  });
});

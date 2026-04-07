import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_KERNEL_PORT,
  ACTIVE_UI_PORT,
  applyWorkspaceCandidateChange,
  allocateBranchPorts,
  buildLabBranchName,
  buildStartEnv,
  resolveLabWorkspacePath,
  sanitizeName,
} from "../scripts/state-lab.mjs";

describe("state-lab helpers", () => {
  it("sanitizes valid names and rejects invalid ones", () => {
    expect(sanitizeName("bootstrap-codex.a_b")).toBe("bootstrap-codex.a_b");
    expect(() => sanitizeName("../bad")).toThrow("Invalid name");
  });

  it("allocates the next free port slot across branches", () => {
    const ports = allocateBranchPorts([
      { metadata: { ports: { slot: 0 } } },
      { metadata: { ports: { slot: 2 } } },
    ]);

    expect(ports.slot).toBe(1);
    expect(ports.kernel).toBe(8897);
    expect(ports.dashboard).toBe(8900);
    expect(ports.spa).toBe(9011);
  });

  it("skips slots whose allocated ports would collide with the active-ui port", () => {
    const ports = allocateBranchPorts([
      { metadata: { ports: { slot: 0 } } },
      { metadata: { ports: { slot: 1 } } },
      { metadata: { ports: { slot: 2 } } },
      { metadata: { ports: { slot: 3 } } },
      { metadata: { ports: { slot: 4 } } },
      { metadata: { ports: { slot: 5 } } },
      { metadata: { ports: { slot: 6 } } },
    ]);

    expect(ports.slot).toBe(8);
    expect(ports.spa).toBe(9081);
  });

  it("builds start env from branch metadata", () => {
    const env = buildStartEnv({
      state_dir: "/tmp/state-lab/branches/codex/state",
      pre_trigger_snapshot_dir: "/tmp/state-lab/branches/codex/pre-trigger-snapshot",
      ports: {
        kernel: 8897,
        dashboard: 8900,
        governor: 8901,
        spa: 9011,
        dashboard_inspector: 9340,
        governor_inspector: 9341,
      },
    });

    expect(env).toEqual({
      SWAYAMBHU_PERSIST_DIR: "/tmp/state-lab/branches/codex/state",
      SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR: "/tmp/state-lab/branches/codex/pre-trigger-snapshot",
      SWAYAMBHU_KERNEL_PORT: "8897",
      SWAYAMBHU_DASHBOARD_PORT: "8900",
      SWAYAMBHU_GOVERNOR_PORT: "8901",
      SWAYAMBHU_SPA_PORT: "9011",
      SWAYAMBHU_DASHBOARD_INSPECTOR_PORT: "9340",
      SWAYAMBHU_GOVERNOR_INSPECTOR_PORT: "9341",
      SWAYAMBHU_GOVERNOR_ENABLED: "true",
      SWAYAMBHU_START_ISOLATED: "true",
    });
  });

  it("exposes a fixed active-ui port", () => {
    expect(ACTIVE_UI_PORT).toBe(9071);
  });

  it("exposes a fixed active-kernel port", () => {
    expect(ACTIVE_KERNEL_PORT).toBe(8787);
  });

  it("builds a sanitized lab branch name from the hypothesis path", () => {
    const name = buildLabBranchName("/tmp/My hypothesis.json", new Date("2026-04-07T10:11:12.000Z"));
    expect(name).toBe("lab-My-hypothesis-2026-04-07T10-11-12-000Z");
  });

  it("resolves workspace targets and blocks path escape", async () => {
    const workspace = "/tmp/lab-workspace";
    expect(resolveLabWorkspacePath(workspace, { path: "userspace.js" })).toBe("/tmp/lab-workspace/userspace.js");
    expect(() => resolveLabWorkspacePath(workspace, { path: "../evil.js" })).toThrow("escapes workspace");
  });

  it("applies workspace patch and write candidate changes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "state-lab-test-"));
    try {
      await writeFile(join(workspace, "userspace.js"), "const value = 1;\n", "utf8");
      await applyWorkspaceCandidateChange(workspace, {
        path: "userspace.js",
        old_string: "1",
        new_string: "2",
      });
      expect(await readFile(join(workspace, "userspace.js"), "utf8")).toContain("2");

      await applyWorkspaceCandidateChange(workspace, {
        path: "prompts/custom.txt",
        code: "hello\n",
      });
      expect(await readFile(join(workspace, "prompts/custom.txt"), "utf8")).toBe("hello\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

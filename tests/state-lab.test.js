import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_KERNEL_PORT,
  ACTIVE_UI_PORT,
  allocateBranchPorts,
  buildStartEnv,
  runStaticValidation,
  sanitizeName,
} from "../scripts/state-lab.mjs";
import {
  compareContinuationSummaries,
  getContinuationConfig,
  isInfrastructureContinuationFailure,
  normalizeStaticChecks,
  reconcileComparativeStaticValidation,
  retargetStaticCommandToWorkspace,
  summarizeBatchSummary,
} from "../lib/state-lab/validation.js";
import {
  applyWorkspaceCandidateChange,
  buildLabBranchName,
  loadLabHypothesis,
  overlayWorkspaceFromSourceState,
  resolveLabWorkspacePath,
  shouldCopyWorkspacePath,
} from "../lib/state-lab/workspace.js";
import { getKV, dispose, root as REPO_ROOT } from "../scripts/shared.mjs";

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
      name: "codex",
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
      SWAYAMBHU_RUNTIME_WORKSPACE: "/tmp/state-lab/branches/codex/runtime-workspace",
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

  it("prefers explicit runtime workspace metadata when present", () => {
    const env = buildStartEnv({
      name: "codex",
      state_dir: "/tmp/state-lab/branches/codex/state",
      pre_trigger_snapshot_dir: "/tmp/state-lab/branches/codex/pre-trigger-snapshot",
      runtime_workspace_dir: "/tmp/custom-runtime-workspace",
      ports: {
        kernel: 8897,
        dashboard: 8900,
        governor: 8901,
        spa: 9011,
        dashboard_inspector: 9340,
        governor_inspector: 9341,
      },
    });

    expect(env.SWAYAMBHU_RUNTIME_WORKSPACE).toBe("/tmp/custom-runtime-workspace");
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

  it("skips transient workspace directories at any depth", () => {
    expect(shouldCopyWorkspacePath("/home/swami/swayambhu/repo/userspace.js")).toBe(true);
    expect(shouldCopyWorkspacePath("/home/swami/swayambhu/repo/.wrangler/tmp/bundle-abc")).toBe(false);
    expect(shouldCopyWorkspacePath("/home/swami/swayambhu/repo/dashboard-api/.wrangler/tmp/bundle-abc")).toBe(false);
    expect(shouldCopyWorkspacePath("/home/swami/swayambhu/repo/site/patron/node_modules/react/index.js")).toBe(false);
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

  it("rejects empty old_string workspace patches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "state-lab-empty-patch-"));
    try {
      await writeFile(join(workspace, "userspace.js"), "const value = 1;\n", "utf8");
      await expect(applyWorkspaceCandidateChange(workspace, {
        path: "userspace.js",
        old_string: "",
        new_string: "patched",
      })).rejects.toThrow("old_string must be non-empty");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("overlays branch code-key state into a prepared workspace before lab patches apply", async () => {
    const base = await mkdtemp(join(tmpdir(), "state-lab-overlay-"));
    const stateDir = join(base, "state");
    const workspace = join(base, "workspace");
    try {
      await mkdir(join(workspace, "prompts"), { recursive: true });
      await writeFile(join(workspace, "userspace.js"), "repo userspace\n", "utf8");
      await writeFile(join(workspace, "prompts", "reflect.md"), "repo reflect\n", "utf8");
      await mkdir(stateDir, { recursive: true });

      const kv = await getKV({ stateDir });
      try {
        await kv.put("kernel:source_map", JSON.stringify({
          userspace: "hook:session:code",
        }), { metadata: { format: "json" } });
        await kv.put("hook:session:code", "branch userspace\n", { metadata: { format: "text" } });
        await kv.put("prompt:reflect", "branch reflect\n", { metadata: { format: "text" } });
      } finally {
        await dispose();
      }

      await overlayWorkspaceFromSourceState({ workspaceDir: workspace, stateDir });

      expect(await readFile(join(workspace, "userspace.js"), "utf8")).toBe("branch userspace\n");
      expect(await readFile(join(workspace, "prompts", "reflect.md"), "utf8")).toBe("branch reflect\n");

      await applyWorkspaceCandidateChange(workspace, {
        target: "hook:session:code",
        old_string: "branch userspace",
        new_string: "patched userspace",
      });
      expect(await readFile(join(workspace, "userspace.js"), "utf8")).toContain("patched userspace");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects prompt overlay paths that escape the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "state-lab-overlay-fetch-"));
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const text = String(url);
      if (text.includes(`/kv/${encodeURIComponent("kernel:source_map")}`)) {
        return new Response(JSON.stringify({ value: { evil_prompt: "prompt:../escape" } }), { status: 200 });
      }
      if (text.includes(`/kv/${encodeURIComponent("prompt:../escape")}`)) {
        return new Response(JSON.stringify({ value: "escape\n" }), { status: 200 });
      }
      if (text.includes("/kv?prefix=")) {
        return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: null }), { status: 200 });
    };

    try {
      await expect(overlayWorkspaceFromSourceState({
        workspaceDir: workspace,
        stateDir: join(workspace, "unused-state"),
        dashboardPort: 9999,
      })).rejects.toThrow("Overlay prompt path escapes prompts dir");
    } finally {
      global.fetch = originalFetch;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves review note provenance when loading a lab hypothesis", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "state-lab-hypothesis-"));
    const hypothesisPath = join(workspace, "hypothesis.json");
    try {
      await writeFile(hypothesisPath, JSON.stringify({
        review_note_key: "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly",
        hypothesis: "Carry blocked state structurally.",
        candidate_changes: [{ type: "kv_patch", key: "prompt:reflect" }],
        validation: { continuation: { enabled: false } },
        limits: { max_wall_time_minutes: 20 },
      }, null, 2), "utf8");

      const loaded = await loadLabHypothesis(hypothesisPath);
      expect(loaded.payload.review_note_key).toBe(
        "review_note:userspace_review:x_wait:d1:000:waiting-state-derived-too-narrowly",
      );
      expect(loaded.payload.hypothesis).toBe("Carry blocked state structurally.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes continuation config with safe defaults", () => {
    expect(getContinuationConfig({})).toEqual({
      enabled: false,
      maxSessions: 1,
      maxCashCost: null,
    });
    expect(getContinuationConfig({
      continuation: {
        enabled: true,
        max_sessions: 5,
        max_cash_cost: 0.75,
      },
    })).toEqual({
      enabled: true,
      maxSessions: 5,
      maxCashCost: 0.75,
    });
    expect(getContinuationConfig({
      continuation: {
        enabled: true,
        max_sessions: "invalid",
        max_cash_cost: "wat",
      },
    })).toEqual({
      enabled: true,
      maxSessions: 1,
      maxCashCost: null,
    });
  });

  it("classifies service-start failures as infrastructure continuation failures", () => {
    expect(isInfrastructureContinuationFailure({
      error: "Services failed to start in 120s (kernel 9457, dashboard 9460). See /tmp/service-start.log",
    })).toBe(true);
    expect(isInfrastructureContinuationFailure({
      error: "candidate regression observed",
      stderr_tail: "assertion failed in userspace.test.js",
    })).toBe(false);
  });

  it("normalizes comparative static checks and keeps static_commands as pass/pass defaults", () => {
    expect(normalizeStaticChecks({
      static_commands: ["npm test -- tests/userspace.test.js"],
    })).toEqual([
      {
        command: "npm test -- tests/userspace.test.js",
        label: null,
        source: "static_command",
        expect: {
          baseline: "pass",
          candidate: "pass",
        },
      },
    ]);

    expect(normalizeStaticChecks({
      static_checks: [
        {
          command: "npx vitest run tests/userspace.test.js -t waiting-state",
          label: "waiting-state regression",
          expect: {
            baseline: "fail",
            candidate: "pass",
          },
        },
      ],
    })).toEqual([
      {
        command: "npx vitest run tests/userspace.test.js -t waiting-state",
        label: "waiting-state regression",
        source: "static_check",
        expect: {
          baseline: "fail",
          candidate: "pass",
        },
      },
    ]);

    expect(normalizeStaticChecks({
      static_commands: ["npm test -- tests/state-lab.test.js"],
      static_checks: [
        {
          command: "npx vitest run tests/userspace.test.js -t waiting-state",
          expect: {
            baseline: "fail",
            candidate: "pass",
          },
        },
      ],
    })).toEqual([
      {
        command: "npm test -- tests/state-lab.test.js",
        label: null,
        source: "static_command",
        expect: {
          baseline: "pass",
          candidate: "pass",
        },
      },
      {
        command: "npx vitest run tests/userspace.test.js -t waiting-state",
        label: null,
        source: "static_check",
        expect: {
          baseline: "fail",
          candidate: "pass",
        },
      },
    ]);
  });

  it("retargets repo-root static commands to the candidate workspace", () => {
    const repoUserspace = join(REPO_ROOT, "userspace.js");
    const repoIndex = join(REPO_ROOT, "index.js");
    expect(retargetStaticCommandToWorkspace(
      `node --check ${repoUserspace}`,
      "/tmp/lab/workspace",
    )).toBe("node --check /tmp/lab/workspace/userspace.js");

    expect(retargetStaticCommandToWorkspace(
      `rg -n "foo" ${repoUserspace} && node ${repoIndex}`,
      "/tmp/lab/workspace",
    )).toBe("rg -n \"foo\" /tmp/lab/workspace/userspace.js && node /tmp/lab/workspace/index.js");
  });

  it("treats matched baseline-fail/candidate-pass static checks as successful validation", async () => {
    const base = await mkdtemp(join(tmpdir(), "state-lab-static-check-"));
    const baselineWorkspace = join(base, "baseline");
    const candidateWorkspace = join(base, "candidate");
    const metadata = {
      state_dir: join(base, "state"),
      pre_trigger_snapshot_dir: join(base, "snapshot"),
      ports: {
        kernel: 8897,
        dashboard: 8900,
        governor: 8901,
        spa: 9011,
        dashboard_inspector: 9340,
        governor_inspector: 9341,
      },
    };

    try {
      await mkdir(baselineWorkspace, { recursive: true });
      await mkdir(candidateWorkspace, { recursive: true });
      await writeFile(join(baselineWorkspace, "state.txt"), "before\n", "utf8");
      await writeFile(join(candidateWorkspace, "state.txt"), "after\n", "utf8");

      const validation = {
        static_checks: [
          {
            command: "grep -q after state.txt",
            expect: {
              baseline: "fail",
              candidate: "pass",
            },
          },
        ],
      };

      const baselineResult = await runStaticValidation({
        paths: { workspaceDir: baselineWorkspace },
        metadata,
      }, validation, { max_wall_time_minutes: 1 }, "baseline");
      const candidateResult = await runStaticValidation({
        paths: { workspaceDir: candidateWorkspace },
        metadata,
      }, validation, { max_wall_time_minutes: 1 }, "candidate");

      expect(baselineResult.passed).toBe(true);
      expect(baselineResult.commands[0]).toMatchObject({
        expected_outcome: "fail",
        actual_outcome: "fail",
        matched: true,
      });

      expect(candidateResult.passed).toBe(true);
      expect(candidateResult.commands[0]).toMatchObject({
        expected_outcome: "pass",
        actual_outcome: "pass",
        matched: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("neutralizes identical shared baseline failures when a comparative static check is present", async () => {
    const base = await mkdtemp(join(tmpdir(), "state-lab-shared-static-"));
    const baselineWorkspace = join(base, "baseline");
    const candidateWorkspace = join(base, "candidate");
    const metadata = {
      state_dir: join(base, "state"),
      pre_trigger_snapshot_dir: join(base, "snapshot"),
      ports: {
        kernel: 8897,
        dashboard: 8900,
        governor: 8901,
        spa: 9011,
        dashboard_inspector: 9340,
        governor_inspector: 9341,
      },
    };

    try {
      await mkdir(baselineWorkspace, { recursive: true });
      await mkdir(candidateWorkspace, { recursive: true });
      await writeFile(join(candidateWorkspace, "state.txt"), "after\n", "utf8");

      const validation = {
        static_commands: ["grep -q shared missing.txt"],
        static_checks: [
          {
            command: "grep -q after state.txt",
            expect: {
              baseline: "fail",
              candidate: "pass",
            },
          },
        ],
      };

      const baselineResult = await runStaticValidation({
        paths: { workspaceDir: baselineWorkspace },
        metadata,
      }, validation, { max_wall_time_minutes: 1 }, "baseline");
      const candidateResult = await runStaticValidation({
        paths: { workspaceDir: candidateWorkspace },
        metadata,
      }, validation, { max_wall_time_minutes: 1 }, "candidate");

      expect(baselineResult.passed).toBe(false);
      expect(candidateResult.passed).toBe(false);

      const reconciled = reconcileComparativeStaticValidation(
        baselineResult,
        candidateResult,
        validation,
      );

      expect(reconciled.neutralized_shared_failures).toBe(1);
      expect(reconciled.baseline.passed).toBe(true);
      expect(reconciled.candidate.passed).toBe(true);
      expect(reconciled.baseline.commands[0]).toMatchObject({
        actual_outcome: "fail",
        matched: true,
        neutralized_shared_baseline_failure: true,
      });
      expect(reconciled.candidate.commands[0]).toMatchObject({
        actual_outcome: "fail",
        matched: true,
        neutralized_shared_baseline_failure: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not neutralize shared failures when there is no comparative static check", async () => {
    const baselineResult = {
      passed: false,
      commands: [{
        command: "npm test -- tests/userspace.test.js",
        source: "static_command",
        expected_outcome: "pass",
        actual_outcome: "fail",
        matched: false,
        exit_code: 1,
        failure_signature_hash: "same",
        stdout_hash: "same",
        stderr_hash: "same",
      }],
    };
    const candidateResult = {
      passed: false,
      commands: [{
        command: "npm test -- tests/userspace.test.js",
        source: "static_command",
        expected_outcome: "pass",
        actual_outcome: "fail",
        matched: false,
        exit_code: 1,
        failure_signature_hash: "same",
        stdout_hash: "same",
        stderr_hash: "same",
      }],
    };

    const reconciled = reconcileComparativeStaticValidation(
      baselineResult,
      candidateResult,
      { static_commands: ["npm test -- tests/userspace.test.js"] },
    );

    expect(reconciled.neutralized_shared_failures).toBe(0);
    expect(reconciled.baseline.passed).toBe(false);
    expect(reconciled.candidate.passed).toBe(false);
  });

  it("does not neutralize shared failures for explicit static_checks", () => {
    const baselineResult = {
      passed: false,
      commands: [{
        command: "npx vitest run tests/userspace.test.js -t targeted-fix",
        label: "targeted-fix",
        source: "static_check",
        expected_outcome: "pass",
        actual_outcome: "fail",
        matched: false,
        exit_code: 1,
        failure_signature_hash: "same",
        stdout_hash: "same",
        stderr_hash: "same",
      }],
    };
    const candidateResult = {
      passed: false,
      commands: [{
        command: "npx vitest run tests/userspace.test.js -t targeted-fix",
        label: "targeted-fix",
        source: "static_check",
        expected_outcome: "pass",
        actual_outcome: "fail",
        matched: false,
        exit_code: 1,
        failure_signature_hash: "same",
        stdout_hash: "same",
        stderr_hash: "same",
      }],
    };

    const reconciled = reconcileComparativeStaticValidation(
      baselineResult,
      candidateResult,
      {
        static_checks: [
          { command: "npx vitest run tests/userspace.test.js -t targeted-fix" },
          {
            command: "grep -q after state.txt",
            expect: { baseline: "fail", candidate: "pass" },
          },
        ],
      },
    );

    expect(reconciled.neutralized_shared_failures).toBe(0);
    expect(reconciled.baseline.passed).toBe(false);
    expect(reconciled.candidate.passed).toBe(false);
  });

  it("runs static commands against the candidate workspace even when the author used repo-root paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "state-lab-static-paths-"));
    const workspace = join(base, "workspace");
    const metadata = {
      state_dir: join(base, "state"),
      pre_trigger_snapshot_dir: join(base, "snapshot"),
      ports: {
        kernel: 8897,
        dashboard: 8900,
        governor: 8901,
        spa: 9011,
        dashboard_inspector: 9340,
        governor_inspector: 9341,
      },
    };

    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "userspace.js"), "export const candidate = true;\n", "utf8");

      const validation = {
        static_checks: [
          {
            command: `rg -n "candidate" ${join(REPO_ROOT, "userspace.js")}`,
            expect: {
              candidate: "pass",
            },
          },
        ],
      };

      const result = await runStaticValidation({
        paths: { workspaceDir: workspace },
        metadata,
      }, validation, { max_wall_time_minutes: 1 }, "candidate");

      expect(result.passed).toBe(true);
      expect(result.commands[0]).toMatchObject({
        command: `rg -n "candidate" ${workspace}/userspace.js`,
        actual_outcome: "pass",
        matched: true,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("summarizes batch results for lab comparison", () => {
    expect(summarizeBatchSummary(null)).toBeNull();
    expect(summarizeBatchSummary({
      cycles: 3,
      totals: { total_issues: 4, meta_policy_notes_total: 1 },
      remote_cleanup: { status: "ok" },
      completed_at: "2026-04-09T00:00:00.000Z",
    })).toEqual({
      cycles: 3,
      totals: { total_issues: 4, meta_policy_notes_total: 1 },
      remote_cleanup: { status: "ok" },
      completed_at: "2026-04-09T00:00:00.000Z",
    });
  });

  it("computes candidate-minus-baseline deltas for continuation summaries", () => {
    const comparison = compareContinuationSummaries(
      {
        cycles: 3,
        totals: {
          total_issues: 5,
          tactic_smuggling: 2,
          meta_policy_notes_total: 0,
        },
      },
      {
        cycles: 3,
        totals: {
          total_issues: 2,
          tactic_smuggling: 0,
          meta_policy_notes_total: 1,
        },
      },
    );

    expect(comparison.baseline.cycles).toBe(3);
    expect(comparison.candidate.cycles).toBe(3);
    expect(comparison.deltas).toEqual({
      total_issues: -3,
      tactic_smuggling: -2,
      meta_policy_notes_total: 1,
    });
  });
});

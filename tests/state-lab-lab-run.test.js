import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { runLabRun } from "../lib/state-lab/lab-run.js";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function buildEntry(root, name) {
  const base = join(root, name);
  await mkdir(base, { recursive: true });
  const workspaceDir = join(base, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  return {
    name,
    metadata: {
      state_dir: join(base, "state"),
    },
    paths: {
      base,
      workspaceDir,
      labStatePath: join(base, "lab-state.json"),
      labReportPath: join(base, "lab-report.json"),
      labResultPath: join(base, "lab-result.json"),
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    buildStartEnv: vi.fn(() => ({})),
    loadLabHypothesis: vi.fn(),
    sanitizeName: vi.fn((value) => value),
    createBranchFromSource: vi.fn(),
    prepareWorkspace: vi.fn(async () => {}),
    applyCandidateChanges: vi.fn(async () => []),
    runStaticValidation: vi.fn(async () => ({ passed: true, commands: [] })),
    buildValidatedChanges: vi.fn(async () => ({ kv_operations: [], code_stage_requests: [], deploy: false })),
    pathExists: vi.fn(async () => false),
    readJson: vi.fn(async () => ({})),
    syncWorkspaceCodeTargetsToBranchKv: vi.fn(async () => []),
    ...overrides,
  };
}

describe("state-lab lab-run module", () => {
  it("writes report/result/state for a stageable lab run", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-lab-lab-run-"));
    try {
      const hypothesisPath = join(root, "hypothesis.json");
      await writeFile(hypothesisPath, JSON.stringify({ ok: true }), "utf8");
      const baselineEntry = await buildEntry(root, "baseline");
      const candidateEntry = await buildEntry(root, "candidate");
      const deps = baseDeps({
        loadLabHypothesis: vi.fn(async () => ({
          resolvedPath: hypothesisPath,
          payload: {
            hypothesis: "test hypothesis",
            review_note_key: "review_note:test",
            candidate_changes: [{ type: "kv_put", key: "x", value: 1 }],
            validation: { continuation: { enabled: false } },
            limits: { max_wall_time_minutes: 10 },
          },
        })),
      });

      deps.createBranchFromSource
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: baselineEntry,
        })
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: candidateEntry,
        });

      await runLabRun(["branch:source", hypothesisPath], deps);

      const state = await readJson(candidateEntry.paths.labStatePath);
      const report = await readJson(candidateEntry.paths.labReportPath);
      const result = await readJson(candidateEntry.paths.labResultPath);

      expect(state.status).toBe("stageable");
      expect(report.promotion_recommendation).toBe("stageable");
      expect(report.baseline_branch).toBe("baseline");
      expect(report.branch).toBe("candidate");
      expect(result.promotion_recommendation).toBe("stageable");
      expect(result.review_note_key).toBe("review_note:test");
      expect(result.reasons_not_to_change).toEqual([]);
      expect(deps.prepareWorkspace).toHaveBeenCalledTimes(2);
      expect(deps.runStaticValidation).toHaveBeenCalledTimes(2);
      expect(deps.buildValidatedChanges).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records failed state when candidate application throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-lab-lab-run-fail-"));
    try {
      const hypothesisPath = join(root, "hypothesis.json");
      await writeFile(hypothesisPath, JSON.stringify({ ok: true }), "utf8");
      const baselineEntry = await buildEntry(root, "baseline");
      const candidateEntry = await buildEntry(root, "candidate");
      const deps = baseDeps({
        loadLabHypothesis: vi.fn(async () => ({
          resolvedPath: hypothesisPath,
          payload: {
            hypothesis: "test hypothesis",
            candidate_changes: [{ type: "kv_put", key: "x", value: 1 }],
            validation: { continuation: { enabled: false } },
            limits: { max_wall_time_minutes: 10 },
          },
        })),
        applyCandidateChanges: vi.fn(async () => {
          throw new Error("candidate_apply_failed");
        }),
      });

      deps.createBranchFromSource
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: baselineEntry,
        })
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: candidateEntry,
        });

      await expect(runLabRun(["branch:source", hypothesisPath], deps)).rejects.toThrow("candidate_apply_failed");

      const state = await readJson(candidateEntry.paths.labStatePath);
      expect(state.status).toBe("failed");
      expect(state.failure_reason).toBe("candidate_apply_failed");
      expect(state.baseline_branch).toBe("baseline");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves continuation result shape when static validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "state-lab-lab-run-static-fail-"));
    try {
      const hypothesisPath = join(root, "hypothesis.json");
      await writeFile(hypothesisPath, JSON.stringify({ ok: true }), "utf8");
      const baselineEntry = await buildEntry(root, "baseline");
      const candidateEntry = await buildEntry(root, "candidate");
      const deps = baseDeps({
        loadLabHypothesis: vi.fn(async () => ({
          resolvedPath: hypothesisPath,
          payload: {
            hypothesis: "test hypothesis",
            candidate_changes: [{ type: "kv_put", key: "x", value: 1 }],
            validation: { continuation: { enabled: true, max_sessions: 2 } },
            limits: { max_wall_time_minutes: 10 },
          },
        })),
        runStaticValidation: vi.fn(async (_entry, _validation, _limits, surface) => ({
          passed: surface === "baseline",
          commands: [],
        })),
      });

      deps.createBranchFromSource
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: baselineEntry,
        })
        .mockResolvedValueOnce({
          source: { ref: "branch:source" },
          entry: candidateEntry,
        });

      await runLabRun(["branch:source", hypothesisPath], deps);

      const report = await readJson(candidateEntry.paths.labReportPath);
      expect(report.promotion_recommendation).toBe("reject");
      expect(report.candidate_continuation).toEqual({
        enabled: true,
        passed: false,
        base_dir: null,
        summary: null,
        synced_code_targets: [],
        stdout_tail: "",
        stderr_tail: "",
        error: "candidate_static_validation_failed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

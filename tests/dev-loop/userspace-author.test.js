import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { lstatSync } from "fs";
import { describe, expect, it } from "vitest";

import {
  normalizeAuthorPayload,
  normalizeCandidateChanges,
} from "../../lib/userspace-review/payloads.js";
// Pure author payload normalization now lives in lib/userspace-review/payloads.js.
import {
  buildReviewInvocation,
  materializeAuthorWorkspace,
  persistLabResultCopies,
  persistOutputCopies,
} from "../../lib/state-lab/review-jobs.js";
import { getKV, dispose } from "../../scripts/shared.mjs";

describe("userspace author normalization", () => {
  it("maps search/replace aliases onto canonical patch fields", () => {
    const changes = normalizeCandidateChanges([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        search: "old",
        replace: "new",
      },
    ]);

    expect(changes).toEqual([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        old_string: "old",
        new_string: "new",
      },
    ]);
  });

  it("expands patch arrays into individual canonical patch operations", () => {
    const changes = normalizeCandidateChanges([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        patches: [
          { search: "first", replace: "one" },
          { old_string: "second", new_string: "two" },
        ],
      },
    ]);

    expect(changes).toEqual([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        old_string: "first",
        new_string: "one",
      },
      {
        type: "kv_patch",
        key: "prompt:reflect",
        old_string: "second",
        new_string: "two",
      },
    ]);
  });

  it("lets per-patch search/replace override top-level defaults", () => {
    const changes = normalizeCandidateChanges([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        search: "fallback-old",
        replace: "fallback-new",
        patches: [
          { search: "first", replace: "one" },
          { old_string: "second", new_string: "two" },
        ],
      },
    ]);

    expect(changes).toEqual([
      {
        type: "kv_patch",
        key: "prompt:reflect",
        old_string: "first",
        new_string: "one",
      },
      {
        type: "kv_patch",
        key: "prompt:reflect",
        old_string: "second",
        new_string: "two",
      },
    ]);
  });

  it("normalizes full author payloads before parse_ok is decided", () => {
    const payload = normalizeAuthorPayload({
      hypothesis: "test patch set",
      candidate_changes: [
        {
          type: "code_patch",
          target: "hook:session:code",
          search: "before",
          replace: "after",
        },
      ],
      validation: { static_commands: [] },
      limits: { max_wall_time_minutes: 20 },
    });

    expect(payload).toMatchObject({
      hypothesis: "test patch set",
      validation: { static_commands: [] },
      limits: { max_wall_time_minutes: 20 },
    });
    expect(payload.candidate_changes).toEqual([
      {
        type: "code_patch",
        target: "hook:session:code",
        old_string: "before",
        new_string: "after",
      },
    ]);
  });

  it("rejects patch entries missing their target field", () => {
    expect(normalizeCandidateChanges([
      {
        type: "kv_patch",
        old_string: "before",
        new_string: "after",
      },
    ])).toBeNull();

    expect(normalizeCandidateChanges([
      {
        type: "code_patch",
        old_string: "before",
        new_string: "after",
      },
    ])).toBeNull();
  });

  it("materializes a branch-author workspace from source-ref state instead of the live repo checkout", async () => {
    const base = await mkdtemp(join(tmpdir(), "userspace-author-workspace-"));
    const repoRoot = join(base, "repo");
    const stateLabDir = join(base, "state-lab");
    const stateDir = join(stateLabDir, "branches", "test-branch", "state");
    const workspaceDir = join(base, "author-workspace");

    await mkdir(join(repoRoot, "prompts"), { recursive: true });
    await mkdir(join(repoRoot, "tools"), { recursive: true });
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(join(repoRoot, "node_modules"), { recursive: true });
    await writeFile(join(repoRoot, "userspace.js"), "repo userspace\n", "utf8");
    await writeFile(join(repoRoot, "prompts", "reflect.md"), "repo reflect prompt\n", "utf8");
    await writeFile(join(repoRoot, "tools", "demo.js"), "repo tool\n", "utf8");
    await writeFile(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(join(repoRoot, "node_modules", "placeholder.js"), "module.exports = 1;\n", "utf8");
    await mkdir(stateDir, { recursive: true });

    const kv = await getKV({ stateDir });
    try {
      await kv.put("kernel:source_map", JSON.stringify({
        userspace: "hook:session:code",
        reflection: "hook:reflect:code",
        tools: "tool:*:code",
      }), { metadata: { format: "json" } });
      await kv.put("hook:session:code", "branch userspace\n", { metadata: { format: "text" } });
      await kv.put("prompt:reflect", "branch reflect prompt\n", { metadata: { format: "text" } });
      await kv.put("tool:demo:code", "branch tool\n", { metadata: { format: "text" } });
    } finally {
      await dispose();
    }

    try {
      const resolved = await materializeAuthorWorkspace({
        sourceRef: "branch:test-branch",
        workspaceDir,
        repoRoot,
        stateLabDir,
      });

      expect(resolved).toBe(workspaceDir);
      expect(await readFile(join(workspaceDir, "userspace.js"), "utf8")).toBe("branch userspace\n");
      expect(await readFile(join(workspaceDir, "prompts", "reflect.md"), "utf8")).toBe("branch reflect prompt\n");
      expect(await readFile(join(workspaceDir, "tools", "demo.js"), "utf8")).toBe("branch tool\n");
      expect(lstatSync(join(workspaceDir, "node_modules")).isSymbolicLink()).toBe(true);
      expect(() => lstatSync(join(workspaceDir, ".git"))).toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("routes branch-scoped review jobs through branch KV instead of the default dashboard state", () => {
    const stateLabDir = join(tmpdir(), "userspace-author-review-state-lab");
    const invocation = buildReviewInvocation({
      reviewNoteKey: "review_note:userspace_review:x_test:d0:000:demo",
      reviewRunner: "codex",
      sourceRef: "branch:test-branch",
      label: "dr2-demo",
      stateLabDir,
    });

    expect(invocation.args).toEqual([
      "lib/userspace-review/review-run.js",
      "--review-note-key", "review_note:userspace_review:x_test:d0:000:demo",
      "--label", "dr2-demo",
      "--runner", "codex",
      "--input-source", "kv",
    ]);
    expect(invocation.env).toEqual({
      SWAYAMBHU_PERSIST_DIR: join(stateLabDir, "branches", "test-branch", "state"),
    });
  });

  it("fails early when a branch source-ref has no state dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "userspace-author-missing-"));
    try {
      await expect(materializeAuthorWorkspace({
        sourceRef: "branch:missing",
        workspaceDir: join(base, "author-workspace"),
        repoRoot: join(base, "repo"),
        stateLabDir: join(base, "state-lab"),
      })).rejects.toThrow("State dir not found");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps current-source review jobs on the default live input path", () => {
    const invocation = buildReviewInvocation({
      reviewNoteKey: "review_note:userspace_review:x_test:d0:000:demo",
      reviewRunner: "claude",
      sourceRef: "current",
      label: "dr2-demo",
    });

    expect(invocation.args).toEqual([
      "lib/userspace-review/review-run.js",
      "--review-note-key", "review_note:userspace_review:x_test:d0:000:demo",
      "--label", "dr2-demo",
      "--runner", "claude",
    ]);
    expect(invocation.env).toEqual({});
  });

  it("uses bundled input for current-source review jobs when a job bundle dir is present", () => {
    const previous = process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR;
    process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR = "/tmp/dr2-bundle";
    try {
      const invocation = buildReviewInvocation({
        reviewNoteKey: "review_note:userspace_review:x_test:d0:000:demo",
        reviewRunner: "codex",
        sourceRef: "current",
        label: "dr2-demo",
      });

      expect(invocation.args).toEqual([
        "lib/userspace-review/review-run.js",
        "--review-note-key", "review_note:userspace_review:x_test:d0:000:demo",
        "--label", "dr2-demo",
        "--runner", "codex",
        "--input-source", "bundle",
      ]);
      expect(invocation.env).toEqual({});
    } finally {
      if (previous == null) delete process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR;
      else process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR = previous;
    }
  });

  it("persists the validated lab result into both the archival run and the live job workdir", async () => {
    const base = await mkdtemp(join(tmpdir(), "dr2-lab-result-"));
    const runDir = join(base, "run");
    const jobDir = join(base, "job");
    try {
      await mkdir(runDir, { recursive: true });
      await mkdir(jobDir, { recursive: true });

      const raw = JSON.stringify({
        promotion_recommendation: "stageable",
        validated_changes_hash: "abc123",
      }, null, 2);

      const paths = await persistLabResultCopies({
        labResultRaw: raw,
        runDir,
        cwd: jobDir,
      });

      expect(paths.bundledLabResultPath).toBe(join(runDir, "lab-result.json"));
      expect(paths.jobWorkdirLabResultPath).toBe(join(jobDir, "lab-result.json"));
      expect(await readFile(paths.bundledLabResultPath, "utf8")).toBe(raw);
      expect(await readFile(paths.jobWorkdirLabResultPath, "utf8")).toBe(raw);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("defaults the live lab-result copy to the review bundle dir when present", async () => {
    const base = await mkdtemp(join(tmpdir(), "dr2-lab-result-env-"));
    const runDir = join(base, "run");
    const jobDir = join(base, "job");
    const previous = process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR;
    try {
      await mkdir(runDir, { recursive: true });
      await mkdir(jobDir, { recursive: true });
      process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR = jobDir;

      const raw = JSON.stringify({ promotion_recommendation: "reject" }, null, 2);
      const paths = await persistLabResultCopies({
        labResultRaw: raw,
        runDir,
      });

      expect(paths.jobWorkdirLabResultPath).toBe(join(jobDir, "lab-result.json"));
      expect(await readFile(paths.jobWorkdirLabResultPath, "utf8")).toBe(raw);
    } finally {
      if (previous == null) delete process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR;
      else process.env.SWAYAMBHU_USERSPACE_REVIEW_BUNDLE_DIR = previous;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("persists the DR-2 output payload into both the archival run and the live job workdir", async () => {
    const base = await mkdtemp(join(tmpdir(), "dr2-output-"));
    const runDir = join(base, "run");
    const jobDir = join(base, "job");
    try {
      await mkdir(runDir, { recursive: true });
      await mkdir(jobDir, { recursive: true });

      const raw = JSON.stringify({
        review_note_key: "review_note:userspace_review:x_wait:d1:000:test",
        promotion_recommendation: "reject",
      }, null, 2);

      const paths = await persistOutputCopies({
        outputRaw: raw,
        runDir,
        cwd: jobDir,
      });

      expect(paths.bundledOutputPath).toBe(join(runDir, "output.json"));
      expect(paths.jobWorkdirOutputPath).toBe(join(jobDir, "output.json"));
      expect(await readFile(paths.bundledOutputPath, "utf8")).toBe(raw);
      expect(await readFile(paths.jobWorkdirOutputPath, "utf8")).toBe(raw);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

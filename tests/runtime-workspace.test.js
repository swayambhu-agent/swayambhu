import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { lstatSync } from "fs";
import { describe, expect, it } from "vitest";

import { listStableDependencyFiles, materializeRuntimeWorkspace } from "../scripts/materialize-runtime-workspace.mjs";
import { dispose, getKV } from "../scripts/shared.mjs";

describe("runtime workspace materialization", () => {
  it("fails fast when required canonical files are missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "runtime-workspace-missing-"));
    const stateDir = join(base, "state");
    const workspaceDir = join(base, "workspace");

    const kv = await getKV({ stateDir });
    try {
      await kv.put("hook:session:code", "export function run() {}\n", { metadata: { format: "text" } });
    } finally {
      await dispose();
    }

    try {
      await expect(materializeRuntimeWorkspace({ stateDir, workspaceDir }))
        .rejects
        .toThrow("runtime workspace missing required canonical file");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writes a runnable workspace from canonical KV code", async () => {
    const base = await mkdtemp(join(tmpdir(), "runtime-workspace-"));
    const stateDir = join(base, "state");
    const workspaceDir = join(base, "workspace");

    const kv = await getKV({ stateDir });
    try {
      await kv.put("kernel:source:kernel.js", "export const kernel = true;\n", { metadata: { format: "text" } });
      await kv.put("kernel:source:hook-communication.js", "export function runTurn() {}\nexport function ingestInbound() {}\nexport function ingestInternal() {}\nexport function handleCommand() {}\nexport function createOutboxItem() {}\nexport function checkOutbox() {}\n", { metadata: { format: "text" } });
      await kv.put("hook:session:code", "export function run() {}\nexport function classify() { return []; }\n", { metadata: { format: "text" } });
      await kv.put("hook:act:code", "export function renderActPrompt() { return ''; }\n", { metadata: { format: "text" } });
      await kv.put("hook:reflect:code", "export const reflect = true;\n", { metadata: { format: "text" } });
      await kv.put("tool:demo:code", "export const demo = true;\n", { metadata: { format: "text" } });
      await kv.put("provider:sample:code", "export const sample = true;\n", { metadata: { format: "text" } });
      await kv.put("channel:slack:code", "export const slack = true;\n", { metadata: { format: "text" } });
    } finally {
      await dispose();
    }

    try {
      const result = await materializeRuntimeWorkspace({ stateDir, workspaceDir });

      expect(result.workspaceDir).toBe(workspaceDir);
      expect(result.files).toContain("index.js");
      expect(await readFile(join(workspaceDir, "userspace.js"), "utf8")).toContain("export function run()");
      expect(await readFile(join(workspaceDir, "act.js"), "utf8")).toContain("renderActPrompt");
      expect(await readFile(join(workspaceDir, "tools", "demo.js"), "utf8")).toContain("demo = true");
      expect(await readFile(join(workspaceDir, "providers", "sample.js"), "utf8")).toContain("sample = true");
      expect(await readFile(join(workspaceDir, "channels", "slack.js"), "utf8")).toContain("slack = true");
      expect(await readFile(join(workspaceDir, "eval.js"), "utf8")).toContain("evaluateAction");
      expect(await readFile(join(workspaceDir, "memory.js"), "utf8")).toContain("cosineSimilarity");
      expect(await readFile(join(workspaceDir, "meta-policy.js"), "utf8")).toContain("normalizeMetaPolicyNotes");
      expect(await readFile(join(workspaceDir, "lib", "session-requests.js"), "utf8")).toContain("SESSION_REQUEST_STATUSES");
      const indexJs = await readFile(join(workspaceDir, "index.js"), "utf8");
      expect(indexJs).toContain("import * as demo from './tools/demo.js';");
      expect(indexJs).toContain("import * as sample from './providers/sample.js';");
      expect(indexJs).toContain("import * as slackAdapter from './channels/slack.js';");
      expect(await readFile(join(workspaceDir, "wrangler.dev.toml"), "utf8")).toContain("main = \"index.js\"");
      expect(lstatSync(join(workspaceDir, "node_modules")).isSymbolicLink()).toBe(true);
      expect(await readFile(join(workspaceDir, ".materialized"), "utf8")).toBe("ok\n");
      expect(await readFile(join(workspaceDir, ".state-lab-runtime.json"), "utf8")).toContain("\"source\": \"canonical-kv\"");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("falls back to filesystem enumeration when git metadata is unavailable", async () => {
    const files = await listStableDependencyFiles("lib", () => {
      const error = new Error("fatal: not a git repository");
      error.status = 128;
      throw error;
    });

    expect(files).toContain("lib/session-requests.js");
  });
});

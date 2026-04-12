import { describe, it, expect, vi, beforeEach } from "vitest";
import { readCodeFromKV, generateIndexJS, keyToFilePath } from "../governor/builder.js";
import { deploy, recordDeployment, hashCode } from "../governor/deployer.js";
import { applyStagedCode, snapshotCanonicalCode } from "../governor/worker.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── 1. readCodeFromKV ─────────────────────────────────────────

describe("readCodeFromKV", () => {
  let kv;

  beforeEach(() => {
    kv = makeKVStore({
      // Tools
      "tool:kv_query:code": "export function execute() {}",
      "tool:kv_query:meta": JSON.stringify({ name: "kv_query" }),
      "tool:web_fetch:code": "export function execute() {}",
      // Providers
      "provider:llm:code": "export function call() {}",
      "provider:llm:meta": JSON.stringify({ name: "llm" }),
      "provider:llm_balance:code": "export function check() {}",
      "provider:llm:last_working:v1": "old code snapshot",
      // Channels
      "channel:slack:code": "export function parseInbound() {}",
      "channel:slack:config": JSON.stringify({ token: "xxx" }),
      // Policy hooks
      "hook:act:code": "export async function runAct() {}",
      // Kernel source (immutable)
      "kernel:source:kernel.js": "class Kernel {}",
      "kernel:source:hook-communication.js": "export function handleChat() {}",
      "kernel:source:authority-policy.js": "export const BOOTSTRAP_KEY_TIERS = {}",
      // Non-code keys (should be ignored by readCodeFromKV)
      "config:defaults": JSON.stringify({ schedule: {} }),
      "prompt:act": "You are...",
    });
  });

  it("collects all code keys into files map", async () => {
    const { files } = await readCodeFromKV(kv);

    expect(files["tools/kv_query.js"]).toBe("export function execute() {}");
    expect(files["tools/web_fetch.js"]).toBe("export function execute() {}");
    expect(files["providers/llm.js"]).toBe("export function call() {}");
    expect(files["providers/llm_balance.js"]).toBe("export function check() {}");
    expect(files["channels/slack.js"]).toBe("export function parseInbound() {}");
    expect(files["act.js"]).toBe("export async function runAct() {}");
    expect(files["kernel.js"]).toBe("class Kernel {}");
    expect(files["hook-communication.js"]).toBe("export function handleChat() {}");
    expect(files["authority-policy.js"]).toBe("export const BOOTSTRAP_KEY_TIERS = {}");
  });

  it("populates metadata arrays correctly", async () => {
    const { metadata } = await readCodeFromKV(kv);

    expect(metadata.tools).toContain("kv_query");
    expect(metadata.tools).toContain("web_fetch");
    expect(metadata.tools).toHaveLength(2);
    expect(metadata.providers).toContain("llm");
    expect(metadata.providers).toContain("llm_balance");
    expect(metadata.providers).toHaveLength(2);
    expect(metadata.channels).toEqual(["slack"]);
  });

  it("skips provider:*:last_working:* snapshots", async () => {
    const { files, metadata } = await readCodeFromKV(kv);

    // Should not appear in providers
    expect(metadata.providers).not.toContain("last_working");
    expect(metadata.providers).not.toContain("v1");
    // No file for the snapshot
    const allPaths = Object.keys(files);
    expect(allPaths.every(p => !p.includes("last_working"))).toBe(true);
  });

  it("skips non-code keys (meta, config, prompt)", async () => {
    const { files } = await readCodeFromKV(kv);

    const allPaths = Object.keys(files);
    expect(allPaths).not.toContain("config:defaults");
    expect(allPaths).not.toContain("prompt:act");
    // Meta keys should not produce files
    expect(allPaths.every(p => !p.includes("meta"))).toBe(true);
  });

  it("handles empty KV gracefully", async () => {
    const emptyKV = makeKVStore({});
    const { files, metadata } = await readCodeFromKV(emptyKV);

    expect(Object.keys(files)).toHaveLength(0);
    expect(metadata.tools).toEqual([]);
    expect(metadata.providers).toEqual([]);
    expect(metadata.channels).toEqual([]);
  });
});

// ── 2. recordDeployment ───────────────────────────────────────

describe("recordDeployment", () => {
  let kv;

  beforeEach(() => {
    kv = makeKVStore({});
  });

  it("writes version manifest, current pointer, and history", async () => {
    const changedKeys = ["tool:foo:code", "tool:bar:code"];
    const hashes = { "kernel.js": "abc", "tools/kv_query.js": "def" };

    const manifest = await recordDeployment(kv, "v_test_1", changedKeys, hashes);

    // Version manifest
    expect(manifest.version_id).toBe("v_test_1");
    expect(manifest.changed_keys).toEqual(changedKeys);
    expect(manifest.code_hashes).toEqual(hashes);

    // KV: version key
    const stored = JSON.parse(kv._store.get("deploy:version:v_test_1"));
    expect(stored.version_id).toBe("v_test_1");

    // KV: current pointer
    const current = JSON.parse(kv._store.get("deploy:current"));
    expect(current.version_id).toBe("v_test_1");

    // KV: history
    const history = JSON.parse(kv._store.get("deploy:history"));
    expect(history).toHaveLength(1);
    expect(history[0].version_id).toBe("v_test_1");
    expect(history[0].changed_count).toBe(2);
  });

  it("prepends to history (newest first)", async () => {
    await recordDeployment(kv, "v_old", ["tool:a:code"], {});
    await recordDeployment(kv, "v_new", ["tool:b:code"], {});

    const history = JSON.parse(kv._store.get("deploy:history"));
    expect(history[0].version_id).toBe("v_new");
    expect(history[1].version_id).toBe("v_old");
  });

  it("caps history at 10 entries", async () => {
    for (let i = 0; i < 12; i++) {
      await recordDeployment(kv, `v_${i}`, [`tool:t${i}:code`], {});
    }

    const history = JSON.parse(kv._store.get("deploy:history"));
    expect(history).toHaveLength(10);
    // Most recent should be first
    expect(history[0].version_id).toBe("v_11");
    // Oldest kept should be v_2
    expect(history[9].version_id).toBe("v_2");
  });
});

// ── 3. hashCode ───────────────────────────────────────────────

describe("hashCode", () => {
  it("returns a string", () => {
    expect(typeof hashCode("hello")).toBe("string");
  });

  it("is deterministic", () => {
    expect(hashCode("test code")).toBe(hashCode("test code"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashCode("version A")).not.toBe(hashCode("version B"));
  });

  it("handles empty string", () => {
    expect(hashCode("")).toBe("0");
  });
});

// ── 4. deploy (CF API) ───────────────────────────────────────

describe("deploy", () => {
  it("throws on missing credentials", async () => {
    await expect(deploy({}, { "index.js": "export default {}" }))
      .rejects.toThrow("Missing CF_ACCOUNT_ID or CF_API_TOKEN");
  });

  it("sends correct request to CF API", async () => {
    const capturedReq = {};
    const mockFetch = vi.fn(async (url, opts) => {
      capturedReq.url = url;
      capturedReq.method = opts.method;
      capturedReq.headers = opts.headers;
      capturedReq.body = opts.body;
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: { id: "script_123", etag: "etag_abc" },
        }),
      };
    });

    // Temporarily replace global fetch
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const env = {
        CF_ACCOUNT_ID: "acc_123",
        CF_API_TOKEN: "tok_secret",
        CF_SCRIPT_NAME: "my-worker",
      };
      const files = {
        "index.js": 'export default { async fetch() { return new Response("ok"); } }',
        "kernel.js": "class Kernel {}",
      };

      const result = await deploy(env, files);

      // Correct URL
      expect(capturedReq.url).toContain("/accounts/acc_123/workers/scripts/my-worker");
      expect(capturedReq.method).toBe("PUT");
      expect(capturedReq.headers.Authorization).toBe("Bearer tok_secret");

      // Multipart body contains metadata and modules
      expect(capturedReq.body).toContain('"main_module":"index.js"');
      expect(capturedReq.body).toContain('name="index.js"');
      expect(capturedReq.body).toContain('name="kernel.js"');
      expect(capturedReq.body).toContain("application/javascript+module");

      // Result
      expect(result.id).toBe("script_123");
      expect(result.etag).toBe("etag_abc");
      expect(result.deployed_at).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws on CF API error", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        errors: [{ message: "Invalid script" }],
      }),
    }));
    try {
      await expect(
        deploy(
          { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" },
          { "index.js": "bad code" },
        ),
      ).rejects.toThrow("Deploy failed (400): Invalid script");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("defaults script name to swayambhu-cns", async () => {
    let capturedUrl;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ success: true, result: {} }),
      };
    });
    try {
      await deploy(
        { CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" },
        { "index.js": "code" },
      );
      expect(capturedUrl).toContain("/scripts/swayambhu-cns");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── 5. applyStagedCode ──────────────────────────────────────

describe("applyStagedCode", () => {
  it("applies staged code matching execution_id to canonical keys", async () => {
    const kv = makeKVStore({
      "code_staging:tool:foo:code": JSON.stringify({
        code: "// new foo code",
        execution_id: "exec_1",
        staged_at: "2026-01-01T00:00:00Z",
      }),
      "code_staging:tool:bar:code": JSON.stringify({
        code: "// new bar code",
        execution_id: "exec_1",
        staged_at: "2026-01-01T00:00:00Z",
      }),
    });

    const changed = await applyStagedCode(kv, "exec_1");

    expect(changed).toEqual(["tool:foo:code", "tool:bar:code"]);
    expect(kv._store.get("tool:foo:code")).toBe("// new foo code");
    expect(kv._store.get("tool:bar:code")).toBe("// new bar code");
  });

  it("ignores staged code from a different execution_id", async () => {
    const kv = makeKVStore({
      "code_staging:tool:foo:code": JSON.stringify({
        code: "// foo from exec_1",
        execution_id: "exec_1",
        staged_at: "2026-01-01T00:00:00Z",
      }),
      "code_staging:tool:bar:code": JSON.stringify({
        code: "// bar from exec_2",
        execution_id: "exec_2",
        staged_at: "2026-01-01T00:00:00Z",
      }),
    });

    const changed = await applyStagedCode(kv, "exec_1");

    // Only foo was applied
    expect(changed).toEqual(["tool:foo:code"]);
    expect(kv._store.get("tool:foo:code")).toBe("// foo from exec_1");
    // bar's staging key remains unconsumed
    expect(kv._store.has("code_staging:tool:bar:code")).toBe(true);
    expect(kv._store.has("tool:bar:code")).toBe(false);
  });

  it("deletes consumed staging keys", async () => {
    const kv = makeKVStore({
      "code_staging:tool:foo:code": JSON.stringify({
        code: "// new code",
        execution_id: "exec_1",
        staged_at: "2026-01-01T00:00:00Z",
      }),
    });

    await applyStagedCode(kv, "exec_1");

    expect(kv._store.has("code_staging:tool:foo:code")).toBe(false);
  });

  it("returns empty array when no code is staged", async () => {
    const kv = makeKVStore({});
    const changed = await applyStagedCode(kv, "exec_1");
    expect(changed).toEqual([]);
  });

  it("applies all staged code when executionId is null (rebuild)", async () => {
    const kv = makeKVStore({
      "code_staging:tool:foo:code": JSON.stringify({
        code: "// foo",
        execution_id: "exec_1",
        staged_at: "2026-01-01T00:00:00Z",
      }),
      "code_staging:tool:bar:code": JSON.stringify({
        code: "// bar",
        execution_id: "exec_2",
        staged_at: "2026-01-01T00:00:00Z",
      }),
    });

    const changed = await applyStagedCode(kv, null);

    expect(changed).toHaveLength(2);
    expect(kv._store.get("tool:foo:code")).toBe("// foo");
    expect(kv._store.get("tool:bar:code")).toBe("// bar");
  });
});

// ── 6. snapshotCanonicalCode ────────────────────────────────

describe("snapshotCanonicalCode", () => {
  it("snapshots current canonical code before applying changes", async () => {
    const kv = makeKVStore({
      "tool:foo:code": "// old foo code",
      "tool:bar:code": "// old bar code",
    });

    await snapshotCanonicalCode(kv, ["tool:foo:code", "tool:bar:code"], "v_123");

    const snapshot = JSON.parse(kv._store.get("deploy:snapshot:v_123"));
    expect(snapshot["tool:foo:code"]).toBe("// old foo code");
    expect(snapshot["tool:bar:code"]).toBe("// old bar code");
  });

  it("records null for keys that did not previously exist", async () => {
    const kv = makeKVStore({});

    await snapshotCanonicalCode(kv, ["tool:new:code"], "v_456");

    const snapshot = JSON.parse(kv._store.get("deploy:snapshot:v_456"));
    expect(snapshot["tool:new:code"]).toBeNull();
  });
});

// ── 7. Full DR → stage → deploy flow ──────────────────────────

describe("full DR → stage → deploy flow", () => {
  it("staged code matching execution_id gets applied to canonical keys", async () => {
    const kv = makeKVStore({
      "tool:kv_query:code": "// original",
      "tool:kv_query:meta": JSON.stringify({ description: "Read KV" }),
      "code_staging:tool:kv_query:code": JSON.stringify({
        code: "// updated by DR",
        staged_at: new Date().toISOString(),
        execution_id: "x_test",
      }),
    });

    const applied = await applyStagedCode(kv, "x_test");
    expect(applied).toEqual(["tool:kv_query:code"]);
    expect(kv._store.get("tool:kv_query:code")).toBe("// updated by DR");
    expect(kv._store.has("code_staging:tool:kv_query:code")).toBe(false);
  });

  it("snapshot preserves canonical code before apply", async () => {
    const kv = makeKVStore({
      "tool:kv_query:code": "// original code to preserve",
    });

    await snapshotCanonicalCode(kv, ["tool:kv_query:code"], "v_test");
    const snapshot = JSON.parse(kv._store.get("deploy:snapshot:v_test"));
    expect(snapshot["tool:kv_query:code"]).toBe("// original code to preserve");
  });

  it("end-to-end: snapshot → apply → canonical updated, staging cleaned", async () => {
    // Simulates what performDeploy does: snapshot first, then apply
    const kv = makeKVStore({
      "tool:kv_query:code": "// v1 original",
      "tool:web_fetch:code": "// v1 fetch",
      "code_staging:tool:kv_query:code": JSON.stringify({
        code: "// v2 from deep reflect",
        staged_at: new Date().toISOString(),
        execution_id: "dr_session_42",
      }),
      "code_staging:tool:web_fetch:code": JSON.stringify({
        code: "// v2 fetch from deep reflect",
        staged_at: new Date().toISOString(),
        execution_id: "dr_session_42",
      }),
    });

    // Step 1: snapshot canonical state before applying
    const targetKeys = ["tool:kv_query:code", "tool:web_fetch:code"];
    await snapshotCanonicalCode(kv, targetKeys, "v_deploy_1");

    // Verify snapshot captured original code
    const snapshot = JSON.parse(kv._store.get("deploy:snapshot:v_deploy_1"));
    expect(snapshot["tool:kv_query:code"]).toBe("// v1 original");
    expect(snapshot["tool:web_fetch:code"]).toBe("// v1 fetch");

    // Step 2: apply staged code
    const changed = await applyStagedCode(kv, "dr_session_42");

    // All staged keys applied
    expect(changed).toHaveLength(2);
    expect(changed).toContain("tool:kv_query:code");
    expect(changed).toContain("tool:web_fetch:code");

    // Canonical keys updated
    expect(kv._store.get("tool:kv_query:code")).toBe("// v2 from deep reflect");
    expect(kv._store.get("tool:web_fetch:code")).toBe("// v2 fetch from deep reflect");

    // Staging keys cleaned up
    expect(kv._store.has("code_staging:tool:kv_query:code")).toBe(false);
    expect(kv._store.has("code_staging:tool:web_fetch:code")).toBe(false);

    // Snapshot still intact for rollback
    const postSnapshot = JSON.parse(kv._store.get("deploy:snapshot:v_deploy_1"));
    expect(postSnapshot["tool:kv_query:code"]).toBe("// v1 original");
  });
});

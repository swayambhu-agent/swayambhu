import { describe, it, expect, vi, beforeEach } from "vitest";
import { readCodeFromKV, generateIndexJS, keyToFilePath } from "../governor/builder.js";
import { deploy, recordDeployment, hashCode, rollback } from "../governor/deployer.js";
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
      "hook:act:code": "export async function orient() {}",
      "hook:reflect:code": "export async function reflect() {}",
      // Kernel source (immutable)
      "kernel:source:kernel.js": "class Brainstem {}",
      "kernel:source:hook-chat.js": "export function handleChat() {}",
      // Non-code keys (should be ignored by readCodeFromKV)
      "config:defaults": JSON.stringify({ wake: {} }),
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
    expect(files["act.js"]).toBe("export async function orient() {}");
    expect(files["reflect.js"]).toBe("export async function reflect() {}");
    expect(files["kernel.js"]).toBe("class Brainstem {}");
    expect(files["hook-chat.js"]).toBe("export function handleChat() {}");
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
    const proposals = [
      { id: "p_1", claims: ["fix bug"] },
      { id: "p_2", claims: ["add feature"] },
    ];
    const hashes = { "kernel.js": "abc", "tools/kv_query.js": "def" };

    const manifest = await recordDeployment(kv, "v_test_1", proposals, hashes);

    // Version manifest
    expect(manifest.version_id).toBe("v_test_1");
    expect(manifest.proposals).toEqual(["p_1", "p_2"]);
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
    expect(history[0].proposal_count).toBe(2);
  });

  it("prepends to history (newest first)", async () => {
    await recordDeployment(kv, "v_old", [{ id: "p_1" }], {});
    await recordDeployment(kv, "v_new", [{ id: "p_2" }], {});

    const history = JSON.parse(kv._store.get("deploy:history"));
    expect(history[0].version_id).toBe("v_new");
    expect(history[1].version_id).toBe("v_old");
  });

  it("caps history at 10 entries", async () => {
    for (let i = 0; i < 12; i++) {
      await recordDeployment(kv, `v_${i}`, [{ id: `p_${i}` }], {});
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
        "kernel.js": "class Brainstem {}",
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

// ── 5. rollback (manifest lookup) ─────────────────────────────

describe("rollback", () => {
  it("returns manifest for valid version", async () => {
    const kv = makeKVStore({
      "deploy:version:v_1": JSON.stringify({
        version_id: "v_1",
        proposals: ["p_1"],
        code_hashes: { "kernel.js": "abc" },
      }),
    });

    const manifest = await rollback(kv, {}, "v_1");
    expect(manifest.version_id).toBe("v_1");
    expect(manifest.proposals).toEqual(["p_1"]);
  });

  it("throws for nonexistent version", async () => {
    const kv = makeKVStore({});
    await expect(rollback(kv, {}, "v_missing"))
      .rejects.toThrow("No deployment manifest for version v_missing");
  });
});

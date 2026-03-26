import { describe, it, expect, vi } from "vitest";
import { Kernel } from "../kernel.js";
import { makeKVStore } from "./helpers/mock-kv.js";
import { buildActContext } from "../act.js";

function makeEnv(kvInit = {}) {
  return { KV: makeKVStore(kvInit) };
}

function makeKernel(kvInit = {}, opts = {}) {
  const env = makeEnv(kvInit);
  const kernel = new Kernel(env, {
    TOOLS: opts.TOOLS || {},
    HOOKS: opts.HOOKS || {},
    PROVIDERS: opts.PROVIDERS || {},
    CHANNELS: opts.CHANNELS || {},
    mode: opts.mode || 'session',
  });
  kernel.defaults = opts.defaults || {};
  kernel.toolGrants = opts.toolGrants || {};
  return { kernel, env };
}

// ── 1. drainInbox ──────────────────────────────────────────

describe("drainInbox", () => {
  it("returns empty array when no inbox items exist", async () => {
    const { kernel } = makeKernel();
    const items = await kernel.drainInbox();
    expect(items).toEqual([]);
  });

  it("reads and deletes all inbox items", async () => {
    const { kernel, env } = makeKernel();
    const item1 = { type: "chat_message", summary: "hello", timestamp: "2026-03-26T10:00:00Z" };
    const item2 = { type: "patron_direct", message: "do X", timestamp: "2026-03-26T10:01:00Z" };
    await env.KV.put("inbox:000001774506800:chat:slack:U123", JSON.stringify(item1));
    await env.KV.put("inbox:000001774506860:patron:direct", JSON.stringify(item2));

    const items = await kernel.drainInbox();

    expect(items).toHaveLength(2);
    expect(items[0].type).toBe("chat_message");
    expect(items[1].type).toBe("patron_direct");

    // Items should be deleted after drain
    const remaining = await env.KV.list({ prefix: "inbox:" });
    expect(remaining.keys).toHaveLength(0);
  });

  it("records karma event with type counts", async () => {
    const { kernel, env } = makeKernel();
    await env.KV.put("inbox:000001774506800:chat:slack:U1", JSON.stringify({ type: "chat_message" }));
    await env.KV.put("inbox:000001774506801:chat:slack:U2", JSON.stringify({ type: "chat_message" }));
    await env.KV.put("inbox:000001774506802:patron:direct", JSON.stringify({ type: "patron_direct" }));

    await kernel.drainInbox();

    const karmaEntry = kernel.karma.find(k => k.event === "inbox_drained");
    expect(karmaEntry).toBeTruthy();
    expect(karmaEntry.count).toBe(3);
    expect(karmaEntry.types).toEqual({ chat_message: 2, patron_direct: 1 });
  });

  it("does not record karma when inbox is empty", async () => {
    const { kernel } = makeKernel();
    await kernel.drainInbox();
    expect(kernel.karma.find(k => k.event === "inbox_drained")).toBeUndefined();
  });
});

// ── 2. writeInboxItem (via kernel interface) ────────────────

describe("writeInboxItem", () => {
  it("writes chat_message inbox item with correct key format", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();

    await K.writeInboxItem({
      type: "chat_message",
      source: { channel: "slack", user_id: "U123" },
      summary: "hello world",
      timestamp: "2026-03-26T10:00:00Z",
    });

    const keys = await env.KV.list({ prefix: "inbox:" });
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0].name).toMatch(/^inbox:\d{15}:chat:slack:U123$/);

    const val = JSON.parse(await env.KV.get(keys.keys[0].name));
    expect(val.type).toBe("chat_message");
    expect(val.summary).toBe("hello world");
  });

  it("writes patron_direct inbox item with correct key format", async () => {
    const { kernel, env } = makeKernel();
    const K = kernel.buildKernelInterface();

    await K.writeInboxItem({
      type: "patron_direct",
      source: { channel: "console" },
      message: "do this now",
    });

    const keys = await env.KV.list({ prefix: "inbox:" });
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0].name).toMatch(/^inbox:\d{15}:patron_direct$/);
  });
});

// ── 3. Comms gate staleness check ──────────────────────────

describe("communicationGate inbox hold", () => {
  const slackMeta = {
    communication: {
      channel: "slack",
      recipient_field: "channel",
      content_field: "text",
      recipient_type: "destination",
    },
  };

  it("holds outbound in session mode when inbox items exist", async () => {
    const { kernel, env } = makeKernel();
    kernel.mode = 'session';
    // Simulate inbox item that arrived mid-session
    await env.KV.put("inbox:000001774506900:chat:slack:U1", JSON.stringify({ type: "chat_message" }));

    const result = await kernel.communicationGate("send_slack", { text: "hi", channel: "C123" }, slackMeta);
    expect(result.verdict).toBe("hold");
    expect(result.reasoning).toContain("inbox");
  });

  it("does NOT hold outbound in chat mode even with inbox items", async () => {
    const { kernel, env } = makeKernel({}, { mode: 'chat' });
    kernel.mode = 'chat';
    await env.KV.put("inbox:000001774506900:chat:slack:U1", JSON.stringify({ type: "chat_message" }));

    const result = await kernel.communicationGate("send_slack", { text: "hi", channel: "C123" }, slackMeta);
    expect(result.verdict).toBe("send");
  });

  it("allows outbound in session mode when inbox is empty", async () => {
    const { kernel } = makeKernel();
    kernel.mode = 'session';

    const result = await kernel.communicationGate("send_slack", { text: "hi", channel: "C123" }, slackMeta);
    expect(result.verdict).toBe("send");
  });
});

// ── 4. buildActContext with inbox ────────────────────────────

describe("buildActContext with inbox", () => {
  it("includes inbox items in context", () => {
    const context = {
      balances: { providers: {}, wallets: {} },
      lastReflect: null,
      additionalContext: {},
      effort: "medium",
      crashData: null,
      inbox: [
        { type: "chat_message", contact_name: "Swami", summary: "explore on your own" },
        { type: "patron_direct", message: "check balances" },
      ],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result.inbox).toHaveLength(2);
    expect(result.inbox[0].type).toBe("chat_message");
    expect(result.inbox[1].type).toBe("patron_direct");
  });

  it("omits inbox key when inbox is empty", () => {
    const context = {
      balances: {}, lastReflect: null, additionalContext: {},
      effort: "low", crashData: null, inbox: [],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result).not.toHaveProperty("inbox");
  });
});

// ── 5. inbox: prefix is kernel-only ─────────────────────────

describe("inbox prefix protection", () => {
  it("inbox keys are classified as system keys", () => {
    expect(Kernel.SYSTEM_KEY_PREFIXES).toContain("inbox:");
  });

  it("inbox keys are classified as kernel-only", () => {
    expect(Kernel.KERNEL_ONLY_PREFIXES).toContain("inbox:");
  });

  it("kvWriteGated rejects writes to inbox keys", async () => {
    const { kernel } = makeKernel();
    const result = await kernel.kvWriteGated(
      { key: "inbox:test", op: "put", value: "nope" },
      "act"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kernel");
  });
});

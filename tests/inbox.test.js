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

// ── 4. buildActContext with events ────────────────────────────

describe("buildActContext with events", () => {
  it("includes events items in context", () => {
    const context = {
      balances: { providers: {}, wallets: {} },
      lastReflect: null,
      additionalContext: {},
      effort: "medium",
      crashData: null,
      events: [
        { type: "chat_message", contact_name: "Swami", summary: "explore on your own" },
        { type: "patron_direct", message: "check balances" },
      ],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("chat_message");
    expect(result.events[1].type).toBe("patron_direct");
  });

  it("omits events key when events is empty", () => {
    const context = {
      balances: {}, lastReflect: null, additionalContext: {},
      effort: "low", crashData: null, events: [],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result).not.toHaveProperty("events");
  });
});


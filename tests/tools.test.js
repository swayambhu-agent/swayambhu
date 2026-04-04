import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { makeMockK } from "./helpers/mock-kernel.js";

// ── Tool modules ─────────────────────────────────────────────

import * as send_slack from "../tools/send_slack.js";
import * as web_fetch from "../tools/web_fetch.js";

import * as kv_manifest from "../tools/kv_manifest.js";
import * as kv_query from "../tools/kv_query.js";
import * as check_email from "../tools/check_email.js";
import * as send_email from "../tools/send_email.js";
import * as computer from "../tools/computer.js";
import * as test_model from "../tools/test_model.js";
import * as web_search from "../tools/web_search.js";
import * as start_job from "../tools/start_job.js";
import * as collect_jobs from "../tools/collect_jobs.js";
import * as send_whatsapp from "../tools/send_whatsapp.js";
import * as google_docs from "../tools/google_docs.js";
import * as gnanetra from "../tools/gnanetra.js";
import * as request_message from "../tools/request_message.js";

// ── Channel modules ─────────────────────────────────────────
import * as slack from "../channels/slack.js";
import * as whatsapp from "../channels/whatsapp.js";

// ── Provider modules ─────────────────────────────────────────

import * as llm from "../providers/llm.js";
import * as llm_balance from "../providers/llm_balance.js";
import * as wallet_balance from "../providers/wallet_balance.js";
import * as gmail from "../providers/gmail.js";
import * as compute from "../providers/compute.js";

// ── Helpers ──────────────────────────────────────────────────

function mockFetch(response) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name === "content-type" ? "application/json" : null },
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
}

function mockFetchSequence(responses) {
  let i = 0;
  return vi.fn(async () => {
    const resp = responses[i++] || responses[responses.length - 1];
    return {
      ok: resp.ok !== false,
      status: resp.status || 200,
      json: async () => resp.json,
      text: async () => resp.text || JSON.stringify(resp.json),
    };
  });
}

const GMAIL_SECRETS = {
  GMAIL_CLIENT_ID: "test-client-id",
  GMAIL_CLIENT_SECRET: "test-client-secret",
  GMAIL_REFRESH_TOKEN: "test-refresh-token",
};

function base64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage({ id, threadId, from, subject, date, messageId, body, mimeType }) {
  return {
    id: id || "msg_1",
    threadId: threadId || "thread_1",
    payload: {
      mimeType: mimeType || "text/plain",
      headers: [
        { name: "From", value: from || "alice@example.com" },
        { name: "Subject", value: subject || "Test Subject" },
        { name: "Date", value: date || "Mon, 10 Mar 2026 12:00:00 GMT" },
        { name: "Message-ID", value: messageId || "<msg1@example.com>" },
      ],
      body: { data: base64url(body || "Hello world") },
    },
  };
}

function mockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key) => {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      try { return JSON.parse(val); } catch { return val; }
    }),
    put: vi.fn(async (key, value) => store.set(key, typeof value === 'string' ? value : JSON.stringify(value))),
    list: vi.fn(async (opts = {}) => {
      let keys = [...store.keys()];
      if (opts.prefix) keys = keys.filter(k => k.startsWith(opts.prefix));
      if (opts.limit) keys = keys.slice(0, opts.limit);
      return {
        keys: keys.map(name => ({ name, metadata: null })),
        list_complete: true,
      };
    }),
    _store: store,
  };
}

// ── 1. Module structure ──────────────────────────────────────

const allTools = {
  send_slack, web_fetch,
  kv_manifest, kv_query, check_email, send_email, computer, test_model, web_search,
  start_job, collect_jobs, send_whatsapp, google_docs, gnanetra, request_message,
};

const allProviders = { llm, llm_balance, wallet_balance, gmail, compute };

describe("module structure", () => {
  for (const [name, mod] of Object.entries(allTools)) {
    it(`tools/${name}.js exports meta and execute`, () => {
      expect(mod.meta).toBeDefined();
      expect(typeof mod.meta.timeout_ms).toBe("number");
      expect(Array.isArray(mod.meta.secrets)).toBe(true);
      expect(typeof mod.meta.kv_access).toBe("string");
      expect(typeof mod.execute).toBe("function");
    });
  }

  for (const [name, mod] of Object.entries(allProviders)) {
    it(`providers/${name}.js exports meta and call/check`, () => {
      expect(mod.meta).toBeDefined();
      expect(typeof mod.meta.timeout_ms).toBe("number");
      expect(mod.call || mod.check).toBeDefined();
    });
  }
});

// ── 2. No export default (tools use named exports only) ──────

describe("no export default", () => {
  const root = resolve(import.meta.dirname, "..");

  for (const name of Object.keys(allTools)) {
    it(`tools/${name}.js has no export default`, () => {
      const code = readFileSync(resolve(root, `tools/${name}.js`), "utf8");
      expect(code).not.toMatch(/export\s+default\s/);
    });
  }

  for (const name of Object.keys(allProviders)) {
    it(`providers/${name}.js has no export default`, () => {
      const code = readFileSync(resolve(root, `providers/${name}.js`), "utf8");
      expect(code).not.toMatch(/export\s+default\s/);
    });
  }
});

// ── 3. Tool execute() tests ──────────────────────────────────

describe("send_slack", () => {
  it("calls Slack API and returns response", async () => {
    const f = mockFetch({ ok: true, channel: "C123", ts: "123.456" });
    const result = await send_slack.execute({
      text: "hello",
      secrets: { SLACK_BOT_TOKEN: "xoxb-tok", SLACK_CHANNEL_ID: "C123" },
      fetch: f,
    });
    expect(f).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, channel: "C123", ts: "123.456" });
    const url = f.mock.calls[0][0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const opts = f.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer xoxb-tok");
  });
});

describe("web_fetch", () => {
  it("fetches URL and returns status + body", async () => {
    const f = vi.fn(async () => ({
      status: 200,
      text: async () => "page content",
    }));
    const result = await web_fetch.execute({ url: "https://example.com", fetch: f });
    expect(result.status).toBe(200);
    expect(result.body).toBe("page content");
  });

  it("truncates body beyond max_length", async () => {
    const f = vi.fn(async () => ({
      status: 200,
      text: async () => "x".repeat(200),
    }));
    const result = await web_fetch.execute({ url: "https://example.com", max_length: 50, fetch: f });
    expect(result.body.length).toBeLessThan(200);
    expect(result.body).toContain("...[truncated]");
  });
});

describe("computer", () => {
  const secrets = { CF_ACCESS_CLIENT_ID: "cid", CF_ACCESS_CLIENT_SECRET: "secret", COMPUTER_API_KEY: "key" };

  it("delegates to compute provider", async () => {
    const f = mockFetch({ status: "completed", exit_code: 0, output: "hello world", id: "p123" });
    const result = await computer.execute({
      command: "echo hello", secrets, fetch: f, provider: compute,
    });
    expect(f).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, status: "completed", exit_code: 0, output: "hello world", process_id: "p123" });
    const url = f.mock.calls[0][0];
    expect(url).toContain("/execute?wait=60");
    const opts = f.mock.calls[0][1];
    expect(opts.headers["CF-Access-Client-Id"]).toBe("cid");
    expect(opts.headers["Authorization"]).toBe("Bearer key");
  });

  it("uses custom timeout", async () => {
    const f = mockFetch({ status: "completed", exit_code: 0, output: "", id: "p1" });
    await computer.execute({ command: "ls", timeout: 120, secrets, fetch: f, provider: compute });
    expect(f.mock.calls[0][0]).toContain("wait=120");
  });

  it("returns error when command is missing", async () => {
    const result = await computer.execute({ secrets, fetch: vi.fn(), provider: compute });
    expect(result).toEqual({ ok: false, error: "command is required" });
  });

  it("handles fetch failure", async () => {
    const f = vi.fn(async () => { throw new Error("network down"); });
    const result = await computer.execute({ command: "ls", secrets, fetch: f, provider: compute });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });

  it("handles non-ok response", async () => {
    const f = vi.fn(async () => ({
      ok: false, status: 500, statusText: "Internal Server Error",
      text: async () => "server error detail",
    }));
    const result = await computer.execute({ command: "ls", secrets, fetch: f, provider: compute });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
    expect(result.detail).toBe("server error detail");
  });
});

describe("kv_manifest", () => {
  it("lists keys with default limit", async () => {
    const kv = mockKV({ "a:1": "v1", "a:2": "v2", "b:1": "v3" });
    const result = await kv_manifest.execute({ kv });
    expect(result.count).toBe(3);
    expect(result.list_complete).toBe(true);
  });

  it("filters by prefix", async () => {
    const kv = mockKV({ "a:1": "v1", "a:2": "v2", "b:1": "v3" });
    const result = await kv_manifest.execute({ prefix: "a:", kv });
    expect(result.count).toBe(2);
    expect(result.keys.every(k => k.key.startsWith("a:"))).toBe(true);
  });

  it("respects limit", async () => {
    const kv = mockKV({ k1: "v1", k2: "v2", k3: "v3" });
    const result = await kv_manifest.execute({ limit: "2", kv });
    expect(result.count).toBe(2);
  });

  it("caps limit at 500", async () => {
    const kv = mockKV();
    await kv_manifest.execute({ limit: "9999", kv });
    expect(kv.list).toHaveBeenCalledWith({ limit: 500 });
  });
});

// ── 4. Provider tests ────────────────────────────────────────

describe("provider:llm_balance", () => {
  it("returns limit_remaining from response", async () => {
    const f = mockFetch({ data: { limit_remaining: 42.5 } });
    const result = await llm_balance.check({
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: f,
    });
    expect(result).toBe(42.5);
  });
});

describe("provider:wallet_balance", () => {
  it("returns USDC balance as number", async () => {
    const hexBalance = "0x" + (5000000).toString(16).padStart(64, "0"); // 5 USDC
    const f = mockFetch({ result: hexBalance });
    const result = await wallet_balance.check({
      secrets: { WALLET_ADDRESS: "0x" + "ab".repeat(20) },
      fetch: f,
    });
    expect(result).toBe(5);
  });
});

// ── 5. kv_query tests ──────────────────────────────────────

const SAMPLE_KARMA = [
  { event: "act_start", session_id: "s_123", effort: "low" },
  {
    event: "llm_call", step: "act_turn_0", ok: true,
    request: { model: "anthropic/claude-opus-4.6", messages: [{ role: "system", content: "long..." }] },
    response: { content: "hello" },
    tool_calls: [
      { type: "function", function: { name: "kv_manifest", arguments: "{}" } },
      { type: "function", function: { name: "check_balance", arguments: "{}" } },
    ],
    cost: 0.0155,
  },
  { event: "tool_result", tool: "kv_manifest", ok: true },
];

describe("kv_query", () => {
  it("returns error for missing key param", async () => {
    const result = await kv_query.execute({ kv: mockKV() });
    expect(result.error).toContain("missing required param");
  });

  it("returns error for missing key in KV", async () => {
    const result = await kv_query.execute({ key: "karma:s_none", kv: mockKV() });
    expect(result.error).toContain("no value found");
  });

  it("returns full array when under max_response_chars", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", kv });
    // Small array returned as-is
    expect(result).toHaveLength(3);
    expect(result[0].event).toBe("act_start");
    expect(result[1].event).toBe("llm_call");
  });

  it("returns array summary when over max_response_chars", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({
      key: "karma:s_123", kv,
      config: { tools: { kv_query: { max_response_chars: 100 } } },
    });
    expect(result.type).toBe("array");
    expect(result.count).toBe(3);
    expect(result.items[0]).toContain("act_start");
    expect(result.items[1]).toContain("llm_call");
  });

  it("returns full object for [1] (under max_response_chars)", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[1]", kv });
    expect(result.event).toBe("llm_call");
    expect(result.cost).toBe(0.0155);
    expect(result.tool_calls).toHaveLength(2);
    expect(result.request.model).toBe("anthropic/claude-opus-4.6");
  });

  it("returns full array for [1].tool_calls (under limit)", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[1].tool_calls", kv });
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("kv_manifest");
    expect(result[1].function.name).toBe("check_balance");
  });

  it("returns leaf value for deep path", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({
      key: "karma:s_123",
      path: "[1].tool_calls[0].function.name",
      kv,
    });
    expect(result.value).toBe("kv_manifest");
  });

  it("returns leaf for numeric value", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[1].cost", kv });
    expect(result.value).toBe(0.0155);
  });

  it("returns error for out-of-bounds index", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[99]", kv });
    expect(result.error).toContain("out of bounds");
  });

  it("returns error with available_keys for missing key", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[0].nonexistent", kv });
    expect(result.error).toContain("not found");
    expect(result.available_keys).toContain("event");
  });

  it("returns error for bad path syntax", async () => {
    const kv = mockKV({ "karma:s_123": SAMPLE_KARMA });
    const result = await kv_query.execute({ key: "karma:s_123", path: "[abc]", kv });
    expect(result.error).toContain("non-numeric");
  });

  it("returns full string values without truncation", async () => {
    const longKarma = [{ event: "test", data: "x".repeat(500) }];
    const kv = mockKV({ "karma:s_long": longKarma });
    const result = await kv_query.execute({ key: "karma:s_long", path: "[0].data", kv });
    expect(result.value).toBe("x".repeat(500));
  });

  it("handles string-encoded JSON in KV", async () => {
    const kv = mockKV({ "karma:s_str": JSON.stringify(SAMPLE_KARMA) });
    const result = await kv_query.execute({ key: "karma:s_str", kv });
    expect(result).toHaveLength(3);
  });

  it("returns small objects directly", async () => {
    const data = { act: { model: "haiku" }, reflect: { model: "sonnet" } };
    const kv = mockKV({ "config:defaults": data });
    const result = await kv_query.execute({ key: "config:defaults", kv });
    expect(result.act).toEqual({ model: "haiku" });
    expect(result.reflect).toEqual({ model: "sonnet" });
  });

  it("summarizes large objects with budget-bounded fields", async () => {
    const data = {};
    for (let i = 0; i < 20; i++) data[`field_${i}`] = "x".repeat(200);
    const kv = mockKV({ "big:obj": data });
    // Use a small maxChars to force summarization
    const result = await kv_query.execute({
      key: "big:obj", kv,
      config: { tools: { kv_query: { max_response_chars: 500 } } },
    });
    // Some fields should be included, rest omitted
    expect(result._omitted).toBeDefined();
    expect(result._total_keys).toBe(20);
    // Included fields should have real content
    const includedKeys = Object.keys(result).filter(k => !k.startsWith("_"));
    expect(includedKeys.length).toBeGreaterThan(0);
    expect(includedKeys.length).toBeLessThan(20);
  });

  it("handles plain text (non-JSON) values without crashing", async () => {
    const kv = mockKV({ "hook:act:code": "function hello() { return 42; }" });
    const result = await kv_query.execute({ key: "hook:act:code", kv });
    expect(result.value).toBe("function hello() { return 42; }");
  });

  it("truncates long strings with metadata", async () => {
    const kv = mockKV({ "big:string": "x".repeat(5000) });
    const result = await kv_query.execute({
      key: "big:string", kv,
      config: { tools: { kv_query: { max_response_chars: 200 } } },
    });
    expect(result.truncated).toBe(true);
    expect(result.total_chars).toBe(5000);
    expect(result.value.length).toBeLessThanOrEqual(204); // 200 + "..."
  });
});

// ── 6. check_email tests ──────────────────────────────────────

describe("check_email", () => {
  const EMAIL_SECRETS = { CF_ACCESS_CLIENT_ID: "cid", CF_ACCESS_CLIENT_SECRET: "csec", EMAIL_RELAY_SECRET: "rsec" };

  function mockRelayProvider(checkResult) {
    return {
      checkEmail: vi.fn(async () => checkResult),
    };
  }

  it("returns empty list when no unread emails", async () => {
    const provider = mockRelayProvider({ emails: [], count: 0 });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result).toEqual({ emails: [], count: 0 });
  });

  it("fetches unread emails with from, subject, body", async () => {
    const provider = mockRelayProvider({
      emails: [
        { id: "msg_1", from: "alice@test.com", subject: "Hi", date: "2026-03-10", body: "Hello" },
        { id: "msg_2", from: "bob@test.com", subject: "Re: Hi", date: "2026-03-10", body: "Hey there" },
      ],
      count: 2,
    });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result.count).toBe(2);
    expect(result.emails[0].from).toBe("alice@test.com");
    expect(result.emails[0].subject).toBe("Hi");
    expect(result.emails[0].body).toBe("Hello");
    expect(result.emails[1].from).toBe("bob@test.com");
  });

  it("returns full body without truncation", async () => {
    const longBody = "x".repeat(600);
    const provider = mockRelayProvider({
      emails: [{ id: "msg_1", from: "a@b.com", subject: "S", date: "2026-03-10", body: longBody }],
      count: 1,
    });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result.emails[0].body).toBe(longBody);
  });

  it("respects max_results param", async () => {
    const provider = mockRelayProvider({ emails: [], count: 0 });
    await check_email.execute({ max_results: 5, secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(provider.checkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5 })
    );
  });

  it("caps max_results at 20", async () => {
    const provider = mockRelayProvider({ emails: [], count: 0 });
    await check_email.execute({ max_results: 100, secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(provider.checkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 20 })
    );
  });

  it("passes markRead true to provider when mark_read is true", async () => {
    const provider = mockRelayProvider({
      emails: [{ id: "msg_1", from: "a@b.com", subject: "S", date: "2026-03-10", body: "hi" }],
      count: 1,
    });
    await check_email.execute({ mark_read: true, secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(provider.checkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ markRead: true })
    );
  });

  it("passes markRead false to provider when mark_read is false", async () => {
    const provider = mockRelayProvider({ emails: [], count: 0 });
    await check_email.execute({ mark_read: false, secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(provider.checkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ markRead: false })
    );
  });

  it("throws on gateway failure", async () => {
    const provider = {
      checkEmail: vi.fn(async () => { throw new Error("Email gateway /check-email failed (500): Internal error"); }),
    };
    await expect(
      check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider })
    ).rejects.toThrow("Email gateway");
  });

  it("extracts sender_email from 'Name <addr>' format", async () => {
    const provider = mockRelayProvider({
      emails: [{ id: "msg_1", from: "Alice <alice@test.com>", subject: "Hi", date: "2026-03-10", body: "Hello" }],
      count: 1,
    });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result.emails[0].sender_email).toBe("alice@test.com");
  });

  it("uses from as sender_email when no angle brackets", async () => {
    const provider = mockRelayProvider({
      emails: [{ id: "msg_1", from: "plain@test.com", subject: "Hi", date: "2026-03-10", body: "Hello" }],
      count: 1,
    });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result.emails[0].sender_email).toBe("plain@test.com");
  });

  it("returns id for each email", async () => {
    const provider = mockRelayProvider({
      emails: [{ id: "msg_42", from: "a@b.com", subject: "S", date: "2026-03-10", body: "hi" }],
      count: 1,
    });
    const result = await check_email.execute({ secrets: EMAIL_SECRETS, fetch: vi.fn(), provider });
    expect(result.emails[0].id).toBe("msg_42");
  });
});

// ── 7. send_email tests ───────────────────────────────────────

describe("send_email", () => {
  const EMAIL_SECRETS = { CF_ACCESS_CLIENT_ID: "cid", CF_ACCESS_CLIENT_SECRET: "csec", EMAIL_RELAY_SECRET: "rsec" };

  function mockSendProvider({ getMessageResult, sendResult } = {}) {
    return {
      getMessage: vi.fn(async () => getMessageResult || { id: "orig_1", from: "a@b.com", to: "c@d.com", subject: "Test", date: "2026-03-10", body: "hi", messageId: "<orig@test.com>" }),
      sendMessage: vi.fn(async () => sendResult || { messageId: "<sent_1@relay>" }),
    };
  }

  it("sends a new email and returns messageId", async () => {
    const provider = mockSendProvider({ sendResult: { messageId: "<sent_1@relay>" } });
    const result = await send_email.execute({
      to: "bob@test.com",
      subject: "Hello",
      body: "Hi Bob",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result).toEqual({ sent: true, messageId: "<sent_1@relay>" });
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "bob@test.com", subject: "Hello", body: "Hi Bob", inReplyTo: null })
    );
  });

  it("passes correct params to provider.sendMessage", async () => {
    const provider = mockSendProvider();
    await send_email.execute({
      to: "bob@test.com",
      subject: "Test",
      body: "Body",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    const call = provider.sendMessage.mock.calls[0][0];
    expect(call.to).toBe("bob@test.com");
    expect(call.subject).toBe("Test");
    expect(call.body).toBe("Body");
    expect(call.secrets).toBe(EMAIL_SECRETS);
  });

  it("returns error for missing 'to'", async () => {
    const provider = mockSendProvider();
    const result = await send_email.execute({
      subject: "Hi",
      body: "test",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result.error).toContain("to");
  });

  it("returns error for missing 'subject' when not replying", async () => {
    const provider = mockSendProvider();
    const result = await send_email.execute({
      to: "bob@test.com",
      body: "test",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result.error).toContain("subject");
  });

  it("returns error for missing 'body'", async () => {
    const provider = mockSendProvider();
    const result = await send_email.execute({
      to: "bob@test.com",
      subject: "Hi",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result.error).toContain("body");
  });

  it("allows missing subject when reply_to_id is provided", async () => {
    const provider = mockSendProvider({
      getMessageResult: { id: "orig_1", subject: "Original Subject", messageId: "<orig@test.com>" },
      sendResult: { messageId: "<sent_reply@relay>" },
    });
    const result = await send_email.execute({
      to: "bob@test.com",
      body: "Reply body",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("<sent_reply@relay>");
  });

  it("prepends Re: to subject when replying", async () => {
    const provider = mockSendProvider({
      getMessageResult: { id: "orig_1", subject: "Hello", messageId: "<orig@test.com>" },
    });
    await send_email.execute({
      to: "bob@test.com",
      body: "Reply",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Hello" })
    );
  });

  it("does not double-prepend Re: if already present", async () => {
    const provider = mockSendProvider({
      getMessageResult: { id: "orig_1", subject: "Re: Hello", messageId: "<orig@test.com>" },
    });
    await send_email.execute({
      to: "bob@test.com",
      body: "Reply",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Hello" })
    );
  });

  it("passes inReplyTo from original message when replying", async () => {
    const provider = mockSendProvider({
      getMessageResult: { id: "orig_1", subject: "Test", messageId: "<unique@example.com>" },
    });
    await send_email.execute({
      to: "bob@test.com",
      body: "Reply",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: "<unique@example.com>" })
    );
  });

  it("uses explicit subject over original when replying", async () => {
    const provider = mockSendProvider({
      getMessageResult: { id: "orig_1", subject: "Old Subject", messageId: "<orig@test.com>" },
    });
    await send_email.execute({
      to: "bob@test.com",
      subject: "New Subject",
      body: "Reply",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "New Subject" })
    );
  });

  it("sends without threading when getMessage fails", async () => {
    const provider = {
      getMessage: vi.fn(async () => { throw new Error("gateway down"); }),
      sendMessage: vi.fn(async () => ({ messageId: "<sent@relay>" })),
    };
    const result = await send_email.execute({
      to: "a@b.com",
      subject: "Hi",
      body: "test",
      reply_to_id: "orig_1",
      secrets: EMAIL_SECRETS,
      fetch: vi.fn(),
      provider,
    });
    expect(result.sent).toBe(true);
    // Should send with null inReplyTo (no threading) and the provided subject
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: null, subject: "Hi" })
    );
  });

  it("throws on gateway send failure", async () => {
    const provider = {
      getMessage: vi.fn(),
      sendMessage: vi.fn(async () => { throw new Error("Email gateway /send-email failed (500): Internal error"); }),
    };
    await expect(
      send_email.execute({ to: "a@b.com", subject: "Hi", body: "test", secrets: EMAIL_SECRETS, fetch: vi.fn(), provider })
    ).rejects.toThrow("Email gateway");
  });
});

// ── 8. provider:gmail tests ──────────────────────────────────

describe("provider:gmail", () => {
  it("getAccessToken sends correct OAuth params", async () => {
    const f = mockFetch({ access_token: "fresh_token" });
    const token = await gmail.getAccessToken(GMAIL_SECRETS, f);
    expect(token).toBe("fresh_token");
    const call = f.mock.calls[0];
    expect(call[0]).toBe("https://oauth2.googleapis.com/token");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toContain("grant_type=refresh_token");
    expect(call[1].body).toContain("client_id=test-client-id");
  });

  it("getAccessToken throws on failure", async () => {
    const f = mockFetchSequence([
      { ok: false, status: 403, json: {}, text: "Forbidden" },
    ]);
    await expect(gmail.getAccessToken(GMAIL_SECRETS, f)).rejects.toThrow("token refresh failed");
  });

  it("listUnread returns message stubs", async () => {
    const f = mockFetch({ messages: [{ id: "m1" }, { id: "m2" }] });
    const msgs = await gmail.listUnread("tok", f, 10);
    expect(msgs).toEqual([{ id: "m1" }, { id: "m2" }]);
    expect(f.mock.calls[0][0]).toContain("maxResults=10");
  });

  it("listUnread returns empty array when no messages", async () => {
    const f = mockFetch({});
    const msgs = await gmail.listUnread("tok", f);
    expect(msgs).toEqual([]);
  });

  it("getMessage extracts all headers and body", async () => {
    const f = mockFetch(gmailMessage({
      id: "m1",
      threadId: "t1",
      from: "sender@test.com",
      subject: "Important",
      date: "Tue, 11 Mar 2026",
      messageId: "<m1@test>",
      body: "Message body here",
    }));
    const msg = await gmail.getMessage("tok", f, "m1");
    expect(msg.id).toBe("m1");
    expect(msg.threadId).toBe("t1");
    expect(msg.from).toBe("sender@test.com");
    expect(msg.subject).toBe("Important");
    expect(msg.body).toBe("Message body here");
    expect(msg.messageId).toBe("<m1@test>");
  });

  it("sendMessage encodes raw RFC 2822 as base64url", async () => {
    const f = mockFetch({ id: "sent_1", threadId: "t_new" });
    const result = await gmail.sendMessage("tok", f, {
      to: "dest@test.com",
      subject: "Subj",
      body: "Body text",
    });
    expect(result).toEqual({ messageId: "sent_1", threadId: "t_new" });
    const call = f.mock.calls[0];
    expect(call[0]).toContain("/messages/send");
    const payload = JSON.parse(call[1].body);
    expect(payload.raw).toBeDefined();
    // Should not contain standard base64 chars that are URL-unsafe
    expect(payload.raw).not.toMatch(/[+/=]/);
  });

  it("sendMessage includes threadId when provided", async () => {
    const f = mockFetch({ id: "s1", threadId: "existing_thread" });
    await gmail.sendMessage("tok", f, {
      to: "a@b.com", subject: "Re: X", body: "reply",
      inReplyTo: "<orig@test>", threadId: "existing_thread",
    });
    const payload = JSON.parse(f.mock.calls[0][1].body);
    expect(payload.threadId).toBe("existing_thread");
  });

  it("markAsRead sends correct modify request", async () => {
    const f = mockFetch({});
    await gmail.markAsRead("tok", f, "msg_99");
    const call = f.mock.calls[0];
    expect(call[0]).toContain("msg_99/modify");
    const payload = JSON.parse(call[1].body);
    expect(payload.removeLabelIds).toEqual(["UNREAD"]);
  });

  it("check returns unread count estimate", async () => {
    const f = mockFetchSequence([
      { json: { access_token: "tok" } },
      { json: { messages: [{ id: "m1" }] } },
      { json: { resultSizeEstimate: 7 } },
    ]);
    const count = await gmail.check({ secrets: GMAIL_SECRETS, fetch: f });
    expect(count).toBe(7);
  });

  it("check returns 0 when no unread", async () => {
    const f = mockFetchSequence([
      { json: { access_token: "tok" } },
      { json: {} },
      { json: {} },
    ]);
    const count = await gmail.check({ secrets: GMAIL_SECRETS, fetch: f });
    expect(count).toBe(0);
  });
});

// ── 9. test_model tests ────────────────────────────────────

describe("test_model", () => {
  it("has expected meta fields", () => {
    expect(test_model.meta.secrets).toEqual(["OPENROUTER_API_KEY"]);
    expect(test_model.meta.kv_access).toBe("none");
    expect(test_model.meta.timeout_ms).toBe(30000);
    expect(test_model.meta.provider).toBe("llm");
  });

  it("returns success with response text, usage, and latency", async () => {
    const provider = {
      call: vi.fn(async () => ({
        content: "Hello from the model",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })),
    };
    const result = await test_model.execute({
      model_id: "anthropic/claude-haiku-4.5",
      prompt: "Say hello",
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: vi.fn(),
      provider,
    });
    expect(result.success).toBe(true);
    expect(result.response_text).toBe("Hello from the model");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(typeof result.latency_ms).toBe("number");
    expect(result.error).toBeNull();
    expect(provider.call).toHaveBeenCalledOnce();
    const callArgs = provider.call.mock.calls[0][0];
    expect(callArgs.model).toBe("anthropic/claude-haiku-4.5");
    expect(callArgs.max_tokens).toBe(100);
  });

  it("returns error when provider throws", async () => {
    const provider = {
      call: vi.fn(async () => { throw new Error("model not found"); }),
    };
    const result = await test_model.execute({
      model_id: "nonexistent/model",
      prompt: "test",
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: vi.fn(),
      provider,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("model not found");
    expect(result.response_text).toBeNull();
    expect(result.usage).toBeNull();
    expect(typeof result.latency_ms).toBe("number");
  });

  it("returns error when model_id is missing", async () => {
    const provider = { call: vi.fn() };
    const result = await test_model.execute({
      prompt: "test",
      secrets: {},
      fetch: vi.fn(),
      provider,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("model_id");
    expect(provider.call).not.toHaveBeenCalled();
  });

  it("returns error when prompt is missing", async () => {
    const provider = { call: vi.fn() };
    const result = await test_model.execute({
      model_id: "some/model",
      secrets: {},
      fetch: vi.fn(),
      provider,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prompt");
    expect(provider.call).not.toHaveBeenCalled();
  });

  it("returns error when prompt exceeds 1000 chars", async () => {
    const provider = { call: vi.fn() };
    const result = await test_model.execute({
      model_id: "some/model",
      prompt: "x".repeat(1001),
      secrets: {},
      fetch: vi.fn(),
      provider,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("1000");
    expect(provider.call).not.toHaveBeenCalled();
  });

  it("caps max_tokens at 500", async () => {
    const provider = {
      call: vi.fn(async () => ({ content: "ok", usage: {} })),
    };
    await test_model.execute({
      model_id: "some/model",
      prompt: "test",
      max_tokens: 9999,
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: vi.fn(),
      provider,
    });
    const callArgs = provider.call.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(500);
  });

  it("defaults max_tokens to 100 when not provided", async () => {
    const provider = {
      call: vi.fn(async () => ({ content: "ok", usage: {} })),
    };
    await test_model.execute({
      model_id: "some/model",
      prompt: "test",
      secrets: { OPENROUTER_API_KEY: "k" },
      fetch: vi.fn(),
      provider,
    });
    const callArgs = provider.call.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(100);
  });
});

// ── 10. web_search tests ─────────────────────────────────

function braveWebResponse(results = [], infobox = null) {
  return {
    query: { original: "test query" },
    web: {
      results: results.map((r, i) => ({
        title: r.title || `Result ${i}`,
        url: r.url || `https://example${i}.com`,
        description: r.description || `Snippet ${i}`,
        age: r.age || null,
        meta_url: { hostname: r.hostname || `example${i}.com` },
      })),
    },
    ...(infobox ? {
      infobox: {
        results: [{
          title: infobox.title,
          description: infobox.description,
          url: infobox.url || null,
          attributes: infobox.attributes || [],
        }],
      },
    } : {}),
  };
}

function braveLLMContextResponse(results = [], summarizerText = "") {
  return {
    ...braveWebResponse(results),
    summarizer: {
      results: summarizerText ? [{ text: summarizerText, references: [] }] : [],
    },
  };
}

describe("web_search", () => {
  it("has expected meta fields", () => {
    expect(web_search.meta.secrets).toEqual(["BRAVE_SEARCH_API_KEY"]);
    expect(web_search.meta.kv_access).toBe("none");
    expect(web_search.meta.timeout_ms).toBe(15000);
    expect(web_search.meta.provider).toBeUndefined();
  });

  it("returns error when query is missing", async () => {
    const result = await web_search.execute({
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("query");
  });

  it("returns error when API key is missing", async () => {
    const result = await web_search.execute({
      query: "test",
      secrets: {},
      fetch: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("returns error for invalid freshness value", async () => {
    const result = await web_search.execute({
      query: "test",
      freshness: "hour",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid freshness");
  });

  it("returns structured results on success", async () => {
    const f = mockFetch(braveWebResponse([
      { title: "Page One", url: "https://one.com", description: "First result", age: "2h ago" },
      { title: "Page Two", url: "https://two.com", description: "Second result" },
    ]));
    const result = await web_search.execute({
      query: "test search",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe("Page One");
    expect(result.results[0].url).toBe("https://one.com");
    expect(result.results[0].snippet).toBe("First result");
    expect(result.results[0].age).toBe("2h ago");
    expect(result.results[1].age).toBeNull();
    expect(result.query).toBe("test search");
    expect(result.result_count).toBe(2);
    expect(result.context).toBeNull();
  });

  it("includes infobox when present", async () => {
    const f = mockFetch(braveWebResponse(
      [{ title: "R1" }],
      { title: "Node.js", description: "A JavaScript runtime", attributes: [["License", "MIT"]] },
    ));
    const result = await web_search.execute({
      query: "node.js",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.infobox).not.toBeNull();
    expect(result.infobox.title).toBe("Node.js");
    expect(result.infobox.description).toBe("A JavaScript runtime");
    expect(result.infobox.attributes).toEqual([["License", "MIT"]]);
  });

  it("sets infobox to null when absent", async () => {
    const f = mockFetch(braveWebResponse([{ title: "R1" }]));
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.infobox).toBeNull();
  });

  it("sends correct URL and headers for web search", async () => {
    const f = mockFetch(braveWebResponse([]));
    await web_search.execute({
      query: "cloudflare workers",
      count: 3,
      freshness: "week",
      secrets: { BRAVE_SEARCH_API_KEY: "test-key" },
      fetch: f,
    });
    expect(f).toHaveBeenCalledOnce();
    const [url, opts] = f.mock.calls[0];
    expect(url).toContain("api.search.brave.com/res/v1/web/search");
    expect(url).toContain("q=cloudflare+workers");
    expect(url).toContain("count=3");
    expect(url).toContain("freshness=pw");
    expect(url).toContain("text_decorations=false");
    expect(url).not.toContain("maximum_number_of_tokens");
    expect(opts.headers["X-Subscription-Token"]).toBe("test-key");
  });

  it("uses LLM Context endpoint when deep=true", async () => {
    const f = mockFetch(braveLLMContextResponse(
      [{ title: "R1" }],
      "Pre-extracted content from pages",
    ));
    const result = await web_search.execute({
      query: "deep search",
      deep: true,
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    const [url] = f.mock.calls[0];
    expect(url).toContain("api.search.brave.com/res/v1/llm/context");
    expect(url).toContain("maximum_number_of_tokens=4096");
    expect(result.context).toBe("Pre-extracted content from pages");
  });

  it("maps freshness values correctly", async () => {
    for (const [input, expected] of [["day", "pd"], ["week", "pw"], ["month", "pm"], ["year", "py"]]) {
      const f = mockFetch(braveWebResponse([]));
      await web_search.execute({
        query: "test",
        freshness: input,
        secrets: { BRAVE_SEARCH_API_KEY: "k" },
        fetch: f,
      });
      expect(f.mock.calls[0][0]).toContain(`freshness=${expected}`);
    }
  });

  it("omits freshness param when not provided", async () => {
    const f = mockFetch(braveWebResponse([]));
    await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(f.mock.calls[0][0]).not.toContain("freshness");
  });

  it("returns structured error for 401", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401 }));
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "bad-key" },
      fetch: f,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("401");
  });

  it("returns structured error for 429 with retry_after", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: (h) => h === "retry-after" ? "30" : null },
    }));
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
    expect(result.retry_after).toBe("30");
  });

  it("returns structured error for 5xx", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503 }));
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });

  it("returns error when fetch throws", async () => {
    const f = vi.fn(async () => { throw new Error("network timeout"); });
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network timeout");
  });

  it("clamps count to range 1-20", async () => {
    const f = mockFetch(braveWebResponse([]));
    await web_search.execute({
      query: "test",
      count: 50,
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(f.mock.calls[0][0]).toContain("count=20");
  });

  it("defaults count to 5", async () => {
    const f = mockFetch(braveWebResponse([]));
    await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(f.mock.calls[0][0]).toContain("count=5");
  });

  it("truncates large responses", async () => {
    const longSnippet = "x".repeat(2000);
    const results = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      description: longSnippet,
    }));
    const f = mockFetch(braveWebResponse(results));
    const result = await web_search.execute({
      query: "test",
      secrets: { BRAVE_SEARCH_API_KEY: "k" },
      fetch: f,
    });
    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThanOrEqual(8000);
  });
});

// ── 11. channel:slack tests ────────────────────────────────

describe("channel:slack", () => {
  describe("config", () => {
    it("declares required secrets", () => {
      expect(slack.config.secrets).toContain("SLACK_BOT_TOKEN");
    });

    it("declares webhook secret env", () => {
      expect(slack.config.webhook_secret_env).toBe("SLACK_SIGNING_SECRET");
    });
  });

  describe("verify", () => {
    const secret = "test_signing_secret";

    async function signRequest(timestamp, rawBody) {
      const encoder = new TextEncoder();
      const sigBase = `v0:${timestamp}:${rawBody}`;
      const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(sigBase));
      const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
      return `v0=${hex}`;
    }

    function makeHeaders(timestamp, signature) {
      return {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      };
    }

    it("returns true for valid HMAC signature with fresh timestamp", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const rawBody = '{"event":"test"}';
      const sig = await signRequest(ts, rawBody);
      const headers = makeHeaders(ts, sig);
      expect(await slack.verify(headers, rawBody, { SLACK_SIGNING_SECRET: secret })).toBe(true);
    });

    it("returns false for invalid signature", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = makeHeaders(ts, "v0=0000000000000000000000000000000000000000000000000000000000000000");
      expect(await slack.verify(headers, '{"event":"test"}', { SLACK_SIGNING_SECRET: secret })).toBe(false);
    });

    it("returns false when timestamp is missing", async () => {
      const headers = { "x-slack-signature": "v0=abc" };
      expect(await slack.verify(headers, "{}", { SLACK_SIGNING_SECRET: secret })).toBe(false);
    });

    it("returns false when signature is missing", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = { "x-slack-request-timestamp": ts };
      expect(await slack.verify(headers, "{}", { SLACK_SIGNING_SECRET: secret })).toBe(false);
    });

    it("returns false when signing secret is not set", async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = makeHeaders(ts, "v0=abc");
      expect(await slack.verify(headers, "{}", {})).toBe(false);
    });

    it("returns false when timestamp is too old (replay protection)", async () => {
      const oldTs = String(Math.floor(Date.now() / 1000) - 600);
      const rawBody = '{}';
      const sig = await signRequest(oldTs, rawBody);
      const headers = makeHeaders(oldTs, sig);
      expect(await slack.verify(headers, rawBody, { SLACK_SIGNING_SECRET: secret })).toBe(false);
    });
  });

  describe("parseInbound", () => {
    it("returns challenge for url_verification", () => {
      const body = { type: "url_verification", challenge: "test_challenge" };
      expect(slack.parseInbound(body)).toEqual({ _challenge: "test_challenge" });
    });

    it("parses a regular message event", () => {
      const body = {
        event: { type: "message", channel: "C123", user: "U456", text: "hello", client_msg_id: "msg-1" },
      };
      const result = slack.parseInbound(body);
      expect(result).toEqual({
        chatId: "C123",
        text: "hello",
        userId: "U456",
        command: null,
        msgId: "msg-1",
        sentTs: null,
      });
    });

    it("sets msgId to null when client_msg_id is missing", () => {
      const body = {
        event: { type: "message", channel: "C1", user: "U1", text: "hi" },
      };
      const result = slack.parseInbound(body);
      expect(result.msgId).toBeNull();
    });

    it("parses a command message", () => {
      const body = {
        event: { type: "message", channel: "C1", user: "U1", text: "/status" },
      };
      const result = slack.parseInbound(body);
      expect(result.command).toBe("status");
    });

    it("ignores bot messages", () => {
      const body = {
        event: { type: "message", channel: "C1", bot_id: "B1", text: "bot msg" },
      };
      expect(slack.parseInbound(body)).toBeNull();
    });

    it("ignores subtypes (message_changed, etc.)", () => {
      const body = {
        event: { type: "message", channel: "C1", user: "U1", text: "x", subtype: "message_changed" },
      };
      expect(slack.parseInbound(body)).toBeNull();
    });

    it("returns null when no event", () => {
      expect(slack.parseInbound({})).toBeNull();
    });

    it("returns null for non-message events", () => {
      const body = { event: { type: "reaction_added" } };
      expect(slack.parseInbound(body)).toBeNull();
    });
  });

  describe("sendReply", () => {
    it("calls Slack chat.postMessage API", async () => {
      const f = vi.fn(async () => ({ ok: true }));
      const secrets = { SLACK_BOT_TOKEN: "xoxb-test" };
      await slack.sendReply("C123", "Hello!", secrets, f);

      expect(f).toHaveBeenCalledOnce();
      const [url, opts] = f.mock.calls[0];
      expect(url).toBe("https://slack.com/api/chat.postMessage");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe("Bearer xoxb-test");
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe("C123");
      expect(body.text).toBe("Hello!");
    });
  });
});

// ── start_job ──────────────────────────────────────────────────

describe("start_job", () => {
  const secrets = { CF_ACCESS_CLIENT_ID: "cid", CF_ACCESS_CLIENT_SECRET: "s", COMPUTER_API_KEY: "k" };
  const config = { jobs: { base_url: "https://test.dev", base_dir: "/tmp/jobs", max_concurrent_jobs: 2, default_ttl_minutes: 60 } };

  it("dispatches a custom job and writes job record", async () => {
    const provider = { call: vi.fn(async () => ({ ok: true, output: [{ data: "12345\r\n" }] })) };
    const kv = mockKV();

    const result = await start_job.execute({
      type: "custom",
      command: "echo hello",
      prompt: "test prompt",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv, config,
    });

    expect(result.ok).toBe(true);
    expect(result.job_id).toMatch(/^j_/);
    expect(result.pid).toBe(12345);
    expect(provider.call).toHaveBeenCalledOnce();

    // Verify job record was written
    const jobKey = [...kv._store.keys()].find(k => k.startsWith("job:"));
    expect(jobKey).toBeTruthy();
    const record = JSON.parse(kv._store.get(jobKey));
    expect(record.status).toBe("running");
    expect(record.type).toBe("custom");
    expect(record.callback_secret).toBeUndefined();
  });

  it("returns error when type is missing", async () => {
    const result = await start_job.execute({
      provider: {}, secrets, fetch: vi.fn(), kv: mockKV(), config,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("type is required");
  });

  it("rejects when concurrency limit reached", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({ status: "running" }),
      "job:j2": JSON.stringify({ status: "running" }),
    });
    const result = await start_job.execute({
      type: "custom", command: "ls", context_keys: [],
      provider: {}, secrets, fetch: vi.fn(), kv, config,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Concurrency limit");
  });

  it("packs context keys into tarball", async () => {
    const provider = { call: vi.fn(async () => ({ ok: true, output: [{ data: "999\r\n" }] })) };
    const kv = mockKV({ "config:defaults": JSON.stringify({ act: {} }), "karma:s1": JSON.stringify([]) });

    const result = await start_job.execute({
      type: "custom", command: "cat *.json", prompt: "analyze",
      context_keys: ["config:defaults", "karma:*"],
      provider, secrets, fetch: vi.fn(), kv, config,
    });

    expect(result.ok).toBe(true);
    expect(result.context_files).toBe(3); // config/defaults.json, karma/s1.json, prompt.txt
  });

  it("generates valid inner script for cc_analysis (no && contamination)", async () => {
    const provider = {
      call: vi.fn(async ({ command }) => {
        expect(command).toContain("base64 -d | sh");
        expect(command).not.toMatch(/sh -c '[^']*&&/);
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    const result = await start_job.execute({
      type: "cc_analysis",
      prompt: "test prompt",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, cc_model: "opus", path_dirs: ["/home/swayambhu/.local/bin"] } },
    });

    expect(result.ok).toBe(true);
  });

  it("injects path_dirs into inner script", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: ["/opt/bin", "/usr/local/custom"] } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    expect(b64Match).toBeTruthy();
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("export PATH=/opt/bin:/usr/local/custom${PATH:+:$PATH}");
  });

  it("escapes cc_model with quotes in inner script", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, cc_model: "model'injection" } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("--model 'model'\\''injection'");
    expect(innerScript).not.toContain("--model model'injection");
  });

  it("filters invalid path_dirs entries", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: ["/valid/path", "not-absolute", "/inject;rm -rf /", 42, "/ok"] } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("export PATH=/valid/path:/ok${PATH:+:$PATH}");
    expect(innerScript).not.toContain("not-absolute");
    expect(innerScript).not.toContain("inject");
  });

  it("wraps custom command in subshell with absolute exit_code path", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "custom",
      command: "python3 analyze.py",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv, config,
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).toContain("(python3 analyze.py)");
    expect(innerScript).toMatch(/echo \$\? > '\/tmp\/jobs\/[^']+\/exit_code'/);
  });

  it("handles non-array path_dirs gracefully", async () => {
    let capturedCommand;
    const provider = {
      call: vi.fn(async ({ command }) => {
        capturedCommand = command;
        return { ok: true, output: [{ data: "12345\r\n" }] };
      }),
    };
    const kv = mockKV();

    await start_job.execute({
      type: "cc_analysis",
      prompt: "test",
      context_keys: [],
      provider, secrets, fetch: vi.fn(), kv,
      config: { jobs: { ...config.jobs, path_dirs: "/not/an/array" } },
    });

    const b64Match = capturedCommand.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sh/);
    const innerScript = Buffer.from(b64Match[1], 'base64').toString('utf8');
    expect(innerScript).not.toContain("export PATH");
  });
});

// ── collect_jobs ─────────────────────────────────────────────

describe("collect_jobs", () => {
  const secrets = { CF_ACCESS_CLIENT_ID: "cid", CF_ACCESS_CLIENT_SECRET: "s", COMPUTER_API_KEY: "k" };
  const config = { jobs: { base_url: "https://test.dev", default_ttl_minutes: 120 } };

  it("detects completed job via exit_code file", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({
        id: "j1", type: "custom", status: "running",
        created_at: new Date().toISOString(),
        workdir: "/tmp/jobs/j1", config: { ttl_minutes: 120 },
      }),
    });
    const provider = {
      call: vi.fn(async ({ command }) => {
        if (command.includes("exit_code")) return { ok: true, output: [{ data: "0\r\n" }] };
        if (command.includes("output.json")) return { ok: true, output: [{ data: '{"result":"done"}\r\n' }] };
        return { ok: true, output: [] };
      }),
    };

    const result = await collect_jobs.execute({ provider, secrets, fetch: vi.fn(), kv, config });

    expect(result.ok).toBe(true);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].job_id).toBe("j1");

    // Job record should be updated
    const job = JSON.parse(kv._store.get("job:j1"));
    expect(job.status).toBe("completed");
    expect(job.exit_code).toBe(0);

    // Job result should be written
    const jobResult = JSON.parse(kv._store.get("job_result:j1"));
    expect(jobResult.result).toEqual({ result: "done" });
  });

  it("reports still running jobs", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({
        id: "j1", type: "custom", status: "running",
        created_at: new Date().toISOString(),
        workdir: "/tmp/jobs/j1", config: { ttl_minutes: 120 },
      }),
    });
    const provider = {
      call: vi.fn(async () => ({ ok: true, output: [{ data: "RUNNING\r\n" }] })),
    };

    const result = await collect_jobs.execute({ provider, secrets, fetch: vi.fn(), kv, config });
    expect(result.still_running).toHaveLength(1);
    expect(result.still_running[0].job_id).toBe("j1");
  });

  it("expires jobs past TTL", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({
        id: "j1", type: "custom", status: "running",
        created_at: new Date(Date.now() - 200 * 60 * 1000).toISOString(), // 200 min ago
        workdir: "/tmp/jobs/j1", config: { ttl_minutes: 120 },
      }),
    });

    const result = await collect_jobs.execute({
      provider: { call: vi.fn() }, secrets, fetch: vi.fn(), kv, config,
    });
    expect(result.expired).toHaveLength(1);
    const job = JSON.parse(kv._store.get("job:j1"));
    expect(job.status).toBe("expired");
  });

  it("quotes workdir in polling commands", async () => {
    const kv = mockKV({
      "job:j1": JSON.stringify({
        id: "j1", type: "custom", status: "running",
        created_at: new Date().toISOString(),
        workdir: "/tmp/jobs/o'reilly", config: { ttl_minutes: 120 },
      }),
    });
    const commands = [];
    const provider = {
      call: vi.fn(async ({ command }) => {
        commands.push(command);
        if (command.includes("exit_code")) return { ok: true, output: [{ data: "0\r\n" }] };
        if (command.includes("output.json")) return { ok: true, output: [{ data: '{"result":"ok"}\r\n' }] };
        return { ok: true, output: [] };
      }),
    };

    await collect_jobs.execute({ provider, secrets, fetch: vi.fn(), kv, config });

    const exitCmd = commands.find(c => c.includes("exit_code"));
    const outputCmd = commands.find(c => c.includes("output.json"));
    expect(exitCmd).toContain("'/tmp/jobs/o'\\''reilly/exit_code'");
    expect(outputCmd).toContain("'/tmp/jobs/o'\\''reilly/output.json'");
  });
});

// ── request_message ───────────────────────────────────────────

describe("request_message", () => {
  it("emits comms_request event with validated contact", async () => {
    const kv = {
      async get(key) {
        if (key === "contact:swami_kevala") return { name: "Swami Kevala" };
        return null;
      },
    };
    const emitEvent = vi.fn(async () => ({ key: "event:test" }));
    const result = await request_message.execute({
      contact: "swami_kevala",
      intent: "ask",
      content: "What should I work on?",
      kv,
      emitEvent,
    });
    expect(result.ok).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith("comms_request", {
      contact: "swami_kevala",
      intent: "ask",
      content: "What should I work on?",
    });
  });

  it("rejects unknown contact slugs", async () => {
    const kv = { async get() { return null; } };
    const emitEvent = vi.fn(async () => ({ key: "event:test" }));
    const result = await request_message.execute({
      contact: "nonexistent",
      intent: "share",
      content: "hello",
      kv,
      emitEvent,
    });
    expect(result.error).toMatch(/unknown contact/i);
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

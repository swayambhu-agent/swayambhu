import { describe, it, expect, vi } from "vitest";
import * as whatsapp from "../channels/whatsapp.js";

// ── Helpers ─────────────────────────────────────────────────

function makeWhatsAppPayload(text = "Hello", from = "919876543210") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "BIZ_ACCOUNT_ID",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "PHONE_123" },
          messages: [{
            id: "wamid.abc123",
            from,
            timestamp: "1711352400",
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function makeStatusPayload() {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "BIZ_ACCOUNT_ID",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "PHONE_123" },
          statuses: [{ id: "wamid.abc123", status: "delivered" }],
        },
      }],
    }],
  };
}

async function computeSignature(body, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

// ── Config ──────────────────────────────────────────────────

describe("whatsapp adapter config", () => {
  it("exports config with secrets and webhook_secret_env", () => {
    expect(whatsapp.config.secrets).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(whatsapp.config.secrets).toContain("WHATSAPP_PHONE_NUMBER_ID");
    expect(whatsapp.config.webhook_secret_env).toBe("WHATSAPP_APP_SECRET");
  });
});

// ── Webhook verification (GET) ──────────────────────────────

describe("verifyWebhook", () => {
  it("returns challenge when verify_token matches", () => {
    const url = new URL("https://example.com/channel/whatsapp?hub.mode=subscribe&hub.verify_token=mytoken&hub.challenge=CHALLENGE_123");
    const result = whatsapp.verifyWebhook(url, { WHATSAPP_VERIFY_TOKEN: "mytoken" });
    expect(result).toBe("CHALLENGE_123");
  });

  it("returns null when verify_token does not match", () => {
    const url = new URL("https://example.com/channel/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE_123");
    const result = whatsapp.verifyWebhook(url, { WHATSAPP_VERIFY_TOKEN: "mytoken" });
    expect(result).toBeNull();
  });

  it("returns null when params are missing", () => {
    const url = new URL("https://example.com/channel/whatsapp");
    const result = whatsapp.verifyWebhook(url, { WHATSAPP_VERIFY_TOKEN: "mytoken" });
    expect(result).toBeNull();
  });
});

// ── Signature verification ──────────────────────────────────

describe("verify", () => {
  const secret = "test_app_secret";

  it("returns true for valid signature", async () => {
    const body = '{"test":"data"}';
    const sig = await computeSignature(body, secret);
    const headers = new Headers({ "X-Hub-Signature-256": sig });
    const result = await whatsapp.verify(headers, body, { WHATSAPP_APP_SECRET: secret });
    expect(result).toBe(true);
  });

  it("returns false for invalid signature", async () => {
    const headers = new Headers({ "X-Hub-Signature-256": "sha256=bad" });
    const result = await whatsapp.verify(headers, '{"test":"data"}', { WHATSAPP_APP_SECRET: secret });
    expect(result).toBe(false);
  });

  it("returns false when header is missing", async () => {
    const headers = new Headers();
    const result = await whatsapp.verify(headers, '{"test":"data"}', { WHATSAPP_APP_SECRET: secret });
    expect(result).toBe(false);
  });

  it("returns false when secret is missing", async () => {
    const headers = new Headers({ "X-Hub-Signature-256": "sha256=abc" });
    const result = await whatsapp.verify(headers, '{"test":"data"}', {});
    expect(result).toBe(false);
  });
});

// ── Parse inbound ───────────────────────────────────────────

describe("parseInbound", () => {
  it("parses a text message", () => {
    const result = whatsapp.parseInbound(makeWhatsAppPayload("Hello world"));
    expect(result).toMatchObject({
      chatId: "919876543210",
      text: "Hello world",
      userId: "919876543210",
      command: null,
      msgId: "wamid.abc123",
    });
  });

  it("parses a command", () => {
    const result = whatsapp.parseInbound(makeWhatsAppPayload("/reset"));
    expect(result.command).toBe("reset");
  });

  it("returns null for status webhooks (delivery receipts)", () => {
    const result = whatsapp.parseInbound(makeStatusPayload());
    expect(result).toBeNull();
  });

  it("returns null for non-whatsapp objects", () => {
    const result = whatsapp.parseInbound({ object: "other" });
    expect(result).toBeNull();
  });

  it("returns null for empty messages", () => {
    const payload = makeWhatsAppPayload();
    payload.entry[0].changes[0].value.messages = [];
    const result = whatsapp.parseInbound(payload);
    expect(result).toBeNull();
  });

  it("skips non-text messages (image, audio)", () => {
    const payload = makeWhatsAppPayload();
    payload.entry[0].changes[0].value.messages = [{
      id: "wamid.img", from: "919876543210", type: "image",
      image: { mime_type: "image/jpeg" },
    }];
    const result = whatsapp.parseInbound(payload);
    expect(result).toBeNull();
  });

  it("extracts phone_number_id from metadata", () => {
    const result = whatsapp.parseInbound(makeWhatsAppPayload());
    expect(result._phoneNumberId).toBe("PHONE_123");
  });
});

// ── Resolve chat key ────────────────────────────────────────

describe("resolveChatKey", () => {
  it("returns userId (phone number)", () => {
    const result = whatsapp.resolveChatKey({ userId: "919876543210", chatId: "919876543210" });
    expect(result).toBe("919876543210");
  });
});

// ── Send reply ──────────────────────────────────────────────

describe("sendReply", () => {
  it("sends a text message via Graph API", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await whatsapp.sendReply("919876543210", "Hello!", {
      WHATSAPP_ACCESS_TOKEN: "tok",
      WHATSAPP_PHONE_NUMBER_ID: "PHONE_123",
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/PHONE_123/messages");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.to).toBe("919876543210");
    expect(body.text.body).toBe("Hello!");
    expect(body.messaging_product).toBe("whatsapp");
  });
});

# Adding a New Channel

Step-by-step guide for integrating a new messaging platform. Uses Slack
(`channels/slack.js`) as the reference implementation throughout.

---

## 1. Create the Channel Adapter

Create `channels/{name}.js`. Must export `config`, `verify`,
`parseInbound`, and `sendReply`. **No `export default`** — required for
`wrapChannelAdapter` compatibility (see
[tools-reference.md](tools-reference.md#scopedkv) for the same constraint
on tools).

### config

```js
export const config = {
  secrets: ["MYPLATFORM_BOT_TOKEN"],       // env vars needed by sendReply
  webhook_secret_env: "MYPLATFORM_SECRET", // env var for verify()
};
```

`secrets` determines which env vars are passed to `sendReply` in prod.
`webhook_secret_env` is passed to `verify` as part of `env_vars`
(`brainstem.js:168-173`).

### verify(headers, rawBody, env)

Validates webhook authenticity. Called with the raw request body (before
JSON parse) and request headers.

```js
export async function verify(headers, rawBody, env) {
  // Validate signature using env[config.webhook_secret_env]
  // Return true if valid, false otherwise
}
```

**Requirements:**
- Access headers via both `headers.get("X-Header")` and
  `headers["x-header"]` — prod passes a `Headers` object (reconstructed
  from `Object.fromEntries`), tests pass plain objects
- Implement replay protection (Slack uses a 5-minute timestamp window)
- Use constant-time comparison for signature checks

**Dev mode:** Verification is skipped entirely in `brainstem-dev.js:70`.

### parseInbound(body)

Parses the platform's webhook payload into a normalized inbound object.

```js
export function parseInbound(body) {
  // Return null if the event should be ignored
  return {
    chatId: "channel_or_thread_id",  // conversation identifier
    text: "message content",          // user's message
    userId: "platform_user_id",       // sender ID (used for contact resolution)
    command: "reset" | null,          // if text starts with /
    msgId: "unique_msg_id" | null,    // for deduplication (null = no dedup)
    // _challenge: "token",           // only for URL verification flows
  };
}
```

**Key behaviors:**
- Return `null` for events to ignore (bot messages, edits, reactions)
- Return `{ _challenge: token }` for platform URL verification — the
  kernel echoes it back as `{ challenge: token }` with 200
  (`brainstem.js:201-204`)
- `chatId` determines conversation scope — all messages with the same
  `chatId` share one `chat:state:{channel}:{chatId}` record
- `msgId` enables deduplication via `dedup:{msgId}` keys with 30s TTL

### sendReply(chatId, text, secrets, fetchFn)

Sends a message back to the platform.

```js
export async function sendReply(chatId, text, secrets, fetchFn) {
  await fetchFn("https://api.platform.com/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secrets.MYPLATFORM_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: chatId, text }),
  });
}
```

**Important:** Use the `fetchFn` parameter, not global `fetch`. In prod
the isolate injects its own `fetch`; in dev the global `fetch` is passed
explicitly.

---

## 2. Seed into KV

Add two entries in `scripts/seed-local-kv.mjs` under the channel adapters
section (~line 198):

```js
// ── Channel adapters ──────────────────────────────────────────
await put("channel:{name}:code", read("channels/{name}.js"), "text", "{Name} channel adapter");
await put("channel:{name}:config", {
  secrets: ["MYPLATFORM_BOT_TOKEN"],
  webhook_secret_env: "MYPLATFORM_SECRET",
}, "json", "{Name} channel config");
```

The `:code` key stores the raw source. The `:config` key stores the same
object as the `config` export — the kernel reads it separately to know
which env vars to inject before loading the adapter code.

> **NOTE:** The config in KV must match the `config` export. The kernel
> reads `channel:{name}:config` from KV in prod (`brainstem.js:162`), not
> the adapter's `config` export. The export is only used in dev mode
> (where the module is imported directly).

---

## 3. Register in brainstem-dev.js

Add the import and `CHANNEL_ADAPTERS` entry at the top of
`brainstem-dev.js`:

```js
import * as myplatformAdapter from './channels/myplatform.js';

const CHANNEL_ADAPTERS = {
  slack: slackAdapter,
  myplatform: myplatformAdapter,   // ← add here
};
```

The dev fetch handler (`brainstem-dev.js:64`) looks up adapters from this
map. Without this entry, `POST /channel/myplatform` returns 404 in dev.

---

## 4. Set Up Contact Index Entries

The kernel resolves senders via `contact_index:{platform}:{userId}` →
contact slug. These entries are created by:

1. **Dashboard API** — `POST /contacts` writes index entries for each
   platform in the contact's `platforms` object
2. **Kernel cache-on-miss** — `resolveContact()` scans all `contact:*`
   records on cache miss, writes the index entry when found
   (`brainstem.js:402`)

For existing contacts, add the new platform to their `platforms` field:

```js
// In seed-local-kv.mjs, update the contact record
await put("contact:swami_kevala", {
  // ...existing fields...
  platforms: {
    slack: "U084ASKBXB7",
    myplatform: "user_12345",   // ← add platform mapping
  },
  // ...
});
```

The first message from that user triggers a `resolveContact()` call,
which scans contacts and caches the index entry automatically.

For new contacts, create them via the dashboard API (`POST /contacts`) or
seed them directly. See
[communication-gating.md](communication-gating.md#contact-records) for the
full contact record schema.

---

## 5. Configure Channel-Specific Chat Settings

Per-contact chat config overrides global defaults. Add to the contact's
`chat` field:

```js
{
  chat: {
    model: "sonnet",                    // LLM model
    effort: "high",                     // LLM effort
    max_cost_per_conversation: 1.00,    // budget ceiling
    max_output_tokens: 2000,            // per-response token limit
    max_tool_rounds: 5,                 // tool-calling loop iterations
    max_history_messages: 40,           // conversation window
  }
}
```

Config resolution: `{ ...defaults.chat, ...contact.chat }` — contact
settings override globals. See
[chat-system.md](chat-system.md#step-3-config-resolution) for the full
config table.

---

## 6. Webhook Endpoint

The kernel handles `POST /channel/{name}` automatically — no routing
changes needed. The `{name}` in the URL maps directly to the KV key
`channel:{name}:code`.

**Prod** (`brainstem.js:147-245`):

```
POST /channel/{name}
  → load channel:{name}:code from KV
  → runInIsolate(verify) with env vars from config
  → runInIsolate(parseInbound)
  → deduplication check
  → return 200
  → background: loadEagerConfig → handleChat()
```

**Dev** (`brainstem-dev.js:53-105`):

```
POST /channel/{name}
  → CHANNEL_ADAPTERS[name] (direct import)
  → skip verification
  → parseInbound() (direct call)
  → deduplication check
  → return 200
  → background: loadEagerConfig → handleChat()
```

The webhook URL to configure on the platform: `https://{worker-domain}/channel/{name}` (prod) or `http://localhost:8787/channel/{name}` (dev).

---

## 7. Webhook Signature Verification

In prod, verification runs in a Worker Loader isolate
(`brainstem.js:175-183`). The kernel:

1. Reads `channel:{name}:config` to find `secrets` and
   `webhook_secret_env`
2. Collects matching env vars into `envVars`
3. Wraps adapter code with `Brainstem.wrapChannelAdapter()` — appends an
   `export default { fetch() }` handler that dispatches by `ctx.action`
4. Calls `runInIsolate` with `action: "verify"`, passing headers (as plain
   object), raw body, and env vars
5. Returns 401 if `!verified.ok`

The `wrapChannelAdapter` wrapper (`brainstem.js:1334-1361`) handles three
actions:

| Action | Calls | Timeout |
|--------|-------|---------|
| `verify` | `verify(headers, rawBody, env_vars)` | 5s |
| `parse` | `parseInbound(body)` | 5s |
| `send` | `sendReply(chatId, text, secrets, fetch)` | 10s |

---

## 8. Communication Tool Integration

If the new channel has a dedicated send tool (like `send_slack` for
Slack), add `communication` metadata to the tool's `meta` export:

```js
export const meta = {
  // ...
  communication: {
    channel: "myplatform",
    recipient_field: "channel",      // which arg holds the recipient
    reply_field: null,               // arg that indicates a reply (null = always initiating)
    content_field: "text",           // which arg holds the message content
    recipient_type: "destination",   // "destination" or "person"
  },
};
```

This triggers the kernel's outbound communication gate before execution.
See [communication-gating.md](communication-gating.md#outbound-communication-gate)
for the full gate flow.

**`recipient_type` determines the mechanical floor:**
- `"destination"` — never blocked (like posting to a channel)
- `"person"` — blocked for unknown recipients when initiating

If the channel also receives inbound content that should be gated (like
`check_email`), add `inbound` metadata to the reading tool:

```js
export const meta = {
  // ...
  inbound: {
    channel: "myplatform",
    sender_field: "sender_id",     // field in result items with sender ID
    content_field: "body",         // field to redact for unknown senders
    result_array: "messages",      // array field in the result to inspect
  },
};
```

---

## 9. Testing

### Adapter tests in tools.test.js

Follow the `channel:slack` test pattern (~line 957):

```js
describe("channel:myplatform", () => {
  describe("config", () => {
    it("declares required secrets", () => { ... });
    it("declares webhook secret env", () => { ... });
  });

  describe("verify", () => {
    // Valid signature, invalid signature, missing fields, replay protection
  });

  describe("parseInbound", () => {
    // Normal message, bot/system messages filtered, commands, challenge
  });

  describe("sendReply", () => {
    // API call with correct headers and body
  });
});
```

Add the import at the top of `tools.test.js`:

```js
import * as myplatform from "../channels/myplatform.js";
```

Also add `wrapAsModule` compatibility tests (no `export default`):

```js
it("channels/myplatform.js has no export default", () => {
  const src = readFileSync(resolve(__dirname, "../channels/myplatform.js"), "utf8");
  expect(src).not.toMatch(/export\s+default/);
});
```

### Chat flow tests in chat.test.js

The existing `chat.test.js` tests are channel-agnostic — `handleChat`
receives a channel name string and an adapter object. New channels don't
need separate chat tests unless they introduce channel-specific behavior.

### Integration test

After seeding and starting dev:

```bash
# Simulate an inbound message
curl -X POST http://localhost:8787/channel/myplatform \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"message","text":"hello","user":"test123","channel":"C001"}}'
```

Watch stderr for `[KARMA]` entries showing `chat_turn` events.

---

## 10. Deploy

### Environment variables

Add secrets via wrangler CLI:

```bash
wrangler secret put MYPLATFORM_BOT_TOKEN
wrangler secret put MYPLATFORM_SECRET
```

Document them in `wrangler.toml` comments:

```toml
# Secrets (set via: wrangler secret put SECRET_NAME)
# MYPLATFORM_BOT_TOKEN
# MYPLATFORM_SECRET
```

### KV seeding

Prod KV is seeded separately from local dev. Ensure the channel's
`:code` and `:config` keys are present in the production KV namespace.

### Checklist

1. `channels/{name}.js` — exports `config`, `verify`, `parseInbound`, `sendReply`
2. `scripts/seed-local-kv.mjs` — seeds `channel:{name}:code` and `channel:{name}:config`
3. `brainstem-dev.js` — adapter added to `CHANNEL_ADAPTERS`
4. Contact records — `platforms.{name}` added for known users
5. Secrets — set via `wrangler secret put` for prod
6. `wrangler.toml` — secrets documented in comments
7. Tests — adapter tests in `tools.test.js`, `wrapAsModule` check
8. (Optional) Send tool — with `communication` metadata for outbound gating
9. (Optional) Read tool — with `inbound` metadata for content gating
10. Webhook URL configured on the platform

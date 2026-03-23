# Tool & Provider Reference

Complete reference for all tools and provider adapters. Tools live in
`tools/*.js`, providers in `providers/*.js`. Both are single-source-of-truth
— dev imports them directly, the seed script reads them into KV for prod.

---

## Registry Tools

Nine tools registered in `config:tool_registry`. Each has a `meta` export
(consumed by the kernel for sandboxing and gate decisions) and an `execute`
function.

### send_slack

**File:** `tools/send_slack.js`
**Purpose:** Post a message to a Slack channel.

| Meta field | Value |
|-----------|-------|
| `secrets` | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` |
| `kv_access` | `none` |
| `timeout_ms` | 10000 |
| `communication` | `{ channel: "slack", recipient_field: "channel", reply_field: null, content_field: "text", recipient_type: "destination" }` |

Input: `{ text, channel }`. If `channel` is omitted, falls back to
`SLACK_CHANNEL_ID` secret.

**Comms gate:** Triggers the outbound communication gate. `recipient_type:
"destination"` means the mechanical floor never blocks it — always proceeds
to the LLM gate. `reply_field: null` means mode is always `"initiating"`.

---

### send_email

**File:** `tools/send_email.js`
**Purpose:** Send an email or reply to a thread via Gmail.

| Meta field | Value |
|-----------|-------|
| `secrets` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `kv_access` | `none` |
| `timeout_ms` | 15000 |
| `provider` | `gmail` |
| `communication` | `{ channel: "email", recipient_field: "to", reply_field: "reply_to_id", content_field: "body", recipient_type: "person" }` |

Input: `{ to, subject, body, reply_to_id }`. `subject` optional when
replying (derived from original). Uses the gmail provider for token refresh
and message sending.

**Comms gate:** `recipient_type: "person"` means the mechanical floor
blocks emails to unknown recipients when initiating. `reply_field:
"reply_to_id"` means if `reply_to_id` is provided, mode is `"responding"`,
which skips the mechanical floor.

---

### check_email

**File:** `tools/check_email.js`
**Purpose:** Fetch unread emails from Gmail.

| Meta field | Value |
|-----------|-------|
| `secrets` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `kv_access` | `none` |
| `timeout_ms` | 15000 |
| `provider` | `gmail` |
| `inbound` | `{ channel: "email", sender_field: "sender_email", content_field: "body", result_array: "emails" }` |

Input: `{ mark_read, max_results }`. Defaults: `mark_read = true`,
`max_results = 10` (capped at 20).

**Inbound gate:** After execution, the kernel inspects each item in
`result.emails`. For each email, it checks `sender_email` against
`resolveContact("email", sender_email)`. Unknown senders have their `body`
redacted and the original content quarantined under `sealed:quarantine:*`.

---

### web_fetch

**File:** `tools/web_fetch.js`
**Purpose:** Fetch a URL and return its content.

| Meta field | Value |
|-----------|-------|
| `secrets` | `[]` |
| `kv_access` | `none` |
| `timeout_ms` | 15000 |

Input: `{ url, headers, method, max_length }`. Default method: `GET`.
Response body truncated at `max_length` (default 10000 chars).

Returns: `{ status, body }`.

---

### kv_query

**File:** `tools/kv_query.js`
**Purpose:** Read and navigate KV values with dot-path and array index
access.

| Meta field | Value |
|-----------|-------|
| `secrets` | `[]` |
| `kv_access` | `read_all` |
| `timeout_ms` | 5000 |

Input: `{ key, path }`. `path` supports dot notation (`a.b.c`) and array
indices (`items[0].name`).

Returns the value directly for small objects (<=10 keys, no nested arrays).
For large or complex structures, returns a summary with field descriptions.
Arrays return item count and brief signatures per element.

**Path parsing:** Handles `[n]` for array index, `.key` for object access.
Returns helpful errors with `available_keys` on key-not-found.

---

### kv_write

**File:** `tools/kv_write.js`
**Purpose:** Write a value to tool-scoped KV storage.

| Meta field | Value |
|-----------|-------|
| `secrets` | `[]` |
| `kv_access` | `own` |
| `timeout_ms` | 5000 |

Input: `{ key, value }`. Strings written as-is, objects JSON-serialized.

With `kv_access: "own"`, writes are scoped to `tooldata:kv_write:*`. Reads
are also scoped — this tool can only access its own data.

---

### kv_manifest

**File:** `tools/kv_manifest.js`
**Purpose:** List KV keys with optional prefix filter.

| Meta field | Value |
|-----------|-------|
| `secrets` | `[]` |
| `kv_access` | `read_all` |
| `timeout_ms` | 5000 |

Input: `{ prefix, limit }`. Limit capped at 500, default 100.

Returns: `{ keys: [{ key, metadata }], list_complete, count }`.

With `kv_access: "read_all"`, can list all keys except those under
`sealed:*` (filtered by ScopedKV).

---

### computer

**File:** `tools/computer.js`
**Purpose:** Execute shell commands on your Linux server.

| Meta field | Value |
|-----------|-------|
| `secrets` | `COMPUTER_CF_CLIENT_ID`, `COMPUTER_API_KEY` |
| `kv_access` | `none` |
| `timeout_ms` | 300000 (5 minutes) |

Input: `{ command, timeout }`. Default timeout: 60 seconds (server-side
wait parameter).

POSTs to `https://akash.swayambhu.dev/execute?wait={timeout}` with
Cloudflare Access client ID and bearer token auth. Returns `{ ok, status,
exit_code, output, process_id }`.

Used by git sync to push modifications to the self-repository.

---

### test_model

**File:** `tools/test_model.js`
**Purpose:** Make a test completion against a model to verify it works before
assigning it to a role.

| Meta field | Value |
|-----------|-------|
| `secrets` | `OPENROUTER_API_KEY` |
| `kv_access` | `none` |
| `timeout_ms` | 30000 |
| `provider` | `llm` |

Input: `{ model_id, prompt, max_tokens }`. `model_id` and `prompt` required.
`prompt` capped at 1000 chars. `max_tokens` default 100, capped at 500.

Returns: `{ success, response_text, usage, latency_ms, error }`.

**Cost tracking:** Calls `provider.call()` directly, bypassing `callLLM()` —
cost is NOT tracked in `sessionCost` and no LLM karma is recorded. The hard
caps (500 max_tokens, 1000 char prompt) keep worst-case cost small (~$0.01).
Usage stats are returned in the tool result and visible via karma.

---

## Built-in Tools

Three tools are hardcoded in the kernel — not loaded from KV, not
executed in isolates.

### spawn_subplan

`kernel.js:1617` (definition), `kernel.js:1787` (implementation)

Spawns a nested agent loop for independent sub-tasks.

**Parameters:**
- `goal` (required) — what the subplan should achieve
- `model` (optional) — model alias, default `haiku`
- `max_steps` (optional) — max turns, default 5

**Behavior:**

1. Checks depth against `defaults.execution.max_subplan_depth` (default 3)
   — rejects if limit reached
2. Loads `prompt:subplan` from KV, falls back to `defaultSubplanPrompt()`
3. Resolves model (default: haiku via fallback model)
4. Gets same tool definitions as parent (including `spawn_subplan` itself
   — but depth check prevents infinite recursion)
5. Calls `runAgentLoop` with `step: "subplan_d{depth}"`, effort `"low"`

Multiple `spawn_subplan` calls in one LLM turn execute in parallel (via
the agent loop's `Promise.all` on tool calls).

### check_balance

`kernel.js:1179`

Checks balances for all configured providers and wallets.

**Parameters:**
- `scope` (optional) — filter to a specific scope

**Behavior:**

1. Loads `providers` and `wallets` KV keys
2. For each provider/wallet with an `adapter` field: calls
   `executeAdapter(config.adapter, {}, secretOverrides)`
3. Secret overrides support `"kv:secret:key_name"` values that resolve
   from KV at runtime
4. Returns `{ providers: { name: { balance, scope } }, wallets: { ... } }`

### verify_patron

`kernel.js` (definition in `buildToolDefinitions`, dispatch in
`executeToolCall`, implementation in `verifyPatron`)

Verifies the patron's identity by checking an Ed25519 signature against
the immutable `patron:public_key`.

**Parameters:**
- `message` (required) — the exact message that was signed
- `signature` (required) — base64-encoded Ed25519 signature

**Behavior:**

1. Loads `patron:public_key` from KV
2. Parses SSH ed25519 wire format to extract 32-byte raw key
   (`Brainstem.parseSSHEd25519`)
3. Imports key via `crypto.subtle.importKey("raw", ..., "Ed25519")`
4. Verifies signature via `crypto.subtle.verify("Ed25519", ...)`
5. Records `patron_verified` or `patron_verification_failed` karma event
6. Returns `{ verified: true }` or `{ verified: false }`

The agent uses this when it needs to confirm someone is really the
patron — e.g. after the patron identity monitor detects unusual
behavior from the patron's Slack account. The patron signs a challenge
message locally with `scripts/patron-sign.mjs` and sends the signature
in chat.

**Key rotation** is handled by `rotatePatronKey()` (exposed on
`KernelRPC`, not as a tool). It requires a signature from the current
key holder proving they authorize the rotation. The new key is written
directly to KV, bypassing the immutability guard.

---

## Tool Availability Matrix

| Tool | Orient | Session reflect | Deep reflect | Chat (known) | Chat (unknown) | Subplan |
|------|--------|----------------|--------------|-------------|---------------|---------|
| send_slack | yes | no | yes | yes | allowlist | yes |
| send_email | yes | no | yes | yes | allowlist | yes |
| check_email | yes | no | yes | yes | allowlist | yes |
| web_fetch | yes | no | yes | yes | allowlist | yes |
| kv_query | yes | no | yes | yes | allowlist | yes |
| kv_write | yes | no | yes | yes | allowlist | yes |
| kv_manifest | yes | no | yes | yes | allowlist | yes |
| computer | yes | no | yes | yes | allowlist | yes |
| test_model | yes | no | yes | yes | allowlist | yes |
| spawn_subplan | yes | no | **no** | yes | allowlist | yes |
| check_balance | yes | no | yes | yes | allowlist | yes |
| verify_patron | yes | no | yes | yes | allowlist | yes |

**Session reflect:** `tools: []` — no tools at all (`reflect.js:52`).

**Deep reflect:** All tools except `spawn_subplan`
(`reflect.js:134-135`).

**Chat (unknown):** Only tools in `config:defaults.chat.unknown_contact_tools`
allowlist. Empty by default = no tools.

**Chat (known):** Full `buildToolDefinitions()` including `spawn_subplan`
and `verify_patron`.

---

## ScopedKV

`kernel.js:19` (prod — `ScopedKV` kernel method), `index.js:185` (dev — `_buildScopedKV`)

Tools with `kv_access` other than `"none"` receive a scoped KV object in
their execution context. Two access levels:

### "own" — tool-private storage

Used by: `kv_write`

| Operation | Behavior |
|-----------|----------|
| `get(key)` | Reads `tooldata:{toolName}:{key}` |
| `put(key, value)` | Writes `tooldata:{toolName}:{key}` |
| `list(opts)` | Lists `tooldata:{toolName}:{prefix}`, strips scope prefix from returned key names |

The tool sees bare key names — it doesn't know about the `tooldata:` prefix.

### "read_all" — read any key, write to own scope

Used by: `kv_query`, `kv_manifest`

| Operation | Behavior |
|-----------|----------|
| `get(key)` | Reads `key` directly (no prefix). Returns `null` for `sealed:*` keys. |
| `put(key, value)` | Writes `tooldata:{toolName}:{key}` (always scoped) |
| `list(opts)` | Lists all keys matching opts. Filters out `sealed:*` keys from results. |

**Key security properties:**
- `sealed:*` keys are never readable through ScopedKV (both levels)
- Writes are always scoped to `tooldata:{toolName}:*` regardless of
  access level — a tool with `read_all` can read any key but can only
  write to its own namespace
- Metadata on writes includes `{ type: "tooldata", format, updated_at }`

---

## Provider Adapters

Four provider modules. Each exports a `meta` with `secrets` and
`timeout_ms`, plus one or more callable functions.

### llm.js — LLM Provider

**File:** `providers/llm.js`
**Purpose:** OpenRouter chat completions — the actual LLM call.

| Meta field | Value |
|-----------|-------|
| `secrets` | `OPENROUTER_API_KEY` |
| `timeout_ms` | 60000 |

**Function:** `call({ model, messages, max_tokens, thinking, tools, secrets, fetch })`

Sends to `https://openrouter.ai/api/v1/chat/completions`. Adds
`provider.require_parameters` for thinking models. Sets `cache_control:
ephemeral` for Anthropic models. Returns `{ content, usage, toolCalls }`.

Used by the kernel's provider cascade (`callWithCascade`) in prod. In dev,
`Brainstem.callWithCascade` makes the OpenRouter call directly instead
of going through this adapter.

### llm_balance.js — OpenRouter Balance

**File:** `providers/llm_balance.js`
**Purpose:** Check remaining OpenRouter credit.

| Meta field | Value |
|-----------|-------|
| `secrets` | `OPENROUTER_API_KEY` |
| `timeout_ms` | 10000 |

**Function:** `check({ secrets, fetch })`

Calls `https://openrouter.ai/api/v1/auth/key`. Returns
`limit_remaining` or `usage` from the response.

Used by `checkBalance` to report OpenRouter balance in orient context.

### wallet_balance.js — Base USDC Balance

**File:** `providers/wallet_balance.js`
**Purpose:** Check USDC balance on Base network.

| Meta field | Value |
|-----------|-------|
| `secrets` | `WALLET_ADDRESS` |
| `timeout_ms` | 10000 |

**Function:** `check({ secrets, fetch })`

Calls `eth_call` on the USDC contract (`0x8335...2913`) with
`balanceOf(wallet)`. Tries three RPC endpoints in sequence
(blastapi, meowrpc, base.org) — falls back on failure. Returns balance
in USDC (raw hex divided by 1e6).

### gmail.js — Gmail API Adapter

**File:** `providers/gmail.js`
**Purpose:** Gmail API operations — used by `check_email` and `send_email`
tools.

| Meta field | Value |
|-----------|-------|
| `secrets` | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |
| `timeout_ms` | 15000 |

**Functions:**

| Function | Purpose |
|----------|---------|
| `getAccessToken(secrets, fetch)` | OAuth2 refresh token → access token |
| `listUnread(token, fetch, maxResults)` | List unread message stubs (`is:unread`) |
| `getMessage(token, fetch, id)` | Get full message (headers + body) |
| `sendMessage(token, fetch, { to, subject, body, inReplyTo, threadId })` | Send or reply with threading headers |
| `markAsRead(token, fetch, id)` | Remove UNREAD label |
| `check({ secrets, fetch })` | Returns unread count (used as provider balance check) |

Body extraction: prefers `text/plain`, falls back to `text/html` (stripped
of tags), recurses into multipart payloads up to depth 10.

Send message: constructs raw RFC 2822 message, base64url-encodes it, POSTs
to Gmail send endpoint. Threading via `In-Reply-To` and `References`
headers.

> **NOTE:** `gmail.check()` is exported and follows the provider `check`
> pattern, but it is not currently called at runtime. No entry in the
> `providers` KV config points to gmail as a balance-check adapter. The
> gmail provider is only used via tool grant `provider` references from
> `check_email` and `send_email`.

---

## Provider Dependencies

Tools whose `kernel:tool_grants` entry includes a `provider` field receive
the provider module in their execution context as `ctx.provider`. The
provider binding is controlled by the kernel — the agent cannot modify it.

| Tool | Grant `provider` | Functions used |
|------|-----------------|---------------|
| `check_email` | `gmail` | `getAccessToken`, `listUnread`, `getMessage`, `markAsRead` |
| `send_email` | `gmail` | `getAccessToken`, `getMessage` (for replies), `sendMessage` |
| `test_model` | `llm` | `call` |

In prod, the provider code is loaded from `provider:{name}:code` KV and
injected as `ctx.provider`. The kernel looks up the provider in the
`PROVIDERS` map (passed via `index.js`) and injects it directly.

> **NOTE:** Tool source files still declare `provider` in `export const
> meta`, but this field is stripped from KV-stored `tool:{name}:meta` at
> seed time. The runtime reads provider bindings exclusively from
> `kernel:tool_grants`.

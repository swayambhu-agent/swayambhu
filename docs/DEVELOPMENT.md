# Development Guide

## Architecture: two-worker system

The system consists of two Cloudflare Workers sharing one KV namespace:

**Runtime Worker** (`index.js` → `kernel.js` + statically compiled modules):
All tools, providers, channels, and hook modules (`act.js`, `reflect.js`) are
statically imported in `index.js` and passed to the kernel via dependency
injection.

**Governor Worker** (`governor/`): Reads approved code from KV, generates
`index.js`, and deploys the runtime via the CF Workers API. Optional for
local dev — `index.js` is hand-written and imports directly from disk.

## What lives where

| Code | Location | How it runs |
|------|----------|-------------|
| Kernel (KV, karma, agent loop, budget) | `kernel.js` | Statically compiled into runtime worker |
| Session flow, session policy | `act.js` | Statically imported by `index.js` |
| Reflection hierarchy, scheduling | `reflect.js` | Statically imported by `index.js` |
| Chat handler | `hook-chat.js` | Statically imported by `kernel.js` |
| Tool implementations | `tools/*.js` | Statically imported by `index.js` |
| Provider adapters | `providers/*.js` | Statically imported by `index.js` |
| Channel adapters | `channels/*.js` | Statically imported by `index.js` |
| Prompts, config, dharma | `scripts/seed-local-kv.mjs` | KV (same seed script) |

Tools and providers live in `tools/` and `providers/` respectively. **Single
source of truth.** The seed script reads these files directly into KV.

## Running locally

```bash
# Start services (preserves existing state)
source .env && bash scripts/start.sh

# Start + trigger a session
source .env && bash scripts/start.sh --trigger

# Full reset + trigger
source .env && bash scripts/start.sh --reset-all-state --trigger
```

Watch stderr for `[KARMA]`, `[TOOL]`, `[LLM]`, `[HOOK]`, `[CHAT]` tagged output.

### Switching models for cheap testing

The seed script seeds the canonical production models (Claude Opus / Sonnet /
Haiku). For basic dev work — testing tool wiring, KV operations, orient flow,
prompt formatting — you don't need expensive models. Use `--set` overrides
when starting with `--reset-all-state`:

```bash
# Full reset with DeepSeek for all roles (~30x cheaper than Claude)
source .env && bash scripts/start.sh --reset-all-state --set orient.model=deepseek --set reflect.model=deepseek

# Override just one role
source .env && bash scripts/start.sh --reset-all-state --set orient.model=deepseek
```

Model aliases (e.g. `deepseek` for `deepseek/deepseek-v3.2`) are resolved
at runtime via `config:models` alias_map.

**When to use cheap models:** tool execution, orient sessions, basic
sessions, KV read/write, prompt template rendering, budget enforcement.

**When to use real models:** reflection hierarchy, proposal
staging/promotion/rollback, deep reflect, anything where output quality
and structured JSON adherence matter.

## Making changes: what to edit and where changes propagate

### 1. Kernel logic (kernel.js)

Examples: budget enforcement, karma recording, agent loop, KV helpers,
session outcome tracking, safety checks, proposal methods.

**Edit:** `kernel.js`
**Propagation:** Automatic. All modules use the K interface provided by the kernel.
**Nothing else to do.**

### 2. Session policy (act.js)

Examples: orient session, context building, session results.

**Edit:** `act.js`
**Propagation:** Automatic — statically imported by `index.js`.
**For prod deploy:** Re-seed KV so the governor picks up the new version:
```bash
node scripts/seed-local-kv.mjs
```

### 3. Reflection / proposal system (reflect.js)

Examples: reflect hierarchy, proposal staging/promotion/rollback,
circuit breaker, tripwire evaluation, session results.

**Edit:** `reflect.js`
**Propagation:** Automatic — statically imported by `index.js`.
**For prod deploy:** Re-seed KV.

### 4. Tool implementations

Examples: changing how `send_slack` works, adding a new tool.

#### Modifying an existing tool

1. Edit `tools/{name}.js`
2. Dev picks it up automatically (imported in `index.js`)
3. Re-seed for KV: `node scripts/seed-local-kv.mjs`

#### Adding a new tool

1. Create `tools/{name}.js` with `export const meta` and `export async function execute`
2. Add `import * as {name} from './tools/{name}.js'` to `index.js`
3. Add `{name}` to the `TOOLS` object in `index.js`
4. Add the tool to the `config:tool_registry` JSON in the seed script
5. Add the tool name to the tool loop in the seed script
6. Re-seed: `node scripts/seed-local-kv.mjs`

#### Removing a tool

1. Remove `tools/{name}.js`
2. Remove import and `TOOLS` entry from `index.js`
3. Remove from `config:tool_registry` and the tool loop in the seed script
4. Re-seed

### 5. Prompts and config

Examples: changing `prompt:orient`, `config:defaults`, `config:models`.

**Edit:** The source file (e.g. `prompts/reflect.md`, `config/defaults.json`)
**Propagation:** Write the single key to KV, or re-seed for bulk changes:
```bash
# Single key update (no full reseed needed)
node scripts/write-kv.mjs prompt:act prompts/act.md
node scripts/write-kv.mjs config:defaults config/defaults.json

# Full reseed
node scripts/seed-local-kv.mjs
```
**Nothing to change in index.js.**

### 6. Provider adapters

Provider code lives in `providers/*.js`. The kernel uses statically imported
provider modules for the LLM cascade and balance checks.

If you change the request/response format (e.g. adding a new field to the
OpenRouter call), update `providers/llm.js`. The kernel's fallback tier
uses a direct fetch to OpenRouter as the last resort.

## The tool module contract

Each file in `tools/` exports:

```js
export const meta = {
  secrets: ["ENV_VAR_NAME"],        // resolved from env
  kv_access: "none"|"own"|"read_all",
  timeout_ms: 10000,
};

export async function execute(ctx) { ... }
```

The `ctx` object passed to `execute` contains:
- All tool input fields (e.g. `ctx.text`, `ctx.url`, `ctx.key`)
- `ctx.secrets` — object with resolved secret values
- `ctx.fetch` — global fetch
- `ctx.kv` — scoped KV accessor (only if `kv_access !== "none"`)
- `ctx.provider` — provider module (only if `meta.provider` is set)

**No `export default`.** Tool files must use only named exports.

## Provider adapters and `meta.provider`

Provider code lives in `providers/*.js`. Each provider exports `meta` and
a callable function (`call`, `check`, or `execute`). Providers handle
external API transport — authentication, request construction, response
parsing, error handling.

### When to use a provider

Use `meta.provider` when a tool needs to call an external API that involves:
- **Authentication** (OAuth token refresh, API key management)
- **Protocol details** (RFC 2822 email construction, base64url encoding)
- **Shared API surface** (multiple tools calling the same service)

The rule: **tools own business logic, providers own transport.** A tool
decides *what* to do (fetch unread emails, send a reply). A provider
knows *how* to talk to the API (refresh OAuth tokens, construct HTTP
requests, parse responses).

### When NOT to use a provider

Don't create a provider for:
- **Simple single-endpoint calls** (e.g. `send_slack` — one POST to one URL)
- **Tool-specific logic** (e.g. `extractEmailAddress` parsing a From header)
- **Anything that doesn't benefit from reuse** across tools

### How it works

Tools declare a provider dependency via `meta.provider`:

```js
// tools/check_email.js
export const meta = {
  secrets: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  kv_access: "none",
  timeout_ms: 15000,
  provider: "gmail",    // ← kernel injects the provider module into ctx
};

export async function execute({ mark_read, max_results, secrets, fetch, provider }) {
  const token = await provider.getAccessToken(secrets, fetch);
  const stubs = await provider.listUnread(token, fetch, limit);
  // ... tool logic using provider functions
}
```

The kernel looks up the provider in the statically imported `PROVIDERS` map
and injects it as `ctx.provider`. The tool calls provider functions
directly.

### Adding a provider-backed tool

1. Create `providers/{name}.js` with exported functions (no `export default`)
2. Create `tools/{tool_name}.js` with `meta.provider: "{name}"`
3. The tool's `meta.secrets` should declare secrets the provider needs
4. In `index.js`: import the provider and add to `PROVIDERS`
5. In `index.js`: import the tool and add to `TOOLS`
6. Add the tool to `config:tool_registry` in the seed script
7. Re-seed: `node scripts/seed-local-kv.mjs`

### Why secrets stay on the tool meta

The tool declares `meta.secrets` (not the provider) because secret
resolution happens in `buildToolContext` before execution. The kernel reads
the tool's `meta.secrets`, resolves them from env/KV, and passes them as
`ctx.secrets`. The tool then threads `secrets` into provider function calls.

## ScopedKV behavior

Tools with `kv_access: "own"` get a KV accessor that:
- **Reads** are prefixed: `tooldata:{toolName}:{key}`
- **Writes** are always prefixed: `tooldata:{toolName}:{key}`
- **List** scopes to `tooldata:{toolName}:` prefix, strips it from results

Tools with `kv_access: "read_all"` get:
- **Reads** use the raw key (full KV access)
- **Writes** are still prefixed (scoped)
- **List** is unscoped

This matches the `_buildScopedKV()` implementation in `kernel.js`.

## Deploying to production

```bash
# Deploy runtime worker (uses wrangler.toml)
npx wrangler deploy

# Seed remote KV (if config/tools/prompts changed)
# Change LOCAL="" in seed script, or use wrangler kv commands directly
```

Production uses `kernel.js` via `index.js` as its main module.

## Inspecting local KV

Local KV is persisted in SQLite at `.wrangler/shared-state/`. Use the
`read-kv` script to inspect it without needing `sqlite3`:

```bash
# List all keys
node scripts/read-kv.mjs

# List keys with a prefix
node scripts/read-kv.mjs karma:
node scripts/read-kv.mjs config:

# Read a specific key's value
node scripts/read-kv.mjs karma:s_1772718337948_o2yj53
node scripts/read-kv.mjs providers

# Raw JSON output (for piping to jq etc.)
node scripts/read-kv.mjs --json providers
```

The script uses Miniflare's API to read the same SQLite store that
`wrangler dev` and the seed script use.

### Writing individual KV keys

To update a single key without a full reseed:

```bash
# From a file (.json → json, .md/other → text)
node scripts/write-kv.mjs prompt:act prompts/act.md
node scripts/write-kv.mjs config:defaults config/defaults.json

# Inline JSON value
node scripts/write-kv.mjs my:key '{"foo": "bar"}'

# From stdin
echo '{"foo": "bar"}' | node scripts/write-kv.mjs my:key --stdin
```

## Debug logging

Background processing errors (e.g. chat handler failures) are written to
`log:{category}:{timestamp}` keys with a 7-day TTL. Karma records reference
these via `log_ref` to keep the audit trail lightweight.

```bash
# List recent logs
node scripts/read-kv.mjs log:

# Read a specific log entry
node scripts/read-kv.mjs log:chat:1711352400000
```

Errors also output to stderr with category tags (e.g. `[CHAT]`) for
real-time visibility during local dev.

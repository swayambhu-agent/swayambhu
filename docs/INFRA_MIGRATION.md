# Infrastructure Migration Guide

What's Cloudflare-specific in kernel.js and what would change for a
platform migration (e.g., Node.js on Linux).

## CF-Specific Code

### KV Namespace (`env.KV` / `this.kv`)

All persistent state — config, tools, hooks, karma logs, session data — is
stored in CF KV. Used throughout via `this.kv.get()`, `this.kv.put()`,
`this.kv.list()`, `this.kv.delete()`, and `this.kv.getWithMetadata()`.

**Migration:** Replace with any key-value store (Redis, SQLite, DynamoDB).
The API surface is small: `get(key, format)`, `put(key, value, { metadata })`,
`list({ prefix })`, `delete(key)`, `getWithMetadata(key, format)`. Write an
adapter matching this interface.

### `scheduled()` Handler

The `export default { scheduled() }` pattern is the CF cron trigger entry
point, declared in `wrangler.toml` under `[triggers]`.

**Migration:** Replace with OS cron, systemd timer, or a scheduler library.
The handler receives `(event, env, ctx)` — `event` has `scheduledTime` and
`cron`, `env` has bindings, `ctx` has `waitUntil()`.

### `wrangler.toml`

Declares all CF bindings:
- `[[kv_namespaces]]` — KV namespace binding
- `[triggers]` — cron schedule
- `[vars]` — environment variables

**Migration:** Replace with environment config (`.env`, config file, or
container env vars). Binding declarations become constructor params or
dependency injection.

## What's Portable (No Changes Needed)

- **Policy modules** (`act.js`, `reflect.js`) — pure policy logic, communicates via K interface
- **LLM calls** — standard HTTP to OpenRouter (`callLLM`, `callWithCascade`)
- **Agent loop** — `runAgentLoop`, `executeToolCall`, `spawnSubplan`
- **Karma logging** — just appends to a KV key (swap the KV layer)
- **Tool context building** — `buildToolContext`, `buildToolDefinitions`
- **Budget enforcement** — pure JS cost/step/duration checks
- **Hook safety** — tripwire logic, session history tracking
- **Prompt building** — `buildPrompt`, template interpolation
- **All business logic** — model resolution, cost estimation, config merging
- **Tool implementations** (`tools/*.js`) — pure functions with `execute(ctx)`
- **Provider adapters** (`providers/*.js`) — standard HTTP calls
- **Channel adapters** (`channels/*.js`) — standard HTTP calls

## Migration Checklist

1. Implement a KV adapter (get/put/list/delete/getWithMetadata)
2. Replace `scheduled()` with a cron/timer entry point
3. Convert `wrangler.toml` bindings to env config
4. Seed the KV store with existing data (`node scripts/seed-local-kv.mjs`)
5. Wire up `index.js` entry point to your platform's request handler

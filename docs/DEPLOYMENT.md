# Dev to Prod Deployment

## What changes between dev and prod

| Aspect | Dev | Prod |
|--------|-----|------|
| Entry point | `index.js` (hand-written, imports from disk) | `index.js` (governor-generated, statically compiled) |
| Config | `wrangler.dev.toml` | `wrangler.toml` |
| Tools/hooks | Imported directly (static imports) | Statically compiled into worker by governor |
| Provider cascade | Direct `fetch()` to OpenRouter (fallback tier) | Three-tier cascade (dynamic → last working → kernel fallback) |
| KV storage | Local SQLite (`.wrangler/shared-state/`) | Cloudflare KV namespace |
| Secrets | `.env` file sourced into shell | `wrangler secret put` per secret |
| Dashboard auth | `OPERATOR_KEY = "test"` in `wrangler.toml` | `wrangler secret put OPERATOR_KEY` with real value |

## Staging: local prod-mode with tunnel

Before deploying to CF, validate everything locally using the kernel
behind a Cloudflare Tunnel.

### Setup

The server runs a `cloudflared` tunnel (config at `~/.cloudflared/config.yml`).
Add an ingress rule for the runtime:

```yaml
ingress:
  - hostname: swayambhu.dev
    service: http://localhost:8787
```

Add a CNAME DNS record in Cloudflare: `swayambhu.dev` → `<tunnel-id>.cfargotunnel.com`
(proxied). Restart `cloudflared` to pick up the config.

### Validation stages

1. **Full runtime** — run `wrangler dev` with `wrangler.toml`,
   trigger `/__scheduled` manually, watch `wrangler tail` for `[TOOL]` `[LLM]` `[HOOK]`
2. **Slack webhook** — point Slack Event Subscriptions to
   `https://swayambhu.dev/channel/slack`, verify challenge + chat flow
3. **Autonomous wake/sleep** — let cron run, verify reflect scheduling
4. **Reflection** — lower reflect interval, watch first depth-1 reflection

### DNS cutover to CF Workers

When moving to production CF Workers, update the DNS:
- Remove the tunnel CNAME for `swayambhu.dev`
- Add a Custom Domain on the Worker in the CF dashboard (handles DNS automatically)
- Or manually point the CNAME to the Worker's `*.workers.dev` subdomain

## Secrets management

### Dev

All secrets live in `.env` at the repo root. Before running anything:

```bash
source .env
```

Wrangler picks up env vars for the runtime worker. The dashboard API
does NOT use `.env` — its only secret (`OPERATOR_KEY`) is hardcoded as
`"test"` in `dashboard-api/wrangler.toml` for local dev.

This is deliberate: the dashboard API is a read-only observer and should
never have access to runtime secrets (API keys, wallet keys, bot tokens).
Least privilege.

### Prod

Secrets are set individually per worker using `wrangler secret put`.

**Runtime Worker** (from repo root):

```bash
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_CHANNEL_ID
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put WALLET_ADDRESS
wrangler secret put WALLET_PRIVATE_KEY
```

These are listed as comments in `wrangler.toml` for reference. Cloudflare
encrypts them at rest and injects them as `env.SECRET_NAME` at runtime.

**Dashboard API** (from `dashboard-api/`):

```bash
wrangler secret put OPERATOR_KEY
```

This overrides the `"test"` placeholder in `dashboard-api/wrangler.toml`.
The dashboard worker only receives `OPERATOR_KEY` — it has no access to
runtime secrets. This isolation is enforced by Cloudflare: each worker
has its own secret namespace.

### Why two workers, not one

The runtime and dashboard API are separate Cloudflare Workers with
separate secret namespaces. This enforces least privilege at the platform
level — the dashboard can read KV but cannot access API keys, wallet
keys, or bot tokens, even if the dashboard code is compromised.

## KV seeding

The seed script (`scripts/seed-local-kv.mjs`) writes to local SQLite by
default. To seed remote KV for a fresh prod deployment:

```bash
# TODO: Add remote seeding support to seed-local-kv.mjs
# For now, use wrangler kv commands directly:
# wrangler kv key put --namespace-id <id> "key" "value"
```

Both workers share the same KV namespace (same `id` in both `wrangler.toml`
files). This is how the dashboard reads runtime state.

## Deploying

### Runtime Worker

```bash
npx wrangler deploy
```

Uses `wrangler.toml`, which declares KV namespace binding and cron triggers.

### Dashboard API

```bash
cd dashboard-api && npx wrangler deploy
```

### After code changes to tools/prompts

If you changed files that get seeded into KV (tools, providers,
modules, prompts, config), you need to re-seed remote KV after deploying.
The governor reads module source from KV to build the runtime.

## Checklist

### First deploy

1. Set all runtime secrets: `wrangler secret put <NAME>` for each
2. Set dashboard API secret: `cd dashboard-api && wrangler secret put OPERATOR_KEY`
3. Seed remote KV with tools, modules, prompts, config
4. Deploy runtime: `npx wrangler deploy`
5. Deploy dashboard: `cd dashboard-api && npx wrangler deploy`
6. Verify cron is firing: check Cloudflare dashboard for Worker invocations
7. Verify the agent wakes: check karma logs in KV

### Subsequent deploys

1. Deploy code: `npx wrangler deploy` (and/or dashboard)
2. Re-seed KV if tools/modules/prompts/config changed
3. Secrets only need updating if values changed (`wrangler secret put`)

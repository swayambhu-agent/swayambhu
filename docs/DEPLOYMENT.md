# Deployment

Swayambhu should be operated with three tiers:

- `local` for development and most testing
- `staging` on Cloudflare for one full dress rehearsal
- `prod` on Cloudflare for live traffic

Do not create a separate Cloudflare `dev` environment unless you actually
need another public integration surface. Local already covers the fast loop.

## Environment model

### Local

- Runtime: `wrangler.dev.toml`
- KV: local Miniflare state in `.wrangler/shared-state/`
- Dashboard API: local `wrangler dev`
- Static site: `node scripts/dev-serve.mjs`
- Inference/Akash: local or remote, as needed for feature testing

### Cloudflare staging

- Runtime: `wrangler.toml --env staging`
- Dashboard API: `dashboard-api/wrangler.toml --env staging`
- KV: dedicated staging namespace
- Secrets: dedicated staging secrets
- Static site: deploy `site/` with staging API base at `staging.swayambhu.dev`
- Patron UI: `staging.swayambhu.dev/patron/`
- Public reflections: `staging.swayambhu.dev/reflections/`
- Dashboard API: `api-staging.swayambhu.dev`
- Runtime/webhook worker: `agent-staging.swayambhu.dev`

### Cloudflare production

- Runtime: `wrangler.toml`
- Dashboard API: `dashboard-api/wrangler.toml`
- KV: dedicated production namespace
- Secrets: dedicated production secrets
- Static site: deploy `site/` with production API base at `swayambhu.dev`
- Patron UI: `swayambhu.dev/patron/`
- Public reflections: `swayambhu.dev/reflections/`
- Dashboard API: `api.swayambhu.dev`
- Runtime/webhook worker: `agent.swayambhu.dev`

This is the canonical domain layout. Do not create separate `patron-*`
subdomains unless there is a concrete operational reason to split the host
later.

## Required config cleanup before deploy

The repo now assumes:

- Runtime entrypoint is `index.js`
- Static site API origins come from config files, not hardcoded `workers.dev` URLs
- Remote KV is pushed via `scripts/cloudflare/push-kv.mjs`
- Staging bootstrap can be automated with `npm run setup:cloudflare`
- Prod bootstrap requires an explicit prod target via `npm run setup:cloudflare:prod`

## Cloudflare bootstrap

The bootstrap script defaults to `staging`. Production requires an explicit
`--env prod --prod` confirmation. For a fresh Cloudflare account, the bootstrap
script will:

- verify account/token access
- ensure a `workers.dev` subdomain exists
- create or reuse the production KV namespace
- push Worker secrets from local env files
- seed remote KV
- build the site in Access-auth mode
- deploy runtime Worker, dashboard API Worker, and Pages site
- attach the apex Pages custom domain
- create the Cloudflare Access app protecting `/patron/*` and `api.*`

Run it with:

```bash
npm run setup:cloudflare
```

For production:

```bash
npm run setup:cloudflare:prod
```

Expected env files:

- `.env.patron.prod` for operator credentials such as `CF_API_TOKEN`, `CF_ACCOUNT_ID`
- `.env.prod` for runtime secrets such as `OPENROUTER_API_KEY`

Templates are provided at:

- `.env.patron.prod.example`
- `.env.prod.example`

Before first staging deploy:

1. Put the real staging KV namespace ID in:
   - `wrangler.toml` → `[env.staging]`
   - `dashboard-api/wrangler.toml` → `[env.staging]`
2. Confirm the production KV namespace ID in:
   - `wrangler.toml`
   - `dashboard-api/wrangler.toml`

## Static site config

The patron dashboard and public reflections page read their API base from:

- `site/patron/config.js`
- `site/reflections/config.js`

Render those files for the target environment before deploying the static site:

```bash
SITE_API_BASE=https://api-staging.swayambhu.dev \
npm run build:site
```

For production:

```bash
SITE_API_BASE=https://api.swayambhu.dev \
npm run build:site
```

Local development does not need these env vars; the site falls back to
`http://localhost:8790`.

## Secrets

### Local

Load runtime secrets from `.env`:

```bash
source .env
```

### Staging runtime

```bash
bash scripts/cloudflare/push-secrets.sh
```

### Production runtime

```bash
bash scripts/cloudflare/push-secrets.sh --env prod --prod
```

### Staging dashboard

```bash
bash scripts/cloudflare/push-secrets.sh --dashboard
```

### Production dashboard

```bash
bash scripts/cloudflare/push-secrets.sh --dashboard --env prod --prod
```

### Optional governor

Only set these if you are actually deploying the governor:

```bash
bash scripts/cloudflare/push-secrets.sh --governor
bash scripts/cloudflare/push-secrets.sh --governor --env prod --prod
```

## Remote KV seeding

Remote KV seeding is now handled by:

```bash
node scripts/cloudflare/push-kv.mjs --account-id <cf-account-id> --namespace-id <kv-namespace-id>
```

Requirements:

- `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN`
- `CF_ACCOUNT_ID`/`CLOUDFLARE_ACCOUNT_ID` or `--account-id`
- explicit `--namespace-id`, or `CF_STAGING_KV_NAMESPACE_ID` / `CF_PROD_KV_NAMESPACE_ID`

Optional:

- `AKASH_INFERENCE_SECRET` or `INFERENCE_SECRET`

Dry run:

```bash
CLOUDFLARE_API_TOKEN=... \
node scripts/cloudflare/push-kv.mjs \
  --account-id <cf-account-id> \
  --namespace-id <kv-namespace-id> \
  --dry-run
```

The script is safe to re-run. It overwrites keys deterministically from the
same seed manifest.

## Staging deploy sequence

1. Push staging secrets.
2. Seed staging KV.
3. Deploy staging runtime:

```bash
npx wrangler deploy --env staging
```

4. Deploy staging dashboard API:

```bash
cd dashboard-api
npx wrangler deploy --env staging
cd ..
```

5. Build static site with staging API base:

```bash
SITE_API_BASE=https://api-staging.swayambhu.dev \
npm run build:site
```

6. Deploy the static site to `staging.swayambhu.dev`.
7. Verify:
   - cron fires
   - Slack webhook challenge succeeds
   - chat flow works
   - dashboard auth works
   - reflections load
   - runtime writes are visible in the dashboard
   - at least one scheduled session completes cleanly

## Production cutover sequence

1. Record rollback targets first:
   - `wrangler deployments list`
   - previous dashboard deployment
   - previous static site deployment
2. Push production secrets with `--env prod --prod`.
3. Seed production KV with `--env prod --prod`.
4. Deploy production runtime:

```bash
npx wrangler deploy
```

5. Deploy production dashboard API:

```bash
cd dashboard-api
npx wrangler deploy
cd ..
```

6. Build static site with production API base:

```bash
SITE_API_BASE=https://api.swayambhu.dev \
npm run build:site
```

7. Deploy the static site.
8. Validate `workers.dev` / temporary site URLs.
9. Attach custom domains:
   - `swayambhu.dev` for the Pages site
   - `api.swayambhu.dev` for the dashboard API worker
   - `agent.swayambhu.dev` for the runtime worker
10. Switch Slack webhook and public links.

## Rollback

Before each production deploy, record the last known good deployment IDs for:

- runtime worker
- dashboard API worker
- static site

Rollback means:

1. restore the previous runtime deployment
2. restore the previous dashboard deployment
3. restore the previous static site deployment
4. restore KV from backup only if the deploy included incompatible data changes

Do not rely on the governor for first production launch. Keep the first
cutover manual and boring.

## Email Relay Service

If Akash hosts the email relay, run it as the `swayambhu` Unix user via a
user-scoped systemd unit, not as a root-managed system service.

Files:

- unit template: `services/systemd/swayambhu-email-gateway.service`
- env template: `services/systemd/email-gateway.env.example`
- installer: `scripts/install-email-gateway-user-service.sh`

On the Akash server, as the `swayambhu` user:

```bash
bash scripts/install-email-gateway-user-service.sh --write-env-only
```

Fill in `~/.config/swayambhu/email-gateway.env`, then run:

```bash
bash scripts/install-email-gateway-user-service.sh
```

For a separate dev mailbox/service on the same machine:

```bash
bash scripts/install-email-gateway-user-service.sh --instance dev --write-env-only
bash scripts/install-email-gateway-user-service.sh --instance dev
```

The service will be installed at:

- `~/.config/systemd/user/swayambhu-email-gateway.service`

For a named instance such as `dev`:

- `~/.config/systemd/user/swayambhu-email-gateway-dev.service`
- `~/.config/swayambhu/email-gateway-dev.env`

Required relay env vars on that host:

- `EMAIL_RELAY_SECRET`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`

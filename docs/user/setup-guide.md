# Setup Guide

This guide walks you through deploying Swayambhu from scratch. By the end
you'll have a running instance — locally for development, and optionally
deployed to production on Cloudflare Workers.

---

## Prerequisites

You'll need accounts and access to the following services:

| Service | What It's For | Cost |
|---------|---------------|------|
| **Cloudflare** (Workers paid plan) | Runs the agent and dashboard, stores all state in KV | $5/month |
| **OpenRouter** | Routes LLM calls to Claude, DeepSeek, etc. | Pay-as-you-go (see [Model Costs](#model-costs)) |
| **Slack workspace** | Real-time messaging channel | Free tier works |
| **Gmail account** | Email send/receive | Free |
| **Linux server** (Hetzner, etc.) | Remote command execution via the `akash_exec` tool | Optional — only if you need remote execution |

On your local machine:

- **Node.js 18+** and **npm**
- **Git**
- **Wrangler CLI** (installed automatically as a project dependency)

---

## 1. Clone and Install

```bash
git clone <your-repo-url> swayambhu
cd swayambhu
npm install
```

This installs Wrangler (Cloudflare's CLI) and Vitest (test runner) as
project dependencies.

---

## 2. Cloudflare Setup

### Create a KV Namespace

Log into the Cloudflare dashboard and create a KV namespace. You can name
it anything (e.g. `swayambhu-kv`). Copy the namespace ID — you'll need it
for both worker configurations.

Or use the CLI:

```bash
npx wrangler kv namespace create KV
```

This prints a namespace ID. Save it.

### Configure the Main Worker

Edit `wrangler.toml` in the project root. Replace the KV namespace ID with
yours:

```toml
name = "swayambhu-cns"
main = "brainstem.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat", "enable_ctx_exports"]

[[worker_loaders]]
binding = "LOADER"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["* * * * *"]
```

The cron fires every minute. The agent checks its own sleep timer and goes
back to sleep if it's not time to wake — so the effective wake frequency
is controlled by the agent, not the cron.

### Configure the Dashboard Worker

Edit `dashboard-api/wrangler.toml`. Use the same KV namespace ID:

```toml
name = "swayambhu-dashboard-api"
main = "worker.js"
compatibility_date = "2025-06-01"

[vars]
OPERATOR_KEY = "test"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

The `OPERATOR_KEY` is the password for the dashboard. Set it to `"test"`
for local development. For production, set it as a secret (see below).

### Set Secrets

Secrets are sensitive values that should never be in config files. Set them
via the Wrangler CLI. You'll configure the actual values in the
service-specific sections below — this is just the list of what you'll
need:

| Secret | Service | Required? |
|--------|---------|-----------|
| `OPENROUTER_API_KEY` | OpenRouter | Yes |
| `SLACK_BOT_TOKEN` | Slack | Yes, if using Slack |
| `SLACK_CHANNEL_ID` | Slack | Yes, if using Slack |
| `SLACK_SIGNING_SECRET` | Slack | Yes, if using Slack |
| `GMAIL_CLIENT_ID` | Gmail | Yes, if using email |
| `GMAIL_CLIENT_SECRET` | Gmail | Yes, if using email |
| `GMAIL_REFRESH_TOKEN` | Gmail | Yes, if using email |
| `AKASH_CF_CLIENT_ID` | Remote server | Only if using remote execution |
| `AKASH_API_KEY` | Remote server | Only if using remote execution |
| `WALLET_ADDRESS` | Crypto wallet | Only if using wallet monitoring |
| `WALLET_PRIVATE_KEY` | Crypto wallet | Only if using wallet monitoring |

For production, set each one:

```bash
echo -n "your-value-here" | npx wrangler secret put SECRET_NAME
```

For the dashboard worker, set the operator key as a secret in production:

```bash
cd dashboard-api
echo -n "your-strong-password" | npx wrangler secret put OPERATOR_KEY
cd ..
```

For local development, create a `.env` file in the project root with all
your secrets:

```bash
OPENROUTER_API_KEY=sk-or-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0...
SLACK_SIGNING_SECRET=...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
```

Source it before running any dev commands:

```bash
source .env
```

> **Never commit `.env` to git.** It should already be in `.gitignore`.

---

## 3. OpenRouter Setup

1. Create an account at [openrouter.ai](https://openrouter.ai).
2. Generate an API key from the dashboard.
3. Add credit to your account. Even $5 is enough to get started with
   cheap models.

Set the secret:

```bash
# Production
echo -n "sk-or-v1-..." | npx wrangler secret put OPENROUTER_API_KEY

# Local (.env)
OPENROUTER_API_KEY=sk-or-v1-...
```

### Model Costs

Swayambhu uses different models for different tasks. Default production
models:

| Role | Model | Input / Output per 1M tokens |
|------|-------|------------------------------|
| Orient (daily tasks) | Claude Haiku 4.5 | $1 / $5 |
| Reflect (session review) | Claude Sonnet 4.6 | $3 / $15 |
| Deep Reflect (periodic) | Claude Opus 4.6 | $5 / $25 |
| Chat (conversations) | Claude Sonnet 4.6 | $3 / $15 |

For development and testing, you can use DeepSeek ($0.10 / $0.10 per 1M
tokens) for everything — see [Local Development](#9-local-development).

---

## 4. Slack Setup

### Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click
   **Create New App** > **From scratch**.
2. Name it (e.g. "Swayambhu") and select your workspace.

### Configure Event Subscriptions

1. In the app settings, go to **Event Subscriptions** and toggle it on.
2. Set the **Request URL** to your worker's Slack webhook endpoint:
   ```
   https://your-worker-name.your-subdomain.workers.dev/channel/slack
   ```
   For local development with a tunnel, use your tunnel URL instead.
3. Under **Subscribe to bot events**, add:
   - `message.channels` — messages in public channels
   - `message.im` — direct messages to the bot

### Set Bot Scopes

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

- `chat:write` — send messages
- `channels:history` — read public channel messages
- `im:history` — read DM history
- `channels:read` — list channels (for channel ID lookup)

### Install to Workspace

1. Go to **Install App** and click **Install to Workspace**.
2. After authorizing, you'll get a **Bot User OAuth Token** (starts with
   `xoxb-`). This is your `SLACK_BOT_TOKEN`.

### Get the Channel ID

1. In Slack, right-click the channel you want Swayambhu to use and select
   **View channel details** (or **Copy link**).
2. The channel ID is the last segment of the URL (starts with `C`).

### Get the Signing Secret

1. In your app settings, go to **Basic Information**.
2. Under **App Credentials**, copy the **Signing Secret**.

### Set the Secrets

```bash
# Production
echo -n "xoxb-..." | npx wrangler secret put SLACK_BOT_TOKEN
echo -n "C0..." | npx wrangler secret put SLACK_CHANNEL_ID
echo -n "..." | npx wrangler secret put SLACK_SIGNING_SECRET

# Local (.env)
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0...
SLACK_SIGNING_SECRET=...
```

### Invite the Bot

Invite Swayambhu to the channel:

```
/invite @Swayambhu
```

---

## 5. Gmail Setup

Swayambhu uses Gmail's API with OAuth2 to read and send email.

### Create OAuth2 Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Create a project (or use an existing one).
3. Enable the **Gmail API** under **APIs & Services** > **Library**.
4. Go to **APIs & Services** > **Credentials** > **Create Credentials** >
   **OAuth client ID**.
5. Set the application type to **Web application**.
6. Add `https://developers.google.com/oauthplayground` as an authorized
   redirect URI.
7. Copy the **Client ID** and **Client Secret**.

### Generate a Refresh Token

1. Go to the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Click the gear icon (settings) and check **Use your own OAuth
   credentials**. Enter your Client ID and Client Secret.
3. In the left panel, find **Gmail API v1** and select these scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
4. Click **Authorize APIs** and sign in with the Gmail account Swayambhu
   will use.
5. Click **Exchange authorization code for tokens**.
6. Copy the **Refresh Token**.

### Set the Secrets

```bash
# Production
echo -n "..." | npx wrangler secret put GMAIL_CLIENT_ID
echo -n "..." | npx wrangler secret put GMAIL_CLIENT_SECRET
echo -n "..." | npx wrangler secret put GMAIL_REFRESH_TOKEN

# Local (.env)
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
```

---

## 6. Remote Server Setup (Optional)

The `akash_exec` tool lets Swayambhu run shell commands on a remote Linux
server. This is optional — skip this section if you don't need remote
execution.

### Server Requirements

Any Linux server accessible over HTTPS. The reference setup uses a
Hetzner dedicated server with a Cloudflare Tunnel for secure access.

The server needs:
- A web service that accepts POST requests with `{ command }` JSON bodies
  and returns `{ status, exit_code, output }`.
- Authentication via `cf-access-client-id` header and `Authorization:
  Bearer` token.
- An endpoint at `/execute?wait={seconds}` that runs the command and waits
  for completion.

### Cloudflare Tunnel

The reference deployment uses Cloudflare Tunnel to expose the execution
endpoint securely (no open ports, no public SSH):

1. Install `cloudflared` on your server.
2. Create a tunnel: `cloudflared tunnel create swayambhu-akash`
3. Configure it to route traffic from a hostname (e.g.
   `akash.swayambhu.dev`) to your local execution service.
4. Set up Cloudflare Access to require a service token for authentication.
5. Create a service token in Cloudflare Access — the Client ID is your
   `AKASH_CF_CLIENT_ID`.

### Set the Secrets

```bash
# Production
echo -n "..." | npx wrangler secret put AKASH_CF_CLIENT_ID
echo -n "..." | npx wrangler secret put AKASH_API_KEY

# Local (.env)
AKASH_CF_CLIENT_ID=...
AKASH_API_KEY=...
```

### Customize the Endpoint

The default endpoint is `https://akash.swayambhu.dev`. To use your own
domain, edit `tools/akash_exec.js` and change the `BASE` constant, then
re-seed.

---

## 7. Generate Identity

Swayambhu has a decentralized identity (DID) anchored on the Base
blockchain. Generate a keypair:

```bash
node scripts/generate-identity.js
```

This prints the DID, address, and private key. **Store the private key
securely — it cannot be recovered.**

To write the identity directly into local KV:

```bash
node scripts/generate-identity.js --seed-kv
```

The seed script (`seed-local-kv.mjs`) includes a default identity. If
you're just getting started locally, you can skip this step and use the
default. Generate your own before deploying to production.

---

## 8. Seed KV

The seed script populates the KV store with everything Swayambhu needs to
run: configuration, prompts, tools, providers, the dharma, yamas, niyamas,
contacts, and reference documentation.

```bash
node scripts/seed-local-kv.mjs
```

This takes about 2 seconds and writes 69 keys. You'll see output
confirming each category.

> The seed script uses Miniflare to write directly to the local KV store
> at `.wrangler/shared-state/`. It does not touch production KV.

---

## 9. Local Development

The start script handles everything — killing stale processes, seeding
state, starting all services, and optionally triggering a wake cycle.

### First Run (Full Reset)

```bash
source .env && bash scripts/start.sh --reset-all-state --wake
```

This:
1. Kills any stale worker processes.
2. Wipes all local KV state and re-seeds from scratch.
3. Starts three services:
   - **Brainstem** at `http://localhost:8787` — the agent
   - **Dashboard API** at `http://localhost:8790` — KV reader for the dashboard
   - **Dashboard SPA** at `http://localhost:3001/operator/` — the operator dashboard
4. Triggers a wake cycle (the agent orients, acts, and reflects).

### Using Cheap Models for Development

Production models (Claude) work well but cost real money. For development
and testing, use DeepSeek at ~30x lower cost:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake \
  --set orient.model=deepseek \
  --set reflect.model=deepseek
```

DeepSeek is fine for testing tool wiring, orient flow, KV operations,
prompt rendering, and basic wake cycles. Use real Claude models when
testing the reflection hierarchy, modification protocol, or anything
requiring structured JSON adherence.

### Subsequent Runs (Preserve State)

```bash
source .env && bash scripts/start.sh
```

This preserves existing KV state (sessions, wisdom, modifications) and
just restarts the services. Add `--wake` to trigger a wake cycle after
startup.

### What to Expect

On first wake, watch the terminal output. You'll see tagged log lines:

- `[KARMA]` — session lifecycle events
- `[TOOL]` — tool executions
- `[LLM]` — LLM API calls with model and cost
- `[HOOK]` — hook lifecycle

The agent will orient itself, possibly check email and balances, reflect on
what it found, set a sleep timer, and go dormant.

### Verify It's Working

**Check the dashboard.** Open `http://localhost:3001/operator/` in your
browser. Enter `test` as the operator key (the default for local
development). You should see:

- **Timeline** tab — the session that just ran, with its karma log.
- **KV Explorer** tab — all 69+ keys in the store.
- **Reflections** tab — the agent's first reflection.

**Check Slack.** If Slack is configured, send a message to the bot in the
channel you configured. The agent will respond via the chat system (no
wake cycle needed — chat is handled as a webhook).

**Trigger another wake manually:**

```bash
curl http://localhost:8787/__scheduled
```

### Stopping

Press `Ctrl+C` in the terminal where `start.sh` is running. It shuts down
all three services cleanly.

---

## 10. Production Deployment

### Deploy the Main Worker

From the project root:

```bash
npx wrangler deploy
```

This deploys `brainstem.js` as a Cloudflare Worker with the cron trigger.
The worker starts firing every minute immediately.

### Deploy the Dashboard

```bash
cd dashboard-api
npx wrangler deploy
cd ..
```

### Set All Production Secrets

If you haven't already set secrets for both workers:

```bash
# Main worker secrets
echo -n "sk-or-v1-..." | npx wrangler secret put OPENROUTER_API_KEY
echo -n "xoxb-..." | npx wrangler secret put SLACK_BOT_TOKEN
echo -n "C0..." | npx wrangler secret put SLACK_CHANNEL_ID
echo -n "..." | npx wrangler secret put SLACK_SIGNING_SECRET
# ... (all other secrets from the table in section 2)

# Dashboard worker secret
cd dashboard-api
echo -n "your-strong-password" | npx wrangler secret put OPERATOR_KEY
cd ..
```

### Seed Production KV

The local seed script writes to local storage. For production, you need to
populate the KV namespace manually or adapt the seed script to use
Wrangler's remote KV API. The simplest approach for initial deployment:

```bash
# Write each key to production KV using wrangler
npx wrangler kv key put --namespace-id <your-id> "dharma" "$(cat DHARMA.md)"
```

For a full production seed, you can modify `scripts/seed-local-kv.mjs` to
write to the production namespace, or use the dashboard API to verify state
after manual seeding.

### Set Up the Slack Webhook URL

Update your Slack app's Event Subscription URL to point to your deployed
worker:

```
https://swayambhu-cns.<your-subdomain>.workers.dev/channel/slack
```

Slack will send a verification challenge. The worker handles this
automatically.

### Verify the Deployment

**Check health via the dashboard API:**

```bash
curl -H "X-Operator-Key: your-password" \
  https://swayambhu-dashboard-api.<your-subdomain>.workers.dev/health
```

You should see:

```json
{
  "sessionCounter": 1,
  "wakeConfig": { "next_wake_after": "...", "sleep_seconds": 21600 },
  "lastReflect": { ... },
  "session": null
}
```

**Check that the cron is firing.** After deployment, the cron trigger fires
every minute. On the first fire, the agent will run a full wake cycle
(orient + reflect). Subsequent fires will be no-ops until the sleep timer
expires. Check the Cloudflare dashboard under **Workers & Pages** >
**your worker** > **Logs** to see cron invocations.

**Check Slack.** If configured, the agent may send a message on its first
wake. You can also message it directly to test the chat system.

---

## Useful Scripts

Once running, these scripts help you inspect and manage the system:

| Command | What It Does |
|---------|-------------|
| `node scripts/read-kv.mjs` | List all keys in local KV |
| `node scripts/read-kv.mjs config:defaults` | Read a specific key |
| `node scripts/read-kv.mjs karma:` | List keys with a prefix |
| `node scripts/dump-sessions.mjs` | Print summaries of all sessions |
| `node scripts/rollback-session.mjs --dry-run` | Preview rolling back the last session's KV changes |
| `node scripts/rollback-session.mjs --yes` | Roll back the last session (skip confirmation) |
| `node scripts/reset-wake-timer.mjs` | Force the next cron trigger to run a wake cycle |
| `npm test` | Run all unit tests (no network, no Workers runtime) |

---

## Dashboard Reference

The operator dashboard at `http://localhost:3001/operator/` (local) or
your deployed dashboard URL (production) provides a real-time view of the
system.

### Authentication

Enter your operator key to access protected routes. For local development,
the key is `test`.

### Tabs

**Timeline** — Every session the agent has run, with expandable karma logs
showing LLM calls, tool executions, and KV operations.

**KV Explorer** — Browse and search all keys in the KV store. Click a key
to view its value. Use the prefix filter to narrow results.

**Reflections** — All depth-1 (deep) reflections. These are the agent's
periodic self-examinations — its most thoughtful output.

**Mutations** — Staged and inflight modifications. See what the agent is
proposing to change about itself and what changes are currently active.

### Public Endpoint

`GET /reflections` on the dashboard API is public (no auth required). It
returns the 20 most recent deep reflections. The static page at
`/reflections/` on the SPA renders these.

### API Routes

All routes except `/reflections` require the `X-Operator-Key` header.

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Session counter, wake config, last reflection, active session |
| `/sessions` | GET | All sessions with type (orient or deep_reflect) |
| `/kv?prefix=` | GET | List KV keys, optional prefix filter |
| `/kv/multi?keys=k1,k2` | GET | Batch read multiple keys |
| `/kv/:key` | GET | Read a single KV value |
| `/quarantine` | GET | List quarantined inbound messages from unknown senders |
| `/contacts` | POST | Create a new contact record |
| `/quarantine/:key` | DELETE | Remove a quarantine entry after review |

---

## Troubleshooting

### "Port still in use" on startup

The start script kills stale `workerd` processes automatically. If ports
are still busy, something else is using them. Check what's listening:

```bash
lsof -i :8787
lsof -i :8790
lsof -i :3001
```

### Agent never wakes

The cron fires every minute, but the agent only wakes when its sleep timer
expires. Check the wake config:

```bash
node scripts/read-kv.mjs wake_config
```

If `next_wake_after` is far in the future, reset it:

```bash
node scripts/reset-wake-timer.mjs
```

Then trigger manually:

```bash
curl http://localhost:8787/__scheduled
```

### LLM calls fail

Check your OpenRouter balance at
[openrouter.ai/settings/credits](https://openrouter.ai/settings/credits).
If the balance is zero, add credit.

If using DeepSeek for development and it's down, switch to Haiku:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake \
  --set orient.model=haiku --set reflect.model=haiku
```

### Slack messages aren't received

1. Verify the webhook URL in your Slack app settings points to the correct
   worker endpoint (`/channel/slack`).
2. Check that the bot is invited to the channel.
3. Check that `SLACK_SIGNING_SECRET` matches what's in your Slack app's
   **Basic Information** page.
4. Look at the worker logs in the Cloudflare dashboard for 401 errors
   (signing secret mismatch) or 404 errors (wrong URL path).

### Dashboard shows "unauthorized"

Make sure you're entering the correct operator key. For local development,
it's `test`. For production, it's whatever you set via `wrangler secret
put OPERATOR_KEY` in the `dashboard-api` directory.

### Agent crashes repeatedly

If the agent crashes 3 times in a row, the kernel's tripwire fires. It
auto-restores the last working hook code (or enters minimal fallback
mode). Check the Slack channel for kernel alerts.

To investigate, read the karma log for the crashed session:

```bash
node scripts/read-kv.mjs karma:
```

Find the most recent session ID and read its karma:

```bash
node scripts/read-kv.mjs karma:s_<session_id>
```

Look for `fatal_error` or `hook_execution_error` events.

To do a full reset and start fresh:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake
```

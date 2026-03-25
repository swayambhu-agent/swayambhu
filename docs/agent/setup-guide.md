# Setup Guide

This guide is for helping someone deploy their own Swayambhu instance. When someone asks "I want to run my own Swayambhu," walk them through this step by step. Adapt the pace to their experience level — some people will need every detail, others just need the checklist.

---

## Prerequisites

They'll need accounts and access to:

| Service | What It's For | Cost |
|---------|---------------|------|
| **Cloudflare** (Workers paid plan) | Runs the agent and dashboard, stores all state in KV | $5/month |
| **OpenRouter** | Routes LLM calls to Claude, DeepSeek, etc. | Pay-as-you-go |
| **Slack workspace** | Real-time messaging channel | Free tier works |
| **Gmail account** | Email send/receive | Free |
| **Linux server** (Hetzner, etc.) | Remote command execution via the `computer` tool | Optional |

On their local machine: **Node.js 18+**, **npm**, **Git**.

**Cost guidance:** Start with $5-10 on OpenRouter. Use DeepSeek for testing (costs ~$0.10/M tokens vs $5-25/M for Claude). They can switch to Claude models once everything is wired up and working. A typical wake cycle with DeepSeek costs less than $0.01.

---

## 1. Clone and Install

```bash
git clone <repo-url> swayambhu
cd swayambhu
npm install
```

This installs Wrangler (Cloudflare's CLI) and Vitest (test runner) as project dependencies.

---

## 2. Cloudflare Setup

### Create a KV Namespace

Log into the Cloudflare dashboard and create a KV namespace (e.g. `swayambhu-kv`). Copy the namespace ID. Or use the CLI:

```bash
npx wrangler kv namespace create KV
```

### Configure the Main Worker

Edit `wrangler.toml` in the project root. Replace the KV namespace ID:

```toml
name = "swayambhu-cns"
main = "index.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "<their-kv-namespace-id>"

[triggers]
crons = ["* * * * *"]
```

The cron fires every minute. The agent checks its own sleep timer and goes back to sleep if it's not time — the effective wake frequency is controlled by the agent, not the cron.

### Configure the Dashboard Worker

Edit `dashboard-api/wrangler.toml`. Use the same KV namespace ID:

```toml
name = "swayambhu-dashboard-api"
main = "worker.js"
compatibility_date = "2025-06-01"

[vars]
PATRON_KEY = "test"

[[kv_namespaces]]
binding = "KV"
id = "<their-kv-namespace-id>"
```

### Secrets

All sensitive values go through `wrangler secret put` for production. For local dev, they go in a `.env` file (never committed to git).

| Secret | Service | Required? |
|--------|---------|-----------|
| `OPENROUTER_API_KEY` | OpenRouter | Yes |
| `SLACK_BOT_TOKEN` | Slack | Yes, if using Slack |
| `SLACK_CHANNEL_ID` | Slack | Yes, if using Slack |
| `SLACK_SIGNING_SECRET` | Slack | Yes, if using Slack |
| `GMAIL_CLIENT_ID` | Gmail | Yes, if using email |
| `GMAIL_CLIENT_SECRET` | Gmail | Yes, if using email |
| `GMAIL_REFRESH_TOKEN` | Gmail | Yes, if using email |
| `COMPUTER_CF_CLIENT_ID` | Remote server | Only if using remote execution |
| `COMPUTER_API_KEY` | Remote server | Only if using remote execution |

For production:
```bash
echo -n "your-value-here" | npx wrangler secret put SECRET_NAME
```

For the dashboard worker:
```bash
cd dashboard-api
echo -n "your-strong-password" | npx wrangler secret put PATRON_KEY
cd ..
```

---

## 3. OpenRouter Setup

1. Create an account at openrouter.ai.
2. Generate an API key from the dashboard.
3. Add credit — even $5 is enough to start with cheap models.

```bash
# Production
echo -n "sk-or-v1-..." | npx wrangler secret put OPENROUTER_API_KEY

# Local (.env)
OPENROUTER_API_KEY=sk-or-v1-...
```

---

## 4. Slack Setup

### Create a Slack App

1. Go to api.slack.com/apps → **Create New App** → **From scratch**.
2. Name it (e.g. "Swayambhu") and select the workspace.

### Configure Event Subscriptions

1. **Event Subscriptions** → toggle on.
2. Set **Request URL** to: `https://your-worker-name.your-subdomain.workers.dev/channel/slack`
   (For local dev with a tunnel, use the tunnel URL.)
3. **Subscribe to bot events**: `message.channels`, `message.im`

### Set Bot Scopes

**OAuth & Permissions** → add Bot Token Scopes:
- `chat:write`
- `channels:history`
- `im:history`
- `channels:read`

### Install to Workspace

**Install App** → **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`).

### Get the Channel ID

Right-click the target channel in Slack → **View channel details** (or **Copy link**). The channel ID is the last segment (starts with `C`).

### Get the Signing Secret

App settings → **Basic Information** → **App Credentials** → copy **Signing Secret**.

### Set the Secrets

```bash
echo -n "xoxb-..." | npx wrangler secret put SLACK_BOT_TOKEN
echo -n "C0..." | npx wrangler secret put SLACK_CHANNEL_ID
echo -n "..." | npx wrangler secret put SLACK_SIGNING_SECRET
```

### Invite the Bot

```
/invite @Swayambhu
```

---

## 5. Gmail Setup

### Create OAuth2 Credentials

1. Google Cloud Console → create a project (or use existing).
2. Enable the **Gmail API** under APIs & Services → Library.
3. APIs & Services → Credentials → Create Credentials → OAuth client ID.
4. Application type: **Web application**.
5. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
6. Copy the **Client ID** and **Client Secret**.

### Generate a Refresh Token

1. Go to the OAuth 2.0 Playground (developers.google.com/oauthplayground).
2. Gear icon → check **Use your own OAuth credentials** → enter Client ID and Secret.
3. Select Gmail API v1 scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
4. **Authorize APIs** → sign in with the Gmail account.
5. **Exchange authorization code for tokens** → copy the **Refresh Token**.

### Set the Secrets

```bash
echo -n "..." | npx wrangler secret put GMAIL_CLIENT_ID
echo -n "..." | npx wrangler secret put GMAIL_CLIENT_SECRET
echo -n "..." | npx wrangler secret put GMAIL_REFRESH_TOKEN
```

---

## 6. Remote Server Setup (Optional)

The `computer` tool lets Swayambhu run shell commands on a remote Linux server. Skip this if they don't need remote execution.

### Server Requirements

Any Linux server accessible over HTTPS. The reference setup uses a Hetzner server with a Cloudflare Tunnel. The server needs:
- A web service accepting POST requests with `{ command }` JSON bodies returning `{ status, exit_code, output }`
- Authentication via `cf-access-client-id` header and `Authorization: Bearer` token
- Endpoint at `/execute?wait={seconds}`

### Cloudflare Tunnel

1. Install `cloudflared` on the server.
2. Create a tunnel: `cloudflared tunnel create swayambhu-computer`
3. Route traffic from a hostname (e.g. `computer.their-domain.dev`) to the local execution service.
4. Set up Cloudflare Access with a service token for authentication.

### Set the Secrets

```bash
echo -n "..." | npx wrangler secret put COMPUTER_CF_CLIENT_ID
echo -n "..." | npx wrangler secret put COMPUTER_API_KEY
```

---

## 7. What They Need to Customize

Before seeding, they should customize:

1. **DHARMA.md** — The agent's core identity and purpose. This is immutable once seeded. They should write their own that reflects what they want their agent to be and do.

2. **Patron contact** — In `config/contacts.json`, update the contact record with their own name, Slack user ID (as a platform binding), and details.

3. **Patron keypair** — Generate an Ed25519 keypair for identity verification. The public key goes in KV at `patron:public_key`.

4. **Identity** — Run `node scripts/generate-identity.js` to generate a unique DID, or use `--seed-kv` to write it directly.

---

## 8. Seed KV and Run

```bash
# Seed the KV store
node scripts/seed-local-kv.mjs

# First run with full reset and wake
source .env && bash scripts/start.sh --reset-all-state --wake
```

### Verify It's Working

- **Dashboard** at `http://localhost:3001/patron/` — enter `test` as patron key
- **Timeline tab** — should show the first session
- **KV Explorer** — should show 70+ keys
- **Slack** — send a message to the bot

### Using Cheap Models

For development, use DeepSeek at ~30x lower cost:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake \
  --set act.model=deepseek \
  --set reflect.model=deepseek
```

---

## 9. Production Deployment

```bash
# Deploy main worker
npx wrangler deploy

# Deploy dashboard
cd dashboard-api && npx wrangler deploy && cd ..

# Set all production secrets (both workers)
# ... (refer to secrets table above)
```

Update the Slack app's Event Subscription URL to the deployed worker URL.

For production KV seeding, adapt `seed-local-kv.mjs` to write to the production namespace, or use `wrangler kv key put` for individual keys.

---

## Troubleshooting

### "Port still in use" on startup
The start script kills stale `workerd` processes automatically. If ports are still busy:
```bash
lsof -i :8787
lsof -i :8790
lsof -i :3001
```

### Agent never wakes
Check the wake config: `node scripts/read-kv.mjs wake_config`. If `next_wake_after` is far in the future, reset it: `node scripts/reset-wake-timer.mjs`, then `curl http://localhost:8787/__scheduled`.

### LLM calls fail
Check OpenRouter balance at openrouter.ai/settings/credits. If using DeepSeek and it's down, switch to Haiku with `--set act.model=haiku --set reflect.model=haiku`.

### Slack messages aren't received
1. Verify webhook URL points to `/channel/slack`
2. Check bot is invited to the channel
3. Check `SLACK_SIGNING_SECRET` matches the app's Basic Information page
4. Check worker logs for 401 (signing secret mismatch) or 404 (wrong path)

### Agent crashes repeatedly
After 3 consecutive crashes, the kernel's tripwire fires and auto-restores. Check karma logs: `node scripts/read-kv.mjs karma:` → find recent session → look for `fatal_error` events. Full reset: `source .env && bash scripts/start.sh --reset-all-state --wake`.

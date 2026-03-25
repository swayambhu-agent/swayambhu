# Getting Started

Swayambhu is an autonomous agent that runs as a Cloudflare Worker on a 1-minute cron. It wakes, acts, reflects, and goes back to sleep. All state lives in Cloudflare KV. It communicates via Slack and Gmail.

This guide walks you through setting up your own instance from scratch. Budget about 30–60 minutes.

## Prerequisites

| Service | What It's For | Cost |
|---------|---------------|------|
| **Cloudflare** (Workers paid plan) | Runs the agent + stores all state | $5/month |
| **OpenRouter** | Routes LLM calls (Claude, DeepSeek, etc.) | Pay-as-you-go |
| **Slack** | Real-time messaging | Free tier works |
| **Gmail** | Email send/receive | Free |

On your machine: **Node.js 18+**, **npm**, **Git**.

> **Cost tip:** Start with $5–10 on OpenRouter. Use DeepSeek for testing (~$0.10/M tokens vs $5–25/M for Claude). A typical wake cycle with DeepSeek costs less than $0.01.

---

## 1. Clone and Install

```bash
git clone <repo-url> swayambhu
cd swayambhu
npm install
```

Verify everything is healthy:

```bash
npm test
```

All tests should pass. If they don't, check your Node version.

---

## 2. Cloudflare Setup

### Log in to Wrangler

```bash
npx wrangler login
```

Opens a browser window. Sign in and authorize Wrangler.

### Create a KV namespace

```bash
npx wrangler kv namespace create KV
```

This prints a namespace ID (a long hex string). Copy it.

### Configure the main worker

Edit `wrangler.toml` in the project root. Replace the KV namespace ID:

```toml
name = "swayambhu-cns"        # or your preferred worker name
main = "index.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["* * * * *"]         # agent controls its own sleep timer
```

### Configure the dashboard worker

Edit `dashboard-api/wrangler.toml`. Use the **same** KV namespace ID:

```toml
name = "swayambhu-dashboard-api"
main = "worker.js"
compatibility_date = "2025-06-01"

[vars]
PATRON_KEY = "test"           # local dev only — override with secret for prod

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

### Create .env for local development

Create a `.env` file in the project root (it's in `.gitignore`, never committed):

```bash
# .env — local development secrets
OPENROUTER_API_KEY=sk-or-v1-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0...
SLACK_SIGNING_SECRET=...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
```

You'll fill in each value as you set up the services below.

---

## 3. OpenRouter Setup

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Go to **Settings → Keys** and generate an API key
3. Go to **Settings → Credits** and add $5–10

Add the key to your `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

For production deployment later:

```bash
echo -n "sk-or-v1-..." | npx wrangler secret put OPENROUTER_API_KEY
```

---

## 4. Slack Setup

### Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "Swayambhu") and select your workspace

### Set bot token scopes

Go to **OAuth & Permissions** → **Bot Token Scopes** and add:

- `chat:write` — send messages
- `channels:history` — read public channels
- `im:history` — read DMs
- `channels:read` — list channels

### Install to workspace

**Install App** → **Install to Workspace**. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### Enable event subscriptions

1. **Event Subscriptions** → toggle on
2. Set **Request URL** to: `https://<your-worker-name>.<your-subdomain>.workers.dev/channel/slack`
3. Under **Subscribe to bot events**, add: `message.channels`, `message.im`

> **Note:** The Request URL won't verify until the worker is deployed. You can come back to this after Step 8.

### Get the signing secret

App settings → **Basic Information** → **App Credentials** → copy **Signing Secret**.

### Get the channel ID

In Slack, right-click the channel → **View channel details**. The ID is at the bottom (starts with `C`).

### Invite the bot

In the target channel: `/invite @Swayambhu`

### Save the secrets

Add to your `.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0...
SLACK_SIGNING_SECRET=...
```

---

## 5. Gmail Setup

### Create OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. **APIs & Services → Library** → search for **Gmail API** → **Enable**
4. **APIs & Services → OAuth consent screen** → configure (External is fine, add your email as a test user)
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
6. Application type: **Web application**
7. Add `http://localhost:8089` as an authorized redirect URI
8. Copy the **Client ID** and **Client Secret**

### Generate a refresh token

Add the Client ID and Secret to your `.env` first, then run the helper script:

```bash
source .env && node scripts/gmail-auth.mjs
```

This will:
1. Print a URL — open it in your browser
2. Sign in with the Gmail account and grant access
3. Redirect back to localhost with an auth code
4. Print the refresh token — paste it into `.env`

Your `.env` should now have:

```
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
```

---

## 6. Customize Your Instance

Before seeding and running, customize these files:

### DHARMA.md — the agent's core identity

This is the agent's immutable identity document — who it is, what it's for, what it values. Write your own. Once seeded, the kernel protects it from modification.

### config/contacts.json — patron and contacts

Replace with your own details:

```json
{
  "patron": {
    "slug": "your_name",
    "public_key": "ssh-ed25519 AAAA..."
  },
  "contacts": {
    "your_name": {
      "name": "Your Name",
      "relationship": "patron",
      "about": "...",
      "timezone": "America/New_York",
      "chat": {
        "model": "sonnet",
        "effort": "high",
        "max_cost_per_conversation": 1.00,
        "max_output_tokens": 2000
      },
      "communication": "..."
    }
  },
  "platform_bindings": {
    "slack:U_YOUR_SLACK_ID": {
      "slug": "your_name",
      "approved": true
    }
  }
}
```

Your Slack user ID: click your profile in Slack → the ID is at the bottom (starts with `U`).

### Patron Ed25519 keypair

Generate a keypair for identity verification:

```bash
ssh-keygen -t ed25519 -C "swayambhu patron key" -f patron_key
```

Put the **public key** contents in `config/contacts.json` under `patron.public_key`. Keep the private key safe — you'll use it to verify your identity to the agent.

### Agent identity (DID)

```bash
node scripts/generate-identity.js
```

Generates a unique decentralized identity. Copy the output into `config/identity.json`, or use `--seed-kv` to write directly.

### Dashboard config (optional)

Edit `site/patron/config.js` to set your timezone and locale:

```js
window.DASHBOARD_CONFIG = {
  timezone: "America/New_York",
  locale: "en-US",
  // ...
};
```

---

## 7. Seed and Run Locally

```bash
# Full reset: wipe local KV, seed fresh, start services, trigger first wake
source .env && bash scripts/start.sh --reset-all-state --wake
```

This will:
1. Kill any stale workers
2. Seed ~70 keys into local KV (config, prompts, tools, providers, dharma, contacts...)
3. Start the kernel (port 8787), dashboard API (port 8790), and dashboard SPA (port 3001)
4. Trigger the first wake cycle

### Verify it's working

- Open `http://localhost:3001/patron/` — enter `test` as the patron key
- **Timeline tab** should show the first session
- **KV Explorer** should show 70+ keys
- Send a Slack DM to the bot (if Slack is configured with a tunnel)

### Use cheap models for development

```bash
# DeepSeek for everything (~30x cheaper than Claude)
source .env && bash scripts/start.sh --reset-all-state --wake \
  --set act.model=deepseek --set reflect.model=deepseek
```

### Manual wake trigger

```bash
curl http://localhost:8787/__scheduled
```

### Inspect KV state

```bash
# List all keys
node scripts/read-kv.mjs

# Read a specific key
node scripts/read-kv.mjs config:defaults

# List keys by prefix
node scripts/read-kv.mjs karma:
```

---

## 8. Deploy to Production

### Deploy the workers

```bash
# Main worker (kernel + agent)
npx wrangler deploy

# Dashboard API
cd dashboard-api && npx wrangler deploy && cd ..
```

### Set production secrets

Set each secret for the **main worker**:

```bash
echo -n "sk-or-v1-..." | npx wrangler secret put OPENROUTER_API_KEY
echo -n "xoxb-..."      | npx wrangler secret put SLACK_BOT_TOKEN
echo -n "C0..."         | npx wrangler secret put SLACK_CHANNEL_ID
echo -n "..."           | npx wrangler secret put SLACK_SIGNING_SECRET
echo -n "..."           | npx wrangler secret put GMAIL_CLIENT_ID
echo -n "..."           | npx wrangler secret put GMAIL_CLIENT_SECRET
echo -n "..."           | npx wrangler secret put GMAIL_REFRESH_TOKEN
```

Set the patron key for the **dashboard worker**:

```bash
cd dashboard-api
echo -n "your-strong-password" | npx wrangler secret put PATRON_KEY
cd ..
```

### Seed production KV

The seed script writes to local KV. For production, you can bulk-upload via Wrangler:

```bash
# Example: seed dharma
npx wrangler kv key put --namespace-id <id> "dharma" "$(cat DHARMA.md)"

# Example: seed a JSON config
npx wrangler kv key put --namespace-id <id> "config:defaults" "$(cat config/defaults.json)"
```

> **Tip:** A production seed script is planned but not yet built. For now, seed locally and verify everything works before deploying.

### Update Slack webhook URL

Go back to your Slack app settings → **Event Subscriptions** and update the Request URL to your deployed worker:

```
https://<your-worker-name>.<your-subdomain>.workers.dev/channel/slack
```

Slack will send a verification challenge. The worker handles it automatically.

### Update dashboard SPA API URL

Edit `site/patron/index.html` and update the production API URL to point to your deployed dashboard worker:

```js
// In the API_URL detection block:
: 'https://<your-dashboard-worker>.<your-subdomain>.workers.dev';
```

### Host the dashboard

The `site/` directory is static HTML. Host it anywhere — Cloudflare Pages, GitHub Pages, S3, or just open `site/patron/index.html` locally.

---

## Troubleshooting

### "Port still in use" on startup

The start script kills stale workers automatically. If ports are still busy:

```bash
lsof -i :8787   # kernel
lsof -i :8790   # dashboard API
lsof -i :3001   # dashboard SPA
```

### Agent never wakes

Check the wake timer: `node scripts/read-kv.mjs wake_config`. If `next_wake_after` is far in the future:

```bash
node scripts/reset-wake-timer.mjs
curl http://localhost:8787/__scheduled
```

### LLM calls fail

Check your OpenRouter balance. If using DeepSeek and it's down, switch to Haiku:

```bash
source .env && bash scripts/start.sh --reset-all-state --wake \
  --set act.model=haiku --set reflect.model=haiku
```

### Slack messages aren't received

1. Verify webhook URL ends with `/channel/slack`
2. Check the bot is invited to the channel
3. Check `SLACK_SIGNING_SECRET` matches the app's Basic Information page
4. Check worker logs for 401 (signing secret mismatch) or 404 (wrong path)

### Agent crashes repeatedly

After 3 consecutive crashes, the kernel's tripwire fires and auto-restores. Check karma logs:

```bash
node scripts/read-kv.mjs karma:   # find recent session, look for fatal_error
```

Nuclear option: `source .env && bash scripts/start.sh --reset-all-state --wake`

### Useful scripts

| Script | Purpose |
|--------|---------|
| `scripts/start.sh` | Start all local services |
| `scripts/read-kv.mjs` | Read KV keys / list by prefix |
| `scripts/delete-kv.mjs <key>` | Delete a KV key |
| `scripts/reset-wake-timer.mjs` | Force next wake cycle |
| `scripts/rollback-session.mjs` | Undo last session's KV changes |
| `scripts/gmail-auth.mjs` | Generate Gmail refresh token |
| `scripts/generate-identity.js` | Generate agent DID |

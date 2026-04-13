# Getting Started

Swayambhu is an autonomous agent that runs as a Cloudflare Worker on a 1-minute cron. It runs sessions on a schedule — acting, reflecting, and going idle between sessions. All state lives in Cloudflare KV. It communicates via Slack and Gmail.

## Quick Start

The setup script walks you through everything interactively — creating accounts, generating config, collecting API keys, and starting the agent:

```bash
git clone <repo-url> swayambhu
cd swayambhu
npm install
bash scripts/setup.sh
```

The script handles: Wrangler login, KV namespace creation, wrangler.toml patching, `.env` generation, patron keypair, contact config, agent DID, and first run.

**Before you start,** create accounts at these services and have them open in browser tabs:

| Service | What It's For | Cost |
|---------|---------------|------|
| **Cloudflare** (free plan works) | Runs the agent + stores all state | Free |
| **OpenRouter** | Routes LLM calls (Claude, DeepSeek, etc.) | Pay-as-you-go |
| **Slack** | Real-time messaging | Free tier works |
| **Gmail** | Email send/receive | Free |

> **Cost tip:** Start with $5–10 on OpenRouter. Use DeepSeek for testing (~$0.10/M tokens vs $5–25/M for Claude). A typical session with DeepSeek costs less than $0.01.

---

## What the Setup Script Does

The script is interactive — it prompts you at each step, lets you skip what you've already done, and writes all config files for you. Here's what each step covers:

1. **Prerequisites** — checks Node.js 18+, npm, git, runs `npm install`
2. **Cloudflare** — `wrangler login`, creates KV namespace, patches both `wrangler.toml` files
3. **API keys** — prompts for OpenRouter, Slack, and Gmail credentials, writes to `.env`
4. **Patron identity** — generates Ed25519 keypair for identity verification
5. **Contact config** — prompts for your name/timezone/Slack ID, generates `config/contacts.json`
6. **Agent identity** — generates a unique DID, writes to `config/identity.json`
7. **DHARMA.md** — reminds you to write/review the agent's identity document
8. **Seed and run** — seeds local KV, starts all services, triggers first session

---

## After Setup

### Verify it's working

- Open `http://localhost:3001/patron/` — enter `test` as the patron key
- **Timeline tab** should show the first session
- **KV Explorer** should show 70+ keys
- Send a Slack DM to the bot (if Slack is configured with a tunnel)

### Subsequent runs (preserve state)

```bash
source .env && bash scripts/start.sh
```

### Manual trigger

```bash
curl http://localhost:8787/__scheduled
```

### Inspect KV state

```bash
node scripts/read-kv.mjs                # list all keys
node scripts/read-kv.mjs config:defaults # read a specific key
node scripts/read-kv.mjs karma:          # list keys by prefix
```

---

## Deploy to Production

### Deploy the workers

```bash
npx wrangler deploy                                    # main worker
cd dashboard-api && npx wrangler deploy && cd ..       # dashboard API
```

### Push secrets to production

The push script reads your `.env` and pushes each secret to Cloudflare:

```bash
bash scripts/cloudflare/push-secrets.sh              # main worker secrets
bash scripts/cloudflare/push-secrets.sh --dashboard   # dashboard patron key
```

### Update Slack webhook URL

In your Slack app settings → **Event Subscriptions**, update the Request URL:

```
https://<your-worker-name>.<your-subdomain>.workers.dev/channel/slack
```

### Update dashboard SPA API URL

Edit `site/patron/index.html` and update the production API URL:

```js
: 'https://<your-dashboard-worker>.<your-subdomain>.workers.dev';
```

### Host the dashboard

The `site/` directory is static HTML. Host it anywhere — Cloudflare Pages, GitHub Pages, or just open `site/patron/index.html` locally.

---

## Manual Setup Reference

If you prefer to set things up manually (or the script doesn't cover your case), here's each service step by step.

<details>
<summary><strong>Cloudflare</strong></summary>

```bash
npx wrangler login
npx wrangler kv namespace create KV
```

Edit `wrangler.toml` — replace the KV namespace ID:

```toml
name = "swayambhu-cns"
main = "index.js"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["* * * * *"]
```

Edit `dashboard-api/wrangler.toml` — same KV namespace ID:

```toml
name = "swayambhu-dashboard-api"
main = "worker.js"
compatibility_date = "2025-06-01"

[vars]
PATRON_KEY = "test"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"
```

</details>

<details>
<summary><strong>OpenRouter</strong></summary>

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. **Settings → Keys** → generate an API key
3. **Settings → Credits** → add $5–10
4. Add to `.env`: `OPENROUTER_API_KEY=sk-or-v1-...`

</details>

<details>
<summary><strong>Slack</strong></summary>

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. **OAuth & Permissions** → add scopes: `chat:write`, `channels:history`, `im:history`, `channels:read`
3. **Install App** → **Install to Workspace** → copy Bot Token (`xoxb-...`)
4. **Event Subscriptions** → toggle on → set Request URL to `https://<worker>.workers.dev/channel/slack`
5. **Subscribe to bot events**: `message.channels`, `message.im`
6. **Basic Information** → copy Signing Secret
7. Get channel ID: right-click channel → View details (starts with `C`)
8. Invite the bot: `/invite @YourBot`
9. Add to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_CHANNEL_ID=C0...
   SLACK_SIGNING_SECRET=...
   ```

> The Request URL won't verify until the worker is deployed. Come back to this after deploying.

</details>

<details>
<summary><strong>Gmail</strong></summary>

1. [Google Cloud Console](https://console.cloud.google.com) → create project → enable **Gmail API**
2. **OAuth consent screen** → configure (add your email as test user)
3. **Credentials → OAuth client ID** → Web application → add `http://localhost:8089` as redirect URI
4. Copy Client ID and Client Secret → add to `.env`
5. Generate refresh token:
   ```bash
   source .env && node scripts/gmail-auth.mjs
   ```
6. Add the printed refresh token to `.env` as `GMAIL_REFRESH_TOKEN`

</details>

<details>
<summary><strong>Patron keypair & contacts</strong></summary>

Generate an Ed25519 keypair:

```bash
ssh-keygen -t ed25519 -C "swayambhu patron key" -f patron_key
```

Create `config/contacts.json`:

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
      "chat": { "model": "sonnet", "effort": "high", "max_cost_per_conversation": 1.00, "max_output_tokens": 2000 },
      "communication": "..."
    }
  },
  "platform_bindings": {
    "slack:U_YOUR_SLACK_ID": { "slug": "your_name", "approved": true }
  }
}
```

Generate agent DID: `node scripts/generate-identity.js`

</details>

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port still in use | `lsof -i :8787` / `:8790` / `:3001` to find what's holding the port |
| Agent never runs | `node scripts/reset-schedule.mjs && curl http://localhost:8787/__scheduled` |
| LLM calls fail | Check OpenRouter balance; switch models with `--set act.model=haiku` |
| Slack not receiving | Check webhook URL ends with `/channel/slack`, bot is invited, signing secret matches |
| Agent crashes | Check `node scripts/read-kv.mjs karma:` for `fatal_error`. Nuclear: `--reset-all-state` |

## Useful Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup.sh` | Interactive first-time setup |
| `scripts/start.sh` | Start all local services |
| `scripts/cloudflare/push-secrets.sh` | Push `.env` secrets to production |
| `scripts/read-kv.mjs` | Read KV keys / list by prefix |
| `scripts/delete-kv.mjs <key>` | Delete a KV key |
| `scripts/reset-schedule.mjs` | Force next session |
| `scripts/rollback-session.mjs` | Undo last session's KV changes |
| `scripts/gmail-auth.mjs` | Generate Gmail refresh token |
| `scripts/generate-identity.js` | Generate agent DID |

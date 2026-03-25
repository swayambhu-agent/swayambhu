#!/usr/bin/env bash
# Interactive setup script for Swayambhu.
# Walks through account setup, generates config files, and seeds local KV.
#
# Usage: bash scripts/setup.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Helpers ──────────────────────────────────────────────────

bold() { printf "\033[1m%s\033[0m" "$*"; }
accent() { printf "\033[1;33m%s\033[0m" "$*"; }
dim() { printf "\033[2m%s\033[0m" "$*"; }
green() { printf "\033[1;32m%s\033[0m" "$*"; }
red() { printf "\033[1;31m%s\033[0m" "$*"; }

banner() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  accent "  $1"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

ask() {
  local prompt="$1" default="${2:-}" var="$3"
  if [ -n "$default" ]; then
    printf "  %s [%s]: " "$prompt" "$default"
  else
    printf "  %s: " "$prompt"
  fi
  read -r input
  eval "$var=\"${input:-$default}\""
}

ask_secret() {
  local prompt="$1" var="$2"
  printf "  %s: " "$prompt"
  read -rs input
  echo ""
  eval "$var=\"$input\""
}

confirm() {
  printf "  %s (y/n) " "$1"
  read -r yn
  [[ "$yn" =~ ^[Yy] ]]
}

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo ""
    red "  Error: $1 is not installed."
    echo ""
    echo "  $2"
    exit 1
  fi
}

write_env_var() {
  local key="$1" value="$2" file="$ROOT/.env"
  if [ -f "$file" ] && grep -q "^${key}=" "$file"; then
    # Update existing
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

# ── Preamble ─────────────────────────────────────────────────

clear 2>/dev/null || true
echo ""
accent "  SWAYAMBHU SETUP"
echo ""
echo "  This script will walk you through setting up your own"
echo "  Swayambhu instance. It will:"
echo ""
echo "    1. Check prerequisites"
echo "    2. Set up Cloudflare (KV namespace, wrangler.toml)"
echo "    3. Collect API keys (OpenRouter, Slack, Gmail)"
echo "    4. Generate your patron identity"
echo "    5. Create your contact config"
echo "    6. Generate the agent's DID"
echo "    7. Seed local KV and run"
echo ""
echo "  You can skip steps you've already done."
echo "  Press Ctrl+C at any time to abort."
echo ""

if ! confirm "Ready to start?"; then
  echo "  Aborted."
  exit 0
fi

# ── Step 1: Prerequisites ────────────────────────────────────

banner "STEP 1: Prerequisites"

check_cmd node "Install Node.js 18+ from https://nodejs.org"
check_cmd npm "npm should come with Node.js"
check_cmd git "Install Git from https://git-scm.com"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  red "  Node.js 18+ required (you have v$(node -v))"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install --silent
fi

green "  ✓ Prerequisites OK"
echo ""

# ── Step 2: Cloudflare ───────────────────────────────────────

banner "STEP 2: Cloudflare"

echo "  You need a Cloudflare account (free plan works)."
echo "  Sign up at https://dash.cloudflare.com/sign-up"
echo ""

if ! npx wrangler whoami &>/dev/null 2>&1; then
  echo "  You're not logged in to Wrangler."
  if confirm "Log in now?"; then
    npx wrangler login
  else
    echo ""
    dim "  Skipping — run 'npx wrangler login' later."
    echo ""
  fi
else
  green "  ✓ Already logged in to Wrangler"
  echo ""
fi

# KV namespace
KV_ID=""
if grep -q '<your-kv-namespace-id>' wrangler.toml 2>/dev/null || grep -q '<your-kv-namespace-id>' dashboard-api/wrangler.toml 2>/dev/null; then
  NEEDS_KV=true
else
  # Read existing ID
  KV_ID=$(grep '^id' wrangler.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  NEEDS_KV=false
fi

if [ "$NEEDS_KV" = true ]; then
  if confirm "Create a new KV namespace?"; then
    echo "  Creating KV namespace..."
    KV_OUTPUT=$(npx wrangler kv namespace create KV 2>&1)
    KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+')
    if [ -z "$KV_ID" ]; then
      echo "$KV_OUTPUT"
      red "  Failed to parse KV namespace ID. Copy it from the output above and"
      echo "  edit wrangler.toml and dashboard-api/wrangler.toml manually."
    else
      green "  ✓ Created KV namespace: $KV_ID"
      echo ""
      # Patch both wrangler.toml files
      sed -i "s/<your-kv-namespace-id>/$KV_ID/" wrangler.toml
      sed -i "s/<your-kv-namespace-id>/$KV_ID/" dashboard-api/wrangler.toml
      green "  ✓ Updated wrangler.toml and dashboard-api/wrangler.toml"
    fi
  fi
else
  green "  ✓ KV namespace already configured: $KV_ID"
fi
echo ""

# Worker name
CURRENT_NAME=$(grep '^name' wrangler.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
if confirm "Change worker name? (currently: $CURRENT_NAME)"; then
  ask "Worker name" "$CURRENT_NAME" WORKER_NAME
  sed -i "s/^name = \".*\"/name = \"$WORKER_NAME\"/" wrangler.toml
  green "  ✓ Updated worker name to $WORKER_NAME"
fi
echo ""

# ── Step 3: API Keys ────────────────────────────────────────

banner "STEP 3: API Keys"

# Initialize .env if it doesn't exist
touch "$ROOT/.env"

# OpenRouter
echo "  $(bold 'OpenRouter') — LLM API calls"
echo "  1. Create account at https://openrouter.ai"
echo "  2. Settings → Keys → generate an API key"
echo "  3. Settings → Credits → add \$5-10"
echo ""
if confirm "Enter OpenRouter API key now?"; then
  ask_secret "OpenRouter API key (sk-or-v1-...)" OR_KEY
  if [ -n "$OR_KEY" ]; then
    write_env_var "OPENROUTER_API_KEY" "$OR_KEY"
    green "  ✓ Saved to .env"
  fi
fi
echo ""

# Slack
echo "  $(bold 'Slack') — Real-time messaging"
echo "  1. https://api.slack.com/apps → Create New App → From scratch"
echo "  2. OAuth & Permissions → add scopes: chat:write, channels:history, im:history, channels:read"
echo "  3. Install to Workspace → copy Bot User OAuth Token (xoxb-...)"
echo "  4. Basic Information → copy Signing Secret"
echo "  5. Get your channel ID (right-click channel → View details)"
echo "  6. Invite the bot: /invite @YourBot"
echo ""
if confirm "Enter Slack credentials now?"; then
  ask_secret "Bot Token (xoxb-...)" SLACK_TOKEN
  [ -n "$SLACK_TOKEN" ] && write_env_var "SLACK_BOT_TOKEN" "$SLACK_TOKEN"

  ask "Channel ID (C...)" "" SLACK_CHAN
  [ -n "$SLACK_CHAN" ] && write_env_var "SLACK_CHANNEL_ID" "$SLACK_CHAN"

  ask_secret "Signing Secret" SLACK_SECRET
  [ -n "$SLACK_SECRET" ] && write_env_var "SLACK_SIGNING_SECRET" "$SLACK_SECRET"

  green "  ✓ Saved to .env"
fi
echo ""

# Gmail
echo "  $(bold 'Gmail') — Email send/receive"
echo "  1. Google Cloud Console → create project → enable Gmail API"
echo "  2. OAuth consent screen → configure (add your email as test user)"
echo "  3. Credentials → OAuth client ID → Web application"
echo "  4. Add http://localhost:8089 as authorized redirect URI"
echo "  5. Copy Client ID and Client Secret"
echo ""
if confirm "Enter Gmail OAuth credentials now?"; then
  ask_secret "Gmail Client ID" GMAIL_CID
  [ -n "$GMAIL_CID" ] && write_env_var "GMAIL_CLIENT_ID" "$GMAIL_CID"

  ask_secret "Gmail Client Secret" GMAIL_CS
  [ -n "$GMAIL_CS" ] && write_env_var "GMAIL_CLIENT_SECRET" "$GMAIL_CS"

  green "  ✓ Saved to .env"
  echo ""

  if confirm "Generate Gmail refresh token now? (opens browser)"; then
    echo ""
    echo "  Starting OAuth flow..."
    # Source .env so gmail-auth.mjs can read the vars
    set -a; source "$ROOT/.env"; set +a
    node scripts/gmail-auth.mjs &
    GMAIL_PID=$!
    echo ""
    echo "  After completing the OAuth flow, paste the refresh token:"
    ask_secret "Refresh token" GMAIL_RT
    [ -n "$GMAIL_RT" ] && write_env_var "GMAIL_REFRESH_TOKEN" "$GMAIL_RT"
    kill $GMAIL_PID 2>/dev/null || true
    green "  ✓ Saved to .env"
  else
    dim "  Run 'source .env && node scripts/gmail-auth.mjs' later to generate the refresh token."
  fi
fi
echo ""

# ── Step 4: Patron Identity ─────────────────────────────────

banner "STEP 4: Patron Identity"

echo "  Your patron Ed25519 keypair is used for identity verification."
echo "  The public key goes into config/contacts.json."
echo ""

PATRON_KEY_FILE="$ROOT/patron_key"
if [ -f "$PATRON_KEY_FILE" ]; then
  green "  ✓ Patron key already exists at patron_key"
  PATRON_PUBKEY=$(cat "${PATRON_KEY_FILE}.pub")
elif confirm "Generate a new Ed25519 keypair?"; then
  ssh-keygen -t ed25519 -C "swayambhu patron key" -f "$PATRON_KEY_FILE" -N ""
  PATRON_PUBKEY=$(cat "${PATRON_KEY_FILE}.pub")
  green "  ✓ Generated patron_key and patron_key.pub"
  echo ""
  dim "  Keep patron_key safe — it's your identity proof to the agent."
else
  echo ""
  ask "Paste your existing Ed25519 public key" "" PATRON_PUBKEY
fi
echo ""

# ── Step 5: Contact Config ──────────────────────────────────

banner "STEP 5: Contact Config"

echo "  Setting up your patron contact record."
echo ""

ask "Your name" "" PATRON_NAME
ask "Contact slug (lowercase, underscores)" "$(echo "$PATRON_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')" PATRON_SLUG
ask "Timezone" "UTC" PATRON_TZ
ask "Brief description of yourself" "" PATRON_ABOUT
ask "Slack user ID (U..., from your Slack profile)" "" PATRON_SLACK_ID

# Build contacts.json
cat > "$ROOT/config/contacts.json" <<CONTACTS_EOF
{
  "patron": {
    "slug": "${PATRON_SLUG}",
    "public_key": "${PATRON_PUBKEY:-ssh-ed25519 PLACEHOLDER}"
  },
  "contacts": {
    "${PATRON_SLUG}": {
      "name": "${PATRON_NAME}",
      "relationship": "patron",
      "about": "${PATRON_ABOUT}",
      "timezone": "${PATRON_TZ}",
      "chat": {
        "model": "sonnet",
        "effort": "high",
        "max_cost_per_conversation": 1.00,
        "max_output_tokens": 2000
      },
      "communication": ""
    }
  },
  "platform_bindings": {
    "slack:${PATRON_SLACK_ID:-PLACEHOLDER}": {
      "slug": "${PATRON_SLUG}",
      "approved": true
    }
  }
}
CONTACTS_EOF

green "  ✓ Generated config/contacts.json"
echo ""

# Dashboard config
ask "Dashboard timezone" "$PATRON_TZ" DASH_TZ
ask "Dashboard locale" "en-US" DASH_LOCALE

cat > "$ROOT/site/patron/config.js" <<CONFIG_EOF
// Dashboard patron config — edit these values to customize the dashboard.
window.DASHBOARD_CONFIG = {
  timezone: "${DASH_TZ}",
  locale: "${DASH_LOCALE}",
  truncate: {
    jsonString: 800,
    textBlock: 800,
  },
  watchIntervalMs: 2000,
};
CONFIG_EOF

green "  ✓ Updated site/patron/config.js"
echo ""

# ── Step 6: Agent Identity ───────────────────────────────────

banner "STEP 6: Agent Identity (DID)"

if confirm "Generate a new agent identity?"; then
  node scripts/generate-identity.js --json > /tmp/swayambhu-identity.json
  # Extract the KV payload (without private key)
  node -e "
    const id = require('/tmp/swayambhu-identity.json');
    const kv = {
      did: id.did,
      address: id.address,
      chain_id: id.chainId,
      chain_name: id.chainName,
      registry: id.registry,
      registry_deployed: false,
      created_at: id.generatedAt,
      dharma_hash: null,
      controller: id.address,
    };
    require('fs').writeFileSync('config/identity.json', JSON.stringify(kv, null, 2) + '\n');
    console.log('  DID: ' + id.did);
    console.log('  ⚠  Private key: ' + id.privateKeyHex);
    console.log('  Store the private key somewhere safe!');
  "
  rm /tmp/swayambhu-identity.json
  green "  ✓ Generated config/identity.json"
else
  dim "  Skipping — using existing config/identity.json"
fi
echo ""

# ── Step 7: DHARMA.md ────────────────────────────────────────

banner "STEP 7: DHARMA.md"

echo "  DHARMA.md is the agent's immutable identity document."
echo "  It defines who the agent is, what it's for, and what it values."
echo "  Once seeded, the kernel protects it from modification."
echo ""

if [ -f "$ROOT/DHARMA.md" ]; then
  echo "  Current DHARMA.md:"
  dim "  $(head -3 "$ROOT/DHARMA.md")"
  echo "  ..."
  echo ""
  if ! confirm "Keep current DHARMA.md?"; then
    echo ""
    echo "  Edit DHARMA.md manually before proceeding to the next step."
    echo "  Press Enter when done..."
    read -r
  fi
else
  echo "  No DHARMA.md found. You need to create one before seeding."
  echo "  Press Enter after creating it..."
  read -r
fi
echo ""

# ── Step 8: Seed and Run ────────────────────────────────────

banner "STEP 8: Seed and Run"

echo "  Everything is configured. Ready to seed local KV and start."
echo ""

if confirm "Seed KV and start the agent?"; then
  echo ""
  echo "  Seeding and starting..."
  echo ""
  set -a; source "$ROOT/.env"; set +a
  bash scripts/start.sh --reset-all-state --wake --set act.model=deepseek --set reflect.model=deepseek
  echo ""
  green "  ✓ Agent is running!"
  echo ""
  echo "  Dashboard: http://localhost:3001/patron/ (key: test)"
  echo "  Kernel:    http://localhost:8787"
  echo "  Manual wake: curl http://localhost:8787/__scheduled"
  echo ""
  echo "  Using DeepSeek models for development (~30x cheaper than Claude)."
  echo "  To switch to production models, restart without --set flags."
else
  echo ""
  echo "  To start later:"
  echo "    source .env && bash scripts/start.sh --reset-all-state --wake"
fi

echo ""
green "  Setup complete!"
echo ""

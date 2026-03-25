#!/usr/bin/env bash
# Interactive setup script for Swayambhu.
# Walks through account setup, generates config files, and seeds local KV.
#
# Usage:
#   bash scripts/setup.sh           # full setup (skips already-done steps)
#   bash scripts/setup.sh --status   # show what's configured and what's missing
#
# You can run this script multiple times — it detects what's already done
# and skips those steps, so you can set up services at your own pace.

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
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

env_has() {
  local key="$1"
  [ -f "$ROOT/.env" ] && grep -q "^${key}=.\+" "$ROOT/.env"
}

kv_configured() {
  [ -f wrangler.toml ] && ! grep -q '<your-kv-namespace-id>' wrangler.toml 2>/dev/null
}

contacts_configured() {
  [ -f config/contacts.json ] && ! grep -q 'PLACEHOLDER' config/contacts.json 2>/dev/null
}

# ── Status mode ──────────────────────────────────────────────

if [ "${1:-}" = "--status" ]; then
  echo ""
  accent "  SWAYAMBHU SETUP STATUS"
  echo ""

  status_line() {
    if $1; then green "  ✓ $2"; else red "  ✗ $2 — $3"; fi
    echo ""
  }

  status_line "command -v node &>/dev/null" "Node.js" "install from https://nodejs.org"
  status_line "[ -d node_modules ]" "Dependencies installed" "run: npm install"
  status_line "npx wrangler whoami &>/dev/null 2>&1" "Wrangler logged in" "run: npx wrangler login"
  status_line "kv_configured" "KV namespace configured" "run: bash scripts/setup.sh"
  status_line "env_has OPENROUTER_API_KEY" "OpenRouter API key" "run: bash scripts/setup.sh"
  status_line "env_has SLACK_BOT_TOKEN" "Slack bot token" "run: bash scripts/setup.sh"
  status_line "env_has SLACK_SIGNING_SECRET" "Slack signing secret" "run: bash scripts/setup.sh"
  status_line "env_has GMAIL_REFRESH_TOKEN" "Gmail refresh token" "run: bash scripts/setup.sh"
  status_line "[ -f patron_key ]" "Patron keypair" "run: bash scripts/setup.sh"
  status_line "contacts_configured" "Contact config" "run: bash scripts/setup.sh"
  status_line "[ -f DHARMA.md ]" "DHARMA.md" "create your agent's identity document"

  echo ""
  # Summary
  MISSING=0
  env_has OPENROUTER_API_KEY || MISSING=$((MISSING + 1))
  kv_configured || MISSING=$((MISSING + 1))
  contacts_configured || MISSING=$((MISSING + 1))
  [ -f DHARMA.md ] || MISSING=$((MISSING + 1))

  if [ "$MISSING" -eq 0 ]; then
    green "  Ready to run!"
    echo ""
    echo "  source .env && bash scripts/start.sh --reset-all-state --wake"
  else
    echo "  $MISSING required item(s) still missing."
    echo "  Run $(bold 'bash scripts/setup.sh') to continue setup."
  fi
  echo ""
  exit 0
fi

# ── Preamble ─────────────────────────────────────────────────

clear 2>/dev/null || true
echo ""
accent "  SWAYAMBHU SETUP"
echo ""
echo "  This script walks you through setting up your own Swayambhu"
echo "  instance. Each step can be skipped and completed later —"
echo "  just re-run this script to pick up where you left off."
echo ""
echo "  Steps that are already done will be auto-skipped."
echo ""
echo "  Run $(bold 'bash scripts/setup.sh --status') anytime to see"
echo "  what's configured and what's still needed."
echo ""
echo "  Press Ctrl+C to stop and come back later."
echo ""

if ! confirm "Ready to start?"; then
  echo "  Aborted. Re-run anytime to continue."
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
    dim "  Skipping — run 'npx wrangler login' when ready."
    echo ""
  fi
else
  green "  ✓ Already logged in to Wrangler"
  echo ""
fi

# KV namespace
if kv_configured; then
  KV_ID=$(grep '^id' wrangler.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  green "  ✓ KV namespace already configured: $KV_ID"
else
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
      sed -i "s/<your-kv-namespace-id>/$KV_ID/" wrangler.toml
      sed -i "s/<your-kv-namespace-id>/$KV_ID/" dashboard-api/wrangler.toml
      green "  ✓ Updated wrangler.toml and dashboard-api/wrangler.toml"
    fi
  else
    dim "  Skipping — edit wrangler.toml manually when ready."
  fi
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
echo "  Skip any service you haven't set up yet — re-run this"
echo "  script later to add them."
echo ""

touch "$ROOT/.env"

# OpenRouter
if env_has OPENROUTER_API_KEY; then
  green "  ✓ OpenRouter API key already set"
else
  echo "  $(bold 'OpenRouter') — LLM API calls (required)"
  echo "  1. Create account at https://openrouter.ai"
  echo "  2. Settings → Keys → generate an API key"
  echo "  3. Settings → Credits → add \$5-10"
  echo ""
  if confirm "Enter OpenRouter API key now?"; then
    ask_secret "API key (sk-or-v1-...)" OR_KEY
    if [ -n "$OR_KEY" ]; then
      write_env_var "OPENROUTER_API_KEY" "$OR_KEY"
      green "  ✓ Saved to .env"
    fi
  else
    dim "  Skipping — add OPENROUTER_API_KEY to .env when ready."
  fi
fi
echo ""

# Slack
if env_has SLACK_BOT_TOKEN && env_has SLACK_SIGNING_SECRET; then
  green "  ✓ Slack credentials already set"
else
  echo "  $(bold 'Slack') — Real-time messaging (optional, can add later)"
  echo "  1. https://api.slack.com/apps → Create New App → From scratch"
  echo "  2. OAuth & Permissions → add scopes: chat:write, channels:history,"
  echo "     im:history, channels:read"
  echo "  3. Install to Workspace → copy Bot User OAuth Token (xoxb-...)"
  echo "  4. Basic Information → copy Signing Secret"
  echo "  5. Get channel ID (right-click channel → View details)"
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
  else
    dim "  Skipping — add Slack vars to .env when ready."
  fi
fi
echo ""

# Gmail
if env_has GMAIL_REFRESH_TOKEN; then
  green "  ✓ Gmail credentials already set"
else
  echo "  $(bold 'Gmail') — Email send/receive (optional, can add later)"
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
      dim "  Run 'source .env && node scripts/gmail-auth.mjs' later."
    fi
  else
    dim "  Skipping — add Gmail vars to .env when ready."
  fi
fi
echo ""

# ── Step 4: Patron Identity ─────────────────────────────────

banner "STEP 4: Patron Identity"

PATRON_KEY_FILE="$ROOT/patron_key"
PATRON_PUBKEY=""

if [ -f "$PATRON_KEY_FILE" ]; then
  green "  ✓ Patron key already exists at patron_key"
  PATRON_PUBKEY=$(cat "${PATRON_KEY_FILE}.pub")
else
  echo "  Your Ed25519 keypair is used for identity verification."
  echo ""
  if confirm "Generate a new Ed25519 keypair?"; then
    ssh-keygen -t ed25519 -C "swayambhu patron key" -f "$PATRON_KEY_FILE" -N ""
    PATRON_PUBKEY=$(cat "${PATRON_KEY_FILE}.pub")
    green "  ✓ Generated patron_key and patron_key.pub"
    echo ""
    dim "  Keep patron_key safe — it's your identity proof to the agent."
  else
    if confirm "Paste an existing public key?"; then
      ask "Ed25519 public key" "" PATRON_PUBKEY
    else
      dim "  Skipping — generate a keypair when ready."
    fi
  fi
fi
echo ""

# ── Step 5: Contact Config ──────────────────────────────────

banner "STEP 5: Contact Config"

if contacts_configured; then
  green "  ✓ config/contacts.json already configured"
  echo ""
  if ! confirm "Reconfigure?"; then
    echo ""
    # skip to next step
    SKIP_CONTACTS=true
  else
    SKIP_CONTACTS=false
  fi
else
  SKIP_CONTACTS=false
fi

if [ "${SKIP_CONTACTS:-false}" = false ]; then
  echo "  Setting up your patron contact record."
  echo ""

  ask "Your name" "" PATRON_NAME
  ask "Contact slug (lowercase, underscores)" "$(echo "$PATRON_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')" PATRON_SLUG
  ask "Timezone" "UTC" PATRON_TZ
  ask "Brief description of yourself" "" PATRON_ABOUT
  ask "Slack user ID (U..., or leave blank to add later)" "" PATRON_SLACK_ID

  SLACK_BINDING_KEY="slack:${PATRON_SLACK_ID:-PLACEHOLDER}"

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
    "${SLACK_BINDING_KEY}": {
      "slug": "${PATRON_SLUG}",
      "approved": true
    }
  }
}
CONTACTS_EOF

  green "  ✓ Generated config/contacts.json"
  echo ""

  # Dashboard config
  ask "Dashboard timezone" "${PATRON_TZ:-UTC}" DASH_TZ
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
fi
echo ""

# ── Step 6: Agent Identity ───────────────────────────────────

banner "STEP 6: Agent Identity (DID)"

# Check if identity.json has a non-default DID
CURRENT_DID=$(node -e "try{console.log(require('./config/identity.json').did)}catch{}" 2>/dev/null || echo "")

if [ -n "$CURRENT_DID" ]; then
  green "  ✓ Agent identity exists: $CURRENT_DID"
  echo ""
  if ! confirm "Generate a new one? (replaces existing)"; then
    echo ""
    SKIP_IDENTITY=true
  else
    SKIP_IDENTITY=false
  fi
else
  SKIP_IDENTITY=false
fi

if [ "${SKIP_IDENTITY:-false}" = false ]; then
  if confirm "Generate a new agent identity?"; then
    node scripts/generate-identity.js --json > /tmp/swayambhu-identity.json
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
    dim "  Skipping — run 'node scripts/generate-identity.js' when ready."
  fi
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
    echo "  Edit DHARMA.md in your editor, then press Enter to continue..."
    read -r
  fi
else
  echo "  No DHARMA.md found. Create one before seeding."
  echo "  This is the most important file — it defines your agent's purpose."
  echo ""
  echo "  Press Enter after creating DHARMA.md..."
  read -r
fi
echo ""

# ── Step 8: Seed and Run ────────────────────────────────────

banner "STEP 8: Seed and Run"

# Check minimum requirements
READY=true
MISSING_ITEMS=""

if ! kv_configured; then
  READY=false
  MISSING_ITEMS="${MISSING_ITEMS}\n  ✗ KV namespace not configured in wrangler.toml"
fi

if ! env_has OPENROUTER_API_KEY; then
  READY=false
  MISSING_ITEMS="${MISSING_ITEMS}\n  ✗ OPENROUTER_API_KEY not set in .env"
fi

if [ ! -f "$ROOT/DHARMA.md" ]; then
  READY=false
  MISSING_ITEMS="${MISSING_ITEMS}\n  ✗ DHARMA.md not found"
fi

if ! contacts_configured; then
  READY=false
  MISSING_ITEMS="${MISSING_ITEMS}\n  ✗ config/contacts.json has PLACEHOLDERs"
fi

if [ "$READY" = true ]; then
  green "  ✓ All requirements met"
  echo ""

  # Show optional items that are missing
  if ! env_has SLACK_BOT_TOKEN; then
    dim "  ⊘ Slack not configured (agent will run without chat)"
    echo ""
  fi
  if ! env_has GMAIL_REFRESH_TOKEN; then
    dim "  ⊘ Gmail not configured (agent will run without email)"
    echo ""
  fi

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
else
  echo "  Not ready to run yet. Missing:"
  echo -e "$MISSING_ITEMS"
  echo ""
  echo "  Fix the items above and re-run: $(bold 'bash scripts/setup.sh')"
  echo "  Or check status anytime:        $(bold 'bash scripts/setup.sh --status')"
fi

echo ""
green "  Setup complete!"
echo ""
echo "  Re-run this script anytime to add missing services."
echo "  Check status: bash scripts/setup.sh --status"
echo ""

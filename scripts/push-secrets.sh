#!/usr/bin/env bash
# Push all secrets from .env to Cloudflare Workers (production).
#
# Usage: bash scripts/push-secrets.sh [--dashboard]
#
# By default, pushes to the main worker.
# With --dashboard, pushes PATRON_KEY to the dashboard worker.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

bold() { printf "\033[1m%s\033[0m" "$*"; }
green() { printf "\033[1;32m%s\033[0m" "$*"; }
dim() { printf "\033[2m%s\033[0m" "$*"; }

if [ "${1:-}" = "--dashboard" ]; then
  echo ""
  echo "Pushing secrets to $(bold 'dashboard-api') worker..."
  echo ""
  printf "  Enter patron key for production dashboard: "
  read -rs PATRON_KEY
  echo ""
  echo -n "$PATRON_KEY" | npx wrangler secret put PATRON_KEY --cwd "$ROOT/dashboard-api"
  green "  ✓ PATRON_KEY set"
  echo ""
  exit 0
fi

# Main worker secrets
SECRETS=(
  OPENROUTER_API_KEY
  SLACK_BOT_TOKEN
  SLACK_CHANNEL_ID
  SLACK_SIGNING_SECRET
  CF_ACCESS_CLIENT_ID
  CF_ACCESS_CLIENT_SECRET
  EMAIL_RELAY_SECRET
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN
  GOOGLE_SA_CLIENT_EMAIL
  GOOGLE_SA_PRIVATE_KEY
)

echo ""
echo "Pushing secrets to $(bold 'main') worker from .env..."
echo ""

# Source .env
set -a; source "$ENV_FILE"; set +a

pushed=0
skipped=0

for secret in "${SECRETS[@]}"; do
  value="${!secret:-}"
  if [ -z "$value" ]; then
    dim "  ⊘ $secret (not set, skipping)"
    echo ""
    skipped=$((skipped + 1))
    continue
  fi
  echo -n "$value" | npx wrangler secret put "$secret" --cwd "$ROOT" 2>/dev/null
  green "  ✓ $secret"
  echo ""
  pushed=$((pushed + 1))
done

echo ""
echo "Done: $pushed pushed, $skipped skipped."
echo ""
echo "Don't forget to also push the dashboard patron key:"
echo "  bash scripts/push-secrets.sh --dashboard"
echo ""

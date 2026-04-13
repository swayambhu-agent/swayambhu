#!/usr/bin/env bash
# Push secrets from .env to Cloudflare Workers.
#
# Usage:
#   bash scripts/cloudflare/push-secrets.sh [--env staging]
#   bash scripts/cloudflare/push-secrets.sh --dashboard [--env staging]
#   bash scripts/cloudflare/push-secrets.sh --governor [--env staging]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

bold() { printf "\033[1m%s\033[0m" "$*"; }
green() { printf "\033[1;32m%s\033[0m" "$*"; }
dim() { printf "\033[2m%s\033[0m" "$*"; }

TARGET="runtime"
ENV_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dashboard) TARGET="dashboard" ;;
    --governor) TARGET="governor" ;;
    --env)
      ENV_NAME="${2:-}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
  shift
done

WRANGLER_ENV_ARGS=()
if [ -n "$ENV_NAME" ]; then
  WRANGLER_ENV_ARGS+=(--env "$ENV_NAME")
fi

set -a
source "$ENV_FILE"
set +a

if [ "$TARGET" = "dashboard" ]; then
  echo ""
  echo "Pushing secrets to $(bold 'dashboard-api') worker${ENV_NAME:+ ($ENV_NAME)}..."
  echo ""
  printf "  Enter patron key: "
  read -rs PATRON_KEY
  echo ""
  echo -n "$PATRON_KEY" | npx wrangler secret put PATRON_KEY --cwd "$ROOT/dashboard-api" "${WRANGLER_ENV_ARGS[@]}"
  green "  ✓ PATRON_KEY set"
  echo ""
  exit 0
fi

push_secret_group() {
  local title="$1"
  local cwd="$2"
  shift 2
  local pushed=0
  local skipped=0

  echo ""
  echo "Pushing secrets to $(bold "$title")${ENV_NAME:+ ($ENV_NAME)} from .env..."
  echo ""

  for secret in "$@"; do
    local value="${!secret:-}"
    if [ -z "$value" ]; then
      dim "  ⊘ $secret (not set, skipping)"
      echo ""
      skipped=$((skipped + 1))
      continue
    fi
    echo -n "$value" | (cd "$cwd" && npx wrangler secret put "$secret" "${WRANGLER_ENV_ARGS[@]}") 2>/dev/null
    green "  ✓ $secret"
    echo ""
    pushed=$((pushed + 1))
  done

  echo ""
  echo "Done: $pushed pushed, $skipped skipped."
  echo ""
}

if [ "$TARGET" = "governor" ]; then
  push_secret_group "governor" "$ROOT/governor" \
    CF_API_TOKEN \
    CF_ACCOUNT_ID \
    CF_SCRIPT_NAME \
    GITHUB_TOKEN \
    GITHUB_REPO \
    GITHUB_BRANCH
  exit 0
fi

push_secret_group "runtime" "$ROOT" \
  OPENROUTER_API_KEY \
  BRAVE_SEARCH_API_KEY \
  SLACK_BOT_TOKEN \
  SLACK_CHANNEL_ID \
  SLACK_SIGNING_SECRET \
  CF_ACCESS_CLIENT_ID \
  CF_ACCESS_CLIENT_SECRET \
  EMAIL_RELAY_SECRET \
  COMPUTER_API_KEY \
  WALLET_ADDRESS \
  WALLET_PRIVATE_KEY

echo "Don't forget to also push the dashboard patron key:"
echo "  bash scripts/cloudflare/push-secrets.sh --dashboard${ENV_NAME:+ --env $ENV_NAME}"
echo ""

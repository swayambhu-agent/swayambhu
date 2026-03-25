#!/usr/bin/env bash
# Restore the pre-trigger KV snapshot taken by start.sh --trigger.
# This kills running workers (they hold the SQLite handle), replaces
# .wrangler/shared-state with the snapshot, and prints restart instructions.
set -euo pipefail
cd "$(dirname "$0")/.."

SNAPSHOT=".wrangler/pre-trigger-snapshot"
STATE=".wrangler/shared-state"

if [[ ! -d "$SNAPSHOT" ]]; then
  echo "ERROR: No snapshot found at $SNAPSHOT"
  echo "Run 'bash scripts/start.sh --trigger' first to create one."
  exit 1
fi

echo "=== Killing workers (they hold the SQLite handle) ==="
pkill -f workerd 2>/dev/null || true
sleep 1
pkill -9 -f workerd 2>/dev/null || true
pkill -f "dev-serve.mjs" 2>/dev/null || true

echo "=== Waiting for ports to free ==="
for i in $(seq 1 15); do
  busy=false
  for port in 8787 8790 3001; do
    if ss -tlnp 2>/dev/null | grep -qE ":${port}([^0-9]|$)" || \
       lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
      busy=true
      break
    fi
  done
  if ! $busy; then break; fi
  if [ "$i" -eq 15 ]; then
    echo "WARNING: ports still in use after 15s — proceeding anyway"
  fi
  sleep 1
done

echo "=== Restoring snapshot ==="
rm -rf "$STATE"
cp -r "$SNAPSHOT" "$STATE"

echo ""
echo "State restored. Restart services with:"
echo "  source .env && bash scripts/start.sh [--trigger] [--set ...]"

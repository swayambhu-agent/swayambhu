#!/usr/bin/env bash
# Restore the pre-trigger KV snapshot taken by start.sh --trigger.
# This kills running workers (they hold the SQLite handle), replaces
# .wrangler/shared-state with the snapshot, and prints restart instructions.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="${SWAYAMBHU_PERSIST_DIR:-.wrangler/shared-state}"
STATE="$(realpath -m "$STATE")"
SNAPSHOT="${SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR:-$(dirname "$STATE")/pre-trigger-snapshot}"
SNAPSHOT="$(realpath -m "$SNAPSHOT")"
KERNEL_PORT="${SWAYAMBHU_KERNEL_PORT:-8787}"
DASHBOARD_PORT="${SWAYAMBHU_DASHBOARD_PORT:-8790}"
SPA_PORT="${SWAYAMBHU_SPA_PORT:-3001}"
GOVERNOR_PORT="${SWAYAMBHU_GOVERNOR_PORT:-8791}"
DASHBOARD_INSPECTOR_PORT="${SWAYAMBHU_DASHBOARD_INSPECTOR_PORT:-9230}"
GOVERNOR_INSPECTOR_PORT="${SWAYAMBHU_GOVERNOR_INSPECTOR_PORT:-9231}"
GOVERNOR=true
case "${SWAYAMBHU_GOVERNOR_ENABLED:-}" in
  0|false|FALSE|no|NO) GOVERNOR=false ;;
  1|true|TRUE|yes|YES) GOVERNOR=true ;;
esac
ISOLATED_START=false
case "${SWAYAMBHU_START_ISOLATED:-false}" in
  1|true|TRUE|yes|YES) ISOLATED_START=true ;;
esac

if [[ ! -d "$SNAPSHOT" ]]; then
  echo "ERROR: No snapshot found at $SNAPSHOT"
  echo "Run 'bash scripts/start.sh --trigger' first to create one."
  exit 1
fi

echo "=== Killing workers (they hold the SQLite handle) ==="
if $ISOLATED_START; then
  pkill -f -- "$STATE" 2>/dev/null || true
  pkill -9 -f -- "$STATE" 2>/dev/null || true
  pkill -f -- "dev-serve.mjs $SPA_PORT" 2>/dev/null || true
else
  pkill -f workerd 2>/dev/null || true
  sleep 1
  pkill -9 -f workerd 2>/dev/null || true
  pkill -f "dev-serve.mjs" 2>/dev/null || true
fi

echo "=== Waiting for ports to free ==="
PORTS="$KERNEL_PORT $DASHBOARD_PORT $SPA_PORT $DASHBOARD_INSPECTOR_PORT"
if $GOVERNOR; then
  PORTS="$PORTS $GOVERNOR_PORT $GOVERNOR_INSPECTOR_PORT"
fi
for i in $(seq 1 15); do
  busy=false
  for port in $PORTS; do
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
echo "  SWAYAMBHU_PERSIST_DIR=\"$STATE\" SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR=\"$SNAPSHOT\" SWAYAMBHU_KERNEL_PORT=\"$KERNEL_PORT\" SWAYAMBHU_DASHBOARD_PORT=\"$DASHBOARD_PORT\" SWAYAMBHU_SPA_PORT=\"$SPA_PORT\" SWAYAMBHU_GOVERNOR_PORT=\"$GOVERNOR_PORT\" SWAYAMBHU_DASHBOARD_INSPECTOR_PORT=\"$DASHBOARD_INSPECTOR_PORT\" SWAYAMBHU_GOVERNOR_INSPECTOR_PORT=\"$GOVERNOR_INSPECTOR_PORT\" SWAYAMBHU_GOVERNOR_ENABLED=\"$GOVERNOR\" SWAYAMBHU_START_ISOLATED=\"$ISOLATED_START\" source .env && bash scripts/start.sh [--trigger] [--set ...]"

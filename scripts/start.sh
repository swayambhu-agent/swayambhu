#!/usr/bin/env bash
# Start Swayambhu dev environment.
# Usage: source .env && bash scripts/start.sh [options]
#
# Options:
#   --trigger               Trigger a session after services are ready
#   --reset-all-state       Wipe ALL local KV state and re-seed from scratch
#                           (deletes sessions, karma, wisdom, config, everything)
#   --yes                   Skip confirmation prompt (for scripts/CI)
#   --governor              Also start the governor worker (not needed for normal dev)
#   --set path=value        Override a config:defaults value after seeding
#                           (dot-path, e.g. act.model=deepseek)
#                           Can be specified multiple times
#
# Examples:
#   bash scripts/start.sh                           # start services only
#   bash scripts/start.sh --trigger                    # start + trigger session
#   bash scripts/start.sh --reset-all-state --trigger  # full reset + trigger session
#   bash scripts/start.sh --reset-all-state --set act.model=deepseek --set reflect.model=deepseek
#   bash scripts/start.sh --reset-all-state --yes   # skip confirmation
#
# Starts:
#   Kernel      http://localhost:8787
#   Dashboard API  http://localhost:8790
#   Dashboard SPA  http://localhost:3001

set -euo pipefail
cd "$(dirname "$0")/.."

STATE_DIR="${SWAYAMBHU_PERSIST_DIR:-.wrangler/shared-state}"
STATE_DIR="$(realpath -m "$STATE_DIR")"
PRE_TRIGGER_SNAPSHOT_DIR="${SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR:-$(dirname "$STATE_DIR")/pre-trigger-snapshot}"
PRE_TRIGGER_SNAPSHOT_DIR="$(realpath -m "$PRE_TRIGGER_SNAPSHOT_DIR")"
SPA_PORT="${SWAYAMBHU_SPA_PORT:-3001}"
KERNEL_PORT="${SWAYAMBHU_KERNEL_PORT:-8787}"
DASHBOARD_PORT="${SWAYAMBHU_DASHBOARD_PORT:-8790}"
GOVERNOR_PORT="${SWAYAMBHU_GOVERNOR_PORT:-8791}"
DASHBOARD_INSPECTOR_PORT="${SWAYAMBHU_DASHBOARD_INSPECTOR_PORT:-9230}"
GOVERNOR_INSPECTOR_PORT="${SWAYAMBHU_GOVERNOR_INSPECTOR_PORT:-9231}"
ISOLATED_START=false
case "${SWAYAMBHU_START_ISOLATED:-false}" in
  1|true|TRUE|yes|YES) ISOLATED_START=true ;;
esac
export SWAYAMBHU_PERSIST_DIR="$STATE_DIR"

RESET=false
TRIGGER=false
SKIP_CONFIRM=false
GOVERNOR=true
case "${SWAYAMBHU_GOVERNOR_ENABLED:-}" in
  0|false|FALSE|no|NO) GOVERNOR=false ;;
  1|true|TRUE|yes|YES) GOVERNOR=true ;;
esac
OVERRIDES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --trigger) TRIGGER=true; shift ;;
    --reset-all-state) RESET=true; shift ;;
    --yes) SKIP_CONFIRM=true; shift ;;
    --governor) GOVERNOR=true; shift ;;
    --no-governor) GOVERNOR=false; shift ;;
    --set)
      [[ -z "${2:-}" || "$2" != *=* ]] && { echo "ERROR: --set requires path=value (e.g. --set act.model=deepseek)"; exit 1; }
      OVERRIDES+=("$2"); shift 2 ;;
    *) echo "Unknown option: $1"; echo "Usage: start.sh [--trigger] [--reset-all-state] [--yes] [--set path=value ...]"; exit 1 ;;
  esac
done

if [[ ${#OVERRIDES[@]} -gt 0 ]] && ! $RESET; then
  echo "WARNING: --set without --reset-all-state has no effect (config already in KV)"
fi

# Split overrides into flat path/value pairs for node argv
OVERRIDE_ARGS=()
if [[ ${#OVERRIDES[@]} -gt 0 ]]; then
  for override in "${OVERRIDES[@]}"; do
    OVERRIDE_ARGS+=("${override%%=*}" "${override#*=}")
  done
fi

PGIDS=()
CLEANING=false
cleanup() {
  $CLEANING && return
  CLEANING=true
  echo ""
  echo "=== Shutting down ==="
  for pgid in "${PGIDS[@]}"; do
    kill -- -"$pgid" 2>/dev/null || true
  done
  exit
}
trap cleanup INT TERM EXIT

# ── Helpers ────────────────────────────────────────────────────

wait_ports_free() {
  local ports="$1"
  local max_wait="${2:-15}"
  echo "=== Waiting for ports $ports to free ==="
  for i in $(seq 1 "$max_wait"); do
    local busy=false
    for port in ${ports//,/ }; do
      if ss -tlnp 2>/dev/null | grep -qE ":${port}([^0-9]|$)" || \
         netstat -tlnp 2>/dev/null | grep -qE ":${port}([^0-9]|$)" || \
         lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
        busy=true
        break
      fi
    done
    if ! $busy; then
      echo "  ports free"
      return 0
    fi
    if [ "$i" -eq "$max_wait" ]; then
      echo "ERROR: ports still in use after ${max_wait}s"
      exit 1
    fi
    sleep 1
  done
}

wait_service() {
  local name="$1"
  local url="$2"
  local max_wait="${3:-30}"
  for i in $(seq 1 "$max_wait"); do
    if curl -s -o /dev/null -w '' "$url" 2>/dev/null; then
      echo "  $name ready"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: $name did not start within ${max_wait}s"
  return 1
}

apply_overrides() {
  if [[ ${#OVERRIDES[@]} -eq 0 ]]; then return; fi

  echo "=== Applying config overrides ==="

  node --input-type=module -e "
import { Miniflare } from 'miniflare';
import { resolve } from 'path';

const root = process.cwd();
const stateDir = process.env.SWAYAMBHU_PERSIST_DIR || resolve(root, '.wrangler/shared-state');
const mf = new Miniflare({
  modules: true,
  script: \"export default { fetch() { return new Response('ok'); } }\",
  kvPersist: resolve(stateDir, 'v3/kv'),
  kvNamespaces: { KV: '05720444f9654ed4985fb67af4aea24d' },
});
const kv = await mf.getKVNamespace('KV');

const raw = await kv.get('config:defaults', 'json');
if (!raw) { console.error('ERROR: config:defaults not found in KV'); process.exit(1); }

// Parse overrides from argv pairs: path1 value1 path2 value2 ...
const args = process.argv.slice(1);
for (let i = 0; i < args.length; i += 2) {
  const path = args[i];
  const value = args[i + 1];
  const parts = path.split('.');
  let obj = raw;
  for (let j = 0; j < parts.length - 1; j++) {
    if (obj[parts[j]] === undefined) obj[parts[j]] = {};
    obj = obj[parts[j]];
  }
  const key = parts[parts.length - 1];
  // Auto-detect type: number, boolean, or string
  let parsed = value;
  if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (!isNaN(value) && value !== '') parsed = Number(value);
  obj[key] = parsed;
  console.log('  ' + path + ' = ' + JSON.stringify(parsed));
}

await kv.put('config:defaults', JSON.stringify(raw), { metadata: { format: 'json' } });
await mf.dispose();
process.exit(0);
" "${OVERRIDE_ARGS[@]}"
}

kill_stale_processes() {
  echo "=== Killing stale processes ==="
  if $ISOLATED_START; then
    pkill -f -- "$STATE_DIR" 2>/dev/null || true
    pkill -9 -f -- "$STATE_DIR" 2>/dev/null || true
    pkill -f -- "dev-serve.mjs $SPA_PORT" 2>/dev/null || true
  else
    pkill -f workerd 2>/dev/null || true
    sleep 1
    # SIGKILL any survivors (workerd can ignore SIGTERM when stuck)
    pkill -9 -f workerd 2>/dev/null || true
    pkill -f "dev-serve.mjs" 2>/dev/null || true
  fi
}

mkdir -p "$(dirname "$STATE_DIR")" "$(dirname "$PRE_TRIGGER_SNAPSHOT_DIR")"

# ── 1. Kill stale processes ────────────────────────────────────
kill_stale_processes

# ── 2. Wait for ports to actually free ─────────────────────────
PORTS_TO_WAIT="$KERNEL_PORT,$DASHBOARD_PORT,$SPA_PORT,$DASHBOARD_INSPECTOR_PORT"
if $GOVERNOR; then
  PORTS_TO_WAIT="$PORTS_TO_WAIT,$GOVERNOR_PORT,$GOVERNOR_INSPECTOR_PORT"
fi
wait_ports_free "$PORTS_TO_WAIT"

# ── 3. Reset or preserve state ─────────────────────────────────
if $RESET; then
  if ! $SKIP_CONFIRM; then
    echo ""
    echo "WARNING: --reset-all-state will PERMANENTLY DELETE all local state:"
    echo "  - All sessions and karma logs"
    echo "  - Accumulated wisdom"
    echo "  - Modification history and rollback records"
    echo "  - All config overrides"
    echo "  - Chat history"
    echo ""
    echo "Everything in $STATE_DIR will be wiped and re-seeded."
    echo ""
    read -rp "Are you sure? Type 'yes' to continue: " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  echo "=== Archiving remote agent surfaces ==="
  if ! node scripts/archive-remote-agent-surfaces.mjs; then
    echo "WARNING: remote agent surface archive failed; continuing with local reset only"
  fi

  echo "=== Clearing local state ==="
  rm -rf "$STATE_DIR"

  echo "=== Seeding KV ==="
  node scripts/seed-local-kv.mjs

  apply_overrides
else
  echo "=== Preserving existing state (use --reset-all-state to wipe) ==="
  echo "=== Syncing tool grants from source ==="
  node scripts/sync-tool-grants.mjs
  echo "=== Resetting session schedule ==="
  node scripts/reset-schedule.mjs
fi

# ── 4. Start all services ─────────────────────────────────────
echo ""
echo "=== Starting kernel (port $KERNEL_PORT) ==="
setsid npx wrangler dev -c wrangler.dev.toml --port "$KERNEL_PORT" --test-scheduled --persist-to "$STATE_DIR" &
PGIDS+=($!)

echo "=== Starting dashboard API (port $DASHBOARD_PORT) ==="
setsid bash -c 'cd dashboard-api && exec npx wrangler dev --port "'"$DASHBOARD_PORT"'" --inspector-port "'"$DASHBOARD_INSPECTOR_PORT"'" --persist-to "'"$STATE_DIR"'"' &
PGIDS+=($!)

echo "=== Building dashboard ==="
npm run build:dashboard

echo "=== Starting dashboard SPA (port $SPA_PORT) ==="
setsid node scripts/dev-serve.mjs "$SPA_PORT" &
PGIDS+=($!)

if $GOVERNOR; then
  echo "=== Starting governor (port $GOVERNOR_PORT) ==="
  setsid bash -c 'cd governor && exec npx wrangler dev --port "'"$GOVERNOR_PORT"'" --inspector-port "'"$GOVERNOR_INSPECTOR_PORT"'" --persist-to "'"$STATE_DIR"'"' &
  PGIDS+=($!)
fi

# ── 5. Wait for services to be ready ──────────────────────────
echo ""
echo "=== Waiting for services to start... ==="
wait_service "kernel" "http://localhost:$KERNEL_PORT" 30
wait_service "dashboard API" "http://localhost:$DASHBOARD_PORT" 30

# ── 6. Trigger session (if requested) ─────────────────────────
if $TRIGGER; then
  echo "=== Snapshotting state (pre-trigger) ==="
  rm -rf "$PRE_TRIGGER_SNAPSHOT_DIR"
  cp -r "$STATE_DIR" "$PRE_TRIGGER_SNAPSHOT_DIR"

  echo "=== Clearing session schedule ==="
  curl -sf -X POST http://localhost:$KERNEL_PORT/__clear-schedule || true

  echo "=== Triggering session ==="
  if ! curl -sf http://localhost:$KERNEL_PORT/__scheduled; then
    echo "WARNING: session trigger failed"
  fi
  echo ""
fi

echo ""
echo "=== Running ==="
echo "  State dir:       $STATE_DIR"
echo "  Kernel:      http://localhost:$KERNEL_PORT"
echo "  Dashboard API:  http://localhost:$DASHBOARD_PORT"
echo "  Dashboard SPA:  http://localhost:$SPA_PORT/patron/"
if $GOVERNOR; then
  echo "  Governor:       http://localhost:$GOVERNOR_PORT"
fi
echo ""
echo "  Trigger: curl http://localhost:$KERNEL_PORT/__scheduled"
if $GOVERNOR; then
  echo "  Deploy:  curl -X POST http://localhost:$GOVERNOR_PORT/deploy"
  echo "  Status:  curl http://localhost:$GOVERNOR_PORT/status"
fi
echo "  Restore: SWAYAMBHU_PERSIST_DIR=\"$STATE_DIR\" SWAYAMBHU_PRE_TRIGGER_SNAPSHOT_DIR=\"$PRE_TRIGGER_SNAPSHOT_DIR\" SWAYAMBHU_KERNEL_PORT=\"$KERNEL_PORT\" SWAYAMBHU_DASHBOARD_PORT=\"$DASHBOARD_PORT\" SWAYAMBHU_SPA_PORT=\"$SPA_PORT\" SWAYAMBHU_GOVERNOR_PORT=\"$GOVERNOR_PORT\" SWAYAMBHU_DASHBOARD_INSPECTOR_PORT=\"$DASHBOARD_INSPECTOR_PORT\" SWAYAMBHU_GOVERNOR_INSPECTOR_PORT=\"$GOVERNOR_INSPECTOR_PORT\" SWAYAMBHU_GOVERNOR_ENABLED=\"$GOVERNOR\" SWAYAMBHU_START_ISOLATED=\"$ISOLATED_START\" bash scripts/restore-snapshot.sh"
echo "  Stop:    Ctrl+C"
echo ""

wait

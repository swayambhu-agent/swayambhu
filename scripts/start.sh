#!/usr/bin/env bash
# Start Swayambhu dev environment.
# Usage: source .env && bash scripts/start.sh [options]
#
# Options:
#   --wake                  Trigger a wake cycle after services are ready
#   --reset-all-state       Wipe ALL local KV state and re-seed from scratch
#                           (deletes sessions, karma, wisdom, config, everything)
#   --yes                   Skip confirmation prompt (for scripts/CI)
#   --set path=value        Override a config:defaults value after seeding
#                           (dot-path, e.g. orient.model=deepseek)
#                           Can be specified multiple times
#
# Examples:
#   bash scripts/start.sh                           # start services only
#   bash scripts/start.sh --wake                    # start + trigger wake cycle
#   bash scripts/start.sh --reset-all-state --wake  # full reset + wake
#   bash scripts/start.sh --reset-all-state --set orient.model=deepseek --set reflect.model=deepseek
#   bash scripts/start.sh --reset-all-state --yes   # skip confirmation
#
# Starts:
#   Brainstem      http://localhost:8787
#   Dashboard API  http://localhost:8790
#   Dashboard SPA  http://localhost:3001

set -euo pipefail
cd "$(dirname "$0")/.."

SPA_PORT=3001
BRAINSTEM_PORT=8787
DASHBOARD_PORT=8790

RESET=false
WAKE=false
SKIP_CONFIRM=false
OVERRIDES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wake) WAKE=true; shift ;;
    --reset-all-state) RESET=true; shift ;;
    --yes) SKIP_CONFIRM=true; shift ;;
    --set)
      [[ -z "${2:-}" || "$2" != *=* ]] && { echo "ERROR: --set requires path=value (e.g. --set orient.model=deepseek)"; exit 1; }
      OVERRIDES+=("$2"); shift 2 ;;
    *) echo "Unknown option: $1"; echo "Usage: start.sh [--wake] [--reset-all-state] [--yes] [--set path=value ...]"; exit 1 ;;
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
const mf = new Miniflare({
  modules: true,
  script: \"export default { fetch() { return new Response('ok'); } }\",
  kvPersist: resolve(root, '.wrangler/shared-state/v3/kv'),
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

# ── 1. Kill stale processes ────────────────────────────────────
echo "=== Killing stale processes ==="
pkill -f workerd 2>/dev/null || true
sleep 1
# SIGKILL any survivors (workerd can ignore SIGTERM when stuck)
pkill -9 -f workerd 2>/dev/null || true
pkill -f "dev-serve.mjs" 2>/dev/null || true

# ── 2. Wait for ports to actually free ─────────────────────────
wait_ports_free "$BRAINSTEM_PORT,$DASHBOARD_PORT,$SPA_PORT"

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
    echo "Everything in .wrangler/shared-state/ will be wiped and re-seeded."
    echo ""
    read -rp "Are you sure? Type 'yes' to continue: " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  echo "=== Clearing local state ==="
  rm -rf .wrangler/shared-state

  echo "=== Seeding KV ==="
  node scripts/seed-local-kv.mjs

  apply_overrides
else
  echo "=== Preserving existing state (use --reset-all-state to wipe) ==="
  echo "=== Resetting wake timer ==="
  node scripts/reset-wake-timer.mjs
fi

# ── 4. Start all services ─────────────────────────────────────
echo ""
echo "=== Starting brainstem (port $BRAINSTEM_PORT) ==="
setsid npx wrangler dev -c wrangler.dev.toml --test-scheduled --persist-to .wrangler/shared-state &
PGIDS+=($!)

echo "=== Starting dashboard API (port $DASHBOARD_PORT) ==="
setsid bash -c 'cd dashboard-api && exec npx wrangler dev --port "'"$DASHBOARD_PORT"'" --inspector-port 9230 --persist-to ../.wrangler/shared-state' &
PGIDS+=($!)

echo "=== Starting dashboard SPA (port $SPA_PORT) ==="
setsid node scripts/dev-serve.mjs "$SPA_PORT" &
PGIDS+=($!)

# ── 5. Wait for services to be ready ──────────────────────────
echo ""
echo "=== Waiting for services to start... ==="
wait_service "brainstem" "http://localhost:$BRAINSTEM_PORT" 30
wait_service "dashboard API" "http://localhost:$DASHBOARD_PORT" 30

# ── 6. Trigger wake cycle (if requested) ──────────────────────
if $WAKE; then
  echo "=== Triggering wake cycle ==="
  if ! curl -sf http://localhost:$BRAINSTEM_PORT/__scheduled; then
    echo "WARNING: wake trigger failed"
  fi
  echo ""
fi

echo ""
echo "=== Running ==="
echo "  Brainstem:      http://localhost:$BRAINSTEM_PORT"
echo "  Dashboard API:  http://localhost:$DASHBOARD_PORT"
echo "  Dashboard SPA:  http://localhost:$SPA_PORT/operator/"
echo ""
echo "  Wake:  curl http://localhost:$BRAINSTEM_PORT/__scheduled"
echo "  Stop:  Ctrl+C"
echo ""

wait

#!/usr/bin/env bash

set -euo pipefail

CONTAINER_CLI=""

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNTIME_NAME="swayambhu-runtime"
REMOTE_BASE="/srv/swayambhu"
REMOTE_REPO="$REMOTE_BASE/repo"
ENV_DIR="/etc/swayambhu"
ENV_FILE="$ENV_DIR/compute.env"
SERVICE_NAME="swayambhu-compute.service"
RUNNER_PATH="/usr/local/bin/sway-deep-reflect-runner"
SYNC_REPO=1
START_IF_READY=1

usage() {
  cat <<EOF
Install the compute gateway into the runtime container.

Usage:
  bash scripts/incus/install-runtime-compute.sh [options]

Options:
  --runtime-name <name>    Runtime container name. Default: $RUNTIME_NAME
  --remote-base <path>     Base directory inside the container. Default: $REMOTE_BASE
  --skip-sync              Do not sync the repo into the container
  --write-env-only         Install/update env and unit files, but do not start the service
  --help                   Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime-name)
      RUNTIME_NAME="${2:-}"
      shift
      ;;
    --remote-base)
      REMOTE_BASE="${2:-}"
      REMOTE_REPO="$REMOTE_BASE/repo"
      shift
      ;;
    --skip-sync)
      SYNC_REPO=0
      ;;
    --write-env-only)
      START_IF_READY=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

detect_container_cli() {
  if command -v incus >/dev/null 2>&1; then
    CONTAINER_CLI="incus"
    return
  fi
  if command -v lxc >/dev/null 2>&1; then
    CONTAINER_CLI="lxc"
    return
  fi
  echo "Missing required command: incus or lxc" >&2
  exit 1
}

sync_repo() {
  local container="$1"
  local remote_repo="$2"
  local remote_parent
  remote_parent="$(dirname "$remote_repo")"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='patron_key' \
    --exclude='site/patron/app.js' \
    --exclude='site/patron/app.css' \
    -C "$ROOT" -cf - . \
  | "$CONTAINER_CLI" exec "$container" -- bash -lc "mkdir -p '$remote_repo' && tar xf - -C '$remote_repo'"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "
    chown -R swayambhu:swayambhu '$remote_parent' &&
    cd '$remote_repo' &&
    runuser -u swayambhu -- npm install
  "
}

write_env() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "
    mkdir -p '$ENV_DIR'
    if [ ! -f '$ENV_FILE' ]; then
      cat >'$ENV_FILE' <<'EOF'
COMPUTER_API_KEY=
PORT=3600
JOBS_ROOT=$REMOTE_BASE/jobs
COMPUTE_ENABLE_EXECUTE=0
COMPUTE_MAX_BODY_BYTES=262144
COMPUTE_MAX_WAIT_SECONDS=300
COMPUTE_MAX_OUTPUT_BYTES=1048576
DEEP_REFLECT_RUNNER=$RUNNER_PATH
DEEP_REFLECT_MAX_CONCURRENT=1
EOF
    fi
    chown root:swayambhu-svc '$ENV_FILE'
    chmod 640 '$ENV_FILE'
  "
}

write_placeholder_runner() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "
    if [ ! -f '$RUNNER_PATH' ]; then
      cat >'$RUNNER_PATH' <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
manifest=\"\${1:-}\"
if [ -z \"\$manifest\" ]; then
  echo 'manifest path required' >&2
  exit 64
fi
job_dir=\"\$(dirname \"\$manifest\")\"
cat >\"\$job_dir/output.json\" <<'JSON'
{\"ok\":false,\"error\":\"deep reflect runner placeholder is installed but no real runner has been configured\"}
JSON
echo 'deep reflect runner placeholder invoked' >\"\$job_dir/stderr.log\"
echo 64 >\"\$job_dir/exit_code\"
exit 64
EOF
      chmod 755 '$RUNNER_PATH'
    fi
  "
}

write_unit() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "cat >'/etc/systemd/system/$SERVICE_NAME' <<'EOF'
[Unit]
Description=Swayambhu Compute Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=swayambhu-svc
Group=swayambhu-svc
WorkingDirectory=$REMOTE_REPO
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $REMOTE_REPO/services/compute-gateway.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/tmp /var/tmp /run $REMOTE_BASE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload"
}

env_ready() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "
    awk -F= '
      BEGIN { bad = 0 }
      /^COMPUTER_API_KEY=/{ if (\$2 == \"\" || \$2 == \"REPLACE_ME\") bad = 1 }
      END { exit bad }
    ' '$ENV_FILE'
  "
}

detect_container_cli
need_cmd tar

if ! "$CONTAINER_CLI" info "$RUNTIME_NAME" >/dev/null 2>&1; then
  echo "Runtime container not found: $RUNTIME_NAME" >&2
  exit 1
fi

"$CONTAINER_CLI" exec "$RUNTIME_NAME" -- bash -lc "
  id -u swayambhu >/dev/null 2>&1 || useradd -m -s /bin/bash swayambhu
  id -u swayambhu-svc >/dev/null 2>&1 || useradd -m -r -s /usr/sbin/nologin swayambhu-svc
  mkdir -p '$REMOTE_BASE' '$REMOTE_BASE/jobs' '$ENV_DIR'
  chown swayambhu:swayambhu '$REMOTE_BASE'
  chown -R swayambhu-svc:swayambhu-svc '$REMOTE_BASE/jobs'
"

if [ "$SYNC_REPO" -eq 1 ]; then
  sync_repo "$RUNTIME_NAME" "$REMOTE_REPO"
fi

"$CONTAINER_CLI" exec "$RUNTIME_NAME" -- bash -lc "
  mkdir -p '$REMOTE_BASE/jobs'
  chown -R swayambhu-svc:swayambhu-svc '$REMOTE_BASE/jobs'
"

write_env "$RUNTIME_NAME"
write_placeholder_runner "$RUNTIME_NAME"
write_unit "$RUNTIME_NAME"

if [ "$START_IF_READY" -eq 1 ] && env_ready "$RUNTIME_NAME"; then
  "$CONTAINER_CLI" exec "$RUNTIME_NAME" -- bash -lc "
    systemctl enable --now '$SERVICE_NAME'
    curl -fsS http://127.0.0.1:3600/health >/dev/null
  "
  echo "Compute gateway installed and started in $RUNTIME_NAME."
else
  echo "Compute gateway files installed in $RUNTIME_NAME, but the service was not started."
  echo "Fill in $ENV_FILE inside the container, then run:"
  echo "  $CONTAINER_CLI exec $RUNTIME_NAME -- systemctl enable --now $SERVICE_NAME"
fi

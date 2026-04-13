#!/usr/bin/env bash

set -euo pipefail

CONTAINER_CLI=""

RUNTIME_NAME="swayambhu-runtime"
LAB_NAME="swayambhu-lab"
RUNTIME_PROFILE="sway-runtime"
LAB_PROFILE="sway-lab"
RUNTIME_BRIDGE="swrtbr0"
LAB_BRIDGE="swlabbr0"
RUNTIME_SUBNET="10.81.10.1/24"
LAB_SUBNET="10.81.20.1/24"
RUNTIME_CIDR="10.81.10.0/24"
LAB_CIDR="10.81.20.0/24"
STORAGE_POOL="default"
LAB_DATASET_VOLUME="sway-lab-datasets"
LAB_DATASET_MOUNT="/srv/datasets"
RUNTIME_CPU="4"
RUNTIME_MEMORY="8GiB"
RUNTIME_ROOT_SIZE="40GiB"
LAB_CPU="4"
LAB_MEMORY="16GiB"
LAB_ROOT_SIZE="100GiB"
LAB_DATASET_SIZE=""
INSTALL_FIREWALL_PERSISTENCE=1
INSTALL_BASELINE_PACKAGES=1

usage() {
  cat <<EOF
Create and prepare the Akash Incus layout for Swayambhu.

Usage:
  bash scripts/incus/setup-akash-containers.sh [options]

Options:
  --runtime-name <name>         Runtime container name. Default: $RUNTIME_NAME
  --lab-name <name>             Lab container name. Default: $LAB_NAME
  --storage-pool <name>         Incus storage pool. Default: $STORAGE_POOL
  --dataset-volume <name>       Lab dataset volume name. Default: $LAB_DATASET_VOLUME
  --dataset-size <size>         Optional dataset volume size, e.g. 500GiB
  --skip-firewall-persistence   Do not install iptables/netfilter persistence packages
  --skip-packages               Do not install baseline packages inside the containers
  --help                        Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime-name)
      RUNTIME_NAME="${2:-}"
      shift
      ;;
    --lab-name)
      LAB_NAME="${2:-}"
      shift
      ;;
    --storage-pool)
      STORAGE_POOL="${2:-}"
      shift
      ;;
    --dataset-volume)
      LAB_DATASET_VOLUME="${2:-}"
      shift
      ;;
    --dataset-size)
      LAB_DATASET_SIZE="${2:-}"
      shift
      ;;
    --skip-firewall-persistence)
      INSTALL_FIREWALL_PERSISTENCE=0
      ;;
    --skip-packages)
      INSTALL_BASELINE_PACKAGES=0
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

ensure_network() {
  local name="$1" addr="$2"
  if "$CONTAINER_CLI" network show "$name" >/dev/null 2>&1; then
    echo "Network exists: $name"
    return
  fi
  "$CONTAINER_CLI" network create "$name" \
    "ipv4.address=$addr" \
    "ipv4.nat=true" \
    "ipv6.address=none"
}

ensure_profile() {
  local profile="$1"
  if "$CONTAINER_CLI" profile show "$profile" >/dev/null 2>&1; then
    echo "Profile exists: $profile"
    return
  fi
  "$CONTAINER_CLI" profile create "$profile"
}

ensure_profile_device() {
  local profile="$1" device="$2"
  shift 2
  if "$CONTAINER_CLI" profile device show "$profile" | grep -q "^${device}:"; then
    echo "Profile $profile already has device $device"
    return
  fi
  "$CONTAINER_CLI" profile device add "$profile" "$device" "$@"
}

ensure_container() {
  local name="$1" profile="$2"
  if "$CONTAINER_CLI" info "$name" >/dev/null 2>&1; then
    echo "Container exists: $name"
    "$CONTAINER_CLI" config set "$name" boot.autostart true
    return
  fi
  "$CONTAINER_CLI" launch images:ubuntu/24.04 "$name" --profile "$profile"
  "$CONTAINER_CLI" config set "$name" boot.autostart true
}

ensure_forward_rule() {
  local src="$1" dst="$2"
  if sudo iptables -C FORWARD -s "$src" -d "$dst" -j DROP >/dev/null 2>&1; then
    echo "Firewall rule exists: $src -> $dst DROP"
    return
  fi
  sudo iptables -I FORWARD -s "$src" -d "$dst" -j DROP
}

install_nodesource_and_node() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y curl ca-certificates gnupg
    if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v22\."; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
    fi
  '
}

install_runtime_packages() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y git tmux jq rsync unzip sudo systemd ca-certificates curl
  '
  install_nodesource_and_node "$container"
}

install_lab_packages() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y \
      git tmux jq rsync unzip sudo systemd ca-certificates curl \
      build-essential python3 python3-dev python3-pip python3-venv \
      python3-numpy python3-scipy python3-matplotlib \
      jupyter-notebook pandoc chktex latexmk \
      texlive-latex-base texlive-latex-extra texlive-fonts-recommended \
      texlive-xetex texlive-science
  '
  install_nodesource_and_node "$container"
}

ensure_runtime_users() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc '
    id -u swayambhu >/dev/null 2>&1 || useradd -m -s /bin/bash swayambhu
    id -u swayambhu-svc >/dev/null 2>&1 || useradd -m -r -s /usr/sbin/nologin swayambhu-svc
    mkdir -p /srv/swayambhu /etc/swayambhu
    chown swayambhu:swayambhu /srv/swayambhu
    chown root:root /etc/swayambhu
    chmod 755 /etc/swayambhu
  '
}

ensure_lab_user() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc '
    id -u swayambhu >/dev/null 2>&1 || useradd -m -s /bin/bash swayambhu
    usermod -aG sudo swayambhu
    mkdir -p /srv/swayambhu /srv/datasets
    chown -R swayambhu:swayambhu /srv/swayambhu /srv/datasets
  '
}

install_runtime_wrappers() {
  local container="$1"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "cat >/usr/local/sbin/sway-runtime-restart <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case \"\${1:-}\" in
  email-gateway|compute|deep-reflect-runner) ;;
  *) echo 'allowed: email-gateway | compute | deep-reflect-runner' >&2; exit 2 ;;
esac
exec systemctl restart \"swayambhu-\${1}.service\"
EOF
chmod 755 /usr/local/sbin/sway-runtime-restart"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "cat >/usr/local/sbin/sway-runtime-logs <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case \"\${1:-}\" in
  email-gateway|compute|deep-reflect-runner) ;;
  *) echo 'allowed: email-gateway | compute | deep-reflect-runner' >&2; exit 2 ;;
esac
exec journalctl -u \"swayambhu-\${1}.service\" -n 200 --no-pager
EOF
chmod 755 /usr/local/sbin/sway-runtime-logs"
  "$CONTAINER_CLI" exec "$container" -- bash -lc "cat >/etc/sudoers.d/90-sway-runtime <<'EOF'
swayambhu ALL=(root) NOPASSWD: /usr/local/sbin/sway-runtime-restart *
swayambhu ALL=(root) NOPASSWD: /usr/local/sbin/sway-runtime-logs *
EOF
chmod 440 /etc/sudoers.d/90-sway-runtime"
}

detect_container_cli
need_cmd sudo

if [ "$INSTALL_FIREWALL_PERSISTENCE" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent netfilter-persistent
fi

ensure_network "$RUNTIME_BRIDGE" "$RUNTIME_SUBNET"
ensure_network "$LAB_BRIDGE" "$LAB_SUBNET"

ensure_profile "$RUNTIME_PROFILE"
ensure_profile_device "$RUNTIME_PROFILE" root disk path=/ "pool=$STORAGE_POOL" "size=$RUNTIME_ROOT_SIZE"
ensure_profile_device "$RUNTIME_PROFILE" eth0 nic name=eth0 "network=$RUNTIME_BRIDGE"
"$CONTAINER_CLI" profile set "$RUNTIME_PROFILE" limits.cpu "$RUNTIME_CPU"
"$CONTAINER_CLI" profile set "$RUNTIME_PROFILE" limits.memory "$RUNTIME_MEMORY"

ensure_profile "$LAB_PROFILE"
ensure_profile_device "$LAB_PROFILE" root disk path=/ "pool=$STORAGE_POOL" "size=$LAB_ROOT_SIZE"
ensure_profile_device "$LAB_PROFILE" eth0 nic name=eth0 "network=$LAB_BRIDGE"
"$CONTAINER_CLI" profile set "$LAB_PROFILE" limits.cpu "$LAB_CPU"
"$CONTAINER_CLI" profile set "$LAB_PROFILE" limits.memory "$LAB_MEMORY"

ensure_container "$RUNTIME_NAME" "$RUNTIME_PROFILE"
ensure_container "$LAB_NAME" "$LAB_PROFILE"

ensure_forward_rule "$LAB_CIDR" "$RUNTIME_CIDR"
ensure_forward_rule "$RUNTIME_CIDR" "$LAB_CIDR"
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save
fi

if ! "$CONTAINER_CLI" storage volume show "$STORAGE_POOL" "$LAB_DATASET_VOLUME" >/dev/null 2>&1; then
  "$CONTAINER_CLI" storage volume create "$STORAGE_POOL" "$LAB_DATASET_VOLUME"
fi
if [ -n "$LAB_DATASET_SIZE" ]; then
  "$CONTAINER_CLI" storage volume set "$STORAGE_POOL" "$LAB_DATASET_VOLUME" size="$LAB_DATASET_SIZE"
fi
if ! "$CONTAINER_CLI" config device show "$LAB_NAME" | grep -q '^datasets:'; then
  "$CONTAINER_CLI" config device add "$LAB_NAME" datasets disk \
    "pool=$STORAGE_POOL" \
    "source=$LAB_DATASET_VOLUME" \
    "path=$LAB_DATASET_MOUNT"
fi

if [ "$INSTALL_BASELINE_PACKAGES" -eq 1 ]; then
  install_runtime_packages "$RUNTIME_NAME"
  install_lab_packages "$LAB_NAME"
fi

ensure_runtime_users "$RUNTIME_NAME"
ensure_lab_user "$LAB_NAME"
install_runtime_wrappers "$RUNTIME_NAME"

echo ""
echo "Akash Incus layout is ready."
echo "Runtime container: $RUNTIME_NAME"
echo "Lab container:     $LAB_NAME"
echo ""
echo "Next:"
echo "  bash scripts/incus/install-runtime-relay.sh"

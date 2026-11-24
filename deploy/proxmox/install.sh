#!/usr/bin/env bash
# Proxmox VE host entry point for a fresh unprivileged Debian LXC.
# Read deploy/proxmox/README.md first. Nothing here touches host firewall,
# networking, reverse proxies or other containers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUEST_SCRIPT="$SCRIPT_DIR/install-guest.sh"

CTID=""
HOSTNAME="seizure-diary"
TEMPLATE=""
TEMPLATE_STORAGE=""
ROOTFS_STORAGE=""
BRIDGE=""
IP_CIDR=""
GATEWAY=""
VLAN=""
DNS=""
CORES="1"
MEMORY="2048"
DISK="12"
REPO_URL="https://github.com/kVinB/FPKD.git"
REF="main"
ASSUME_YES="0"
DRY_RUN="0"

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[install] %s\n' "$*"
}

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/proxmox/install.sh [options]

Provisions a fresh unprivileged Debian 12 LXC, installs Git/Node/build tools,
clones the app, builds it, and starts systemd. Requires Proxmox VE on the host.

Options:
  --ctid <id>                 Container ID (default: next free from 200)
  --hostname <name>           Guest hostname (default: seizure-diary)
  --template <volid>          Downloaded template volid, e.g. local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst
  --template-storage <id>     Storage for template download (required if not pre-downloaded)
  --rootfs-storage <id>       Storage for the container root disk (required if ambiguous)
  --bridge <name>             Network bridge (default: vmbr0 if it exists)
  --ip <cidr>                 Static IPv4/prefix, e.g. 10.20.0.5/24 (default: DHCP)
  --gateway <ip>              Gateway for static IP
  --vlan <id>                 Optional VLAN tag (1-4094)
  --dns <servers>             Comma-separated DNS servers (default: template DHCP/DNS)
  --cores <n>                 vCPUs (default: 1)
  --memory <mib>              RAM in MiB (default: 2048)
  --disk <gib>                Root disk in GiB (default: 12)
  --repo-url <url>            GitHub HTTPS or SSH repository URL
  --ref <branch>              Trusted branch to deploy (default: main)
  --yes                       Do not prompt for final confirmation
  --dry-run                   Validate and print the summary; make no changes and download nothing
  -h, --help                  Show this help

Private SSH repositories: the guest generates a deploy key on first run and
pauses so you can add it in GitHub. Resume with the printed pct command.
USAGE
}

need_value() {
  [ "$#" -ge 2 ] || die "missing value for $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ctid) need_value "$@"; CTID="$2"; shift 2 ;;
    --hostname) need_value "$@"; HOSTNAME="$2"; shift 2 ;;
    --template) need_value "$@"; TEMPLATE="$2"; shift 2 ;;
    --template-storage) need_value "$@"; TEMPLATE_STORAGE="$2"; shift 2 ;;
    --rootfs-storage) need_value "$@"; ROOTFS_STORAGE="$2"; shift 2 ;;
    --bridge) need_value "$@"; BRIDGE="$2"; shift 2 ;;
    --ip) need_value "$@"; IP_CIDR="$2"; shift 2 ;;
    --gateway) need_value "$@"; GATEWAY="$2"; shift 2 ;;
    --vlan) need_value "$@"; VLAN="$2"; shift 2 ;;
    --dns) need_value "$@"; DNS="$2"; shift 2 ;;
    --cores) need_value "$@"; CORES="$2"; shift 2 ;;
    --memory) need_value "$@"; MEMORY="$2"; shift 2 ;;
    --disk) need_value "$@"; DISK="$2"; shift 2 ;;
    --repo-url) need_value "$@"; REPO_URL="$2"; shift 2 ;;
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --yes) ASSUME_YES="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root on the Proxmox VE host"
command -v pct >/dev/null 2>&1 || die "pct is not available; is this a Proxmox VE host?"
command -v pveam >/dev/null 2>&1 || die "pveam is not available; is this a Proxmox VE host?"
command -v pvesm >/dev/null 2>&1 || die "pvesm is not available; is this a Proxmox VE host?"
[ -x "$GUEST_SCRIPT" ] || die "guest installer not found or not executable: $GUEST_SCRIPT"

case "$REPO_URL" in
  https://github.com/*/*|git@github.com:*/*) ;;
  *) die "only GitHub HTTPS or SSH repository URLs are accepted" ;;
esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --ref"
[[ "$CORES" =~ ^[1-9][0-9]*$ ]] || die "--cores must be a positive integer"
[[ "$MEMORY" =~ ^[1-9][0-9]*$ ]] || die "--memory must be a positive integer"
[[ "$DISK" =~ ^[1-9][0-9]*$ ]] || die "--disk must be a positive integer"

# Rootfs storage: never assume one exists.
mapfile -t ROOTDIR_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
if [ "${#ROOTDIR_STORAGES[@]}" -eq 0 ]; then
  die "no active storage supports container rootdir; configure storage first"
fi
if [ -n "$ROOTFS_STORAGE" ]; then
  printf '%s\n' "${ROOTDIR_STORAGES[@]}" | grep -qx "$ROOTFS_STORAGE" ||
    die "rootfs storage '$ROOTFS_STORAGE' does not support rootdir or is inactive"
elif [ "${#ROOTDIR_STORAGES[@]}" -eq 1 ]; then
  ROOTFS_STORAGE="${ROOTDIR_STORAGES[0]}"
else
  die "multiple rootfs storages available (${ROOTDIR_STORAGES[*]}); pass --rootfs-storage"
fi

# Bridge validation.
if [ -z "$BRIDGE" ]; then
  if ip -o link show vmbr0 >/dev/null 2>&1; then
    BRIDGE="vmbr0"
  else
    die "no bridge specified and vmbr0 does not exist; pass --bridge"
  fi
fi
ip -o link show "$BRIDGE" >/dev/null 2>&1 || die "bridge '$BRIDGE' does not exist on the host"

# Network settings.
NET0="name=eth0,bridge=$BRIDGE"
if [ -n "$IP_CIDR" ]; then
  [[ "$IP_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))$ ]] ||
    die "--ip must be IPv4/prefix, e.g. 10.20.0.5/24"
  [ -n "$GATEWAY" ] || die "--gateway is required with a static --ip"
  [[ "$GATEWAY" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--gateway must be an IPv4 address"
  NET0="$NET0,ip=$IP_CIDR,gw=$GATEWAY"
else
  NET0="$NET0,ip=dhcp"
fi
if [ -n "$VLAN" ]; then
  [[ "$VLAN" =~ ^([1-9][0-9]{0,2}|[1-3][0-9]{3}|40[0-8][0-9]|409[0-4])$ ]] || die "--vlan must be 1-4094"
  NET0="$NET0,tag=$VLAN"
fi
NAMESERVER=""
if [ -n "$DNS" ]; then
  NAMESERVER="${DNS//,/ }"
fi

# CTID: validate unused, never reuse or delete.
if [ -z "$CTID" ]; then
  for candidate in $(seq 200 299); do
    if ! pct status "$candidate" >/dev/null 2>&1; then
      CTID="$candidate"
      break
    fi
  done
fi
[ -n "$CTID" ] || die "no free CTID found in 200-299; pass --ctid"
[[ "$CTID" =~ ^[1-9][0-9]{2,5}$ ]] || die "--ctid must be a numeric container ID"
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists; refusing to reuse it"

# Template discovery. Never guess archive names.
TEMPLATE_VOLID="$TEMPLATE"
TEMPLATE_ARCHIVE=""
TEMPLATE_NEEDS_DOWNLOAD="0"
if [ -n "$TEMPLATE_VOLID" ]; then
  pveam list 2>/dev/null | awk '{print $1}' | grep -qx "$TEMPLATE_VOLID" ||
    die "template '$TEMPLATE_VOLID' is not present; download it with pveam first"
else
  TEMPLATE_VOLID="$(pveam list 2>/dev/null | awk '$1 ~ /debian-12-standard/ {print $1}' | sort -V | tail -1)"
  if [ -z "$TEMPLATE_VOLID" ]; then
    mapfile -t VZTMPL_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
    if [ -n "$TEMPLATE_STORAGE" ]; then
      printf '%s\n' "${VZTMPL_STORAGES[@]}" | grep -qx "$TEMPLATE_STORAGE" ||
        die "template storage '$TEMPLATE_STORAGE' does not support vztmpl or is inactive"
    elif [ "${#VZTMPL_STORAGES[@]}" -eq 1 ]; then
      TEMPLATE_STORAGE="${VZTMPL_STORAGES[0]}"
    else
      die "no downloaded Debian 12 template found; pass --template-storage (available: ${VZTMPL_STORAGES[*]:-none})"
    fi
    TEMPLATE_ARCHIVE="$(pveam available --section system 2>/dev/null | awk '$2 ~ /^debian-12-standard/ {print $2}' | sort -V | tail -1)"
    [ -n "$TEMPLATE_ARCHIVE" ] || die "no official debian-12-standard template is available from pveam"
    TEMPLATE_VOLID="$TEMPLATE_STORAGE:vztmpl/$TEMPLATE_ARCHIVE"
    TEMPLATE_NEEDS_DOWNLOAD="1"
  fi
fi

INSTALLER_REV="unknown"
if git -C "$SCRIPT_DIR/../.." rev-parse --short HEAD >/dev/null 2>&1; then
  INSTALLER_REV="$(git -C "$SCRIPT_DIR/../.." rev-parse --short HEAD)"
fi

cat <<SUMMARY

Seizure Diary Proxmox install summary
-------------------------------------
Installer revision : $INSTALLER_REV
CTID               : $CTID
Hostname           : $HOSTNAME
Template           : $TEMPLATE_VOLID$( [ "$TEMPLATE_NEEDS_DOWNLOAD" = "1" ] && printf ' (will download %s to %s)' "$TEMPLATE_ARCHIVE" "$TEMPLATE_STORAGE")
Root filesystem    : $ROOTFS_STORAGE:$DISK GiB
CPU / RAM          : $CORES vCPU / $MEMORY MiB
Network            : $NET0
DNS                : ${NAMESERVER:-provider default}
Repository         : $REPO_URL
Ref                : $REF

The guest will be unprivileged. Host firewall, networking, reverse proxy and
cluster settings are not modified. The app binds to loopback inside the guest.
SUMMARY

if [ "$DRY_RUN" = "1" ]; then
  log "Dry run complete. No changes were made and nothing was downloaded."
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf '\nType "install" to create the container: '
  read -r answer
  [ "$answer" = "install" ] || die "aborted by operator"
fi

if [ "$TEMPLATE_NEEDS_DOWNLOAD" = "1" ]; then
  log "Downloading template $TEMPLATE_ARCHIVE to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_ARCHIVE" || die "template download failed"
fi

log "Creating unprivileged container $CTID"
create_args=(
  "$CTID" "$TEMPLATE_VOLID"
  --hostname "$HOSTNAME"
  --cores "$CORES"
  --memory "$MEMORY"
  --swap 512
  --rootfs "$ROOTFS_STORAGE:$DISK"
  --net0 "$NET0"
  --unprivileged 1
  --onboot 1
  --description "Seizure Diary"
)
if [ -n "$NAMESERVER" ]; then
  create_args+=(--nameserver "$NAMESERVER")
fi
if ! pct create "${create_args[@]}"; then
  die "container creation failed. Partial state: check 'pct status $CTID' and 'pct config $CTID'. This script never destroys containers."
fi

log "Starting container"
pct start "$CTID" || die "failed to start CTID $CTID"

log "Waiting for guest network"
guest_ok="0"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1 && getent hosts github.com >/dev/null 2>&1' 2>/dev/null; then
    guest_ok="1"
    break
  fi
  sleep 2
done
if [ "$guest_ok" != "1" ]; then
  die "guest did not reach DNS/internet for apt and Git. Container $CTID was left running; inspect networking, then re-run: pct exec $CTID -- bash /root/install-guest.sh --repo-url '$REPO_URL' --ref '$REF'"
fi

log "Staging guest installer"
pct push "$CTID" "$GUEST_SCRIPT" /root/install-guest.sh --perms 0755 ||
  die "failed to push guest installer. Container $CTID is running; resume manually once fixed."

log "Running guest bootstrap (this installs packages, Node, builds and starts the app)"
set +e
pct exec "$CTID" -- bash /root/install-guest.sh --repo-url "$REPO_URL" --ref "$REF" --non-interactive
guest_status=$?
set -e

if [ "$guest_status" -eq 2 ]; then
  cat <<RESUME

The guest needs a read-only GitHub deploy key before it can clone the private
repository. The public key was printed above. Add it in GitHub:
  Repository -> Settings -> Deploy keys -> Add deploy key (read-only)

Then resume without recreating the container:
  pct exec $CTID -- bash /root/install-guest.sh --repo-url '$REPO_URL' --ref '$REF' --non-interactive --resume
RESUME
  exit 2
fi

if [ "$guest_status" -ne 0 ]; then
  die "guest bootstrap failed (exit $guest_status). Container $CTID is left in place. Inspect: pct exec $CTID -- journalctl -u seizure-diary -n 100 ; re-run the guest installer after fixing."
fi

cat <<DONE

Seizure Diary installed in CTID $CTID.
Installer revision: $INSTALLER_REV

Next steps (all from the guest console or pct exec):
  pct exec $CTID -- /usr/local/bin/seizure-diary status
  pct exec $CTID -- /usr/local/bin/seizure-diary bootstrap-admin --username <admin>
  pct exec $CTID -- /usr/local/bin/seizure-diary update --check

Then configure a private HTTPS reverse proxy (LAN or WireGuard only), set
PUBLIC_ORIGIN in /etc/seizure-diary/seizure-diary.env, set
BACKUP_ENCRYPTION_KEY, restart the service, and verify LAN/VPN access is
allowed while external access is blocked.
DONE

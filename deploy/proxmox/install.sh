#!/usr/bin/env bash
# Proxmox VE host entry point. Builds a dedicated Debian guest (QEMU VM by
# default, or an unprivileged LXC) and installs a prebuilt GitHub release
# bundle built by GitHub Actions runners. Nothing here modifies host firewall,
# networking, reverse proxies or other guests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUEST_SCRIPT="$SCRIPT_DIR/install-guest.sh"
RELEASE_TOOL="$SCRIPT_DIR/release.mjs"

GUEST_TYPE="lxc"
CTID=""
HOSTNAME="seizure-diary"
TEMPLATE=""
TEMPLATE_STORAGE=""
ROOTFS_STORAGE=""
VM_STORAGE=""
IMAGE_DIR="/var/lib/vz/template/iso"
SSH_PRIVATE_KEY=""
VM_USER="debian"
BRIDGE=""
IP_CIDR=""
GATEWAY=""
VLAN=""
DNS=""
CORES="1"
MEMORY="2048"
DISK="12"
REPO="kVinB/FPKD"
VERSION="latest"
TOKEN_FILE=""
ASSUME_YES="0"
DRY_RUN="0"
INTERACTIVE="auto"

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[install] %s\n' "$*"
}

UI_TITLE="Seizure Diary"
UI_WHIPTAIL="${WHIPTAIL:-whiptail}"

ui_available() {
  if [ "${SEIZURE_DIARY_FORCE_UI:-0}" = "1" ]; then
    command -v "$UI_WHIPTAIL" >/dev/null 2>&1
  else
    [ -t 0 ] && [ -t 1 ] && command -v "$UI_WHIPTAIL" >/dev/null 2>&1
  fi
}

ui_menu() {
  local title="$1" prompt="$2" default="$3"
  shift 3
  local pairs=("$@")
  local count=$(( ${#pairs[@]} / 2 ))
  if [ "$count" -eq 0 ]; then
    die "no choices are available for: $title"
  fi
  if ui_available; then
    local list_height=$(( count < 10 ? count : 12 ))
    local height=$(( list_height + 8 ))
    local args=(--title "$UI_TITLE - $title")
    [ -n "$default" ] && args+=(--default-item "$default")
    args+=(--menu "$prompt" "$height" 82 "$list_height")
    local choice
    if ! choice="$("$UI_WHIPTAIL" --clear "${args[@]}" "${pairs[@]}" 3>&1 1>&2 2>&3)"; then
      return 1
    fi
    printf '%s' "$choice"
    return 0
  fi
  printf '\n%s\n%s\n' "$title" "$prompt" >&2
  local index=1
  local i
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    printf '  %d) %s — %s\n' "$index" "${pairs[i]}" "${pairs[i + 1]}" >&2
    index=$((index + 1))
  done
  local attempt answer chosen
  for attempt in 1 2 3 4 5; do
    printf 'Choice [%s]: ' "$default" >&2
    read -r answer
    answer="${answer:-$default}"
    if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 1 ] && [ "$answer" -le "$count" ]; then
      chosen="${pairs[$(( (answer - 1) * 2 ))]}"
      printf '%s' "$chosen"
      return 0
    fi
    for ((i = 0; i < ${#pairs[@]}; i += 2)); do
      if [ "$answer" = "${pairs[i]}" ]; then
        printf '%s' "$answer"
        return 0
      fi
    done
    printf 'Invalid choice. Try again.\n' >&2
  done
  return 1
}

ui_input() {
  local title="$1" prompt="$2" default="$3"
  if ui_available; then
    local value
    if ! value="$("$UI_WHIPTAIL" --clear --title "$UI_TITLE - $title" \
      --inputbox "$prompt" 10 82 "$default" 3>&1 1>&2 2>&3)"; then
      return 1
    fi
    printf '%s' "$value"
    return 0
  fi
  local answer
  printf '%s [%s]: ' "$prompt" "$default" >&2
  read -r answer
  printf '%s' "${answer:-$default}"
}

ui_password() {
  local title="$1" prompt="$2"
  if ui_available; then
    local value
    if ! value="$("$UI_WHIPTAIL" --clear --title "$UI_TITLE - $title" \
      --passwordbox "$prompt" 10 82 3>&1 1>&2 2>&3)"; then
      return 1
    fi
    printf '%s' "$value"
    return 0
  fi
  local value
  printf '%s: ' "$prompt" >&2
  read -r -s value
  printf '\n' >&2
  printf '%s' "$value"
}

ui_yesno() {
  local title="$1" prompt="$2" default="${3:-yes}"
  if ui_available; then
    local args=(--clear --title "$UI_TITLE - $title" --yesno "$prompt" 12 82)
    [ "$default" = "no" ] && args=(--clear --title "$UI_TITLE - $title" --defaultno --yesno "$prompt" 12 82)
    "$UI_WHIPTAIL" "${args[@]}" 3>&1 1>&2 2>&3
    return $?
  fi
  local answer
  local suffix="[Y/n]"
  [ "$default" = "no" ] && suffix="[y/N]"
  printf '%s %s: ' "$prompt" "$suffix" >&2
  read -r answer
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

next_free_id() {
  local candidate
  for candidate in $(seq 200 299); do
    if [ "$GUEST_TYPE" = "vm" ]; then
      qm status "$candidate" >/dev/null 2>&1 || { printf '%s' "$candidate"; return; }
    else
      pct status "$candidate" >/dev/null 2>&1 || { printf '%s' "$candidate"; return; }
    fi
  done
  return 1
}

storage_menu() {
  local content="$1" title="$2" current="$3"
  local rows=()
  mapfile -t rows < <(pvesm status -content "$content" 2>/dev/null | awk 'NR>1 && $3=="active" {print $1"|"$2"|"$6}')
  if [ "${#rows[@]}" -eq 0 ]; then
    die "no active storage supports $content; configure storage first"
  fi
  local pairs=()
  local row id type avail
  for row in "${rows[@]}"; do
    IFS='|' read -r id type avail <<< "$row"
    pairs+=("$id" "$type · free $avail")
  done
  local default="$current"
  if [ -z "$default" ]; then default="${pairs[0]}"; fi
  ui_menu "$title" "Select the Proxmox storage ID (not a physical disk)." "$default" "${pairs[@]}"
}

template_menu() {
  local current="$1"
  local pairs=(__download__ "Download latest Debian 12 template")
  local row volid
  mapfile -t rows < <(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' | grep '/debian-12-standard/' | sort -V)
  for row in "${rows[@]}"; do
    [ -n "$row" ] || continue
    pairs+=("$row" "Use $row")
  done
  local default="__download__"
  if [ -n "$current" ]; then default="$current"; fi
  ui_menu "Debian template" "Choose a downloaded template or download the latest official Debian 12 template." "$default" "${pairs[@]}"
}

pveam_available_debian12() {
  pveam available --section system 2>/dev/null |
    awk '$2 ~ /^debian-12-standard/ {print $2}' | sort -V | tail -1
}

ensure_pveam_index() {
  local archive
  archive="$(pveam_available_debian12)"
  if [ -z "$archive" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      die "no debian-12-standard template is indexed; run 'pveam update' first (dry-run does not refresh the index) and retry"
    fi
    printf '[install] %s\n' "Refreshing the pveam template index" >&2
    pveam update >/dev/null 2>&1 ||
      die "pveam update failed; run 'pveam update' on the host and retry"
    archive="$(pveam_available_debian12)"
  fi
  [ -n "$archive" ] ||
    die "no official debian-12-standard template is available from pveam after 'pveam update'"
  printf '%s' "$archive"
}

interactive_collect() {
  REPO="$(ui_input "GitHub repository" "Repository (owner/name)" "$REPO")" || die "cancelled"
  local release_choice
  release_choice="$(ui_menu "Release" "Install the latest runner-built release or a specific tag." "latest" \
    latest "Latest release" specific "Specific YYYYMMDD.VV tag")" || die "cancelled"
  if [ "$release_choice" = "specific" ]; then
    local version_default="$VERSION"
    [ "$version_default" = "latest" ] && version_default=""
    VERSION="$(ui_input "Release tag" "Enter a release tag (YYYYMMDD.VV)" "$version_default")" || die "cancelled"
  else
    VERSION="latest"
  fi

  local token_default="paste" token_pairs=(paste "Paste a read-only GitHub token (hidden)")
  local host_token="/root/seizure-diary-github-token"
  if [ -n "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
    token_pairs=(configured "Use --token-file $TOKEN_FILE" "${token_pairs[@]}")
    token_default="configured"
  elif [ -r "$host_token" ]; then
    token_pairs=(existing "Use existing $host_token" "${token_pairs[@]}")
    token_default="existing"
  fi
  token_pairs+=(public "Public repository (no token)")
  local token_choice
  token_choice="$(ui_menu "GitHub access" "Choose how to download the private release bundle." "$token_default" "${token_pairs[@]}")" || die "cancelled"
  case "$token_choice" in
    configured) ;;
    existing) TOKEN_FILE="$host_token" ;;
    paste)
      local secret
      secret="$(ui_password "GitHub token" "Paste a fine-grained token with Contents: read. Input is hidden and saved on this host as 0600.")" || die "cancelled"
      [ -n "$secret" ] || die "empty GitHub token"
      umask 077
      printf '%s' "$secret" > "$host_token"
      chmod 0600 "$host_token"
      unset secret
      TOKEN_FILE="$host_token"
      ;;
    public) TOKEN_FILE="" ;;
    *) die "unknown token choice" ;;
  esac

  HOSTNAME="$(ui_input "Hostname" "Guest hostname" "$HOSTNAME")" || die "cancelled"
  if [ -z "$CTID" ]; then
    CTID="$(next_free_id)" || die "no free guest ID found in 200-299"
  fi
  CTID="$(ui_input "Guest ID" "VMID/CTID (must be unused)" "$CTID")" || die "cancelled"
  CORES="$(ui_input "CPU" "vCPUs" "$CORES")" || die "cancelled"
  MEMORY="$(ui_input "RAM" "Memory in MiB" "$MEMORY")" || die "cancelled"
  DISK="$(ui_input "Disk" "Disk size in GiB" "$DISK")" || die "cancelled"

  local bridges=()
  mapfile -t bridges < <(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | sort -u)
  if [ "${#bridges[@]}" -eq 0 ]; then
    BRIDGE="$(ui_input "Bridge" "Network bridge" "${BRIDGE:-vmbr0}")" || die "cancelled"
  else
    local bridge_pairs=()
    local bridge
    for bridge in "${bridges[@]}"; do
      [ -n "$bridge" ] && bridge_pairs+=("$bridge" "Bridge $bridge")
    done
    local bridge_default="$BRIDGE"
    if [ -z "$bridge_default" ] || ! printf '%s\n' "${bridges[@]}" | grep -qx "$bridge_default"; then
      bridge_default="${bridges[0]}"
    fi
    BRIDGE="$(ui_menu "Bridge" "Select the network bridge." "$bridge_default" "${bridge_pairs[@]}")" || die "cancelled"
  fi

  if [ "$GUEST_TYPE" = "lxc" ]; then
    if ui_yesno "Network" "Use DHCP for the container? Choose No to enter a static address." "yes"; then
      IP_CIDR=""
      GATEWAY=""
    else
      IP_CIDR="$(ui_input "Network" "Static IPv4/prefix, e.g. 10.20.0.10/24" "$IP_CIDR")" || die "cancelled"
      GATEWAY="$(ui_input "Network" "Gateway IPv4 address" "$GATEWAY")" || die "cancelled"
    fi
  else
    IP_CIDR="$(ui_input "Network" "Static IPv4/prefix, e.g. 10.20.0.10/24" "$IP_CIDR")" || die "cancelled"
    GATEWAY="$(ui_input "Network" "Gateway IPv4 address" "$GATEWAY")" || die "cancelled"
  fi
  DNS="$(ui_input "DNS" "Comma-separated DNS servers (blank for provider/default)" "$DNS")" || die "cancelled"
  VLAN="$(ui_input "VLAN" "Optional VLAN tag 1-4094 (blank for none)" "$VLAN")" || die "cancelled"

  if [ "$GUEST_TYPE" = "lxc" ]; then
    ROOTFS_STORAGE="$(storage_menu rootdir "Container disk storage" "$ROOTFS_STORAGE")" || die "cancelled"
    TEMPLATE_STORAGE="$(storage_menu vztmpl "Template storage" "$TEMPLATE_STORAGE")" || die "cancelled"
    local template_choice
    template_choice="$(template_menu "$TEMPLATE")" || die "cancelled"
    if [ "$template_choice" = "__download__" ]; then
      TEMPLATE=""
    else
      TEMPLATE="$template_choice"
    fi
  else
    VM_STORAGE="$(storage_menu images "VM disk storage" "$VM_STORAGE")" || die "cancelled"
    IMAGE_DIR="$(ui_input "Cloud image cache" "Directory for the Debian cloud image" "$IMAGE_DIR")" || die "cancelled"
    SSH_PRIVATE_KEY="$(ui_input "SSH key" "Host path to the SSH private key used for VM bootstrap" "$SSH_PRIVATE_KEY")" || die "cancelled"
    VM_USER="$(ui_input "VM user" "Cloud-init user" "$VM_USER")" || die "cancelled"
  fi
}

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/proxmox/install.sh [options]

Creates a dedicated Debian guest on Proxmox VE, downloads a runner-built,
checksum-verified release bundle from GitHub, and starts it under systemd.

Guest type:
  --type <vm|lxc>             lxc = unprivileged Debian 12 LXC (default)
                              vm = QEMU Debian cloud-image VM

Identity and source:
  --ctid <id>                 VMID/CTID (default: next free from 200)
  --hostname <name>           Guest hostname (default: seizure-diary)
  --repo <owner/name>         GitHub repository (default: kVinB/FPKD)
  --version latest|<tag>      Release to install (default: latest)
  --token-file <path>         Host file with a read-only GitHub token for a
                              private repository. Installed 0400 root in the guest.

LXC options:
  --template <volid>          Downloaded template volid
  --template-storage <id>     Storage for template download
  --rootfs-storage <id>       Container root storage

VM options:
  --vm-storage <id>           Storage with images support (VM disk + cloud-init)
  --image-dir <path>          Debian cloud image cache (default: /var/lib/vz/template/iso)
  --ssh-private-key <path>    SSH private key used to bootstrapping the VM (required)
  --vm-user <name>            Cloud-init user (default: debian)

Network:
  --bridge <name>             Network bridge (default: vmbr0 if present)
  --ip <cidr>                 Static IPv4/prefix (required for VM; e.g. 10.20.0.10/24)
  --gateway <ip>              Gateway for static IP
  --vlan <id>                 Optional VLAN tag (1-4094)
  --dns <servers>             Comma-separated DNS servers

Resources:
  --cores <n>                 vCPUs (default: 1)
  --memory <mib>              RAM in MiB (default: 2048)
  --disk <gib>                Disk in GiB (default: 12)

Other:
  --yes                       Do not prompt for final confirmation
  --dry-run                   Validate and print the summary; make no changes and download nothing
  --interactive               Force the guided prompts (LXC is the default)
  --non-interactive           Never prompt; use flags/defaults or fail on ambiguity
  -h, --help                  Show this help
USAGE
}

need_value() {
  [ "$#" -ge 2 ] || die "missing value for $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --type) need_value "$@"; GUEST_TYPE="$2"; shift 2 ;;
    --ctid|--vmid) need_value "$@"; CTID="$2"; shift 2 ;;
    --hostname) need_value "$@"; HOSTNAME="$2"; shift 2 ;;
    --template) need_value "$@"; TEMPLATE="$2"; shift 2 ;;
    --template-storage) need_value "$@"; TEMPLATE_STORAGE="$2"; shift 2 ;;
    --rootfs-storage) need_value "$@"; ROOTFS_STORAGE="$2"; shift 2 ;;
    --vm-storage) need_value "$@"; VM_STORAGE="$2"; shift 2 ;;
    --image-dir) need_value "$@"; IMAGE_DIR="$2"; shift 2 ;;
    --ssh-private-key) need_value "$@"; SSH_PRIVATE_KEY="$2"; shift 2 ;;
    --vm-user) need_value "$@"; VM_USER="$2"; shift 2 ;;
    --bridge) need_value "$@"; BRIDGE="$2"; shift 2 ;;
    --ip) need_value "$@"; IP_CIDR="$2"; shift 2 ;;
    --gateway) need_value "$@"; GATEWAY="$2"; shift 2 ;;
    --vlan) need_value "$@"; VLAN="$2"; shift 2 ;;
    --dns) need_value "$@"; DNS="$2"; shift 2 ;;
    --cores) need_value "$@"; CORES="$2"; shift 2 ;;
    --memory) need_value "$@"; MEMORY="$2"; shift 2 ;;
    --disk) need_value "$@"; DISK="$2"; shift 2 ;;
    --repo) need_value "$@"; REPO="$2"; shift 2 ;;
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --token-file) need_value "$@"; TOKEN_FILE="$2"; shift 2 ;;
    --yes) ASSUME_YES="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --interactive) INTERACTIVE="1"; shift ;;
    --non-interactive) INTERACTIVE="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root on the Proxmox VE host"
if [ "$INTERACTIVE" = "auto" ]; then
  if [ -t 0 ] && [ -t 1 ] && [ "$ASSUME_YES" != "1" ]; then INTERACTIVE="1"; else INTERACTIVE="0"; fi
fi
command -v pvesm >/dev/null 2>&1 || die "pvesm is not available; is this a Proxmox VE host?"
if [ "$INTERACTIVE" = "1" ]; then
  GUEST_TYPE="$(ui_menu "Guest type" "Choose the Debian guest type. LXC is recommended for this app." "$GUEST_TYPE"     lxc "LXC Container (recommended)" vm "QEMU VM")" || die "cancelled"
fi
case "$GUEST_TYPE" in
  vm)
    command -v qm >/dev/null 2>&1 || die "qm is not available; install/update Proxmox VE"
    command -v ssh >/dev/null 2>&1 || die "ssh client is required for VM bootstrap"
    command -v scp >/dev/null 2>&1 || die "scp is required for VM bootstrap"
    command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is required for VM bootstrap"
    command -v curl >/dev/null 2>&1 || die "curl is required to download the Debian cloud image"
    command -v sha512sum >/dev/null 2>&1 || die "sha512sum is required for image verification"
    ;;
  lxc)
    command -v pct >/dev/null 2>&1 || die "pct is not available; is this a Proxmox VE host?"
    command -v pveam >/dev/null 2>&1 || die "pveam is not available; is this a Proxmox VE host?"
    [ -x "$GUEST_SCRIPT" ] || die "guest installer not found or not executable: $GUEST_SCRIPT. Copy the whole deploy/proxmox directory (install.sh needs install-guest.sh and release.mjs beside it) or use the single-file seizure-diary-installer-<tag>.sh release asset."
    ;;
  *)
    die "--type must be vm or lxc"
    ;;
esac
[ -r "$RELEASE_TOOL" ] || die "release tool not found: $RELEASE_TOOL"
if [ "$INTERACTIVE" = "1" ]; then
  interactive_collect
fi
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be owner/name"
if [ "$VERSION" != "latest" ] && [[ ! "$VERSION" =~ ^[0-9]{8}\.[0-9]{2}$ ]]; then
  die "--version must be latest or YYYYMMDD.VV"
fi
if [ -n "$TOKEN_FILE" ]; then
  [ -r "$TOKEN_FILE" ] || die "token file is not readable: $TOKEN_FILE"
fi
[[ "$CORES" =~ ^[1-9][0-9]*$ ]] || die "--cores must be a positive integer"
[[ "$MEMORY" =~ ^[1-9][0-9]*$ ]] || die "--memory must be a positive integer"
[[ "$DISK" =~ ^[1-9][0-9]*$ ]] || die "--disk must be a positive integer"

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
NETWORK_DESC=""
VM_IPCONFIG=""
if [ -n "$IP_CIDR" ]; then
  [[ "$IP_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))$ ]] ||
    die "--ip must be IPv4/prefix, e.g. 10.20.0.10/24"
  [ -n "$GATEWAY" ] || die "--gateway is required with a static --ip"
  [[ "$GATEWAY" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--gateway must be an IPv4 address"
  VM_IPCONFIG="ip=$IP_CIDR,gw=$GATEWAY"
elif [ "$GUEST_TYPE" = "vm" ]; then
  die "VM installs require --ip <prefix> and --gateway so the host can reach the guest for bootstrap"
fi
if [ -n "$VLAN" ]; then
  [[ "$VLAN" =~ ^([1-9][0-9]{0,2}|[1-3][0-9]{3}|40[0-8][0-9]|409[0-4])$ ]] || die "--vlan must be 1-4094"
fi
NAMESERVER=""
if [ -n "$DNS" ]; then
  NAMESERVER="${DNS//,/ }"
fi

# Guest ID: validate unused, never reuse or delete.
if [ -z "$CTID" ]; then
  for candidate in $(seq 200 299); do
    if [ "$GUEST_TYPE" = "vm" ]; then
      qm status "$candidate" >/dev/null 2>&1 || { CTID="$candidate"; break; }
    else
      pct status "$candidate" >/dev/null 2>&1 || { CTID="$candidate"; break; }
    fi
  done
fi
[ -n "$CTID" ] || die "no free ID found in 200-299; pass --ctid"
[[ "$CTID" =~ ^[1-9][0-9]{2,5}$ ]] || die "--ctid must be a numeric guest ID"
if [ "$GUEST_TYPE" = "vm" ]; then
  qm status "$CTID" >/dev/null 2>&1 && die "VMID $CTID already exists; refusing to reuse it"
else
  pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists; refusing to reuse it"
fi

SSH_PUBLIC_KEY=""
if [ "$GUEST_TYPE" = "vm" ]; then
  [ -n "$SSH_PRIVATE_KEY" ] || die "VM installs require --ssh-private-key"
  [ -r "$SSH_PRIVATE_KEY" ] || die "SSH private key is not readable: $SSH_PRIVATE_KEY"
  SSH_PUBLIC_KEY="$(mktemp)"
  if ! ssh-keygen -y -f "$SSH_PRIVATE_KEY" > "$SSH_PUBLIC_KEY" 2>/dev/null; then
    rm -f "$SSH_PUBLIC_KEY"
    die "could not derive a public key from $SSH_PRIVATE_KEY"
  fi
  trap 'rm -f "$SSH_PUBLIC_KEY"' EXIT
  mapfile -t IMAGE_STORAGES < <(pvesm status -content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}')
  if [ -n "$VM_STORAGE" ]; then
    printf '%s\n' "${IMAGE_STORAGES[@]}" | grep -qx "$VM_STORAGE" ||
      die "VM storage '$VM_STORAGE' does not support images or is inactive"
  elif [ "${#IMAGE_STORAGES[@]}" -eq 1 ]; then
    VM_STORAGE="${IMAGE_STORAGES[0]}"
  else
    die "multiple/no image storages available (${IMAGE_STORAGES[*]:-none}); pass --vm-storage"
  fi
else
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
fi

# LXC template discovery. Never guess archive names.
TEMPLATE_VOLID="$TEMPLATE"
TEMPLATE_ARCHIVE=""
TEMPLATE_NEEDS_DOWNLOAD="0"
if [ "$GUEST_TYPE" = "lxc" ]; then
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
      TEMPLATE_ARCHIVE="$(ensure_pveam_index)"
      TEMPLATE_VOLID="$TEMPLATE_STORAGE:vztmpl/$TEMPLATE_ARCHIVE"
      TEMPLATE_NEEDS_DOWNLOAD="1"
    fi
  fi
fi

IMAGE_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
IMAGE_SUMS_URL="https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS"
IMAGE_PATH="$IMAGE_DIR/debian-12-genericcloud-amd64.qcow2"

INSTALLER_REV="unknown"
if git -C "$SCRIPT_DIR/../.." rev-parse --short HEAD >/dev/null 2>&1; then
  INSTALLER_REV="$(git -C "$SCRIPT_DIR/../.." rev-parse --short HEAD)"
fi

TOKEN_DESC="none (release must be public)"
[ -n "$TOKEN_FILE" ] && TOKEN_DESC="provided (0400 root in guest)"
DETAIL_LINES=""
if [ "$GUEST_TYPE" = "vm" ]; then
  DETAIL_LINES="VM storage         : $VM_STORAGE
Cloud image cache  : $IMAGE_DIR
Bootstrap SSH user : $VM_USER"
else
  TEMPLATE_SUFFIX=""
  if [ "$TEMPLATE_NEEDS_DOWNLOAD" = "1" ]; then
    TEMPLATE_SUFFIX=" (will download)"
  fi
  DETAIL_LINES="Root filesystem    : $ROOTFS_STORAGE:$DISK GiB
Template           : $TEMPLATE_VOLID$TEMPLATE_SUFFIX"
fi

cat <<SUMMARY

Seizure Diary Proxmox install summary
-------------------------------------
Installer revision : $INSTALLER_REV
Guest type         : $GUEST_TYPE
Guest ID / name    : $CTID / $HOSTNAME
Release source     : https://github.com/$REPO
Release version    : $VERSION
GitHub token       : $TOKEN_DESC
CPU / RAM / disk   : $CORES vCPU / $MEMORY MiB / $DISK GiB
Bridge / VLAN      : $BRIDGE${VLAN:+ / $VLAN}
Address            : ${IP_CIDR:-DHCP}
Gateway / DNS      : ${GATEWAY:-provider default} / ${NAMESERVER:-provider default}
$DETAIL_LINES

This installs a prebuilt GitHub release bundle. No application build occurs on
the Proxmox host or guest. Host firewall, networking, reverse proxy and cluster
settings are not modified. The app binds to loopback inside the guest.
SUMMARY

if [ "$DRY_RUN" = "1" ]; then
  log "Dry run complete. No changes were made and nothing was downloaded."
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  if [ "$INTERACTIVE" = "1" ] && ui_available; then
    ui_yesno "Install" "Create the $GUEST_TYPE guest and install the runner-built release now?" "yes" ||
      die "aborted by operator"
  else
    printf '\nType "install" to create the guest: '
    read -r answer
    [ "$answer" = "install" ] || die "aborted by operator"
  fi
fi

run_guest_installer_lxc() {
  log "Staging guest installer and release tool"
  pct push "$CTID" "$GUEST_SCRIPT" /root/install-guest.sh --perms 0755 ||
    die "failed to push guest installer. Container $CTID is left in place."
  pct push "$CTID" "$RELEASE_TOOL" /root/release.mjs --perms 0755 ||
    die "failed to push release tool. Container $CTID is left in place."
  local installer_args=(--repo "$REPO" --version "$VERSION" --non-interactive)
  if [ -n "$TOKEN_FILE" ]; then
    pct push "$CTID" "$TOKEN_FILE" /root/github-token --perms 0600 ||
      die "failed to push GitHub token. Container $CTID is left in place."
    installer_args+=(--token-file /root/github-token)
  fi
  log "Downloading and starting the runner-built release in the container"
  set +e
  pct exec "$CTID" -- bash /root/install-guest.sh "${installer_args[@]}"
  local status=$?
  set -e
  return "$status"
}

run_guest_installer_vm() {
  local ip="${IP_CIDR%%/*}"
  local known_hosts="/root/.ssh/known_hosts_seizure-diary-${CTID}"
  local ssh_opts=(
    -i "$SSH_PRIVATE_KEY"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$known_hosts"
    -o ConnectTimeout=10
  )
  log "Waiting for SSH on $ip"
  local ready="0"
  for _ in $(seq 1 60); do
    if ssh "${ssh_opts[@]}" "$VM_USER@$ip" true >/dev/null 2>&1; then
      ready="1"
      break
    fi
    sleep 5
  done
  if [ "$ready" != "1" ]; then
    die "VM $CTID did not accept SSH at $ip. The VM is left in place; inspect its console and cloud-init."
  fi

  log "Transferring installer and release tool"
  local files=("$GUEST_SCRIPT" "$RELEASE_TOOL")
  scp "${ssh_opts[@]}" "${files[@]}" "$VM_USER@$ip:/tmp/" >/dev/null ||
    die "failed to copy installer files to VM $CTID"
  local token_setup="true"
  local token_remote=""
  if [ -n "$TOKEN_FILE" ]; then
    scp "${ssh_opts[@]}" "$TOKEN_FILE" "$VM_USER@$ip:/tmp/github-token" >/dev/null ||
      die "failed to copy GitHub token to VM $CTID"
    token_setup="sudo -n install -m 0600 /tmp/github-token /root/github-token && sudo -n rm -f /tmp/github-token"
    token_remote=" --token-file /root/github-token"
  fi
  local remote_command
  remote_command="sudo -n install -m 0755 /tmp/install-guest.sh /root/install-guest.sh && sudo -n install -m 0755 /tmp/release.mjs /root/release.mjs && $token_setup && sudo -n bash /root/install-guest.sh --repo '$REPO' --version '$VERSION'$token_remote --non-interactive"
  ssh "${ssh_opts[@]}" "$VM_USER@$ip" "$remote_command" ||
    die "guest bootstrap failed on VM $CTID. Inspect the console with: qm terminal $CTID"
}

if [ "$GUEST_TYPE" = "lxc" ]; then
  [ -x "$GUEST_SCRIPT" ] || die "guest installer not found: $GUEST_SCRIPT. Copy the whole deploy/proxmox directory or use the single-file installer."
  if [ "$TEMPLATE_NEEDS_DOWNLOAD" = "1" ]; then
    log "Downloading template $TEMPLATE_ARCHIVE to $TEMPLATE_STORAGE"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_ARCHIVE" || die "template download failed"
  fi
  log "Creating unprivileged container $CTID"
  NET0="name=eth0,bridge=$BRIDGE"
  if [ -n "$IP_CIDR" ]; then
    NET0="$NET0,ip=$IP_CIDR,gw=$GATEWAY"
  else
    NET0="$NET0,ip=dhcp"
  fi
  [ -n "$VLAN" ] && NET0="$NET0,tag=$VLAN"
  create_args=(
    "$CTID" "$TEMPLATE_VOLID"
    --hostname "$HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap 512
    --rootfs "$ROOTFS_STORAGE:$DISK" --net0 "$NET0" --unprivileged 1
    --onboot 1 --description "Seizure Diary"
  )
  [ -n "$NAMESERVER" ] && create_args+=(--nameserver "$NAMESERVER")
  pct create "${create_args[@]}" || die "container creation failed. Check 'pct status $CTID'; this script never destroys containers."
  pct start "$CTID" || die "failed to start CTID $CTID"
  log "Waiting for guest network"
  guest_ok="0"
  for _ in $(seq 1 30); do
    if pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1 && getent hosts github.com >/dev/null 2>&1' 2>/dev/null; then
      guest_ok="1"; break
    fi
    sleep 2
  done
  [ "$guest_ok" = "1" ] || die "guest did not reach DNS/internet. Container $CTID is left running; inspect networking."
  set +e
  run_guest_installer_lxc
  guest_status=$?
  set -e
  if [ "$guest_status" -ne 0 ]; then
    die "guest bootstrap failed (exit $guest_status). Container $CTID is left in place; inspect: pct exec $CTID -- journalctl -u seizure-diary -n 100"
  fi
else
  if [ "$(uname -m)" != "x86_64" ]; then
    die "the Debian cloud image bootstrap currently supports x86_64 Proxmox hosts only"
  fi
  mkdir -p "$IMAGE_DIR"
  chmod 0700 "$IMAGE_DIR"
  log "Downloading and verifying the Debian 12 cloud image"
  sums_tmp="$(mktemp)"
  curl -fsSL -o "$sums_tmp" "$IMAGE_SUMS_URL" || die "could not download Debian SHA512SUMS"
  if ! (cd "$IMAGE_DIR" && grep ' debian-12-genericcloud-amd64.qcow2$' "$sums_tmp" | sha512sum -c -) >/dev/null 2>&1; then
    curl -fsSL -o "$IMAGE_PATH" "$IMAGE_URL" || die "could not download the Debian cloud image"
    (cd "$IMAGE_DIR" && grep ' debian-12-genericcloud-amd64.qcow2$' "$sums_tmp" | sha512sum -c -) ||
      die "Debian cloud image checksum verification failed"
  fi
  rm -f "$sums_tmp"

  log "Creating VM $CTID"
  NET0="virtio,bridge=$BRIDGE"
  [ -n "$VLAN" ] && NET0="$NET0,tag=$VLAN"
  qm create "$CTID" \
    --name "$HOSTNAME" --cores "$CORES" --memory "$MEMORY" \
    --net0 "$NET0" --scsihw virtio-scsi-pci --ostype l26 \
    --agent enabled=1 --serial0 socket --vga std --onboot 1 \
    --description "Seizure Diary" ||
    die "VM creation failed. Check 'qm config $CTID'; this script never destroys VMs."
  qm importdisk "$CTID" "$IMAGE_PATH" "$VM_STORAGE" ||
    die "failed to import the cloud image. VM $CTID is left in place."
  disk_volume="$(qm config "$CTID" | awk -F': ' '/^unused0:/ {print $2}')"
  [ -n "$disk_volume" ] || die "could not identify the imported VM disk"
  qm set "$CTID" --scsi0 "$disk_volume" || die "could not attach the VM disk"
  qm resize "$CTID" scsi0 "${DISK}G" >/dev/null || die "could not resize the VM disk to ${DISK}G"
  qm set "$CTID" --ide2 "$VM_STORAGE:cloudinit" --boot order=scsi0 ||
    die "could not configure cloud-init"
  qm set "$CTID" --ipconfig0 "$VM_IPCONFIG" --ciuser "$VM_USER" --sshkeys "$SSH_PUBLIC_KEY" ||
    die "could not configure cloud-init network/SSH"
  [ -n "$NAMESERVER" ] && qm set "$CTID" --nameserver "$NAMESERVER" || true
  qm cloudinit update "$CTID" >/dev/null
  qm start "$CTID" || die "failed to start VM $CTID"
  run_guest_installer_vm
fi

cat <<DONE

Seizure Diary installed in $GUEST_TYPE $CTID.
Installer revision: $INSTALLER_REV
Release: $VERSION from https://github.com/$REPO

Next steps (guest console or host pct/qm access):
  $( [ "$GUEST_TYPE" = "lxc" ] && printf 'pct exec %s -- /usr/local/bin/seizure-diary status' "$CTID" || printf 'SSH to the VM and run: /usr/local/bin/seizure-diary status' )
  $( [ "$GUEST_TYPE" = "lxc" ] && printf 'pct exec %s -- /usr/local/bin/seizure-diary bootstrap-admin --username <admin>' "$CTID" || printf '/usr/local/bin/seizure-diary bootstrap-admin --username <admin>' )

Then configure private HTTPS and set PUBLIC_ORIGIN; set BACKUP_ENCRYPTION_KEY,
enable the backup timer, and verify LAN/WireGuard access while external access
is blocked.
DONE

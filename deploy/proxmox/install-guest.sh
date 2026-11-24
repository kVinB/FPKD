#!/usr/bin/env bash
# Guest bootstrap for a fresh unprivileged Debian LXC or Debian VM.
# Installs runtime prerequisites and a prebuilt GitHub release bundle.
# All application builds happen on GitHub Actions runners.
set -euo pipefail

REPO="kVinB/FPKD"
VERSION="latest"
TOKEN_FILE=""
NONINTERACTIVE="0"
NODE_VERSION="22.13.1"

APP_ROOT="/opt/seizure-diary"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
TOOLS_DIR="$APP_ROOT/tools"
CONF_DIR="/etc/seizure-diary"
ENV_FILE="$CONF_DIR/seizure-diary.env"
INSTALL_CONF="$CONF_DIR/install.conf"
TOKEN_PATH="$CONF_DIR/github-token"
DATA_DIR="/var/lib/seizure-diary"
BACKUP_DIR="/var/backups/seizure-diary"
SERVICE_USER="seizure-diary"
SERVICE_NAME="seizure-diary"

die() {
  printf 'install-guest.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[guest] %s\n' "$*" >&2
}

usage() {
  cat <<'USAGE'
Usage: sudo bash install-guest.sh [options]

Installs a prebuilt, checksum-verified release bundle downloaded from GitHub.
No Git, compiler or application build is performed on this guest.

Options:
  --repo <owner/name>       GitHub repository (default: kVinB/FPKD)
  --version latest|<tag>    Release to install (default: latest)
  --token-file <path>       Staged read-only GitHub token (private repositories);
                            installed as /etc/seizure-diary/github-token (0400 root)
  --non-interactive         Accepted for host automation; no prompts are used
  -h, --help                Show this help
USAGE
}

need_value() {
  [ "$#" -ge 2 ] || die "missing value for $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) need_value "$@"; REPO="$2"; shift 2 ;;
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --token-file) need_value "$@"; TOKEN_FILE="$2"; shift 2 ;;
    --non-interactive) NONINTERACTIVE="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root inside the guest"
[ -f /etc/debian_version ] || die "this installer supports Debian guests only"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid --repo (owner/name)"
if [ "$VERSION" != "latest" ] && [[ ! "$VERSION" =~ ^[0-9]{8}\.[0-9]{2}$ ]]; then
  die "invalid --version (latest or YYYYMMDD.VV)"
fi
if [ -n "$TOKEN_FILE" ] && [ ! -r "$TOKEN_FILE" ]; then
  die "token file is not readable: $TOKEN_FILE"
fi
void="$NONINTERACTIVE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_TOOL_SRC="$SCRIPT_DIR/release.mjs"
[ -r "$RELEASE_TOOL_SRC" ] || die "release.mjs must be staged next to the installer"

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl openssl sqlite3 tar util-linux xz-utils
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    if node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a === 22 && b >= 12 ? 0 : 1)'; then
      log "Using existing Node.js $(node --version)"
      return
    fi
  fi

  local arch
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64) arch="arm64" ;;
    *) die "unsupported CPU architecture for Node.js tarball: $(uname -m)" ;;
  esac
  local dir="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${arch}"
  if [ ! -x "$dir/bin/node" ]; then
    log "Installing Node.js v$NODE_VERSION ($arch) from the official tarball with checksum verification"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v${NODE_VERSION}-linux-${arch}.tar.xz"
    (cd "$tmp" && grep " node-v${NODE_VERSION}-linux-${arch}.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs
  fi
  ln -sfn "$dir/bin/node" /usr/local/bin/node
  ln -sfn "$dir/bin/npm" /usr/local/bin/npm
  ln -sfn "$dir/bin/npx" /usr/local/bin/npx
  log "Node.js $(node --version), npm $(npm --version)"
}

create_identity_and_dirs() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$BACKUP_DIR"
  install -d -m 0755 -o root -g root "$APP_ROOT" "$RELEASES_DIR" "$TOOLS_DIR"
}

write_config_files() {
  cat > "$INSTALL_CONF" <<EOF
REPO_SLUG=$REPO
GITHUB_TOKEN_FILE=$TOKEN_PATH
APP_ROOT=$APP_ROOT
SERVICE_USER=$SERVICE_USER
TOOLS_DIR=$TOOLS_DIR
NODE_VERSION=$NODE_VERSION
EOF
  chown root:"$SERVICE_USER" "$INSTALL_CONF"
  chmod 0640 "$INSTALL_CONF"

  if [ ! -f "$ENV_FILE" ]; then
    log "Creating $ENV_FILE"
    local secret
    secret="$(openssl rand -base64 32)"
    umask 0077
    cat > "$ENV_FILE" <<EOF_ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
SEIZURE_DIARY_DB_PATH=$DATA_DIR/seizure-diary.sqlite3
PUBLIC_ORIGIN=https://diary.home.arpa
TRUSTED_PROXIES=127.0.0.1,::1
SESSION_IDLE_SECONDS=1800
SESSION_ABSOLUTE_SECONDS=43200
TEMP_SESSION_SECONDS=900
TEMP_PASSWORD_SECONDS=172800
REAUTH_WINDOW_SECONDS=300
SECURE_COOKIES=true
CSRF_SECRET=$secret
BACKUP_DIR=$BACKUP_DIR
# BACKUP_ENCRYPTION_KEY=base64-32-bytes-required-for-encrypted-backups-and-updates
EOF_ENV
    chown root:"$SERVICE_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
}

install_token() {
  if [ -n "$TOKEN_FILE" ]; then
    if [ "$(readlink -f "$TOKEN_FILE")" = "$(readlink -f "$TOKEN_PATH" 2>/dev/null || printf '%s' "$TOKEN_PATH")" ]; then
      log "Using the read-only GitHub token already in place"
    else
      log "Installing the read-only GitHub token (0400 root)"
      install -m 0400 -o root -g root "$TOKEN_FILE" "$TOKEN_PATH"
      rm -f "$TOKEN_FILE"
    fi
  elif [ -r "$TOKEN_PATH" ]; then
    log "Using the existing read-only GitHub token"
  else
    log "No GitHub token configured; release downloads must be publicly readable"
  fi
}

release_args() {
  local -n _args="$1"
  _args=(--repo "$REPO" --version "$VERSION")
  if [ -r "$TOKEN_PATH" ]; then
    _args+=(--token-file "$TOKEN_PATH")
  fi
}

download_release() {
  install -m 0755 -o root -g root "$RELEASE_TOOL_SRC" "$TOOLS_DIR/release.mjs"
  local args=()
  release_args args
  local resolved
  if ! resolved="$(node "$TOOLS_DIR/release.mjs" resolve "${args[@]}")"; then
    die "could not resolve release $VERSION for $REPO. For a private repository, supply --token-file with a read-only GitHub token."
  fi
  local version
  version="$(printf '%s' "$resolved" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const value = JSON.parse(s).version;
      if (!/^[0-9]{8}\.[0-9]{2}$/.test(value)) process.exit(1);
      process.stdout.write(value);
    });
  ')" || die "release metadata did not contain a valid YYYYMMDD.VV version"

  local release="$RELEASES_DIR/$version"
  if [ -d "$release" ] && [ ! -f "$release/.deployed-version" ]; then
    die "release directory $release exists without a completion marker; remove it and retry"
  fi
  if [ -f "$release/.deployed-version" ]; then
    log "Release $version is already present; reusing it"
  else
    log "Downloading and verifying release $version"
    local downloaded
    if ! downloaded="$(node "$TOOLS_DIR/release.mjs" download "${args[@]}" --dest "$RELEASES_DIR")"; then
      die "release download, checksum verification or extraction failed"
    fi
    [ -d "$release" ] || die "downloaded release directory is missing: $release"
    printf '%s\n' "$version" > "$release/.deployed-version"
  fi

  [ -f "$release/dist/server/index.js" ] || die "release is missing dist/server/index.js"
  [ -f "$release/dist/web/index.html" ] || die "release is missing dist/web/index.html"
  [ -d "$release/node_modules" ] || die "release is missing production node_modules"
  [ -f "$release/deploy/proxmox/update.sh" ] || die "release is missing update.sh"
  [ -f "$release/deploy/proxmox/release.mjs" ] || die "release is missing release.mjs"

  chown -R root:"$SERVICE_USER" "$release"
  chmod -R g+rX,o-rwx "$release"
  printf '%s' "$version"
}

install_runtime_files() {
  local version="$1"
  local release="$RELEASES_DIR/$version"
  log "Installing management command, updater and systemd units for $version"
  install -m 0755 -o root -g root "$release/deploy/proxmox/seizure-diary" /usr/local/bin/seizure-diary
  install -m 0755 -o root -g root "$release/deploy/proxmox/update.sh" "$APP_ROOT/update.sh"
  install -m 0755 -o root -g root "$release/deploy/proxmox/release.mjs" "$TOOLS_DIR/release.mjs"
  local unit
  for unit in seizure-diary.service seizure-diary-backup.service seizure-diary-backup.timer; do
    install -m 0644 -o root -g root "$release/deploy/proxmox/systemd/$unit" "/etc/systemd/system/$unit"
  done
}

start_and_check() {
  local version="$1"
  local release="$RELEASES_DIR/$version"
  ln -sfn "$release" "$APP_ROOT/current.new"
  mv -Tf "$APP_ROOT/current.new" "$CURRENT_LINK"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"

  local port="3000"
  # shellcheck disable=SC1090
  if [ -r "$ENV_FILE" ]; then
    port="$(set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a; printf '%s' "${PORT:-3000}")"
  fi
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1; then
      log "Service is ready on 127.0.0.1:${port} (build $version)"
      if grep -Eq '^BACKUP_ENCRYPTION_KEY=.+' "$ENV_FILE"; then
        systemctl enable --now seizure-diary-backup.timer >/dev/null 2>&1 ||
          log "warning: could not enable the backup timer; inspect systemctl status seizure-diary-backup.timer"
        log "Daily encrypted backup timer enabled"
      else
        log "Backup timer installed but not enabled: set BACKUP_ENCRYPTION_KEY in $ENV_FILE, then run systemctl enable --now seizure-diary-backup.timer"
      fi
      return 0
    fi
    sleep 1
  done
  systemctl --no-pager status "$SERVICE_NAME" || true
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
  die "the service did not become healthy. The release is in place but not serving. Inspect the logs above."
}

log "Installing runtime packages"
install_packages
log "Checking Node.js"
install_node
log "Creating service identity and directories"
create_identity_and_dirs
write_config_files
install_token

log "Resolving and downloading the runner-built release from $REPO"
RELEASE_VERSION="$(download_release)"
install_runtime_files "$RELEASE_VERSION"
start_and_check "$RELEASE_VERSION"

cat <<DONE

Seizure Diary $RELEASE_VERSION is installed at $RELEASES_DIR/$RELEASE_VERSION

Next steps:
  1. Create the first admin:
       /usr/local/bin/seizure-diary bootstrap-admin --username <admin>
  2. Configure a private HTTPS reverse proxy and set PUBLIC_ORIGIN in
       $ENV_FILE
     then: systemctl restart $SERVICE_NAME
  3. Set BACKUP_ENCRYPTION_KEY (base64, 32 bytes) in $ENV_FILE, then enable daily backups:
       systemctl enable --now seizure-diary-backup.timer
  4. Future updates download the next runner-built GitHub release:
       /usr/local/bin/seizure-diary update
DONE

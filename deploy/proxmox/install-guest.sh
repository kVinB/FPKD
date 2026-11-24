#!/usr/bin/env bash
# Guest bootstrap for a fresh unprivileged Debian 12 LXC, or a supported
# existing dedicated LXC. Run as root inside the guest, or via pct exec.
# Idempotent for the same application instance.
set -euo pipefail

REPO_URL="https://github.com/kVinB/FPKD.git"
REF="main"
RESUME="0"
NONINTERACTIVE="0"
NODE_VERSION="22.13.1"

APP_ROOT="/opt/seizure-diary"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
CONF_DIR="/etc/seizure-diary"
ENV_FILE="$CONF_DIR/seizure-diary.env"
INSTALL_CONF="$CONF_DIR/install.conf"
DATA_DIR="/var/lib/seizure-diary"
BACKUP_DIR="/var/backups/seizure-diary"
SERVICE_USER="seizure-diary"
DEPLOY_USER="seizure-diary-deploy"
SERVICE_NAME="seizure-diary"
GITHUB_ED25519_FINGERPRINT="${GITHUB_ED25519_FINGERPRINT:-SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU}"

die() {
  printf 'install-guest.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[guest] %s\n' "$*"
}

usage() {
  cat <<'USAGE'
Usage: sudo bash install-guest.sh [options]

Options:
  --repo-url <url>     GitHub HTTPS or SSH repository URL
  --ref <branch>       Trusted branch to deploy (default: main)
  --resume             Continue after adding the guest's read-only deploy key
  --non-interactive    Never wait for operator input; exit cleanly if key access is missing
  -h, --help           Show this help
USAGE
}

need_value() {
  [ "$#" -ge 2 ] || die "missing value for $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-url) need_value "$@"; REPO_URL="$2"; shift 2 ;;
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --resume) RESUME="1"; shift ;;
    --non-interactive) NONINTERACTIVE="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root inside the LXC"
[ -f /etc/debian_version ] || die "this installer supports Debian guests only"

case "$REPO_URL" in
  https://github.com/*/*|git@github.com:*/*) ;;
  *) die "only GitHub HTTPS or SSH repository URLs are accepted" ;;
esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --ref"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid NODE_VERSION"

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" 2>/dev/null | cut -d: -f6 || true)"
DEPLOY_HOME="${DEPLOY_HOME:-/var/lib/seizure-diary-deploy}"

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    git ca-certificates curl openssh-client sqlite3 util-linux \
    build-essential python3 xz-utils openssl
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -ge 20 ] && [ "$major" -le 22 ]; then
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
    log "Installing Node.js v$NODE_VERSION ($arch) from official tarball with checksum verification"
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

create_identities_and_dirs() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DEPLOY_HOME" --create-home --shell /bin/bash "$DEPLOY_USER"
  fi

  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$BACKUP_DIR"
  install -d -m 0755 -o root -g root "$APP_ROOT" "$RELEASES_DIR"
  install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME"
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
}

write_config_files() {
  cat > "$INSTALL_CONF" <<EOF
REPO_URL=$REPO_URL
REF=$REF
DEPLOY_USER=$DEPLOY_USER
SERVICE_USER=$SERVICE_USER
APP_ROOT=$APP_ROOT
WORK_DIR=$DEPLOY_HOME
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

ssh_options() {
  printf 'ssh -i %s/.ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=%s/.ssh/known_hosts -o StrictHostKeyChecking=yes -o ConnectTimeout=15' \
    "$DEPLOY_HOME" "$DEPLOY_HOME"
}

setup_deploy_key() {
  case "$REPO_URL" in
    git@github.com:*/*) ;;
    *) return 0 ;;
  esac

  if [ ! -f "$DEPLOY_HOME/.ssh/id_ed25519" ]; then
    log "Generating a read-only deploy key for this guest"
    runuser -u "$DEPLOY_USER" -- ssh-keygen -q -t ed25519 -N '' \
      -C "seizure-diary-deploy@$(hostname)" \
      -f "$DEPLOY_HOME/.ssh/id_ed25519"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/id_ed25519" "$DEPLOY_HOME/.ssh/id_ed25519.pub"
  chmod 0600 "$DEPLOY_HOME/.ssh/id_ed25519"

  if [ ! -f "$DEPLOY_HOME/.ssh/known_hosts" ]; then
    log "Verifying GitHub's SSH host key fingerprint"
    local tmp
    tmp="$(mktemp)"
    ssh-keyscan -T 15 -t ed25519 github.com > "$tmp" 2>/dev/null || die "could not scan github.com SSH host key"
    grep -q '^github.com ' "$tmp" || die "github.com did not return an Ed25519 host key"
    local fingerprint
    fingerprint="$(ssh-keygen -lf "$tmp" | awk '{print $2}' | head -1)"
    if [ "$fingerprint" != "$GITHUB_ED25519_FINGERPRINT" ]; then
      rm -f "$tmp"
      die "GitHub host key fingerprint mismatch (got $fingerprint). Refusing to continue."
    fi
    install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$tmp" "$DEPLOY_HOME/.ssh/known_hosts"
    rm -f "$tmp"
  fi
}

test_repo_access() {
  local ssh_cmd
  ssh_cmd="$(ssh_options)"
  if [[ "$REPO_URL" == git@github.com:* ]]; then
    runuser -u "$DEPLOY_USER" -- env GIT_SSH_COMMAND="$ssh_cmd" \
      git ls-remote "$REPO_URL" >/dev/null 2>&1
  else
    runuser -u "$DEPLOY_USER" -- env GIT_TERMINAL_PROMPT=0 \
      git ls-remote "$REPO_URL" >/dev/null 2>&1
  fi
}

require_access_or_pause() {
  if test_repo_access; then
    return 0
  fi
  echo
  echo "The guest cannot read $REPO_URL yet."
  if [[ "$REPO_URL" == git@github.com:* ]]; then
    echo "Add this read-only deploy key in GitHub (Repository -> Settings -> Deploy keys):"
    echo
    cat "$DEPLOY_HOME/.ssh/id_ed25519.pub"
    echo
    echo "Then resume:"
    echo "  bash /root/install-guest.sh --repo-url '$REPO_URL' --ref '$REF' --non-interactive --resume"
    exit 2
  fi
  echo "For a private repository, use a repo-scoped SSH URL so the deploy key can be used."
  exit 2
}

fetch_repository() {
  local ssh_cmd
  ssh_cmd="$(ssh_options)"
  local work="$DEPLOY_HOME/repo"
  if [ ! -d "$work/.git" ]; then
    log "Cloning $REPO_URL"
    if [[ "$REPO_URL" == git@github.com:* ]]; then
      runuser -u "$DEPLOY_USER" -- env GIT_SSH_COMMAND="$ssh_cmd" \
        git clone "$REPO_URL" "$work"
    else
      runuser -u "$DEPLOY_USER" -- env GIT_TERMINAL_PROMPT=0 \
        git clone "$REPO_URL" "$work"
    fi
  else
    log "Fetching $REF"
    if [[ "$REPO_URL" == git@github.com:* ]]; then
      runuser -u "$DEPLOY_USER" -- env GIT_SSH_COMMAND="$ssh_cmd" \
        git -C "$work" fetch origin "$REF"
    else
      runuser -u "$DEPLOY_USER" -- env GIT_TERMINAL_PROMPT=0 \
        git -C "$work" fetch origin "$REF"
    fi
  fi
  runuser -u "$DEPLOY_USER" -- git -C "$work" rev-parse FETCH_HEAD
}

build_release() {
  local commit="$1"
  local release="$RELEASES_DIR/$commit"
  if [ -f "$release/.deployed-commit" ]; then
    log "Release $commit already built; reusing it"
    echo "$release"
    return 0
  fi

  local work="$DEPLOY_HOME/repo"
  local build="$DEPLOY_HOME/build-$commit"
  log "Staging and building $commit as $DEPLOY_USER"
  rm -rf "$build"
  mkdir -p "$build"
  runuser -u "$DEPLOY_USER" -- git -C "$work" archive "$commit" | tar -x -C "$build"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$build"

  runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" bash -c \
    "cd '$build' && npm ci && npm run typecheck && npm test && npm run build && npm prune --omit=dev" \
    || die "build or tests failed for $commit; the live release and database were not touched"

  install -d -m 0750 -o root -g "$SERVICE_USER" "$release"
  cp -a "$build/dist" "$release/dist"
  cp "$build/package.json" "$build/package-lock.json" "$release/"
  cp -a "$build/node_modules" "$release/node_modules"
  printf '%s\n' "$commit" > "$release/.deployed-commit"
  chown -R root:"$SERVICE_USER" "$release"
  chmod -R g+rX,o-rwx "$release"
  echo "$release"
}

install_runtime_files() {
  local commit="$1"
  local work="$DEPLOY_HOME/repo"

  log "Installing management command, updater and systemd unit"
  runuser -u "$DEPLOY_USER" -- git -C "$work" show "$commit:deploy/proxmox/seizure-diary" > /usr/local/bin/seizure-diary
  chown root:root /usr/local/bin/seizure-diary
  chmod 0755 /usr/local/bin/seizure-diary

  runuser -u "$DEPLOY_USER" -- git -C "$work" show "$commit:deploy/proxmox/update.sh" > "$APP_ROOT/update.sh"
  chown root:root "$APP_ROOT/update.sh"
  chmod 0755 "$APP_ROOT/update.sh"

  runuser -u "$DEPLOY_USER" -- git -C "$work" show "$commit:deploy/proxmox/systemd/seizure-diary.service" \
    > "/etc/systemd/system/${SERVICE_NAME}.service"
  chown root:root "/etc/systemd/system/${SERVICE_NAME}.service"
  chmod 0644 "/etc/systemd/system/${SERVICE_NAME}.service"
}

start_and_check() {
  local release="$1"
  ln -sfn "$release" "$APP_ROOT/current.new"
  mv -Tf "$APP_ROOT/current.new" "$CURRENT_LINK"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"

  local port="3000"
  # shellcheck disable=SC1090
  if [ -r "$ENV_FILE" ]; then
    port="$(. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${PORT:-3000}")"
  fi
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1; then
      log "Service is ready on 127.0.0.1:${port}"
      return 0
    fi
    sleep 1
  done
  systemctl --no-pager status "$SERVICE_NAME" || true
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
  die "the service did not become healthy. The release is in place but not serving. Inspect the logs above."
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log "Installing packages"
install_packages
log "Checking Node.js"
install_node
log "Creating service and deployment identities"
create_identities_and_dirs
write_config_files
setup_deploy_key

if [ "$RESUME" = "1" ]; then
  log "Resuming after deploy-key setup"
fi
require_access_or_pause

log "Fetching repository"
TARGET_COMMIT="$(fetch_repository)"
[ -n "$TARGET_COMMIT" ] || die "could not resolve a commit for $REF"
log "Target commit: $TARGET_COMMIT"

RELEASE_DIR="$(build_release "$TARGET_COMMIT")"
install_runtime_files "$TARGET_COMMIT"
start_and_check "$RELEASE_DIR"

cat <<DONE

Seizure Diary is installed at $RELEASE_DIR

Next steps:
  1. Create the first admin (guest-local, hidden password prompt):
       /usr/local/bin/seizure-diary bootstrap-admin --username <admin>
  2. Configure a private HTTPS reverse proxy and set PUBLIC_ORIGIN in
       $ENV_FILE
     then: systemctl restart $SERVICE_NAME
  3. Set BACKUP_ENCRYPTION_KEY (base64, 32 bytes) in $ENV_FILE before relying on backups.
  4. Verify LAN/WireGuard access is allowed and external access is blocked.
  5. Manage updates with: /usr/local/bin/seizure-diary update
DONE

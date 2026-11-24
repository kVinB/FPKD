#!/usr/bin/env bash
# Manual, forward-only updater installed at /opt/seizure-diary/update.sh.
# Downloads a runner-built, checksum-verified GitHub release bundle.
# Run as root. Never invoked automatically or in the background.
set -euo pipefail

APP_ROOT="${SEIZURE_DIARY_APP_ROOT:-/opt/seizure-diary}"
CURRENT_LINK="$APP_ROOT/current"
RELEASES_DIR="$APP_ROOT/releases"
ENV_FILE="${SEIZURE_DIARY_ENV_FILE:-/etc/seizure-diary/seizure-diary.env}"
INSTALL_CONF="${SEIZURE_DIARY_INSTALL_CONF:-/etc/seizure-diary/install.conf}"
SERVICE_NAME="${SEIZURE_DIARY_SERVICE_NAME:-seizure-diary}"
LOCK_FILE="${SEIZURE_DIARY_UPDATE_LOCK:-/run/seizure-diary-update.lock}"
BIN_DIR="${SEIZURE_DIARY_BIN_DIR:-/usr/local/bin}"
SYSTEMD_DIR="${SEIZURE_DIARY_SYSTEMD_DIR:-/etc/systemd/system}"
TOOLS_DIR="${SEIZURE_DIARY_TOOLS_DIR:-$APP_ROOT/tools}"
HEALTH_ATTEMPTS="${SEIZURE_DIARY_HEALTH_ATTEMPTS:-20}"

TARGET_REQUEST="latest"
CHECK_ONLY="0"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY="1"; shift ;;
    --version)
      [ "$#" -ge 2 ] || { printf 'update.sh: missing value for --version\n' >&2; exit 1; }
      TARGET_REQUEST="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: seizure-diary update [--check] [--version latest|<YYYYMMDD.VV>]

Downloads the next runner-built GitHub release and deploys it transactionally.
--check reports installed and upstream versions only. It does not stop the
service, back up, migrate or deploy.
USAGE
      exit 0
      ;;
    *) printf 'update.sh: unknown option %s\n' "$1" >&2; exit 1 ;;
  esac
done

die() {
  printf 'update.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[update] %s\n' "$*" >&2
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -r "$INSTALL_CONF" ] || die "missing $INSTALL_CONF"
[ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
[ -d "$CURRENT_LINK" ] || die "no active release at $CURRENT_LINK"
[ -x "$TOOLS_DIR/release.mjs" ] || die "missing release tool at $TOOLS_DIR/release.mjs"

# shellcheck disable=SC1090
. "$INSTALL_CONF"
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

REPO_SLUG="${REPO_SLUG:-}"
GITHUB_TOKEN_FILE="${GITHUB_TOKEN_FILE:-/etc/seizure-diary/github-token}"
DB_PATH="${SEIZURE_DIARY_DB_PATH:?SEIZURE_DIARY_DB_PATH is not set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/seizure-diary}"
PORT="${PORT:-3000}"
SERVICE_USER="${SERVICE_USER:-seizure-diary}"

[ -n "$REPO_SLUG" ] || die "REPO_SLUG missing from $INSTALL_CONF"
if [ "$TARGET_REQUEST" != "latest" ] && [[ ! "$TARGET_REQUEST" =~ ^[0-9]{8}\.[0-9]{2}$ ]]; then
  die "invalid --version (latest or YYYYMMDD.VV)"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another update is already running"
fi

CURRENT_VERSION="$(cat "$CURRENT_LINK/.deployed-version" 2>/dev/null || true)"
if [ -z "$CURRENT_VERSION" ]; then
  CURRENT_VERSION="$(cat "$CURRENT_LINK/.deployed-commit" 2>/dev/null || true)"
fi
[ -n "$CURRENT_VERSION" ] || die "cannot read installed version from $CURRENT_LINK"
CURRENT_BUNDLE_VERSION="$CURRENT_VERSION"
[[ "$CURRENT_VERSION" =~ ^[0-9]{8}\.[0-9]{2}$ ]] || CURRENT_BUNDLE_VERSION="unknown"

release_args=()
if [ -r "$GITHUB_TOKEN_FILE" ]; then
  release_args+=(--token-file "$GITHUB_TOKEN_FILE")
fi

log "Resolving $TARGET_REQUEST from $REPO_SLUG"
if ! resolved="$(node "$TOOLS_DIR/release.mjs" resolve \
  --repo "$REPO_SLUG" --version "$TARGET_REQUEST" "${release_args[@]}")"; then
  die "could not resolve the requested release. For a private repository, check $GITHUB_TOKEN_FILE."
fi
TARGET_VERSION="$(printf '%s' "$resolved" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    const value = JSON.parse(s).version;
    if (!/^[0-9]{8}\.[0-9]{2}$/.test(value)) process.exit(1);
    process.stdout.write(value);
  });
')" || die "release metadata did not contain a valid YYYYMMDD.VV version"

if [ "$CHECK_ONLY" = "1" ]; then
  printf 'installed: %s\nupstream:  %s\n' "$CURRENT_VERSION" "$TARGET_VERSION"
  if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
    printf 'status: up to date\n'
  else
    printf 'status: update available (run: seizure-diary update)\n'
  fi
  exit 0
fi

if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
  log "Already at $TARGET_VERSION; nothing to download, back up or restart"
  exit 0
fi

if [[ "$CURRENT_VERSION" =~ ^[0-9]{8}\.[0-9]{2}$ ]] && [[ "$TARGET_VERSION" < "$CURRENT_VERSION" ]]; then
  die "refusing to downgrade from $CURRENT_VERSION to $TARGET_VERSION"
fi

[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] ||
  die "BACKUP_ENCRYPTION_KEY is not set in $ENV_FILE. Refusing to update without an encrypted pre-update backup."

free_kb="$(df -Pk "$APP_ROOT" | awk 'NR==2 {print $4}')"
if [ "${free_kb:-0}" -lt 1048576 ]; then
  die "less than 1 GiB free on $APP_ROOT; free space before updating"
fi

RELEASE_DIR="$RELEASES_DIR/$TARGET_VERSION"
if [ -d "$RELEASE_DIR" ] && [ ! -f "$RELEASE_DIR/.deployed-version" ]; then
  die "release directory $RELEASE_DIR exists without a completion marker; remove it and retry"
fi

if [ -f "$RELEASE_DIR/.deployed-version" ]; then
  log "Release $TARGET_VERSION is already downloaded; reusing it"
else
  log "Downloading and verifying release $TARGET_VERSION"
  if ! node "$TOOLS_DIR/release.mjs" download \
    --repo "$REPO_SLUG" --version "$TARGET_VERSION" "${release_args[@]}" --dest "$RELEASES_DIR"; then
    die "release download, checksum verification or extraction failed; the live release was not touched"
  fi
  [ -d "$RELEASE_DIR" ] || die "downloaded release directory is missing: $RELEASE_DIR"
  printf '%s\n' "$TARGET_VERSION" > "$RELEASE_DIR/.deployed-version"
fi

for required in \
  dist/server/index.js dist/web/index.html node_modules \
  deploy/proxmox/update.sh deploy/proxmox/seizure-diary deploy/proxmox/release.mjs; do
  [ -e "$RELEASE_DIR/$required" ] || die "release is missing $required"
done
chown -R root:"$SERVICE_USER" "$RELEASE_DIR"
chmod -R g+rX,o-rwx "$RELEASE_DIR"

log "Installing management command, updater and systemd units before cutover"
install -m 0755 -o root -g root "$RELEASE_DIR/deploy/proxmox/seizure-diary" "$BIN_DIR/seizure-diary.new"
mv -f "$BIN_DIR/seizure-diary.new" "$BIN_DIR/seizure-diary"
install -m 0755 -o root -g root "$RELEASE_DIR/deploy/proxmox/update.sh" "$APP_ROOT/update.sh.new"
mv -f "$APP_ROOT/update.sh.new" "$APP_ROOT/update.sh"
install -m 0755 -o root -g root "$RELEASE_DIR/deploy/proxmox/release.mjs" "$TOOLS_DIR/release.mjs.new"
mv -f "$TOOLS_DIR/release.mjs.new" "$TOOLS_DIR/release.mjs"
for unit in seizure-diary.service seizure-diary-backup.service seizure-diary-backup.timer; do
  install -m 0644 -o root -g root "$RELEASE_DIR/deploy/proxmox/systemd/$unit" "$SYSTEMD_DIR/$unit.new"
  mv -f "$SYSTEMD_DIR/$unit.new" "$SYSTEMD_DIR/$unit"
done
systemctl daemon-reload

log "Stopping the service and taking a verified encrypted snapshot"
systemctl stop "$SERVICE_NAME"
if ! runuser -u "$SERVICE_USER" -- env \
  SEIZURE_DIARY_DB_PATH="$DB_PATH" \
  BACKUP_DIR="$BACKUP_DIR" \
  BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
  NODE_ENV=production \
  node "$CURRENT_LINK/dist/server/cli.js" backup --retain 14; then
  log "Pre-update backup failed; restarting the previous release. No migrations were run."
  systemctl start "$SERVICE_NAME"
  die "aborted before migrations"
fi

log "Applying versioned migrations for $TARGET_VERSION"
if ! runuser -u "$SERVICE_USER" -- env \
  SEIZURE_DIARY_DB_PATH="$DB_PATH" \
  NODE_ENV=production \
  node "$RELEASE_DIR/dist/server/cli.js" migrate; then
  cat >&2 <<FAILED

MIGRATION FAILED AFTER THE SERVICE WAS STOPPED.
The database may have partially applied versioned migrations. The service is
being left STOPPED on purpose. Do not overwrite the database with the pre-update
snapshot unless you are certain no user writes occurred and you can restore with
the service stopped and no stale -wal/-shm sidecars.

Recovery:
  1. Inspect: journalctl -u $SERVICE_NAME -n 100
  2. Check:   sqlite3 $DB_PATH 'PRAGMA integrity_check;'
  3. Fix the migration or restore the pre-update encrypted snapshot with:
       seizure-diary restore-backup <file> --force
     (the command removes stale WAL/SHM sidecars and revokes sessions)
  4. Start the service only after the database is verified.
FAILED
  exit 1
fi

log "Switching the active release atomically"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$CURRENT_LINK"

systemctl start "$SERVICE_NAME"
ready="0"
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    ready="1"
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  systemctl stop "$SERVICE_NAME" || true
  cat >&2 <<FAILED

NEW RELEASE DID NOT BECOME HEALTHY.
The service is left STOPPED and the database is NOT automatically rolled back,
because migrations may have run and user writes could exist. Previous release:
  $RELEASES_DIR/$CURRENT_VERSION
Previous snapshot: $BACKUP_DIR (newest encrypted file)

Inspect:
  journalctl -u $SERVICE_NAME -n 100
Recover only with a verified database snapshot and the service stopped.
FAILED
  exit 1
fi

if grep -Eq '^BACKUP_ENCRYPTION_KEY=.+' "$ENV_FILE"; then
  systemctl enable --now seizure-diary-backup.timer >/dev/null 2>&1 ||
    log "warning: could not enable the daily backup timer"
fi

printf 'updated: %s -> %s\n' "$CURRENT_VERSION" "$TARGET_VERSION"
printf 'previous release retained at %s\n' "$RELEASES_DIR/$CURRENT_VERSION"

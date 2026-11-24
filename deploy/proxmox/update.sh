#!/usr/bin/env bash
# Manual, forward-only updater installed at /opt/seizure-diary/update.sh.
# Run as root. Never invoked automatically or in the background.
set -euo pipefail

APP_ROOT="/opt/seizure-diary"
CURRENT_LINK="$APP_ROOT/current"
RELEASES_DIR="$APP_ROOT/releases"
ENV_FILE="/etc/seizure-diary/seizure-diary.env"
INSTALL_CONF="/etc/seizure-diary/install.conf"
SERVICE_NAME="seizure-diary"
LOCK_FILE="/run/seizure-diary-update.lock"

CHECK_ONLY="0"
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY="1" ;;
    -h|--help)
      cat <<'USAGE'
Usage: seizure-diary update [--check]

--check reports installed and upstream revisions only. It does not build,
stop the service, back up, migrate or deploy.
USAGE
      exit 0
      ;;
    *) printf 'update.sh: unknown option %s\n' "$arg" >&2; exit 1 ;;
  esac
done

die() {
  printf 'update.sh: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[update] %s\n' "$*"
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -r "$INSTALL_CONF" ] || die "missing $INSTALL_CONF"
[ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
[ -d "$CURRENT_LINK" ] || die "no active release at $CURRENT_LINK"

# shellcheck disable=SC1090
. "$INSTALL_CONF"
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

REPO_URL="${REPO_URL:-}"
REF="${REF:-main}"
DEPLOY_USER="${DEPLOY_USER:-seizure-diary-deploy}"
SERVICE_USER="${SERVICE_USER:-seizure-diary}"
WORK_DIR="${WORK_DIR:-/var/lib/seizure-diary-deploy}"
DB_PATH="${SEIZURE_DIARY_DB_PATH:?SEIZURE_DIARY_DB_PATH is not set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/seizure-diary}"
PORT="${PORT:-3000}"

[ -n "$REPO_URL" ] || die "REPO_URL missing from $INSTALL_CONF"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid REF in $INSTALL_CONF"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another update is already running"
fi

WORK_REPO="$WORK_DIR/repo"
[ -d "$WORK_REPO/.git" ] || die "missing deployment checkout at $WORK_REPO"

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
SSH_CMD="ssh -i $DEPLOY_HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=$DEPLOY_HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes -o ConnectTimeout=15"

remote_url="$(runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" remote get-url origin)"
if [ "$remote_url" != "$REPO_URL" ]; then
  die "configured remote '$remote_url' does not match $INSTALL_CONF ($REPO_URL); refusing to update"
fi

CURRENT_COMMIT="$(cat "$CURRENT_LINK/.deployed-commit" 2>/dev/null || true)"
[ -n "$CURRENT_COMMIT" ] || die "cannot read deployed commit from $CURRENT_LINK/.deployed-commit"

log "Fetching $REF from $REPO_URL"
if [[ "$REPO_URL" == git@github.com:* ]]; then
  runuser -u "$DEPLOY_USER" -- env GIT_SSH_COMMAND="$SSH_CMD" \
    git -C "$WORK_REPO" fetch origin "$REF" || die "git fetch failed; no changes were made"
else
  runuser -u "$DEPLOY_USER" -- env GIT_TERMINAL_PROMPT=0 \
    git -C "$WORK_REPO" fetch origin "$REF" || die "git fetch failed; no changes were made"
fi
TARGET_COMMIT="$(runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" rev-parse FETCH_HEAD)"

if ! runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" cat-file -e "$CURRENT_COMMIT^{commit}" 2>/dev/null; then
  die "installed commit $CURRENT_COMMIT is not in the deployment checkout; refusing an unsafe update. Reinstall or restore the matching release first."
fi

if ! runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" merge-base --is-ancestor "$CURRENT_COMMIT" "$TARGET_COMMIT"; then
  die "upstream $TARGET_COMMIT is not a forward descendant of installed $CURRENT_COMMIT (diverged or rewritten history). Operator intervention required."
fi

if [ "$CHECK_ONLY" = "1" ]; then
  printf 'installed: %s\nupstream:  %s (%s)\n' "$CURRENT_COMMIT" "$TARGET_COMMIT" "$REF"
  if [ "$CURRENT_COMMIT" = "$TARGET_COMMIT" ]; then
    printf 'status: up to date\n'
  else
    printf 'status: update available (run: seizure-diary update)\n'
  fi
  exit 0
fi

if [ "$CURRENT_COMMIT" = "$TARGET_COMMIT" ]; then
  log "Already at $TARGET_COMMIT; nothing to build, back up or restart"
  exit 0
fi

[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] ||
  die "BACKUP_ENCRYPTION_KEY is not set in $ENV_FILE. Refusing to update without an encrypted pre-update backup."

free_kb="$(df -Pk "$APP_ROOT" | awk 'NR==2 {print $4}')"
if [ "${free_kb:-0}" -lt 1048576 ]; then
  die "less than 1 GiB free on $APP_ROOT; free space before updating"
fi

BUILD_DIR="$WORK_DIR/update-$TARGET_COMMIT"
RELEASE_DIR="$RELEASES_DIR/$TARGET_COMMIT"

cleanup_build() {
  rm -rf "$BUILD_DIR"
}
trap cleanup_build EXIT

log "Staging $TARGET_COMMIT"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" archive "$TARGET_COMMIT" | tar -x -C "$BUILD_DIR"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$BUILD_DIR"

log "Installing dependencies, testing and building (live service untouched)"
if ! runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" bash -c \
  "cd '$BUILD_DIR' && npm ci && npm run typecheck && npm test && npm run build && npm prune --omit=dev"; then
  die "staging build or tests failed for $TARGET_COMMIT; the live release and database were not touched"
fi

log "Preparing release directory"
rm -rf "$RELEASE_DIR"
install -d -m 0750 -o root -g "$SERVICE_USER" "$RELEASE_DIR"
cp -a "$BUILD_DIR/dist" "$RELEASE_DIR/dist"
cp "$BUILD_DIR/package.json" "$BUILD_DIR/package-lock.json" "$RELEASE_DIR/"
cp -a "$BUILD_DIR/node_modules" "$RELEASE_DIR/node_modules"
printf '%s\n' "$TARGET_COMMIT" > "$RELEASE_DIR/.deployed-commit"
chown -R root:"$SERVICE_USER" "$RELEASE_DIR"
chmod -R g+rX,o-rwx "$RELEASE_DIR"

# Install the new management command and unit before cutover; paths are stable.
runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" show "$TARGET_COMMIT:deploy/proxmox/seizure-diary" \
  > /usr/local/bin/seizure-diary.new
chown root:root /usr/local/bin/seizure-diary.new
chmod 0755 /usr/local/bin/seizure-diary.new
mv -f /usr/local/bin/seizure-diary.new /usr/local/bin/seizure-diary

runuser -u "$DEPLOY_USER" -- git -C "$WORK_REPO" show \
  "$TARGET_COMMIT:deploy/proxmox/systemd/seizure-diary.service" \
  > "/etc/systemd/system/${SERVICE_NAME}.service.new"
chown root:root "/etc/systemd/system/${SERVICE_NAME}.service.new"
chmod 0644 "/etc/systemd/system/${SERVICE_NAME}.service.new"
mv -f "/etc/systemd/system/${SERVICE_NAME}.service.new" "/etc/systemd/system/${SERVICE_NAME}.service"
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

log "Applying versioned migrations for $TARGET_COMMIT"
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
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    ready="1"
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  cat >&2 <<FAILED

NEW RELEASE DID NOT BECOME HEALTHY.
The service is left STOPPED and the database is NOT automatically rolled back,
because migrations may have run and user writes could exist. Previous release:
  $RELEASES_DIR/$CURRENT_COMMIT
Previous snapshot: $BACKUP_DIR (newest encrypted file)

Inspect:
  journalctl -u $SERVICE_NAME -n 100
Recover only with a verified database snapshot and the service stopped.
FAILED
  exit 1
fi

trap - EXIT
cleanup_build
printf 'updated: %s -> %s\n' "$CURRENT_COMMIT" "$TARGET_COMMIT"
printf 'previous release retained at %s\n' "$RELEASES_DIR/$CURRENT_COMMIT"

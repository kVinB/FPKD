# Proxmox native LXC installer and updater

This directory installs **Seizure Diary** into a fresh **unprivileged Debian 12 LXC**
on Proxmox VE, using the application's real npm build and systemd. It does **not**
require Docker, Docker nesting, a privileged container, or preinstalled guest
Git/Node. The updater is manual and forward-only.

The app is private, server-backed, and not offline-first. The SQLite database is
readable by anyone with guest root or the database backups. HTTPS and file
permissions are not end-to-end encryption.

## Files

| File | Purpose |
|---|---|
| `install.sh` | Proxmox host entry point (`pct`/`pveam`), dry-run and validation |
| `install-guest.sh` | Guest bootstrap: apt, verified Node LTS, identities, build, systemd; resume support for deploy keys |
| `seizure-diary` | Management command installed at `/usr/local/bin/seizure-diary` |
| `update.sh` | Manual update transaction installed at `/opt/seizure-diary/update.sh` |
| `systemd/seizure-diary.service` | Hardened, non-root service unit |
| `systemd/seizure-diary-backup.service` / `.timer` | Daily encrypted backup job and schedule |
| `seizure-diary.env.example` | Reference environment (installer writes a generated secret) |
| `nginx-private.conf.example` | Private HTTPS reverse-proxy example (LAN/WireGuard only) |

## Paths and identities

- Releases: `/opt/seizure-diary/releases/<commit>`, active symlink `/opt/seizure-diary/current`
- Database: `/var/lib/seizure-diary/seizure-diary.sqlite3` (service user only)
- Backups: `/var/backups/seizure-diary` (service user only)
- Config: `/etc/seizure-diary/seizure-diary.env` (root-owned, group-readable by service)
- Install metadata: `/etc/seizure-diary/install.conf`
- Build/deploy checkout: `/var/lib/seizure-diary-deploy/repo`
- Users: `seizure-diary` (service, no shell) and `seizure-diary-deploy` (build only)

The running service cannot read the deploy private key. The build user cannot read
the database or environment secrets.

## Prerequisites

1. Proxmox VE 8.x host with `pct`, `pveam`, `pvesm` available.
2. A storage that supports `rootdir` (container disks) and a storage that supports
   `vztmpl` (templates). The installer validates this; it never assumes IDs.
3. A network bridge (for example `vmbr0`) and either DHCP or a static IPv4/prefix+gateway.
4. Outbound DNS/HTTPS from the guest for Debian packages and GitHub.
5. A reviewed copy of this repository on the Proxmox host, **without** using `curl | bash`.

If the host has no Git and cannot clone the repository, obtain a reviewed tarball on
an authenticated workstation, verify its contents, and copy it to the host using
your existing access. The installer records the deployed commit.

## Step 1 — host install

```sh
sudo ./deploy/proxmox/install.sh --dry-run --rootfs-storage <storage> ...
sudo ./deploy/proxmox/install.sh \
  --ctid 210 \
  --hostname seizure-diary \
  --rootfs-storage <rootdir-storage> \
  --template-storage <vztmpl-storage> \
  --bridge vmbr0 \
  --ip 10.20.0.10/24 \
  --gateway 10.20.0.1 \
  --dns 10.20.0.1 \
  --repo-url git@github.com:kVinB/FPKD.git \
  --ref main \
  --yes
```

The summary is shown before any change. `--dry-run` performs no writes, downloads,
container creation, or start. The script never reuses or destroys a CTID, and does
not modify host packages, firewall, networking, reverse proxies, or cluster config.

### Private GitHub repository (read-only deploy key)

For a private repo use the SSH URL (`git@github.com:kVinB/FPKD.git`). On first run the
guest:

1. Generates an Ed25519 deploy key as `seizure-diary-deploy`.
2. Prints only the **public** key and pauses without recreating the container.
3. Verifies GitHub's SSH host key against
   `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`
   (override with `GITHUB_ED25519_FINGERPRINT` only if GitHub rotates it and you have
   verified the new fingerprint separately).

Add the public key in GitHub → Repository → Settings → Deploy keys → Add deploy key,
**read-only**, then resume:

```sh
pct exec 210 -- bash /root/install-guest.sh \
  --repo-url git@github.com:kVinB/FPKD.git --ref main --non-interactive --resume
```

The host installer prints the exact resume command and exits with status `2`.

## Step 2 — first admin and configuration

All guest-admin commands may be run from the guest console or with `pct exec`:

```sh
pct exec 210 -- /usr/local/bin/seizure-diary status
pct exec 210 -- /usr/local/bin/seizure-diary bootstrap-admin --username <admin>
```

`bootstrap-admin` refuses an already provisioned database, prompts with hidden password
input (or accepts `--password-stdin` for automation), and creates no default password.
There is no public signup endpoint.

Edit `/etc/seizure-diary/seizure-diary.env`:

- `PUBLIC_ORIGIN=https://diary.home.arpa` (exact browser origin, no trailing slash)
- `BACKUP_ENCRYPTION_KEY` — base64 for 32 bytes, e.g. `openssl rand -base64 32`
- Keep `HOST=127.0.0.1` and publish only through the private proxy.

Then `systemctl restart seizure-diary`.

## Step 3 — private HTTPS ingress

Use `nginx-private.conf.example` as a starting point or your existing private reverse
proxy:

- Bind the listener and proxy host only to LAN/WireGuard addresses.
- Use a certificate trusted by every family device (DNS-validated or a private CA).
- Enforce firewall/ACL rules by source; **DNS alone does not protect the app**.
- Give each family device an individual WireGuard peer scoped to this app; do not grant
  Proxmox management or unrelated service access.
- Do not add public port forwarding or a public tunnel for the web app.
- Disable proxy caching for `/api/` responses.

Before using real data, verify sign-in from an allowed LAN/WireGuard client, confirm an
external client (not on VPN) cannot reach the app, and confirm data survives a restart.

## Management commands

```sh
/usr/local/bin/seizure-diary version
/usr/local/bin/seizure-diary status
/usr/local/bin/seizure-diary update --check
/usr/local/bin/seizure-diary update
/usr/local/bin/seizure-diary bootstrap-admin --username <admin>
/usr/local/bin/seizure-diary backup --retain 14
/usr/local/bin/seizure-diary verify-backup <file>
/usr/local/bin/seizure-diary restore-backup <file> --force
```

From the Proxmox host:

```sh
pct exec 210 -- /usr/local/bin/seizure-diary update
pct exec 210 -- /usr/local/bin/seizure-diary update --check
```

`update`, migration, bootstrap, password recovery and restore need guest root.
Backups run as the service user (or root, which switches to it). The web user never
gets the deploy key or database path.

## Backup and restore

Generate a backup encryption key once and keep it outside the guest:

```sh
openssl rand -base64 32    # set as BACKUP_ENCRYPTION_KEY in the env file
```

Manual encrypted snapshot:

```sh
/usr/local/bin/seizure-diary backup --retain 14
```

This uses SQLite `VACUUM INTO` into a staging file, runs `PRAGMA integrity_check`,
encrypts with AES-256-GCM, sets mode `0600`, and applies retention to matching files.
It never copies only a live WAL database. Move encrypted snapshots to separate,
protected storage.

### Daily backup timer

The installer ships `seizure-diary-backup.service` and `.timer`. The installer enables the
timer only when `BACKUP_ENCRYPTION_KEY` is present; otherwise set the key and enable it
manually:

```sh
systemctl enable --now seizure-diary-backup.timer
systemctl list-timers seizure-diary-backup.timer
systemctl start seizure-diary-backup.service      # run one backup now
journalctl -u seizure-diary-backup.service -n 100 # inspect result/failure
```

The timer runs daily at 02:30 with up to 15 minutes of randomised delay and `Persistent=true`
so a missed run is attempted after the guest starts. It uses the same `seizure-diary backup
--retain 14` command under the unprivileged service user. Monitor failed units/logs from
outside the app; the app does not send notifications or telemetry. Updates reinstall the
units and re-enable the timer only when an encryption key is configured.

Verify without restoring:

```sh
seizure-diary verify-backup /var/backups/seizure-diary/<file>.enc
```

Restore (service must be stopped; the command refuses to overwrite without `--force`):

```sh
systemctl stop seizure-diary
seizure-diary restore-backup /var/backups/seizure-diary/<file>.enc --force
systemctl start seizure-diary
```

Restore verifies the snapshot, replaces the database, removes stale `-wal`/`-shm`
sidecars, and revokes all sessions. Test a restore in an isolated guest before relying
on it. Host snapshots supplement but do not replace this workflow.

Personal user JSON export/restore and clear-all are inside Settings and only affect the
signed-in account.

## Updates and downtime

`seizure-diary update` is manual and serialised with a lock. It:

1. Fetches only the configured remote and ref; refuses changed remotes, divergence, and
   rewritten history; exits without rebuilding if already current.
2. Stages the exact commit separately and runs `npm ci`, typecheck, tests, production
   build, then prunes dev dependencies. The live site stays up during this stage.
3. Stops the service, makes and verifies an **encrypted** SQLite snapshot, aborts if the
   backup cannot be made.
4. Runs versioned migrations, swaps the release symlink atomically, restarts, and waits
   for a bounded `/api/v1/health` check.
5. On failure before migrations, restarts the previous release. After migrations start,
   it **fails closed** (service stopped, no automatic database rollback) and prints
   recovery instructions, because newer health records may exist.

Downtime is limited to backup, migration, and restart. During that window the browser
shows a connection error; it never claims a save succeeded.

Rollback is manual: keep the previous release directory and pre-update encrypted
snapshot. Restore the database only with the service stopped, verify integrity, and
then point `current` at the previous release before starting. Do not silently roll back
a live database.

## What is not covered here

- This installer was **not executed against a real Proxmox host** in this workspace.
  Shell syntax, help output, and mocked `pct`/`pveam`/`pvesm` provisioning paths
  (dry-run/no mutation, CTID conflict, storage/bridge/static-IP validation, no
  `pct destroy`) plus updater transaction paths (no-change, divergence, failed build,
  failed backup, failed migration, failed health check, lock contention) and the app's
  deployment files are tested; real `pct`/`pveam` provisioning remains a deployment
  acceptance check.
- Do not use a privileged container, Docker nesting, or public exposure to work around
  local test problems.
- Debian/Proxmox package upgrades and firewall changes are separate lifecycles; the
  updater does not run them or change firewall rules.

# Proxmox install, VM/LXC bootstrap and runner-built updates

This directory installs **Seizure Diary** on Proxmox VE from a prebuilt GitHub
release. The guided installer defaults to an unprivileged **Debian 12 LXC**; a
dedicated **Debian 12 QEMU VM** is also selectable. The interactive flow asks for
the Proxmox storage ID, template storage, bridge, network and credentials. The
installer validates the collected values only after the prompts, prints the
summary, and asks for a final confirmation before creating anything.

Application builds happen on **GitHub Actions runners**, not on the Proxmox host
or guest. A successful `main` build creates the next `YYYYMMDD.VV` tag and
publishes a checksum-verified deployment bundle as a GitHub Release asset. The
guest downloads that bundle using a repo-scoped, read-only GitHub token.

The app is private, server-backed and not offline-first. The SQLite database is
readable by anyone with guest root or the database backups. HTTPS and file
permissions are not end-to-end encryption.

## Files

| File | Purpose |
|---|---|
| `install.sh` | Proxmox host entry point: guided LXC/VM prompts, storage validation, stages the guest bootstrap |
| `install-guest.sh` | Guest bootstrap: runtime packages, Node LTS, token, release download/extract, systemd |
| `../../scripts/package-installer.mjs` | Builds the single-file `seizure-diary-installer-<tag>.sh` release asset |
| `release.mjs` | GitHub Release resolver/downloader with SHA-256 verification |
| `seizure-diary` | Management command installed at `/usr/local/bin/seizure-diary` |
| `update.sh` | Manual artifact update transaction installed at `/opt/seizure-diary/update.sh` |
| `systemd/seizure-diary.service` | Hardened, non-root service unit |
| `systemd/seizure-diary-backup.service` / `.timer` | Daily encrypted backup job and schedule |
| `seizure-diary.env.example` | Reference environment (installer writes a generated secret) |
| `nginx-private.conf.example` | Private HTTPS reverse-proxy example (LAN/WireGuard only) |

## GitHub Actions release pipeline

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

1. Resolve the next `YYYYMMDD.VV` tag (UTC date, two-digit build number).
2. Typecheck, lint, dependency audit, 116 tests, production build, Docker/Compose
   smoke test and the full browser matrix.
3. On a successful `main` push, create the annotated git tag.
4. Build the deployment bundle inside `node:22.13.1-bookworm-slim` (Debian 12,
   matching the guest), generate the self-contained installer, and publish:
   - `seizure-diary-<tag>.tar.gz`
   - `seizure-diary-<tag>.tar.gz.sha256`
   - `seizure-diary-installer-<tag>.sh`
   - `seizure-diary-installer-<tag>.sh.sha256`
5. Create/update the GitHub Release for that tag.

The bundle contains `dist/`, production `node_modules/`, `package.json`,
`package-lock.json` and `deploy/`. No source repository clone, compiler,
`build-essential`, Git or `npm` build is required on the guest.

## Prerequisites

1. Proxmox VE 8.x host with `pvesm` and either `qm` (VM) or `pct`/`pveam` (LXC).
2. Storage validation is explicit; the installer never assumes IDs:
   - VM: storage with `images` content plus a writable cloud-image cache directory.
   - LXC: storage with `rootdir` and `vztmpl` content. When no Debian 12 template
     is already downloaded, the installer runs `pveam update`, then downloads the
     latest official `debian-12-standard` template. Run `pveam update` manually
     first if the host cannot reach the Proxmox template mirrors.
3. VM only: a static IPv4/prefix + gateway, and an SSH private key readable by the
   host installer. Its public key is injected through cloud-init.
4. Outbound HTTPS from the guest to GitHub (release API/assets) and
   nodejs.org (pinned Node LTS tarball).
5. For a private repository, a **read-only GitHub token**:
   - Prefer a fine-grained token scoped to this repository with **Contents: read**.
   - The guided installer offers a hidden paste prompt and saves it on the host as
     `/root/seizure-diary-github-token` with mode 0600, or you can pass `--token-file`.
   - The guest stores it at `/etc/seizure-diary/github-token` as `0400 root`.
   - Rotate/revoke it if the guest is compromised. Do not commit tokens or put
     them in command lines, URLs or logs.

## Step 1 — copy/paste installer (recommended)

Open the private GitHub Release page and copy
`seizure-diary-installer-<tag>.sh` into a root-owned file on the Proxmox host:

```sh
nano /root/seizure-diary-install.sh
sudo bash /root/seizure-diary-install.sh
```

The script asks for LXC (default) or VM, the Proxmox **storage ID**, template
storage, bridge, network, release version and token. It verifies its embedded
scripts before running. To use the multi-file source instead, copy the whole
`deploy/proxmox/` directory to the host and run `install.sh` with flags;
`install.sh` needs `install-guest.sh` and `release.mjs` in the same directory.
Copying only `install.sh` fails with “guest installer not found or not
executable”.

LXC (default in the guided flow):

```sh
sudo ./deploy/proxmox/install.sh \
  --type lxc \
  --ctid 210 \
  --rootfs-storage <rootdir-storage> \
  --template-storage <vztmpl-storage> \
  --bridge vmbr0 \
  --repo kVinB/FPKD \
  --token-file /root/seizure-diary-github-token \
  --yes
```

VM:

```sh
sudo ./deploy/proxmox/install.sh \
  --type vm \
  --ctid 220 \
  --hostname seizure-diary \
  --vm-storage <images-storage> \
  --ssh-private-key /root/.ssh/id_ed25519 \
  --ip 10.20.0.10/24 \
  --gateway 10.20.0.1 \
  --dns 10.20.0.1 \
  --repo kVinB/FPKD \
  --token-file /root/seizure-diary-github-token \
  --yes
```

Use `--dry-run` to validate and print the summary without downloading images,
creating guests or starting anything. For LXC, a dry run does not refresh the
`pveam` index: if no Debian 12 template is downloaded and the index is empty, it
fails with an instruction to run `pveam update` first. The installer never reuses
or destroys a guest ID, and does not modify host packages, firewall, networking,
cluster configuration or reverse proxies. It downloads and SHA-512 verifies the
official Debian 12 genericcloud image for VM installs.

VM bootstrap waits for SSH on the static address and uses `sudo -n` as the
cloud-init user (`debian` by default). The VM is left in place on failure; inspect
its console with `qm terminal <vmid>`.

### Troubleshooting a failed run

- `pveam list` shows only templates already downloaded. With no downloaded
  Debian 12 template, the installer refreshes the index with `pveam update` and
  then runs `pveam download`. If `pveam update` fails, the installer stops with
  an actionable error; run it manually on the host and retry.
- Validation happens after the guided prompts. A failure prints to stderr and
  exits non-zero. The install summary and final confirmation are the only
  go/no-go gate; there is no earlier “Ready” message.
- Capture the full trace when diagnosing a failure:
  `sudo bash -x ./deploy/proxmox/install.sh ... 2>&1 | tee /tmp/install.log`
- The script never destroys a guest or container. If a run fails after creation,
  inspect `pct status <id>` / `qm status <id>` and remove it manually only after
  reviewing the error.

## Step 2 — first admin and configuration

Guest administrator commands:

```sh
# LXC
pct exec 210 -- /usr/local/bin/seizure-diary status
pct exec 210 -- /usr/local/bin/seizure-diary bootstrap-admin --username <admin>

# VM
ssh <vm-user>@10.20.0.10 'sudo /usr/local/bin/seizure-diary status'
ssh <vm-user>@10.20.0.10 'sudo /usr/local/bin/seizure-diary bootstrap-admin --username <admin>'
```

`bootstrap-admin` refuses an already provisioned database and uses hidden
password input (or `--password-stdin` for automation). No default password or
public bootstrap endpoint exists.

Edit `/etc/seizure-diary/seizure-diary.env`:

- `PUBLIC_ORIGIN=https://diary.home.arpa` (exact browser origin, no slash)
- `BACKUP_ENCRYPTION_KEY` — base64 for 32 bytes, e.g. `openssl rand -base64 32`
- Keep `HOST=127.0.0.1`; publish only through the private proxy.

Then `systemctl restart seizure-diary`.

## Step 3 — private HTTPS ingress

Use `nginx-private.conf.example` or your private reverse proxy:

- Bind only to LAN/WireGuard addresses; enforce firewall/ACL by source.
- Use a certificate trusted by every family device.
- Give family devices individual WireGuard peers scoped to this app; do not grant
  Proxmox management or unrelated service access.
- Do not add public forwarding or a public tunnel.
- Disable proxy caching for `/api/`.

Verify allowed LAN/WireGuard access, blocked external access and persistence
after restart before using real data.

## Management commands

```sh
/usr/local/bin/seizure-diary version
/usr/local/bin/seizure-diary status
/usr/local/bin/seizure-diary update --check
/usr/local/bin/seizure-diary update
/usr/local/bin/seizure-diary update --version 20261124.04
/usr/local/bin/seizure-diary bootstrap-admin --username <admin>
/usr/local/bin/seizure-diary backup --retain 14
/usr/local/bin/seizure-diary verify-backup <file>
/usr/local/bin/seizure-diary restore-backup <file> --force
```

From the Proxmox host for LXC:

```sh
pct exec 210 -- /usr/local/bin/seizure-diary update --check
pct exec 210 -- /usr/local/bin/seizure-diary update
```

Updates and restore need guest root. Backups run as the service user (root
switches to it). The web user never gets the GitHub token or database path.

## Updates and downtime

`seizure-diary update` is manual and serialised with a lock. It:

1. Resolves `latest` (or `--version`) from GitHub, using the read-only token.
2. Refuses downgrades and no-ops when already current.
3. Downloads the bundle, verifies the SHA-256 checksum, extracts it to a new
   release directory and validates required files.
4. Installs the new management scripts/units, stops the service, and makes a
   verified encrypted SQLite snapshot. It aborts before migrations if the backup
   fails and restarts the previous release.
5. Runs versioned migrations, swaps the release symlink atomically, starts the
   service and waits for a bounded `/api/v1/health` check.
6. After migrations start, failures fail closed: the service is left stopped and
   the database is not automatically rolled back. Recovery instructions are
   printed. The previous release and pre-update snapshot are retained.

Downtime is limited to backup, migration and restart. Users see a connection
error during the restart and never a false “saved” confirmation.

Installs created before the runner-built artifact model (source checkout, deploy
key, guest build) do not have `/opt/seizure-diary/tools/release.mjs`. Migrate by
reinstalling into a fresh guest, or install the current release tool and update
script from a reviewed release bundle before running the artifact updater.

Rollback is manual: keep the previous release directory and encrypted snapshot;
restore only with the service stopped and after integrity verification.

## Backup and restore

Generate a backup encryption key once and keep it outside the guest:

```sh
openssl rand -base64 32    # set as BACKUP_ENCRYPTION_KEY in the env file
```

Manual encrypted snapshot:

```sh
/usr/local/bin/seizure-diary backup --retain 14
```

This uses SQLite `VACUUM INTO`, `PRAGMA integrity_check`, AES-256-GCM encryption,
mode `0600`, and retention. It never copies only a live WAL database.

### Daily backup timer

The installer ships `seizure-diary-backup.service` and `.timer`. It enables the
timer only when `BACKUP_ENCRYPTION_KEY` is present; otherwise set the key and
enable it manually:

```sh
systemctl enable --now seizure-diary-backup.timer
systemctl list-timers seizure-diary-backup.timer
systemctl start seizure-diary-backup.service
journalctl -u seizure-diary-backup.service -n 100
```

The timer runs daily at 02:30 with up to 15 minutes of randomised delay and
`Persistent=true`. Move encrypted snapshots to separate protected storage and
test a restore in an isolated guest.

Verify without restoring:

```sh
seizure-diary verify-backup /var/backups/seizure-diary/<file>.enc
```

Restore (service stopped; refuses to overwrite without `--force`):

```sh
systemctl stop seizure-diary
seizure-diary restore-backup /var/backups/seizure-diary/<file>.enc --force
systemctl start seizure-diary
```

Restore verifies the snapshot, replaces the database, removes stale WAL/SHM
sidecars and revokes all sessions.

## What is not covered here

- The VM and LXC installers are covered by mocked `qm`/`pct`/`pveam`/`pvesm`
  tests and shell checks in this workspace, but were **not executed against a
  real Proxmox host**. Real VM boot, cloud-init/SSH, artifact download with a real
  token, LAN/WireGuard ingress and isolated restore remain deployment acceptance
  checks.
- The GitHub Actions release job produced a real bundle and the GitHub API/asset
  download was validated with a repository token. The single-file installer asset is
  built by the release job; interactive storage selection is covered by mocked `whiptail`
  tests. Guest-local `0400` token handling, real VM/LXC boot and LAN/WireGuard ingress
  still need operator acceptance.
- Do not use a privileged container, Docker nesting, public exposure or a
  personal token with broader scope to work around local test problems.
- Debian/Proxmox upgrades and firewall changes are separate lifecycles.

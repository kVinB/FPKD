# Security policy

Seizure Diary is a private, self-hosted family diary. It is **not** a medical device
and makes no clinical validation, regulatory-compliance, end-to-end-encryption or
PDF/UA claims. See the technical specification in this repository for the full threat
model and product boundaries.

## Supported versions

Security fixes are applied to the current `main` branch. There is no public hosted
service and no supported public deployment. Only private LAN/WireGuard ingress behind
HTTPS is in scope.

## Trust boundary

- The SQLite database is on a Proxmox guest. Anyone with guest/host root, a database
  snapshot, or the ability to impersonate the service can read all family diaries.
- HTTPS and filesystem permissions are **not** end-to-end encryption.
- An app administrator can create/reset accounts but cannot read another member's diary
  through the app. An operator who resets a password can sign in as that member; this is
  an explicit trust boundary, not a vulnerability.
- A quiet diary is not evidence of a seizure-free period. The app records self-reported
  entries and does not monitor emergencies or recommend treatment.

## Data handling

- No third-party analytics, remote fonts, telemetry, cloud authentication or external
  PDF services are used.
- Private API responses are `no-store`; the app sets CSP, framing protection and
  `Referrer-Policy: no-referrer`.
- Logs redact cookies, CSRF headers, passwords, session headers and backup bodies.
- Operator backups must be encrypted with `BACKUP_ENCRYPTION_KEY` and stored separately.
  Personal JSON exports are unencrypted by design; downloaded PDFs leave app storage.
- Session tokens are stored only as hashes; passwords use Argon2id; temporary passwords
  are one-time and expire.

## Deployment requirements

- Publish the app only through a private HTTPS reverse proxy reachable from LAN or
  individual WireGuard peers. Enforce firewall/ACL rules; DNS alone is not protection.
- Do not add public port forwarding, public tunnels, shared accounts or public signup.
- Keep `PUBLIC_ORIGIN`, `CSRF_SECRET`, `BACKUP_ENCRYPTION_KEY`, deploy keys and database
  files out of source control and out of the web root.
- Run as the provided unprivileged identities. Do not use privileged LXC or Docker
  nesting.
- Verify an encrypted backup restore in an isolated guest before relying on backups.
- Rotate credentials after suspected compromise, revoke sessions, and treat any leaked
  database snapshot as full disclosure of all diaries.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting / Security Advisory flow for this repository
if available. Otherwise contact the repository owner through an already-trusted private
channel.

Please include:

- affected commit/version and deployment context;
- reproduction steps using **synthetic** data only;
- expected vs observed behavior and impact;
- whether the issue requires host root, a leaked backup, or only a member/admin account.

Do not include real health information, credentials, session tokens, database files or
backup encryption keys in a report. Do not open a public issue containing such data.

## Out of scope

- Attacks requiring guest/host root, physical access, a compromised device/browser,
  or a stolen database/backup.
- Denial of service against the private host.
- Claims that the app should diagnose, predict, monitor or recommend treatment.
- Missing features explicitly out of scope (offline sync, caregiver access, public
  sharing, attachments, medication dosing, automatic report delivery).

# Seizure Diary (FPKD)

[![CI](https://github.com/kVinB/FPKD/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kVinB/FPKD/actions/workflows/ci.yml)

A private, mobile-first family diary for recording self-reported episodes, reviewing
logged frequency, and preparing a readable, selectable-text PDF for a neurology
appointment.

> A record of what you experienced or observed. This app does not diagnose seizures,
> recommend treatment, or monitor emergencies. Charts and reports describe **logged
> events**, not verified seizure counts. A quiet diary is not evidence of a seizure-free
> period.

This is **private, server-backed software**, not offline-first. Diary data lives in
SQLite on a private Proxmox guest; a browser needs a connection to that server to save
or retrieve data. HTTPS, file permissions and encrypted backups are **not end-to-end
encryption**: an authorized host operator can read the database. The app does not claim
clinical validation, end-to-end encryption, PDF/UA conformance, or regulatory
compliance.

## Stack

- **Web**: Vite, React 18, strict TypeScript, Tailwind CSS, React Router.
- **API**: Fastify 5, one Node.js LTS process serving SPA + `/api/v1` same-origin.
- **Data**: `better-sqlite3` with WAL, `foreign_keys=ON`, `synchronous=FULL`, numbered
  transactional migrations, prepared SQL, per-owner indexes.
- **Domain**: shared strict schemas (Zod), DST-aware `@js-temporal/polyfill` time logic,
  one aggregation module for analytics/table/report, privacy-projected report model.
- **Auth**: Argon2id, opaque server-side sessions (hashed at rest), `__Host-` cookies,
  CSRF, exact-origin checks, login throttling, admin-only provisioning.
- **PDF**: `@react-pdf/renderer` with bundled DejaVu fonts, generated locally in the
  browser only on explicit user action.

```
shared/   types, schemas, time/DST, ranges/buckets, tags, backup, report model
server/   config, SQLite/repositories, auth/admin, HTTP routes, operator CLI
web/      React screens, SVG chart, PDF document/generator
deploy/   Dockerfile, Compose, Proxmox LXC installer/updater, systemd, proxy example
tests/    unit, real SQLite/API integration, Playwright e2e, deploy script checks
```

## Quick start (development, synthetic data only)

Requires Node.js 22.12–22.x (tested on 22.23.5) and npm.

```sh
npm ci
cp .env.example .env          # edit PUBLIC_ORIGIN and set CSRF_SECRET
npm run db:migrate
npm run db:bootstrap-admin -- --username admin   # hidden password prompt
npm run dev                   # API on :3000, Vite on :5173
```

Open `http://localhost:5173`. For a production-like local run:

```sh
npm run build
NODE_ENV=production HOST=127.0.0.1 PORT=3000 \
PUBLIC_ORIGIN=http://localhost:3000 SECURE_COOKIES=false \
SEIZURE_DIARY_DB_PATH=./data/seizure-diary.sqlite3 \
CSRF_SECRET="$(openssl rand -base64 32)" npm start
```

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite + API with proxy |
| `npm run build` | Build SPA and bundle API + CLI |
| `npm start` | Run the production bundle |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run audit` | Dependency audit (fails on high/critical) |
| `node scripts/build-version.mjs` | Print the resolved build tag |
| `npm test` | Unit + real SQLite/API integration + deploy script checks |
| `npm run e2e` | Production build + Playwright (Chromium desktop/mobile, axe) |
| `npm run e2e:all` | Same with Firefox, WebKit, iPhone emulation and 320 px profile |
| `npm run bench` | 10k-event warmed analytics/report-model benchmark |
| `npm run e2e:perf` | 500-entry PDF timing (sets `PERF=1`) |
| `npm run db:migrate` | Apply migrations |
| `npm run db:bootstrap-admin` | Guest-local first admin bootstrap |
| `npm run db:reset-password -- <username>` | Operator recovery |
| `npm run db:backup` | Encrypted consistent snapshot |

### Configuration

See `.env.example`. Key values: `SEIZURE_DIARY_DB_PATH`, `PUBLIC_ORIGIN`,
`HOST`/`PORT`, `SECURE_COOKIES`, `CSRF_SECRET`, `BACKUP_ENCRYPTION_KEY`,
session lifetimes. The server refuses to start a database whose schema is newer than
the application supports.

## Product behavior

- **Journal**: own-diary CRUD. Timestamp is the only required field. Exact,
  approximate and date-only values; DST gaps rejected; repeated wall times require an
  explicit offset. Affected areas are three independent checkboxes (Arms, Legs,
  Speech) plus distinct Not recorded / Unsure / None of these states. Duration,
  possible triggers, aura, rescue use with up to five recorded administrations,
  optional label and notes.
- **Analytics**: day/Monday-week/month buckets in the reporting zone, zero-filled,
  clipped edges marked partial, paginated; one event counts once even with multiple
  areas/tags/administrations; total, days with entries, rescue-used events, median of
  known durations; descriptive per-area and per-trigger/per-aura counts with answered
  totals. Tag counts can sum above the event total and are reported labels, not causes or
  diagnoses. No predictions or causal claims.
- **Reports**: server-authorised, privacy-projected HTML preview frozen with a data
  version, dataset epoch and digest. Name and notes are excluded by default. Download
  verifies freshness before client-side PDF generation. Neutral filename, A4, page
  numbers, continuation labels, bundled fonts, selectable text, zero-event export.
- **Accounts**: no public signup. Admin creates one account per member with a one-time
  temporary password (48 h, single use, restricted 15-minute session), forcing a
  password change. Admin reset requires recent re-authentication; disable/reset revoke
  sessions; enable does not revive them. Admins cannot read another member's diary in
  the app.
- **Backups**: personal versioned JSON (v2; explicit v1 conversion), validated preview,
  digest/epoch-bound confirm-replace, confirmed clear-all, epoch rotation. Operator
  backups use verified encrypted SQLite snapshots.

## Build versions and release tags

Build tags use the UTC date and a two-digit build number: `YYYYMMDD.VV`, for example
`20261124.01`. They are not semantic versions.

- Every successful push to `main` (after the verify and Docker jobs pass) automatically
  creates the next annotated git tag for that UTC date. The first tagged build was
  `20261124.01`; the next same-day build becomes `.02`, and so on.
- Pull-request builds and local development builds are not tagged. PR footers show
  `dev-<short-sha>`; the Vite dev server shows `dev`.
- The resolved tag is embedded at build time by `scripts/build-version.mjs` (or an
  explicit `BUILD_VERSION` override) and displayed in the bottom-right footer on app
  screens.
- Docker accepts `--build-arg BUILD_VERSION=...`; CI passes the resolved tag. A native
  build on a tagged commit uses that tag, otherwise it computes the next one for the date.
- Tags are immutable. Do not move, delete or reuse a tag. CI creates the tag only after
  the build and smoke checks pass; no GitHub Release is created automatically.

## Security and privacy boundary

- Same-origin SPA + API, no CORS credentials, no third-party analytics, fonts or PDF
  services. Restrictive CSP, `Referrer-Policy: no-referrer`, framing protection,
  `Cache-Control: no-store` for API/private responses.
- Server-side owner scope is built only from the authenticated principal; client owner
  IDs are never accepted. Every event/tag/settings/analytics/report/backup query is
  owner-scoped, including for admins.
- Login and state-changing requests require CSRF tokens and an allowed exact origin;
  login is throttled by account and source IP; logs redact cookies, CSRF headers,
  passwords and backup bodies.
- The host operator (guest root, database backups) can read all diaries and could
  impersonate an account after a password reset. App-level separation does not protect
  against host compromise.

## CI and verified results

GitHub Actions (`.github/workflows/ci.yml`) runs:

- **verify**: `npm ci`, dependency audit, typecheck, lint, 110 unit/integration/deploy
  tests, production build, then Playwright on desktop Chromium/Firefox/WebKit, Pixel-7 and iPhone-13
  emulation, and a 320×568 Chromium profile; axe on core screens; PDF text and rendered
  page checks.
- **docker**: non-root image build, Compose health/smoke test, private API `401` check,
  and teardown. Docker is verified in CI only (the local workspace has no Docker).
- **Benchmark** (manual `workflow_dispatch`): 10,000-event analytics and 500-entry PDF
  timing.

Project policies are in [`SECURITY.md`](./SECURITY.md) and [`AGENTS.md`](./AGENTS.md).
Current evidence is recorded in [`docs/verification-report.md`](./docs/verification-report.md).
Manual checks that cannot be automated are tracked in
[`docs/manual-acceptance.md`](./docs/manual-acceptance.md) (real iPhone Safari, screen
reader/zoom, human PDF visual review, Proxmox/LAN/WireGuard, backup/restore drill).

Actual commands run in this workspace and outcomes:

```sh
npm run audit                                  # 0 vulnerabilities
npm run typecheck                              # passed
npm run lint                                   # passed
npm test                                       # 110 passed
npm run build                                  # passed (SPA + API/CLI bundles)
npm run e2e                                    # 7 passed, 5 skipped (Chromium)
E2E_BROWSERS=all PDF_RENDER=1 npm run e2e      # 20 passed, 16 skipped (per-project gating)
npm run bench                                  # 10k events: p95 468.1 ms query+aggregate
PERF=1 npm run e2e:perf                        # 500-entry PDF: 7.9 s, 23 pages
```

Benchmark numbers are from one warmed run on this machine, not a universal claim. The
10,000-event 90-day query+aggregation p95 was **468.1 ms** (target 500 ms); report-model
construction p95 was **2,009.7 ms**; the 500-entry PDF met the 10 s target at **7.9 s**
after compacting the PDF event layout.

The browser suite boots the production bundle against a temp SQLite database and covers
desktop and mobile layouts across Chromium, Firefox and WebKit (iPhone-13 emulation, not a
real device):

- admin login → create member → one-time temporary password → forced password change;
- log event with Arms+Speech, estimated duration, trigger, rescue use, label/notes;
- reload persistence, detail view, edit;
- analytics chart/table, plus descriptive trigger/aura tag counts with answered totals;
- report preview with name/notes off, PDF download, **extracted PDF text** asserted for
  affected areas/label and asserted absent for notes/name;
- admin's own journal remains empty (app-level isolation);
- no cross-origin network requests;
- offline/connection-loss draft retention and retry without duplicates across all
  browser/viewport profiles;
- injected SQLite insert/update failures return `503`, roll back partial tags and
  preserve the prior revision;
- operator CLI encrypted backup → verify → restore round-trip, including session
  revocation and retention;
- mocked Proxmox `pct`/`pveam`/`pvesm` installer paths: dry-run makes no changes, existing
  CTIDs are refused, ambiguous storage/bridge/static-IP input is rejected, and no
  `pct destroy` is issued;
- mocked updater transaction paths: no-change, divergent history, staging build failure,
  backup failure rollback/restart, migration fail-closed, post-start health failure
  stopping the service, and lock contention;
- multipage PDF (40 events, long notes) with searchable text, continuation labels and
  page numbers, plus rendered-page PNGs and blank-page guards when `PDF_RENDER=1`;
- 320 px layout with no horizontal page scroll and ≥44 px interactive controls;
- axe (WCAG 2.2 A/AA tags) on login, journal, new event, analytics, reports, settings and
  admin accounts at desktop/mobile/320 px widths, with no serious/critical violations.

### Acceptance-test coverage (A01–A15)

| ID | Status | Evidence |
|---|---|---|
| A01 | Verified | Integration save/reload/restart; e2e save/reload at 320, 412 and desktop widths; no horizontal overflow. |
| A02 | Verified | Unit all 7 area combos; integration full round-trip, stale edit/delete conflict, invalid values; e2e journal/detail/PDF. |
| A03 | Verified | Unit + integration gap rejection, repeated-offset instants one hour apart, date-only fixed, timed midnight bucket change. |
| A04 | Verified | Integration boundary events, zero buckets, clipped weeks, multi-tag event counted once, chart/table/report totals agree. |
| A05 | Verified | Unit/integration distinct statuses, Used-without-details, median denominator excluding unknown/blank, report rendering. |
| A06 | Verified | Integration privacy projection and stale-preview `409`; e2e PDF text excludes name/notes by default. |
| A07 | Verified | Integration export/import round-trip, malformed/unsupported/duplicate/stale rejection, v1 conversion, clear-all. |
| A08 | Verified | Service restart persistence, plus Playwright connection-loss draft retention and retry without duplicates across Chromium/Firefox/WebKit mobile/desktop/320 px. |
| A09 | Verified | Stable-ID retry, concurrent double submit, revision/epoch conflicts, plus injected SQLite insert/update failures returning `503` with rollback and prior revision preserved. |
| A10 | Verified | Headers/CSP/no-store, CSRF, origin, hostile text and no third-party requests verified in Chromium, Firefox and WebKit; production build under test. |
| A11 | Partially verified | Axe reports no serious/critical WCAG 2.2 A/AA violations on 7 screens across 6 browser/viewport profiles. **No manual VoiceOver/NVDA or zoomed-layout pass.** |
| A12 | Partially verified | Text extracted from single/multipage PDFs; continuation labels/page numbers and rendered-page blank/clip guards verified. **Human visual sign-off remains.** |
| A13 | Verified | CLI-only bootstrap (second attempt refused), admin provisioning, one-time/expiring temp password, restricted session, reset/disable/enable revocation. |
| A14 | Verified | Two members + admin: direct access, queries, analytics, reports, export and restore stay owner-scoped; restore/clear do not touch others. |
| A15 | Not verified | Requires real Proxmox, LAN/WireGuard and external network checks; not available here. |

## Proxmox runbook (native unprivileged Debian LXC)

Full details: [`deploy/proxmox/README.md`](./deploy/proxmox/README.md).

1. **Persistent storage**: provision a dedicated LXC/VM with guest-local disk; never put
   SQLite on SMB/NFS. The service uses `/var/lib/seizure-diary` and
   `/var/backups/seizure-diary`; releases live under `/opt/seizure-diary`.
2. **Install**: on the Proxmox host, review this repo, then run
   `sudo ./deploy/proxmox/install.sh --dry-run ...` followed by the real command. The
   installer validates storage/bridge/CTID, creates an unprivileged guest, installs
   Debian packages (including Git), verified Node LTS, builds and starts systemd.
3. **Private repo access**: the guest prints a read-only Ed25519 public deploy key and
   pauses. Add it in GitHub → Settings → Deploy keys, then resume with the printed
   `pct exec ... --resume` command. The private key never leaves the deploy identity.
4. **Bootstrap**: run `pct exec <CTID> -- /usr/local/bin/seizure-diary bootstrap-admin
   --username <admin>` (hidden prompt, no default credentials).
5. **Private HTTPS**: terminate TLS in a LAN/WireGuard-only reverse proxy with a trusted
   certificate; keep `HOST=127.0.0.1`; set `PUBLIC_ORIGIN`; enforce firewall/ACL by
   source, not DNS alone.
6. **Member provisioning**: admin signs in → Accounts → Add account. Share the shown
   username and temporary password privately (password-manager share preferred); it is
   shown once and expires after 48 h. The member sets a permanent password before diary
   access.
7. **Password reset**: admin re-authenticates, then resets. All sessions are revoked and
   a new one-time temporary password is shown. Give it privately; advise members to
   keep their own exports. As a last resort the operator can run
   `seizure-diary reset-password <username>` from the guest console.
8. **Backups**: set `BACKUP_ENCRYPTION_KEY`, then enable the installed daily timer with
   `systemctl enable --now seizure-diary-backup.timer` and run
   `seizure-diary backup --retain 14` once manually. Check
   `systemctl list-timers`/`journalctl -u seizure-diary-backup.service`, verify with
   `verify-backup`, move encrypted files to separate storage, and test a restore in an
   isolated guest. Personal JSON exports are not encrypted.
9. **Restore**: `systemctl stop seizure-diary`; `seizure-diary restore-backup <file>
   --force`; verify integrity; start the service. Restored sessions are revoked.
10. **Upgrades/rollback**: `seizure-diary update --check`, then `seizure-diary update`.
    It builds/tests in staging, takes a verified encrypted backup, migrates, swaps the
    release atomically and health-checks. After migrations start, failures fail closed
    (service stopped, no silent DB rollback). The previous release and snapshot are
    retained for documented manual rollback.

### Docker VM alternative

A non-root multi-stage `Dockerfile`, `deploy/docker-compose.yml` (persistent `/data`,
loopback-only bind, read-only root, dropped capabilities, health check) and
`deploy/.env.example` are provided for a dedicated Debian VM. CI builds the image and
runs a Compose health/smoke test; the local workspace has no Docker, so local execution
remains unverified. Do not use Docker nesting in LXC; use the native LXC path or a VM.

## Known limitations / unverified environments

- Real Proxmox `pct`/`pveam` provisioning, LAN/WireGuard ingress, external blocking,
  and isolated-restore acceptance were **not** run (no Proxmox/network access here).
- Docker is built/smoke-tested in CI only; local Docker execution is unverified.
- Real iPhone Safari and real devices are not verified; WebKit coverage is emulation.
- A11 has automated axe coverage but still lacks the manual screen-reader/zoom pass in
  [`docs/manual-acceptance.md`](./docs/manual-acceptance.md).
- A12 has automated text/pagination/rendered-page checks; human visual sign-off remains
  (checklist included).
- Performance numbers are from this workspace (10k p95 468.1 ms; 500-entry PDF 7.9 s)
  and are not universal.
- No clinical validation, E2EE, PDF/UA conformance, or regulatory compliance is claimed.

## Repository status

P0 implementation plus CI hardening and the P1 descriptive breakdown: auth/admin, diary
CRUD with affected areas, analytics with per-area and per-trigger/per-aura counts,
privacy-controlled PDF, personal backup/restore/clear, operator tooling with a daily
encrypted backup timer, cross-browser tests, 320 px layout checks, automated accessibility,
PDF render guards, performance benchmarks and a manual acceptance checklist. Tag counts are reported labels only, with no causal or diagnostic inference,
and can sum above the logged-event total. Do not deploy with real health data until the
remaining deployment (A15) and manual accessibility/visual checks are completed.

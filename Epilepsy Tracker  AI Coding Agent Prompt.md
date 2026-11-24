# Epilepsy Tracker: AI Coding Agent Prompt

Copy the block below into your coding agent and provide the companion `Epilepsy-Tracker-Technical-Specification.md` (v2.0) in its workspace. The specification controls field semantics, wireframes, API contracts, deployment, and acceptance tests.

```text
You are the lead engineer for Seizure Diary, a private family web app on
Proxmox. Build, run and verify it using synthetic data. Implement
Epilepsy-Tracker-Technical-Specification.md v2.0 and satisfy A01–A15.
If the companion spec is missing or an older version, request v2.0 before
implementing details that depend on it.

STACK AND BOUNDARIES
- Inspect the repo, its instructions and package manager. Preserve unrelated
  work. In an empty repo use Vite/React, strict TypeScript and Tailwind for
  the UI; supported Node.js LTS, Fastify and a maintained SQLite driver for
  the backend. Pin compatible dependencies, a maintained SQLite build and
  a DST-aware time library. Use SVG frequency charts and @react-pdf/renderer
  with bundled fonts. Check current official package docs before configuring.
- SQLite on the Proxmox guest is the sole persistent diary data store. Serve
  SPA and /api/v1 same-origin behind private HTTPS. Do not add IndexedDB,
  persistent browser health-data caches, service workers, offline sync, cloud
  authentication, public registration, or a separate mobile backend.
- Build Login, Change Password, Journal, New/Edit/Detail, Analytics, Reports,
  Settings and admin-only Accounts. Use desktop and mobile wireframes, not mock
  data in live screens. Do not deploy to the user's server, publish, push
  externally or use real health data without separate user instructions.

DELIVERY ORDER
1. Build the SQLite data layer with prepared SQL, foreign keys, WAL on
   guest-local disk, migrations, transactions, per-owner indexes, revision
   checks, an epoch for restore/reset and a report data version. Authentication
   sets server-side owner scope; never accept owner IDs from the client.
   Include guest-local first-admin bootstrap and operator recovery commands
   using hidden password input, no default credentials.
2. Implement admin-only member creation: admin enters a username and optional
   display label; server generates a distinct temporary password, returns it
   for one-time display and private manual sharing, and stores only a hash.
   Force a password change before diary access. Enforce expiry, single use,
   restricted first-login session, and session rotation/revocation on
   password change, reset and disable. No public signup or email reset.
   Provide admin reset, disable and enable controls, with recent
   re-authentication for resets. Admins can use their own diary but not
   read any other member's diary in the app. Follow the spec for Argon2id,
   secure cookies, session lifetimes, CSRF, rate limits, logging redaction
   and no-store responses. Test the API, not just hidden UI controls.
3. Ship own-diary CRUD. Timestamp is the only required field; use exact,
   approximate and date-only values and validate time zone, DST gaps and
   repeated offsets. Place “What was affected?” after the timestamp:
   independent large Arms, Legs and Speech checkboxes (any combination),
   plus distinct Not recorded, Unsure and None of these states. Include areas
   in journal, detail and PDF. Also implement duration, possible triggers,
   aura, rescue use and recorded administration details, optional label and
   notes. Validate server-side. Save only after commit; use a stable event ID
   for retries. If disconnected, keep a dirty form only in memory and show
   that nothing was saved; clear private state on logout or auth loss.
4. Build owner-scoped day/week/month frequency charts and accessible data
   tables. Use one range selector for analytics and reports; match the spec
   for time zones, date-only assignment, zero buckets and partial periods.
   One episode counts once even with multiple affected areas. Use “logged
   events”; no predictions, causal claims, dosing or clinical interpretation.
5. Build HTML report preview and genuine selectable-text A4 PDF download.
   Authorize and version-check the frozen report model before the browser
   creates the PDF. Exclude name and notes by default, include affected areas,
   and honor privacy controls in the data returned by the server. Use a neutral
   filename, pagination, bundled fonts and no third-party PDF service. Revoke
   object URLs when no longer needed and never cache reports.
6. Add per-user versioned JSON export, validated preview and confirm-replace
   restore, and confirmed personal clear-all. No account/session data in these
   exports, no owner in import payloads, no access to other diaries. Use
   a separate operator-only consistent SQLite backup/restore workflow with
   encryption, retention, verification and revocation of restored sessions.
7. Package a non-root Docker image and Compose service for a Debian VM on
   Proxmox. Persist /data on the guest filesystem. Document optional native
   install on unprivileged Debian LXC with systemd, app-aware backups, recovery,
   upgrade and rollback. Provide a non-secret env sample and private HTTPS
   ingress instructions for LAN or individual WireGuard peers with private
   DNS and firewall/ACL enforcement. If a public reverse proxy already
   exists, document how to keep this app on an isolated private listener/host
   or how to enforce the private boundary; do not assume DNS alone protects it.

TEST AND DOCUMENT
- Add unit, real SQLite/API integration and production-build browser tests.
  Map them to A01–A15. Verify first-admin bootstrap, rejected public/member
  provisioning, one-time temporary credentials, session invalidation,
  cross-account and admin isolation, CSRF, malformed backups and rollback,
  DST/range math, affected-area combinations, retry without duplicates, and
  a service restart with a retained volume. Use two synthetic members and
  a synthetic admin for isolation checks across diary, tags, analytics,
  reports, exports, restore, and clear-all.
- Check desktop and mobile layouts, keyboard, error messages and touch
  targets. Extract PDF text and visually inspect multiple pages. Run lint,
  typecheck, unit/integration tests, production build and Playwright. Check
  current Chromium, Firefox and WebKit where available; distinguish iPhone
  emulation from real-device testing. Verify an isolated backup restore,
  and mark LAN/VPN/external ingress checks requiring the user's network as
  deployment acceptance checks if unavailable in your workspace.
- README must include setup/run/test commands and a numbered Proxmox runbook:
  persistent storage, installation, backup, bootstrap, private HTTPS access,
  member provisioning, safe credential handoff, password reset, restore and
  upgrades. Explain this is private server-backed, not offline-first; a host
  operator can read the DB. Do not claim clinical validation, end-to-end
  encryption, PDF/UA conformance, or regulatory compliance.

DEFINITION OF DONE
- P0 features work end to end, documented commands run, and no unrelated
  files or secrets are committed. Implement P1 only after P0 passes.
- Report feature/file changes, exact commands and actual outcomes, A01–A15
  coverage, and unverified environments or release blockers. Never claim
  tests passed unless run. If blocked, finish independent slices and state
  the smallest concrete blocker.
```

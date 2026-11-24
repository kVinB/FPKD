# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Seizure Diary (FPKD) is a private, server-backed family diary for self-reported episodes,
logged-event analytics and a privacy-controlled PDF. React/Vite web app, Fastify API,
SQLite on a private Proxmox guest. Read the v2.0 specification and
`docs/manual-acceptance.md` before changing behavior.

## Non-negotiable boundaries

- Use **synthetic data only**. Never use real health data in development, tests or logs.
- Do not deploy to a live server, push, publish, create releases, or make Proxmox/GitHub
  changes unless the user explicitly asks.
- Keep SQLite on guest-local disk as the sole persistent diary store. Do not add
  IndexedDB, service workers, offline sync, persistent browser health caches, cloud
  authentication, public signup, shared accounts or caregiver access.
- No third-party analytics, remote fonts, external PDF/document services or telemetry.
- Server-side owner scope comes only from the authenticated principal. Never accept an
  owner ID from the client; admins must not read other members' diaries through the app.
- Charts/reports say “logged events”, never verified seizure counts. No predictions,
  causal claims, dosing guidance or clinical interpretation.
- Do not claim clinical validation, E2EE, PDF/UA conformance or regulatory compliance.

## Commands

```sh
npm ci
npm run audit
npm run typecheck
npm run lint
npm test                 # unit + real SQLite/API integration + deploy checks
npm run build            # SPA + API/CLI bundles
npm run e2e              # production build, Chromium desktop/mobile, axe
npm run e2e:all          # Chromium/Firefox/WebKit, mobile/320 profiles
npm run bench            # 10k-event analytics benchmark
npm run e2e:perf         # 500-entry PDF timing
```

Set `E2E_BROWSERS=all` and `PDF_RENDER=1` for the full browser/PDF matrix. CI runs those
plus a non-root Docker/Compose smoke job. Install browsers with
`npx playwright install --with-deps chromium firefox webkit`; PDF rendering needs
`poppler-utils`.

Local first admin: `npm run db:bootstrap-admin -- --username <name>` (hidden password).
Dev server: `npm run dev`. Production-like local run is documented in README.

## Architecture map

```
shared/   types, Zod schemas, Temporal time/DST, ranges/buckets, tags, backup, report
server/   config, SQLite migrations/repositories, auth/admin, routes, operator CLI
web/      React screens, API client/auth, SVG chart, PDF document/generator
deploy/   Docker/Compose, Proxmox host/guest installer, updater, systemd units
tests/    unit, SQLite/API integration, Playwright e2e, fixtures, deploy checks
docs/     manual acceptance checklist
```

Key server rules: prepared SQL; FKs/WAL/synchronous=FULL; numbered transactional
migrations that fail closed; revision checks, dataset epoch and data version; stable-ID
retry idempotency; CSRF + exact-origin checks; no-store private responses. Key time rules:
DST gaps rejected, repeated wall times need explicit offsets, date-only events keep their
recorded date, reporting-zone grouping for timed events.

## Testing expectations

Every behavior change needs a test mapped to A01–A15 where applicable. Use real SQLite
and HTTP injection for API/ownership/session/restore/revision behavior; Playwright on the
production build for browser journeys, axe and PDF checks. Do not claim tests passed
unless run. Record actual outcomes and unverified environments.

## Git/PR workflow

- Inspect status/diff first; preserve unrelated work; never commit secrets.
- Use a focused feature branch and PR into `main`; wait for CI to pass.
- Do not merge, tag or release without explicit instruction.
- Keep Proxmox/LAN/WireGuard, real-device, screen-reader and human PDF visual checks marked
  unverified until performed on the required environment.

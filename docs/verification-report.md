# Verification report

Base commit under test: **`6e665c6`** (dependency audit, 2026-11-24).
Synthetic data only. This report records commands and observed outcomes; it is not a
clinical, security-certification or performance guarantee.

> Snapshot note: build-version footer and automatic `YYYYMMDD.VV` tagging were added
> after this snapshot (see README "Build versions and release tags"). The local suite
> after that change is 110 tests; the evidence below remains the recorded
> benchmark/browser snapshot for the listed commit.

## Environment

| Item | Value |
|---|---|
| Workspace | Linux container, Node.js 22.23.5, npm 10.9.9 |
| Database | Real SQLite via `better-sqlite3` (temp files), migrations v1 |
| Browsers | Playwright 1.65.1: Chromium, Firefox, WebKit, Pixel-7/iPhone-13 emulation, 320×568 profile |
| PDF checks | `pdf-parse` text extraction, `pdftoppm` rendered-page guards |
| Docker | Not installed locally; verified in GitHub Actions |
| Proxmox | Not available in this workspace |

## Automated results

| Check | Command / run | Outcome |
|---|---|---|
| Dependency audit | `npm run audit` | 0 vulnerabilities |
| Types | `npm run typecheck` | pass |
| Lint | `npm run lint` | pass |
| Tests | `npm test` | 106 passed (53 unit, 35 integration, 18 deploy) |
| Build | `npm run build` | pass (Vite SPA + esbuild API/CLI) |
| Full browser matrix | `E2E_BROWSERS=all PDF_RENDER=1 npm run e2e` | 20 passed, 16 skipped (per-project gating) |
| Local benchmark | `npm run bench` | 10k events: p95 468.1 ms query+aggregate; report model p95 2,009.7 ms |
| Local PDF timing | `PERF=1 npm run e2e:perf` | 500-entry PDF 7.9 s, 23 pages |
| CI PR #8 verify | GitHub Actions run 45422674263 | pass, 5m56s |
| CI PR #8 Docker/Compose | GitHub Actions run 45422674263 | pass, 53s |
| CI main post-merge | GitHub Actions run 45424476655 | both jobs pass |
| CI benchmark workflow | GitHub Actions run 45424500999 | pass, 2m25s |

CI benchmark observed on the hosted runner:

- 10k-event 90-day query+aggregate: p50 **403.0 ms**, p95 **454.2 ms**, max 513.6 ms
- Report model: p50 **1,819.6 ms**, p95 **1,890.9 ms**
- 500-entry PDF: **8,195 ms**, 23 pages, 141 KiB

The 500 ms p95 and 10 s PDF targets were met in both recorded environments. Treat these
as observed numbers on these machines, not universal guarantees.

## A01–A15 coverage

| ID | Status | Primary evidence |
|---|---|---|
| A01 | Verified | Minimal save/reload/restart; 320/412/desktop journeys; no horizontal overflow. |
| A02 | Verified | All 7 area combinations, full round-trip, stale edit/delete conflict, journal/detail/PDF. |
| A03 | Verified | DST gap rejection, repeated-offset selection one hour apart, date-only fixed, timed bucket change. |
| A04 | Verified | Inclusive range boundaries, zero buckets, clipped weeks, one count per event, chart/table/report agreement. |
| A05 | Verified | Distinct Not recorded/Unsure/None/Used-without-details, median denominator, PDF/detail rendering. |
| A06 | Verified | Privacy projection, stale preview `409`, PDF text excludes name/notes by default. |
| A07 | Verified | Export/import, malformed/unsupported/duplicate/stale rejection, v1 conversion, clear-all. |
| A08 | Verified | Service restart persistence, connection-loss draft retention and retry without duplicates. |
| A09 | Verified | Stable-ID retry, concurrent double submit, revision/epoch conflicts, injected SQLite failures with rollback. |
| A10 | Verified | CSP/no-store, CSRF, exact origin, hostile text, no third-party requests across three engines. |
| A11 | Partially verified | Axe WCAG 2.2 A/AA on 7 screens/6 profiles; manual screen-reader and zoom pass outstanding. |
| A12 | Partially verified | Multipage text/pagination and rendered-page guards; human visual sign-off outstanding. |
| A13 | Verified | CLI-only bootstrap, one-time/expiring temp passwords, restricted session, reset/disable/enable revocation. |
| A14 | Verified | Two members + admin isolated across events, analytics, reports, export, restore and clear. |
| A15 | Not verified | Requires real Proxmox, LAN/WireGuard, external-blocking and isolated restore checks. |

## Unverified / required before real data

- Real Proxmox `pct`/`pveam` installation, deploy-key pause/resume and updater on a
  disposable guest.
- LAN/WireGuard access allowed, external client blocked, restart persistence, encrypted
  backup restore in an isolated guest.
- Real iPhone Safari (WebKit tests are emulation), manual VoiceOver/NVDA and 200% zoom,
  human multi-page PDF visual inspection.
- Deployment staging with real reverse proxy/TLS and firewall ACLs.

Use [`manual-acceptance.md`](./manual-acceptance.md) to record those checks with
synthetic data, tester, device and date.

## Reproduce locally

```sh
npm ci
npm run audit
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install --with-deps chromium firefox webkit
E2E_BROWSERS=all PDF_RENDER=1 npm run e2e
npm run bench
PERF=1 npm run e2e:perf
```

`PDF_RENDER=1` requires `poppler-utils`. Docker and Proxmox checks are intentionally not
claimed here; see the CI workflow and `deploy/proxmox/README.md`.

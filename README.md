# Seizure Diary (FPKD)

A private, mobile-first family diary for recording self-reported episodes, reviewing logged frequency, and preparing a readable PDF for a neurology appointment.

> A record of what you experienced or observed. This app does not diagnose seizures, recommend treatment, or monitor emergencies. Charts and reports describe **logged events**, not verified seizure counts.

This is a **private, server-backed** app, not offline-first. Diary data lives in SQLite on a private Proxmox guest; the browser needs a connection to that private server to save or retrieve data. Storage permissions and HTTPS are **not** end-to-end encryption: an authorized host operator can read the database.

## Status

Repository bootstrap. The application is not implemented yet. Specifications and delivery plan are committed first.

## Documentation

- [`Epilepsy Tracker  AI Coding Agent Prompt.md`](./Epilepsy%20Tracker%20%20AI%20Coding%20Agent%20Prompt.md) — build order, boundaries, definition of done.
- [`Epilepsy Tracker  Technical Specification.md`](./Epilepsy%20Tracker%20%20Technical%20Specification.md) — v2.0 field semantics, wireframes, API contracts, deployment, acceptance tests A01–A15.
- [`Epilepsy Tracker  Proxmox Installer and Updater Agent Prompt.md`](./Epilepsy%20Tracker%20%20Proxmox%20Installer%20and%20Updater%20Agent%20Prompt.md) — native Debian LXC installer/updater requirements.

## Planned layout

```
web/     Vite + React + strict TypeScript + Tailwind (SPA)
server/  Fastify + better-sqlite3: HTTP, auth, sessions, migrations
shared/  Schemas, validators, DST/range/bucket and report model
deploy/  Dockerfile, Compose, Proxmox installer and updater
tests/   Unit, SQLite/API integration, Playwright e2e, synthetic fixtures
```

Planned stack: Vite, React, strict TypeScript, Tailwind, Fastify, `better-sqlite3`, `@js-temporal/polyfill`, `@react-pdf/renderer`, Argon2id, Playwright. Dependencies are pinned when the application is scaffolded.

## Scope boundary

P0: own-diary CRUD with affected areas, analytics, privacy-controlled PDF, admin-only account provisioning, personal backup/restore/clear, and operator site backups. P1 (per-area/per-tag breakdown) ships only after P0 passes.

Out of scope: offline sync, shared accounts, caregiver/public access, detection, emergency notification, clinical interpretation, dosing guidance, automatic report delivery, attachments, routine medication tracking.

## Safety and privacy claims

The project does not claim clinical validation, end-to-end encryption, PDF/UA conformance, or regulatory compliance. See the technical specification for the full trust boundary and deployment runbook requirements.

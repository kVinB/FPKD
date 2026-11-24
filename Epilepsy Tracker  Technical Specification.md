# Epilepsy Tracker: Technical Specification

Version 2.0 · Private family deployment on Proxmox · Working title: Seizure Diary

Build a private, mobile-first family diary for recording self-reported episodes, reviewing logged frequency, and preparing a readable PDF for a neurology appointment. React and Tailwind run in the browser; a Node.js API stores data in SQLite on a private Proxmox guest. Each family member has their own account and diary; the same account can be used across devices on the LAN or over WireGuard. This is self-hosted, not offline-first: the browser needs a connection to the private server to save or retrieve diary data.

## Product goals and scope

Epilepsy Action recommends bringing a diary with details such as timing, duration, possible triggers, aura and recovery to appointments ([Epilepsy Action appointment guidance](https://www.epilepsy.org.uk/living/self-advocacy/10-ways-to-prepare-for-appointments)). The Epilepsy Society’s diary also provides space for emergency medication use and frequency summaries ([Epilepsy Society seizure diary](https://epilepsysociety.org.uk/sites/default/files/2025-09/SeizurediaryA4Sept2025.pdf)).

| Priority | User need | Product requirement |
|---|---|---|
| P0 | As a person logging after an event, I want to save quickly even if details are incomplete. | Create, inspect, edit and delete events; select any combination of Arms, Legs and Speech; support uncertain or unknown details without guessing. |
| P0 | As a person reviewing my diary, I want to see how many events I recorded over time. | Filter by reporting dates and show day, week and month counts alongside a data table. |
| P0 | As a person preparing for an appointment, I want to choose exactly what my neurologist sees. | Preview and download a date-scoped PDF with explicit privacy options. |
| P0 | As the family admin, I want to decide who can sign in. | No public signup; admin creates one account per member and privately passes on temporary credentials. Admin can reset access or disable an account, but cannot browse other members’ diaries in the app. |
| P0 | As a returning user, I want my diary to work from my own devices and remain recoverable. | Server-backed CRUD, versioned personal JSON backup/restore, personal clear-all, and encrypted site backups managed by the server operator. |
| P1 | As a person reviewing patterns, I want a descriptive breakdown. | Per-area and optional per-tag counts; no causal or diagnostic inference. |
| Out of scope | Avoid adding clinical, sharing or offline-sync complexity. | No offline database/sync, shared accounts, caregiver access, public access, detection, live seizure timing, emergency notification, clinical interpretation, medication dosing guidance, or automatic report delivery. No attachments or routine medication regimen tracking. |

Use first-run language such as “A record of what you experienced or observed. This app does not diagnose seizures, recommend treatment, or monitor emergencies.” Charts and reports say **logged events**, not verified seizure counts. A quiet diary is not evidence of a seizure-free period. Do not treat aura tags as diagnoses or infer cause from co-occurrence; the app records what the person reports. The MVP records one event per entry, including suspected events; an aura is an attribute of an entry, not a second automatically generated event.

Target outcomes for pre-release testing: at least 9 of 10 representative participants complete a basic entry unassisted on a phone within 30 seconds after a short orientation; at least 9 of 10 generate the requested date-range PDF with notes off. Time and observe these in consented sessions using synthetic data rather than adding production analytics. Compare against each participant’s current logging workflow where possible. Before broader distribution, have a clinician review sample reports for clarity and have the product owner review privacy and any jurisdiction-specific obligations; neither review blocks developing with synthetic data.

## Architecture and implementation contracts

| Layer | Recommendation |
|---|---|
| Web UI | Vite, React, TypeScript in strict mode, Tailwind CSS, accessible native form controls and an SPA router. Keep form draft state separate from persisted state; use mobile-first responsive variants ([React state guidance](https://react.dev/learn/managing-state), [Tailwind responsive design](https://tailwindcss.com/docs/responsive-design)). |
| Domain | Pure TypeScript validators, time-zone conversion, range selection, bucketing and report model. Use a pinned, DST-aware time library such as the Temporal polyfill; do not parse a wall-clock date/time through host-local `Date` defaults. |
| Private backend | One supported Node.js LTS process, Fastify API and a pinned SQLite driver such as `better-sqlite3`; serve the SPA and `/api/v1` from one origin. Use shared TypeScript schemas with authoritative server validation. |
| Transport | HTTPS via a private reverse proxy; cookie-based sessions. No browser database, background sync, service worker or persistent client cache for diary data in v2. Keep an unsaved form in memory on a connection error and allow manual retry. |
| Analytics | Render a responsive static SVG bar chart from the domain bucket model, plus visible totals and a semantic data table. A custom chart is sufficient; no remote dashboard service. |
| PDF | Generate a genuine text-based PDF Blob locally with `@react-pdf/renderer` and bundled fonts; handle wrapping/page numbering explicitly ([React-pdf advanced rendering docs](https://react-pdf.org/advanced)). Keep report model independent of the renderer. |
| Hosting | Docker Compose in a dedicated Debian VM on Proxmox is the default; optionally install natively with `systemd` in an unprivileged Debian LXC. Use persistent guest-local SQLite storage and a LAN/WireGuard-only ingress. |

Suggested layout: `web/` for React screens, `server/` for HTTP/auth/SQLite/migrations, `shared/` for schemas and deterministic domain/report logic, `deploy/` for Compose and native service guidance, and `tests/fixtures/` for synthetic data. Routes: `/login`, `/change-password`, `/journal`, `/events/new`, `/events/:id`, `/events/:id/edit`, `/analytics`, `/reports`, `/settings`, `/admin/accounts`. `/` redirects based on session state; new/edit share one form. Missing or inaccessible records show the same back-to-journal state. Keep patient names, notes, filters and other health details out of URLs.

```text
LAN / WireGuard browser -> private HTTPS reverse proxy -> Node API + React assets
                                                           |
                                      auth -> scoped repository -> SQLite
                                                           |
                                        authorized response -> chart / PDF
Guest operator -> verified SQLite snapshot -> encrypted separate storage
```

### SQLite data and consistency

| Table | Keys and fields |
|---|---|
| `users` | UUID, unique normalized username (ASCII lowercase, 3–32 characters, letters/digits/`.`/`_`/`-`), display label, `member` or `admin` role, `active` or `disabled` status, password hash, `must_change_password`, optional temporary-password expiry, timestamps. |
| `sessions` | Hash of opaque session token, user FK, created/last-seen/expiry timestamps. Index user FK and expiry; purge expired sessions. |
| `diary_settings` | User FK as key, `report_zone`, Monday week start, random `dataset_epoch` and incrementing `data_version` for report invalidation. |
| `events` | Composite key `(owner_id, event_id)`; owner FK and index `(owner_id, capture_date, event_id)`; original date/time/zone/offset/instant, precision, timestamps, revision, and validated JSON for detailed form answers. |
| `tags` | Composite key `(owner_id, tag_id)`, owner FK, kind, display label and normalized label; unique `(owner_id, kind, normalized_label)`. Built-ins seeded per user; store label snapshots in events. |
| `account_audit` | Timestamp, actor ID, target ID, action and outcome for account creation, reset, disable and re-enable; no diary data, passwords, tokens, or full request payloads. |

Use prepared SQL, `PRAGMA foreign_keys=ON` per connection, WAL, a short busy timeout and `synchronous=FULL` as the durability default. Pin a maintained SQLite build with the WAL fixes noted in the [SQLite WAL documentation](https://sqlite.org/wal.html), and keep the database and companion files on the same guest-local filesystem, not an SMB/NFS share. Use numbered transactional migrations and verify the persisted data across restarts; fail startup on an incompatible schema rather than resetting it. Normalize tags with NFKC, trim, collapse whitespace and lowercase. Save custom tags and their event in one transaction; validate references within the same owner.

Construct a repository scope only from the authenticated principal. Every diary query, even for an app admin, uses that scope for events, tags, settings, analytics and exports. Never accept an owner ID from the client. Generate a stable proposed UUID per create; retry uncertain commits with the same ID and payload, returning the original only when they match within the owner scope. Same-timestamp episodes can be separate. For writes, check owner, expected event revision where applicable, and expected dataset epoch inside the transaction; a stale edit/restore/reset returns `409` without dropping the draft. Confirm save only after commit. Increment data version on changes affecting the report and check it before generating a PDF from an existing preview.

### Authentication and admin workflow

1. **Bootstrap:** Create the first admin from a guest-local CLI with a hidden password prompt, no default password or public bootstrap endpoint. The command refuses to bootstrap an already provisioned database. Document a separate local recovery/reset command for the operator; protect it with OS access.
2. **Create:** Admin opens Accounts, enters a username and optional display label, and creates a member account. The server generates a unique high-entropy temporary password, displays it once along with the username, and only stores a hash. Default validity: 48 hours. The admin shares the username and temporary password privately, preferably via a password-manager share or another trusted channel. Do not email credentials automatically or expose them in URLs, logs or account lists. If lost, generate a new one rather than retrieving it.
3. **First sign-in / reset:** A temporary password can open only a restricted session to set a permanent password or sign out; consume the temporary credential on first successful login in a single transaction. Give the restricted session up to 15 minutes; if lost or expired, the admin issues a new temporary password. After change, rotate the session and invalidate old sessions. The app admin cannot view a member’s chosen password. Admin password resets are privileged: require recent re-authentication and advise members to keep their own exports. There is no self-service signup or email reset; accounts use unique credentials, not one family login.
4. **Manage:** Admin sees username/display label, role and account status only, with actions to reset, disable or re-enable member accounts. Disable and reset revoke all sessions immediately; re-enabling does not revive them. Member management cannot target admins. An admin can also keep a private diary under their own account. App-level separation does not protect against someone with Proxmox/guest root access, a database backup, or an operator impersonating an account after a password reset; make this trust boundary explicit.

Use Argon2id via a maintained library with at least 19 MiB memory, two iterations and parallelism one, adjusted upward after measuring; never store plain passwords ([OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). Accept 15–128 characters, allow paste/password managers, and do not silently trim passwords. Use cryptographically random opaque session IDs, store only their digests, and send a host-only `__Host-` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain`; default to 30 minutes idle / 12 hours absolute with documented configurability. Rotate on login/password change, revoke on logout/disable/reset, and clear in-memory diary and report data on logout or authorization loss ([OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)). Apply rate limits by account and source IP, generic login errors, request size limits, exact same-origin validation and authenticated CSRF tokens on state-changing requests, including protections for login and logout. Trust proxy headers only from the configured proxy. No CORS credentials or third-party analytics.

### HTTP contract

All paths below are under `/api/v1`. Use JSON unless downloading/importing a backup; return safe structured errors with field IDs. Auth and private data responses use `Cache-Control: no-store`; downloads are user-initiated. Unauthenticated `401`, wrong role `403`, missing or not-owned event `404`, stale or conflicting write `409`, invalid input `422`, throttled `429`, and transient storage unavailable `503` with safe retry handling.

| Endpoint family | Operations and scope |
|---|---|
| `/auth` | `POST /login`, `GET /session`, `POST /change-password`, `POST /reauthenticate`, `POST /logout`, and a non-cacheable CSRF bootstrap endpoint. Re-authenticate with the current password to permit privileged reset actions for five minutes in that session. |
| `/events`, `/events/:id`, `/tags`, `/settings` | Authenticated own-diary collection/detail CRUD, own tag suggestions and own preferences. Search/range filters use a JSON `POST /events/query` rather than URLs. |
| `/analytics/query`, `/reports/preview`, `/reports/validate` | Authenticated read operations using validated ranges; common server selector. Preview returns only the privacy-projected report model and the owner's data version; validate the version before client PDF creation. |
| `/diary/backup`, `/diary/restore/preview`, `/diary/restore`, `/diary/clear` | Authenticated personal export, validate restore, confirm replace, and clear; revalidate on apply and bind destructive actions to the current dataset state. No account credentials or data from any other owner. |
| `/admin/accounts` | Admin-only list and create; POST actions for `/:id/reset-password`, `/:id/disable`, `/:id/enable`. Do not expose any diary fields or counts through these routes. |

## Data model and form specification

All explicit statuses below are stored, validated and rendered consistently. “Not recorded” means the person left the field unanswered; “Unknown” means they explicitly chose that they were unsure; “None reported” or “Not used” is an explicit negative. An empty array on its own is not an explicit negative.

```ts
type PlainDateString = string; // YYYY-MM-DD; validate as a real Gregorian date
type InstantString = string;   // ISO 8601 UTC, ending in Z; canonicalize
type TagRef = { id: string; label: string };
type TagAnswer =
  | { status: 'not_recorded' | 'unknown' | 'none_reported' }
  | { status: 'reported'; tags: TagRef[] };
type AffectedArea = 'arms' | 'legs' | 'speech';
type AffectedAreas =
  | { status: 'not_recorded' | 'unknown' | 'none_reported' }
  | { status: 'reported'; areas: AffectedArea[] }; // 1–3 distinct values
type EventTime =
  | { precision: 'date_only'; captureDate: PlainDateString; zone: string }
  | { precision: 'exact' | 'approximate'; captureDate: PlainDateString;
      wallTime: string; zone: string; offset: string; instantUtc: InstantString };
type Duration =
  | { status: 'not_recorded' | 'unknown' }
  | { status: 'exact' | 'estimated'; seconds: number };
type Administration = {
  id: string; name?: string; doseAsReported?: string;
  timingAsReported?: string; // e.g. “about 2 minutes after start”
};
type Rescue =
  | { status: 'not_recorded' | 'unknown' | 'not_used' }
  | { status: 'used'; administrations: Administration[] };
interface SeizureEvent {
  id: string;
  captureDate: PlainDateString; // indexed; must equal occurredAt.captureDate
  occurredAt: EventTime;
  duration: Duration;
  affectedAreas: AffectedAreas;
  triggers: TagAnswer;
  aura: TagAnswer;
  rescue: Rescue;
  eventLabel?: string; // user's description, not a clinical classification
  notes?: string;
  createdAt: InstantString;
  updatedAt: InstantString;
  revision: number; // starts at 1
}
```

| Input | UI and rules |
|---|---|
| Timestamp (only required input) | Prefill current date and time in the device’s detected IANA time zone, visibly editable. Provide separate date and time inputs and precision choices “Exact”, “Approximate”, and “Date only”. Precision initially reads “Approximate” for a prefill. Show the selected zone and let the user change it for travel or retrospective entry. Precision `date_only` clears time and does not fabricate midnight. Use the server clock for validation: reject a future date in its capture zone and timed entries more than five minutes ahead as an input guard, not a clinical threshold. |
| What was affected? | Immediately below the timestamp, show three large independent checkboxes styled as chips: **Arms**, **Legs**, **Speech**. Any combination is valid; none is preselected. Offer “Unsure” and “None of these” as mutually exclusive alternatives to selections. Clearing the last choice means Not recorded. Optional notes can capture side or what changed in speech. Preserve selections on edit; show them in journal, detail, and PDF. Reject duplicate or unknown values and incompatible answers on the server. This records observations, not a clinical classification. |
| Duration | Optional minute/second inputs (seconds component 0–59); label “Exact”, “Estimated”, or “Unknown”. Default to Not recorded; entering a value defaults to Estimated unless changed. Validate whole total seconds from 1 to 86,400 as an app input bound, not a clinical cutoff. Blank is not zero. |
| Possible triggers | Label “Possible triggers”; search and toggle suggestion chips, add a custom label, or choose “None reported” / “Unsure”. Seed examples such as poor sleep, stress, illness and missed medication, without suggesting causality ([Epilepsy Foundation trigger guidance](https://www.epilepsy.com/manage/managing-triggers)). Up to 12 distinct tags of 1–40 Unicode code points; selecting a tag sets Reported; removing the final tag returns to Not recorded. |
| Aura / warning | Same status and tag rules. Include a few examples, such as unusual smell, déjà vu, visual changes and tingling, with custom entries. Use descriptions, not a diagnosis or inferred seizure type. |
| Rescue medication | Radio group: “Not recorded”, “Not used”, “Used”, “Unsure”, default Not recorded. For Used, optionally add up to five administrations; each row requires at least one detail, with optional recorded name (80 characters), dose as reported (60) and timing as reported (80). `used` with `[]` is valid and displayed as “Used; details not recorded”. No suggested drugs, doses, units, calculations or instructions. Switching away from Used excludes administration details; confirm before discarding filled rows. |
| More details | Optional user-defined event label (60 characters) and plain-text notes (2,000 characters); suggested note prompts: what happened, recovery, or observations. Render and export text as text, never as HTML. |

Trim free text at save and apply consistent size limits to imports. Preserve form input on validation, quota or transaction errors; move focus to an error summary linked to fields, and provide retry. Cancel confirms if edited. When creating, Save returns to journal with the new entry highlighted or linked; on edit, Save returns to detail. Confirm deletion with the relevant event date/time and clear action wording. No background autofill of medical details.

### Time and range rules

- **Entry display:** Keep the original local wall time, zone, offset, UTC instant and precision. Show time with an approximate marker where appropriate; display “Time not recorded” for date-only entries. A timed entry’s instant and stored original zone must reproduce its wall time, date and offset. A DST gap is an invalid wall time and must be corrected by the user; a repeated wall time requires explicit selection between the two offsets before save or import validation accepts it.
- **Reporting zone:** Default to the device zone at setup; change through Settings (with visible zone in Analytics and Reports). Timed events are grouped by their local date in that zone. Date-only events are always assigned to their recorded calendar date and never shifted. Include events by inclusive report calendar dates; for ordinary timed boundaries this includes the start of the first day and excludes the start of the day after the last. Implement matching by computed calendar date to handle skipped or irregular local dates. Candidate retrieval can query capture dates broadened by two calendar days on either side, then apply exact domain filtering. Default ranges are 30 and 90 calendar dates ending today in the report zone. Reject reversed/future ranges and cap custom analytics/report ranges at five calendar years.
- **Display and order:** In journal and report, group by report date, with timed events ordered by UTC instant and date-only events after timed events on their assigned date. Journal uses newest date first and newest timed first; report uses oldest date first and earliest timed first. Break ties by UUID. Row/detail display shows the recorded time and zone; where the reporting date differs, show both rather than silently rewriting a record. Journal defaults to latest entries across all dates, paginated 25 per page; apply the same domain date logic when filtering. Include a visible active-filter reset and a distinct no-matches state.

## Screen flows and wireframes

Layouts below are low-fidelity and describe hierarchy, not fixed component width. Use a light slate background, dark high-contrast body text, one restrained teal action colour and consistent spacing; quiet visual states and clear labels take priority over decorative effects.

### Desktop: navigation, dashboard and quick entry

```text
+----------------------------------------------------------------------------------+
| Seizure Diary                                               [Account / Sign out] |
+-----------------+----------------------------------------------------------------+
| Journal         | Analytics                                     [+ Log event]   |
| Analytics *     | [Last 30 days v] [Week v]   Reporting zone: Europe/Dublin       |
| Reports         |                                                                |
| Settings        | [Logged events: 8]  [Days with entries: 5]  [Rescue used: 2]    |
| Accounts (admin)|                                                                |
|                 |                                                                |
|                 | Logged events by week                                         |
|                 | 4 |          [##]                                              |
|                 | 2 | [##]     [##]             [##]                             |
|                 | 0 +------------------------------------                        |
|                 |       2 Nov    9 Nov    16 Nov    23 Nov                        |
|                 | [View data table]                            [Prepare report] |
+-----------------+----------------------------------------------------------------+

+----------------------------------------------------------------------------------+
| Journal > New event                                                              |
| Date [24 Nov 2026]     Time [14:30]       Precision [Approximate v]               |
| Entry time zone [Europe/Dublin v]                                                |
| What was affected? [x] Arms [ ] Legs [x] Speech  [Unsure] [None of these]         |
| Duration [min] [sec] [Estimated v]                                                |
| Possible triggers [ + Add ] [Poor sleep x]    Aura / warning [ + Add ]            |
| Rescue medication ( ) Not recorded  ( ) Not used  ( ) Used  ( ) Unsure            |
|   If Used: [ + Add administration ]                                             |
| [More details v]                                               [Cancel] [Save] |
+----------------------------------------------------------------------------------+
```

Desktop Journal shows date/time and zone, affected areas, duration, event label and rescue status in a compact table, with row links opening detail. Desktop Reports uses controls beside an HTML report preview. Admin Accounts shows member rows and an Add account action; the create dialog shows temporary credentials once with explicit copy and dismiss actions. On mobile, put Accounts under More for admins and stack each member’s actions below their name and status. Login is centered on desktop and single-column on mobile, with no signup link. Temporary-password login goes directly to Change Password, not to the diary.

### Mobile: journal, entry and report

```text
+-------------------------+   +-------------------------+   +-------------------------+
| Seizure Diary           |   | < Journal     Log event |   | Reports                 |
| Private server          |   | Date [24 Nov 2026]       |   | [30 days v] [Custom]     |
| [ + Log event ]         |   | Time [14:30]             |   | Europe/Dublin            |
| [ Date range v ]        |   | [Approximate v]          |   | [ ] Include name        |
|                         |   | Europe/Dublin [Change]  |   | [ ] Include notes       |
| 24 Nov                  |   | What was affected?      |   | [ Generate preview ]     |
| Arms, Speech            |   | [x] Arms [ ] Legs       |   |                         |
|                         |   | [x] Speech   [Unsure]  |   |                         |
|                         |   | [None of these]        |   |                         |
|                         |   | Duration [min] [sec]    |   |                         |
| 14:30 approx.      >    |   | [Estimated / Unknown]   |   | 8 logged events         |
| 1m 25s | Rescue used    |   | Triggers [ + Add ]      |   | Preview cards / summary |
|                         |   | Aura [ + Add ]          |   | PDF may contain private |
| 19 Nov                  |   | Rescue medication [v]   |   | health information.     |
| Time not recorded  >    |   | [More details v]        |   | [ Download PDF ]         |
|                         |   |                         |   |                         |
| Journal Charts PDF More |   | [Cancel]        [Save]  |   | Journal Charts PDF More |
+-------------------------+   +-------------------------+   +-------------------------+
```

On mobile Charts, stack the date and granularity controls above scroll-free metric cards and the chart; place the accessible data table below. The mobile form gets the full page and hides bottom navigation while editing. Its action bar accounts for safe areas and must not hide keyboard-focused inputs or errors; allow it to become inline if space is constrained. Journal cards and report preview reflow at 320 CSS px and with zoom; use a stacked row layout instead of page-level horizontal scrolling.

### Admin account setup

```text
Desktop: Accounts                         Mobile: More > Accounts
+------------------------------------+    +---------------------------+
| Family accounts    [+ Add account] |    | Accounts   [+ Add account]|
| Username    Status     Actions    |    | sample-member             |
| sample      Active     [Manage v] |    | Active            [Manage]|
+------------------------------------+    +---------------------------+
Create -> Enter username / optional label -> Create member
       -> Username + one-time temporary password [Copy] [Done]
       -> Member signs in -> Set permanent password -> Own journal
```

### Accessibility and state handling

Target WCAG 2.2 AA using the [W3C WCAG 2.2 recommendation](https://www.w3.org/TR/WCAG22/). Product requirements: 44 × 44 CSS px touch targets for main interactions, visible and unobscured focus, explicit field labels, radio fieldsets/legends, no colour-only meaning, no flashing or decorative motion, and reduced-motion support. Inline status and save feedback use a polite live region; errors identify and link to invalid fields. Dialogs handle focus trapping and restoration; keyboard and screen reader users can add/remove tags and use chart data without hovering. Keep instructions short and put optional notes after core data entry.

Distinguish first use, zero matches, loading, expired session, server unreachable, and save failure. On connection failure keep the form in memory and show “Not saved. Connect to your home network or WireGuard and retry.” Page reload, logout or authorization loss clears that input. Do not treat an API failure as an empty diary, claim a write before commit, or replay another account’s edits later.

## Analytics and report rules

### Dashboard

- **Frequency chart:** Vertical bars showing integer counts of logged events per calendar day, Monday-start week, or month in the report zone. Fill in zero buckets across the selected range and mark clipped edge buckets as partial in labels/table. No smoothing or comparison against clinical thresholds. With zero matches, show a plain explanation and let the table show zeros; do not claim “no seizures.” For mobile or long ranges, paginate buckets (up to 12 on mobile and 24 on desktop) without dropping data or changing KPI totals; screen readers can use a paginated table with matching buckets.
- **Summary:** Total logged events; distinct report dates with entries; events marked rescue used (count events, not administrations); median of known duration values, showing the count of recorded durations and noting estimates are included. For an even sample use the arithmetic mean of the two central values; show half-seconds if present. No known durations displays “Not enough data.”
- **Consistency:** One owner-scoped selector and one aggregation module serve the chart, table and report. Every entry contributes once to frequency even when it has multiple affected areas, tags or administrations. Optional P1 area counts count one event once per selected area and can sum above the event total; state that and show how many entries recorded an area answer. Do not add risk scores, forecasts or causal interpretations.

### Neurologist PDF

1. Choose dates and preview the exact included dataset in accessible HTML. Include patient name only if explicitly opted in and entered for this report; leave notes off by default. Preview clearly indicates whether name and notes are included; rescue medication and its recorded details are part of the standard report and are disclosed before download. Show an event count, reporting zone, and a warning that exports may contain sensitive health information.
2. Freeze a user-scoped report model at preview generation and require an authorized freshness check before download. A changed diary or report control invalidates the preview. Generate the PDF in the browser, only on user action. Permit an explicit zero-event export that states “No events logged in this period.” Never email, upload or automatically share the file.
3. Output A4 portrait, print-friendly monochrome-compatible styling, clear dates, page numbers, date range, reporting zone, generation timestamp and compact summary. Follow with chronological events: report date, original time/zone as needed, precision, optional label, duration, **Affected areas** (e.g. “Arms, Speech”), triggers, aura, and rescue use/details. Show “Not recorded”, “Unsure” and “None of these” distinctly when applicable. Include notes only when opted in. State “Patient-entered diary; totals reflect logged entries only.” Use running labels on continuation pages and never silently truncate content.
4. Render selectable/searchable text with bundled fonts, consistent line breaks and page margins. Test long notes, accents and supported Unicode scripts; if text cannot be safely rendered, fail visibly and let the person revise or omit optional fields rather than silently corrupting the report. Verify no clipping/overlap and no missing/duplicated events on multipage output. Do not claim PDF/UA conformance; HTML preview is the accessible on-screen equivalent.
5. Use a neutral filename such as `seizure-diary_2026-11-01_2026-11-30.pdf`, never patient name. Keep preview/report Blob in memory, revoke object URLs after use and do not persist generated artifacts in browser storage. Advise that downloaded copies leave the app’s storage and deleting diary data does not delete them.

## Privacy, backup and deployment

- **Data boundary:** Display “Saved to your family’s private server.” No external telemetry, fonts, analytics or document processing. Use a dedicated origin, restrictive CSP, `Referrer-Policy: no-referrer`, framing protection and no request bodies, health details, credential values or session headers in logs. Disable reverse-proxy caching for private responses. Storage permissions and HTTPS are not end-to-end encryption: the SQLite database is readable by authorized host operators. Maintain encrypted backups and consider encrypted guest storage where appropriate.
- **Personal JSON vs. PDF:** JSON is restorable; a PDF is a shareable report. Use `{ format: "seizure-diary", formatVersion: 2, exportedAt, settings, tags, events }`. Snapshot in one scoped read transaction. Omit accounts, owner IDs, passwords, sessions, report-only names and security settings. Warn that downloaded JSON is unencrypted. A user-selected restore file is sent only to the private server over HTTPS. Cap at 25 MiB, validate schema/versions/references/lengths/time precision/duplicates on the server, and accept earlier v1 only through explicit conversion with missing areas mapped to Not recorded. No browser data is migrated automatically. Show counts and optional previous backup before a confirmed atomic replace of only the signed-in user's diary. Bind confirmation to the file digest and current dataset/data version, revalidate on apply and rotate the epoch after restore. Never label an oversized export restorable.
- **Personal clear-all:** Require deliberate confirmation, offer backup, clear only the current account’s events, custom tags and diary settings, and rotate the dataset epoch. Reseed built-in tags, clear report/draft state and do not affect the account or anyone else’s diary. Older server backups or downloaded exports may still contain removed data.
- **Site backup:** Run an operator-only guest job using the [SQLite Online Backup API](https://sqlite.org/backup.html) or `VACUUM INTO` into a staging location. Do not copy only the open database file under WAL. Encrypt before moving to separate storage, apply retention (starting target: daily backups, 14 daily copies), monitor failures, and verify a restore in an isolated guest. Host snapshots can supplement but do not replace this workflow. Document stopping the app, validating the snapshot and matching app version, staging rollback, replacing the DB without stale WAL/SHM sidecars, revoking all restored sessions and invalidating pre-restore temporary credentials before serving traffic. A site backup contains all members’ diary data and password hashes and is never downloadable by an app admin.

### Proxmox deployment runbook requirements

1. Provision a dedicated Debian VM and run a production Docker Compose service there. Start with 1 vCPU, 1–2 GiB RAM and a persistent disk sized for retention; measure before resizing. Run as an unprivileged service user, mount a writable guest-local directory at `/data`, and configure the database as `/data/seizure-diary.sqlite3`. Put persistent files outside the image and web root; restrict directory/file permissions. Use a health check exposing no application data. Document optional native `systemd` installation in an unprivileged LXC using the [Proxmox container documentation](https://pve.proxmox.com/pve-docs/chapter-pct.html); do not require privileged LXC or Docker nesting.
2. Publish the backend only to the private reverse proxy. Use internal DNS and a stable HTTPS hostname; if using Nginx Proxy Manager, keep this proxy host reachable only from LAN/WireGuard, or use a private-only proxy listener if the existing one is public. Use client-trusted TLS (e.g. DNS-validated certificate or a private CA trusted by every device). Protect ingress with a firewall or ACL, not just private DNS. Give family devices individual VPN peers scoped to this app; do not grant access to Proxmox management or unrelated services. No public forwarding or tunnel for the web app.
3. Deliver a Dockerfile, Compose file, non-secret environment sample, proxy/firewall setup notes, migration workflow, bootstrap/recovery CLI and documented backup/restore commands. Include pre-update backup and rollback instructions. Before using real data, verify login and persistence after service restart, allowed LAN/VPN access, blocked access from outside the VPN, and a successful restore. Use synthetic fixtures only in test/dev paths.

## Delivery and acceptance tests

Build in this order: (1) SQLite, sessions and admin provisioning; (2) scoped journal CRUD and affected areas; (3) analytics; (4) report preview and PDF; (5) backups, Proxmox packaging, privacy and accessibility verification. Ship P0 before P1. On a documented environment, target a warmed 90-day query and aggregation within 500 ms at p95 over 30 runs against 10,000 synthetic events, and a 500-entry PDF without long notes within 10 seconds. Record observed numbers rather than claiming universal performance.

| ID | Given / When / Then |
|---|---|
| A01 | Given a fresh diary on a 320–390 px viewport, when a user saves the visible prefilled timestamp and leaves details blank, then one event is saved with unanswered statuses, shown immediately and still present after reload. |
| A02 | Given a fully populated event with Arms and Speech, exact duration, multiple tags, and two rescue entries, then all fields round-trip after edit and appear in journal/detail/PDF. All seven nonempty area combinations save; unset, unsure and none remain distinct. Duplicate/unknown values fail server validation. Cancelled deletion leaves the event intact. |
| A03 | Given DST in `Europe/Dublin`, when `2026-03-29 01:30` is entered it is rejected; when `2026-10-25 01:30` is entered it requires offset selection, and the two allowed choices produce instants exactly one hour apart. A date-only event stays on its entered date after changing report zone; a timed event near midnight can change report bucket. |
| A04 | Given fixtures at both ends of a one-day report and one just outside, when the range is opened, then only in-range items are shown. Given zero buckets, a clipped week and multi-tag events, chart, table and PDF totals agree without counting a tagged event twice. |
| A05 | Given Not recorded, Unknown, None/Not used and Used-without-details samples, when rendered in detail and PDF, then all states remain distinct. Known-duration median excludes blank and unknown durations and uses the right denominator. |
| A06 | Given a preview with name and notes off, then the authorized PDF matches the date range, counts, affected areas and privacy projection. Changing inclusion or diary data invalidates the preview. No PDF or health data is sent to a third party. |
| A07 | Given valid, malformed, oversized, unsupported-version and duplicate-ID backups, when tested, then only the valid confirmed file replaces data. Cancel and simulated failed restore leave the prior diary unchanged. Export and re-import a valid fixture without changing event content. |
| A08 | Given a dirty form and loss of LAN/VPN connectivity, then no save is claimed and in-memory fields remain. Reconnect and retry without duplication. Restart the service with its persistent volume and verify that member data and area selections remain. |
| A09 | Given an injected SQLite write error, double submit, or two editors with the same revision, then the draft survives transient failure, duplicate taps create one event, and stale edits cannot overwrite newer data. Reset/restore invalidates stale forms without touching another member. |
| A10 | Given hostile text or a cross-origin mutation, then text renders inertly and the request cannot change data without valid origin and CSRF checks. Private responses are not cached and a production network trace has no third-party requests. |
| A11 | Given keyboard-only and screen reader use at mobile and desktop widths, when navigating menus, error summaries, tag controls and chart data, then focus order is logical and no content is inaccessible behind sticky controls. No critical automated accessibility violations; manually test keyboard, VoiceOver or equivalent and at least one zoomed layout. |
| A12 | Given long notes, accented text and enough entries for several pages, when PDF text is extracted and pages are visually reviewed, then included text remains searchable, each event appears exactly once, page numbers and continuation labels appear, and there is no clipping. |
| A13 | Given a fresh installation, a member and an admin, only the guest CLI can bootstrap the first admin and only an admin can provision members. No signup exists; a temporary password is shown once, expires and grants only password change; reuse fails. Reset and disable revoke active sessions; re-enable does not restore them. |
| A14 | Given two members and an admin, attempts to read, modify, count, export or restore another user’s records fail or stay scoped to the signed-in user. Direct event requests for another user return the same not-found result as absent records. No bypass through report or backup APIs. |
| A15 | Given the packaged Proxmox deployment with synthetic data, LAN and authorized WireGuard clients can sign in, a non-VPN external client cannot reach the app, and an isolated SQLite backup restore recovers all diaries without reviving old sessions. |

Use unit tests for validators, DST/range/median logic and report privacy projection; real SQLite and HTTP integration tests for migrations, accounts, sessions, ownership, atomic restore and revision/epoch; Playwright on a production build for mobile and desktop journeys. Cover Chromium, Firefox and WebKit where feasible; manually check iPhone Safari PDF download and WireGuard access before claiming support. Explicitly track unverified environments.

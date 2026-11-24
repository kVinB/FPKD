# Manual acceptance checklist

Use **synthetic data only**. Do not enter real health information until the deployment,
privacy and accessibility checks below are signed off by the appropriate people.

Record the commit under test, tester, device/OS/browser, date and observations. A checked
box without reproducible steps is not acceptance evidence. Automated coverage lives in
`tests/` and CI; this file covers what automation cannot prove.

## Record

| Field | Value |
|---|---|
| Commit / release | |
| Tester(s) | |
| Date | |
| Proxmox host / guest | |
| Browser / device / OS | |
| Screen reader / zoom tooling | |

## 1. Real iPhone Safari (not emulation)

- [ ] Open the private HTTPS hostname over LAN, and again over WireGuard.
- [ ] Sign in; verify the page is usable at default zoom and landscape.
- [ ] Create an event with Arms + Speech, estimated duration, a trigger, rescue use,
      label and notes; save; reload and confirm it persists.
- [ ] Toggle Airplane Mode / leave WireGuard, tap Save, and confirm the app says
      “Not saved…”, keeps the draft, and does not claim success.
- [ ] Reconnect and retry; confirm exactly one event exists.
- [ ] Open Reports, leave name and notes off, generate the preview, download the PDF,
      open it in Safari/Files, and confirm text is selectable and pages are not clipped.
- [ ] Confirm downloaded files leave app storage (deleting diary data does not delete
      already-downloaded copies).

Notes / screenshots:

## 2. Keyboard and screen reader (A11)

Test with VoiceOver (Safari/iOS or macOS), NVDA (Firefox/Chrome) or an equivalent.

- [ ] Login: labels announced, invalid credentials announced, focus moves to the error
      summary, then to the password field.
- [ ] Journal: navigation order is logical; filters have labels; entry links announce
      date/time and open the detail.
- [ ] Event form: “What was affected?” is a fieldset with Arms/Legs/Speech checkboxes;
      Unsure/None of these are distinct; each tag add/remove is operable without hover.
- [ ] Validation: submitting an invalid duration/date focuses the summary; summary links
      move focus to the field; errors are announced politely.
- [ ] Charts: KPI totals are reachable; the data table is exposed with matching buckets;
      scrollable chart region is focusable.
- [ ] Dialogs (admin create/reset, clear-all): focus is trapped, Escape closes, focus is
      restored to the trigger.
- [ ] At 200% browser zoom and at 320 CSS px, no page-level horizontal scrolling is
      required for login, journal, form, analytics, reports, settings or accounts.
- [ ] Keyboard-only: complete an event, cancel with confirmation, and sign out.

Notes:

## 3. PDF visual review (A12)

Generate a report with several pages, long notes, accented text and rescue details.

- [ ] Each event appears exactly once, in chronological order.
- [ ] Page numbers and “Seizure Diary (continued)” appear on continuation pages.
- [ ] No clipped rows, overlapping text, missing fields or blank pages.
- [ ] Affected areas, triggers, aura, duration, rescue and opted-in notes are legible.
- [ ] Name and notes are absent when their privacy options are off.
- [ ] Text is selectable/searchable in a desktop PDF reader.
- [ ] Zero-event export states “No events logged in this period.”
- [ ] The filename is neutral (no patient name).

Attach rendered page images or file to the acceptance record:

## 4. Proxmox, LAN and WireGuard (A15)

Use a disposable Debian VM (default) and/or unprivileged LXC. Do not test against real
family data.

- [ ] GitHub Actions produced a `YYYYMMDD.VV` tag and a release asset
      `seizure-diary-<tag>.tar.gz` with a matching `.sha256`.
- [ ] `install.sh --dry-run --type vm ...` and `--type lxc ...` show the summary and make
      no changes or downloads.
- [ ] Fresh VM install creates the Debian cloud VM, cloud-init/SSH bootstrap succeeds, and
      the guest does not install Git/compiler build prerequisites.
- [ ] Fresh LXC install completes without Docker, nesting or a privileged container.
- [ ] Private-repo token is stored as `0400 root` in the guest; the app service cannot
      read it or the release-asset download credentials.
- [ ] `seizure-diary bootstrap-admin` refuses an already provisioned DB; sign-in succeeds
      over private HTTPS.
- [ ] LAN client can sign in; authorized WireGuard peer can sign in.
- [ ] A client outside LAN/VPN cannot reach the app (firewall/ACL, not just DNS).
- [ ] Restart the guest/service; diary data and Arms/Legs/Speech selections persist.
- [ ] `seizure-diary update --check` reports installed/upstream versions without
      downloading the full artifact.
- [ ] A second runner-built release updates the site, keeps credentials/events/areas, and
      changes the footer build tag to the new release.
- [ ] A deliberately failed artifact download/migration/health check leaves the previous
      release intact or fails closed with the service stopped and exact recovery
      instructions.
- [ ] Daily encrypted backup timer runs; `verify-backup` succeeds.
- [ ] Restore into an isolated guest recovers all diaries without reviving old sessions or
      temporary passwords.

Commands / observations:

## 5. Operator backup and restore drill

- [ ] Set `BACKUP_ENCRYPTION_KEY` (base64, 32 bytes) outside source control.
- [ ] `systemctl enable --now seizure-diary-backup.timer`; confirm it appears in
      `systemctl list-timers`.
- [ ] Run the service manually once and confirm an encrypted file with mode `0600`.
- [ ] Confirm retention keeps the configured count (default 14) and does not delete
      unrelated files.
- [ ] Verify the encrypted snapshot; move a copy to separate protected storage.
- [ ] Stop the service, restore with `restore-backup <file> --force`, verify integrity,
      start the service and sign in again.
- [ ] Confirm old sessions are revoked and downloaded personal exports are unaffected.

Notes:

## Sign-off

| Area | Result | Tester | Date |
|---|---|---|---|
| Real iPhone Safari | | | |
| Screen reader / zoom | | | |
| PDF visual review | | | |
| Proxmox / LAN / WireGuard | | | |
| Backup / restore drill | | | |

Remaining known gaps at last update: A11 manual assistive-technology pass, A12 human PDF
visual sign-off, and A15 real Proxmox/LAN/WireGuard/restore acceptance.

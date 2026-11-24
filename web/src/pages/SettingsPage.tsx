import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DiarySettings } from '@shared/types';
import { api, downloadFile, errorMessage } from '../api';
import { useAuth } from '../auth';
import { fetchSettings, saveReportZone } from '../settingsClient';
import { Modal, Spinner, StatusMessage, ZoneSelect } from '../components/ui';

interface RestorePreview {
  ok: true;
  digest: string;
  counts: {
    events: number;
    tags: number;
    customTags: number;
    dateOnlyEvents: number;
    timedEvents: number;
  };
  convertedFromV1: boolean;
  backup: { reportZone: string; events: number; tags: number };
  current: { dataVersion: number; datasetEpoch: string; reportZone: string };
}

export function SettingsPage(): JSX.Element {
  const { user, csrfToken, logout } = useAuth();
  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [zone, setZone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [exporting, setExporting] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<unknown>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState('');
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<unknown>(null);
  const [offerBackup, setOfferBackup] = useState(true);

  useEffect(() => {
    document.title = 'Settings · Seizure Diary';
  }, []);

  useEffect(() => {
    let active = true;
    fetchSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setZone(loaded.reportZone);
        setLoading(false);
      })
      .catch((caught) => {
        if (active) {
          setError(caught);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const saveZone = async () => {
    if (!csrfToken) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const updated = await saveReportZone(zone, csrfToken);
      setSettings(updated);
      setStatus('Reporting zone saved.');
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const exportBackup = async () => {
    setExporting(true);
    setError(null);
    setStatus(null);
    try {
      const { filename } = await downloadFile(
        '/diary/backup',
        `seizure-diary_backup_${new Date().toISOString().slice(0, 10)}.json`,
      );
      setStatus(
        `Backup downloaded as ${filename}. It is unencrypted: store it privately. Downloaded copies leave the app.`,
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setExporting(false);
    }
  };

  const chooseRestoreFile = async (file: File | undefined) => {
    setRestoreError(null);
    setRestorePreview(null);
    setRestoreBackup(null);
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setRestoreError(new Error('Backup files are capped at 25 MiB.'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setRestoreError(new Error('That file is not valid JSON.'));
      return;
    }
    if (!csrfToken) {
      setRestoreError(new Error('Your session expired. Sign in again.'));
      return;
    }
    try {
      const preview = await api<RestorePreview>('/diary/restore/preview', {
        method: 'POST',
        body: { backup: parsed },
        csrfToken,
      });
      setRestorePreview(preview);
      setRestoreBackup(parsed);
    } catch (caught) {
      setRestoreError(caught);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmRestore = async () => {
    if (!restorePreview || restoreBackup === null || !csrfToken || !settings) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const result = await api<{ events: number; tags: number; dataVersion: number; datasetEpoch: string }>(
        '/diary/restore',
        {
          method: 'POST',
          body: {
            backup: restoreBackup,
            digest: restorePreview.digest,
            expectedDataVersion: restorePreview.current.dataVersion,
            expectedDatasetEpoch: restorePreview.current.datasetEpoch,
          },
          csrfToken,
        },
      );
      const updated: DiarySettings = {
        reportZone: restorePreview.backup.reportZone,
        weekStartsOn: 1,
        datasetEpoch: result.datasetEpoch,
        dataVersion: result.dataVersion,
      };
      setSettings(updated);
      setZone(updated.reportZone);
      setStatus(
        `Restore complete: ${result.events} events and ${result.tags} tags replaced your diary.`,
      );
      setRestorePreview(null);
      setRestoreBackup(null);
    } catch (caught) {
      setRestoreError(caught);
    } finally {
      setRestoreBusy(false);
    }
  };

  const confirmClear = async () => {
    if (!csrfToken || !settings) return;
    if (clearText !== 'CLEAR') return;
    setClearBusy(true);
    setClearError(null);
    try {
      if (offerBackup) {
        const { filename } = await downloadFile(
          '/diary/backup',
          `seizure-diary_backup_${new Date().toISOString().slice(0, 10)}.json`,
        );
        setStatus(`Backup downloaded as ${filename} before clearing.`);
      }
      const result = await api<{ dataVersion: number; datasetEpoch: string }>('/diary/clear', {
        method: 'POST',
        body: {
          confirm: true,
          expectedDataVersion: settings.dataVersion,
          expectedDatasetEpoch: settings.datasetEpoch,
        },
        csrfToken,
      });
      setSettings({
        ...settings,
        dataVersion: result.dataVersion,
        datasetEpoch: result.datasetEpoch,
      });
      setStatus('All diary entries and custom tags for this account were cleared.');
      setClearOpen(false);
      setClearText('');
    } catch (caught) {
      setClearError(caught);
    } finally {
      setClearBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading settings" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="muted">
          Saved to your family’s private server. This is not offline-first, and the server operator
          can read the database; HTTPS and file permissions are not end-to-end encryption.
        </p>
      </div>

      {status ? <StatusMessage tone="success">{status}</StatusMessage> : null}
      {error ? <StatusMessage tone="error">{errorMessage(error)}</StatusMessage> : null}

      <section className="card space-y-3" aria-labelledby="account-heading">
        <h2 id="account-heading" className="text-lg font-semibold">
          Account
        </h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="muted">Username</dt>
            <dd className="font-semibold">{user?.username}</dd>
          </div>
          <div>
            <dt className="muted">Display label</dt>
            <dd>{user?.displayLabel || 'Not set'}</dd>
          </div>
          <div>
            <dt className="muted">Role</dt>
            <dd>{user?.role}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Link to="/change-password" className="btn-secondary">
            Change password
          </Link>
          {user?.role === 'admin' ? (
            <Link to="/admin/accounts" className="btn-secondary">
              Manage family accounts
            </Link>
          ) : null}
          <button type="button" className="btn-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="card space-y-3" aria-labelledby="zone-heading">
        <h2 id="zone-heading" className="text-lg font-semibold">
          Reporting zone
        </h2>
        <p className="muted">
          Timed events are grouped by their local date in this zone. Date-only events keep their
          recorded calendar date.
        </p>
        <ZoneSelect id="settings-zone" value={zone} onChange={setZone} />
        <button
          type="button"
          className="btn-primary"
          onClick={() => void saveZone()}
          disabled={saving || zone === settings?.reportZone}
        >
          {saving ? 'Saving…' : 'Save reporting zone'}
        </button>
        <p className="muted text-xs">
          Data version {settings?.dataVersion ?? '—'} · dataset epoch{' '}
          {settings?.datasetEpoch?.slice(0, 8) ?? '—'}…
        </p>
      </section>

      <section className="card space-y-3" aria-labelledby="backup-heading">
        <h2 id="backup-heading" className="text-lg font-semibold">
          Personal backup and restore
        </h2>
        <p className="muted">
          JSON is restorable; a PDF is a shareable report. Backups contain only your diary, settings
          and tags — never accounts, passwords or sessions. Downloaded JSON is unencrypted.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => void exportBackup()} disabled={exporting}>
            {exporting ? 'Preparing download…' : 'Download JSON backup'}
          </button>
        </div>
        <div>
          <label htmlFor="restore-file" className="field-label">
            Choose a backup to preview
          </label>
          <input
            ref={fileRef}
            id="restore-file"
            type="file"
            accept="application/json,.json"
            className="block w-full text-sm"
            onChange={(event) => void chooseRestoreFile(event.target.files?.[0])}
          />
        </div>
        {restoreError ? (
          <StatusMessage tone="error">{errorMessage(restoreError)}</StatusMessage>
        ) : null}
        {restorePreview ? (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-semibold">Confirm replace?</p>
            <p>
              {restorePreview.counts.events} events ({restorePreview.counts.timedEvents} timed,{' '}
              {restorePreview.counts.dateOnlyEvents} date-only), {restorePreview.counts.tags} tags (
              {restorePreview.counts.customTags} custom). Reporting zone in the file:{' '}
              {restorePreview.backup.reportZone}.
            </p>
            {restorePreview.convertedFromV1 ? (
              <p>This is a v1 backup; missing affected areas will be mapped to Not recorded.</p>
            ) : null}
            <p>This atomically replaces only your current diary. Your account stays the same.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-danger"
                onClick={() => void confirmRestore()}
                disabled={restoreBusy}
              >
                {restoreBusy ? 'Restoring…' : 'Replace my diary with this backup'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setRestorePreview(null);
                  setRestoreBackup(null);
                }}
                disabled={restoreBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card space-y-3" aria-labelledby="clear-heading">
        <h2 id="clear-heading" className="text-lg font-semibold">
          Clear all diary data
        </h2>
        <p className="muted">
          Clears only this account’s events, custom tags and diary settings, then rotates the dataset
          epoch. Built-in tags are reseeded. Older server backups or downloaded exports may still
          contain removed data.
        </p>
        <button type="button" className="btn-danger" onClick={() => setClearOpen(true)}>
          Clear all diary data
        </button>
      </section>

      <Modal open={clearOpen} title="Clear all diary data" onClose={() => setClearOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm">
            This cannot be undone in the app. Type <strong>CLEAR</strong> to confirm.
          </p>
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={offerBackup}
              onChange={(event) => setOfferBackup(event.target.checked)}
            />
            <span>Download a JSON backup before clearing</span>
          </label>
          <div>
            <label htmlFor="clear-confirm" className="field-label">
              Confirmation
            </label>
            <input
              id="clear-confirm"
              className="field-input"
              value={clearText}
              onChange={(event) => setClearText(event.target.value)}
              autoComplete="off"
            />
          </div>
          {clearError ? <StatusMessage tone="error">{errorMessage(clearError)}</StatusMessage> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-danger"
              onClick={() => void confirmClear()}
              disabled={clearBusy || clearText !== 'CLEAR'}
            >
              {clearBusy ? 'Clearing…' : 'Clear my diary'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setClearOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      <p className="muted text-xs">
        The app does not provide clinical interpretation, dosing guidance, emergency monitoring or
        automatic report delivery. A quiet diary is not evidence of a seizure-free period.
      </p>
    </div>
  );
}

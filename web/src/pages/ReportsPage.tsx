import { useCallback, useEffect, useState } from 'react';
import type { DiarySettings } from '@shared/types';
import type { Granularity } from '@shared/range';
import type { ReportModel } from '@shared/report';
import { formatPlainDate, todayInZone } from '@shared/time';
import { ApiError, api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { fetchSettings } from '../settingsClient';
import { Spinner, StatusMessage } from '../components/ui';

interface PreviewResponse {
  model: ReportModel;
  digest: string;
  dataVersion: number;
  datasetEpoch: string;
}

interface PreviewRequest {
  start: string;
  end: string;
  granularity: Granularity;
  includeName: boolean;
  name?: string;
  includeNotes: boolean;
}

type Preset = '30' | '90' | 'custom';

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function medianText(value: number | null, count: number): string {
  if (value === null) return 'Not enough data';
  return Number.isInteger(value) ? `${value}s (${count} recorded)` : `${value}s (${count} recorded)`;
}

export function ReportsPage(): JSX.Element {
  const { csrfToken } = useAuth();
  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [preset, setPreset] = useState<Preset>('30');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [includeName, setIncludeName] = useState(false);
  const [name, setName] = useState('');
  const [includeNotes, setIncludeNotes] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Reports · Seizure Diary';
  }, []);

  useEffect(() => {
    let active = true;
    fetchSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        const today = todayInZone(loaded.reportZone);
        setEnd(today);
        setStart(addDays(today, -29));
      })
      .catch((caught) => {
        if (active) setError(caught);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    setPreviewRequest(null);
  }, [start, end, includeName, name, includeNotes, preset]);

  const rangeFor = useCallback(() => {
    if (!settings) throw new Error('Settings are still loading.');
    const today = todayInZone(settings.reportZone);
    let from = start;
    let to = end;
    if (preset === '30') {
      to = today;
      from = addDays(today, -29);
    } else if (preset === '90') {
      to = today;
      from = addDays(today, -89);
    }
    if (!from || !to) throw new Error('Choose both a start and an end date.');
    if (from > to) throw new Error('The start date must be on or before the end date.');
    if (to > today) throw new Error('The end date cannot be in the future.');
    return { start: from, end: to };
  }, [settings, start, end, preset]);

  const generate = async () => {
    setError(null);
    setDownloadError(null);
    if (!csrfToken) {
      setError(new Error('Your session expired. Sign in again.'));
      return;
    }
    let range: { start: string; end: string };
    try {
      range = rangeFor();
    } catch (caught) {
      setError(caught);
      return;
    }
    const request: PreviewRequest = {
      start: range.start,
      end: range.end,
      granularity: 'week',
      includeName,
      includeNotes,
      ...(includeName && name.trim() ? { name: name.trim() } : {}),
    };
    setGenerating(true);
    try {
      const response = await api<PreviewResponse>('/reports/preview', {
        method: 'POST',
        body: request,
        csrfToken,
      });
      setPreview(response);
      setPreviewRequest(request);
    } catch (caught) {
      setError(caught);
      setPreview(null);
      setPreviewRequest(null);
    } finally {
      setGenerating(false);
    }
  };

  const download = async () => {
    if (!preview || !previewRequest || !csrfToken) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await api<{ ok: boolean }>('/reports/validate', {
        method: 'POST',
        body: {
          ...previewRequest,
          dataVersion: preview.dataVersion,
          datasetEpoch: preview.datasetEpoch,
          modelDigest: preview.digest,
        },
        csrfToken,
      });
    } catch (caught) {
      setPreview(null);
      setPreviewRequest(null);
      setDownloadError(caught);
      setDownloading(false);
      return;
    }

    try {
      const { generateReportPdf } = await import('../pdf/generate');
      const blob = await generateReportPdf(preview.model);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `seizure-diary_${preview.model.range.start}_${preview.model.range.end}.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      }
    } catch (caught) {
      setDownloadError(
        new Error(
          `The PDF could not be generated. No file was downloaded. ${errorMessage(caught)}`,
        ),
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="muted">
          Preview exactly what will be shared, then download a selectable-text A4 PDF. Exports may
          contain sensitive health information.
        </p>
      </div>

      <form
        className="card space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="report-preset" className="field-label">
              Date range
            </label>
            <select
              id="report-preset"
              className="field-input"
              value={preset}
              onChange={(event) => {
                const next = event.target.value as Preset;
                setPreset(next);
                if (settings && next !== 'custom') {
                  const today = todayInZone(settings.reportZone);
                  setEnd(today);
                  setStart(addDays(today, next === '30' ? -29 : -89));
                }
              }}
            >
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label htmlFor="report-start" className="field-label">
              From
            </label>
            <input
              id="report-start"
              type="date"
              className="field-input"
              value={start}
              disabled={preset !== 'custom'}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-end" className="field-label">
              To
            </label>
            <input
              id="report-end"
              type="date"
              className="field-input"
              value={end}
              disabled={preset !== 'custom'}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <p className="muted">
              Reporting zone: <strong>{settings?.reportZone ?? '…'}</strong>
            </p>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="field-label">Privacy options</legend>
          <label className="flex min-h-[44px] items-center gap-2">
            <input
              type="checkbox"
              checked={includeName}
              onChange={(event) => setIncludeName(event.target.checked)}
            />
            <span>Include a name on this report</span>
          </label>
          {includeName ? (
            <div>
              <label htmlFor="report-name" className="field-label">
                Name for this report only
              </label>
              <input
                id="report-name"
                className="field-input"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}
          <label className="flex min-h-[44px] items-center gap-2">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(event) => setIncludeNotes(event.target.checked)}
            />
            <span>Include notes (off by default)</span>
          </label>
          <p className="muted">
            Rescue medication and its recorded details are always part of the report. Affected
            areas are always included.
          </p>
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={generating || !settings}>
            {generating ? 'Generating preview…' : 'Generate preview'}
          </button>
          {preview ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? 'Preparing PDF…' : 'Download PDF'}
            </button>
          ) : null}
        </div>
      </form>

      {error ? <StatusMessage tone="error">{errorMessage(error)}</StatusMessage> : null}
      {downloadError ? (
        <StatusMessage tone="error">
          {downloadError instanceof ApiError && downloadError.code === 'stale_preview'
            ? 'The diary or report settings changed. Generate a new preview before downloading.'
            : errorMessage(downloadError)}
        </StatusMessage>
      ) : null}

      {generating ? <Spinner label="Building the privacy-projected preview" /> : null}

      {preview ? (
        <article className="card space-y-4" aria-labelledby="preview-heading">
          <div>
            <h2 id="preview-heading" className="text-lg font-semibold">
              Preview
            </h2>
            <p className="muted">
              {preview.model.events.length} logged event
              {preview.model.events.length === 1 ? '' : 's'} ·{' '}
              {formatPlainDate(preview.model.range.start)} –{' '}
              {formatPlainDate(preview.model.range.end)} · reporting zone{' '}
              {preview.model.reportZone}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-slate-300 px-3 py-1">
              Name: {preview.model.patientName ? `included (${preview.model.patientName})` : 'not included'}
            </span>
            <span className="rounded-full border border-slate-300 px-3 py-1">
              Notes: {preview.model.includeNotes ? 'included' : 'not included'}
            </span>
            <span className="rounded-full border border-slate-300 px-3 py-1">
              Rescue details: included
            </span>
          </div>
          <StatusMessage tone="warning">
            This preview and any downloaded PDF may contain private health information. Email,
            upload or automatic sharing is never performed by the app.
          </StatusMessage>

          {preview.model.events.length === 0 ? (
            <p>
              No events logged in this period. You can still download a PDF stating that no events
              were logged.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="muted">Logged events</p>
                  <p className="text-2xl font-bold">{preview.model.summary.totalEvents}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="muted">Days with entries</p>
                  <p className="text-2xl font-bold">{preview.model.summary.distinctDates}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="muted">Rescue used</p>
                  <p className="text-2xl font-bold">{preview.model.summary.rescueUsed}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="muted">Median known duration</p>
                  <p className="text-xl font-bold">
                    {medianText(
                      preview.model.summary.medianDurationSeconds,
                      preview.model.summary.durationsRecorded,
                    )}
                  </p>
                </div>
              </div>

              <ul className="space-y-3">
                {preview.model.events.map((event) => (
                  <li key={event.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold">{formatPlainDate(event.reportDate)}</p>
                      <p className="muted">
                        {event.occurred.timeDisplay}
                        {event.occurred.approximate ? ' approx.' : ''} · {event.occurred.zone}
                        {event.occurred.differsFromReportDate
                          ? ` · recorded ${formatPlainDate(event.occurred.date)}`
                          : ''}
                      </p>
                    </div>
                    {event.eventLabel ? <p className="mt-1 font-semibold">{event.eventLabel}</p> : null}
                    <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="muted">Duration</dt>
                        <dd>{event.duration.label}</dd>
                      </div>
                      <div>
                        <dt className="muted">Affected areas</dt>
                        <dd>{event.affectedAreas.display}</dd>
                      </div>
                      <div>
                        <dt className="muted">Possible triggers</dt>
                        <dd>{event.triggers.display}</dd>
                      </div>
                      <div>
                        <dt className="muted">Aura / warning</dt>
                        <dd>{event.aura.display}</dd>
                      </div>
                      <div>
                        <dt className="muted">Rescue medication</dt>
                        <dd>{event.rescue.display}</dd>
                      </div>
                    </dl>
                    {event.rescue.administrations.length > 0 ? (
                      <ul className="mt-2 list-disc pl-5 text-sm">
                        {event.rescue.administrations.map((administration, index) => (
                          <li key={index}>
                            {[
                              administration.name,
                              administration.doseAsReported
                                ? `dose as reported: ${administration.doseAsReported}`
                                : null,
                              administration.timingAsReported
                                ? `timing as reported: ${administration.timingAsReported}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {event.notes ? (
                      <div className="mt-2">
                        <p className="muted">Notes</p>
                        <p className="whitespace-pre-wrap break-words text-sm">{event.notes}</p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="muted text-xs">
              Patient-entered diary; totals reflect logged entries only. Downloaded copies leave the
              app’s storage.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? 'Preparing PDF…' : 'Download PDF'}
            </button>
          </div>
        </article>
      ) : null}
    </div>
  );
}

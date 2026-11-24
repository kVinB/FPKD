import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Bucket } from '@shared/range';
import type { AnalyticsResult, Granularity } from '@shared/range';
import type { AffectedArea, DiarySettings } from '@shared/types';
import { formatDuration, formatPlainDate, todayInZone } from '@shared/time';
import { api, errorMessage } from '../api';
import { fetchSettings } from '../settingsClient';
import {
  EmptyState,
  ErrorSummary,
  Spinner,
  StatusMessage,
  useIsMobile,
} from '../components/ui';
import { AFFECTED_AREA_LABELS } from '@shared/types';

type Preset = '30' | '90' | 'custom';

function isoToday(zone: string): string {
  return todayInZone(zone);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function bucketLabel(bucket: Bucket, granularity: Granularity): string {
  if (granularity === 'month') {
    return formatPlainDate(bucket.start).replace(/^\d+ /, '');
  }
  if (granularity === 'week') {
    return formatPlainDate(bucket.start);
  }
  return formatPlainDate(bucket.start);
}

function bucketRangeLabel(bucket: Bucket, granularity: Granularity): string {
  if (granularity === 'day') return formatPlainDate(bucket.start);
  return `${formatPlainDate(bucket.start)} – ${formatPlainDate(bucket.end)}`;
}

function medianLabel(value: number | null, count: number): string {
  if (value === null) return 'Not enough data';
  const text = Number.isInteger(value) ? formatDuration(value) : `${value}s`;
  return `${text} (${count} recorded)`;
}

export function AnalyticsPage(): JSX.Element {
  const isMobile = useIsMobile();
  const pageSize = isMobile ? 12 : 24;

  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [preset, setPreset] = useState<Preset>('30');
  const [granularity, setGranularity] = useState<Granularity>('week');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [applied, setApplied] = useState<{ start: string; end: string; granularity: Granularity } | null>(
    null,
  );
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [bucketPage, setBucketPage] = useState(0);

  useEffect(() => {
    document.title = 'Analytics · Seizure Diary';
  }, []);

  useEffect(() => {
    let active = true;
    fetchSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        const today = isoToday(loaded.reportZone);
        const start = addDays(today, -29);
        setCustomStart(start);
        setCustomEnd(today);
        setApplied({ start, end: today, granularity: 'week' });
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

  const load = useCallback(
    async (range: { start: string; end: string; granularity: Granularity }) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api<AnalyticsResult>('/analytics/query', {
          method: 'POST',
          body: range,
        });
        setData(result);
        setBucketPage(0);
      } catch (caught) {
        setError(caught);
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (applied) void load(applied);
  }, [applied, load]);

  const apply = () => {
    if (!settings) return;
    const today = isoToday(settings.reportZone);
    let start = customStart;
    let end = customEnd;
    if (preset === '30') {
      end = today;
      start = addDays(today, -29);
      setCustomStart(start);
      setCustomEnd(end);
    } else if (preset === '90') {
      end = today;
      start = addDays(today, -89);
      setCustomStart(start);
      setCustomEnd(end);
    }
    setRangeError(null);
    if (!start || !end) {
      setRangeError('Choose both a start and an end date.');
      return;
    }
    if (start > end) {
      setRangeError('The start date must be on or before the end date.');
      return;
    }
    if (end > today) {
      setRangeError('The end date cannot be in the future.');
      return;
    }
    setApplied({ start, end, granularity });
  };

  const buckets = data?.buckets ?? [];
  const pageCount = Math.max(1, Math.ceil(buckets.length / pageSize));
  const safePage = Math.min(bucketPage, pageCount - 1);
  const visibleBuckets = buckets.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const maxCount = useMemo(
    () => Math.max(1, ...visibleBuckets.map((bucket) => bucket.count)),
    [visibleBuckets],
  );
  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="muted">
          Logged events — what was recorded, not verified seizure counts. A quiet diary is not
          evidence of a seizure-free period.
        </p>
      </div>

      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="range-preset" className="field-label">
              Date range
            </label>
            <select
              id="range-preset"
              className="field-input"
              value={preset}
              onChange={(event) => setPreset(event.target.value as Preset)}
            >
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label htmlFor="range-granularity" className="field-label">
              Group by
            </label>
            <select
              id="range-granularity"
              className="field-input"
              value={granularity}
              onChange={(event) => setGranularity(event.target.value as Granularity)}
            >
              <option value="day">Day</option>
              <option value="week">Week (Monday start)</option>
              <option value="month">Month</option>
            </select>
          </div>
          {preset === 'custom' ? (
            <>
              <div>
                <label htmlFor="range-start" className="field-label">
                  From
                </label>
                <input
                  id="range-start"
                  type="date"
                  className="field-input"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="range-end" className="field-label">
                  To
                </label>
                <input
                  id="range-end"
                  type="date"
                  className="field-input"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="muted">
            Reporting zone: <strong>{data?.reportZone ?? settings?.reportZone ?? '…'}</strong>{' '}
            <Link to="/settings" className="link">
              Change
            </Link>
          </p>
          <button type="submit" className="btn-primary">
            Update chart
          </button>
        </div>
        {rangeError ? <StatusMessage tone="error">{rangeError}</StatusMessage> : null}
      </form>

      {error ? (
        <div className="space-y-2">
          <ErrorSummary
            errors={[{ field: 'form', message: errorMessage(error) }]}
            title="Could not load analytics"
          />
          {applied ? (
            <button type="button" className="btn-secondary" onClick={() => void load(applied)}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && !data ? <Spinner label="Loading analytics" /> : null}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card">
            <p className="muted">Logged events</p>
            <p className="text-3xl font-bold">{summary.totalEvents}</p>
          </div>
          <div className="card">
            <p className="muted">Days with entries</p>
            <p className="text-3xl font-bold">{summary.distinctDates}</p>
          </div>
          <div className="card">
            <p className="muted">Rescue used</p>
            <p className="text-3xl font-bold">{summary.rescueUsed}</p>
            <p className="muted text-xs">Counts events, not administrations.</p>
          </div>
          <div className="card">
            <p className="muted">Median known duration</p>
            <p className="text-2xl font-bold">
              {medianLabel(summary.medianDurationSeconds, summary.durationsRecorded)}
            </p>
            <p className="muted text-xs">Exact and estimated durations included.</p>
          </div>
        </div>
      ) : null}

      {data && summary && summary.totalEvents === 0 ? (
        <StatusMessage tone="info">
          No logged events in this range. Zero buckets are shown below; a quiet diary is not
          evidence of a seizure-free period.
        </StatusMessage>
      ) : null}

      {data ? (
        <section className="card space-y-3" aria-labelledby="chart-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="chart-heading" className="text-lg font-semibold">
              Logged events by {data.range.granularity}
            </h2>
            <p className="muted">
              {formatPlainDate(data.range.start)} – {formatPlainDate(data.range.end)}
            </p>
          </div>

          {buckets.length === 0 ? (
            <EmptyState title="No buckets in this range" />
          ) : (
            <>
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable chart">
                <svg
                  viewBox="0 0 720 260"
                  role="img"
                  aria-label={`Bar chart of logged events. ${summary?.totalEvents ?? 0} logged events across ${buckets.length} buckets.`}
                  className="h-56 w-full min-w-[520px]"
                >
                  <line x1="40" y1="220" x2="700" y2="220" stroke="#94a3b8" strokeWidth="1" />
                  <line x1="40" y1="20" x2="40" y2="220" stroke="#94a3b8" strokeWidth="1" />
                  {[0, 0.5, 1].map((ratio) => {
                    const y = 220 - ratio * 200;
                    const value = Math.round(maxCount * ratio);
                    return (
                      <g key={ratio}>
                        <line x1="36" y1={y} x2="700" y2={y} stroke="#e2e8f0" strokeWidth="1" />
                        <text x="30" y={y + 4} textAnchor="end" fontSize="11" fill="#475569">
                          {value}
                        </text>
                      </g>
                    );
                  })}
                  {visibleBuckets.map((bucket, index) => {
                    const count = visibleBuckets.length;
                    const width = Math.min(48, 620 / Math.max(count, 1) - 8);
                    const slot = 640 / Math.max(count, 1);
                    const x = 50 + index * slot + (slot - width) / 2;
                    const height = (bucket.count / maxCount) * 200;
                    const y = 220 - height;
                    return (
                      <g key={bucket.key}>
                        <rect
                          x={x}
                          y={y}
                          width={width}
                          height={Math.max(height, bucket.count > 0 ? 2 : 0)}
                          fill="#0f766e"
                          rx="2"
                        />
                        {bucket.count > 0 ? (
                          <text
                            x={x + width / 2}
                            y={y - 4}
                            textAnchor="middle"
                            fontSize="12"
                            fill="#0f172a"
                          >
                            {bucket.count}
                          </text>
                        ) : null}
                        <text
                          x={x + width / 2}
                          y="240"
                          textAnchor="middle"
                          fontSize="10"
                          fill="#475569"
                        >
                          {bucketLabel(bucket, data.range.granularity)}
                          {bucket.partial ? '*' : ''}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setBucketPage((value) => Math.max(0, value - 1))}
                  disabled={safePage <= 0}
                >
                  Previous buckets
                </button>
                <p className="muted">
                  Buckets {safePage + 1}–{Math.min((safePage + 1) * pageSize, buckets.length)} of{' '}
                  {buckets.length}
                </p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setBucketPage((value) => Math.min(pageCount - 1, value + 1))}
                  disabled={safePage >= pageCount - 1}
                >
                  Next buckets
                </button>
              </div>

              <details>
                <summary className="cursor-pointer font-semibold">View data table</summary>
                <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable data table">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Logged events per {data.range.granularity} bucket
                    </caption>
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                      <tr>
                        <th scope="col" className="px-3 py-2">Period</th>
                        <th scope="col" className="px-3 py-2">Logged events</th>
                        <th scope="col" className="px-3 py-2">Partial period</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleBuckets.map((bucket) => (
                        <tr key={bucket.key}>
                          <td className="px-3 py-2">
                            {bucketRangeLabel(bucket, data.range.granularity)}
                          </td>
                          <td className="px-3 py-2">{bucket.count}</td>
                          <td className="px-3 py-2">{bucket.partial ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <p className="muted text-xs">
                * Partial period at the edge of the selected range. Zero buckets are shown; a quiet
                period is not evidence of seizure freedom.
              </p>
            </>
          )}
        </section>
      ) : null}

      {summary && summary.areaAnswered > 0 ? (
        <section className="card space-y-2" aria-labelledby="areas-heading">
          <h2 id="areas-heading" className="text-lg font-semibold">
            Affected areas (descriptive)
          </h2>
          <ul className="grid gap-2 sm:grid-cols-3">
            {(['arms', 'legs', 'speech'] as AffectedArea[]).map((area) => (
              <li key={area} className="rounded-lg border border-slate-200 p-3">
                <p className="muted">{AFFECTED_AREA_LABELS[area]}</p>
                <p className="text-xl font-semibold">{summary.areaCounts[area]}</p>
              </li>
            ))}
          </ul>
          <p className="muted text-xs">
            One event counts once per selected area, so these can sum above the logged-event
            total. Entries with an area answer: {summary.areaAnswered}.
          </p>
        </section>
      ) : null}

      <p className="muted text-xs">
        No predictions, causal claims, dosing or clinical interpretation. Counts reflect logged
        entries only.
      </p>
    </div>
  );
}

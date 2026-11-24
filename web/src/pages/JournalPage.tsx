import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { SeizureEvent } from '@shared/types';
import { reportDateFor, formatPlainDate } from '@shared/time';
import { areaDisplay, durationDisplay, rescueDisplay } from '@shared/report';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { EmptyState, ErrorSummary, Spinner, StatusMessage } from '../components/ui';

interface QueryResponse {
  items: SeizureEvent[];
  total: number;
  page: number;
  pageSize: number;
  reportZone: string;
  dataVersion: number;
  datasetEpoch: string;
}

function timeLabel(event: SeizureEvent): string {
  if (event.occurredAt.precision === 'date_only') return 'Time not recorded';
  const suffix = event.occurredAt.precision === 'approximate' ? ' approx.' : '';
  return `${event.occurredAt.wallTime}${suffix}`;
}

export function JournalPage(): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const highlightId = (location.state as { highlightId?: string } | null)?.highlightId;

  const [data, setData] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(1);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState<{ start?: string; end?: string; search?: string }>({});

  useEffect(() => {
    document.title = 'Journal · Seizure Diary';
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await api<QueryResponse>('/events/query', {
          method: 'POST',
          body: {
            page,
            pageSize: 25,
            ...(applied.start ? { start: applied.start } : {}),
            ...(applied.end ? { end: applied.end } : {}),
            ...(applied.search ? { search: applied.search } : {}),
          },
          ...(signal ? { signal } : {}),
        });
        setData(response);
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return;
        setError(caught);
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [page, applied],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const groups = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, SeizureEvent[]>();
    for (const event of data.items) {
      const reportDate = reportDateFor(event.occurredAt, data.reportZone);
      const list = map.get(reportDate) ?? [];
      list.push(event);
      map.set(reportDate, list);
    }
    return [...map.entries()];
  }, [data]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const hasFilter = Boolean(applied.start || applied.end || applied.search);

  const applyFilter = (event: React.FormEvent) => {
    event.preventDefault();
    if (start && end && start > end) {
      setError(new Error('The start date must be on or before the end date.'));
      return;
    }
    setPage(1);
    setApplied({
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    });
  };

  const resetFilter = () => {
    setStart('');
    setEnd('');
    setSearch('');
    setApplied({});
    setPage(1);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Journal</h1>
          <p className="muted">
            Signed in as {user?.displayLabel || user?.username}. Saved to your family’s private
            server.
          </p>
        </div>
        <Link to="/events/new" className="btn-primary">
          + Log event
        </Link>
      </div>

      <form onSubmit={applyFilter} className="card space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="filter-start" className="field-label">
              From date
            </label>
            <input
              id="filter-start"
              type="date"
              className="field-input"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="filter-end" className="field-label">
              To date
            </label>
            <input
              id="filter-end"
              type="date"
              className="field-input"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="filter-search" className="field-label">
              Search label or notes
            </label>
            <input
              id="filter-search"
              className="field-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary">
            Apply filters
          </button>
          {hasFilter ? (
            <button type="button" className="btn-secondary" onClick={resetFilter}>
              Reset filters
            </button>
          ) : null}
        </div>
      </form>

      {error ? (
        <div className="space-y-2">
          <ErrorSummary errors={[{ field: 'form', message: errorMessage(error) }]} title="Could not load the journal" />
          <button type="button" className="btn-secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && !data ? <Spinner label="Loading journal" /> : null}

      {data && data.total === 0 ? (
        <EmptyState
          title={hasFilter ? 'No entries match these filters' : 'No logged events yet'}
        >
          {hasFilter
            ? 'Reset the filters to see all entries.'
            : 'Log a suspected or confirmed event, even if you do not know all the details.'}
        </EmptyState>
      ) : null}

      {data && data.total > 0 ? (
        <div className="space-y-6">
          <p className="muted">
            {data.total} logged event{data.total === 1 ? '' : 's'} · reporting zone{' '}
            {data.reportZone}
          </p>
          {groups.map(([date, events]) => (
            <section key={date} aria-labelledby={`date-${date}`}>
              <h2 id={`date-${date}`} className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-600">
                {formatPlainDate(date)}
              </h2>
              <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                    <tr>
                      <th scope="col" className="px-4 py-3">Time</th>
                      <th scope="col" className="px-4 py-3">Affected areas</th>
                      <th scope="col" className="px-4 py-3">Duration</th>
                      <th scope="col" className="px-4 py-3">Label</th>
                      <th scope="col" className="px-4 py-3">Rescue</th>
                      <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {events.map((event) => {
                      const duration = durationDisplay(event);
                      const recordedDateDiffers =
                        reportDateFor(event.occurredAt, data.reportZone) !==
                        event.occurredAt.captureDate;
                      return (
                        <tr
                          key={event.id}
                          className={highlightId === event.id ? 'bg-teal-50' : undefined}
                        >
                          <td className="px-4 py-3">
                            <div className="font-semibold">{timeLabel(event)}</div>
                            <div className="muted">
                              {event.occurredAt.precision === 'date_only'
                                ? event.occurredAt.zone
                                : `${event.occurredAt.zone} (${event.occurredAt.offset})`}
                            </div>
                            {recordedDateDiffers ? (
                              <div className="muted">
                                recorded {formatPlainDate(event.occurredAt.captureDate)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">{areaDisplay(event.affectedAreas)}</td>
                          <td className="px-4 py-3">{duration.label}</td>
                          <td className="px-4 py-3">{event.eventLabel || '—'}</td>
                          <td className="px-4 py-3">{rescueDisplay(event.rescue).display}</td>
                          <td className="px-4 py-3 text-right">
                            <Link to={`/events/${event.id}`} className="link">
                              Open
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="space-y-3 md:hidden">
                {events.map((event) => (
                  <li key={event.id}>
                    <Link
                      to={`/events/${event.id}`}
                      state={{ fromJournal: true }}
                      className={`block rounded-xl border bg-white p-4 no-underline shadow-sm ${
                        highlightId === event.id ? 'border-teal-600 ring-2 ring-teal-200' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{timeLabel(event)}</span>
                        <span className="muted">{event.occurredAt.precision}</span>
                      </div>
                      <p className="mt-1 text-sm">{areaDisplay(event.affectedAreas)}</p>
                      <p className="muted mt-1">
                        {durationDisplay(event).label} · {rescueDisplay(event.rescue).display}
                        {event.eventLabel ? ` · ${event.eventLabel}` : ''}
                      </p>
                      {reportDateFor(event.occurredAt, data.reportZone) !==
                      event.occurredAt.captureDate ? (
                        <p className="muted mt-1">
                          recorded {formatPlainDate(event.occurredAt.captureDate)} ·{' '}
                          {event.occurredAt.zone}
                        </p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              className="btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </button>
            <p className="muted">
              Page {data.page} of {totalPages}
            </p>
            <button
              type="button"
              className="btn-secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {data && data.items.length === 0 && data.total > 0 ? (
        <StatusMessage tone="info">
          This page has no entries. Use Previous to go back.
        </StatusMessage>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => navigate('/events/new')}
        >
          + Log event
        </button>
      </div>
    </div>
  );
}

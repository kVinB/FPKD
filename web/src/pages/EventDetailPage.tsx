import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DiarySettings, SeizureEvent } from '@shared/types';
import {
  areaDisplay,
  durationDisplay,
  rescueDisplay,
  tagDisplay,
} from '@shared/report';
import { formatPlainDate, reportDateFor } from '@shared/time';
import { ApiError, api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { fetchSettings } from '../settingsClient';
import { Spinner, StatusMessage } from '../components/ui';

export function EventDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { csrfToken } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState<SeizureEvent | null>(null);
  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Event · Seizure Diary';
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [eventData, settingsData] = await Promise.all([
          api<{ event: SeizureEvent }>(`/events/${encodeURIComponent(id ?? '')}`),
          fetchSettings(),
        ]);
        if (!active) return;
        setEvent(eventData.event);
        setSettings(settingsData);
      } catch (caught) {
        if (active) setError(caught);
      } finally {
        if (active) setLoading(false);
      }
    };
    if (id) void load();
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) return <Spinner label="Loading entry" />;

  if (error || !event) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{notFound ? 'Entry not available' : 'Could not load entry'}</h1>
        <StatusMessage tone="error">
          {notFound
            ? 'This entry is missing or not available to your account.'
            : error
              ? errorMessage(error)
              : 'This entry is missing or not available to your account.'}
        </StatusMessage>
        <Link to="/journal" className="btn-secondary">
          Back to journal
        </Link>
      </div>
    );
  }

  const occurred = event.occurredAt;
  const reportDate = settings ? reportDateFor(occurred, settings.reportZone) : null;
  const differs = reportDate && reportDate !== occurred.captureDate;
  const duration = durationDisplay(event);
  const rescue = rescueDisplay(event.rescue);

  const onDelete = async () => {
    const when =
      occurred.precision === 'date_only'
        ? `${formatPlainDate(occurred.captureDate)} (time not recorded)`
        : `${formatPlainDate(occurred.captureDate)} at ${occurred.wallTime}${occurred.precision === 'approximate' ? ' approx.' : ''}`;
    if (!window.confirm(`Delete the entry from ${when}? This cannot be undone.`)) return;
    if (!csrfToken) {
      setDeleteError(new Error('Your session expired. Sign in again.'));
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/events/${encodeURIComponent(event.id)}`, {
        method: 'DELETE',
        csrfToken,
        body: {
          expectedRevision: event.revision,
          ...(settings ? { expectedDatasetEpoch: settings.datasetEpoch } : {}),
        },
      });
      navigate('/journal', { replace: true });
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{formatPlainDate(reportDate ?? occurred.captureDate)}</h1>
          <p className="muted">
            {occurred.precision === 'date_only'
              ? 'Time not recorded'
              : `${occurred.wallTime}${occurred.precision === 'approximate' ? ' approx.' : ''} · ${occurred.zone} (${occurred.offset})`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/events/${event.id}/edit`} className="btn-primary">
            Edit
          </Link>
          <button type="button" className="btn-danger" onClick={() => void onDelete()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      {deleteError ? (
        <StatusMessage tone="error">{errorMessage(deleteError)}</StatusMessage>
      ) : null}

      {differs && settings ? (
        <StatusMessage tone="info">
          Recorded date {formatPlainDate(occurred.captureDate)}; reporting date in{' '}
          {settings.reportZone} is {formatPlainDate(reportDate ?? occurred.captureDate)}.
        </StatusMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="card">
          <h2 className="text-lg font-semibold">Affected areas</h2>
          <p className="mt-2 text-xl font-semibold">{areaDisplay(event.affectedAreas)}</p>
          <p className="muted mt-1">Observations, not a clinical classification.</p>
        </section>
        <section className="card">
          <h2 className="text-lg font-semibold">Duration</h2>
          <p className="mt-2 text-xl font-semibold">{duration.label}</p>
        </section>
        <section className="card">
          <h2 className="text-lg font-semibold">Possible triggers</h2>
          <p className="mt-2">{tagDisplay(event.triggers)}</p>
        </section>
        <section className="card">
          <h2 className="text-lg font-semibold">Aura / warning</h2>
          <p className="mt-2">{tagDisplay(event.aura)}</p>
        </section>
      </div>

      <section className="card">
        <h2 className="text-lg font-semibold">Rescue medication</h2>
        <p className="mt-2 font-semibold">{rescue.display}</p>
        {rescue.administrations.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {rescue.administrations.map((administration, index) => (
              <li key={index} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-semibold">Administration {index + 1}</p>
                <dl className="mt-1 grid gap-1 sm:grid-cols-3">
                  <div>
                    <dt className="muted">Name as reported</dt>
                    <dd>{administration.name || 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt className="muted">Dose as reported</dt>
                    <dd>{administration.doseAsReported || 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt className="muted">Timing as reported</dt>
                    <dd>{administration.timingAsReported || 'Not recorded'}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {event.eventLabel || event.notes ? (
        <section className="card space-y-3">
          {event.eventLabel ? (
            <div>
              <h2 className="text-lg font-semibold">Event label</h2>
              <p className="mt-1 whitespace-pre-wrap">{event.eventLabel}</p>
            </div>
          ) : null}
          {event.notes ? (
            <div>
              <h2 className="text-lg font-semibold">Notes</h2>
              <p className="mt-1 whitespace-pre-wrap break-words">{event.notes}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="flex items-center justify-between">
        <Link to="/journal" className="link">
          Back to journal
        </Link>
        <p className="muted text-xs">
          Revision {event.revision} · saved to your family’s private server
        </p>
      </div>
    </div>
  );
}

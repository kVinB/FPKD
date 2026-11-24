import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Administration,
  AffectedAreas,
  DiarySettings,
  Rescue,
  SeizureEvent,
  Tag,
  TagAnswer,
} from '@shared/types';
import {
  buildTimedEventTime,
  isValidIanaZone,
  isRealPlainDate,
  isWallTime,
  nowWallClock,
  possibleOffsets,
} from '@shared/time';
import { codePointLength } from '@shared/tags';
import { ApiError, api, errorFieldMap, errorMessage } from '../api';
import { useAuth } from '../auth';
import { fetchSettings } from '../settingsClient';
import {
  AffectedAreasField,
  TagPicker,
} from '../components/fields';
import {
  deviceTimeZone,
  ErrorSummary,
  Spinner,
  StatusMessage,
  ZoneSelect,
} from '../components/ui';

type Precision = 'exact' | 'approximate' | 'date_only';
type DurationMode = 'not_recorded' | 'exact' | 'estimated' | 'unknown';

interface AdministrationDraft {
  id: string;
  name: string;
  dose: string;
  timing: string;
}

interface FormError {
  field: string;
  message: string;
}

const EMPTY_AREAS: AffectedAreas = { status: 'not_recorded' };

function mapServerField(field: string): string {
  if (field === 'occurredAt') return 'date';
  if (field === 'form') return 'form';
  return field;
}

export function EventFormPage({ mode }: { mode: 'new' | 'edit' }): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { csrfToken } = useAuth();
  const navigate = useNavigate();
  const editing = mode === 'edit';
  const newEventId = useRef(crypto.randomUUID());
  const hydrated = useRef(false);
  const initialised = useRef(false);

  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [existing, setExisting] = useState<SeizureEvent | null>(null);
  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [tagSuggestions, setTagSuggestions] = useState<Tag[]>([]);

  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [zone, setZone] = useState('UTC');
  const [precision, setPrecision] = useState<Precision>('approximate');
  const [offset, setOffset] = useState('');
  const [affected, setAffected] = useState<AffectedAreas>(EMPTY_AREAS);
  const [durationMode, setDurationMode] = useState<DurationMode>('not_recorded');
  const [minutes, setMinutes] = useState('');
  const [seconds, setSeconds] = useState('');
  const [triggers, setTriggers] = useState<TagAnswer>({ status: 'not_recorded' });
  const [aura, setAura] = useState<TagAnswer>({ status: 'not_recorded' });
  const [rescueStatus, setRescueStatus] = useState<Rescue['status']>('not_recorded');
  const [administrations, setAdministrations] = useState<AdministrationDraft[]>([]);
  const [eventLabel, setEventLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localErrors, setLocalErrors] = useState<FormError[]>([]);

  useEffect(() => {
    document.title = editing ? 'Edit event · Seizure Diary' : 'New event · Seizure Diary';
  }, [editing]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setInitialLoading(true);
      setLoadError(null);
      try {
        const [settingsData, tagsData, eventData] = await Promise.all([
          fetchSettings(),
          api<{ tags: Tag[] }>('/tags'),
          editing && id
            ? api<{ event: SeizureEvent }>(`/events/${encodeURIComponent(id)}`)
            : Promise.resolve(null),
        ]);
        if (!active) return;
        setSettings(settingsData);
        setTagSuggestions(tagsData.tags);

        if (editing && eventData) {
          const event = eventData.event;
          setExisting(event);
          setDate(event.occurredAt.captureDate);
          setZone(event.occurredAt.zone);
          setPrecision(event.occurredAt.precision);
          if (event.occurredAt.precision !== 'date_only') {
            setTime(event.occurredAt.wallTime);
            setOffset(event.occurredAt.offset);
          }
          setAffected(event.affectedAreas);
          if (event.duration.status === 'exact' || event.duration.status === 'estimated') {
            setDurationMode(event.duration.status);
            setMinutes(String(Math.floor(event.duration.seconds / 60)));
            setSeconds(String(event.duration.seconds % 60));
          } else {
            setDurationMode(event.duration.status);
          }
          setTriggers(event.triggers);
          setAura(event.aura);
          setRescueStatus(event.rescue.status);
          if (event.rescue.status === 'used') {
            setAdministrations(
              event.rescue.administrations.map((administration) => ({
                id: administration.id,
                name: administration.name ?? '',
                dose: administration.doseAsReported ?? '',
                timing: administration.timingAsReported ?? '',
              })),
            );
          }
          setEventLabel(event.eventLabel ?? '');
          setNotes(event.notes ?? '');
          setMoreOpen(Boolean(event.eventLabel || event.notes));
        } else {
          const deviceZone = deviceTimeZone();
          const wall = nowWallClock(deviceZone);
          setZone(deviceZone);
          setDate(wall.date);
          setTime(wall.time);
          setPrecision('approximate');
        }
        initialised.current = true;
      } catch (caught) {
        if (active) setLoadError(caught);
      } finally {
        if (active) setInitialLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [editing, id]);

  useEffect(() => {
    if (!initialised.current) return;
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    setDirty(true);
  }, [date, time, zone, precision, offset, affected, durationMode, minutes, seconds, triggers, aura, rescueStatus, administrations, eventLabel, notes]);

  const offsetOptions = useMemo(() => {
    if (precision === 'date_only') return [] as string[];
    if (!isRealPlainDate(date) || !isWallTime(time) || !isValidIanaZone(zone)) return [] as string[];
    try {
      return possibleOffsets(date, time, zone);
    } catch {
      return [] as string[];
    }
  }, [date, time, zone, precision]);

  useEffect(() => {
    if (offset && offsetOptions.length > 0 && !offsetOptions.includes(offset)) {
      setOffset('');
    }
  }, [offset, offsetOptions]);

  const serverFields = errorFieldMap(error);
  const summaryErrors: FormError[] = [...localErrors];
  if (error instanceof ApiError) {
    if (error.fields.length > 0) {
      for (const field of error.fields) {
        summaryErrors.push({ field: mapServerField(field.field), message: field.message });
      }
    } else {
      summaryErrors.push({ field: 'form', message: error.message });
    }
  } else if (error) {
    summaryErrors.push({ field: 'form', message: errorMessage(error) });
  }

  const setPrecisionSafely = (next: Precision) => {
    setPrecision(next);
    if (next === 'date_only') {
      setTime('');
      setOffset('');
    } else if (!time) {
      setTime(nowWallClock(zone).time);
    }
  };

  const changeRescueStatus = (next: Rescue['status']) => {
    const filled = administrations.some(
      (row) => row.name.trim() || row.dose.trim() || row.timing.trim(),
    );
    if (rescueStatus === 'used' && next !== 'used' && filled) {
      const discard = window.confirm(
        'Discard the recorded rescue administration details? They will not be saved.',
      );
      if (!discard) return;
      setAdministrations([]);
    }
    setRescueStatus(next);
  };

  const addAdministration = () => {
    if (administrations.length >= 5) return;
    setAdministrations((rows) => [
      ...rows,
      { id: crypto.randomUUID(), name: '', dose: '', timing: '' },
    ]);
  };

  const removeAdministration = (rowId: string) => {
    setAdministrations((rows) => rows.filter((row) => row.id !== rowId));
  };

  const updateAdministration = (rowId: string, key: keyof AdministrationDraft, value: string) => {
    setAdministrations((rows) =>
      rows.map((row) => (row.id === rowId ? { ...row, [key]: value } : row)),
    );
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    if (editing && id) navigate(`/events/${id}`);
    else navigate('/journal');
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const errors: FormError[] = [];

    let occurredAt: SeizureEvent['occurredAt'] | null = null;
    if (!isRealPlainDate(date)) {
      errors.push({ field: 'date', message: 'Enter a real calendar date.' });
    } else if (!isValidIanaZone(zone)) {
      errors.push({ field: 'zone', message: 'Choose a valid IANA time zone.' });
    } else if (precision === 'date_only') {
      occurredAt = { precision: 'date_only', captureDate: date, zone };
    } else if (!isWallTime(time)) {
      errors.push({ field: 'time', message: 'Enter a time as HH:MM.' });
    } else {
      const resolution = buildTimedEventTime(
        { date, time, zone, ...(offset ? { offset } : {}) },
        precision,
      );
      if (!resolution.ok) {
        if (resolution.code === 'offset_required') {
          errors.push({
            field: 'time',
            message:
              'This clock time occurs twice when the clocks change. Choose the offset that applies.',
          });
        } else {
          errors.push({ field: 'time', message: resolution.message });
        }
      } else {
        occurredAt = resolution.eventTime;
      }
    }

    let duration: SeizureEvent['duration'] | null = null;
    if (durationMode === 'not_recorded' || durationMode === 'unknown') {
      duration = { status: durationMode };
    } else {
      const minutesValue = minutes.trim() === '' ? 0 : Number.parseInt(minutes, 10);
      const secondsValue = seconds.trim() === '' ? 0 : Number.parseInt(seconds, 10);
      if (
        !Number.isInteger(minutesValue) ||
        !Number.isInteger(secondsValue) ||
        minutesValue < 0 ||
        secondsValue < 0 ||
        secondsValue > 59
      ) {
        errors.push({ field: 'duration', message: 'Enter whole minutes and 0–59 seconds.' });
      } else {
        const total = minutesValue * 60 + secondsValue;
        if (total < 1) {
          errors.push({ field: 'duration', message: 'Enter a duration or choose Not recorded.' });
        } else if (total > 86_400) {
          errors.push({ field: 'duration', message: 'Duration cannot exceed 24 hours.' });
        } else {
          duration = { status: durationMode, seconds: total };
        }
      }
    }

    let rescue: Rescue | null = null;
    if (rescueStatus !== 'used') {
      rescue = { status: rescueStatus };
    } else {
      const rows: Administration[] = [];
      let administrationError = false;
      for (const row of administrations) {
        const name = row.name.trim();
        const dose = row.dose.trim();
        const timing = row.timing.trim();
        if (!name && !dose && !timing) {
          administrationError = true;
          continue;
        }
        if (codePointLength(name) > 80 || codePointLength(dose) > 60 || codePointLength(timing) > 80) {
          administrationError = true;
          continue;
        }
        rows.push({
          id: row.id,
          ...(name ? { name } : {}),
          ...(dose ? { doseAsReported: dose } : {}),
          ...(timing ? { timingAsReported: timing } : {}),
        });
      }
      if (administrationError) {
        errors.push({
          field: 'rescue',
          message:
            'Each administration needs at least one detail, within the allowed lengths (80/60/80).',
        });
      } else {
        rescue = { status: 'used', administrations: rows };
      }
    }

    const label = eventLabel.trim();
    const notesValue = notes.trim();
    if (codePointLength(label) > 60) {
      errors.push({ field: 'eventLabel', message: 'Event label must be 60 characters or fewer.' });
    }
    if (codePointLength(notesValue) > 2000) {
      errors.push({ field: 'notes', message: 'Notes must be 2000 characters or fewer.' });
    }

    if (errors.length > 0 || !occurredAt || !duration || !rescue) {
      setLocalErrors(errors);
      setError(null);
      return;
    }

    setLocalErrors([]);
    setError(null);
    setBusy(true);
    try {
      const payload = {
        ...(editing ? {} : { id: newEventId.current }),
        occurredAt,
        duration,
        affectedAreas: affected,
        triggers,
        aura,
        rescue,
        ...(label ? { eventLabel: label } : {}),
        ...(notesValue ? { notes: notesValue } : {}),
        ...(editing && existing ? { expectedRevision: existing.revision } : {}),
        ...(settings ? { expectedDatasetEpoch: settings.datasetEpoch } : {}),
      };
      if (!csrfToken) throw new Error('Your session expired. Sign in again.');
      if (editing && id) {
        await api(`/events/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: payload,
          csrfToken,
        });
        navigate(`/events/${encodeURIComponent(id)}`, { replace: true });
      } else {
        const result = await api<{ event: SeizureEvent }>('/events', {
          method: 'POST',
          body: payload,
          csrfToken,
        });
        navigate('/journal', {
          replace: true,
          state: { highlightId: result.event.id },
        });
      }
    } catch (caught) {
      setError(caught);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  if (initialLoading) return <Spinner label="Loading entry" />;

  if (loadError) {
    const notFound = loadError instanceof ApiError && loadError.status === 404;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{notFound ? 'Entry not available' : 'Could not load entry'}</h1>
        <StatusMessage tone="error">
          {notFound
            ? 'This entry is missing or not available to your account.'
            : errorMessage(loadError)}
        </StatusMessage>
        <Link to="/journal" className="btn-secondary">
          Back to journal
        </Link>
      </div>
    );
  }

  const triggerSuggestions = tagSuggestions.filter((tag) => tag.kind === 'trigger');
  const auraSuggestions = tagSuggestions.filter((tag) => tag.kind === 'aura');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{editing ? 'Edit event' : 'New event'}</h1>
        <Link to="/journal" className="link">
          Back to journal
        </Link>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorSummary errors={summaryErrors} />

        {error instanceof ApiError && error.isNetwork ? (
          <StatusMessage tone="warning">
            Not saved. Connect to your home network or WireGuard and retry. Your changes are still
            on this screen.
          </StatusMessage>
        ) : null}
        {error instanceof ApiError && error.code === 'stale_revision' ? (
          <StatusMessage tone="warning">
            This entry changed on another device. Your draft is still here; reload the latest
            entry before saving again.
          </StatusMessage>
        ) : null}
        {error instanceof ApiError && error.code === 'stale_dataset' ? (
          <StatusMessage tone="warning">
            The diary changed since this form opened. Reload before saving so you do not overwrite
            newer data.
          </StatusMessage>
        ) : null}

        <section className="card space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Timestamp</h2>
            <p className="muted">
              Only the timestamp is required. Future dates and times more than five minutes ahead
              are rejected.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="field-date" className="field-label">
                Date
              </label>
              <input
                id="field-date"
                type="date"
                className="field-input"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                aria-invalid={Boolean(serverFields.occurredAt)}
              />
            </div>
            <div>
              <label htmlFor="field-time" className="field-label">
                Time
              </label>
              <input
                id="field-time"
                type="time"
                className="field-input"
                value={time}
                disabled={precision === 'date_only'}
                onChange={(event) => {
                  setTime(event.target.value);
                  setOffset('');
                }}
              />
              {precision === 'date_only' ? (
                <p className="muted mt-1">Not recorded for a date-only entry.</p>
              ) : null}
            </div>
          </div>
          <fieldset>
            <legend className="field-label">Precision</legend>
            <div className="flex flex-wrap gap-3">
              {(['exact', 'approximate', 'date_only'] as Precision[]).map((value) => (
                <label key={value} className="flex min-h-[44px] items-center gap-2">
                  <input
                    type="radio"
                    name="precision"
                    value={value}
                    checked={precision === value}
                    onChange={() => setPrecisionSafely(value)}
                  />
                  <span>
                    {value === 'exact' ? 'Exact' : value === 'approximate' ? 'Approximate' : 'Date only'}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="field-zone" className="field-label">
              Entry time zone
            </label>
            <ZoneSelect id="field-zone" value={zone} onChange={setZone} />
          </div>
          {precision !== 'date_only' && offsetOptions.length > 1 ? (
            <div>
              <label htmlFor="field-offset" className="field-label">
                This time occurs twice — choose the offset
              </label>
              <select
                id="field-offset"
                className="field-input"
                value={offset}
                onChange={(event) => setOffset(event.target.value)}
              >
                <option value="">Choose an offset</option>
                {offsetOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <p className="muted mt-1">
                The clocks change at this time. Choose the offset that matches the actual instant.
              </p>
            </div>
          ) : null}
        </section>

        <section className="card">
          <AffectedAreasField value={affected} onChange={setAffected} />
        </section>

        <section id="field-duration" tabIndex={-1} className="card space-y-3">
          <h2 className="text-lg font-semibold">Duration</h2>
          <div>
            <label htmlFor="duration-mode" className="field-label">
              Duration accuracy
            </label>
            <select
              id="duration-mode"
              className="field-input"
              value={durationMode}
              onChange={(event) => {
                const next = event.target.value as DurationMode;
                setDurationMode(next);
              }}
            >
              <option value="not_recorded">Not recorded</option>
              <option value="estimated">Estimated</option>
              <option value="exact">Exact</option>
              <option value="unknown">Unsure</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="duration-minutes" className="field-label">
                Minutes
              </label>
              <input
                id="duration-minutes"
                type="number"
                inputMode="numeric"
                min={0}
                max={1440}
                className="field-input"
                value={minutes}
                disabled={durationMode === 'unknown'}
                onChange={(event) => {
                  setMinutes(event.target.value);
                  if (durationMode === 'not_recorded') setDurationMode('estimated');
                }}
              />
            </div>
            <div>
              <label htmlFor="duration-seconds" className="field-label">
                Seconds
              </label>
              <input
                id="duration-seconds"
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                className="field-input"
                value={seconds}
                disabled={durationMode === 'unknown'}
                onChange={(event) => {
                  setSeconds(event.target.value);
                  if (durationMode === 'not_recorded') setDurationMode('estimated');
                }}
              />
            </div>
          </div>
          <p className="muted">Blank is not zero. Entering a value defaults to Estimated.</p>
        </section>

        <section className="card">
          <TagPicker
            id="triggers"
            legend="Possible triggers"
            hint="Record possible triggers without judging cause. Examples are suggestions only."
            kind="trigger"
            value={triggers}
            suggestions={triggerSuggestions}
            onChange={setTriggers}
          />
        </section>

        <section className="card">
          <TagPicker
            id="aura"
            legend="Aura / warning"
            hint="Describe what you noticed, if anything. This is not a diagnosis."
            kind="aura"
            value={aura}
            suggestions={auraSuggestions}
            onChange={setAura}
          />
        </section>

        <fieldset id="field-rescue" tabIndex={-1} className="card space-y-3">
          <legend className="field-label">Rescue medication</legend>
          <p className="muted">
            Record what was used, as reported. The app does not suggest drugs, doses, units or
            instructions.
          </p>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ['not_recorded', 'Not recorded'],
                ['not_used', 'Not used'],
                ['used', 'Used'],
                ['unknown', 'Unsure'],
              ] as [Rescue['status'], string][]
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-[44px] items-center gap-2">
                <input
                  type="radio"
                  name="rescue"
                  value={value}
                  checked={rescueStatus === value}
                  onChange={() => changeRescueStatus(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {rescueStatus === 'used' ? (
            <div className="space-y-3">
              <p className="muted">
                {administrations.length === 0
                  ? 'Used; details not recorded is a valid answer.'
                  : 'Add up to five administrations. Each row needs at least one recorded detail.'}
              </p>
              {administrations.map((row, index) => (
                <fieldset key={row.id} className="rounded-lg border border-slate-200 p-3">
                  <legend className="px-1 text-sm font-semibold">Administration {index + 1}</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <label htmlFor={`admin-name-${row.id}`} className="field-label">
                        Name as reported
                      </label>
                      <input
                        id={`admin-name-${row.id}`}
                        className="field-input"
                        value={row.name}
                        maxLength={80}
                        onChange={(event) => updateAdministration(row.id, 'name', event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor={`admin-dose-${row.id}`} className="field-label">
                        Dose as reported
                      </label>
                      <input
                        id={`admin-dose-${row.id}`}
                        className="field-input"
                        value={row.dose}
                        maxLength={60}
                        onChange={(event) => updateAdministration(row.id, 'dose', event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor={`admin-timing-${row.id}`} className="field-label">
                        Timing as reported
                      </label>
                      <input
                        id={`admin-timing-${row.id}`}
                        className="field-input"
                        value={row.timing}
                        maxLength={80}
                        placeholder="e.g. about 2 minutes after start"
                        onChange={(event) => updateAdministration(row.id, 'timing', event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="mt-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => removeAdministration(row.id)}
                    >
                      Remove administration
                    </button>
                  </div>
                </fieldset>
              ))}
              <button
                type="button"
                className="btn-secondary"
                onClick={addAdministration}
                disabled={administrations.length >= 5}
              >
                + Add administration
              </button>
            </div>
          ) : null}
        </fieldset>

        <section className="card space-y-3">
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            More details {moreOpen ? '▾' : '▸'}
          </button>
          {moreOpen ? (
            <div className="space-y-3">
              <div>
                <label htmlFor="field-eventLabel" className="field-label">
                  Event label (optional)
                </label>
                <input
                  id="field-eventLabel"
                  className="field-input"
                  value={eventLabel}
                  maxLength={60}
                  onChange={(event) => setEventLabel(event.target.value)}
                  placeholder="Your own description, not a clinical classification"
                />
                <p className="muted mt-1">{codePointLength(eventLabel)}/60</p>
              </div>
              <div>
                <label htmlFor="field-notes" className="field-label">
                  Notes (optional)
                </label>
                <textarea
                  id="field-notes"
                  className="field-input min-h-[120px]"
                  value={notes}
                  maxLength={2000}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What happened, recovery, or other observations"
                />
                <p className="muted mt-1">{codePointLength(notes)}/2000</p>
              </div>
            </div>
          ) : null}
        </section>

        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-200 bg-slatebg/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:mx-0 sm:rounded-xl sm:border">
          <button type="submit" className="btn-primary flex-1" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-secondary" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

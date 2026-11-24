import { Temporal } from '@js-temporal/polyfill';
import type { AffectedAreas, EventTime, SeizureEvent, TagAnswer } from '@shared/types';
import { captureDateForInstant, offsetAtInstant } from '@shared/time';

let counter = 0;

export function nextUuid(prefix = '00000000-0000-4000-8000'): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(12, '0')}`;
}

export interface TimedEventOptions {
  id?: string;
  instantUtc: string;
  zone?: string;
  precision?: 'exact' | 'approximate';
  affectedAreas?: AffectedAreas;
  duration?: SeizureEvent['duration'];
  triggers?: TagAnswer;
  aura?: TagAnswer;
  rescue?: SeizureEvent['rescue'];
  eventLabel?: string;
  notes?: string;
}

export function timedEvent(options: TimedEventOptions): SeizureEvent {
  const zone = options.zone ?? 'UTC';
  const zdt = Temporal.Instant.from(options.instantUtc).toZonedDateTimeISO(zone);
  const occurredAt: EventTime = {
    precision: options.precision ?? 'exact',
    captureDate: captureDateForInstant(options.instantUtc, zone),
    wallTime: zdt.toPlainTime().toString({ smallestUnit: 'minute' }),
    zone,
    offset: offsetAtInstant(options.instantUtc, zone),
    instantUtc: options.instantUtc,
  };
  return baseEvent(options.id ?? nextUuid(), occurredAt, options);
}

export function dateOnlyEvent(
  date: string,
  options: Partial<TimedEventOptions> & { id?: string; zone?: string } = {},
): SeizureEvent {
  const occurredAt: EventTime = {
    precision: 'date_only',
    captureDate: date,
    zone: options.zone ?? 'UTC',
  };
  return baseEvent(options.id ?? nextUuid(), occurredAt, options);
}

function baseEvent(
  id: string,
  occurredAt: EventTime,
  options: Partial<TimedEventOptions>,
): SeizureEvent {
  const timestamp = '2026-11-24T12:00:00Z';
  const event: SeizureEvent = {
    id,
    captureDate: occurredAt.captureDate,
    occurredAt,
    duration: options.duration ?? { status: 'not_recorded' },
    affectedAreas: options.affectedAreas ?? { status: 'not_recorded' },
    triggers: options.triggers ?? { status: 'not_recorded' },
    aura: options.aura ?? { status: 'not_recorded' },
    rescue: options.rescue ?? { status: 'not_recorded' },
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
  if (options.eventLabel) event.eventLabel = options.eventLabel;
  if (options.notes) event.notes = options.notes;
  return event;
}

export const tagStress = { id: 'trigger-stress', label: 'Stress' };
export const tagPoorSleep = { id: 'trigger-poor-sleep', label: 'Poor sleep' };
export const tagAuraSmell = { id: 'aura-unusual-smell', label: 'Unusual smell' };

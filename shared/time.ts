import { Temporal } from '@js-temporal/polyfill';
import type { EventTime, PlainDateString } from './types';

export type TimedEventTime = Extract<EventTime, { precision: 'exact' | 'approximate' }>;
export type DateOnlyEventTime = Extract<EventTime, { precision: 'date_only' }>;

export type WallTimeResolution =
  | { ok: true; eventTime: TimedEventTime }
  | {
      ok: false;
      code:
        | 'invalid_zone'
        | 'invalid_date'
        | 'invalid_time'
        | 'dst_gap'
        | 'offset_required'
        | 'offset_invalid';
      message: string;
      allowedOffsets?: string[];
    };

const zoneCache = new Map<string, boolean>();

export function isValidIanaZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  if (/^[+-]/.test(zone) || /^\d/.test(zone)) return false;
  const cached = zoneCache.get(zone);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    valid = true;
  } catch {
    valid = false;
  }
  zoneCache.set(zone, valid);
  return valid;
}

export function isRealPlainDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    const parsed = Temporal.PlainDate.from(value, { overflow: 'reject' });
    return parsed.toString() === value;
  } catch {
    return false;
  }
}

export function parsePlainDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value, { overflow: 'reject' });
}

export function isIsoInstant(value: string): boolean {
  if (!/Z$/.test(value)) return false;
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}

export function canonicalInstant(value: string): string {
  return Temporal.Instant.from(value).toString();
}

export function isWallTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function makePlainDateTime(date: string, time: string): Temporal.PlainDateTime {
  const [h, m] = time.split(':').map((part) => Number(part));
  return parsePlainDate(date).toPlainDateTime({ hour: h ?? 0, minute: m ?? 0 });
}

export function offsetAtInstant(instantUtc: string, zone: string): string {
  return Temporal.Instant.from(instantUtc).toZonedDateTimeISO(zone).offset;
}

export function captureDateForInstant(instantUtc: string, zone: string): PlainDateString {
  return Temporal.Instant.from(instantUtc).toZonedDateTimeISO(zone).toPlainDate().toString();
}

export function nowInstant(): string {
  return Temporal.Now.instant().toString();
}

export function addSecondsToInstant(instantUtc: string, seconds: number): string {
  return Temporal.Instant.from(instantUtc).add({ seconds }).toString();
}

export function compareInstants(a: string, b: string): number {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b));
}

export function todayInZone(zone: string): PlainDateString {
  return Temporal.Now.plainDateISO(zone).toString();
}

export function nowWallClock(zone: string): { date: PlainDateString; time: string } {
  const zdt = Temporal.Now.zonedDateTimeISO(zone);
  return {
    date: zdt.toPlainDate().toString(),
    time: zdt.toPlainTime().toString({ smallestUnit: 'minute' }),
  };
}

/** Allowed offsets for a wall time. Length 2 means the wall time is repeated. */
export function possibleOffsets(date: string, time: string, zone: string): string[] {
  const pdt = makePlainDateTime(date, time);
  const earlier = pdt.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = pdt.toZonedDateTime(zone, { disambiguation: 'later' });
  const offsets = new Set<string>();
  if (earlier.toPlainDateTime().equals(pdt)) offsets.add(earlier.offset);
  if (later.toPlainDateTime().equals(pdt)) offsets.add(later.offset);
  return [...offsets];
}

export function resolveWallTime(args: {
  date: string;
  time: string;
  zone: string;
  offset?: string;
  precision?: 'exact' | 'approximate';
}): WallTimeResolution {
  const { date, time, zone, offset } = args;
  const precision = args.precision ?? 'exact';
  if (!isValidIanaZone(zone)) {
    return { ok: false, code: 'invalid_zone', message: 'Choose a valid IANA time zone.' };
  }
  if (!isRealPlainDate(date)) {
    return { ok: false, code: 'invalid_date', message: 'Enter a real calendar date.' };
  }
  if (!isWallTime(time)) {
    return { ok: false, code: 'invalid_time', message: 'Enter a time as HH:MM.' };
  }

  const pdt = makePlainDateTime(date, time);

  let resolved: Temporal.ZonedDateTime | null = null;
  try {
    resolved = pdt.toZonedDateTime(zone, { disambiguation: 'reject' });
  } catch {
    resolved = null;
  }

  if (resolved) {
    if (offset !== undefined && offset !== resolved.offset) {
      return {
        ok: false,
        code: 'offset_invalid',
        message: `The offset ${offset} does not match ${zone} at that time (${resolved.offset}).`,
        allowedOffsets: [resolved.offset],
      };
    }
    return { ok: true, eventTime: timedEventTime(resolved, precision) };
  }

  const earlier = pdt.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = pdt.toZonedDateTime(zone, { disambiguation: 'later' });
  const earlierMatches = earlier.toPlainDateTime().equals(pdt);
  const laterMatches = later.toPlainDateTime().equals(pdt);

  if (earlierMatches && laterMatches) {
    const uniqueAllowed = [...new Set([earlier.offset, later.offset])];
    if (!offset) {
      return {
        ok: false,
        code: 'offset_required',
        message:
          'This clock time occurs twice when the clocks change. Choose which offset applies.',
        allowedOffsets: uniqueAllowed,
      };
    }
    const chosen = uniqueAllowed.includes(offset)
      ? earlier.offset === offset
        ? earlier
        : later
      : null;
    if (!chosen) {
      return {
        ok: false,
        code: 'offset_invalid',
        message: `Choose one of the two offsets for this repeated time: ${uniqueAllowed.join(' or ')}.`,
        allowedOffsets: uniqueAllowed,
      };
    }
    return { ok: true, eventTime: timedEventTime(chosen, precision) };
  }

  return {
    ok: false,
    code: 'dst_gap',
    message:
      'That clock time does not exist in this time zone because the clocks changed. Choose another time.',
  };
}

function timedEventTime(
  zdt: Temporal.ZonedDateTime,
  precision: 'exact' | 'approximate',
): TimedEventTime {
  const wall = zdt.toPlainTime().toString({ smallestUnit: 'minute' });
  return {
    precision,
    captureDate: zdt.toPlainDate().toString(),
    wallTime: wall,
    zone: zdt.timeZoneId ?? 'UTC',
    offset: zdt.offset,
    instantUtc: zdt.toInstant().toString(),
  };
}

/** Build a timed EventTime with the caller's chosen precision. */
export function buildTimedEventTime(
  args: { date: string; time: string; zone: string; offset?: string },
  precision: 'exact' | 'approximate',
): WallTimeResolution {
  return resolveWallTime({ ...args, precision });
}

export function buildDateOnlyEventTime(date: string, zone: string): EventTime {
  return { precision: 'date_only', captureDate: date, zone };
}

export function eventInstant(event: EventTime): string | null {
  return event.precision === 'date_only' ? null : event.instantUtc;
}

/** Reporting calendar date: date-only keeps its own date; timed uses the instant in the report zone. */
export function reportDateFor(event: EventTime, reportZone: string): PlainDateString {
  if (event.precision === 'date_only') return event.captureDate;
  return captureDateForInstant(event.instantUtc, reportZone);
}

export function compareReportDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the timed entry's stored fields reproduce its wall time, date, zone and offset. */
export function reproducesWallTime(event: TimedEventTime): boolean {
  try {
    const zdt = Temporal.Instant.from(event.instantUtc).toZonedDateTimeISO(event.zone);
    return (
      zdt.toPlainDate().toString() === event.captureDate &&
      zdt.toPlainTime().toString({ smallestUnit: 'minute' }) === event.wallTime &&
      zdt.offset === event.offset
    );
  } catch {
    return false;
  }
}

export function addDays(date: PlainDateString, days: number): PlainDateString {
  return parsePlainDate(date).add({ days }).toString();
}

export function differenceInCalendarDays(start: PlainDateString, end: PlainDateString): number {
  return parsePlainDate(start).until(parsePlainDate(end)).days;
}

export function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatPlainDate(date: PlainDateString): string {
  const [y, m, d] = date.split('-').map((p) => Number(p));
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function formatPlainDateNumeric(date: PlainDateString): string {
  return date;
}

export function formatTimestamp(instantUtc: string): string {
  const zdt = Temporal.Instant.from(instantUtc).toZonedDateTimeISO('UTC');
  const pdt = zdt.toPlainDateTime();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pdt.year}-${pad(pdt.month)}-${pad(pdt.day)} ${pad(pdt.hour)}:${pad(
    pdt.minute,
  )}:${pad(pdt.second)} UTC`;
}

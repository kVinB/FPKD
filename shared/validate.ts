import { Temporal } from '@js-temporal/polyfill';
import type { EventTime } from './types';
import { isRealPlainDate, isValidIanaZone, reproducesWallTime, todayInZone } from './time';

export interface EventTimeValidationIssue {
  code: string;
  message: string;
}

/**
 * Server-authoritative temporal validation for a diary entry.
 * `nowInstantUtc` must come from the server clock.
 */
export function validateEventTime(
  occurredAt: EventTime,
  nowInstantUtc: string,
): EventTimeValidationIssue[] {
  const issues: EventTimeValidationIssue[] = [];

  if (!isValidIanaZone(occurredAt.zone)) {
    issues.push({ code: 'invalid_zone', message: 'Choose a valid IANA time zone.' });
    return issues;
  }
  if (!isRealPlainDate(occurredAt.captureDate)) {
    issues.push({ code: 'invalid_capture_date', message: 'Enter a real calendar date.' });
    return issues;
  }

  if (occurredAt.precision === 'date_only') {
    if (occurredAt.captureDate > todayInZone(occurredAt.zone)) {
      issues.push({ code: 'future_date', message: 'The capture date cannot be in the future.' });
    }
    return issues;
  }

  if (!reproducesWallTime(occurredAt)) {
    issues.push({
      code: 'inconsistent_instant',
      message:
        'The stored instant does not reproduce the entered wall time, zone and offset. Check the date, time and DST choice.',
    });
  }

  try {
    const instant = Temporal.Instant.from(occurredAt.instantUtc);
    const limit = Temporal.Instant.from(nowInstantUtc).add({ minutes: 5 });
    if (Temporal.Instant.compare(instant, limit) > 0) {
      issues.push({
        code: 'future_time',
        message: 'Timed entries cannot be more than five minutes in the future.',
      });
    }
  } catch {
    issues.push({ code: 'invalid_instant', message: 'The instant is not valid ISO 8601 UTC.' });
  }

  return issues;
}

import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import {
  buildTimedEventTime,
  reportDateFor,
  reproducesWallTime,
  resolveWallTime,
  type TimedEventTime,
} from '@shared/time';
import { validateEventTime } from '@shared/validate';
import { dateOnlyEvent, timedEvent } from '../fixtures/events';

describe('DST handling (A03)', () => {
  it('rejects the spring-forward gap in Europe/Dublin', () => {
    const result = resolveWallTime({
      date: '2026-03-29',
      time: '01:30',
      zone: 'Europe/Dublin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('dst_gap');
  });

  it('requires an explicit offset for the repeated autumn time', () => {
    const result = resolveWallTime({
      date: '2026-10-25',
      time: '01:30',
      zone: 'Europe/Dublin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('offset_required');
      expect(result.allowedOffsets?.sort()).toEqual(['+00:00', '+01:00']);
    }
  });

  it('produces instants exactly one hour apart for the two repeated offsets', () => {
    const first = resolveWallTime({
      date: '2026-10-25',
      time: '01:30',
      zone: 'Europe/Dublin',
      offset: '+01:00',
    });
    const second = resolveWallTime({
      date: '2026-10-25',
      time: '01:30',
      zone: 'Europe/Dublin',
      offset: '+00:00',
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      const delta =
        Temporal.Instant.from(second.eventTime.instantUtc).epochMilliseconds -
        Temporal.Instant.from(first.eventTime.instantUtc).epochMilliseconds;
      expect(delta).toBe(3_600_000);
      expect(reproducesWallTime(first.eventTime)).toBe(true);
      expect(reproducesWallTime(second.eventTime)).toBe(true);
    }
  });

  it('rejects an offset that does not match an unambiguous time', () => {
    const result = buildTimedEventTime(
      { date: '2026-11-24', time: '10:00', zone: 'Europe/Dublin', offset: '+05:00' },
      'exact',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('offset_invalid');
  });

  it('canonicalises a valid wall time', () => {
    const result = buildTimedEventTime(
      { date: '2026-11-24', time: '10:00', zone: 'Europe/Dublin' },
      'approximate',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventTime.precision).toBe('approximate');
      expect(result.eventTime.offset).toBe('+00:00');
      expect(result.eventTime.instantUtc).toBe('2026-11-24T10:00:00Z');
      expect(reproducesWallTime(result.eventTime)).toBe(true);
    }
  });
});

describe('report date assignment (A03/A04)', () => {
  it('never shifts a date-only event when the report zone changes', () => {
    const event = dateOnlyEvent('2026-11-24', { zone: 'Australia/Sydney' });
    expect(reportDateFor(event.occurredAt, 'America/New_York')).toBe('2026-11-24');
    expect(reportDateFor(event.occurredAt, 'Asia/Tokyo')).toBe('2026-11-24');
  });

  it('can move a timed event near midnight into a different report bucket', () => {
    const event = timedEvent({ instantUtc: '2026-11-24T23:30:00Z', zone: 'UTC' });
    expect(reportDateFor(event.occurredAt, 'America/New_York')).toBe('2026-11-24');
    expect(reportDateFor(event.occurredAt, 'Asia/Tokyo')).toBe('2026-11-25');
  });
});

describe('server temporal validation', () => {
  const now = '2026-11-24T12:00:00Z';

  it('accepts a consistent past timed entry', () => {
    const event = timedEvent({ instantUtc: '2026-11-24T10:00:00Z' });
    expect(validateEventTime(event.occurredAt, now)).toEqual([]);
  });

  it('rejects times more than five minutes ahead', () => {
    const tooFar = timedEvent({ instantUtc: '2026-11-24T12:06:00Z' });
    const issueCodes = validateEventTime(tooFar.occurredAt, now).map((issue) => issue.code);
    expect(issueCodes).toContain('future_time');

    const allowed = timedEvent({ instantUtc: '2026-11-24T12:04:00Z' });
    expect(validateEventTime(allowed.occurredAt, now)).toEqual([]);
  });

  it('rejects an inconsistent stored instant', () => {
    const event = timedEvent({ instantUtc: '2026-11-24T10:00:00Z' });
    const tampered = {
      ...(event.occurredAt as TimedEventTime),
      wallTime: '11:00',
    };
    const codes = validateEventTime(tampered, now).map((issue) => issue.code);
    expect(codes).toContain('inconsistent_instant');
  });

  it('rejects a far-future date-only entry', () => {
    const event = dateOnlyEvent('2999-01-01');
    const codes = validateEventTime(event.occurredAt, now).map((issue) => issue.code);
    expect(codes).toContain('future_date');
  });
});

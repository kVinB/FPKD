import { describe, expect, it } from 'vitest';
import {
  aggregate,
  buildBuckets,
  median,
  validateRange,
  weekStart,
  type ReportRange,
} from '@shared/range';
import { dateOnlyEvent, timedEvent, tagStress } from '../fixtures/events';

const dayRange: ReportRange = { start: '2026-11-01', end: '2026-11-07', granularity: 'day' };

describe('range validation', () => {
  it('accepts an ordinary range', () => {
    const result = validateRange({
      start: '2026-11-01',
      end: '2026-11-07',
      granularity: 'day',
      today: '2026-11-24',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects reversed and future ranges and invalid granularity', () => {
    expect(
      validateRange({
        start: '2026-11-08',
        end: '2026-11-07',
        granularity: 'day',
        today: '2026-11-24',
      }).ok,
    ).toBe(false);
    const future = validateRange({
      start: '2026-11-01',
      end: '2026-11-30',
      granularity: 'day',
      today: '2026-11-24',
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.code).toBe('future_range');
    const bad = validateRange({
      start: '2026-11-01',
      end: '2026-11-07',
      granularity: 'year',
      today: '2026-11-24',
    });
    expect(bad.ok).toBe(false);
  });

  it('caps custom ranges at five calendar years', () => {
    const result = validateRange({
      start: '2014-01-01',
      end: '2026-11-24',
      granularity: 'month',
      today: '2026-11-24',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('range_too_long');
  });
});

describe('bucket building', () => {
  it('fills zero buckets across a day range', () => {
    const buckets = buildBuckets(dayRange);
    expect(buckets).toHaveLength(7);
    expect(buckets.every((bucket) => bucket.count === 0 && !bucket.partial)).toBe(true);
  });

  it('uses Monday weeks and marks clipped edges partial', () => {
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
    const buckets = buildBuckets({
      start: '2026-11-01',
      end: '2026-11-10',
      granularity: 'week',
    });
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(buckets[0]?.partial).toBe(true);
    expect(buckets[1]?.partial).toBe(false);
    expect(buckets[2]?.partial).toBe(true);
  });

  it('builds month buckets', () => {
    const buckets = buildBuckets({
      start: '2026-10-15',
      end: '2026-12-02',
      granularity: 'month',
    });
    expect(buckets.map((bucket) => bucket.key)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
    expect(buckets[0]?.partial).toBe(true);
    expect(buckets[2]?.partial).toBe(true);
  });
});

describe('aggregation', () => {
  const events = [
    timedEvent({
      instantUtc: '2026-11-01T09:00:00Z',
      affectedAreas: { status: 'reported', areas: ['arms', 'speech'] },
      duration: { status: 'exact', seconds: 60 },
      triggers: { status: 'reported', tags: [tagStress] },
      rescue: {
        status: 'used',
        administrations: [
          { id: '11111111-1111-4111-8111-111111111111', name: 'A' },
          { id: '22222222-2222-4222-8222-222222222222', name: 'B' },
        ],
      },
    }),
    timedEvent({
      instantUtc: '2026-11-01T18:00:00Z',
      affectedAreas: { status: 'reported', areas: ['legs'] },
      duration: { status: 'estimated', seconds: 90 },
      triggers: { status: 'reported', tags: [tagStress] },
    }),
    dateOnlyEvent('2026-11-03', {
      affectedAreas: { status: 'unknown' },
      duration: { status: 'unknown' },
    }),
    timedEvent({ instantUtc: '2026-11-07T23:00:00Z' }),
    timedEvent({ instantUtc: '2026-10-31T23:00:00Z' }),
    timedEvent({ instantUtc: '2026-11-08T00:30:00Z' }),
  ];

  it('counts one episode once regardless of areas, tags or administrations', () => {
    const result = aggregate(events, { reportZone: 'UTC', range: dayRange });
    expect(result.summary.totalEvents).toBe(4);
    expect(result.summary.distinctDates).toBe(3);
    expect(result.summary.rescueUsed).toBe(1);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
  });

  it('excludes out-of-range events by report date', () => {
    const result = aggregate(events, { reportZone: 'UTC', range: dayRange });
    const counted = result.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(counted).toBe(4);
  });

  it('computes the median of known durations and the right denominator', () => {
    const result = aggregate(events, { reportZone: 'UTC', range: dayRange });
    expect(result.summary.durationsRecorded).toBe(2);
    expect(result.summary.medianDurationSeconds).toBe(75);
    expect(median([60])).toBe(60);
    expect(median([])).toBeNull();
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('counts areas once per event and reports how many answered', () => {
    const result = aggregate(events, { reportZone: 'UTC', range: dayRange });
    expect(result.summary.areaCounts).toEqual({ arms: 1, legs: 1, speech: 1 });
    expect(result.summary.areaAnswered).toBe(3);
    const areaSum =
      result.summary.areaCounts.arms +
      result.summary.areaCounts.legs +
      result.summary.areaCounts.speech;
    expect(areaSum).toBe(3);
    expect(areaSum).toBeGreaterThan(2);
  });

  it('places date-only events on their recorded date even when report zone differs', () => {
    const dateOnly = dateOnlyEvent('2026-11-03', { zone: 'Pacific/Auckland' });
    const result = aggregate([dateOnly], {
      reportZone: 'America/Los_Angeles',
      range: dayRange,
    });
    expect(result.summary.totalEvents).toBe(1);
    expect(result.buckets.find((bucket) => bucket.key === '2026-11-03')?.count).toBe(1);
  });
});

import { Temporal } from '@js-temporal/polyfill';
import type {
  AffectedArea,
  DiarySettings,
  PlainDateString,
  Rescue,
  SeizureEvent,
  TagAnswer,
} from './types';
import { differenceInCalendarDays, parsePlainDate, reportDateFor } from './time';

export type Granularity = 'day' | 'week' | 'month';

export interface ReportRange {
  start: PlainDateString;
  end: PlainDateString;
  granularity: Granularity;
}

export type RangeValidation =
  | {
      ok: true;
      range: ReportRange;
      daySpan: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

const MAX_RANGE_YEARS = 5;

export function validateRange(input: {
  start: string;
  end: string;
  granularity: string;
  today: PlainDateString;
}): RangeValidation {
  const { start, end, granularity, today } = input;
  if (granularity !== 'day' && granularity !== 'week' && granularity !== 'month') {
    return { ok: false, code: 'invalid_granularity', message: 'Choose day, week or month.' };
  }
  let startDate: Temporal.PlainDate;
  let endDate: Temporal.PlainDate;
  try {
    startDate = parsePlainDate(start);
  } catch {
    return { ok: false, code: 'invalid_start', message: 'Enter a real start date.' };
  }
  try {
    endDate = parsePlainDate(end);
  } catch {
    return { ok: false, code: 'invalid_end', message: 'Enter a real end date.' };
  }
  if (Temporal.PlainDate.compare(startDate, endDate) > 0) {
    return { ok: false, code: 'reversed_range', message: 'The start date must be on or before the end date.' };
  }
  const todayDate = parsePlainDate(today);
  if (Temporal.PlainDate.compare(endDate, todayDate) > 0) {
    return { ok: false, code: 'future_range', message: 'The end date cannot be in the future.' };
  }
  const daySpan = startDate.until(endDate).days + 1;
  if (daySpan > MAX_RANGE_YEARS * 366) {
    return {
      ok: false,
      code: 'range_too_long',
      message: `Ranges are capped at ${MAX_RANGE_YEARS} calendar years.`,
    };
  }
  return {
    ok: true,
    range: { start: startDate.toString(), end: endDate.toString(), granularity },
    daySpan,
  };
}

export function defaultRange(days: 30 | 90, today: PlainDateString): ReportRange {
  const end = parsePlainDate(today);
  const start = end.subtract({ days: days - 1 });
  return { start: start.toString(), end: end.toString(), granularity: 'week' };
}

export function weekStart(date: PlainDateString): PlainDateString {
  const d = parsePlainDate(date);
  return d.subtract({ days: d.dayOfWeek - 1 }).toString();
}

export function monthStart(date: PlainDateString): PlainDateString {
  const d = parsePlainDate(date);
  return d.with({ day: 1 }).toString();
}

export interface Bucket {
  key: string;
  start: PlainDateString;
  end: PlainDateString;
  partial: boolean;
  count: number;
}

export function bucketKeyFor(date: PlainDateString, granularity: Granularity): string {
  if (granularity === 'day') return date;
  if (granularity === 'week') return weekStart(date);
  return monthStart(date);
}

export function buildBuckets(range: ReportRange): Bucket[] {
  const start = parsePlainDate(range.start);
  const end = parsePlainDate(range.end);
  const buckets: Bucket[] = [];

  if (range.granularity === 'day') {
    let cursor = start;
    while (Temporal.PlainDate.compare(cursor, end) <= 0) {
      const key = cursor.toString();
      buckets.push({ key, start: key, end: key, partial: false, count: 0 });
      cursor = cursor.add({ days: 1 });
    }
    return buckets;
  }

  if (range.granularity === 'week') {
    let cursor = parsePlainDate(weekStart(range.start));
    const last = parsePlainDate(weekStart(range.end));
    while (Temporal.PlainDate.compare(cursor, last) <= 0) {
      const bucketEnd = cursor.add({ days: 6 });
      buckets.push({
        key: cursor.toString(),
        start: cursor.toString(),
        end: bucketEnd.toString(),
        partial:
          Temporal.PlainDate.compare(cursor, start) < 0 ||
          Temporal.PlainDate.compare(bucketEnd, end) > 0,
        count: 0,
      });
      cursor = cursor.add({ days: 7 });
    }
    return buckets;
  }

  let cursor = parsePlainDate(monthStart(range.start));
  const last = parsePlainDate(monthStart(range.end));
  while (Temporal.PlainDate.compare(cursor, last) <= 0) {
    const bucketEnd = cursor.add({ months: 1 }).subtract({ days: 1 });
    buckets.push({
      key: cursor.toString(),
      start: cursor.toString(),
      end: bucketEnd.toString(),
      partial:
        Temporal.PlainDate.compare(cursor, start) < 0 ||
        Temporal.PlainDate.compare(bucketEnd, end) > 0,
      count: 0,
    });
    cursor = cursor.add({ months: 1 });
  }
  return buckets;
}

export interface TagCount {
  id: string;
  label: string;
  count: number;
}

export interface AnalyticsSummary {
  totalEvents: number;
  distinctDates: number;
  rescueUsed: number;
  durationsRecorded: number;
  medianDurationSeconds: number | null;
  areaCounts: Record<AffectedArea, number>;
  areaAnswered: number;
  triggerTagCounts: TagCount[];
  auraTagCounts: TagCount[];
  triggerAnswered: number;
  auraAnswered: number;
}

export interface AnalyticsResult {
  range: ReportRange;
  reportZone: string;
  buckets: Bucket[];
  summary: AnalyticsSummary;
  dataVersion: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

export interface AggregateOptions {
  reportZone: string;
  range: ReportRange;
  dataVersion?: number;
}

function collectTagCounts(
  answer: TagAnswer,
  counts: Map<string, { label: string; count: number }>,
): number {
  if (answer.status === 'not_recorded') return 0;
  if (answer.status !== 'reported') return 1;
  const seen = new Set<string>();
  for (const tag of answer.tags) {
    if (seen.has(tag.id)) continue;
    seen.add(tag.id);
    const existing = counts.get(tag.id);
    if (existing) existing.count += 1;
    else counts.set(tag.id, { label: tag.label, count: 1 });
  }
  return 1;
}

function sortedTagCounts(
  counts: Map<string, { label: string; count: number }>,
): TagCount[] {
  return [...counts.entries()]
    .map(([id, value]) => ({ id, label: value.label, count: value.count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
}

export function aggregate(
  events: SeizureEvent[],
  options: AggregateOptions,
): AnalyticsResult {
  const { reportZone, range } = options;
  const buckets = buildBuckets(range);
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const dates = new Set<string>();
  const durationValues: number[] = [];
  const areaCounts: Record<AffectedArea, number> = { arms: 0, legs: 0, speech: 0 };
  const triggerCounts = new Map<string, { label: string; count: number }>();
  const auraCounts = new Map<string, { label: string; count: number }>();
  let areaAnswered = 0;
  let triggerAnswered = 0;
  let auraAnswered = 0;
  let rescueUsed = 0;
  let totalEvents = 0;

  for (const event of events) {
    const reportDate = reportDateFor(event.occurredAt, reportZone);
    if (reportDate < range.start || reportDate > range.end) continue;

    totalEvents += 1;
    dates.add(reportDate);

    const key = bucketKeyFor(reportDate, range.granularity);
    const bucket = byKey.get(key);
    if (bucket) bucket.count += 1;

    if (event.rescue.status === 'used') rescueUsed += 1;

    if (event.duration.status === 'exact' || event.duration.status === 'estimated') {
      durationValues.push(event.duration.seconds);
    }

    if (event.affectedAreas.status === 'reported') {
      areaAnswered += 1;
      for (const area of event.affectedAreas.areas) areaCounts[area] += 1;
    } else if (event.affectedAreas.status !== 'not_recorded') {
      areaAnswered += 1;
    }

    triggerAnswered += collectTagCounts(event.triggers, triggerCounts);
    auraAnswered += collectTagCounts(event.aura, auraCounts);
  }

  return {
    range,
    reportZone,
    buckets,
    summary: {
      totalEvents,
      distinctDates: dates.size,
      rescueUsed,
      durationsRecorded: durationValues.length,
      medianDurationSeconds: median(durationValues),
      areaCounts,
      areaAnswered,
      triggerTagCounts: sortedTagCounts(triggerCounts),
      auraTagCounts: sortedTagCounts(auraCounts),
      triggerAnswered,
      auraAnswered,
    },
    dataVersion: options.dataVersion ?? 0,
  };
}

export function rescueUsed(event: { rescue: Rescue }): boolean {
  return event.rescue.status === 'used';
}

export function clipLabel(bucket: Bucket, granularity: Granularity): string {
  const start = bucket.start;
  if (granularity === 'month') {
    const d = parsePlainDate(start);
    return `${d.year}-${String(d.month).padStart(2, '0')}`;
  }
  return start;
}

export function bucketDayCount(bucket: Bucket): number {
  return differenceInCalendarDays(bucket.start, bucket.end) + 1;
}

export function settingsEpoch(settings: DiarySettings): string {
  return settings.datasetEpoch;
}

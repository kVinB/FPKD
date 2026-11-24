import type {
  AffectedArea,
  AffectedAreaStatus,
  EventTime,
  Rescue,
  SeizureEvent,
  TagAnswer,
  TagStatus,
} from './types';
import {
  AREA_STATUS_LABELS,
  AFFECTED_AREA_LABELS,
  RESCUE_STATUS_LABELS,
  TAG_STATUS_LABELS,
} from './types';
import { formatDuration, reportDateFor } from './time';
import {
  aggregate,
  type AnalyticsResult,
  type AnalyticsSummary,
  type Bucket,
  type ReportRange,
} from './range';

export interface ReportEventView {
  id: string;
  reportDate: string;
  occurred: {
    precision: EventTime['precision'];
    date: string;
    timeDisplay: string;
    approximate: boolean;
    timeNotRecorded: boolean;
    zone: string;
    offset?: string;
    differsFromReportDate: boolean;
  };
  eventLabel?: string;
  duration: {
    status: string;
    label: string;
    seconds: number | null;
  };
  affectedAreas: {
    status: AffectedAreaStatus | 'reported';
    areas: AffectedArea[];
    display: string;
  };
  triggers: {
    status: TagStatus | 'reported';
    labels: string[];
    display: string;
  };
  aura: {
    status: TagStatus | 'reported';
    labels: string[];
    display: string;
  };
  rescue: {
    status: Rescue['status'];
    display: string;
    administrations: {
      name?: string;
      doseAsReported?: string;
      timingAsReported?: string;
    }[];
  };
  notes?: string;
}

export interface ReportModel {
  format: 'seizure-diary-report';
  formatVersion: 2;
  range: { start: string; end: string };
  granularity: ReportRange['granularity'];
  reportZone: string;
  generatedAt: string;
  includeName: boolean;
  includeNotes: boolean;
  patientName?: string;
  events: ReportEventView[];
  buckets: Bucket[];
  summary: AnalyticsSummary;
  dataVersion: number;
  datasetEpoch: string;
  disclaimer: string;
}

export interface BuildReportOptions {
  range: ReportRange;
  reportZone: string;
  generatedAt: string;
  includeName: boolean;
  includeNotes: boolean;
  name?: string;
  dataVersion: number;
  datasetEpoch: string;
}

const AREA_ORDER: AffectedArea[] = ['arms', 'legs', 'speech'];

export function areaDisplay(affected: SeizureEvent['affectedAreas']): string {
  if (affected.status !== 'reported') return AREA_STATUS_LABELS[affected.status];
  return AREA_ORDER.filter((area) => affected.areas.includes(area))
    .map((area) => AFFECTED_AREA_LABELS[area])
    .join(', ');
}

export function tagDisplay(answer: TagAnswer): string {
  if (answer.status !== 'reported') return TAG_STATUS_LABELS[answer.status];
  return answer.tags.map((tag) => tag.label).join(', ');
}

export function durationDisplay(event: SeizureEvent): {
  status: string;
  label: string;
  seconds: number | null;
} {
  const { duration } = event;
  if (duration.status === 'not_recorded') {
    return { status: duration.status, label: 'Not recorded', seconds: null };
  }
  if (duration.status === 'unknown') {
    return { status: duration.status, label: 'Unsure', seconds: null };
  }
  const qualifier = duration.status === 'estimated' ? 'estimated' : 'exact';
  return {
    status: duration.status,
    label: `${formatDuration(duration.seconds)} (${qualifier})`,
    seconds: duration.seconds,
  };
}

export function rescueDisplay(rescue: Rescue): {
  status: Rescue['status'];
  display: string;
  administrations: { name?: string; doseAsReported?: string; timingAsReported?: string }[];
} {
  if (rescue.status !== 'used') {
    return {
      status: rescue.status,
      display: RESCUE_STATUS_LABELS[rescue.status],
      administrations: [],
    };
  }
  if (rescue.administrations.length === 0) {
    return {
      status: rescue.status,
      display: 'Used; details not recorded',
      administrations: [],
    };
  }
  return {
    status: rescue.status,
    display: 'Used',
    administrations: rescue.administrations.map((administration) => ({
      name: administration.name,
      doseAsReported: administration.doseAsReported,
      timingAsReported: administration.timingAsReported,
    })),
  };
}

function occurredView(event: SeizureEvent, reportZone: string): ReportEventView['occurred'] {
  const reportDate = reportDateFor(event.occurredAt, reportZone);
  if (event.occurredAt.precision === 'date_only') {
    return {
      precision: 'date_only',
      date: event.occurredAt.captureDate,
      timeDisplay: 'Time not recorded',
      approximate: false,
      timeNotRecorded: true,
      zone: event.occurredAt.zone,
      differsFromReportDate: reportDate !== event.occurredAt.captureDate,
    };
  }
  return {
    precision: event.occurredAt.precision,
    date: event.occurredAt.captureDate,
    timeDisplay: event.occurredAt.wallTime,
    approximate: event.occurredAt.precision === 'approximate',
    timeNotRecorded: false,
    zone: event.occurredAt.zone,
    offset: event.occurredAt.offset,
    differsFromReportDate: reportDate !== event.occurredAt.captureDate,
  };
}

export function projectEvent(
  event: SeizureEvent,
  options: { reportZone: string; includeNotes: boolean },
): ReportEventView {
  const duration = durationDisplay(event);
  const rescue = rescueDisplay(event.rescue);
  const view: ReportEventView = {
    id: event.id,
    reportDate: reportDateFor(event.occurredAt, options.reportZone),
    occurred: occurredView(event, options.reportZone),
    duration,
    affectedAreas: {
      status: event.affectedAreas.status,
      areas:
        event.affectedAreas.status === 'reported'
          ? AREA_ORDER.filter((area) => event.affectedAreas.status === 'reported' && event.affectedAreas.areas.includes(area))
          : [],
      display: areaDisplay(event.affectedAreas),
    },
    triggers: {
      status: event.triggers.status,
      labels: event.triggers.status === 'reported' ? event.triggers.tags.map((tag) => tag.label) : [],
      display: tagDisplay(event.triggers),
    },
    aura: {
      status: event.aura.status,
      labels: event.aura.status === 'reported' ? event.aura.tags.map((tag) => tag.label) : [],
      display: tagDisplay(event.aura),
    },
    rescue,
  };
  if (event.eventLabel) view.eventLabel = event.eventLabel;
  if (options.includeNotes && event.notes) view.notes = event.notes;
  return view;
}

function compareEventsForReport(a: SeizureEvent, b: SeizureEvent, reportZone: string): number {
  const dateA = reportDateFor(a.occurredAt, reportZone);
  const dateB = reportDateFor(b.occurredAt, reportZone);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;

  const aDateOnly = a.occurredAt.precision === 'date_only';
  const bDateOnly = b.occurredAt.precision === 'date_only';
  if (aDateOnly !== bDateOnly) return aDateOnly ? 1 : -1;

  if (!aDateOnly && !bDateOnly) {
    const aInstant = (a.occurredAt as Extract<EventTime, { precision: 'exact' | 'approximate' }>).instantUtc;
    const bInstant = (b.occurredAt as Extract<EventTime, { precision: 'exact' | 'approximate' }>).instantUtc;
    if (aInstant !== bInstant) return aInstant < bInstant ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildReportModel(
  events: SeizureEvent[],
  options: BuildReportOptions,
): ReportModel {
  const { range, reportZone } = options;
  const filtered = events.filter((event) => {
    const reportDate = reportDateFor(event.occurredAt, reportZone);
    return reportDate >= range.start && reportDate <= range.end;
  });

  const sorted = [...filtered].sort((a, b) => compareEventsForReport(a, b, reportZone));
  const views = sorted.map((event) =>
    projectEvent(event, { reportZone, includeNotes: options.includeNotes }),
  );

  const analytics: AnalyticsResult = aggregate(filtered, {
    reportZone,
    range,
    dataVersion: options.dataVersion,
  });

  const model: ReportModel = {
    format: 'seizure-diary-report',
    formatVersion: 2,
    range: { start: range.start, end: range.end },
    granularity: range.granularity,
    reportZone,
    generatedAt: options.generatedAt,
    includeName: options.includeName,
    includeNotes: options.includeNotes,
    events: views,
    buckets: analytics.buckets,
    summary: analytics.summary,
    dataVersion: options.dataVersion,
    datasetEpoch: options.datasetEpoch,
    disclaimer: 'Patient-entered diary; totals reflect logged entries only.',
  };
  if (options.includeName && options.name && options.name.trim().length > 0) {
    model.patientName = options.name.trim();
  }
  return model;
}

export function reportDigestPayload(model: ReportModel): string {
  const { generatedAt: _generatedAt, ...rest } = model;
  return canonicalJson(rest);
}

export function canonicalJson(value: unknown): string {  const seen = new WeakSet<object>();
  const serialize = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null';
    if (seen.has(input as object)) throw new Error('Cannot canonicalize circular structure');
    seen.add(input as object);
    let output: string;
    if (Array.isArray(input)) {
      output = `[${input.map((entry) => serialize(entry)).join(',')}]`;
    } else {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      output = `{${keys
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
        .join(',')}}`;
    }
    seen.delete(input as object);
    return output;
  };
  return serialize(value);
}

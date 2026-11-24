import { describe, expect, it } from 'vitest';
import { buildReportModel, canonicalJson, reportDigestPayload } from '@shared/report';
import type { ReportRange } from '@shared/range';
import { dateOnlyEvent, timedEvent, tagStress } from '../fixtures/events';

const range: ReportRange = { start: '2026-11-01', end: '2026-11-01', granularity: 'day' };

function sampleEvents() {
  const earlier = timedEvent({
    id: '11111111-1111-4111-8111-111111111111',
    instantUtc: '2026-11-01T08:00:00Z',
    eventLabel: 'Earlier',
  });
  const later = timedEvent({
    id: '22222222-2222-4222-8222-222222222222',
    instantUtc: '2026-11-01T10:00:00Z',
    affectedAreas: { status: 'reported', areas: ['speech', 'arms'] },
    duration: { status: 'estimated', seconds: 85 },
    triggers: { status: 'reported', tags: [tagStress] },
    rescue: {
      status: 'used',
      administrations: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'As reported',
          timingAsReported: 'about 2 minutes after start',
        },
      ],
    },
    eventLabel: 'Later',
    notes: 'Private note text',
  });
  const dateOnly = dateOnlyEvent('2026-11-01', {
    id: '44444444-4444-4444-8444-444444444444',
    zone: 'Pacific/Auckland',
  });
  const outside = timedEvent({
    id: '55555555-5555-4555-8555-555555555555',
    instantUtc: '2026-10-31T10:00:00Z',
  });
  return { earlier, later, dateOnly, outside };
}

function build(options: { includeName: boolean; includeNotes: boolean }) {
  const { earlier, later, dateOnly, outside } = sampleEvents();
  return buildReportModel([later, earlier, dateOnly, outside], {
    range,
    reportZone: 'UTC',
    generatedAt: '2026-11-24T12:00:00Z',
    includeName: options.includeName,
    includeNotes: options.includeNotes,
    name: 'Sample Person',
    dataVersion: 7,
    datasetEpoch: '11111111-1111-4111-8111-111111111111',
  });
}

describe('report privacy projection (A05/A06)', () => {
  it('omits name and notes by default', () => {
    const model = build({ includeName: false, includeNotes: false });
    expect(model.patientName).toBeUndefined();
    expect(model.events.every((event) => event.notes === undefined)).toBe(true);
    expect(model.events.some((event) => event.notes !== undefined)).toBe(false);
  });

  it('includes the name and notes only when opted in', () => {
    const model = build({ includeName: true, includeNotes: true });
    expect(model.patientName).toBe('Sample Person');
    const withNotes = model.events.find((event) => event.id.endsWith('222222222222'));
    expect(withNotes?.notes).toBe('Private note text');
  });

  it('always includes affected areas, rescue details and dates', () => {
    const model = build({ includeName: false, includeNotes: false });
    const event = model.events.find((entry) => entry.id.endsWith('222222222222'));
    expect(event?.affectedAreas.display).toBe('Arms, Speech');
    expect(event?.affectedAreas.areas).toEqual(['arms', 'speech']);
    expect(event?.rescue.display).toBe('Used');
    expect(event?.rescue.administrations[0]?.name).toBe('As reported');
    expect(event?.reportDate).toBe('2026-11-01');
  });

  it('distinguishes Not recorded, Unsure and None of these', () => {
    const model = build({ includeName: false, includeNotes: false });
    const dateOnly = model.events.find((event) => event.id.endsWith('444444444444'));
    expect(dateOnly?.affectedAreas.display).toBe('Not recorded');
    expect(dateOnly?.occurred.timeNotRecorded).toBe(true);
  });
});

describe('report ordering and totals', () => {
  it('orders timed events by instant, then date-only, excluding out-of-range events', () => {
    const model = build({ includeName: false, includeNotes: false });
    expect(model.events.map((event) => event.id.slice(-4))).toEqual(['1111', '2222', '4444']);
    expect(model.summary.totalEvents).toBe(3);
  });

  it('keeps the reporting zone and disclaimer', () => {
    const model = build({ includeName: false, includeNotes: false });
    expect(model.reportZone).toBe('UTC');
    expect(model.disclaimer).toContain('logged entries only');
    expect(model.dataVersion).toBe(7);
  });

  it('supports an explicit zero-event report', () => {
    const model = buildReportModel([], {
      range: { start: '2026-01-01', end: '2026-01-31', granularity: 'week' },
      reportZone: 'UTC',
      generatedAt: '2026-11-24T12:00:00Z',
      includeName: false,
      includeNotes: false,
      dataVersion: 1,
      datasetEpoch: '11111111-1111-4111-8111-111111111111',
    });
    expect(model.events).toHaveLength(0);
    expect(model.summary.totalEvents).toBe(0);
  });
});

describe('canonical digest stability', () => {
  it('sorts keys and is stable across object property order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('ignores generatedAt for the preview digest', () => {
    const first = build({ includeName: false, includeNotes: false });
    const second = { ...first, generatedAt: '2027-01-01T00:00:00Z' };
    expect(reportDigestPayload(first)).toBe(reportDigestPayload(second));
  });

  it('changes the digest when the privacy projection changes', () => {
    const withoutNotes = build({ includeName: false, includeNotes: false });
    const withNotes = build({ includeName: false, includeNotes: true });
    expect(reportDigestPayload(withoutNotes)).not.toBe(reportDigestPayload(withNotes));
  });
});

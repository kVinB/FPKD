import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

let context: TestContext | null = null;

afterEach(async () => {
  if (context) {
    await context.close();
    context = null;
  }
});

function eventBody(instantUtc: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const date = instantUtc.slice(0, 10);
  const time = instantUtc.slice(11, 16);
  return {
    occurredAt: {
      precision: 'exact',
      captureDate: date,
      wallTime: time,
      zone: 'UTC',
      offset: '+00:00',
      instantUtc,
    },
    duration: { status: 'not_recorded' },
    affectedAreas: { status: 'not_recorded' },
    triggers: { status: 'not_recorded' },
    aura: { status: 'not_recorded' },
    rescue: { status: 'not_recorded' },
    ...overrides,
  };
}

async function seedRangeEvents(client: Awaited<ReturnType<TestContext['createClient']>>) {
  await client.json('POST', '/events', {
    body: eventBody('2026-11-01T00:00:00Z', {
      duration: { status: 'exact', seconds: 60 },
      affectedAreas: { status: 'reported', areas: ['arms'] },
    }),
    csrf: client.sessionCsrf,
  });
  await client.json('POST', '/events', {
    body: eventBody('2026-11-07T23:59:00Z', {
      duration: { status: 'estimated', seconds: 120 },
      affectedAreas: { status: 'reported', areas: ['legs'] },
    }),
    csrf: client.sessionCsrf,
  });
  await client.json('POST', '/events', {
    body: eventBody('2026-11-08T00:00:00Z'),
    csrf: client.sessionCsrf,
  });
  await client.json('POST', '/events', {
    body: eventBody('2026-11-01T12:00:00Z', {
      affectedAreas: { status: 'reported', areas: ['speech', 'arms'] },
      duration: { status: 'unknown' },
      triggers: {
        status: 'reported',
        tags: [
          { id: 'trigger-stress', label: 'Stress' },
          { id: 'trigger-poor-sleep', label: 'Poor sleep' },
        ],
      },
      rescue: { status: 'used', administrations: [] },
    }),
    csrf: client.sessionCsrf,
  });
  await client.json('POST', '/events', {
    body: {
      occurredAt: { precision: 'date_only', captureDate: '2026-11-03', zone: 'UTC' },
      duration: { status: 'not_recorded' },
      affectedAreas: { status: 'not_recorded' },
      triggers: { status: 'not_recorded' },
      aura: { status: 'not_recorded' },
      rescue: { status: 'not_recorded' },
    },
    csrf: client.sessionCsrf,
  });
}

describe('A04 analytics and report agreement', () => {
  it('includes boundary events exactly once, fills zero buckets and agrees across views', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'analytics-user', password: 'analytics-password-123' });
    const client = context.createClient();
    await client.login('analytics-user', 'analytics-password-123');
    await seedRangeEvents(client);

    const analytics = await client.json<{
      summary: {
        totalEvents: number;
        distinctDates: number;
        rescueUsed: number;
        durationsRecorded: number;
        medianDurationSeconds: number | null;
        triggerTagCounts: { id: string; label: string; count: number }[];
        auraTagCounts: { id: string; label: string; count: number }[];
        triggerAnswered: number;
        auraAnswered: number;
      };
      buckets: { key: string; count: number; partial: boolean }[];
    }>('POST', '/analytics/query', {
      body: { start: '2026-11-01', end: '2026-11-07', granularity: 'day' },
    });
    expect(analytics.summary.totalEvents).toBe(4);
    expect(analytics.summary.distinctDates).toBe(3);
    expect(analytics.summary.rescueUsed).toBe(1);
    expect(analytics.summary.durationsRecorded).toBe(2);
    expect(analytics.summary.medianDurationSeconds).toBe(90);
    expect(analytics.summary.triggerTagCounts).toEqual([
      { id: 'trigger-poor-sleep', label: 'Poor sleep', count: 1 },
      { id: 'trigger-stress', label: 'Stress', count: 1 },
    ]);
    expect(analytics.summary.auraTagCounts).toEqual([]);
    expect(analytics.summary.triggerAnswered).toBe(1);
    expect(analytics.summary.auraAnswered).toBe(0);
    const triggerTagSum = analytics.summary.triggerTagCounts.reduce(
      (sum, tag) => sum + tag.count,
      0,
    );
    expect(triggerTagSum).toBeGreaterThan(analytics.summary.triggerAnswered);
    expect(analytics.buckets).toHaveLength(7);
    expect(analytics.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
    const weekBucket = analytics.buckets.find((bucket) => bucket.key === '2026-11-01');
    expect(weekBucket?.count).toBe(2);
    expect(analytics.buckets.some((bucket) => bucket.count === 0)).toBe(true);

    const report = await client.json<{
      model: {
        summary: {
          totalEvents: number;
          medianDurationSeconds: number | null;
          triggerTagCounts: { id: string; label: string; count: number }[];
        };
        buckets: { key: string; count: number }[];
        events: unknown[];
      };
      digest: string;
    }>('POST', '/reports/preview', {
      body: { start: '2026-11-01', end: '2026-11-07', granularity: 'day' },
      csrf: client.sessionCsrf,
    });
    expect(report.model.summary.totalEvents).toBe(analytics.summary.totalEvents);
    expect(report.model.summary.medianDurationSeconds).toBe(90);
    expect(report.model.summary.triggerTagCounts).toEqual(
      analytics.summary.triggerTagCounts,
    );
    expect(report.model.events).toHaveLength(4);
    expect(report.model.buckets.map((bucket) => bucket.count)).toEqual(
      analytics.buckets.map((bucket) => bucket.count),
    );
  });

  it('marks clipped week edges partial without changing totals', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'week-user', password: 'week-password-123' });
    const client = context.createClient();
    await client.login('week-user', 'week-password-123');
    const analytics = await client.json<{
      summary: { totalEvents: number };
      buckets: { key: string; partial: boolean }[];
    }>('POST', '/analytics/query', {
      body: { start: '2026-11-01', end: '2026-11-10', granularity: 'week' },
    });
    expect(analytics.summary.totalEvents).toBe(0);
    expect(analytics.buckets.length).toBeGreaterThan(0);
    expect(analytics.buckets[0]?.partial).toBe(true);
    expect(analytics.buckets.every((bucket) => bucket.key >= '2026-10-26')).toBe(true);
  });
});

describe('A05/A06 privacy projection and freshness', () => {
  it('omits name and notes by default and shows distinct statuses', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'privacy-user', password: 'privacy-password-123' });
    const client = context.createClient();
    await client.login('privacy-user', 'privacy-password-123');
    await client.json('POST', '/events', {
      body: eventBody('2026-11-01T09:00:00Z', {
        affectedAreas: { status: 'unknown' },
        triggers: { status: 'none_reported' },
        aura: { status: 'not_recorded' },
        rescue: { status: 'used', administrations: [] },
        eventLabel: 'Private label',
        notes: 'Private note',
      }),
      csrf: client.sessionCsrf,
    });

    const off = await client.json<{
      model: {
        patientName?: string;
        includeNotes: boolean;
        events: {
          affectedAreas: { display: string };
          triggers: { display: string };
          aura: { display: string };
          rescue: { display: string };
          notes?: string;
        }[];
      };
      digest: string;
    }>('POST', '/reports/preview', {
      body: { start: '2026-11-01', end: '2026-11-01', includeName: false, name: 'Sample', includeNotes: false },
      csrf: client.sessionCsrf,
    });
    expect(off.model.patientName).toBeUndefined();
    expect(off.model.events[0]?.notes).toBeUndefined();
    expect(off.model.events[0]?.affectedAreas.display).toBe('Unsure');
    expect(off.model.events[0]?.triggers.display).toBe('None reported');
    expect(off.model.events[0]?.aura.display).toBe('Not recorded');
    expect(off.model.events[0]?.rescue.display).toBe('Used; details not recorded');

    const on = await client.json<{
      model: { patientName?: string; includeNotes: boolean; events: { notes?: string }[] };
    }>('POST', '/reports/preview', {
      body: { start: '2026-11-01', end: '2026-11-01', includeName: true, name: 'Sample', includeNotes: true },
      csrf: client.sessionCsrf,
    });
    expect(on.model.patientName).toBe('Sample');
    expect(on.model.includeNotes).toBe(true);
    expect(on.model.events[0]?.notes).toBe('Private note');
  });

  it('invalidates a preview when diary data or the digest changes', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'fresh-user', password: 'fresh-password-123' });
    const client = context.createClient();
    await client.login('fresh-user', 'fresh-password-123');
    await client.json('POST', '/events', {
      body: eventBody('2026-11-01T09:00:00Z'),
      csrf: client.sessionCsrf,
    });
    const request = { start: '2026-11-01', end: '2026-11-01', includeName: false, includeNotes: false };
    const preview = await client.json<{
      digest: string;
      dataVersion: number;
      datasetEpoch: string;
    }>('POST', '/reports/preview', {
      body: request,
      csrf: client.sessionCsrf,
    });

    const ok = await client.request('POST', '/reports/validate', {
      body: {
        ...request,
        dataVersion: preview.dataVersion,
        datasetEpoch: preview.datasetEpoch,
        modelDigest: preview.digest,
      },
      csrf: client.sessionCsrf,
    });
    expect(ok.statusCode).toBe(200);

    const wrongDigest = await client.request('POST', '/reports/validate', {
      body: {
        ...request,
        dataVersion: preview.dataVersion,
        datasetEpoch: preview.datasetEpoch,
        modelDigest: 'f'.repeat(64),
      },
      csrf: client.sessionCsrf,
    });
    expect(wrongDigest.statusCode).toBe(409);

    await client.json('POST', '/events', {
      body: eventBody('2026-11-01T10:00:00Z'),
      csrf: client.sessionCsrf,
    });
    const stale = await client.request('POST', '/reports/validate', {
      body: {
        ...request,
        dataVersion: preview.dataVersion,
        datasetEpoch: preview.datasetEpoch,
        modelDigest: preview.digest,
      },
      csrf: client.sessionCsrf,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('stale_preview');
  });

  it('uses the report zone to move a timed event while keeping date-only fixed', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'reportzone-user', password: 'reportzone-password-123' });
    const client = context.createClient();
    await client.login('reportzone-user', 'reportzone-password-123');
    await client.json('POST', '/events', {
      body: eventBody('2026-11-01T23:30:00Z'),
      csrf: client.sessionCsrf,
    });
    await client.json('POST', '/events', {
      body: {
        occurredAt: { precision: 'date_only', captureDate: '2026-11-01', zone: 'Pacific/Auckland' },
        duration: { status: 'not_recorded' },
        affectedAreas: { status: 'not_recorded' },
        triggers: { status: 'not_recorded' },
        aura: { status: 'not_recorded' },
        rescue: { status: 'not_recorded' },
      },
      csrf: client.sessionCsrf,
    });
    await client.json('PUT', '/settings', {
      body: { reportZone: 'Asia/Tokyo' },
      csrf: client.sessionCsrf,
    });
    const dayOne = await client.json<{ model: { events: { id: string }[] } }>(
      'POST',
      '/reports/preview',
      { body: { start: '2026-11-01', end: '2026-11-01' }, csrf: client.sessionCsrf },
    );
    const dayTwo = await client.json<{ model: { events: { id: string }[] } }>(
      'POST',
      '/reports/preview',
      { body: { start: '2026-11-02', end: '2026-11-02' }, csrf: client.sessionCsrf },
    );
    expect(dayOne.model.events).toHaveLength(1);
    expect(dayTwo.model.events).toHaveLength(1);
  });
});

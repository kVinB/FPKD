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
  return {
    occurredAt: {
      precision: 'exact',
      captureDate: instantUtc.slice(0, 10),
      wallTime: instantUtc.slice(11, 16),
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

async function seedBackupDiary(client: Awaited<ReturnType<TestContext['createClient']>>) {
  await client.json('POST', '/events', {
    body: eventBody('2026-11-01T09:00:00Z', {
      affectedAreas: { status: 'reported', areas: ['arms', 'speech'] },
      duration: { status: 'estimated', seconds: 85 },
      triggers: {
        status: 'reported',
        tags: [
          { id: 'trigger-stress', label: 'Stress' },
          { id: '11111111-1111-4111-8111-111111111111', label: 'Custom trigger' },
        ],
      },
      aura: { status: 'none_reported' },
      rescue: {
        status: 'used',
        administrations: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'As reported',
            timingAsReported: 'about 2 minutes after start',
          },
        ],
      },
      eventLabel: 'Synthetic one',
      notes: 'Notes one',
    }),
    csrf: client.sessionCsrf,
  });
  await client.json('POST', '/events', {
    body: {
      occurredAt: { precision: 'date_only', captureDate: '2026-11-02', zone: 'UTC' },
      duration: { status: 'not_recorded' },
      affectedAreas: { status: 'none_reported' },
      triggers: { status: 'unknown' },
      aura: { status: 'not_recorded' },
      rescue: { status: 'not_recorded' },
    },
    csrf: client.sessionCsrf,
  });
}

describe('A07 personal backup and restore', () => {
  it('exports without account or owner data and round-trips content', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'backup-user', password: 'backup-password-123' });
    const client = context.createClient();
    await client.login('backup-user', 'backup-password-123');
    await seedBackupDiary(client);

    const backup = await client.json<Record<string, unknown>>('GET', '/diary/backup');
    expect(backup.format).toBe('seizure-diary');
    expect(backup.formatVersion).toBe(2);
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('session');
    expect(serialized).not.toContain('backup-user');
    const events = backup.events as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(events[0]?.occurredAt).toBeTruthy();

    const settings = await client.json<{ settings: { dataVersion: number; datasetEpoch: string } }>(
      'GET',
      '/settings',
    );
    const preview = await client.json<{
      ok: boolean;
      digest: string;
      counts: { events: number; customTags: number };
      convertedFromV1: boolean;
    }>('POST', '/diary/restore/preview', {
      body: { backup },
      csrf: client.sessionCsrf,
    });
    expect(preview.ok).toBe(true);
    expect(preview.counts.events).toBe(2);
    expect(preview.counts.customTags).toBe(1);
    expect(preview.convertedFromV1).toBe(false);

    const restored = await client.json<{ events: number; dataVersion: number; datasetEpoch: string }>(
      'POST',
      '/diary/restore',
      {
        body: {
          backup,
          digest: preview.digest,
          expectedDataVersion: settings.settings.dataVersion,
          expectedDatasetEpoch: settings.settings.datasetEpoch,
        },
        csrf: client.sessionCsrf,
      },
    );
    expect(restored.events).toBe(2);
    expect(restored.datasetEpoch).not.toBe(settings.settings.datasetEpoch);

    const detail = await client.json<{ total: number; items: Record<string, unknown>[] }>(
      'POST',
      '/events/query',
      { body: { page: 1, pageSize: 10 }, csrf: client.sessionCsrf },
    );
    expect(detail.total).toBe(2);
    const full = detail.items.find((item) => item.eventLabel === 'Synthetic one');
    expect(full?.notes).toBe('Notes one');
    expect((full?.affectedAreas as { areas: string[] }).areas).toEqual(['arms', 'speech']);
    expect((full?.rescue as { administrations: unknown[] }).administrations).toHaveLength(1);
  });

  it('rejects malformed, unsupported, duplicate and stale restores without changing data', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'reject-user', password: 'reject-password-123' });
    const client = context.createClient();
    await client.login('reject-user', 'reject-password-123');
    await seedBackupDiary(client);
    const backup = await client.json<Record<string, unknown>>('GET', '/diary/backup');
    const settings = await client.json<{ settings: { dataVersion: number; datasetEpoch: string } }>(
      'GET',
      '/settings',
    );

    for (const bad of [
      { hello: 'world' },
      { ...backup, formatVersion: 3 },
      { ...backup, events: [...(backup.events as unknown[]), (backup.events as unknown[])[0]] },
    ]) {
      const response = await client.request('POST', '/diary/restore/preview', {
        body: { backup: bad },
        csrf: client.sessionCsrf,
      });
      expect(response.statusCode).toBe(422);
    }

    const preview = await client.json<{ digest: string }>('POST', '/diary/restore/preview', {
      body: { backup },
      csrf: client.sessionCsrf,
    });

    const wrongDigest = await client.request('POST', '/diary/restore', {
      body: {
        backup,
        digest: 'f'.repeat(64),
        expectedDataVersion: settings.settings.dataVersion,
        expectedDatasetEpoch: settings.settings.datasetEpoch,
      },
      csrf: client.sessionCsrf,
    });
    expect(wrongDigest.statusCode).toBe(422);

    await client.json('POST', '/events', {
      body: eventBody('2026-11-03T09:00:00Z'),
      csrf: client.sessionCsrf,
    });
    const stale = await client.request('POST', '/diary/restore', {
      body: {
        backup,
        digest: preview.digest,
        expectedDataVersion: settings.settings.dataVersion,
        expectedDatasetEpoch: settings.settings.datasetEpoch,
      },
      csrf: client.sessionCsrf,
    });
    expect(stale.statusCode).toBe(409);

    const after = await client.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(after.total).toBe(3);
  });

  it('accepts a v1 backup only through explicit conversion', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'v1-user', password: 'v1-password-123' });
    const client = context.createClient();
    await client.login('v1-user', 'v1-password-123');
    await seedBackupDiary(client);
    const v2 = await client.json<Record<string, unknown>>('GET', '/diary/backup');
    const v1 = {
      ...v2,
      formatVersion: 1,
      events: (v2.events as Record<string, unknown>[]).map((event) => {
        const copy = { ...event };
        delete copy.affectedAreas;
        return copy;
      }),
    };
    const preview = await client.json<{ convertedFromV1: boolean; counts: { events: number } }>(
      'POST',
      '/diary/restore/preview',
      { body: { backup: v1 }, csrf: client.sessionCsrf },
    );
    expect(preview.convertedFromV1).toBe(true);
    expect(preview.counts.events).toBe(2);
  });

  it('clears only the signed-in diary and reseeds built-in tags', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'clear-user', password: 'clear-password-123' });
    const client = context.createClient();
    await client.login('clear-user', 'clear-password-123');
    await seedBackupDiary(client);
    const settings = await client.json<{ settings: { dataVersion: number; datasetEpoch: string } }>(
      'GET',
      '/settings',
    );
    const cleared = await client.json<{ dataVersion: number; datasetEpoch: string }>(
      'POST',
      '/diary/clear',
      {
        body: {
          confirm: true,
          expectedDataVersion: settings.settings.dataVersion,
          expectedDatasetEpoch: settings.settings.datasetEpoch,
        },
        csrf: client.sessionCsrf,
      },
    );
    expect(cleared.datasetEpoch).not.toBe(settings.settings.datasetEpoch);
    const query = await client.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(query.total).toBe(0);
    const tags = await client.json<{ tags: { id: string }[] }>('GET', '/tags');
    expect(tags.tags.some((tag) => tag.id === 'trigger-stress')).toBe(true);
    const backup = await client.json<{ events: unknown[]; tags: { id: string }[] }>(
      'GET',
      '/diary/backup',
    );
    expect(backup.events).toHaveLength(0);
    expect(backup.tags.some((tag) => tag.id === 'trigger-stress')).toBe(true);
  });
});

describe('A10 privacy headers and hostile text', () => {
  it('sets no-store and restrictive security headers on private responses', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'header-user', password: 'header-password-123' });
    const client = context.createClient();
    await client.login('header-user', 'header-password-123');
    const response = await client.request('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.body).not.toContain('password');
  });

  it('stores hostile text inertly rather than transforming it', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'hostile-user', password: 'hostile-password-123' });
    const client = context.createClient();
    await client.login('hostile-user', 'hostile-password-123');
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const created = await client.json<{ event: { id: string } }>('POST', '/events', {
      body: eventBody('2026-11-01T09:00:00Z', { eventLabel: hostile, notes: hostile }),
      csrf: client.sessionCsrf,
    });
    const detail = await client.json<{ event: { eventLabel: string; notes: string } }>(
      'GET',
      `/events/${created.event.id}`,
    );
    expect(detail.event.eventLabel).toBe(hostile);
    expect(detail.event.notes).toBe(hostile);
  });

  it('returns no diary data from the health endpoint', async () => {
    context = await createTestContext();
    const response = await context.createClient().request('GET', '/health');
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('users');
    expect(body).not.toHaveProperty('events');
    expect(body).not.toHaveProperty('dbPath');
  });

  it('rejects unauthenticated private requests', async () => {
    context = await createTestContext();
    const client = context.createClient();
    for (const [method, url] of [
      ['GET', '/events/query'],
      ['GET', '/settings'],
      ['GET', '/tags'],
      ['GET', '/diary/backup'],
      ['GET', '/admin/accounts'],
    ] as const) {
      const response = await client.request(method, url);
      expect(response.statusCode).toBe(401);
    }
  });
});

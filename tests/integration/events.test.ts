import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createTestContext, type TestContext } from './helpers';

let context: TestContext | null = null;

afterEach(async () => {
  if (context) {
    await context.close();
    context = null;
  }
});

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    occurredAt: { precision: 'date_only', captureDate: '2026-11-01', zone: 'UTC' },
    duration: { status: 'not_recorded' },
    affectedAreas: { status: 'not_recorded' },
    triggers: { status: 'not_recorded' },
    aura: { status: 'not_recorded' },
    rescue: { status: 'not_recorded' },
    ...overrides,
  };
}

function timedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return basePayload({
    occurredAt: {
      precision: 'exact',
      captureDate: '2026-11-24',
      wallTime: '10:00',
      zone: 'Europe/Dublin',
      offset: '+00:00',
      instantUtc: '2026-11-24T10:00:00Z',
    },
    ...overrides,
  });
}

describe('A01/A08 journal CRUD and persistence', () => {
  it('saves a minimal prefilled-style timestamp-only event and keeps it after reload/restart', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'journal-user', password: 'journal-password-123' });
    const client = context.createClient();
    await client.login('journal-user', 'journal-password-123');

    const created = await client.json<{ event: { id: string; affectedAreas: { status: string } } }>(
      'POST',
      '/events',
      { body: basePayload(), csrf: client.sessionCsrf },
    );
    expect(created.event.affectedAreas.status).toBe('not_recorded');

    const query = await client.json<{ total: number; items: unknown[] }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(query.total).toBe(1);
    expect(query.items).toHaveLength(1);

    await context.reopen();

    const afterRestart = context.createClient();
    await afterRestart.login('journal-user', 'journal-password-123');
    const persisted = await afterRestart.json<{ total: number; items: { id: string }[] }>(
      'POST',
      '/events/query',
      { body: { page: 1 }, csrf: afterRestart.sessionCsrf },
    );
    expect(persisted.total).toBe(1);
    expect(persisted.items[0]?.id).toBe(created.event.id);
  });
});

describe('A02 affected areas and full round-trip', () => {
  it('round-trips every field and all seven nonempty area combinations', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'full-user', password: 'full-password-123' });
    const client = context.createClient();
    await client.login('full-user', 'full-password-123');

    const payload = timedPayload({
      duration: { status: 'exact', seconds: 85 },
      affectedAreas: { status: 'reported', areas: ['arms', 'speech'] },
      triggers: {
        status: 'reported',
        tags: [
          { id: 'trigger-stress', label: 'Stress' },
          { id: 'trigger-poor-sleep', label: 'Poor sleep' },
        ],
      },
      aura: {
        status: 'reported',
        tags: [{ id: 'aura-unusual-smell', label: 'Unusual smell' }],
      },
      rescue: {
        status: 'used',
        administrations: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'As reported',
            doseAsReported: 'as prescribed',
            timingAsReported: 'about 2 minutes after start',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            timingAsReported: 'later',
          },
        ],
      },
      eventLabel: 'Synthetic event',
      notes: 'Synthetic notes',
    });

    const created = await client.json<{ event: { id: string; revision: number } }>('POST', '/events', {
      body: payload,
      csrf: client.sessionCsrf,
    });
    const detail = await client.json<{
      event: {
        revision: number;
        affectedAreas: { areas: string[] };
        duration: { seconds: number };
        triggers: { tags: { label: string }[] };
        aura: { tags: { label: string }[] };
        rescue: { administrations: unknown[] };
        eventLabel: string;
        notes: string;
      };
    }>('GET', `/events/${created.event.id}`);
    expect(detail.event.revision).toBe(1);
    expect(detail.event.affectedAreas.areas).toEqual(['arms', 'speech']);
    expect(detail.event.duration.seconds).toBe(85);
    expect(detail.event.triggers.tags.map((tag) => tag.label)).toEqual(['Stress', 'Poor sleep']);
    expect(detail.event.aura.tags[0]?.label).toBe('Unusual smell');
    expect(detail.event.rescue.administrations).toHaveLength(2);
    expect(detail.event.notes).toBe('Synthetic notes');

    const combos = [
      ['arms'],
      ['legs'],
      ['speech'],
      ['arms', 'legs'],
      ['arms', 'speech'],
      ['legs', 'speech'],
      ['arms', 'legs', 'speech'],
    ];
    for (const areas of combos) {
      await client.json('POST', '/events', {
        body: basePayload({
          affectedAreas: { status: 'reported', areas },
        }),
        csrf: client.sessionCsrf,
      });
    }

    for (const invalid of [
      { status: 'reported', areas: ['arms', 'arms'] },
      { status: 'reported', areas: ['head'] },
      { status: 'reported', areas: [] },
    ]) {
      const response = await client.request('POST', '/events', {
        body: basePayload({ affectedAreas: invalid }),
        csrf: client.sessionCsrf,
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('round-trips edits and rejects stale writes and conflicting deletes', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'edit-user', password: 'edit-password-123' });
    const client = context.createClient();
    await client.login('edit-user', 'edit-password-123');
    const created = await client.json<{ event: { id: string } }>('POST', '/events', {
      body: basePayload(),
      csrf: client.sessionCsrf,
    });

    const update = await client.json<{ event: { revision: number; eventLabel: string } }>(
      'PUT',
      `/events/${created.event.id}`,
      {
        body: basePayload({ eventLabel: 'Updated label', expectedRevision: 1 }),
        csrf: client.sessionCsrf,
      },
    );
    expect(update.event.revision).toBe(2);
    expect(update.event.eventLabel).toBe('Updated label');

    const staleUpdate = await client.request('PUT', `/events/${created.event.id}`, {
      body: basePayload({ eventLabel: 'Stale overwrite', expectedRevision: 1 }),
      csrf: client.sessionCsrf,
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect((staleUpdate.json() as { error: { code: string } }).error.code).toBe('stale_revision');

    const staleDelete = await client.request('DELETE', `/events/${created.event.id}`, {
      body: { expectedRevision: 1 },
      csrf: client.sessionCsrf,
    });
    expect(staleDelete.statusCode).toBe(409);

    const stillThere = await client.json<{ event: { revision: number; eventLabel: string } }>(
      'GET',
      `/events/${created.event.id}`,
    );
    expect(stillThere.event.revision).toBe(2);
    expect(stillThere.event.eventLabel).toBe('Updated label');

    const deleted = await client.json('DELETE', `/events/${created.event.id}`, {
      body: { expectedRevision: 2 },
      csrf: client.sessionCsrf,
    });
    expect(deleted).toBeTruthy();
    const missing = await client.request('GET', `/events/${created.event.id}`);
    expect(missing.statusCode).toBe(404);
  });

  it('rejects duplicate or unknown affected values on the server', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'area-user', password: 'area-password-123' });
    const client = context.createClient();
    await client.login('area-user', 'area-password-123');
    const response = await client.request('POST', '/events', {
      body: basePayload({ affectedAreas: { status: 'reported', areas: ['unknown'] } }),
      csrf: client.sessionCsrf,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('A03 DST and report-zone boundaries through the API', () => {
  it('rejects a gap time and saves both repeated-time offsets one hour apart', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'dst-user', password: 'dst-password-123' });
    const client = context.createClient();
    await client.login('dst-user', 'dst-password-123');

    const gap = await client.request('POST', '/events', {
      body: basePayload({
        occurredAt: {
          precision: 'exact',
          captureDate: '2026-03-29',
          wallTime: '01:30',
          zone: 'Europe/Dublin',
          offset: '+00:00',
          instantUtc: '2026-03-29T01:30:00Z',
        },
      }),
      csrf: client.sessionCsrf,
    });
    expect(gap.statusCode).toBe(422);

    const first = await client.json<{ event: { occurredAt: { instantUtc: string } } }>(
      'POST',
      '/events',
      {
        body: basePayload({
          occurredAt: {
            precision: 'exact',
            captureDate: '2026-10-25',
            wallTime: '01:30',
            zone: 'Europe/Dublin',
            offset: '+01:00',
            instantUtc: '2026-10-25T00:30:00Z',
          },
        }),
        csrf: client.sessionCsrf,
      },
    );
    const second = await client.json<{ event: { occurredAt: { instantUtc: string } } }>(
      'POST',
      '/events',
      {
        body: basePayload({
          occurredAt: {
            precision: 'exact',
            captureDate: '2026-10-25',
            wallTime: '01:30',
            zone: 'Europe/Dublin',
            offset: '+00:00',
            instantUtc: '2026-10-25T01:30:00Z',
          },
        }),
        csrf: client.sessionCsrf,
      },
    );
    const delta =
      Date.parse(second.event.occurredAt.instantUtc) -
      Date.parse(first.event.occurredAt.instantUtc);
    expect(delta).toBe(3_600_000);

    const wrongOffset = await client.request('POST', '/events', {
      body: basePayload({
        occurredAt: {
          precision: 'exact',
          captureDate: '2026-10-25',
          wallTime: '01:30',
          zone: 'Europe/Dublin',
          offset: '+02:00',
          instantUtc: '2026-10-25T02:30:00Z',
        },
      }),
      csrf: client.sessionCsrf,
    });
    expect(wrongOffset.statusCode).toBe(422);
  });

  it('keeps date-only dates fixed and moves a timed midnight event between report buckets', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'zone-user', password: 'zone-password-123' });
    const client = context.createClient();
    await client.login('zone-user', 'zone-password-123');
    const dateOnly = await client.json<{ event: { id: string } }>('POST', '/events', {
      body: basePayload({
        occurredAt: { precision: 'date_only', captureDate: '2026-11-01', zone: 'Pacific/Auckland' },
      }),
      csrf: client.sessionCsrf,
    });
    const timed = await client.json<{ event: { id: string } }>('POST', '/events', {
      body: basePayload({
        occurredAt: {
          precision: 'exact',
          captureDate: '2026-11-01',
          wallTime: '23:30',
          zone: 'UTC',
          offset: '+00:00',
          instantUtc: '2026-11-01T23:30:00Z',
        },
      }),
      csrf: client.sessionCsrf,
    });
    void dateOnly;

    await client.json('PUT', '/settings', {
      body: { reportZone: 'Asia/Tokyo' },
      csrf: client.sessionCsrf,
    });
    const tokyoDay1 = await client.json<{ summary: { totalEvents: number } }>(
      'POST',
      '/analytics/query',
      { body: { start: '2026-11-01', end: '2026-11-01', granularity: 'day' } },
    );
    const tokyoDay2 = await client.json<{ summary: { totalEvents: number } }>(
      'POST',
      '/analytics/query',
      { body: { start: '2026-11-02', end: '2026-11-02', granularity: 'day' } },
    );
    expect(tokyoDay1.summary.totalEvents).toBe(1);
    expect(tokyoDay2.summary.totalEvents).toBe(1);

    const queryDay2 = await client.json<{ items: { id: string }[] }>('POST', '/events/query', {
      body: { page: 1, start: '2026-11-02', end: '2026-11-02' },
      csrf: client.sessionCsrf,
    });
    expect(queryDay2.items.map((item) => item.id)).toContain(timed.event.id);
  });
});

describe('A09 retries, duplicates and dataset epoch', () => {
  it('is idempotent for a stable event id and rejects a conflicting reuse', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'retry-user', password: 'retry-password-123' });
    const client = context.createClient();
    await client.login('retry-user', 'retry-password-123');
    const eventId = crypto.randomUUID();
    const payload = basePayload({ id: eventId, affectedAreas: { status: 'reported', areas: ['arms'] } });

    const first = await client.json<{ created: boolean; event: { id: string } }>('POST', '/events', {
      body: payload,
      csrf: client.sessionCsrf,
    });
    const second = await client.json<{ created: boolean; event: { id: string } }>('POST', '/events', {
      body: payload,
      csrf: client.sessionCsrf,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(eventId);

    const query = await client.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(query.total).toBe(1);

    const conflicting = await client.request('POST', '/events', {
      body: basePayload({ id: eventId, notes: 'different payload' }),
      csrf: client.sessionCsrf,
    });
    expect(conflicting.statusCode).toBe(409);
    expect((conflicting.json() as { error: { code: string } }).error.code).toBe('event_id_conflict');
  });

  it('creates exactly one event for concurrent double submits', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'double-user', password: 'double-password-123' });
    const client = context.createClient();
    await client.login('double-user', 'double-password-123');
    const eventId = crypto.randomUUID();
    const payload = basePayload({ id: eventId });
    const results = await Promise.all([
      client.request('POST', '/events', { body: payload, csrf: client.sessionCsrf }),
      client.request('POST', '/events', { body: payload, csrf: client.sessionCsrf }),
    ]);
    expect(results.every((result) => result.statusCode < 300)).toBe(true);
    const created = results.filter(
      (result) => (result.json() as { created: boolean }).created === true,
    );
    expect(created).toHaveLength(1);
    const query = await client.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(query.total).toBe(1);
  });

  it('rejects writes bound to a stale dataset epoch', async () => {
    context = await createTestContext();
    const user = await context.seedUser({ username: 'epoch-user', password: 'epoch-password-123' });
    const client = context.createClient();
    await client.login('epoch-user', 'epoch-password-123');
    const settings = await client.json<{ settings: { datasetEpoch: string } }>('GET', '/settings');
    context.db
      .prepare('UPDATE diary_settings SET dataset_epoch = ? WHERE user_id = ?')
      .run(crypto.randomUUID(), user.id);
    const response = await client.request('POST', '/events', {
      body: basePayload({ expectedDatasetEpoch: settings.settings.datasetEpoch }),
      csrf: client.sessionCsrf,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('stale_dataset');
  });

  it('returns 503 and rolls back partial tag writes when SQLite aborts an insert', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'writefail-user', password: 'writefail-password-123' });
    const client = context.createClient();
    await client.login('writefail-user', 'writefail-password-123');
    const customTagId = '11111111-1111-4111-8111-111111111111';
    const payload = basePayload({
      triggers: {
        status: 'reported',
        tags: [{ id: customTagId, label: 'Rollback tag' }],
      },
      eventLabel: 'Should not persist',
    });

    context.db.exec(`
      CREATE TRIGGER inject_write_failure
      BEFORE INSERT ON events
      BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
    `);
    try {
      const response = await client.request('POST', '/events', {
        body: payload,
        csrf: client.sessionCsrf,
      });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'storage_unavailable',
      );
      const events = context.db
        .prepare('SELECT COUNT(*) AS count FROM events')
        .get() as { count: number };
      expect(events.count).toBe(0);
      const tag = context.db
        .prepare('SELECT COUNT(*) AS count FROM tags WHERE tag_id = ?')
        .get(customTagId) as { count: number };
      expect(tag.count).toBe(0);
    } finally {
      context.db.exec('DROP TRIGGER IF EXISTS inject_write_failure');
    }

    const retry = await client.json<{ created: boolean }>('POST', '/events', {
      body: payload,
      csrf: client.sessionCsrf,
    });
    expect(retry.created).toBe(true);
    const query = await client.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: client.sessionCsrf,
    });
    expect(query.total).toBe(1);
  });

  it('returns 503 and preserves the previous revision when SQLite aborts an update', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'updatefail-user', password: 'updatefail-password-123' });
    const client = context.createClient();
    await client.login('updatefail-user', 'updatefail-password-123');
    const created = await client.json<{ event: { id: string } }>('POST', '/events', {
      body: basePayload({ eventLabel: 'Original label' }),
      csrf: client.sessionCsrf,
    });

    context.db.exec(`
      CREATE TRIGGER inject_update_failure
      BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;
    `);
    try {
      const response = await client.request('PUT', `/events/${created.event.id}`, {
        body: basePayload({ eventLabel: 'Changed label', expectedRevision: 1 }),
        csrf: client.sessionCsrf,
      });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'storage_unavailable',
      );
      const unchanged = await client.json<{ event: { revision: number; eventLabel: string } }>(
        'GET',
        `/events/${created.event.id}`,
      );
      expect(unchanged.event.revision).toBe(1);
      expect(unchanged.event.eventLabel).toBe('Original label');
    } finally {
      context.db.exec('DROP TRIGGER IF EXISTS inject_update_failure');
    }

    const retry = await client.json<{ event: { revision: number; eventLabel: string } }>(
      'PUT',
      `/events/${created.event.id}`,
      {
        body: basePayload({ eventLabel: 'Changed label', expectedRevision: 1 }),
        csrf: client.sessionCsrf,
      },
    );
    expect(retry.event.revision).toBe(2);
    expect(retry.event.eventLabel).toBe('Changed label');
  });
});

describe('A14 owner isolation', () => {
  it('scopes diary, tags, analytics, reports, exports and restore to the signed-in owner', async () => {
    context = await createTestContext();
    const memberA = await context.seedUser({ username: 'member-a', password: 'member-a-password-123' });
    await context.seedUser({ username: 'member-b', password: 'member-b-password-123' });
    await context.seedUser({ username: 'admin-iso', password: 'admin-iso-password-123', role: 'admin' });

    const a = context.createClient();
    await a.login('member-a', 'member-a-password-123');
    const b = context.createClient();
    await b.login('member-b', 'member-b-password-123');
    const admin = context.createClient();
    await admin.login('admin-iso', 'admin-iso-password-123');

    const created = await a.json<{ event: { id: string } }>('POST', '/events', {
      body: basePayload({
        affectedAreas: { status: 'reported', areas: ['arms'] },
        triggers: { status: 'reported', tags: [{ id: 'trigger-stress', label: 'Stress' }] },
      }),
      csrf: a.sessionCsrf,
    });
    const eventId = created.event.id;

    for (const client of [b, admin]) {
      const direct = await client.request('GET', `/events/${eventId}`);
      expect(direct.statusCode).toBe(404);
      const query = await client.json<{ total: number }>('POST', '/events/query', {
        body: { page: 1 },
        csrf: client.sessionCsrf,
      });
      expect(query.total).toBe(0);
      const analytics = await client.json<{ summary: { totalEvents: number } }>(
        'POST',
        '/analytics/query',
        { body: { start: '2026-11-01', end: '2026-11-01', granularity: 'day' } },
      );
      expect(analytics.summary.totalEvents).toBe(0);
      const report = await client.json<{ model: { events: unknown[] } }>('POST', '/reports/preview', {
        body: { start: '2026-11-01', end: '2026-11-01' },
        csrf: client.sessionCsrf,
      });
      expect(report.model.events).toHaveLength(0);
    }

    const aBackup = await a.json<{ events: unknown[] }>('GET', '/diary/backup');
    expect(aBackup.events).toHaveLength(1);
    const bBackup = await b.json<{ events: unknown[] }>('GET', '/diary/backup');
    expect(bBackup.events).toHaveLength(0);

    const bSettings = await b.json<{ settings: { dataVersion: number; datasetEpoch: string } }>(
      'GET',
      '/settings',
    );
    const preview = await b.json<{ digest: string }>('POST', '/diary/restore/preview', {
      body: { backup: aBackup },
      csrf: b.sessionCsrf,
    });
    await b.json('POST', '/diary/restore', {
      body: {
        backup: aBackup,
        digest: preview.digest,
        expectedDataVersion: bSettings.settings.dataVersion,
        expectedDatasetEpoch: bSettings.settings.datasetEpoch,
      },
      csrf: b.sessionCsrf,
    });

    const aStill = await a.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: a.sessionCsrf,
    });
    expect(aStill.total).toBe(1);
    const bNow = await b.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: b.sessionCsrf,
    });
    expect(bNow.total).toBe(1);

    await b.json('POST', '/diary/clear', {
      body: {
        confirm: true,
        expectedDataVersion: (await b.json<{ settings: { dataVersion: number } }>('GET', '/settings'))
          .settings.dataVersion,
        expectedDatasetEpoch: (await b.json<{ settings: { datasetEpoch: string } }>('GET', '/settings'))
          .settings.datasetEpoch,
      },
      csrf: b.sessionCsrf,
    });
    const aAfterClear = await a.json<{ total: number }>('POST', '/events/query', {
      body: { page: 1 },
      csrf: a.sessionCsrf,
    });
    expect(aAfterClear.total).toBe(1);
    void memberA;
  });

  it('does not expose diary fields through admin account routes', async () => {
    context = await createTestContext();
    await context.seedUser({ username: 'admin-list', password: 'admin-list-password-123', role: 'admin' });
    const admin = context.createClient();
    await admin.login('admin-list', 'admin-list-password-123');
    await admin.json('POST', '/admin/accounts', {
      body: { username: 'listed-member' },
      csrf: admin.sessionCsrf,
    });
    const response = await admin.request('GET', '/admin/accounts');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('affectedAreas');
    expect(response.body).not.toContain('notes');
    expect(response.body).not.toContain('password');
  });
});

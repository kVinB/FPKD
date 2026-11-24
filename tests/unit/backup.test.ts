import { describe, expect, it } from 'vitest';
import { validateBackup } from '@shared/backup';
import { timedEvent, tagStress } from '../fixtures/events';

function makeBackup(): Record<string, unknown> {
  const event = timedEvent({
    id: '11111111-1111-4111-8111-111111111111',
    instantUtc: '2026-11-24T10:00:00Z',
    zone: 'Europe/Dublin',
    affectedAreas: { status: 'reported', areas: ['arms', 'speech'] },
    duration: { status: 'estimated', seconds: 85 },
    triggers: { status: 'reported', tags: [tagStress] },
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
    eventLabel: 'Synthetic',
    notes: 'Synthetic note',
  });
  return {
    format: 'seizure-diary',
    formatVersion: 2,
    exportedAt: '2026-11-24T12:00:00Z',
    settings: { reportZone: 'Europe/Dublin' },
    tags: [
      { id: 'trigger-stress', kind: 'trigger', label: 'Stress' },
      { id: 'aura-deja-vu', kind: 'aura', label: 'Déjà vu' },
    ],
    events: [
      {
        id: event.id,
        occurredAt: event.occurredAt,
        duration: event.duration,
        affectedAreas: event.affectedAreas,
        triggers: event.triggers,
        aura: event.aura,
        rescue: event.rescue,
        eventLabel: event.eventLabel,
        notes: event.notes,
      },
    ],
  };
}

describe('backup validation (A07)', () => {
  it('accepts a valid v2 backup and reports counts', () => {
    const result = validateBackup(makeBackup(), 'UTC');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.settings.reportZone).toBe('Europe/Dublin');
      expect(result.counts.events).toBe(1);
      expect(result.counts.tags).toBe(2);
      expect(result.counts.timedEvents).toBe(1);
      expect(result.data.events[0]?.notes).toBe('Synthetic note');
    }
  });

  it('converts v1 by mapping missing affected areas to Not recorded', () => {
    const v1 = makeBackup();
    v1.formatVersion = 1;
    delete v1.settings;
    delete v1.tags;
    const events = v1.events as Record<string, unknown>[];
    delete events[0]?.affectedAreas;
    delete events[0]?.triggers;
    delete events[0]?.aura;
    events[0] = {
      ...events[0],
      triggers: { status: 'not_recorded' },
      aura: { status: 'not_recorded' },
    };
    const result = validateBackup(v1, 'America/New_York');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.convertedFromV1).toBe(true);
      expect(result.data.events[0]?.affectedAreas).toEqual({ status: 'not_recorded' });
      expect(result.data.settings.reportZone).toBe('America/New_York');
    }
  });

  it('rejects unsupported versions, malformed shapes and duplicate ids', () => {
    const version = makeBackup();
    version.formatVersion = 3;
    expect(validateBackup(version, 'UTC').ok).toBe(false);

    const duplicateEvent = makeBackup();
    const events = duplicateEvent.events as Record<string, unknown>[];
    events.push({ ...events[0] });
    const duplicateResult = validateBackup(duplicateEvent, 'UTC');
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) {
      expect(duplicateResult.issues.some((issue) => issue.code === 'duplicate_event_id')).toBe(true);
    }

    expect(validateBackup({ hello: 'world' }, 'UTC').ok).toBe(false);
    expect(validateBackup(null, 'UTC').ok).toBe(false);
  });

  it('rejects unknown tag references and kind mismatches', () => {
    const unknown = makeBackup();
    const events = unknown.events as Record<string, unknown>[];
    events[0] = {
      ...events[0],
      triggers: { status: 'reported', tags: [{ id: 'missing-tag', label: 'Missing' }] },
    };
    const unknownResult = validateBackup(unknown, 'UTC');
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.issues.some((issue) => issue.code === 'unknown_tag_reference')).toBe(true);
    }

    const wrongKind = makeBackup();
    const wrongEvents = wrongKind.events as Record<string, unknown>[];
    wrongEvents[0] = {
      ...wrongEvents[0],
      aura: { status: 'reported', tags: [{ id: 'trigger-stress', label: 'Stress' }] },
    };
    const wrongKindResult = validateBackup(wrongKind, 'UTC');
    expect(wrongKindResult.ok).toBe(false);
    if (!wrongKindResult.ok) {
      expect(wrongKindResult.issues.some((issue) => issue.code === 'tag_kind_mismatch')).toBe(true);
    }
  });

  it('rejects duplicate normalized tag labels', () => {
    const duplicate = makeBackup();
    duplicate.tags = [
      { id: 'trigger-a', kind: 'trigger', label: 'Stress' },
      { id: 'trigger-b', kind: 'trigger', label: '  stress ' },
    ];
    const events = duplicate.events as Record<string, unknown>[];
    events[0] = { ...events[0], triggers: { status: 'none_reported' } };
    const result = validateBackup(duplicate, 'UTC');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'duplicate_tag_label')).toBe(true);
    }
  });

  it('rejects an inconsistent stored instant', () => {
    const inconsistent = makeBackup();
    const events = inconsistent.events as Record<string, unknown>[];
    const occurred = events[0]?.occurredAt as Record<string, unknown>;
    events[0] = { ...events[0], occurredAt: { ...occurred, wallTime: '11:30' } };
    const result = validateBackup(inconsistent, 'UTC');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'inconsistent_instant')).toBe(true);
    }
  });

  it('does not change event content across export/import validation', () => {
    const backup = makeBackup();
    const result = validateBackup(backup, 'UTC');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const source = (backup.events as Record<string, unknown>[])[0];
      expect(result.data.events[0]?.occurredAt).toEqual(source?.occurredAt);
      expect(result.data.events[0]?.affectedAreas).toEqual(source?.affectedAreas);
      expect(result.data.events[0]?.triggers).toEqual(source?.triggers);
      expect(result.data.events[0]?.rescue).toEqual(source?.rescue);
    }
  });
});

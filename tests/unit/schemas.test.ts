import { describe, expect, it } from 'vitest';
import {
  affectedAreasSchema,
  durationSchema,
  eventInputSchema,
  eventTimeSchema,
  passwordSchema,
  rescueSchema,
  restoreApplySchema,
  tagAnswerSchema,
  usernameSchema,
} from '@shared/schemas';

const AREAS = ['arms', 'legs', 'speech'] as const;

describe('affected areas (A02)', () => {
  it('accepts all seven nonempty combinations', () => {
    const combos: string[][] = [];
    for (let mask = 1; mask < 8; mask += 1) {
      combos.push(AREAS.filter((_, index) => mask & (1 << index)));
    }
    expect(combos).toHaveLength(7);
    for (const areas of combos) {
      const parsed = affectedAreasSchema.safeParse({ status: 'reported', areas });
      expect(parsed.success, areas.join(',')).toBe(true);
    }
  });

  it('keeps not recorded, unsure and none distinct', () => {
    for (const status of ['not_recorded', 'unknown', 'none_reported'] as const) {
      const parsed = affectedAreasSchema.safeParse({ status });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.status).toBe(status);
    }
  });

  it('rejects duplicates, unknown values and empty reported selections', () => {
    expect(
      affectedAreasSchema.safeParse({ status: 'reported', areas: ['arms', 'arms'] }).success,
    ).toBe(false);
    expect(
      affectedAreasSchema.safeParse({ status: 'reported', areas: ['head'] }).success,
    ).toBe(false);
    expect(affectedAreasSchema.safeParse({ status: 'reported', areas: [] }).success).toBe(false);
  });
});

describe('tag answers', () => {
  it('rejects more than 12 tags and duplicate ids', () => {
    const tags = Array.from({ length: 13 }, (_, index) => ({
      id: `tag-${index}`,
      label: `Tag ${index}`,
    }));
    expect(tagAnswerSchema.safeParse({ status: 'reported', tags }).success).toBe(false);

    const duplicate = [
      { id: 'same-id', label: 'One' },
      { id: 'same-id', label: 'Two' },
    ];
    expect(tagAnswerSchema.safeParse({ status: 'reported', tags: duplicate }).success).toBe(false);
  });

  it('rejects labels over 40 code points and accepts accented labels', () => {
    const tooLong = { id: 'x', label: 'é'.repeat(41) };
    expect(tagAnswerSchema.safeParse({ status: 'reported', tags: [tooLong] }).success).toBe(false);
    const accented = { id: 'y', label: 'Déjà vu' };
    expect(tagAnswerSchema.safeParse({ status: 'reported', tags: [accented] }).success).toBe(true);
  });
});

describe('duration', () => {
  it('validates bounds and strict shapes', () => {
    expect(durationSchema.safeParse({ status: 'exact', seconds: 1 }).success).toBe(true);
    expect(durationSchema.safeParse({ status: 'estimated', seconds: 86_400 }).success).toBe(true);
    expect(durationSchema.safeParse({ status: 'exact', seconds: 86_401 }).success).toBe(false);
    expect(durationSchema.safeParse({ status: 'exact', seconds: 0 }).success).toBe(false);
    expect(durationSchema.safeParse({ status: 'not_recorded', seconds: 5 }).success).toBe(false);
    expect(durationSchema.safeParse({ status: 'unknown' }).success).toBe(true);
  });
});

describe('rescue', () => {
  it('accepts Used with no administration details', () => {
    expect(rescueSchema.safeParse({ status: 'used', administrations: [] }).success).toBe(true);
  });

  it('requires at least one detail per administration and caps at five', () => {
    expect(
      rescueSchema.safeParse({
        status: 'used',
        administrations: [{ id: '11111111-1111-4111-8111-111111111111' }],
      }).success,
    ).toBe(false);
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `1111111${index}-1111-4111-8111-11111111111${index}`,
      name: `Name ${index}`,
    }));
    expect(rescueSchema.safeParse({ status: 'used', administrations: rows }).success).toBe(true);
    expect(
      rescueSchema.safeParse({
        status: 'used',
        administrations: [...rows, { ...rows[0], id: '33333333-3333-4333-8333-333333333333' }],
      }).success,
    ).toBe(false);
  });
});

describe('event input', () => {
  const valid = {
    occurredAt: {
      precision: 'date_only',
      captureDate: '2026-11-24',
      zone: 'Europe/Dublin',
    },
    duration: { status: 'not_recorded' },
    affectedAreas: { status: 'not_recorded' },
    triggers: { status: 'not_recorded' },
    aura: { status: 'not_recorded' },
    rescue: { status: 'not_recorded' },
  };

  it('accepts a minimal event', () => {
    expect(eventInputSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects unknown fields and invalid dates', () => {
    expect(eventInputSchema.safeParse({ ...valid, ownerId: 'x' }).success).toBe(false);
    expect(
      eventInputSchema.safeParse({
        ...valid,
        occurredAt: { precision: 'date_only', captureDate: '2026-02-30', zone: 'UTC' },
      }).success,
    ).toBe(false);
  });

  it('requires a real offset for timed entries', () => {
    expect(
      eventTimeSchema.safeParse({
        precision: 'exact',
        captureDate: '2026-11-24',
        wallTime: '10:00',
        zone: 'Europe/Dublin',
        offset: '00:00',
        instantUtc: '2026-11-24T10:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('account and restore schemas', () => {
  it('validates usernames and passwords', () => {
    expect(usernameSchema.safeParse('sample-member_1').success).toBe(true);
    expect(usernameSchema.safeParse('Sample').success).toBe(false);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(15)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('requires explicit confirmation and dataset binding for destructive actions', () => {
    expect(
      restoreApplySchema.safeParse({
        backup: {},
        digest: 'a'.repeat(64),
        expectedDataVersion: 1,
        expectedDatasetEpoch: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
    expect(
      restoreApplySchema.safeParse({
        backup: {},
        digest: 'short',
        expectedDataVersion: 1,
        expectedDatasetEpoch: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });
});

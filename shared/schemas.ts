import { z } from 'zod';
import { codePointLength, isValidTagLabel } from './tags';
import { isIsoInstant, isRealPlainDate, isValidIanaZone, isWallTime } from './time';

export const MAX_NOTES_CODE_POINTS = 2000;
export const MAX_EVENT_LABEL_CODE_POINTS = 60;
export const MAX_DISPLAY_LABEL_CODE_POINTS = 80;
export const MAX_NAME_CODE_POINTS = 80;
export const MAX_DOSE_CODE_POINTS = 60;
export const MAX_TIMING_CODE_POINTS = 80;
export const MAX_ADMINISTRATIONS = 5;
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

const cpString = (max: number) =>
  z.string().refine((value) => codePointLength(value) <= max, {
    message: `Must be at most ${max} characters.`,
  });

export const plainDateSchema = z
  .string()
  .refine(isRealPlainDate, { message: 'Enter a real calendar date (YYYY-MM-DD).' });

export const instantSchema = z
  .string()
  .refine(isIsoInstant, { message: 'Instant must be ISO 8601 UTC ending in Z.' });

export const ianaZoneSchema = z
  .string()
  .refine(isValidIanaZone, { message: 'Choose a valid IANA time zone.' });

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._-]+$/, {
    message: 'Use 3–32 characters: lowercase letters, digits, dot, underscore or hyphen.',
  });

export const passwordSchema = z
  .string()
  .min(15, { message: 'Use at least 15 characters.' })
  .max(128, { message: 'Use at most 128 characters.' });

export const tagRefSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z
      .string()
      .refine((value) => isValidTagLabel(value), {
        message: 'Each tag label must be 1–40 characters.',
      }),
  })
  .strict();

const tagStatusObject = (status: 'not_recorded' | 'unknown' | 'none_reported') =>
  z.object({ status: z.literal(status) }).strict();

export const tagAnswerSchema = z
  .union([
    tagStatusObject('not_recorded'),
    tagStatusObject('unknown'),
    tagStatusObject('none_reported'),
    z
      .object({
        status: z.literal('reported'),
        tags: z.array(tagRefSchema).min(1).max(12),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.status !== 'reported') return;
    const seenIds = new Set<string>();
    const seenLabels = new Set<string>();
    for (const tag of value.tags) {
      if (seenIds.has(tag.id)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate tag id.', path: ['tags'] });
      }
      seenIds.add(tag.id);
      const normalized = tag.label.normalize('NFKC').trim().toLowerCase();
      if (seenLabels.has(normalized)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate tag label.', path: ['tags'] });
      }
      seenLabels.add(normalized);
    }
  });

const areaStatusObject = (status: 'not_recorded' | 'unknown' | 'none_reported') =>
  z.object({ status: z.literal(status) }).strict();

export const affectedAreasSchema = z
  .union([
    areaStatusObject('not_recorded'),
    areaStatusObject('unknown'),
    areaStatusObject('none_reported'),
    z
      .object({
        status: z.literal('reported'),
        areas: z.array(z.enum(['arms', 'legs', 'speech'])).min(1).max(3),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.status !== 'reported') return;
    const seen = new Set<string>();
    for (const area of value.areas) {
      if (seen.has(area)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate affected area.', path: ['areas'] });
      }
      seen.add(area);
    }
  });

const durationStatusObject = (status: 'not_recorded' | 'unknown') =>
  z.object({ status: z.literal(status) }).strict();

export const durationSchema = z.discriminatedUnion('status', [
  durationStatusObject('not_recorded'),
  durationStatusObject('unknown'),
  z.object({ status: z.literal('exact'), seconds: z.number().int().min(1).max(86_400) }).strict(),
  z
    .object({ status: z.literal('estimated'), seconds: z.number().int().min(1).max(86_400) })
    .strict(),
]);

const administrationSchema = z
  .object({
    id: z.string().uuid(),
    name: cpString(MAX_NAME_CODE_POINTS).optional(),
    doseAsReported: cpString(MAX_DOSE_CODE_POINTS).optional(),
    timingAsReported: cpString(MAX_TIMING_CODE_POINTS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasAny =
      (value.name && value.name.trim().length > 0) ||
      (value.doseAsReported && value.doseAsReported.trim().length > 0) ||
      (value.timingAsReported && value.timingAsReported.trim().length > 0);
    if (!hasAny) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each administration needs at least one recorded detail.',
      });
    }
  });

export const rescueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_recorded') }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('not_used') }).strict(),
  z
    .object({
      status: z.literal('used'),
      administrations: z.array(administrationSchema).max(MAX_ADMINISTRATIONS),
    })
    .strict(),
]);

const timedObject = (precision: 'exact' | 'approximate') =>
  z
    .object({
      precision: z.literal(precision),
      captureDate: plainDateSchema,
      wallTime: z.string().refine(isWallTime, { message: 'Enter a time as HH:MM.' }),
      zone: ianaZoneSchema,
      offset: z.string().regex(/^[+-]\d{2}:\d{2}$/, { message: 'Offset must look like +01:00.' }),
      instantUtc: instantSchema,
    })
    .strict();

export const eventTimeSchema = z.discriminatedUnion('precision', [
  z
    .object({
      precision: z.literal('date_only'),
      captureDate: plainDateSchema,
      zone: ianaZoneSchema,
    })
    .strict(),
  timedObject('exact'),
  timedObject('approximate'),
]);

export const eventInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    occurredAt: eventTimeSchema,
    duration: durationSchema,
    affectedAreas: affectedAreasSchema,
    triggers: tagAnswerSchema,
    aura: tagAnswerSchema,
    rescue: rescueSchema,
    eventLabel: cpString(MAX_EVENT_LABEL_CODE_POINTS).optional(),
    notes: cpString(MAX_NOTES_CODE_POINTS).optional(),
    expectedRevision: z.number().int().min(1).optional(),
    expectedDatasetEpoch: z.string().uuid().optional(),
  })
  .strict();

export type EventInput = z.infer<typeof eventInputSchema>;

export const deleteEventSchema = z
  .object({
    expectedRevision: z.number().int().min(1).optional(),
    expectedDatasetEpoch: z.string().uuid().optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .strict();

export const reauthenticateSchema = z.object({ password: z.string().min(1).max(128) }).strict();

export const createAccountSchema = z
  .object({
    username: z.string().min(3).max(32),
    displayLabel: cpString(MAX_DISPLAY_LABEL_CODE_POINTS).optional(),
  })
  .strict();

export const eventsQuerySchema = z
  .object({
    page: z.number().int().min(1).max(100_000).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    start: plainDateSchema.optional(),
    end: plainDateSchema.optional(),
    search: z.string().max(120).optional(),
  })
  .strict();

export const analyticsQuerySchema = z
  .object({
    start: plainDateSchema,
    end: plainDateSchema,
    granularity: z.enum(['day', 'week', 'month']),
  })
  .strict();

export const reportPreviewSchema = z
  .object({
    start: plainDateSchema,
    end: plainDateSchema,
    granularity: z.enum(['day', 'week', 'month']).optional(),
    includeName: z.boolean().optional(),
    name: cpString(MAX_NAME_CODE_POINTS).optional(),
    includeNotes: z.boolean().optional(),
  })
  .strict();

export const reportValidateSchema = z
  .object({
    start: plainDateSchema,
    end: plainDateSchema,
    granularity: z.enum(['day', 'week', 'month']).optional(),
    includeName: z.boolean(),
    name: cpString(MAX_NAME_CODE_POINTS).optional(),
    includeNotes: z.boolean(),
    dataVersion: z.number().int().min(0),
    datasetEpoch: z.string().uuid(),
    modelDigest: z.string().min(16).max(128),
  })
  .strict();

export const settingsUpdateSchema = z
  .object({
    reportZone: ianaZoneSchema,
  })
  .strict();

export const restorePreviewSchema = z
  .object({
    backup: z.unknown(),
  })
  .strict();

export const restoreApplySchema = z
  .object({
    backup: z.unknown(),
    digest: z.string().min(16).max(128),
    expectedDataVersion: z.number().int().min(0),
    expectedDatasetEpoch: z.string().uuid(),
  })
  .strict();

export const clearAllSchema = z
  .object({
    confirm: z.literal(true),
    expectedDataVersion: z.number().int().min(0),
    expectedDatasetEpoch: z.string().uuid(),
  })
  .strict();

export const tagCreateSchema = z
  .object({
    kind: z.enum(['trigger', 'aura']),
    label: z
      .string()
      .refine((value) => isValidTagLabel(value), {
        message: 'Tag labels must be 1–40 characters.',
      }),
  })
  .strict();

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function firstIssue(error: z.ZodError): {
  field: string;
  code: string;
  message: string;
}[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_',
    code: issue.code,
    message: issue.message,
  }));
}

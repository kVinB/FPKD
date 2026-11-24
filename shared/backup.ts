import { z } from 'zod';
import {
  affectedAreasSchema,
  durationSchema,
  eventTimeSchema,
  rescueSchema,
  tagAnswerSchema,
  instantSchema,
  ianaZoneSchema,
  MAX_NOTES_CODE_POINTS,
  MAX_EVENT_LABEL_CODE_POINTS,
} from './schemas';
import { codePointLength } from './tags';
import { reproducesWallTime, isRealPlainDate } from './time';
import type { AffectedAreas, SeizureEvent } from './types';

export const BACKUP_FORMAT = 'seizure-diary';
export const BACKUP_FORMAT_VERSION = 2;

const backupTagSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['trigger', 'aura']),
    label: z
      .string()
      .refine((value) => {
        const length = codePointLength(value.trim());
        return length >= 1 && length <= 40;
      }, 'Tag labels must be 1–40 characters.'),
  })
  .strict();

const backupEventBaseSchema = z
  .object({
    id: z.string().uuid(),
    occurredAt: eventTimeSchema,
    duration: durationSchema,
    triggers: tagAnswerSchema,
    aura: tagAnswerSchema,
    rescue: rescueSchema,
    eventLabel: z
      .string()
      .refine((value) => codePointLength(value) <= MAX_EVENT_LABEL_CODE_POINTS)
      .optional(),
    notes: z.string().refine((value) => codePointLength(value) <= MAX_NOTES_CODE_POINTS).optional(),
  })
  .strict();

const backupEventSchema = backupEventBaseSchema.extend({
  affectedAreas: affectedAreasSchema,
});

const backupV2Schema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(2),
    exportedAt: instantSchema,
    settings: z
      .object({
        reportZone: ianaZoneSchema,
      })
      .strict(),
    tags: z.array(backupTagSchema).max(10_000),
    events: z.array(backupEventSchema).max(100_000),
  })
  .strict();

const backupV1EventSchema = backupEventBaseSchema.extend({
  affectedAreas: affectedAreasSchema.optional(),
});

const backupV1Schema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(1),
    exportedAt: instantSchema,
    settings: z.object({ reportZone: ianaZoneSchema }).strict().optional(),
    tags: z.array(backupTagSchema).max(10_000).optional(),
    events: z.array(backupV1EventSchema).max(100_000),
  })
  .strict();

export interface BackupEvent {
  id: string;
  occurredAt: SeizureEvent['occurredAt'];
  duration: SeizureEvent['duration'];
  affectedAreas: AffectedAreas;
  triggers: SeizureEvent['triggers'];
  aura: SeizureEvent['aura'];
  rescue: SeizureEvent['rescue'];
  eventLabel?: string;
  notes?: string;
}

export interface BackupData {
  formatVersion: 2;
  exportedAt: string;
  settings: { reportZone: string };
  tags: { id: string; kind: 'trigger' | 'aura'; label: string }[];
  events: BackupEvent[];
  convertedFromV1: boolean;
}

export interface BackupValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export type BackupValidation =
  | {
      ok: true;
      data: BackupData;
      counts: {
        events: number;
        tags: number;
        customTags: number;
        dateOnlyEvents: number;
        timedEvents: number;
      };
    }
  | { ok: false; issues: BackupValidationIssue[] };

export function validateBackup(raw: unknown, fallbackZone: string): BackupValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, issues: [{ code: 'not_object', message: 'The backup must be a JSON object.' }] };
  }

  const formatVersion = (raw as Record<string, unknown>).formatVersion;
  let convertedFromV1 = false;
  let candidate: z.infer<typeof backupV2Schema>;

  if (formatVersion === 1) {
    const parsed = backupV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, issues: formatZodIssues(parsed.error) };
    convertedFromV1 = true;
    const events = parsed.data.events.map((event) => ({
      ...event,
      affectedAreas: event.affectedAreas ?? { status: 'not_recorded' as const },
    }));
    const normalized = {
      format: BACKUP_FORMAT,
      formatVersion: 2,
      exportedAt: parsed.data.exportedAt,
      settings: parsed.data.settings ?? { reportZone: fallbackZone },
      tags: parsed.data.tags ?? [],
      events,
    };
    const reparsed = backupV2Schema.safeParse(normalized);
    if (!reparsed.success) return { ok: false, issues: formatZodIssues(reparsed.error) };
    candidate = reparsed.data;
  } else if (formatVersion === 2) {
    const parsed = backupV2Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, issues: formatZodIssues(parsed.error) };
    candidate = parsed.data;
  } else {
    return {
      ok: false,
      issues: [
        {
          code: 'unsupported_version',
          message: `Unsupported backup formatVersion ${String(formatVersion)}. Only v1 and v2 are accepted.`,
        },
      ],
    };
  }

  return validateBackupSemantics(candidate, convertedFromV1);
}

function validateBackupSemantics(
  data: z.infer<typeof backupV2Schema>,
  convertedFromV1: boolean,
): BackupValidation {
  const issues: BackupValidationIssue[] = [];

  const tagById = new Map<string, { kind: 'trigger' | 'aura'; label: string; normalized: string }>();
  const seenNormalized = new Set<string>();
  for (const tag of data.tags) {
    if (tagById.has(tag.id)) {
      issues.push({ code: 'duplicate_tag_id', message: `Duplicate tag id ${tag.id}.`, field: 'tags' });
      continue;
    }
    const normalized = tag.label.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    const normKey = `${tag.kind}:${normalized}`;
    if (seenNormalized.has(normKey)) {
      issues.push({
        code: 'duplicate_tag_label',
        message: `Duplicate ${tag.kind} tag label "${tag.label}".`,
        field: 'tags',
      });
    }
    seenNormalized.add(normKey);
    tagById.set(tag.id, {
      kind: tag.kind,
      label: tag.label,
      normalized,
    });
  }

  const seenEventIds = new Set<string>();
  let dateOnlyEvents = 0;
  let timedEvents = 0;

  for (const [index, event] of data.events.entries()) {
    if (seenEventIds.has(event.id)) {
      issues.push({
        code: 'duplicate_event_id',
        message: `Duplicate event id ${event.id}.`,
        field: `events.${index}.id`,
      });
    }
    seenEventIds.add(event.id);

    if (!isRealPlainDate(event.occurredAt.captureDate)) {
      issues.push({
        code: 'invalid_capture_date',
        message: 'Event capture date is not a real date.',
        field: `events.${index}.occurredAt.captureDate`,
      });
    }

    if (event.occurredAt.precision === 'date_only') {
      dateOnlyEvents += 1;
    } else {
      timedEvents += 1;
      if (!reproducesWallTime(event.occurredAt)) {
        issues.push({
          code: 'inconsistent_instant',
          message:
            'Timed event does not reproduce its wall time, date, zone and offset from the stored instant.',
          field: `events.${index}.occurredAt`,
        });
      }
    }

    for (const [kind, answer] of [
      ['trigger', event.triggers],
      ['aura', event.aura],
    ] as const) {
      if (answer.status !== 'reported') continue;
      for (const tag of answer.tags) {
        const known = tagById.get(tag.id);
        if (!known) {
          issues.push({
            code: 'unknown_tag_reference',
            message: `Event references tag ${tag.id} that is not in the backup.`,
            field: `events.${index}.${kind}`,
          });
          continue;
        }
        if (known.kind !== kind) {
          issues.push({
            code: 'tag_kind_mismatch',
            message: `Tag ${tag.id} is a ${known.kind} tag but is used as a ${kind}.`,
            field: `events.${index}.${kind}`,
          });
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    data: {
      formatVersion: 2,
      exportedAt: data.exportedAt,
      settings: data.settings,
      tags: data.tags,
      events: data.events.map((event) => ({
        ...event,
        eventLabel: event.eventLabel?.trim() || undefined,
        notes: event.notes?.trim() || undefined,
      })),
      convertedFromV1,
    },
    counts: {
      events: data.events.length,
      tags: data.tags.length,
      customTags: data.tags.filter((tag) => !tag.id.startsWith('trigger-') && !tag.id.startsWith('aura-'))
        .length,
      dateOnlyEvents,
      timedEvents,
    },
  };
}

function formatZodIssues(error: z.ZodError): BackupValidationIssue[] {
  return error.issues.slice(0, 50).map((issue) => ({
    code: issue.code,
    message: issue.message,
    field: issue.path.join('.') || undefined,
  }));
}

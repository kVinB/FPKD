import crypto from 'node:crypto';
import type {
  DiarySettings,
  EventTime,
  SeizureEvent,
  Tag,
  TagAnswer,
  TagKind,
  TagRef,
} from '@shared/types';
import { BUILT_IN_AURAS, BUILT_IN_TRIGGERS, builtInTags, isValidTagLabel, normalizeTagLabel, trimText } from '@shared/tags';
import { reportDateFor } from '@shared/time';
import { canonicalJson } from '@shared/report';
import { validateEventTime } from '@shared/validate';
import type { BackupData } from '@shared/backup';
import type { EventInput } from '@shared/schemas';
import type { Db } from './connection';
import { conflict, notFound, unprocessable } from '../errors';

export interface OwnerScope {
  ownerId: string;
  db: Db;
}

export function createScope(db: Db, ownerId: string): OwnerScope {
  if (!ownerId) throw new Error('Owner scope requires an authenticated principal');
  return { ownerId, db };
}

export interface SettingsRow {
  user_id: string;
  report_zone: string;
  week_starts_on: number;
  dataset_epoch: string;
  data_version: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  owner_id: string;
  event_id: string;
  capture_date: string;
  occurred_at_json: string;
  duration_json: string;
  affected_areas_json: string;
  triggers_json: string;
  aura_json: string;
  rescue_json: string;
  event_label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface TagRow {
  owner_id: string;
  tag_id: string;
  kind: TagKind;
  label: string;
  normalized_label: string;
  built_in: number;
  created_at: string;
}

const BUILT_IN_IDS = new Set(
  [...BUILT_IN_TRIGGERS, ...BUILT_IN_AURAS].map((tag) => tag.id),
);

export function getSettingsRow(db: Db, ownerId: string): SettingsRow | undefined {
  return db.prepare('SELECT * FROM diary_settings WHERE user_id = ?').get(ownerId) as
    | SettingsRow
    | undefined;
}

export function toDiarySettings(row: SettingsRow): DiarySettings {
  return {
    reportZone: row.report_zone,
    weekStartsOn: 1,
    datasetEpoch: row.dataset_epoch,
    dataVersion: row.data_version,
  };
}

export function ensureDiarySetup(
  db: Db,
  ownerId: string,
  reportZone: string,
  now: string,
): SettingsRow {
  const existing = getSettingsRow(db, ownerId);
  if (existing) {
    seedBuiltInTags(db, ownerId, now);
    return existing;
  }
  db.prepare(
    `INSERT OR IGNORE INTO diary_settings
       (user_id, report_zone, week_starts_on, dataset_epoch, data_version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, ?, ?)`,
  ).run(ownerId, reportZone, crypto.randomUUID(), now, now);
  seedBuiltInTags(db, ownerId, now);
  return getSettingsRow(db, ownerId) as SettingsRow;
}

function requireSettings(scope: OwnerScope): SettingsRow {
  const row = getSettingsRow(scope.db, scope.ownerId);
  if (!row) {
    return ensureDiarySetup(scope.db, scope.ownerId, 'UTC', new Date().toISOString());
  }
  return row;
}

export function getSettings(scope: OwnerScope): DiarySettings {
  return toDiarySettings(requireSettings(scope));
}

export function seedBuiltInTags(db: Db, ownerId: string, now: string): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tags
       (owner_id, tag_id, kind, label, normalized_label, built_in, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  for (const kind of ['trigger', 'aura'] as const) {
    for (const tag of builtInTags(kind)) {
      insert.run(
        ownerId,
        tag.id,
        kind,
        tag.label,
        normalizeTagLabel(tag.label),
        now,
      );
    }
  }
}

export function updateReportZone(scope: OwnerScope, zone: string, now: string): DiarySettings {
  requireSettings(scope);
  scope.db
    .prepare('UPDATE diary_settings SET report_zone = ?, data_version = data_version + 1, updated_at = ? WHERE user_id = ?')
    .run(zone, now, scope.ownerId);
  return getSettings(scope);
}

function bumpDataVersion(scope: OwnerScope, now: string): void {
  scope.db
    .prepare('UPDATE diary_settings SET data_version = data_version + 1, updated_at = ? WHERE user_id = ?')
    .run(now, scope.ownerId);
}

function rotateDataset(scope: OwnerScope, now: string): void {
  scope.db
    .prepare(
      'UPDATE diary_settings SET dataset_epoch = ?, data_version = data_version + 1, updated_at = ? WHERE user_id = ?',
    )
    .run(crypto.randomUUID(), now, scope.ownerId);
}

export function listTags(scope: OwnerScope, kind?: TagKind): Tag[] {
  const rows = kind
    ? (scope.db
        .prepare('SELECT * FROM tags WHERE owner_id = ? AND kind = ? ORDER BY built_in DESC, label ASC')
        .all(scope.ownerId, kind) as TagRow[])
    : (scope.db
        .prepare('SELECT * FROM tags WHERE owner_id = ? ORDER BY kind ASC, built_in DESC, label ASC')
        .all(scope.ownerId) as TagRow[]);
  return rows.map((row) => ({
    id: row.tag_id,
    ownerId: row.owner_id,
    kind: row.kind,
    label: row.label,
    normalizedLabel: row.normalized_label,
    builtIn: row.built_in === 1,
    createdAt: row.created_at,
  }));
}

export function createTag(scope: OwnerScope, kind: TagKind, label: string, now: string): Tag {
  const trimmed = label.trim();
  const tagId = crypto.randomUUID();
  try {
    scope.db
      .prepare(
        `INSERT INTO tags (owner_id, tag_id, kind, label, normalized_label, built_in, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(scope.ownerId, tagId, kind, trimmed, normalizeTagLabel(trimmed), now);
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw conflict('tag_exists', 'A tag with that label already exists.');
    }
    throw error;
  }
  const row = scope.db
    .prepare('SELECT * FROM tags WHERE owner_id = ? AND tag_id = ?')
    .get(scope.ownerId, tagId) as TagRow;
  return {
    id: row.tag_id,
    ownerId: row.owner_id,
    kind: row.kind,
    label: row.label,
    normalizedLabel: row.normalized_label,
    builtIn: false,
    createdAt: row.created_at,
  };
}

function resolveTagAnswer(
  scope: OwnerScope,
  answer: TagAnswer,
  kind: TagKind,
  now: string,
): TagAnswer {  if (answer.status !== 'reported') return answer;

  const byId = scope.db.prepare(
    'SELECT * FROM tags WHERE owner_id = ? AND tag_id = ?',
  );
  const byNorm = scope.db.prepare(
    'SELECT * FROM tags WHERE owner_id = ? AND kind = ? AND normalized_label = ?',
  );
  const insert = scope.db.prepare(
    `INSERT INTO tags (owner_id, tag_id, kind, label, normalized_label, built_in, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  );

  const resolved: TagRef[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();

  for (const ref of answer.tags) {
    const label = ref.label.trim();
    if (!isValidTagLabel(label)) {
      throw unprocessable('Tag labels must be 1–40 characters.', [
        { field: kind, code: 'invalid_tag_label', message: `Invalid tag label "${ref.label}".` },
      ]);
    }
    const existingById = byId.get(scope.ownerId, ref.id) as TagRow | undefined;
    let chosen: TagRow | undefined;
    if (existingById) {
      if (existingById.kind !== kind) {
        throw unprocessable('A tag cannot be used with a different kind.', [
          {
            field: kind,
            code: 'tag_kind_mismatch',
            message: `Tag ${ref.id} is a ${existingById.kind} tag.`,
          },
        ]);
      }
      chosen = existingById;
    } else {
      const normalized = normalizeTagLabel(label);
      const existingByLabel = byNorm.get(scope.ownerId, kind, normalized) as TagRow | undefined;
      if (existingByLabel) {
        chosen = existingByLabel;
      } else {
        insert.run(
          scope.ownerId,
          ref.id,
          kind,
          label,
          normalized,
          now,
        );
        chosen = scope.db
          .prepare('SELECT * FROM tags WHERE owner_id = ? AND tag_id = ?')
          .get(scope.ownerId, ref.id) as TagRow;
      }
    }
    if (chosen && !seenIds.has(chosen.tag_id)) {
      const normalizedChosen = chosen.normalized_label;
      if (!seenLabels.has(normalizedChosen)) {
        seenIds.add(chosen.tag_id);
        seenLabels.add(normalizedChosen);
        resolved.push({ id: chosen.tag_id, label: chosen.label });
      }
    }
  }

  if (resolved.length === 0) return { status: 'none_reported' };
  return { status: 'reported', tags: resolved.slice(0, 12) };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function rowToEvent(row: EventRow): SeizureEvent {
  const event: SeizureEvent = {
    id: row.event_id,
    captureDate: row.capture_date,
    occurredAt: parseJson<EventTime>(row.occurred_at_json),
    duration: parseJson<SeizureEvent['duration']>(row.duration_json),
    affectedAreas: parseJson<SeizureEvent['affectedAreas']>(row.affected_areas_json),
    triggers: parseJson<TagAnswer>(row.triggers_json),
    aura: parseJson<TagAnswer>(row.aura_json),
    rescue: parseJson<SeizureEvent['rescue']>(row.rescue_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
  if (row.event_label) event.eventLabel = row.event_label;
  if (row.notes) event.notes = row.notes;
  return event;
}

function tagLabelsForComparison(answer: TagAnswer): string[] {
  if (answer.status !== 'reported') return [answer.status];
  return answer.tags.map((tag) => normalizeTagLabel(tag.label)).sort();
}

function rescueForComparison(rescue: SeizureEvent['rescue']): unknown {
  if (rescue.status !== 'used') return rescue.status;
  return {
    status: 'used',
    administrations: rescue.administrations.map((administration) => ({
      name: administration.name?.trim() ?? '',
      doseAsReported: administration.doseAsReported?.trim() ?? '',
      timingAsReported: administration.timingAsReported?.trim() ?? '',
    })),
  };
}

export function eventContentKey(event: {
  occurredAt: EventTime;
  duration: SeizureEvent['duration'];
  affectedAreas: SeizureEvent['affectedAreas'];
  triggers: TagAnswer;
  aura: TagAnswer;
  rescue: SeizureEvent['rescue'];
  eventLabel?: string;
  notes?: string;
}): string {
  return canonicalJson({
    occurredAt: event.occurredAt,
    duration: event.duration,
    affectedAreas:
      event.affectedAreas.status === 'reported'
        ? { status: 'reported', areas: [...event.affectedAreas.areas].sort() }
        : event.affectedAreas.status,
    triggers: tagLabelsForComparison(event.triggers),
    aura: tagLabelsForComparison(event.aura),
    rescue: rescueForComparison(event.rescue),
    eventLabel: trimText(event.eventLabel) ?? '',
    notes: trimText(event.notes) ?? '',
  });
}

function validateForSave(input: EventInput, now: string): void {
  const issues = validateEventTime(input.occurredAt, now);
  if (issues.length > 0) {
    throw unprocessable('Check the date, time and time zone.', issues.map((issue) => ({
      field: 'occurredAt',
      code: issue.code,
      message: issue.message,
    })));
  }
}

function insertEventRow(
  scope: OwnerScope,
  args: {
    id: string;
    input: EventInput;
    triggers: TagAnswer;
    aura: TagAnswer;
    now: string;
    revision: number;
    createdAt: string;
  },
): void {
  const label = trimText(args.input.eventLabel);
  const notes = trimText(args.input.notes);
  scope.db
    .prepare(
      `INSERT INTO events
         (owner_id, event_id, capture_date, occurred_at_json, duration_json,
          affected_areas_json, triggers_json, aura_json, rescue_json,
          event_label, notes, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.ownerId,
      args.id,
      args.input.occurredAt.captureDate,
      JSON.stringify(args.input.occurredAt),
      JSON.stringify(args.input.duration),
      JSON.stringify(args.input.affectedAreas),
      JSON.stringify(args.triggers),
      JSON.stringify(args.aura),
      JSON.stringify(args.input.rescue),
      label ?? null,
      notes ?? null,
      args.createdAt,
      args.now,
      args.revision,
    );
}

export interface WriteResult {
  event?: SeizureEvent;
  created?: boolean;
  deleted?: boolean;
  dataVersion: number;
  datasetEpoch: string;
}

export function createEvent(
  scope: OwnerScope,
  input: EventInput,
  now: string,
  expectedDatasetEpoch?: string,
): WriteResult {
  validateForSave(input, now);
  const eventId = input.id ?? crypto.randomUUID();

  const run = scope.db.transaction((): WriteResult => {
    const settings = requireSettings(scope);
    if (expectedDatasetEpoch && expectedDatasetEpoch !== settings.dataset_epoch) {
      throw conflict(
        'stale_dataset',
        'The diary changed since this form was opened. Reload before saving.',
      );
    }
    const existingRow = scope.db
      .prepare('SELECT * FROM events WHERE owner_id = ? AND event_id = ?')
      .get(scope.ownerId, eventId) as EventRow | undefined;
    if (existingRow) {
      const existing = rowToEvent(existingRow);
      if (eventContentKey(existing) === eventContentKey(input)) {
        return {
          event: existing,
          created: false,
          dataVersion: settings.data_version,
          datasetEpoch: settings.dataset_epoch,
        };
      }
      throw conflict('event_id_conflict', 'An event with this id already exists with different details.');
    }

    const triggers = resolveTagAnswer(scope, input.triggers, 'trigger', now);
    const aura = resolveTagAnswer(scope, input.aura, 'aura', now);
    insertEventRow(scope, {
      id: eventId,
      input,
      triggers,
      aura,
      now,
      revision: 1,
      createdAt: now,
    });
    bumpDataVersion(scope, now);
    const updated = getSettingsRow(scope.db, scope.ownerId) as SettingsRow;
    return {
      event: getEvent(scope, eventId) as SeizureEvent,
      created: true,
      dataVersion: updated.data_version,
      datasetEpoch: updated.dataset_epoch,
    };
  });

  return run();
}

export function getEvent(scope: OwnerScope, eventId: string): SeizureEvent | undefined {
  const row = scope.db
    .prepare('SELECT * FROM events WHERE owner_id = ? AND event_id = ?')
    .get(scope.ownerId, eventId) as EventRow | undefined;
  return row ? rowToEvent(row) : undefined;
}

export function requireEvent(scope: OwnerScope, eventId: string): SeizureEvent {
  const event = getEvent(scope, eventId);
  if (!event) throw notFound('Event not found.');
  return event;
}

export function updateEvent(
  scope: OwnerScope,
  eventId: string,
  input: EventInput,
  now: string,
  expectedDatasetEpoch?: string,
): WriteResult {
  validateForSave(input, now);
  if (input.expectedRevision === undefined) {
    throw unprocessable('Editing requires the revision you loaded.', [
      { field: 'expectedRevision', code: 'required', message: 'Load the latest entry and try again.' },
    ]);
  }

  const run = scope.db.transaction((): WriteResult => {
    const settings = requireSettings(scope);
    if (expectedDatasetEpoch && expectedDatasetEpoch !== settings.dataset_epoch) {
      throw conflict(
        'stale_dataset',
        'The diary changed since this form was opened. Reload before saving.',
      );
    }
    const existingRow = scope.db
      .prepare('SELECT * FROM events WHERE owner_id = ? AND event_id = ?')
      .get(scope.ownerId, eventId) as EventRow | undefined;
    if (!existingRow) throw notFound('Event not found.');
    if (existingRow.revision !== input.expectedRevision) {
      throw conflict(
        'stale_revision',
        'This entry changed since you opened it. Reload to see the latest version.',
        { currentRevision: existingRow.revision },
      );
    }

    const triggers = resolveTagAnswer(scope, input.triggers, 'trigger', now);
    const aura = resolveTagAnswer(scope, input.aura, 'aura', now);
    const label = trimText(input.eventLabel);
    const notes = trimText(input.notes);
    const result = scope.db
      .prepare(
        `UPDATE events SET
           capture_date = ?, occurred_at_json = ?, duration_json = ?,
           affected_areas_json = ?, triggers_json = ?, aura_json = ?,
           rescue_json = ?, event_label = ?, notes = ?, updated_at = ?, revision = revision + 1
         WHERE owner_id = ? AND event_id = ? AND revision = ?`,
      )
      .run(
        input.occurredAt.captureDate,
        JSON.stringify(input.occurredAt),
        JSON.stringify(input.duration),
        JSON.stringify(input.affectedAreas),
        JSON.stringify(triggers),
        JSON.stringify(aura),
        JSON.stringify(input.rescue),
        label ?? null,
        notes ?? null,
        now,
        scope.ownerId,
        eventId,
        input.expectedRevision,
      );
    if (result.changes === 0) {
      throw conflict('stale_revision', 'This entry changed since you opened it.');
    }
    bumpDataVersion(scope, now);
    const updated = getSettingsRow(scope.db, scope.ownerId) as SettingsRow;
    return {
      event: getEvent(scope, eventId) as SeizureEvent,
      dataVersion: updated.data_version,
      datasetEpoch: updated.dataset_epoch,
    };
  });

  return run();
}

export function deleteEvent(
  scope: OwnerScope,
  eventId: string,
  options: { expectedRevision?: number; expectedDatasetEpoch?: string },
  now: string,
): WriteResult {
  const run = scope.db.transaction((): WriteResult => {
    const settings = requireSettings(scope);
    if (options.expectedDatasetEpoch && options.expectedDatasetEpoch !== settings.dataset_epoch) {
      throw conflict('stale_dataset', 'The diary changed since this page was loaded.');
    }
    const existing = getEvent(scope, eventId);
    if (!existing) throw notFound('Event not found.');
    if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) {
      throw conflict('stale_revision', 'This entry changed since you loaded it.');
    }
    scope.db
      .prepare('DELETE FROM events WHERE owner_id = ? AND event_id = ?')
      .run(scope.ownerId, eventId);
    bumpDataVersion(scope, now);
    const updated = getSettingsRow(scope.db, scope.ownerId) as SettingsRow;
    return {
      deleted: true,
      dataVersion: updated.data_version,
      datasetEpoch: updated.dataset_epoch,
    };
  });
  return run();
}

const CANDIDATE_DAY_PADDING = 2;

function candidateRows(scope: OwnerScope, start?: string, end?: string): EventRow[] {
  if (start && end) {
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - CANDIDATE_DAY_PADDING);
    endDate.setUTCDate(endDate.getUTCDate() + CANDIDATE_DAY_PADDING);
    const padStart = startDate.toISOString().slice(0, 10);
    const padEnd = endDate.toISOString().slice(0, 10);
    return scope.db
      .prepare(
        `SELECT * FROM events
         WHERE owner_id = ? AND capture_date >= ? AND capture_date <= ?
         ORDER BY capture_date ASC, event_id ASC`,
      )
      .all(scope.ownerId, padStart, padEnd) as EventRow[];
  }
  return scope.db
    .prepare('SELECT * FROM events WHERE owner_id = ? ORDER BY capture_date ASC, event_id ASC')
    .all(scope.ownerId) as EventRow[];
}

export function listEventsForRange(
  scope: OwnerScope,
  reportZone: string,
  start: string,
  end: string,
): SeizureEvent[] {
  return candidateRows(scope, start, end)
    .map(rowToEvent)
    .filter((event) => {
      const reportDate = reportDateFor(event.occurredAt, reportZone);
      return reportDate >= start && reportDate <= end;
    });
}

export function listAllEvents(scope: OwnerScope): SeizureEvent[] {
  return candidateRows(scope).map(rowToEvent);
}

export interface EventQuery {
  page: number;
  pageSize: number;
  start?: string;
  end?: string;
  search?: string;
}

export interface EventQueryResult {
  items: SeizureEvent[];
  total: number;
  page: number;
  pageSize: number;
  reportZone: string;
  dataVersion: number;
  datasetEpoch: string;
}

function compareJournal(a: SeizureEvent & { __reportDate?: string }, b: SeizureEvent, reportZone: string): number {
  const dateA = reportDateFor(a.occurredAt, reportZone);
  const dateB = reportDateFor(b.occurredAt, reportZone);
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;

  const aDateOnly = a.occurredAt.precision === 'date_only';
  const bDateOnly = b.occurredAt.precision === 'date_only';
  if (aDateOnly !== bDateOnly) return aDateOnly ? 1 : -1;

  if (!aDateOnly && !bDateOnly) {
    const aInstant = (a.occurredAt as Extract<EventTime, { precision: 'exact' | 'approximate' }>).instantUtc;
    const bInstant = (b.occurredAt as Extract<EventTime, { precision: 'exact' | 'approximate' }>).instantUtc;
    if (aInstant !== bInstant) return aInstant < bInstant ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function queryEvents(
  scope: OwnerScope,
  reportZone: string,
  query: EventQuery,
  dataVersion: number,
  datasetEpoch: string,
): EventQueryResult {
  const rows = candidateRows(scope, query.start, query.end);
  let events = rows.map(rowToEvent);

  if (query.start && query.end) {
    events = events.filter((event) => {
      const reportDate = reportDateFor(event.occurredAt, reportZone);
      return reportDate >= (query.start as string) && reportDate <= (query.end as string);
    });
  }

  const search = query.search?.trim().toLowerCase();
  if (search) {
    events = events.filter((event) => {
      const haystack = `${event.eventLabel ?? ''}\n${event.notes ?? ''}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  events.sort((a, b) => compareJournal(a, b, reportZone));
  const total = events.length;
  const page = query.page;
  const pageSize = query.pageSize;
  const startIndex = (page - 1) * pageSize;
  return {
    items: events.slice(startIndex, startIndex + pageSize),
    total,
    page,
    pageSize,
    reportZone,
    dataVersion,
    datasetEpoch,
  };
}

export function exportDiary(scope: OwnerScope, now: string): {
  format: 'seizure-diary';
  formatVersion: 2;
  exportedAt: string;
  settings: { reportZone: string };
  tags: { id: string; kind: TagKind; label: string }[];
  events: {
    id: string;
    occurredAt: EventTime;
    duration: SeizureEvent['duration'];
    affectedAreas: SeizureEvent['affectedAreas'];
    triggers: TagAnswer;
    aura: TagAnswer;
    rescue: SeizureEvent['rescue'];
    eventLabel?: string;
    notes?: string;
  }[];
} {
  const run = scope.db.transaction(() => {
    const settings = requireSettings(scope);
    const tags = listTags(scope).map((tag) => ({
      id: tag.id,
      kind: tag.kind,
      label: tag.label,
    }));
    const events = listAllEvents(scope).map((event) => {
      const exported: ReturnType<typeof exportDiary>['events'][number] = {
        id: event.id,
        occurredAt: event.occurredAt,
        duration: event.duration,
        affectedAreas: event.affectedAreas,
        triggers: event.triggers,
        aura: event.aura,
        rescue: event.rescue,
      };
      if (event.eventLabel) exported.eventLabel = event.eventLabel;
      if (event.notes) exported.notes = event.notes;
      return exported;
    });
    return {
      format: 'seizure-diary' as const,
      formatVersion: 2 as const,
      exportedAt: now,
      settings: { reportZone: settings.report_zone },
      tags,
      events,
    };
  });
  return run();
}

export interface RestoreResult {
  events: number;
  tags: number;
  dataVersion: number;
  datasetEpoch: string;
}

export function replaceDiary(
  scope: OwnerScope,
  backup: BackupData,
  expectedDataVersion: number,
  expectedDatasetEpoch: string,
  now: string,
): RestoreResult {
  const run = scope.db.transaction((): RestoreResult => {
    const settings = requireSettings(scope);
    if (
      settings.data_version !== expectedDataVersion ||
      settings.dataset_epoch !== expectedDatasetEpoch
    ) {
      throw conflict(
        'stale_dataset',
        'The diary changed after the restore preview. Generate a new preview before restoring.',
      );
    }

    scope.db.prepare('DELETE FROM events WHERE owner_id = ?').run(scope.ownerId);
    scope.db.prepare('DELETE FROM tags WHERE owner_id = ?').run(scope.ownerId);

    const insertTag = scope.db.prepare(
      `INSERT INTO tags (owner_id, tag_id, kind, label, normalized_label, built_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const tag of backup.tags) {
      insertTag.run(
        scope.ownerId,
        tag.id,
        tag.kind,
        tag.label.trim(),
        normalizeTagLabel(tag.label),
        BUILT_IN_IDS.has(tag.id) ? 1 : 0,
        now,
      );
    }
    seedBuiltInTags(scope.db, scope.ownerId, now);

    const insertEvent = scope.db.prepare(
      `INSERT INTO events
         (owner_id, event_id, capture_date, occurred_at_json, duration_json,
          affected_areas_json, triggers_json, aura_json, rescue_json,
          event_label, notes, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    for (const event of backup.events) {
      insertEvent.run(
        scope.ownerId,
        event.id,
        event.occurredAt.captureDate,
        JSON.stringify(event.occurredAt),
        JSON.stringify(event.duration),
        JSON.stringify(event.affectedAreas),
        JSON.stringify(event.triggers),
        JSON.stringify(event.aura),
        JSON.stringify(event.rescue),
        trimText(event.eventLabel) ?? null,
        trimText(event.notes) ?? null,
        now,
        now,
      );
    }

    scope.db
      .prepare('UPDATE diary_settings SET report_zone = ?, updated_at = ? WHERE user_id = ?')
      .run(backup.settings.reportZone, now, scope.ownerId);
    rotateDataset(scope, now);
    const updated = getSettingsRow(scope.db, scope.ownerId) as SettingsRow;
    return {
      events: backup.events.length,
      tags: backup.tags.length,
      dataVersion: updated.data_version,
      datasetEpoch: updated.dataset_epoch,
    };
  });
  return run();
}

export interface ClearResult {
  dataVersion: number;
  datasetEpoch: string;
}

export function clearDiary(
  scope: OwnerScope,
  expectedDataVersion: number,
  expectedDatasetEpoch: string,
  now: string,
): ClearResult {
  const run = scope.db.transaction((): ClearResult => {
    const settings = requireSettings(scope);
    if (
      settings.data_version !== expectedDataVersion ||
      settings.dataset_epoch !== expectedDatasetEpoch
    ) {
      throw conflict(
        'stale_dataset',
        'The diary changed since this page was loaded. Reload before clearing.',
      );
    }
    scope.db.prepare('DELETE FROM events WHERE owner_id = ?').run(scope.ownerId);
    scope.db.prepare('DELETE FROM tags WHERE owner_id = ? AND built_in = 0').run(scope.ownerId);
    seedBuiltInTags(scope.db, scope.ownerId, now);
    rotateDataset(scope, now);
    const updated = getSettingsRow(scope.db, scope.ownerId) as SettingsRow;
    return { dataVersion: updated.data_version, datasetEpoch: updated.dataset_epoch };
  });
  return run();
}

export function countEvents(scope: OwnerScope): number {
  const row = scope.db
    .prepare('SELECT COUNT(*) AS count FROM events WHERE owner_id = ?')
    .get(scope.ownerId) as { count: number };
  return row.count;
}

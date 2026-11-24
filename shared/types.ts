export type PlainDateString = string;
export type InstantString = string;

export type TagRef = { id: string; label: string };

export type TagStatus = 'not_recorded' | 'unknown' | 'none_reported';
export type TagAnswer =
  | { status: TagStatus }
  | { status: 'reported'; tags: TagRef[] };

export type AffectedArea = 'arms' | 'legs' | 'speech';
export type AffectedAreaStatus = 'not_recorded' | 'unknown' | 'none_reported';
export type AffectedAreas =
  | { status: AffectedAreaStatus }
  | { status: 'reported'; areas: AffectedArea[] };

export type TimePrecision = 'exact' | 'approximate' | 'date_only';

export type EventTime =
  | { precision: 'date_only'; captureDate: PlainDateString; zone: string }
  | {
      precision: 'exact' | 'approximate';
      captureDate: PlainDateString;
      wallTime: string;
      zone: string;
      offset: string;
      instantUtc: InstantString;
    };

export type Duration =
  | { status: 'not_recorded' }
  | { status: 'unknown' }
  | { status: 'exact'; seconds: number }
  | { status: 'estimated'; seconds: number };

export type Administration = {
  id: string;
  name?: string;
  doseAsReported?: string;
  timingAsReported?: string;
};

export type Rescue =
  | { status: 'not_recorded' }
  | { status: 'unknown' }
  | { status: 'not_used' }
  | { status: 'used'; administrations: Administration[] };

export type TagKind = 'trigger' | 'aura';

export interface Tag {
  id: string;
  ownerId: string;
  kind: TagKind;
  label: string;
  normalizedLabel: string;
  builtIn: boolean;
  createdAt: InstantString;
}

export interface SeizureEvent {
  id: string;
  captureDate: PlainDateString;
  occurredAt: EventTime;
  duration: Duration;
  affectedAreas: AffectedAreas;
  triggers: TagAnswer;
  aura: TagAnswer;
  rescue: Rescue;
  eventLabel?: string;
  notes?: string;
  createdAt: InstantString;
  updatedAt: InstantString;
  revision: number;
}

export interface DiarySettings {
  reportZone: string;
  weekStartsOn: 1;
  datasetEpoch: string;
  dataVersion: number;
}

export type Role = 'member' | 'admin';
export type AccountStatus = 'active' | 'disabled';

export interface AuthUser {
  id: string;
  username: string;
  displayLabel: string | null;
  role: Role;
  status: AccountStatus;
  mustChangePassword: boolean;
}

export interface AccountSummary {
  id: string;
  username: string;
  displayLabel: string | null;
  role: Role;
  status: AccountStatus;
  mustChangePassword: boolean;
  createdAt: InstantString;
  updatedAt: InstantString;
}

export interface SessionInfo {
  user: AuthUser;
  restricted: boolean;
  reauthenticatedUntil: InstantString | null;
  csrfToken: string;
  idleExpiresAt: InstantString;
  absoluteExpiresAt: InstantString;
}

export interface RangeInput {
  start: PlainDateString;
  end: PlainDateString;
  granularity: import('./range').Granularity;
}

export interface StructuredError {
  error: {
    code: string;
    message: string;
    fields?: { field: string; code: string; message: string }[];
    details?: Record<string, unknown>;
  };
}

export const AFFECTED_AREA_LABELS: Record<AffectedArea, string> = {
  arms: 'Arms',
  legs: 'Legs',
  speech: 'Speech',
};

export const TAG_STATUS_LABELS: Record<TagStatus, string> = {
  not_recorded: 'Not recorded',
  unknown: 'Unsure',
  none_reported: 'None reported',
};

export const AREA_STATUS_LABELS: Record<AffectedAreaStatus, string> = {
  not_recorded: 'Not recorded',
  unknown: 'Unsure',
  none_reported: 'None of these',
};

export const DURATION_STATUS_LABELS: Record<Duration['status'], string> = {
  not_recorded: 'Not recorded',
  unknown: 'Unsure',
  exact: 'Exact',
  estimated: 'Estimated',
};

export const RESCUE_STATUS_LABELS: Record<Rescue['status'], string> = {
  not_recorded: 'Not recorded',
  unknown: 'Unsure',
  not_used: 'Not used',
  used: 'Used',
};

export const TIME_PRECISION_LABELS: Record<TimePrecision, string> = {
  exact: 'Exact',
  approximate: 'Approximate',
  date_only: 'Date only',
};

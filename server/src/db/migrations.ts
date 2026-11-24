import type { Db } from './connection';

export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_label TEXT,
          role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          password_hash TEXT NOT NULL,
          must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
          temp_password_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
          csrf_token TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          idle_expires_at TEXT NOT NULL,
          absolute_expires_at TEXT NOT NULL,
          reauthenticated_until TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expiry ON sessions(idle_expires_at, absolute_expires_at);

        CREATE TABLE diary_settings (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          report_zone TEXT NOT NULL,
          week_starts_on INTEGER NOT NULL DEFAULT 1 CHECK (week_starts_on = 1),
          dataset_epoch TEXT NOT NULL,
          data_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE events (
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          capture_date TEXT NOT NULL,
          occurred_at_json TEXT NOT NULL,
          duration_json TEXT NOT NULL,
          affected_areas_json TEXT NOT NULL,
          triggers_json TEXT NOT NULL,
          aura_json TEXT NOT NULL,
          rescue_json TEXT NOT NULL,
          event_label TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (owner_id, event_id)
        );
        CREATE INDEX idx_events_owner_capture ON events(owner_id, capture_date, event_id);

        CREATE TABLE tags (
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('trigger', 'aura')),
          label TEXT NOT NULL,
          normalized_label TEXT NOT NULL,
          built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
          created_at TEXT NOT NULL,
          PRIMARY KEY (owner_id, tag_id)
        );
        CREATE UNIQUE INDEX uq_tags_owner_kind_norm
          ON tags(owner_id, kind, normalized_label);

        CREATE TABLE account_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          actor_id TEXT,
          target_id TEXT,
          action TEXT NOT NULL,
          outcome TEXT NOT NULL
        );
        CREATE INDEX idx_account_audit_created ON account_audit(created_at);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]?.version ?? 0;

export function runMigrations(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string }[];
  const known = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const row of applied) {
    if (!known.has(row.version)) {
      throw new Error(
        `Database schema version ${row.version} is newer than this application supports (${LATEST_SCHEMA_VERSION}). Refusing to start.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    apply();
  }

  return LATEST_SCHEMA_VERSION;
}

export function currentSchemaVersion(db: Db): number {
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function listMigrations(): { version: number; name: string }[] {
  return migrations.map((migration) => ({ version: migration.version, name: migration.name }));
}

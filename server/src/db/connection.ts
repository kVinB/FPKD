import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
}

export function openDatabase(dbPath: string, options: OpenOptions = {}): Db {
  const readonly = options.readonly ?? false;
  if (dbPath !== ':memory:' && !readonly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    if (dbPath !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('synchronous = FULL');
  }
  return db;
}

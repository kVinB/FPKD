import type { Db } from './connection';
import { addSecondsToInstant } from '@shared/time';

export interface SessionRow {
  token_hash: string;
  user_id: string;
  restricted: number;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  reauthenticated_until: string | null;
}

export interface CreateSessionArgs {
  userId: string;
  tokenHash: string;
  csrfToken: string;
  restricted: boolean;
  now: string;
  idleSeconds: number;
  absoluteSeconds: number;
}

export function createSession(db: Db, args: CreateSessionArgs): SessionRow {
  const idleExpiresAt = addSecondsToInstant(args.now, args.idleSeconds);
  const absoluteExpiresAt = addSecondsToInstant(args.now, args.absoluteSeconds);
  db.prepare(
    `INSERT INTO sessions
       (token_hash, user_id, restricted, csrf_token, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, reauthenticated_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    args.tokenHash,
    args.userId,
    args.restricted ? 1 : 0,
    args.csrfToken,
    args.now,
    args.now,
    idleExpiresAt,
    absoluteExpiresAt,
  );
  return findSession(db, args.tokenHash) as SessionRow;
}

export function findSession(db: Db, tokenHash: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
    | SessionRow
    | undefined;
}

export function findValidSession(db: Db, tokenHash: string, now: string): SessionRow | undefined {
  const row = findSession(db, tokenHash);
  if (!row) return undefined;
  if (row.idle_expires_at <= now) return undefined;
  if (row.absolute_expires_at <= now) return undefined;
  return row;
}

export function touchSession(
  db: Db,
  tokenHash: string,
  now: string,
  idleSeconds: number,
): SessionRow | undefined {
  const row = findSession(db, tokenHash);
  if (!row) return undefined;
  const candidate = addSecondsToInstant(now, idleSeconds);
  const idleExpiresAt = candidate < row.absolute_expires_at ? candidate : row.absolute_expires_at;
  db.prepare(
    'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?',
  ).run(now, idleExpiresAt, tokenHash);
  return { ...row, last_seen_at: now, idle_expires_at: idleExpiresAt };
}

export function setReauthenticated(
  db: Db,
  tokenHash: string,
  until: string | null,
): void {
  db.prepare('UPDATE sessions SET reauthenticated_until = ? WHERE token_hash = ?').run(
    until,
    tokenHash,
  );
}

export function deleteSession(db: Db, tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteSessionsForUser(db: Db, userId: string): number {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return result.changes;
}

export function purgeExpiredSessions(db: Db, now: string): number {
  const result = db
    .prepare('DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?')
    .run(now, now);
  return result.changes;
}

export function rotateCsrfToken(db: Db, tokenHash: string, csrfToken: string): void {
  db.prepare('UPDATE sessions SET csrf_token = ? WHERE token_hash = ?').run(csrfToken, tokenHash);
}

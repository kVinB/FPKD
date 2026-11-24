import crypto from 'node:crypto';
import type { AccountSummary, AuthUser, Role } from '@shared/types';
import type { Db } from './connection';

export interface UserRow {
  id: string;
  username: string;
  display_label: string | null;
  role: Role;
  status: 'active' | 'disabled';
  password_hash: string;
  must_change_password: number;
  temp_password_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserWithSecret extends AuthUser {
  passwordHash: string;
  tempPasswordExpiresAt: string | null;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayLabel: row.display_label,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
  };
}

export function toAccountSummary(row: UserRow): AccountSummary {
  return {
    id: row.id,
    username: row.username,
    displayLabel: row.display_label,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function getUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function withSecret(row: UserRow): UserWithSecret {
  return {
    ...toAuthUser(row),
    passwordHash: row.password_hash,
    tempPasswordExpiresAt: row.temp_password_expires_at,
  };
}

export function createUser(
  db: Db,
  args: {
    username: string;
    displayLabel?: string | null;
    role: Role;
    passwordHash: string;
    mustChangePassword: boolean;
    tempPasswordExpiresAt?: string | null;
    now: string;
  },
): UserRow {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users
       (id, username, display_label, role, status, password_hash,
        must_change_password, temp_password_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.username,
    args.displayLabel ?? null,
    args.role,
    args.passwordHash,
    args.mustChangePassword ? 1 : 0,
    args.tempPasswordExpiresAt ?? null,
    args.now,
    args.now,
  );
  return getUserById(db, id) as UserRow;
}

export function updatePassword(
  db: Db,
  userId: string,
  passwordHash: string,
  options: { mustChangePassword: boolean; tempPasswordExpiresAt: string | null; now: string },
): void {
  db.prepare(
    `UPDATE users
       SET password_hash = ?, must_change_password = ?, temp_password_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    passwordHash,
    options.mustChangePassword ? 1 : 0,
    options.tempPasswordExpiresAt,
    options.now,
    userId,
  );
}

export function consumeTemporaryPassword(db: Db, userId: string, now: string): void {
  db.prepare(
    `UPDATE users
       SET temp_password_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(now, userId);
}

export function setUserStatus(
  db: Db,
  userId: string,
  status: 'active' | 'disabled',
  now: string,
): void {
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now, userId);
}

export function listAccounts(db: Db, role?: Role): UserRow[] {
  if (role) {
    return db
      .prepare('SELECT * FROM users WHERE role = ? ORDER BY username ASC')
      .all(role) as UserRow[];
  }
  return db.prepare('SELECT * FROM users ORDER BY username ASC').all() as UserRow[];
}

export function countUsers(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  return row.count;
}

export function countAdmins(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
    .get() as { count: number };
  return row.count;
}

export interface AuditEntry {
  actorId: string | null;
  targetId: string | null;
  action: string;
  outcome: string;
}

export function recordAudit(db: Db, entry: AuditEntry, now: string): void {
  db.prepare(
    `INSERT INTO account_audit (created_at, actor_id, target_id, action, outcome)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(now, entry.actorId, entry.targetId, entry.action, entry.outcome);
}

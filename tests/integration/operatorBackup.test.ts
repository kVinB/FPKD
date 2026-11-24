import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@server/db/connection';

const CLI = 'server/src/cli.ts';

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', CLI, ...args], {
    cwd: process.cwd(),
    env,
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('operator backup CLI', () => {
  it(
    'round-trips an encrypted snapshot and revokes restored sessions',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-operator-'));
      const dbPath = path.join(dir, 'seizure-diary.sqlite3');
      const backupDir = path.join(dir, 'backups');
      const key = crypto.randomBytes(32).toString('base64');
      const wrongKey = crypto.randomBytes(32).toString('base64');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: 'http://localhost:3000',
        SECURE_COOKIES: 'false',
        SEIZURE_DIARY_DB_PATH: dbPath,
        BACKUP_DIR: backupDir,
        BACKUP_ENCRYPTION_KEY: key,
      };

      try {
        const bootstrap = runCli(
          ['bootstrap-admin', '--username', 'backup-admin', '--password-stdin'],
          env,
          'backup-admin-password-123\n',
        );
        expect(bootstrap.status, bootstrap.stderr).toBe(0);

        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const db = openDatabase(dbPath);
        try {
          const user = db
            .prepare("SELECT id FROM users WHERE username = 'backup-admin'")
            .get() as { id: string };
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO sessions
               (token_hash, user_id, restricted, csrf_token, created_at, last_seen_at,
                idle_expires_at, absolute_expires_at, reauthenticated_until)
             VALUES (?, ?, 0, 'csrf', ?, ?, '2999-01-01T00:00:00Z', '2999-01-01T00:00:00Z', NULL)`,
          ).run('stale-session-hash', user.id, now, now);
        } finally {
          db.close();
        }

        const backup = runCli(['backup', '--retain', '2'], env);
        expect(backup.status, backup.stderr).toBe(0);
        const encryptedFiles = fs
          .readdirSync(backupDir)
          .filter((file) => file.endsWith('.enc'))
          .map((file) => path.join(backupDir, file));
        expect(encryptedFiles).toHaveLength(1);
        expect(fs.readFileSync(encryptedFiles[0] as string).subarray(0, 6).toString()).toBe(
          'SDBAK1',
        );
        expect(fs.statSync(encryptedFiles[0] as string).mode & 0o777).toBe(0o600);

        const verified = runCli(['verify-backup', encryptedFiles[0] as string], env);
        expect(verified.status, verified.stderr).toBe(0);

        const wrongKeyVerify = runCli(['verify-backup', encryptedFiles[0] as string], {
          ...env,
          BACKUP_ENCRYPTION_KEY: wrongKey,
        });
        expect(wrongKeyVerify.status).not.toBe(0);

        const restored = runCli(['restore-backup', encryptedFiles[0] as string, '--force'], env);
        expect(restored.status, restored.stderr).toBe(0);

        const restoredDb = openDatabase(dbPath);
        try {
          const users = restoredDb
            .prepare('SELECT COUNT(*) AS count FROM users')
            .get() as { count: number };
          const sessions = restoredDb
            .prepare('SELECT COUNT(*) AS count FROM sessions')
            .get() as { count: number };
          const schema = restoredDb
            .prepare('SELECT MAX(version) AS version FROM schema_migrations')
            .get() as { version: number };
          expect(users.count).toBe(1);
          expect(sessions.count).toBe(0);
          expect(schema.version).toBe(1);
        } finally {
          restoredDb.close();
        }

        expect(runCli(['backup', '--retain', '2'], env).status).toBe(0);
        expect(runCli(['backup', '--retain', '2'], env).status).toBe(0);
        const retained = fs.readdirSync(backupDir).filter((file) => file.endsWith('.enc'));
        expect(retained.length).toBeGreaterThanOrEqual(1);
        expect(retained.length).toBeLessThanOrEqual(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

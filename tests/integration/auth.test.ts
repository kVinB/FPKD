import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestContext, type TestContext } from './helpers';
import { openDatabase } from '@server/db/connection';
import { runMigrations } from '@server/db/migrations';
import { getUserByUsername, countUsers } from '@server/db/users';

let context: TestContext | null = null;

afterEach(async () => {
  if (context) {
    await context.close();
    context = null;
  }
});

describe('A13 first-admin bootstrap and provisioning', () => {
  it('allows only the guest CLI to bootstrap the first admin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-cli-'));
    const dbPath = path.join(dir, 'cli.sqlite3');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:3000',
      SECURE_COOKIES: 'false',
      SEIZURE_DIARY_DB_PATH: dbPath,
    };
    try {
      const first = spawnSync(
        'npx',
        ['tsx', 'server/src/cli.ts', 'bootstrap-admin', '--username', 'cli-admin', '--password-stdin'],
        {
          cwd: process.cwd(),
          env,
          input: 'cli-admin-password-123\n',
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(first.status, first.stderr).toBe(0);

      const db = openDatabase(dbPath);
      runMigrations(db);
      expect(countUsers(db)).toBe(1);
      const admin = getUserByUsername(db, 'cli-admin');
      expect(admin?.role).toBe('admin');
      db.close();

      const second = spawnSync(
        'npx',
        ['tsx', 'server/src/cli.ts', 'bootstrap-admin', '--username', 'another-admin', '--password-stdin'],
        {
          cwd: process.cwd(),
          env,
          input: 'another-password-123\n',
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(second.status).not.toBe(0);
      expect(`${second.stdout}${second.stderr}`).toContain('already provisioned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets only an admin provision members and forces a password change', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'admin-one',
      password: 'admin-one-password-123',
      role: 'admin',
    });
    const admin = context.createClient();
    await admin.login('admin-one', 'admin-one-password-123');

    const created = await admin.json<{
      account: { id: string; username: string; role: string };
      username: string;
      temporaryPassword: string;
      expiresAt: string;
    }>('POST', '/admin/accounts', {
      body: { username: 'sample-member', displayLabel: 'Sample Member' },
      csrf: admin.sessionCsrf,
    });
    expect(created.username).toBe('sample-member');
    expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(15);

    const list = await admin.json<{ accounts: Record<string, unknown>[] }>('GET', '/admin/accounts');
    expect(list.accounts).toHaveLength(1);
    const account = list.accounts[0] as Record<string, unknown>;
    expect(account.role).toBe('member');
    expect(account).not.toHaveProperty('events');
    expect(account).not.toHaveProperty('notes');
    expect(account).not.toHaveProperty('password_hash');

    const unauthenticated = context.createClient();
    const cannotProvision = await unauthenticated.request('POST', '/admin/accounts', {
      body: { username: 'sneaky' },
    });
    expect(cannotProvision.statusCode).toBe(401);

    const member = context.createClient();
    const login = await member.login('sample-member', created.temporaryPassword);
    expect(login.restricted).toBe(true);
    expect(login.mustChangePassword).toBe(true);

    const blocked = await member.request('POST', '/events/query', {
      body: { page: 1 },
      csrf: member.sessionCsrf,
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      'password_change_required',
    );

    const readiness = await member.request('GET', '/admin/accounts');
    expect(readiness.statusCode).toBe(403);

    await member.json('POST', '/auth/change-password', {
      body: {
        currentPassword: created.temporaryPassword,
        newPassword: 'member-permanent-password-1',
      },
      csrf: member.sessionCsrf,
    });
    const session = await member.refreshSession();
    expect(session.restricted).toBe(false);
    const journal = await member.json('POST', '/events/query', {
      body: { page: 1 },
      csrf: member.sessionCsrf,
    });
    expect(journal).toBeTruthy();

    const reuse = context.createClient();
    const rejectResponse = await reuse.request('GET', '/auth/csrf');
    const rejectCsrf = (rejectResponse.json() as { csrfToken: string }).csrfToken;
    const reused = await reuse.request('POST', '/auth/login', {
      body: { username: 'sample-member', password: created.temporaryPassword },
      csrf: rejectCsrf,
    });
    expect(reused.statusCode).toBe(401);
  });

  it('expires temporary passwords', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'admin-two',
      password: 'admin-two-password-123',
      role: 'admin',
    });
    const admin = context.createClient();
    await admin.login('admin-two', 'admin-two-password-123');
    const created = await admin.json<{ temporaryPassword: string }>('POST', '/admin/accounts', {
      body: { username: 'expiring-member' },
      csrf: admin.sessionCsrf,
    });
    context.db
      .prepare("UPDATE users SET temp_password_expires_at = ? WHERE username = 'expiring-member'")
      .run('2020-01-01T00:00:00Z');
    const member = context.createClient();
    const csrfResponse = await member.request('GET', '/auth/csrf');
    const csrf = (csrfResponse.json() as { csrfToken: string }).csrfToken;
    const response = await member.request('POST', '/auth/login', {
      body: { username: 'expiring-member', password: created.temporaryPassword },
      csrf,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('A13 reset, disable and enable', () => {
  it('requires recent re-auth, revokes sessions and does not revive them on enable', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'admin-three',
      password: 'admin-three-password-123',
      role: 'admin',
    });
    const memberUser = await context.seedUser({
      username: 'member-three',
      password: 'member-three-password-123',
    });
    const admin = context.createClient();
    await admin.login('admin-three', 'admin-three-password-123');
    const member = context.createClient();
    await member.login('member-three', 'member-three-password-123');

    const noReauth = await admin.request('POST', `/admin/accounts/${memberUser.id}/reset-password`, {
      csrf: admin.sessionCsrf,
    });
    expect(noReauth.statusCode).toBe(403);
    expect((noReauth.json() as { error: { code: string } }).error.code).toBe('reauth_required');

    const wrongReauth = await admin.request('POST', '/auth/reauthenticate', {
      body: { password: 'wrong-password' },
      csrf: admin.sessionCsrf,
    });
    expect(wrongReauth.statusCode).toBe(422);

    await admin.json('POST', '/auth/reauthenticate', {
      body: { password: 'admin-three-password-123' },
      csrf: admin.sessionCsrf,
    });

    const reset = await admin.json<{ temporaryPassword: string }>(
      'POST',
      `/admin/accounts/${memberUser.id}/reset-password`,
      { csrf: admin.sessionCsrf },
    );
    expect(reset.temporaryPassword).toBeTruthy();

    const revoked = await member.request('GET', '/auth/session');
    expect(revoked.statusCode).toBe(401);

    const tempLogin = context.createClient();
    const tempSession = await tempLogin.login('member-three', reset.temporaryPassword);
    expect(tempSession.restricted).toBe(true);

    const disable = await admin.request('POST', `/admin/accounts/${memberUser.id}/disable`, {
      csrf: admin.sessionCsrf,
    });
    expect(disable.statusCode).toBe(200);
    const revokedByDisable = await tempLogin.request('GET', '/auth/session');
    expect(revokedByDisable.statusCode).toBe(401);

    const disabledLogin = context.createClient();
    const csrfResponse = await disabledLogin.request('GET', '/auth/csrf');
    const csrf = (csrfResponse.json() as { csrfToken: string }).csrfToken;
    const disabledAttempt = await disabledLogin.request('POST', '/auth/login', {
      body: { username: 'member-three', password: reset.temporaryPassword },
      csrf,
    });
    expect(disabledAttempt.statusCode).toBe(401);

    await admin.json('POST', `/admin/accounts/${memberUser.id}/enable`, {
      csrf: admin.sessionCsrf,
    });
    const oldSession = await tempLogin.request('GET', '/auth/session');
    expect(oldSession.statusCode).toBe(401);

    const consumedTemp = context.createClient();
    const consumedCsrfResponse = await consumedTemp.request('GET', '/auth/csrf');
    const consumedCsrf = (consumedCsrfResponse.json() as { csrfToken: string }).csrfToken;
    const consumedAttempt = await consumedTemp.request('POST', '/auth/login', {
      body: { username: 'member-three', password: reset.temporaryPassword },
      csrf: consumedCsrf,
    });
    expect(consumedAttempt.statusCode).toBe(401);

    const secondReset = await admin.json<{ temporaryPassword: string }>(
      'POST',
      `/admin/accounts/${memberUser.id}/reset-password`,
      { csrf: admin.sessionCsrf },
    );
    const enabledLogin = context.createClient();
    const enabled = await enabledLogin.login('member-three', secondReset.temporaryPassword);
    expect(enabled.restricted).toBe(true);
  });

  it('refuses member management targets that are admins', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'admin-four',
      password: 'admin-four-password-123',
      role: 'admin',
    });
    const otherAdmin = await context.seedUser({
      username: 'admin-five',
      password: 'admin-five-password-123',
      role: 'admin',
    });
    const client = context.createClient();
    await client.login('admin-four', 'admin-four-password-123');
    const response = await client.request('POST', `/admin/accounts/${otherAdmin.id}/disable`, {
      csrf: client.sessionCsrf,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('A10/A13 CSRF, origin and rate limits', () => {
  it('requires CSRF for mutations and validates exact origins', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'csrf-admin',
      password: 'csrf-admin-password-123',
      role: 'admin',
    });
    const client = context.createClient();
    await client.login('csrf-admin', 'csrf-admin-password-123');

    const noCsrf = await client.request('POST', '/events', {
      body: {
        occurredAt: { precision: 'date_only', captureDate: '2026-01-01', zone: 'UTC' },
        duration: { status: 'not_recorded' },
        affectedAreas: { status: 'not_recorded' },
        triggers: { status: 'not_recorded' },
        aura: { status: 'not_recorded' },
        rescue: { status: 'not_recorded' },
      },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((noCsrf.json() as { error: { code: string } }).error.code).toBe('csrf_required');

    const evil = await client.request('POST', '/events', {
      body: {},
      csrf: client.sessionCsrf,
      origin: 'https://evil.example',
    });
    expect(evil.statusCode).toBe(403);
    expect((evil.json() as { error: { code: string } }).error.code).toBe('origin_invalid');

    const missingOrigin = await client.request('POST', '/events', {
      body: {},
      csrf: client.sessionCsrf,
      origin: null,
    });
    expect(missingOrigin.statusCode).toBe(403);

    const loginNoCsrf = context.createClient();
    const response = await loginNoCsrf.request('POST', '/auth/login', {
      body: { username: 'csrf-admin', password: 'csrf-admin-password-123' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('csrf_invalid');
  });

  it('throttles repeated login failures by account and source', async () => {
    context = await createTestContext({ loginMaxAttempts: 3 });
    await context.seedUser({
      username: 'throttle-user',
      password: 'throttle-password-123',
    });
    const client = context.createClient();
    const csrfResponse = await client.request('GET', '/auth/csrf');
    const csrf = (csrfResponse.json() as { csrfToken: string }).csrfToken;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await client.request('POST', '/auth/login', {
        body: { username: 'throttle-user', password: 'wrong-password' },
        csrf,
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await client.request('POST', '/auth/login', {
      body: { username: 'throttle-user', password: 'throttle-password-123' },
      csrf,
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('rejects expired idle sessions', async () => {
    context = await createTestContext();
    await context.seedUser({
      username: 'expiry-user',
      password: 'expiry-password-123',
    });
    const client = context.createClient();
    await client.login('expiry-user', 'expiry-password-123');
    context.db.prepare('UPDATE sessions SET idle_expires_at = ?').run('2020-01-01T00:00:00Z');
    const response = await client.request('GET', '/auth/session');
    expect(response.statusCode).toBe(401);
  });
});

import type { FastifyInstance } from 'fastify';
import { addSecondsToInstant, nowInstant } from '@shared/time';
import {
  createAccountSchema,
  normalizeUsername,
  usernameSchema,
} from '@shared/schemas';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import {
  createUser,
  getUserById,
  getUserByUsername,
  listAccounts,
  recordAudit,
  setUserStatus,
  toAccountSummary,
  updatePassword,
} from '../db/users';
import { deleteSessionsForUser } from '../db/sessions';
import { ensureDiarySetup } from '../db/diary';
import {
  assertSessionCsrf,
  requireAdmin,
  requireRecentReauth,
} from '../auth/principal';
import { generateTemporaryPassword } from '../auth/crypto';
import { hashPassword } from '../auth/passwords';
import { conflict, notFound, unprocessable } from '../errors';
import { parse } from '../http';

export interface AdminRouteOptions {
  db: Db;
  config: Config;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRouteOptions,
): Promise<void> {
  const { db, config } = options;

  app.get('/admin/accounts', async (request) => {
    requireAdmin(db, request, config);
    const accounts = listAccounts(db, 'member').map(toAccountSummary);
    return { accounts };
  });

  app.post('/admin/accounts', async (request, reply) => {
    const principal = requireAdmin(db, request, config);
    assertSessionCsrf(request, principal);
    const body = parse(createAccountSchema, request.body);
    const username = normalizeUsername(body.username);
    const parsedUsername = usernameSchema.safeParse(username);
    if (!parsedUsername.success) {
      throw unprocessable(
        'Use 3–32 characters: lowercase letters, digits, dot, underscore or hyphen.',
        [
          {
            field: 'username',
            code: 'invalid_username',
            message: 'Use 3–32 characters: lowercase letters, digits, dot, underscore or hyphen.',
          },
        ],
      );
    }
    if (getUserByUsername(db, username)) {
      throw conflict('username_taken', 'That username is already in use.');
    }
    const displayLabel = body.displayLabel?.trim() || null;
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const now = nowInstant();
    const expiresAt = addSecondsToInstant(now, config.tempPasswordSeconds);

    const created = db.transaction(() => {
      const user = createUser(db, {
        username,
        displayLabel,
        role: 'member',
        passwordHash,
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        now,
      });
      ensureDiarySetup(db, user.id, 'UTC', now);
      recordAudit(
        db,
        {
          actorId: principal.user.id,
          targetId: user.id,
          action: 'account_create',
          outcome: 'success',
        },
        now,
      );
      return user;
    })();

    reply.code(201).send({
      account: toAccountSummary(created),
      username,
      temporaryPassword,
      expiresAt,
      notice:
        'Share this username and temporary password privately now. It will not be shown again.',
    });
  });

  app.post('/admin/accounts/:id/reset-password', async (request) => {
    const principal = requireAdmin(db, request, config);
    assertSessionCsrf(request, principal);
    requireRecentReauth(principal, config.reauthWindowSeconds);
    const { id } = request.params as { id: string };
    const target = getUserById(db, id);
    if (!target || target.role !== 'member') throw notFound('Account not found.');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const now = nowInstant();
    const expiresAt = addSecondsToInstant(now, config.tempPasswordSeconds);

    db.transaction(() => {
      updatePassword(db, target.id, passwordHash, {
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        now,
      });
      deleteSessionsForUser(db, target.id);
      recordAudit(
        db,
        {
          actorId: principal.user.id,
          targetId: target.id,
          action: 'account_reset',
          outcome: 'success',
        },
        now,
      );
    })();

    return {
      account: toAccountSummary(getUserById(db, target.id) ?? target),
      username: target.username,
      temporaryPassword,
      expiresAt,
      notice:
        'Share this temporary password privately now. It will not be shown again. The member should keep their own export.',
    };
  });

  app.post('/admin/accounts/:id/disable', async (request) => {
    const principal = requireAdmin(db, request, config);
    assertSessionCsrf(request, principal);
    const { id } = request.params as { id: string };
    const target = getUserById(db, id);
    if (!target || target.role !== 'member') throw notFound('Account not found.');
    const now = nowInstant();
    db.transaction(() => {
      setUserStatus(db, target.id, 'disabled', now);
      deleteSessionsForUser(db, target.id);
      recordAudit(
        db,
        {
          actorId: principal.user.id,
          targetId: target.id,
          action: 'account_disable',
          outcome: 'success',
        },
        now,
      );
    })();
    return { account: toAccountSummary(getUserById(db, target.id) ?? target) };
  });

  app.post('/admin/accounts/:id/enable', async (request) => {
    const principal = requireAdmin(db, request, config);
    assertSessionCsrf(request, principal);
    const { id } = request.params as { id: string };
    const target = getUserById(db, id);
    if (!target || target.role !== 'member') throw notFound('Account not found.');
    const now = nowInstant();
    db.transaction(() => {
      setUserStatus(db, target.id, 'active', now);
      recordAudit(
        db,
        {
          actorId: principal.user.id,
          targetId: target.id,
          action: 'account_enable',
          outcome: 'success',
        },
        now,
      );
    })();
    return { account: toAccountSummary(getUserById(db, target.id) ?? target) };
  });
}

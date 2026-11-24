import type { FastifyInstance } from 'fastify';
import { addSecondsToInstant, compareInstants, nowInstant } from '@shared/time';
import {
  changePasswordSchema,
  loginSchema,
  normalizeUsername,
  reauthenticateSchema,
} from '@shared/schemas';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import {
  consumeTemporaryPassword,
  getUserByUsername,
  getUserById,
  recordAudit,
  toAuthUser,
  updatePassword,
} from '../db/users';
import {
  assertSessionCsrf,
  loadPrincipal,
  requireFullPrincipal,
  requirePrincipal,
} from '../auth/principal';
import { issueSession } from '../auth/sessionService';
import { hashPassword, verifyPassword } from '../auth/passwords';
import {
  clearCsrfCookie,
  clearSessionCookie,
  readCsrfCookie,
  setCsrfCookie,
} from '../auth/cookies';
import {
  createLoginCsrfToken,
  timingSafeEqualString,
  verifyLoginCsrfToken,
} from '../auth/crypto';
import { LoginThrottle } from '../auth/loginThrottle';
import { deleteSession, deleteSessionsForUser, setReauthenticated } from '../db/sessions';
import { forbidden, tooManyRequests, unauthorized, unprocessable } from '../errors';
import { parse } from '../http';

export interface AuthRouteOptions {
  db: Db;
  config: Config;
  loginThrottle: LoginThrottle;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const { db, config, loginThrottle } = options;

  app.get('/csrf', async (request, reply) => {
    const principal = loadPrincipal(db, request, config);
    if (principal) {
      return { csrfToken: principal.csrfToken };
    }
    const issued = createLoginCsrfToken(config.csrfSecret);
    setCsrfCookie(reply, config, issued.token);
    return {
      csrfToken: issued.token,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
  });

  app.post('/login', async (request, reply) => {
    const body = parse(loginSchema, request.body);
    const normalized = normalizeUsername(body.username);
    const userKey = `user:${normalized}`;
    const ipKey = `ip:${request.ip}`;

    const loginCsrfHeader = request.headers['x-csrf-token'];
    const loginCsrfCookie = readCsrfCookie(request, config);
    if (
      typeof loginCsrfHeader !== 'string' ||
      !loginCsrfCookie ||
      !timingSafeEqualString(loginCsrfHeader, loginCsrfCookie) ||
      !verifyLoginCsrfToken(config.csrfSecret, loginCsrfHeader)
    ) {
      throw forbidden('csrf_invalid', 'Refresh the page and try signing in again.');
    }

    if (loginThrottle.isBlocked(ipKey) || loginThrottle.isBlocked(userKey)) {
      throw tooManyRequests();
    }

    const now = nowInstant();
    const fail = (): never => {
      loginThrottle.fail(ipKey);
      loginThrottle.fail(userKey);
      throw unauthorized('invalid_credentials', 'Username or password is incorrect.');
    };

    const row = getUserByUsername(db, normalized);
    if (!row || row.status !== 'active') {
      return fail();
    }

    if (row.must_change_password === 1) {
      if (!row.temp_password_expires_at) return fail();
      if (compareInstants(row.temp_password_expires_at, now) <= 0) return fail();
      const valid = await verifyPassword(row.password_hash, body.password);
      if (!valid) return fail();

      const run = db.transaction(() => {
        consumeTemporaryPassword(db, row.id, now);
        return issueSession(db, config, request, reply, {
          userId: row.id,
          restricted: true,
          now,
        });
      });
      const issued = run();
      loginThrottle.reset(userKey);
      return {
        authenticated: true,
        user: toAuthUser({ ...row, temp_password_expires_at: null }),
        restricted: true,
        mustChangePassword: true,
        csrfToken: issued.csrfToken,
        redirect: '/change-password',
      };
    }

    const valid = await verifyPassword(row.password_hash, body.password);
    if (!valid) return fail();

    const issued = issueSession(db, config, request, reply, {
      userId: row.id,
      restricted: false,
      now,
    });
    loginThrottle.reset(userKey);
    return {
      authenticated: true,
      user: toAuthUser(row),
      restricted: false,
      mustChangePassword: false,
      csrfToken: issued.csrfToken,
      redirect: '/journal',
    };
  });

  app.get('/session', async (request) => {
    const principal = loadPrincipal(db, request, config);
    if (!principal) throw unauthorized();
    return {
      authenticated: true,
      user: principal.user,
      restricted: principal.restricted || principal.user.mustChangePassword,
      mustChangePassword: principal.user.mustChangePassword,
      csrfToken: principal.csrfToken,
      reauthenticatedUntil: principal.reauthenticatedUntil,
      idleExpiresAt: principal.idleExpiresAt,
      absoluteExpiresAt: principal.absoluteExpiresAt,
    };
  });

  app.post('/change-password', async (request, reply) => {
    const principal = requirePrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const body = parse(changePasswordSchema, request.body);
    if (body.newPassword === body.currentPassword) {
      throw unprocessable('Choose a new password that is different from the current one.', [
        {
          field: 'newPassword',
          code: 'password_reused',
          message: 'Choose a password you have not just used.',
        },
      ]);
    }

    const row = getUserById(db, principal.user.id);
    if (!row) throw unauthorized();
    const valid = await verifyPassword(row.password_hash, body.currentPassword);
    if (!valid) {
      throw unprocessable('The current password is incorrect.', [
        { field: 'currentPassword', code: 'invalid_password', message: 'Incorrect current password.' },
      ]);
    }
    const passwordHash = await hashPassword(body.newPassword);
    const now = nowInstant();
    const run = db.transaction(() => {
      updatePassword(db, row.id, passwordHash, {
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        now,
      });
      deleteSessionsForUser(db, row.id);
    });
    run();
    const issued = issueSession(db, config, request, reply, {
      userId: row.id,
      restricted: false,
      now,
    });
    recordAudit(
      db,
      { actorId: row.id, targetId: row.id, action: 'password_change', outcome: 'success' },
      now,
    );
    const updated = getUserById(db, row.id);
    return {
      authenticated: true,
      user: updated ? toAuthUser(updated) : principal.user,
      restricted: false,
      mustChangePassword: false,
      csrfToken: issued.csrfToken,
    };
  });

  app.post('/reauthenticate', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const body = parse(reauthenticateSchema, request.body);
    const row = getUserById(db, principal.user.id);
    if (!row) throw unauthorized();
    const valid = await verifyPassword(row.password_hash, body.password);
    if (!valid) {
      throw unprocessable('The password is incorrect.', [
        { field: 'password', code: 'invalid_password', message: 'Incorrect password.' },
      ]);
    }
    const until = addSecondsToInstant(nowInstant(), config.reauthWindowSeconds);
    setReauthenticated(db, principal.tokenHash, until);
    return { reauthenticatedUntil: until };
  });

  app.post('/logout', async (request, reply) => {
    const principal = requirePrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    deleteSession(db, principal.tokenHash);
    clearSessionCookie(reply, config);
    clearCsrfCookie(reply, config);
    reply.code(204).send();
  });
}

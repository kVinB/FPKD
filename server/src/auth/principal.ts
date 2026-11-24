import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '@shared/types';
import { nowInstant, compareInstants } from '@shared/time';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import { getUserById, toAuthUser } from '../db/users';
import { deleteSession, findValidSession, touchSession } from '../db/sessions';
import { readSessionCookie } from './cookies';
import { sha256Hex, timingSafeEqualString } from './crypto';
import { forbidden, unauthorized } from '../errors';

export interface Principal {
  user: AuthUser;
  tokenHash: string;
  restricted: boolean;
  csrfToken: string;
  reauthenticatedUntil: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function loadPrincipal(db: Db, request: FastifyRequest, config: Config): Principal | null {
  const token = readSessionCookie(request, config);
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const now = nowInstant();
  const session = findValidSession(db, tokenHash, now);
  if (!session) {
    if (findSessionExists(db, tokenHash)) deleteSession(db, tokenHash);
    return null;
  }
  const userRow = getUserById(db, session.user_id);
  if (!userRow || userRow.status !== 'active') {
    deleteSession(db, tokenHash);
    return null;
  }
  const touched = touchSession(db, tokenHash, now, config.sessionIdleSeconds) ?? session;
  return {
    user: toAuthUser(userRow),
    tokenHash,
    restricted: session.restricted === 1,
    csrfToken: session.csrf_token,
    reauthenticatedUntil: session.reauthenticated_until,
    idleExpiresAt: touched.idle_expires_at,
    absoluteExpiresAt: touched.absolute_expires_at,
  };
}

function findSessionExists(db: Db, tokenHash: string): boolean {
  const row = db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(tokenHash);
  return row !== undefined;
}

export function requirePrincipal(
  db: Db,
  request: FastifyRequest,
  config: Config,
): Principal {
  if (request.principal) return request.principal;
  const principal = loadPrincipal(db, request, config);
  if (!principal) throw unauthorized();
  request.principal = principal;
  return principal;
}

export function requireFullPrincipal(
  db: Db,
  request: FastifyRequest,
  config: Config,
): Principal {
  const principal = requirePrincipal(db, request, config);
  if (principal.restricted || principal.user.mustChangePassword) {
    throw forbidden(
      'password_change_required',
      'Set a permanent password before using the diary.',
    );
  }
  return principal;
}

export function requireAdmin(
  db: Db,
  request: FastifyRequest,
  config: Config,
): Principal {
  const principal = requireFullPrincipal(db, request, config);
  if (principal.user.role !== 'admin') {
    throw forbidden('admin_required', 'Administrator access is required.');
  }
  return principal;
}

export function requireRecentReauth(principal: Principal, windowSeconds: number): void {
  if (!principal.reauthenticatedUntil) {
    throw forbidden('reauth_required', 'Re-enter your password to perform this action.');
  }
  if (compareInstants(principal.reauthenticatedUntil, nowInstant()) <= 0) {
    throw forbidden('reauth_required', 'Re-enter your password to perform this action.');
  }
  void windowSeconds;
}

export function assertSessionCsrf(request: FastifyRequest, principal: Principal): void {
  const header = request.headers['x-csrf-token'];
  if (typeof header !== 'string' || header.length === 0) {
    throw forbidden('csrf_required', 'A valid CSRF token is required.');
  }
  if (!timingSafeEqualString(header, principal.csrfToken)) {
    throw forbidden('csrf_invalid', 'A valid CSRF token is required.');
  }
}

export function assertOrigin(request: FastifyRequest, config: Config): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const originHeader = request.headers.origin;
  const refererHeader = request.headers.referer;
  let origin: string | undefined;
  if (typeof originHeader === 'string' && originHeader.length > 0) {
    origin = originHeader.replace(/\/+$/, '');
  } else if (typeof refererHeader === 'string' && refererHeader.length > 0) {
    try {
      origin = new URL(refererHeader).origin;
    } catch {
      origin = undefined;
    }
  }
  if (!origin) {
    throw forbidden('origin_required', 'This request must come from the diary application.');
  }
  if (!config.allowedOrigins.includes(origin)) {
    throw forbidden('origin_invalid', 'This request came from an unexpected origin.');
  }
}

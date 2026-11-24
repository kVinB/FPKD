import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import { createSession, deleteSession, findSession, type SessionRow } from '../db/sessions';
import { randomToken, sha256Hex } from './crypto';
import { clearCsrfCookie, readSessionCookie, setSessionCookie } from './cookies';

export interface IssuedSession {
  session: SessionRow;
  csrfToken: string;
  absoluteSeconds: number;
}

export function issueSession(
  db: Db,
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; restricted: boolean; now: string },
): IssuedSession {
  const existing = readSessionCookie(request, config);
  if (existing) {
    const hash = sha256Hex(existing);
    if (findSession(db, hash)) deleteSession(db, hash);
  }

  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const csrfToken = randomToken(32);
  const absoluteSeconds = args.restricted
    ? Math.min(config.tempSessionSeconds, config.sessionAbsoluteSeconds)
    : config.sessionAbsoluteSeconds;

  const session = createSession(db, {
    userId: args.userId,
    tokenHash,
    csrfToken,
    restricted: args.restricted,
    now: args.now,
    idleSeconds: Math.min(config.sessionIdleSeconds, absoluteSeconds),
    absoluteSeconds,
  });

  setSessionCookie(reply, config, token, absoluteSeconds);
  clearCsrfCookie(reply, config);
  return { session, csrfToken, absoluteSeconds };
}

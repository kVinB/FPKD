import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
}

export function sessionCookieOptions(config: Config, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieOptions(config: Config, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(config.sessionCookieName, token, sessionCookieOptions(config, maxAgeSeconds));
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.sessionCookieName, { path: '/' });
}

export function readSessionCookie(request: FastifyRequest, config: Config): string | null {
  const value = request.cookies[config.sessionCookieName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setCsrfCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(config.csrfCookieName, token, csrfCookieOptions(config, 600));
}

export function readCsrfCookie(request: FastifyRequest, config: Config): string | null {
  const value = request.cookies[config.csrfCookieName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function clearCsrfCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.csrfCookieName, { path: '/' });
}

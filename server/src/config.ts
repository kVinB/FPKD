import 'dotenv/config';
import path from 'node:path';

export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  env: NodeEnv;
  isProduction: boolean;
  host: string;
  port: number;
  dbPath: string;
  publicOrigin: string;
  allowedOrigins: string[];
  trustedProxies: string[];
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  tempSessionSeconds: number;
  tempPasswordSeconds: number;
  reauthWindowSeconds: number;
  secureCookies: boolean;
  webDist: string;
  backupDir: string;
  csrfSecret: string;
  sessionCookieName: string;
  csrfCookieName: string;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${key}: ${raw}`);
  }
  return parsed;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function listEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV as NodeEnv | undefined) ?? 'development';
  const isProduction = nodeEnv === 'production';
  const publicOrigin = (env.PUBLIC_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(publicOrigin)) {
    throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a trailing slash or path');
  }

  const allowedOrigins = new Set<string>([publicOrigin]);
  if (!isProduction) {
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3100',
      'http://127.0.0.1:3100',
    ]) {
      allowedOrigins.add(origin);
    }
  }

  const secureCookies = boolEnv(env, 'SECURE_COOKIES', isProduction);
  const csrfSecret = env.CSRF_SECRET ?? 'development-only-csrf-secret-change-me';

  return {
    env: nodeEnv,
    isProduction,
    host: env.HOST ?? '127.0.0.1',
    port: intEnv(env, 'PORT', 3000),
    dbPath: env.SEIZURE_DIARY_DB_PATH ?? path.resolve('data/seizure-diary.sqlite3'),
    publicOrigin,
    allowedOrigins: [...allowedOrigins],
    trustedProxies: listEnv(env.TRUSTED_PROXIES ?? '127.0.0.1,::1'),
    sessionIdleSeconds: intEnv(env, 'SESSION_IDLE_SECONDS', 1800),
    sessionAbsoluteSeconds: intEnv(env, 'SESSION_ABSOLUTE_SECONDS', 43200),
    tempSessionSeconds: intEnv(env, 'TEMP_SESSION_SECONDS', 900),
    tempPasswordSeconds: intEnv(env, 'TEMP_PASSWORD_SECONDS', 172800),
    reauthWindowSeconds: intEnv(env, 'REAUTH_WINDOW_SECONDS', 300),
    secureCookies,
    webDist: env.WEB_DIST ?? path.resolve('dist/web'),
    backupDir: env.BACKUP_DIR ?? path.resolve('backups'),
    csrfSecret,
    sessionCookieName: secureCookies ? '__Host-sd_session' : 'sd_session',
    csrfCookieName: secureCookies ? '__Host-sd_csrf' : 'sd_csrf',
  };
}

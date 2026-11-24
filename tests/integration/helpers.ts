import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { loadConfig, type Config } from '@server/config';
import { openDatabase, type Db } from '@server/db/connection';
import { runMigrations } from '@server/db/migrations';
import { buildApp } from '@server/app';
import { LoginThrottle } from '@server/auth/loginThrottle';
import { hashPassword } from '@server/auth/passwords';
import { createUser, getUserById, type UserRow } from '@server/db/users';
import { ensureDiarySetup } from '@server/db/diary';
import { nowInstant } from '@shared/time';

export const TEST_ORIGIN = 'http://localhost:3000';

export interface TestContext {
  dir: string;
  dbPath: string;
  config: Config;
  db: Db;
  app: FastifyInstance;
  createClient: () => TestClient;
  seedUser: (args: {
    username: string;
    password: string;
    role?: 'member' | 'admin';
    displayLabel?: string;
  }) => Promise<UserRow>;
  reopen: () => Promise<void>;
  close: () => Promise<void>;
}

export class TestClient {
  private cookies = new Map<string, string>();
  sessionCsrf = '';

  constructor(
    private readonly app: FastifyInstance,
    private readonly config: Config,
  ) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private captureCookies(response: LightMyRequestResponse): void {
    const header = response.headers['set-cookie'];
    if (!header) return;
    const list = Array.isArray(header) ? header : [String(header)];
    for (const entry of list) {
      const pair = entry.split(';')[0];
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: NonNullable<InjectOptions['method']>,
    url: string,
    options: {
      body?: unknown;
      csrf?: string;
      headers?: Record<string, string>;
      origin?: string | null;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      ...(options.origin === null ? {} : { origin: options.origin ?? TEST_ORIGIN }),
      ...(options.headers ?? {}),
    };
    const response = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
    this.captureCookies(response);
    return response;
  }

  async json<T>(
    method: NonNullable<InjectOptions['method']>,
    url: string,
    options: {
      body?: unknown;
      csrf?: string;
      headers?: Record<string, string>;
      origin?: string | null;
    } = {},
  ): Promise<T> {
    const response = await this.request(method, url, options);
    if (response.statusCode >= 400) {
      throw new Error(`${method} ${url} failed ${response.statusCode}: ${response.body}`);
    }
    if (response.statusCode === 204) return undefined as T;
    return response.json() as T;
  }

  async login(username: string, password: string): Promise<{
    user: { id: string; username: string; role: string; mustChangePassword: boolean };
    restricted: boolean;
    mustChangePassword: boolean;
    csrfToken: string;
    redirect: string;
  }> {
    const csrfResponse = await this.request('GET', '/auth/csrf');
    const csrf = (csrfResponse.json() as { csrfToken: string }).csrfToken;
    const response = await this.request('POST', '/auth/login', {
      body: { username, password },
      csrf,
    });
    if (response.statusCode !== 200) {
      throw new Error(`login failed ${response.statusCode}: ${response.body}`);
    }
    const data = response.json() as {
      user: { id: string; username: string; role: string; mustChangePassword: boolean };
      restricted: boolean;
      mustChangePassword: boolean;
      csrfToken: string;
      redirect: string;
    };
    this.sessionCsrf = data.csrfToken;
    return data;
  }

  async refreshSession(): Promise<{
    user: { id: string; username: string; role: string; mustChangePassword: boolean };
    restricted: boolean;
    csrfToken: string;
  }> {
    const data = await this.json<{
      user: { id: string; username: string; role: string; mustChangePassword: boolean };
      restricted: boolean;
      csrfToken: string;
    }>('GET', '/auth/session');
    this.sessionCsrf = data.csrfToken;
    return data;
  }
}

export async function createTestContext(
  options: { loginMaxAttempts?: number } = {},
): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-test-'));
  const dbPath = path.join(dir, 'test.sqlite3');
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3000',
    PUBLIC_ORIGIN: TEST_ORIGIN,
    SECURE_COOKIES: 'false',
    SEIZURE_DIARY_DB_PATH: dbPath,
    CSRF_SECRET: 'test-only-csrf-secret',
    SESSION_IDLE_SECONDS: '1800',
    SESSION_ABSOLUTE_SECONDS: '43200',
    TEMP_SESSION_SECONDS: '900',
    TEMP_PASSWORD_SECONDS: '172800',
    REAUTH_WINDOW_SECONDS: '300',
    BACKUP_DIR: path.join(dir, 'backups'),
  });

  let db = openDatabase(dbPath);
  runMigrations(db);
  let app = await buildApp(config, {
    db,
    loginThrottle: new LoginThrottle({
      maxAttempts: options.loginMaxAttempts ?? 1000,
    }),
  });
  await app.ready();

  const seedUser = async (args: {
    username: string;
    password: string;
    role?: 'member' | 'admin';
    displayLabel?: string;
  }): Promise<UserRow> => {
    const now = nowInstant();
    const passwordHash = await hashPassword(args.password);
    const user = createUser(db, {
      username: args.username,
      displayLabel: args.displayLabel ?? null,
      role: args.role ?? 'member',
      passwordHash,
      mustChangePassword: false,
      tempPasswordExpiresAt: null,
      now,
    });
    ensureDiarySetup(db, user.id, 'UTC', now);
    return getUserById(db, user.id) as UserRow;
  };

  return {
    dir,
    dbPath,
    config,
    get db() {
      return db;
    },
    get app() {
      return app;
    },
    createClient: () => new TestClient(app, config),
    seedUser,
    async reopen() {
      await app.close();
      db.close();
      db = openDatabase(dbPath);
      runMigrations(db);
      app = await buildApp(config, {
        db,
        loginThrottle: new LoginThrottle({
          maxAttempts: options.loginMaxAttempts ?? 1000,
        }),
      });
      await app.ready();
    },
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function isoNow(): string {
  return nowInstant();
}

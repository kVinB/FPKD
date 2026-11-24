import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { nowInstant } from '@shared/time';
import type { Config } from './config';
import type { Db } from './db/connection';
import { currentSchemaVersion } from './db/migrations';
import { assertOrigin } from './auth/principal';
import { LoginThrottle } from './auth/loginThrottle';
import { registerErrorHandlers } from './http';
import { registerAuthRoutes } from './routes/auth';
import { registerEventRoutes } from './routes/events';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerReportRoutes } from './routes/reports';
import { registerDiaryBackupRoutes } from './routes/diaryBackup';
import { registerAdminRoutes } from './routes/admin';

export interface AppDependencies {
  db: Db;
  loginThrottle?: LoginThrottle;
}

export const APP_VERSION = '0.1.0';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export async function buildApp(config: Config, deps: AppDependencies): Promise<FastifyInstance> {
  const { db } = deps;
  const loginThrottle = deps.loginThrottle ?? new LoginThrottle();

  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.isProduction ? 'info' : 'debug',
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'req.headers["x-csrf-token"]',
                'body.password',
                'body.currentPassword',
                'body.newPassword',
                'body.backup',
              ],
              censor: '[redacted]',
            },
          },
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustedProxies,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.isProduction ? 300 : 100_000,
    timeWindow: '1 minute',
    cache: 10_000,
    allowList: config.isProduction ? [] : ['127.0.0.1', '::1'],
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      assertOrigin(request, config);
    }
    reply.header('Cache-Control', 'no-store, max-age=0');
    reply.header('Pragma', 'no-cache');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CSP);
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, max-age=0');
    }
    return payload;
  });

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    version: APP_VERSION,
    schemaVersion: currentSchemaVersion(db),
    time: nowInstant(),
  }));

  registerErrorHandlers(app);

  const routeDeps = { db, config };
  await app.register(registerAuthRoutes, {
    prefix: '/api/v1/auth',
    db,
    config,
    loginThrottle,
  });
  await app.register(registerEventRoutes, { prefix: '/api/v1', ...routeDeps });
  await app.register(registerAnalyticsRoutes, { prefix: '/api/v1', ...routeDeps });
  await app.register(registerReportRoutes, { prefix: '/api/v1', ...routeDeps });
  await app.register(registerDiaryBackupRoutes, { prefix: '/api/v1', ...routeDeps });
  await app.register(registerAdminRoutes, { prefix: '/api/v1', ...routeDeps });

  const webDist = path.resolve(config.webDist);
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    if (fs.existsSync(path.join(webDist, 'index.html'))) {
      reply.header('Cache-Control', 'no-store');
      reply.type('text/html').send(fs.createReadStream(path.join(webDist, 'index.html')));
      return;
    }
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
  });

  return app;
}

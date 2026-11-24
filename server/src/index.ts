import { loadConfig } from './config';
import { openDatabase } from './db/connection';
import { runMigrations } from './db/migrations';
import { buildApp, APP_VERSION } from './app';
import { purgeExpiredSessions } from './db/sessions';
import { nowInstant } from '@shared/time';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const schemaVersion = runMigrations(db);
  purgeExpiredSessions(db, nowInstant());

  const app = await buildApp(config, { db });

  const cleanup = setInterval(() => {
    try {
      purgeExpiredSessions(db, nowInstant());
    } catch (error) {
      app.log.error({ err: { message: (error as Error).message } }, 'session purge failed');
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(cleanup);
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { version: APP_VERSION, schemaVersion, dbPath: config.dbPath, origin: config.publicOrigin },
    'Seizure Diary API ready',
  );
}

main().catch((error: unknown) => {
  console.error('Failed to start Seizure Diary:', (error as Error).message);
  process.exit(1);
});

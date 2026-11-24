import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-e2e-'));
const dbPath = path.join(dir, 'e2e.sqlite3');
const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3100',
  PUBLIC_ORIGIN: 'http://127.0.0.1:3100',
  SECURE_COOKIES: 'false',
  SEIZURE_DIARY_DB_PATH: dbPath,
  WEB_DIST: path.resolve('dist/web'),
  BACKUP_DIR: path.join(dir, 'backups'),
  CSRF_SECRET: 'e2e-static-csrf-secret-not-for-production',
  SESSION_IDLE_SECONDS: '1800',
  SESSION_ABSOLUTE_SECONDS: '43200',
  TEMP_SESSION_SECONDS: '900',
  TEMP_PASSWORD_SECONDS: '172800',
  REAUTH_WINDOW_SECONDS: '300',
};

const seed = spawnSync(
  'npx',
  [
    'tsx',
    'server/src/cli.ts',
    'bootstrap-admin',
    '--username',
    'e2e-admin',
    '--display-label',
    'E2E Admin',
    '--password-stdin',
  ],
  {
    cwd,
    env,
    input: 'e2e-admin-password-123\n',
    encoding: 'utf8',
    timeout: 120_000,
  },
);
if (seed.status !== 0) {
  console.error('Failed to seed E2E admin:', seed.stdout, seed.stderr);
  process.exit(1);
}

let child = null;
let shuttingDown = false;

function cleanup() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => {
    cleanup();
    process.exit(0);
  }, 500).unref?.();
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('exit', cleanup);

child = spawn(process.execPath, ['dist/server/index.js'], { cwd, env, stdio: 'inherit' });

child.on('close', (code) => {
  if (!shuttingDown) {
    cleanup();
    process.exit(code ?? 1);
  }
});

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const UPDATE = path.join(ROOT, 'deploy/proxmox/update.sh');
const RELEASE_TOOL = path.join(ROOT, 'deploy/proxmox/release.mjs');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const CAN_SUDO =
  !IS_ROOT &&
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const CAN_RUN = IS_ROOT || CAN_SUDO;

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function fakeCli(): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === 'backup' && process.env.MOCK_BACKUP_FAIL === '1') process.exit(1);
if (mode === 'migrate' && process.env.MOCK_MIGRATE_FAIL === '1') process.exit(1);
process.exit(0);
`;
}

function copyDeploy(target: string): void {
  for (const file of [
    'deploy/proxmox/seizure-diary',
    'deploy/proxmox/update.sh',
    'deploy/proxmox/release.mjs',
    'deploy/proxmox/systemd/seizure-diary.service',
    'deploy/proxmox/systemd/seizure-diary-backup.service',
    'deploy/proxmox/systemd/seizure-diary-backup.timer',
  ]) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(target, file));
  }
}

interface Bundle {
  buffer: Buffer;
  sha: string;
}

function buildBundle(version: string): Bundle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-bundle-'));
  try {
    copyDeploy(dir);
    write(path.join(dir, 'dist/server/cli.js'), fakeCli(), 0o755);
    write(path.join(dir, 'dist/server/index.js'), '// fixture server\n');
    write(path.join(dir, 'dist/web/index.html'), '<!doctype html><title>fixture</title>\n');
    write(path.join(dir, 'node_modules/.keep'), '');
    write(path.join(dir, '.deployed-version'), `${version}\n`);
    const output = path.join(os.tmpdir(), `seizure-diary-${version}-${Date.now()}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', output, '-C', dir, '.'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const buffer = fs.readFileSync(output);
    fs.rmSync(output, { force: true });
    return { buffer, sha: crypto.createHash('sha256').update(buffer).digest('hex') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface FixtureOptions {
  current?: string;
  target?: string;
  assetAvailable?: boolean;
  releaseAvailable?: boolean;
  badChecksum?: boolean;
}

interface Fixture {
  dir: string;
  appRoot: string;
  current: string;
  target: string;
  env: NodeJS.ProcessEnv;
  log: string;
  currentLink: () => string;
  serviceState: () => string;
  cleanup: () => Promise<void>;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const current = options.current ?? '20261124.01';
  const target = options.target ?? '20261124.02';
  const bundle = buildBundle(target);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-update-'));
  const appRoot = path.join(dir, 'app');
  const releases = path.join(appRoot, 'releases');
  const currentRelease = path.join(releases, current);
  write(path.join(currentRelease, 'dist/server/cli.js'), fakeCli(), 0o755);
  write(path.join(currentRelease, '.deployed-version'), `${current}\n`);
  fs.symlinkSync(currentRelease, path.join(appRoot, 'current'), 'dir');

  const server = http.createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (options.releaseAvailable === false) {
      response.writeHead(404).end('missing');
      return;
    }
    const isLatest = url.pathname === '/repos/owner/repo/releases/latest';
    const isTag = url.pathname === `/repos/owner/repo/releases/tags/${target}`;
    if (isLatest || isTag) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          tag_name: target,
          html_url: `https://example.invalid/releases/${target}`,
          assets: [
            {
              name: `seizure-diary-${target}.tar.gz`,
              url: `http://127.0.0.1:${port}/assets/bundle`,
            },
            {
              name: `seizure-diary-${target}.tar.gz.sha256`,
              url: `http://127.0.0.1:${port}/assets/sha`,
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === '/assets/bundle' && options.assetAvailable !== false) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(bundle.buffer);
      return;
    }
    if (url.pathname === '/assets/sha' && options.assetAvailable !== false) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      const checksum = options.badChecksum ? '0'.repeat(64) : bundle.sha;
      response.end(`${checksum}  seizure-diary-${target}.tar.gz\n`);
      return;
    }
    response.writeHead(404).end('missing');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const confDir = path.join(dir, 'conf');
  write(
    path.join(confDir, 'install.conf'),
    `REPO_SLUG=owner/repo
GITHUB_TOKEN_FILE=${path.join(confDir, 'token')}
APP_ROOT=${appRoot}
SERVICE_USER=root
TOOLS_DIR=${path.join(dir, 'tools')}
`,
  );
  write(
    path.join(confDir, 'seizure-diary.env'),
    `SEIZURE_DIARY_DB_PATH=${path.join(dir, 'db.sqlite3')}
BACKUP_DIR=${path.join(dir, 'backups')}
PORT=3000
BACKUP_ENCRYPTION_KEY=fixture-key
`,
  );
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  write(path.join(dir, 'tools/release.mjs'), fs.readFileSync(RELEASE_TOOL, 'utf8'), 0o755);

  const bin = path.join(dir, 'mockbin');
  const log = path.join(dir, 'commands.log');
  const state = path.join(dir, 'service-state');
  fs.mkdirSync(bin);
  fs.writeFileSync(log, '');
  fs.writeFileSync(state, 'stopped\n');
  write(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "start" ]; then printf 'running\\n' > "$MOCK_STATE"; fi
if [ "$1" = "stop" ]; then printf 'stopped\\n' > "$MOCK_STATE"; fi
exit 0
`,
    0o755,
  );
  write(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$MOCK_LOG"
exit "\${MOCK_CURL_EXIT:-0}"
`,
    0o755,
  );
  write(
    path.join(bin, 'runuser'),
    `#!/usr/bin/env bash
printf 'runuser %s\\n' "$*" >> "$MOCK_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -u) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`,
    0o755,
  );

  const binDir = path.join(dir, 'usr-local-bin');
  const systemdDir = path.join(dir, 'systemd');
  const lock = path.join(dir, 'update.lock');
  fs.mkdirSync(binDir);
  fs.mkdirSync(systemdDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    MOCK_LOG: log,
    MOCK_STATE: state,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    SEIZURE_DIARY_APP_ROOT: appRoot,
    SEIZURE_DIARY_ENV_FILE: path.join(confDir, 'seizure-diary.env'),
    SEIZURE_DIARY_INSTALL_CONF: path.join(confDir, 'install.conf'),
    SEIZURE_DIARY_SERVICE_NAME: 'seizure-diary-fixture',
    SEIZURE_DIARY_UPDATE_LOCK: lock,
    SEIZURE_DIARY_BIN_DIR: binDir,
    SEIZURE_DIARY_SYSTEMD_DIR: systemdDir,
    SEIZURE_DIARY_TOOLS_DIR: path.join(dir, 'tools'),
    SEIZURE_DIARY_HEALTH_ATTEMPTS: '1',
  };

  return {
    dir,
    appRoot,
    current,
    target,
    env,
    log,
    currentLink: () => fs.readlinkSync(path.join(appRoot, 'current')),
    serviceState: () => fs.readFileSync(state, 'utf8').trim(),
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (IS_ROOT) fs.rmSync(dir, { recursive: true, force: true });
      else spawnSync('sudo', ['-n', 'rm', '-rf', dir], { stdio: 'ignore' });
    },
  };
}

function runUpdate(
  fixture: Fixture,
  args: string[],
  overrides: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const envPairs = Object.entries({ ...fixture.env, ...overrides })
    .filter(
      ([key]) =>
        key.startsWith('SEIZURE_DIARY_') ||
        key.startsWith('MOCK_') ||
        key === 'PATH' ||
        key === 'GITHUB_API_URL',
    )
    .map(([key, value]) => `${key}=${value ?? ''}`);
  const command = IS_ROOT ? 'bash' : 'sudo';
  const commandArgs = IS_ROOT ? [UPDATE, ...args] : ['-n', 'env', ...envPairs, 'bash', UPDATE, ...args];
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env: { ...fixture.env, ...overrides },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function readLog(fixture: Fixture): string {
  return fs.readFileSync(fixture.log, 'utf8');
}

describe.skipIf(!CAN_RUN)('Proxmox updater artifact transaction paths', () => {
  it('does nothing when already at the upstream release', async () => {
    const fixture = await createFixture({ current: '20261124.02', target: '20261124.02' });
    try {
      const result = await runUpdate(fixture, ['--check']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('up to date');
      expect(readLog(fixture)).not.toContain('systemctl stop');
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses a downgrade before stopping the service', async () => {
    const fixture = await createFixture({ current: '20261124.02', target: '20261124.01' });
    try {
      const result = await runUpdate(fixture, []);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('refusing to downgrade');
      expect(readLog(fixture)).not.toContain('systemctl stop');
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves the live release untouched when download or checksum verification fails', async () => {
    const fixture = await createFixture({ assetAvailable: false });
    try {
      const result = await runUpdate(fixture, []);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('download');
      expect(readLog(fixture)).not.toContain('systemctl stop');
      expect(fixture.currentLink()).toContain(fixture.current);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a checksum mismatch before touching the live release', async () => {
    const fixture = await createFixture({ badChecksum: true });
    try {
      const result = await runUpdate(fixture, []);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('checksum');
      expect(readLog(fixture)).not.toContain('systemctl stop');
      expect(fixture.currentLink()).toContain(fixture.current);
    } finally {
      await fixture.cleanup();
    }
  });

  it('restarts the previous release when the pre-update backup fails', async () => {
    const fixture = await createFixture();
    try {
      const result = await runUpdate(fixture, [], { MOCK_BACKUP_FAIL: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('aborted before migrations');
      expect(readLog(fixture)).toContain('systemctl start seizure-diary-fixture');
      expect(fixture.currentLink()).toContain(fixture.current);
      expect(fixture.serviceState()).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed without swapping the release when migrations fail', async () => {
    const fixture = await createFixture();
    try {
      const result = await runUpdate(fixture, [], { MOCK_MIGRATE_FAIL: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION FAILED');
      expect(readLog(fixture)).toContain('systemctl stop seizure-diary-fixture');
      expect(readLog(fixture)).not.toContain('systemctl start seizure-diary-fixture');
      expect(fixture.currentLink()).toContain(fixture.current);
      expect(fixture.serviceState()).toBe('stopped');
    } finally {
      await fixture.cleanup();
    }
  });

  it('switches releases on success and leaves the service stopped on health failure', async () => {
    const success = await createFixture();
    try {
      const result = await runUpdate(success, []);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`updated: ${success.current} -> ${success.target}`);
      expect(success.currentLink()).toContain(success.target);
      expect(success.serviceState()).toBe('running');
    } finally {
      await success.cleanup();
    }

    const unhealthy = await createFixture();
    try {
      const result = await runUpdate(unhealthy, [], { MOCK_CURL_EXIT: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('NEW RELEASE DID NOT BECOME HEALTHY');
      expect(unhealthy.currentLink()).toContain(unhealthy.target);
      expect(unhealthy.serviceState()).toBe('stopped');
    } finally {
      await unhealthy.cleanup();
    }
  });

  it('refuses concurrent updates via the lock', async () => {
    const fixture = await createFixture();
    const holder = spawn('flock', [
      '-n',
      path.join(fixture.dir, 'update.lock'),
      '-c',
      'sleep 10',
    ]);
    try {
      spawnSync('sleep', ['0.3']);
      const result = await runUpdate(fixture, ['--check']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('another update is already running');
    } finally {
      holder.kill();
      await fixture.cleanup();
    }
  });
});

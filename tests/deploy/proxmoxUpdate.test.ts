import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const UPDATE = path.join(ROOT, 'deploy/proxmox/update.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const CAN_SUDO =
  !IS_ROOT &&
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const CAN_RUN = IS_ROOT || CAN_SUDO;

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function copyDeployFiles(target: string): void {
  fs.mkdirSync(path.join(target, 'deploy/proxmox/systemd'), { recursive: true });
  for (const file of [
    'deploy/proxmox/seizure-diary',
    'deploy/proxmox/update.sh',
    'deploy/proxmox/systemd/seizure-diary.service',
    'deploy/proxmox/systemd/seizure-diary-backup.service',
    'deploy/proxmox/systemd/seizure-diary-backup.timer',
  ]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(target, file));
  }
}

interface FixtureOptions {
  commitAhead?: boolean;
  divergent?: boolean;
}

interface Fixture {
  dir: string;
  appRoot: string;
  initialCommit: string;
  targetCommit: string;
  env: NodeJS.ProcessEnv;
  log: string;
  currentLink: () => string;
  cleanup: () => void;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-update-'));
  const bare = path.join(dir, 'origin.git');
  spawnSync('git', ['init', '--bare', '-q', bare]);
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  git(seed, ['init', '-q']);
  git(seed, ['config', 'user.email', 'fixture@example.invalid']);
  git(seed, ['config', 'user.name', 'Fixture']);
  write(path.join(seed, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n');
  write(path.join(seed, 'package-lock.json'), '{}\n');
  copyDeployFiles(seed);
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'initial']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-q', 'origin', 'main']);
  const initialCommit = git(seed, ['rev-parse', 'HEAD']);

  const workRoot = path.join(dir, 'work');
  fs.mkdirSync(workRoot);
  const repo = path.join(workRoot, 'repo');
  git(dir, ['clone', '-q', bare, repo]);

  let targetCommit = initialCommit;
  if (options.commitAhead) {
    write(path.join(seed, 'README.md'), 'changed\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'second']);
    git(seed, ['push', '-q', 'origin', 'main']);
    targetCommit = git(seed, ['rev-parse', 'HEAD']);
  }
  if (options.divergent) {
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    git(other, ['init', '-q']);
    git(other, ['config', 'user.email', 'other@example.invalid']);
    git(other, ['config', 'user.name', 'Other']);
    write(path.join(other, 'OTHER.md'), 'divergent\n');
    git(other, ['add', '.']);
    git(other, ['commit', '-q', '-m', 'unrelated']);
    git(other, ['branch', '-M', 'main']);
    git(other, ['remote', 'add', 'origin', bare]);
    git(other, ['push', '-q', '--force', 'origin', 'main']);
    targetCommit = git(other, ['rev-parse', 'HEAD']);
  }

  const appRoot = path.join(dir, 'app');
  const releases = path.join(appRoot, 'releases');
  const release = path.join(releases, initialCommit);
  fs.mkdirSync(path.join(release, 'dist/server'), { recursive: true });
  write(path.join(release, '.deployed-commit'), `${initialCommit}\n`);
  write(path.join(release, 'dist/server/cli.js'), '// fixture\n');
  fs.symlinkSync(release, path.join(appRoot, 'current'), 'dir');

  const confDir = path.join(dir, 'conf');
  const installConf = path.join(confDir, 'install.conf');
  const envFile = path.join(confDir, 'seizure-diary.env');
  write(
    installConf,
    [
      `REPO_URL=${bare}`,
      'REF=main',
      'DEPLOY_USER=root',
      'SERVICE_USER=root',
      `APP_ROOT=${appRoot}`,
      `WORK_DIR=${workRoot}`,
      'NODE_VERSION=22',
      '',
    ].join('\n'),
  );
  write(
    envFile,
    [
      `SEIZURE_DIARY_DB_PATH=${path.join(dir, 'seizure-diary.sqlite3')}`,
      `BACKUP_DIR=${path.join(dir, 'backups')}`,
      'PORT=3000',
      'BACKUP_ENCRYPTION_KEY=fixture-key',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });

  const bin = path.join(dir, 'mockbin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'commands.log');
  fs.writeFileSync(log, '');
  const state = path.join(dir, 'service-state');
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
  write(
    path.join(bin, 'npm'),
    `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
if [ "\${MOCK_NPM_EXIT:-0}" = "1" ]; then exit 1; fi
case "$1" in
  ci) mkdir -p node_modules; exit 0 ;;
  run)
    if [ "\${2:-}" = "build" ]; then
      mkdir -p dist/server
      printf '// built fixture\\n' > dist/server/cli.js
    fi
    exit 0
    ;;
  prune|test) exit 0 ;;
  *) exit 0 ;;
esac
`,
    0o755,
  );
  write(
    path.join(bin, 'node'),
    `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *" backup "*) exit "\${MOCK_NODE_BACKUP_EXIT:-0}" ;;
  *" migrate"*) exit "\${MOCK_NODE_MIGRATE_EXIT:-0}" ;;
  *) exit 0 ;;
esac
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
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    SEIZURE_DIARY_APP_ROOT: appRoot,
    SEIZURE_DIARY_ENV_FILE: envFile,
    SEIZURE_DIARY_INSTALL_CONF: installConf,
    SEIZURE_DIARY_SERVICE_NAME: 'seizure-diary-fixture',
    SEIZURE_DIARY_UPDATE_LOCK: lock,
    SEIZURE_DIARY_BIN_DIR: binDir,
    SEIZURE_DIARY_SYSTEMD_DIR: systemdDir,
    SEIZURE_DIARY_HEALTH_ATTEMPTS: '1',
  };

  return {
    dir,
    appRoot,
    initialCommit,
    targetCommit,
    env,
    log,
    currentLink: () => fs.readlinkSync(path.join(appRoot, 'current')),
    cleanup: () => {
      if (IS_ROOT) {
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        spawnSync('sudo', ['-n', 'rm', '-rf', dir], { stdio: 'ignore' });
      }
    },
  };
}

function runUpdate(
  fixture: Fixture,
  args: string[],
  overrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const envPairs = Object.entries({ ...fixture.env, ...overrides })
    .filter(
      ([key]) =>
        key.startsWith('SEIZURE_DIARY_') ||
        key.startsWith('GIT_CONFIG_') ||
        key === 'PATH' ||
        key.startsWith('MOCK_'),
    )
    .map(([key, value]) => `${key}=${value ?? ''}`);
  const result = IS_ROOT
    ? spawnSync('bash', [UPDATE, ...args], {
        cwd: ROOT,
        env: { ...fixture.env, ...overrides },
        encoding: 'utf8',
        timeout: 120_000,
      })
    : spawnSync('sudo', ['-n', 'env', ...envPairs, 'bash', UPDATE, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readLog(fixture: Fixture): string {
  return fs.readFileSync(fixture.log, 'utf8');
}

describe.skipIf(!CAN_RUN)('Proxmox updater transaction paths', () => {
  it('does nothing when already at the target commit', () => {
    const fixture = createFixture();
    try {
      const result = runUpdate(fixture, ['--check']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('up to date');
      const log = readLog(fixture);
      expect(log).not.toContain('systemctl stop');
      expect(fixture.currentLink()).toContain(fixture.initialCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses divergent or rewritten history before stopping the service', () => {
    const fixture = createFixture({ divergent: true });
    try {
      const result = runUpdate(fixture, []);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('not a forward descendant');
      expect(readLog(fixture)).not.toContain('systemctl stop');
      expect(fixture.currentLink()).toContain(fixture.initialCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it('leaves the live release untouched when staging build fails', () => {
    const fixture = createFixture({ commitAhead: true });
    try {
      const result = runUpdate(fixture, [], { MOCK_NPM_EXIT: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('staging build or tests failed');
      expect(readLog(fixture)).not.toContain('systemctl stop');
      expect(fixture.currentLink()).toContain(fixture.initialCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it('restarts the previous release when the pre-update backup fails', () => {
    const fixture = createFixture({ commitAhead: true });
    try {
      const result = runUpdate(fixture, [], { MOCK_NODE_BACKUP_EXIT: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('aborted before migrations');
      const log = readLog(fixture);
      expect(log).toContain('systemctl stop seizure-diary-fixture');
      expect(log).toContain('systemctl start seizure-diary-fixture');
      expect(fixture.currentLink()).toContain(fixture.initialCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails closed without swapping the release when migrations fail', () => {
    const fixture = createFixture({ commitAhead: true });
    try {
      const result = runUpdate(fixture, [], { MOCK_NODE_MIGRATE_EXIT: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION FAILED');
      const log = readLog(fixture);
      expect(log).toContain('systemctl stop seizure-diary-fixture');
      expect(log).not.toContain('systemctl start seizure-diary-fixture');
      expect(fixture.currentLink()).toContain(fixture.initialCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it('switches releases on success and leaves the service stopped on health failure', () => {
    const success = createFixture({ commitAhead: true });
    try {
      const result = runUpdate(success, []);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`updated: ${success.initialCommit} -> ${success.targetCommit}`);
      expect(success.currentLink()).toContain(success.targetCommit);
      expect(readLog(success)).toContain('systemctl start seizure-diary-fixture');
      expect(fs.readFileSync(path.join(success.dir, 'service-state'), 'utf8').trim()).toBe(
        'running',
      );
    } finally {
      success.cleanup();
    }

    const unhealthy = createFixture({ commitAhead: true });
    try {
      const result = runUpdate(unhealthy, [], { MOCK_CURL_EXIT: '1' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('NEW RELEASE DID NOT BECOME HEALTHY');
      expect(unhealthy.currentLink()).toContain(unhealthy.targetCommit);
      expect(readLog(unhealthy)).toContain('systemctl start seizure-diary-fixture');
      expect(readLog(unhealthy)).toContain('systemctl stop seizure-diary-fixture');
      expect(fs.readFileSync(path.join(unhealthy.dir, 'service-state'), 'utf8').trim()).toBe(
        'stopped',
      );
    } finally {
      unhealthy.cleanup();
    }
  });

  it('refuses concurrent updates via the lock', () => {
    const fixture = createFixture();
    const holder = spawn('flock', [
      '-n',
      path.join(fixture.dir, 'update.lock'),
      '-c',
      'sleep 10',
    ]);
    try {
      spawnSync('sleep', ['0.3']);
      const result = runUpdate(fixture, ['--check']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('another update is already running');
    } finally {
      holder.kill();
      fixture.cleanup();
    }
  });
});

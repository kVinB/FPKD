import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const INSTALL = path.join(ROOT, 'deploy/proxmox/install.sh');
const TEMPLATE = 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst';

interface MockOptions {
  templatePresent?: boolean;
  rootdirStorages?: string[];
  bridgeExists?: boolean;
  conflictId?: string;
}

interface MockEnv {
  dir: string;
  log: string;
  env: NodeJS.ProcessEnv;
  readLog: () => string;
  cleanup: () => void;
}

function writeMock(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function createMockEnv(options: MockOptions = {}): MockEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-proxmox-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'commands.log');
  fs.writeFileSync(log, '');
  const storages = (options.rootdirStorages ?? ['local']).join(' ');

  writeMock(
    bin,
    'pct',
    `#!/usr/bin/env bash
printf 'pct %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
  status)
    if [ -n "\${MOCK_CONFLICT_ID:-}" ] && [ "$2" = "\${MOCK_CONFLICT_ID}" ]; then exit 0; fi
    exit 1
    ;;
  create|start|push|exec|config|destroy) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  writeMock(
    bin,
    'pveam',
    `#!/usr/bin/env bash
printf 'pveam %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
  list)
    if [ "\${MOCK_TEMPLATE_PRESENT:-1}" = "1" ]; then printf '%s\\n' "\${MOCK_TEMPLATE_VOLID}"; fi
    exit 0
    ;;
  available)
    printf 'system  debian-12-standard_12.7-1_amd64.tar.zst\\n'
    exit 0
    ;;
  download) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  writeMock(
    bin,
    'pvesm',
    `#!/usr/bin/env bash
printf 'pvesm %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "status" ]; then
  printf 'Name Type Status Total Used Available %%\\n'
  for storage in \${MOCK_ROOTDIR_STORAGES}; do
    printf '%s dir active 100000 0 100000 0%%\\n' "$storage"
  done
  exit 0
fi
exit 0
`,
  );
  writeMock(
    bin,
    'ip',
    `#!/usr/bin/env bash
printf 'ip %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "-o" ] && [ "$2" = "link" ] && [ "$3" = "show" ] && [ "$4" = "\${MOCK_BRIDGE:-vmbr0}" ]; then
  [ "\${MOCK_BRIDGE_EXISTS:-1}" = "1" ] && exit 0
fi
exit 1
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    MOCK_LOG: log,
    MOCK_TEMPLATE_PRESENT: options.templatePresent === false ? '0' : '1',
    MOCK_TEMPLATE_VOLID: TEMPLATE,
    MOCK_ROOTDIR_STORAGES: storages,
    MOCK_BRIDGE_EXISTS: options.bridgeExists === false ? '0' : '1',
    ...(options.conflictId ? { MOCK_CONFLICT_ID: options.conflictId } : {}),
  };

  return {
    dir,
    log,
    env,
    readLog: () => fs.readFileSync(log, 'utf8'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function runInstall(
  mock: MockEnv,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [INSTALL, ...args], {
    cwd: ROOT,
    env: mock.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const baseArgs = [
  '--hostname',
  'test-diary',
  '--rootfs-storage',
  'local',
  '--template',
  TEMPLATE,
  '--bridge',
  'vmbr0',
  '--ip',
  '10.20.0.10/24',
  '--gateway',
  '10.20.0.1',
];

describe('Proxmox host installer safe paths', () => {
  it('provisions a fresh unprivileged guest without destroying anything', () => {
    const mock = createMockEnv();
    try {
      const result = runInstall(mock, [...baseArgs, '--ctid', '210', '--yes']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Seizure Diary installed in CTID 210');
      const log = mock.readLog();
      expect(log).toMatch(/pct create 210 /);
      expect(log).toContain('--unprivileged 1');
      expect(log).toContain('--rootfs local:12');
      expect(log).toContain('--onboot 1');
      expect(log).toContain('pct start 210');
      expect(log).toContain('pct push 210');
      expect(log).toContain('install-guest.sh');
      expect(log).not.toContain('pct destroy');
      expect(log).not.toContain('pveam download');
    } finally {
      mock.cleanup();
    }
  });

  it('dry-run performs no container, template or guest mutations', () => {
    const mock = createMockEnv({ templatePresent: false });
    try {
      const result = runInstall(mock, [
        '--hostname',
        'test-diary',
        '--rootfs-storage',
        'local',
        '--template-storage',
        'local',
        '--bridge',
        'vmbr0',
        '--ip',
        '10.20.0.10/24',
        '--gateway',
        '10.20.0.1',
        '--ctid',
        '211',
        '--dry-run',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Dry run complete');
      expect(result.stdout).toContain('will download');
      const log = mock.readLog();
      expect(log).not.toMatch(/pct (create|start|push|exec|destroy)/);
      expect(log).not.toMatch(/pveam download/);
      expect(log).toContain('pct status 211');
    } finally {
      mock.cleanup();
    }
  });

  it('refuses an existing CTID without creating or destroying a guest', () => {
    const mock = createMockEnv({ conflictId: '300' });
    try {
      const result = runInstall(mock, [...baseArgs, '--ctid', '300', '--yes']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('already exists');
      const log = mock.readLog();
      expect(log).not.toMatch(/pct (create|start|push|exec|destroy)/);
    } finally {
      mock.cleanup();
    }
  });

  it('requires an explicit rootfs storage when multiple are available', () => {
    const mock = createMockEnv({ rootdirStorages: ['local', 'other'] });
    try {
      const result = runInstall(mock, [
        ...baseArgs.filter((arg) => arg !== 'local' && arg !== '--rootfs-storage'),
        '--ctid',
        '212',
        '--yes',
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('multiple rootfs storages');
      expect(mock.readLog()).not.toMatch(/pct (create|start|push|exec|destroy)/);
    } finally {
      mock.cleanup();
    }
  });

  it('rejects a missing bridge and static IP without a gateway', () => {
    const noBridge = createMockEnv({ bridgeExists: false });
    try {
      const result = runInstall(noBridge, [...baseArgs, '--ctid', '213', '--yes']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('does not exist');
    } finally {
      noBridge.cleanup();
    }

    const noGateway = createMockEnv();
    try {
      const result = runInstall(noGateway, [
        '--rootfs-storage',
        'local',
        '--template',
        TEMPLATE,
        '--bridge',
        'vmbr0',
        '--ip',
        '10.20.0.10/24',
        '--ctid',
        '214',
        '--yes',
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('--gateway is required');
    } finally {
      noGateway.cleanup();
    }
  });
});

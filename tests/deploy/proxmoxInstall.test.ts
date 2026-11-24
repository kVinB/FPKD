import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const INSTALL = path.join(ROOT, 'deploy/proxmox/install.sh');
const TEMPLATE = 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const CAN_SUDO =
  !IS_ROOT &&
  spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const CAN_RUN = IS_ROOT || CAN_SUDO;

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
  writeMock(
    bin,
    'qm',
    `#!/usr/bin/env bash
printf 'qm %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
  status)
    if [ -n "\${MOCK_VM_CONFLICT_ID:-}" ] && [ "$2" = "\${MOCK_VM_CONFLICT_ID}" ]; then exit 0; fi
    exit 1
    ;;
  config) printf 'unused0: local:vm-200-disk-0\\n'; exit 0 ;;
  create|importdisk|set|resize|cloudinit|start|destroy) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  writeMock(
    bin,
    'curl',
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$MOCK_LOG"
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -fsSL) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "$out" ]; then
  case "$url" in
    *SHA512SUMS) printf 'fakehash  debian-12-genericcloud-amd64.qcow2\\n' > "$out" ;;
    *) printf 'fixture-image\\n' > "$out" ;;
  esac
fi
exit 0
`,
  );
  writeMock(
    bin,
    'sha512sum',
    `#!/usr/bin/env bash
printf 'sha512sum %s\\n' "$*" >> "$MOCK_LOG"
exit 0
`,
  );
  writeMock(
    bin,
    'ssh',
    `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"
exit 0
`,
  );
  writeMock(
    bin,
    'scp',
    `#!/usr/bin/env bash
printf 'scp %s\\n' "$*" >> "$MOCK_LOG"
exit 0
`,
  );

  writeMock(
    bin,
    'whiptail',
    `#!/usr/bin/env bash
printf 'whiptail %s\\n' "$*" >> "$MOCK_LOG"
mode=""
title=""
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --title) title="$2"; shift 2 ;;
    --default-item) shift 2 ;;
    --clear|--defaultno) shift ;;
    --menu) mode="menu"; prompt="$2"; break ;;
    --inputbox) mode="input"; prompt="$2"; break ;;
    --passwordbox) mode="password"; prompt="$2"; break ;;
    --yesno) mode="yesno"; prompt="$2"; break ;;
    --msgbox) mode="msgbox"; prompt="$2"; break ;;
    *) shift ;;
  esac
done
case "$mode" in
  menu)
    case "$prompt" in
      *"Choose the Debian guest type"*) reply="lxc" ;;
      *"Select the Proxmox storage ID"*)
        case "$title" in
          *"Template storage"*) reply="local" ;;
          *) reply="local" ;;
        esac
        ;;
      *"Choose a downloaded template"*) reply="__download__" ;;
      *"Select the network bridge."*) reply="vmbr0" ;;
      *"Install the latest runner-built release"*) reply="latest" ;;
      *"Choose how to download"*) reply="public" ;;
      *) reply="local" ;;
    esac
    printf '%s\\n' "$reply" >&2
    exit 0
    ;;
  input)
    case "$prompt" in
      *"Repository (owner/name)"*) reply="kVinB/FPKD" ;;
      *"Guest hostname"*) reply="interactive-diary" ;;
      *"VMID/CTID"*) reply="240" ;;
      *"vCPUs"*) reply="1" ;;
      *"Memory in MiB"*) reply="2048" ;;
      *"Disk size in GiB"*) reply="8" ;;
      *"DNS"*) reply="" ;;
      *"VLAN"*) reply="" ;;
      *) reply="" ;;
    esac
    printf '%s\\n' "$reply" >&2
    exit 0
    ;;
  password)
    printf 'test-token\\n' >&2
    exit 0
    ;;
  yesno) exit 0 ;;
  msgbox) exit 0 ;;
  *) exit 0 ;;
esac
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
    WHIPTAIL: path.join(bin, 'whiptail'),
    SEIZURE_DIARY_FORCE_UI: '1',
    ...(options.conflictId ? { MOCK_CONFLICT_ID: options.conflictId } : {}),
  };

  return {
    dir,
    log,
    env,
    readLog: () => fs.readFileSync(log, 'utf8'),
    cleanup: () => {
      if (IS_ROOT) fs.rmSync(dir, { recursive: true, force: true });
      else spawnSync('sudo', ['-n', 'rm', '-rf', dir], { stdio: 'ignore' });
    },
  };
}

function runInstall(
  mock: MockEnv,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const keys = [
    'PATH',
    'MOCK_LOG',
    'MOCK_TEMPLATE_PRESENT',
    'MOCK_TEMPLATE_VOLID',
    'MOCK_ROOTDIR_STORAGES',
    'MOCK_BRIDGE_EXISTS',
    'WHIPTAIL',
    'SEIZURE_DIARY_FORCE_UI',
    ...(mock.env.MOCK_CONFLICT_ID ? ['MOCK_CONFLICT_ID'] : []),
  ];
  const result = IS_ROOT
    ? spawnSync('bash', [INSTALL, ...args], {
        cwd: ROOT,
        env: mock.env,
        encoding: 'utf8',
        timeout: 60_000,
      })
    : spawnSync(
        'sudo',
        [
          '-n',
          'env',
          ...keys.map((key) => `${key}=${mock.env[key] ?? ''}`),
          'bash',
          INSTALL,
          ...args,
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const baseArgs = [
  '--type',
  'lxc',
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

describe.skipIf(!CAN_RUN)('Proxmox host installer safe paths', () => {
  it('provisions a fresh unprivileged guest without destroying anything', () => {
    const mock = createMockEnv();
    try {
      const result = runInstall(mock, [...baseArgs, '--ctid', '210', '--yes']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Seizure Diary installed in lxc 210');
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
        '--type',
        'lxc',
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

  it('prompts for an LXC storage in interactive mode and performs a dry-run', () => {
    const mock = createMockEnv();
    try {
      const result = runInstall(mock, ['--interactive', '--dry-run']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Guest type         : lxc');
      expect(result.stdout).toContain('Root filesystem    : local:8 GiB');
      expect(result.stdout).toContain('interactive-diary');
      expect(result.stdout).toContain('Dry run complete');
      const log = mock.readLog();
      expect(log).toContain('pvesm status -content rootdir');
      expect(log).toContain('pvesm status -content vztmpl');
      expect(log).toContain('whiptail');
      expect(log).not.toMatch(/pct (create|start|push|exec|destroy)/);
      expect(log).not.toMatch(/pveam download/);
    } finally {
      mock.cleanup();
    }
  });

  it('validates a QEMU VM dry-run without downloading or creating the VM', () => {
    const mock = createMockEnv();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-key-'));
    const key = path.join(keyDir, 'id_ed25519');
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    expect(generated.status, generated.stderr?.toString()).toBe(0);
    try {
      const result = runInstall(mock, [
        '--type',
        'vm',
        '--vm-storage',
        'local',
        '--ssh-private-key',
        key,
        '--ip',
        '10.20.0.10/24',
        '--gateway',
        '10.20.0.1',
        '--ctid',
        '220',
        '--dry-run',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Guest type         : vm');
      expect(result.stdout).toContain('VM storage');
      expect(result.stdout).toContain('Dry run complete');
      const log = mock.readLog();
      expect(log).toContain('qm status 220');
      expect(log).not.toMatch(/qm (create|importdisk|set|resize|cloudinit|start)/);
      expect(log).not.toMatch(/curl /);
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
      mock.cleanup();
    }
  });

  it('creates a QEMU VM and bootstraps it over SSH with mocked tooling', () => {
    const mock = createMockEnv();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-key-'));
    const key = path.join(keyDir, 'id_ed25519');
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    expect(generated.status, generated.stderr?.toString()).toBe(0);
    try {
      const result = runInstall(mock, [
        '--type',
        'vm',
        '--vm-storage',
        'local',
        '--ssh-private-key',
        key,
        '--ip',
        '10.20.0.10/24',
        '--gateway',
        '10.20.0.1',
        '--ctid',
        '221',
        '--image-dir',
        path.join(mock.dir, 'images'),
        '--yes',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Seizure Diary installed in vm 221');
      const log = mock.readLog();
      expect(log).toMatch(/qm create 221 /);
      expect(log).toContain('qm importdisk 221');
      expect(log).toMatch(/qm set 221 --scsi0/);
      expect(log).toContain('qm resize 221 scsi0 12G');
      expect(log).toContain('qm cloudinit update 221');
      expect(log).toContain('qm start 221');
      expect(log).toContain('scp ');
      expect(log).toContain('ssh ');
      expect(log).not.toContain('qm destroy');
      expect(log).not.toContain('pct create');
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
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
        '--type',
        'lxc',
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

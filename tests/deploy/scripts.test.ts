import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scripts = [
  'deploy/proxmox/install.sh',
  'deploy/proxmox/install-guest.sh',
  'deploy/proxmox/seizure-diary',
  'deploy/proxmox/update.sh',
  'deploy/proxmox/release.mjs',
  'scripts/package-installer.mjs',
];

describe('shell entry points', () => {
  it('are executable and pass bash syntax checks', () => {
    for (const script of scripts) {
      const full = path.join(root, script);
      expect(fs.existsSync(full), script).toBe(true);
      const mode = fs.statSync(full).mode;
      expect(mode & 0o111, `${script} should be executable`).not.toBe(0);
      const result = script.endsWith('.mjs')
        ? spawnSync('node', ['--check', full], { encoding: 'utf8' })
        : spawnSync('bash', ['-n', full], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('exposes documented management commands', () => {
    const result = spawnSync('bash', [path.join(root, 'deploy/proxmox/seizure-diary'), 'help'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('update');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('version');
    expect(result.stdout).toContain('bootstrap-admin');
    expect(result.stdout).toContain('backup');
  });

  it('supports install/update help without making changes', () => {
    for (const args of [
      ['deploy/proxmox/install.sh', '--help'],
      ['deploy/proxmox/update.sh', '--help'],
      ['deploy/proxmox/install-guest.sh', '--help'],
    ]) {
      const result = spawnSync('bash', [path.join(root, args[0] as string), ...args.slice(1)], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('fails safely outside Proxmox and never destroys containers', () => {
    const result = spawnSync('bash', [path.join(root, 'deploy/proxmox/install.sh'), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/pct|Proxmox/i);

    const install = fs.readFileSync(path.join(root, 'deploy/proxmox/install.sh'), 'utf8');
    expect(install).not.toContain('pct destroy');
    expect(install).not.toContain('curl | bash');
    const update = fs.readFileSync(path.join(root, 'deploy/proxmox/update.sh'), 'utf8');
    expect(update).not.toContain('git reset --hard');
  });

  it('uses runner-built GitHub release artifacts instead of guest builds', () => {
    const installGuest = fs.readFileSync(
      path.join(root, 'deploy/proxmox/install-guest.sh'),
      'utf8',
    );
    expect(installGuest).toContain('release.mjs');
    expect(installGuest).toContain('--token-file');
    expect(installGuest).not.toContain('git clone');
    expect(installGuest).not.toContain('npm ci');
    expect(installGuest).not.toContain('build-essential');
    const update = fs.readFileSync(path.join(root, 'deploy/proxmox/update.sh'), 'utf8');
    expect(update).toContain('release.mjs');
    expect(update).toContain('BACKUP_ENCRYPTION_KEY');
    expect(update).not.toContain('npm ci');
    expect(update).not.toContain('git fetch');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('Publish deployment bundle');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('seizure-diary-$VERSION.tar.gz');
    expect(workflow).toContain('seizure-diary-installer-$VERSION.sh');
    expect(workflow).toContain('package-installer.mjs');
    const installer = fs.readFileSync(path.join(root, 'deploy/proxmox/install.sh'), 'utf8');
    expect(installer).toContain('--type');
    expect(installer).toContain('qm create');
    expect(installer).toContain('pct create');
    expect(installer).toContain('install-guest.sh');
  });

  it('ships a daily encrypted backup timer and installs it', () => {
    const service = fs.readFileSync(
      path.join(root, 'deploy/proxmox/systemd/seizure-diary-backup.service'),
      'utf8',
    );
    expect(service).toContain('User=seizure-diary');
    expect(service).toContain('ExecStart=/usr/local/bin/seizure-diary backup --retain 14');
    expect(service).toContain('ProtectSystem=strict');
    expect(service).toContain('ReadWritePaths=/var/backups/seizure-diary');
    expect(service).toContain('UMask=0077');

    const timer = fs.readFileSync(
      path.join(root, 'deploy/proxmox/systemd/seizure-diary-backup.timer'),
      'utf8',
    );
    expect(timer).toContain('OnCalendar=*-*-* 02:30:00');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=seizure-diary-backup.service');

    const install = fs.readFileSync(path.join(root, 'deploy/proxmox/install-guest.sh'), 'utf8');
    expect(install).toContain('seizure-diary-backup.timer');
    expect(install).toContain('systemctl enable --now seizure-diary-backup.timer');
    const update = fs.readFileSync(path.join(root, 'deploy/proxmox/update.sh'), 'utf8');
    expect(update).toContain('seizure-diary-backup.timer');
    const docs = fs.readFileSync(path.join(root, 'deploy/proxmox/README.md'), 'utf8');
    expect(docs).toContain('Daily backup timer');
  });

  it('ships a non-root Docker image and compose service', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/data/seizure-diary.sqlite3');
    const compose = fs.readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('seizure-data:/data');
  });
});

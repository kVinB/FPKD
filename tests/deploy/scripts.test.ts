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
];

describe('shell entry points', () => {
  it('are executable and pass bash syntax checks', () => {
    for (const script of scripts) {
      const full = path.join(root, script);
      expect(fs.existsSync(full), script).toBe(true);
      const mode = fs.statSync(full).mode;
      expect(mode & 0o111, `${script} should be executable`).not.toBe(0);
      const result = spawnSync('bash', ['-n', full], { encoding: 'utf8' });
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

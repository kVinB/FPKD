import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();

describe('single-file Proxmox installer package', () => {
  it('builds a self-contained installer that passes its embedded integrity check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-installer-test-'));
    const output = path.join(dir, 'seizure-diary-installer-20261124.05.sh');
    try {
      const build = spawnSync(
        'node',
        [
          'scripts/package-installer.mjs',
          '--version',
          '20261124.05',
          '--commit',
          'abc1234',
          '--out',
          output,
        ],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(build.status, build.stderr).toBe(0);
      const script = fs.readFileSync(output, 'utf8');
      expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(script).toContain('# Version: 20261124.05');
      expect(script).toContain('# Commit: abc1234');
      expect(script).toContain('install.sh');
      expect(script).toContain('install-guest.sh');
      expect(script).toContain('release.mjs');
      expect(script).toContain('__PAYLOAD_BELOW__');
      expect(script).toMatch(/[a-f0-9]{64}/);

      const help = spawnSync('bash', [output, '--help'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('Usage: sudo ./deploy/proxmox/install.sh');
      expect(help.stdout).not.toContain('__PAYLOAD_BELOW__');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

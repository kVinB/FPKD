import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBuildVersion } from '../../scripts/build-version.mjs';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-version-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

function commit(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', name]);
}

const NOON = new Date('2026-11-24T12:00:00Z');

describe('build version resolution', () => {
  it('starts at .01 for the first untagged build of the UTC date', () => {
    const dir = createRepo();
    try {
      expect(computeBuildVersion({ cwd: dir, date: NOON })).toBe('20261124.01');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('increments from the highest tag already created for the date', () => {
    const dir = createRepo();
    try {
      git(dir, ['tag', '20261124.01']);
      commit(dir, 'second.txt');
      expect(computeBuildVersion({ cwd: dir, date: NOON })).toBe('20261124.02');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers a tag pointing at HEAD, including a previous date', () => {
    const dir = createRepo();
    try {
      git(dir, ['tag', '20261123.04']);
      expect(computeBuildVersion({ cwd: dir, date: NOON })).toBe('20261123.04');
      git(dir, ['tag', '20261124.03']);
      expect(computeBuildVersion({ cwd: dir, date: NOON })).toBe('20261124.03');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an explicit override and rejects unsafe values', () => {
    const dir = createRepo();
    try {
      expect(computeBuildVersion({ cwd: dir, date: NOON, override: 'dev-abc1234' })).toBe(
        'dev-abc1234',
      );
      expect(() =>
        computeBuildVersion({ cwd: dir, date: NOON, override: 'bad tag' }),
      ).toThrow(/Invalid BUILD_VERSION/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

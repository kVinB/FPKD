#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SOURCE_FILES = [
  'deploy/proxmox/install.sh',
  'deploy/proxmox/install-guest.sh',
  'deploy/proxmox/release.mjs',
];

function usage() {
  process.stderr.write(
    'Usage: node scripts/package-installer.mjs --version <YYYYMMDD.VV> --commit <sha> [--out <file>]\n',
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--version':
        args.version = value;
        index += 1;
        break;
      case '--commit':
        args.commit = value;
        index += 1;
        break;
      case '--out':
        args.out = value;
        index += 1;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (args.help) return args;
  if (!/^\d{8}\.\d{2}$/.test(args.version ?? '')) {
    throw new Error('--version must be YYYYMMDD.VV');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(args.commit ?? '')) {
    throw new Error('--commit must be a git commit hash');
  }
  args.out ??= `seizure-diary-installer-${args.version}.sh`;
  return args;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createPayload() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'sd-installer-package-'));
  try {
    const hashes = {};
    for (const file of SOURCE_FILES) {
      const source = path.join(ROOT, file);
      const target = path.join(dir, path.basename(file));
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      hashes[path.basename(file)] = sha256(target);
    }
    const archive = path.join(dir, 'installer.tar.gz');
    const tar = spawnSync(
      'tar',
      ['-czf', archive, '-C', dir, ...SOURCE_FILES.map((file) => path.basename(file))],
      { encoding: 'utf8' },
    );
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const base64 = fs.readFileSync(archive).toString('base64');
    return {
      hashes,
      payload: base64.match(/.{1,76}/g)?.join('\n') ?? '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function render(args) {
  const { hashes, payload } = createPayload();
  const generated = new Date().toISOString();
  const lines = [
    '#!/usr/bin/env bash',
    '# Seizure Diary self-contained Proxmox installer',
    `# Version: ${args.version}`,
    `# Commit: ${args.commit}`,
    `# Source: https://github.com/kVinB/FPKD`,
    `# Generated: ${generated}`,
    '# Embedded SHA-256:',
    ...SOURCE_FILES.map(
      (file) => `#   ${path.basename(file)} ${hashes[path.basename(file)]}`,
    ),
    '# Save this file, then run: sudo bash <file>',
    'set -euo pipefail',
    'if [ ! -f "$0" ]; then',
    '  printf "Save this installer to a file before running it.\\n" >&2',
    '  exit 1',
    'fi',
    'umask 077',
    'installer_dir="$(mktemp -d "${TMPDIR:-/tmp}/seizure-diary-installer.XXXXXX")"',
    'cleanup() { rm -rf "$installer_dir"; }',
    'trap cleanup EXIT',
    'payload_start="$(awk \'/^__PAYLOAD_BELOW__$/ { print NR + 1; exit }\' "$0")"',
    'if [ -z "$payload_start" ]; then',
    '  printf "Installer payload is missing.\\n" >&2',
    '  exit 1',
    'fi',
    'tail -n "+$payload_start" "$0" | base64 -d | tar -xzf - -C "$installer_dir"',
    'verify_embedded() {',
    '  local expected="$1" file="$2" actual',
    '  actual="$(sha256sum "$installer_dir/$file" | awk \'{print $1}\')"',
    '  if [ "$actual" != "$expected" ]; then',
    '    printf "Installer integrity check failed for %s.\\n" "$file" >&2',
    '    exit 1',
    '  fi',
    '}',
    ...SOURCE_FILES.map(
      (file) =>
        `verify_embedded '${hashes[path.basename(file)]}' '${path.basename(file)}'`,
    ),
    'status=0',
    'bash "$installer_dir/install.sh" "$@" || status=$?',
    'exit "$status"',
    '',
    '__PAYLOAD_BELOW__',
    payload,
    '',
  ];
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const output = path.resolve(args.out);
  fs.writeFileSync(output, render(args), { mode: 0o755 });
  fs.chmodSync(output, 0o755);
  process.stdout.write(`${output}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`package-installer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION_PATTERN = /^\d{8}\.\d{2}$/;
const DEFAULT_API = 'https://api.github.com';

function usage() {
  process.stderr.write(`Usage:
  release.mjs resolve --repo <owner/repo> [--token-file <file>] [--version latest|<tag>]
  release.mjs download --repo <owner/repo> [--token-file <file>] [--version latest|<tag>] --dest <dir>
`);
}

function parseArgs(argv) {
  const args = { command: argv[0], version: 'latest' };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--repo':
        args.repo = value;
        index += 1;
        break;
      case '--token-file':
        args.tokenFile = value;
        index += 1;
        break;
      case '--version':
        args.version = value;
        index += 1;
        break;
      case '--dest':
        args.dest = value;
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
  if (args.command !== 'resolve' && args.command !== 'download') {
    throw new Error('command must be resolve or download');
  }
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error('--repo must be owner/name');
  }
  if (args.command === 'download' && !args.dest) {
    throw new Error('download requires --dest');
  }
  if (args.version !== 'latest' && !VERSION_PATTERN.test(args.version)) {
    throw new Error('--version must be latest or YYYYMMDD.VV');
  }
  return args;
}

function readToken(file) {
  if (!file) {
    const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    return envToken.trim() || null;
  }
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch (error) {
    throw new Error(`cannot read token file: ${error.message}`);
  }
}

function headers(token, accept) {
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'seizure-diary-release',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function jsonRequest(url, token) {
  const response = await fetch(url, { headers: headers(token, 'application/vnd.github+json') });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

function assetFor(release, name) {
  const asset = (release.assets ?? []).find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`release ${release.tag_name} has no asset ${name}`);
  return asset;
}

async function resolveRelease(args) {
  const token = readToken(args.tokenFile);
  const api = (process.env.GITHUB_API_URL ?? DEFAULT_API).replace(/\/+$/, '');
  const release =
    args.version === 'latest'
      ? await jsonRequest(`${api}/repos/${args.repo}/releases/latest`, token)
      : await jsonRequest(
          `${api}/repos/${args.repo}/releases/tags/${encodeURIComponent(args.version)}`,
          token,
        );
  const version = String(release.tag_name ?? '');
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`release tag ${version} is not YYYYMMDD.VV`);
  }
  const bundleName = `seizure-diary-${version}.tar.gz`;
  const summaryName = `${bundleName}.sha256`;
  return {
    version,
    bundleName,
    summaryName,
    bundle: assetFor(release, bundleName),
    summary: assetFor(release, summaryName),
    htmlUrl: release.html_url,
    token,
    api,
  };
}

async function downloadAsset(asset, token, destination) {
  const response = await fetch(asset.url, {
    headers: headers(token, 'application/octet-stream'),
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`asset download failed ${response.status}: ${asset.name}`);
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function downloadRelease(args) {
  const resolved = await resolveRelease(args);
  const dest = path.resolve(args.dest);
  const target = path.join(dest, resolved.version);
  if (fs.existsSync(target)) {
    throw new Error(`release ${resolved.version} already exists at ${target}`);
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
  const staging = fs.mkdtempSync(path.join(dest, '.download-'));
  try {
    const bundlePath = path.join(staging, resolved.bundleName);
    const summaryPath = path.join(staging, resolved.summaryName);
    await downloadAsset(resolved.bundle, resolved.token, bundlePath);
    await downloadAsset(resolved.summary, resolved.token, summaryPath);
    const expected = fs.readFileSync(summaryPath, 'utf8').trim().split(/\s+/)[0] ?? '';
    const actual = sha256(bundlePath);
    if (!/^[a-f0-9]{64}$/i.test(expected) || expected.toLowerCase() !== actual) {
      throw new Error(`checksum mismatch for ${resolved.bundleName}`);
    }

    const extracted = path.join(staging, 'extracted');
    fs.mkdirSync(extracted);
    const untar = spawnSync('tar', ['-xzf', bundlePath, '-C', extracted], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    for (const required of [
      'dist/server/index.js',
      'dist/web/index.html',
      'node_modules',
      'deploy/proxmox/update.sh',
    ]) {
      if (!fs.existsSync(path.join(extracted, required))) {
        throw new Error(`bundle is missing ${required}`);
      }
    }
    fs.chmodSync(extracted, 0o755);
    fs.renameSync(extracted, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { version: resolved.version, path: target };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.command === 'resolve') {
    const resolved = await resolveRelease(args);
    process.stdout.write(
      `${JSON.stringify({
        version: resolved.version,
        bundle: resolved.bundleName,
        sha256: resolved.summaryName,
        htmlUrl: resolved.htmlUrl,
      })}\n`,
    );
    return;
  }
  const result = await downloadRelease(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`release.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

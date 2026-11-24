import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TAG_PATTERN = /^(\d{8})\.(\d{2})$/;
const OVERRIDE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function compareTags(a, b) {
  const left = TAG_PATTERN.exec(a);
  const right = TAG_PATTERN.exec(b);
  if (!left || !right) return a.localeCompare(b);
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return Number(left[2]) - Number(right[2]);
}

function nextForDate(yyyymmdd, cwd) {
  const tags = git(['tag', '--list', `${yyyymmdd}.*`], cwd)
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
  let highest = 0;
  for (const tag of tags) {
    const match = TAG_PATTERN.exec(tag);
    if (match && match[1] === yyyymmdd) {
      highest = Math.max(highest, Number(match[2]));
    }
  }
  return `${yyyymmdd}.${String(highest + 1).padStart(2, '0')}`;
}

/**
 * Resolve the build tag shown in the app footer.
 *
 * Precedence:
 *  1. explicit BUILD_VERSION / override (used by CI and Docker builds);
 *  2. a YYYYMMDD.VV tag pointing at HEAD (release commits);
 *  3. the next YYYYMMDD.VV tag for the current UTC date (untagged build).
 *
 * Returns "dev" when git metadata is unavailable and no override is set.
 */
export function computeBuildVersion(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const date = options.date ?? new Date();
  const override = (options.override ?? process.env.BUILD_VERSION ?? '').trim();
  if (override) {
    if (!OVERRIDE_PATTERN.test(override)) {
      throw new Error(`Invalid BUILD_VERSION: ${override}`);
    }
    return override;
  }

  const atHead = git(['tag', '--points-at', 'HEAD'], cwd)
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => TAG_PATTERN.test(tag))
    .sort(compareTags);
  if (atHead.length > 0) {
    return atHead[atHead.length - 1];
  }

  const yyyymmdd = date.toISOString().slice(0, 10).replaceAll('-', '');
  return nextForDate(yyyymmdd, cwd);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.stdout.write(`${computeBuildVersion()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

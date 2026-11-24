import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '@server/db/connection';
import { runMigrations } from '@server/db/migrations';
import { createUser } from '@server/db/users';
import {
  createEvent,
  createScope,
  ensureDiarySetup,
  getSettings,
  listEventsForRange,
} from '@server/db/diary';
import { aggregate, type ReportRange } from '@shared/range';
import { buildReportModel } from '@shared/report';
import type { EventInput } from '@shared/schemas';
import { nowInstant } from '@shared/time';

const EVENT_COUNT = 10_000;
const RUNS = 30;
const REPORT_ZONE = 'UTC';
const START = '2026-08-27';
const END = '2026-11-24';

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function areaSet(index: number): EventInput['affectedAreas'] {
  const combos: EventInput['affectedAreas'][] = [
    { status: 'reported', areas: ['arms'] },
    { status: 'reported', areas: ['legs'] },
    { status: 'reported', areas: ['speech'] },
    { status: 'reported', areas: ['arms', 'speech'] },
    { status: 'none_reported' },
    { status: 'unknown' },
    { status: 'not_recorded' },
  ];
  return combos[index % combos.length] as EventInput['affectedAreas'];
}

function buildEvent(index: number, baseMs: number): EventInput {
  const instant = new Date(baseMs + index * 12 * 60 * 1000).toISOString();
  const date = instant.slice(0, 10);
  const time = instant.slice(11, 16);
  return {
    occurredAt: {
      precision: index % 5 === 0 ? 'approximate' : 'exact',
      captureDate: date,
      wallTime: time,
      zone: 'UTC',
      offset: '+00:00',
      instantUtc: instant,
    },
    duration:
      index % 17 === 0
        ? { status: 'unknown' }
        : { status: index % 3 === 0 ? 'exact' : 'estimated', seconds: 30 + (index % 300) },
    affectedAreas: areaSet(index),
    triggers: {
      status: index % 4 === 0 ? 'none_reported' : 'reported',
      ...(index % 4 === 0
        ? {}
        : {
            tags: [
              { id: 'trigger-stress', label: 'Stress' },
              ...(index % 5 === 0
                ? [{ id: 'trigger-poor-sleep', label: 'Poor sleep' }]
                : []),
            ],
          }),
    } as EventInput['triggers'],
    aura: index % 6 === 0 ? { status: 'unknown' } : { status: 'not_recorded' },
    rescue:
      index % 10 === 0
        ? {
            status: 'used',
            administrations: [
              {
                id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
                name: 'As reported',
                timingAsReported: 'about 2 minutes after start',
              },
            ],
          }
        : { status: 'not_used' },
    ...(index % 2 === 0 ? { eventLabel: `Synthetic event ${index}` } : {}),
  };
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seizure-diary-bench-'));
  const dbPath = path.join(dir, 'bench.sqlite3');
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    const now = nowInstant();
    const user = createUser(db, {
      username: 'bench',
      displayLabel: 'Benchmark',
      role: 'member',
      passwordHash: 'not-a-real-hash',
      mustChangePassword: false,
      tempPasswordExpiresAt: null,
      now,
    });
    ensureDiarySetup(db, user.id, REPORT_ZONE, now);
    const scope = createScope(db, user.id);
    const baseMs = Date.UTC(2026, 7, 27, 8, 0, 0);

    console.log(`Seeding ${EVENT_COUNT.toLocaleString()} synthetic events…`);
    const seedStart = performance.now();
    const seed = db.transaction(() => {
      for (let index = 0; index < EVENT_COUNT; index += 1) {
        createEvent(scope, buildEvent(index, baseMs), now);
      }
    });
    seed();
    console.log(`Seeded in ${Math.round(performance.now() - seedStart)} ms`);

    const settings = getSettings(scope);
    const range: ReportRange = { start: START, end: END, granularity: 'week' };
    const queryTimings: number[] = [];
    const reportTimings: number[] = [];
    let counted = 0;

    for (let run = 0; run < RUNS; run += 1) {
      const queryStart = performance.now();
      const events = listEventsForRange(scope, REPORT_ZONE, range.start, range.end);
      const analytics = aggregate(events, {
        reportZone: REPORT_ZONE,
        range,
        dataVersion: settings.dataVersion,
      });
      queryTimings.push(performance.now() - queryStart);
      counted = analytics.summary.totalEvents;

      const reportStart = performance.now();
      buildReportModel(events, {
        range,
        reportZone: REPORT_ZONE,
        generatedAt: now,
        includeName: false,
        includeNotes: false,
        dataVersion: settings.dataVersion,
        datasetEpoch: settings.datasetEpoch,
      });
      reportTimings.push(performance.now() - reportStart);
    }

    const summary = {
      eventsSeeded: EVENT_COUNT,
      eventsIn90DayRange: counted,
      runs: RUNS,
      queryAndAggregateMs: {
        p50: Number(percentile(queryTimings, 0.5).toFixed(1)),
        p95: Number(percentile(queryTimings, 0.95).toFixed(1)),
        max: Number(Math.max(...queryTimings).toFixed(1)),
      },
      reportModelMs: {
        p50: Number(percentile(reportTimings, 0.5).toFixed(1)),
        p95: Number(percentile(reportTimings, 0.95).toFixed(1)),
        max: Number(Math.max(...reportTimings).toFixed(1)),
      },
      note: 'Single warmed process on this machine; not a universal performance claim.',
    };
    console.log(JSON.stringify(summary, null, 2));
    const p95 = summary.queryAndAggregateMs.p95;
    if (p95 > 500) {
      console.error(`Benchmark p95 ${p95} ms exceeds the 500 ms target.`);
      process.exitCode = 1;
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('Benchmark failed:', (error as Error).message);
  process.exit(1);
});

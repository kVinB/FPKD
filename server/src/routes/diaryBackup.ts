import type { FastifyInstance } from 'fastify';
import {
  clearAllSchema,
  restoreApplySchema,
  restorePreviewSchema,
} from '@shared/schemas';
import { validateBackup } from '@shared/backup';
import { canonicalJson } from '@shared/report';
import { nowInstant } from '@shared/time';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import {
  clearDiary,
  createScope,
  exportDiary,
  getSettings,
  replaceDiary,
} from '../db/diary';
import { assertSessionCsrf, requireFullPrincipal } from '../auth/principal';
import { sha256Hex } from '../auth/crypto';
import { unprocessable } from '../errors';
import { parse } from '../http';

export interface DiaryBackupRouteOptions {
  db: Db;
  config: Config;
}

function backupDigest(raw: unknown): string {
  return sha256Hex(canonicalJson(raw));
}

export async function registerDiaryBackupRoutes(
  app: FastifyInstance,
  options: DiaryBackupRouteOptions,
): Promise<void> {
  const { db, config } = options;

  app.get('/diary/backup', async (request, reply) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    const exported = exportDiary(scope, nowInstant());
    const date = exported.exportedAt.slice(0, 10);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="seizure-diary_backup_${date}.json"`,
    );
    return reply.send(exported);
  });

  app.post(
    '/diary/restore/preview',
    { bodyLimit: 25 * 1024 * 1024 },
    async (request) => {
      const principal = requireFullPrincipal(db, request, config);
      assertSessionCsrf(request, principal);
      const scope = createScope(db, principal.user.id);
      const settings = getSettings(scope);
      const body = parse(restorePreviewSchema, request.body);
      const validation = validateBackup(body.backup, settings.reportZone);
      if (!validation.ok) {
        throw unprocessable('This file is not a valid Seizure Diary backup.', [
          ...validation.issues.slice(0, 25).map((issue) => ({
            field: issue.field ?? 'backup',
            code: issue.code,
            message: issue.message,
          })),
        ]);
      }
      return {
        ok: true,
        digest: backupDigest(body.backup),
        counts: validation.counts,
        convertedFromV1: validation.data.convertedFromV1,
        backup: {
          reportZone: validation.data.settings.reportZone,
          events: validation.counts.events,
          tags: validation.counts.tags,
        },
        current: {
          dataVersion: settings.dataVersion,
          datasetEpoch: settings.datasetEpoch,
          reportZone: settings.reportZone,
        },
      };
    },
  );

  app.post(
    '/diary/restore',
    { bodyLimit: 25 * 1024 * 1024 },
    async (request) => {
      const principal = requireFullPrincipal(db, request, config);
      assertSessionCsrf(request, principal);
      const scope = createScope(db, principal.user.id);
      const settings = getSettings(scope);
      const body = parse(restoreApplySchema, request.body);
      const validation = validateBackup(body.backup, settings.reportZone);
      if (!validation.ok) {
        throw unprocessable('This file is not a valid Seizure Diary backup.', [
          ...validation.issues.slice(0, 25).map((issue) => ({
            field: issue.field ?? 'backup',
            code: issue.code,
            message: issue.message,
          })),
        ]);
      }
      if (backupDigest(body.backup) !== body.digest) {
        throw unprocessable('The file changed after it was previewed. Preview it again.', [
          { field: 'backup', code: 'digest_mismatch', message: 'Backup digest mismatch.' },
        ]);
      }
      return replaceDiary(
        scope,
        validation.data,
        body.expectedDataVersion,
        body.expectedDatasetEpoch,
        nowInstant(),
      );
    },
  );

  app.post('/diary/clear', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const body = parse(clearAllSchema, request.body);
    return clearDiary(
      scope,
      body.expectedDataVersion,
      body.expectedDatasetEpoch,
      nowInstant(),
    );
  });
}

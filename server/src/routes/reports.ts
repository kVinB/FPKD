import type { FastifyInstance } from 'fastify';
import { reportPreviewSchema, reportValidateSchema } from '@shared/schemas';
import { validateRange } from '@shared/range';
import { buildReportModel, reportDigestPayload } from '@shared/report';
import { nowInstant, todayInZone } from '@shared/time';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import { createScope, getSettings, listEventsForRange } from '../db/diary';
import { assertSessionCsrf, requireFullPrincipal } from '../auth/principal';
import { sha256Hex } from '../auth/crypto';
import { conflict, unprocessable } from '../errors';
import { parse } from '../http';

export interface ReportsRouteOptions {
  db: Db;
  config: Config;
}

export async function registerReportRoutes(
  app: FastifyInstance,
  options: ReportsRouteOptions,
): Promise<void> {
  const { db, config } = options;

  app.post('/reports/preview', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const body = parse(reportPreviewSchema, request.body);
    const settings = getSettings(scope);
    const validation = validateRange({
      start: body.start,
      end: body.end,
      granularity: body.granularity ?? 'week',
      today: todayInZone(settings.reportZone),
    });
    if (!validation.ok) {
      throw unprocessable(validation.message, [
        { field: 'start', code: validation.code, message: validation.message },
      ]);
    }
    const includeName = body.includeName === true;
    const includeNotes = body.includeNotes === true;
    const events = listEventsForRange(
      scope,
      settings.reportZone,
      validation.range.start,
      validation.range.end,
    );
    const model = buildReportModel(events, {
      range: validation.range,
      reportZone: settings.reportZone,
      generatedAt: nowInstant(),
      includeName,
      includeNotes,
      ...(body.name ? { name: body.name } : {}),
      dataVersion: settings.dataVersion,
      datasetEpoch: settings.datasetEpoch,
    });
    const digest = sha256Hex(reportDigestPayload(model));
    return {
      model,
      digest,
      dataVersion: settings.dataVersion,
      datasetEpoch: settings.datasetEpoch,
    };
  });

  app.post('/reports/validate', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const body = parse(reportValidateSchema, request.body);
    const settings = getSettings(scope);
    if (
      body.dataVersion !== settings.dataVersion ||
      body.datasetEpoch !== settings.datasetEpoch
    ) {
      throw conflict(
        'stale_preview',
        'The diary changed since this preview was generated. Generate a new preview.',
      );
    }
    const validation = validateRange({
      start: body.start,
      end: body.end,
      granularity: body.granularity ?? 'week',
      today: todayInZone(settings.reportZone),
    });
    if (!validation.ok) {
      throw unprocessable(validation.message, [
        { field: 'start', code: validation.code, message: validation.message },
      ]);
    }
    const includeName = body.includeName === true;
    const includeNotes = body.includeNotes === true;
    const events = listEventsForRange(
      scope,
      settings.reportZone,
      validation.range.start,
      validation.range.end,
    );
    const model = buildReportModel(events, {
      range: validation.range,
      reportZone: settings.reportZone,
      generatedAt: nowInstant(),
      includeName,
      includeNotes,
      ...(body.name ? { name: body.name } : {}),
      dataVersion: settings.dataVersion,
      datasetEpoch: settings.datasetEpoch,
    });
    const digest = sha256Hex(reportDigestPayload(model));
    if (digest !== body.modelDigest) {
      throw conflict(
        'stale_preview',
        'The report contents changed since the preview. Generate a new preview.',
      );
    }
    return { ok: true, dataVersion: settings.dataVersion, datasetEpoch: settings.datasetEpoch };
  });
}

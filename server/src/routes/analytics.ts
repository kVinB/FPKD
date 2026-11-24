import type { FastifyInstance } from 'fastify';
import { analyticsQuerySchema } from '@shared/schemas';
import { aggregate, validateRange } from '@shared/range';
import { todayInZone } from '@shared/time';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import { createScope, getSettings, listEventsForRange } from '../db/diary';
import { requireFullPrincipal } from '../auth/principal';
import { unprocessable } from '../errors';
import { parse } from '../http';

export interface AnalyticsRouteOptions {
  db: Db;
  config: Config;
}

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRouteOptions,
): Promise<void> {
  const { db, config } = options;

  app.post('/analytics/query', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    const body = parse(analyticsQuerySchema, request.body);
    const settings = getSettings(scope);
    const validation = validateRange({
      start: body.start,
      end: body.end,
      granularity: body.granularity,
      today: todayInZone(settings.reportZone),
    });
    if (!validation.ok) {
      throw unprocessable(validation.message, [
        { field: 'start', code: validation.code, message: validation.message },
      ]);
    }
    const events = listEventsForRange(
      scope,
      settings.reportZone,
      validation.range.start,
      validation.range.end,
    );
    return aggregate(events, {
      reportZone: settings.reportZone,
      range: validation.range,
      dataVersion: settings.dataVersion,
    });
  });
}

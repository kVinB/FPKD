import type { FastifyInstance } from 'fastify';
import { nowInstant } from '@shared/time';
import {
  deleteEventSchema,
  eventInputSchema,
  eventsQuerySchema,
  settingsUpdateSchema,
  tagCreateSchema,
} from '@shared/schemas';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import {
  createEvent,
  createScope,
  createTag,
  deleteEvent,
  getEvent,
  getSettings,
  listTags,
  queryEvents,
  updateEvent,
  updateReportZone,
} from '../db/diary';
import { assertSessionCsrf, requireFullPrincipal } from '../auth/principal';
import { notFound, unprocessable } from '../errors';
import { parse } from '../http';

export interface DiaryRouteOptions {
  db: Db;
  config: Config;
}

export async function registerEventRoutes(
  app: FastifyInstance,
  options: DiaryRouteOptions,
): Promise<void> {
  const { db, config } = options;

  app.post('/events/query', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    const body = parse(eventsQuerySchema, request.body ?? {});
    const settings = getSettings(scope);
    return queryEvents(
      scope,
      settings.reportZone,
      {
        page: body.page ?? 1,
        pageSize: body.pageSize ?? 25,
        ...(body.start ? { start: body.start } : {}),
        ...(body.end ? { end: body.end } : {}),
        ...(body.search ? { search: body.search } : {}),
      },
      settings.dataVersion,
      settings.datasetEpoch,
    );
  });

  app.get('/events/:id', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    const { id } = request.params as { id: string };
    const event = getEvent(scope, id);
    if (!event) throw notFound('Event not found.');
    return { event };
  });

  app.post('/events', async (request, reply) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const input = parse(eventInputSchema, request.body);
    const result = createEvent(
      scope,
      input,
      nowInstant(),
      input.expectedDatasetEpoch,
    );
    reply.code(result.created ? 201 : 200).send({
      event: result.event,
      created: result.created ?? false,
      dataVersion: result.dataVersion,
      datasetEpoch: result.datasetEpoch,
    });
  });

  app.put('/events/:id', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const { id } = request.params as { id: string };
    const input = parse(eventInputSchema, request.body);
    const result = updateEvent(scope, id, input, nowInstant(), input.expectedDatasetEpoch);
    return {
      event: result.event,
      dataVersion: result.dataVersion,
      datasetEpoch: result.datasetEpoch,
    };
  });

  app.delete('/events/:id', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const { id } = request.params as { id: string };
    const body = parse(deleteEventSchema, request.body ?? {});
    return deleteEvent(
      scope,
      id,
      {
        ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision } : {}),
        ...(body.expectedDatasetEpoch ? { expectedDatasetEpoch: body.expectedDatasetEpoch } : {}),
      },
      nowInstant(),
    );
  });

  app.get('/tags', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    const query = request.query as { kind?: string };
    if (query.kind && query.kind !== 'trigger' && query.kind !== 'aura') {
      throw unprocessable('Choose trigger or aura.', [
        { field: 'kind', code: 'invalid', message: 'Unknown tag kind.' },
      ]);
    }
    return { tags: listTags(scope, query.kind as 'trigger' | 'aura' | undefined) };
  });

  app.post('/tags', async (request, reply) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const body = parse(tagCreateSchema, request.body);
    const tag = createTag(scope, body.kind, body.label, nowInstant());
    reply.code(201).send({ tag });
  });

  app.get('/settings', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    const scope = createScope(db, principal.user.id);
    return { settings: getSettings(scope) };
  });

  app.put('/settings', async (request) => {
    const principal = requireFullPrincipal(db, request, config);
    assertSessionCsrf(request, principal);
    const scope = createScope(db, principal.user.id);
    const body = parse(settingsUpdateSchema, request.body);
    const settings = updateReportZone(scope, body.reportZone, nowInstant());
    return { settings };
  });
}

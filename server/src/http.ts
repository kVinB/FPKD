import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodType } from 'zod';
import { AppError } from './errors';
import { unprocessable } from './errors';
import { firstIssue } from '@shared/schemas';

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw unprocessable('Check the highlighted fields.', firstIssue(result.error));
  }
  return result.data;
}

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AppError) {
    reply.code(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }
  const fastifyError = error as { code?: string; statusCode?: number };
  if (fastifyError?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    reply.code(413).send({
      error: {
        code: 'payload_too_large',
        message: 'The uploaded file is larger than the allowed size.',
      },
    });
    return;
  }
  if (typeof fastifyError?.code === 'string' && fastifyError.code.startsWith('SQLITE')) {
    reply.code(503).send({
      error: {
        code: 'storage_unavailable',
        message: 'Storage is temporarily unavailable. Retry shortly.',
      },
    });
    return;
  }
  reply.code(500).send({
    error: { code: 'internal_error', message: 'Something went wrong. Nothing was saved.' },
  });
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof AppError)) {
      request.log.error(
        { err: { message: error.message, code: (error as { code?: string }).code } },
        'unhandled error',
      );
    }
    sendError(reply, error);
  });
}

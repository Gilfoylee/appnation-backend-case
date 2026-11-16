import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';

/** Every error leaves the service as `{ "error": "<code>" }` with a matching status code. */
export function errorHandler(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    void reply.code(error.statusCode).send({ error: error.code });
    return;
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode === 413) {
    void reply.code(413).send({ error: 'payload_too_large' });
    return;
  }
  if (statusCode === 415) {
    void reply.code(415).send({ error: 'unsupported_media_type' });
    return;
  }
  if (statusCode >= 400 && statusCode < 500) {
    // Malformed JSON, empty body with a JSON content type, etc.
    void reply.code(400).send({ error: 'invalid_request' });
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send({ error: 'internal_error' });
}

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { GenerationService } from './domain/generation.service.js';
import { errorHandler } from './http/error-handler.js';
import { v1Routes } from './http/routes.js';

export interface AppOptions {
  service: GenerationService;
  logger: FastifyBaseLogger;
  bodyLimitBytes: number;
}

export function buildApp({ service, logger, bodyLimitBytes }: AppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // A 2,000-character prompt is at most ~24 KiB of JSON even with \uXXXX escapes; reject anything larger.
    bodyLimit: bodyLimitBytes,
    // Bound how long a slow client may hold a connection open.
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'not_found' });
  });

  // Polled by the container healthcheck; only log problems.
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.register(v1Routes, { prefix: '/v1', service });

  return app;
}

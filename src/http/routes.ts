import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalidCursor, invalidLimit, invalidPrompt } from '../domain/errors.js';
import type { GenerationService } from '../domain/generation.service.js';
import type { Generation } from '../db/generations.repository.js';
import { requireUserId } from './user-id.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 512;

const createBodySchema = z.object({ prompt: z.string() });

const historyQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export interface V1RouteOptions {
  service: GenerationService;
}

export async function v1Routes(app: FastifyInstance, { service }: V1RouteOptions): Promise<void> {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', requireUserId);

  app.post('/generations', async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      throw invalidPrompt();
    }
    const generation = await service.generate(request.userId, body.data.prompt);
    return reply.code(201).send(toResponse(generation));
  });

  app.get('/generations', async (request) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw invalidLimit();
    }
    const limit = parseLimit(query.data.limit);
    const cursor = query.data.cursor;
    if (cursor !== undefined && (cursor === '' || cursor.length > MAX_CURSOR_LENGTH)) {
      throw invalidCursor();
    }

    const page = await service.listHistory(request.userId, limit, cursor);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  });

  app.get('/quota', async (request) => {
    const status = await service.getQuotaStatus(request.userId);
    return { ...status, resetsAt: status.resetsAt.toISOString() };
  });
}

/** Defaults to 20; values above 100 are capped at 100; anything that is not a positive integer is rejected. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d{1,6}$/.test(raw)) {
    throw invalidLimit();
  }
  const limit = Number(raw);
  if (limit < 1) {
    throw invalidLimit();
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

function toResponse(generation: Generation) {
  return {
    id: generation.id,
    prompt: generation.prompt,
    result: generation.result,
    cached: generation.cached,
    createdAt: generation.createdAt.toISOString(),
  };
}

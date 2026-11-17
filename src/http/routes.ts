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
    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query.limit);
    const cursor = parseCursor(query.cursor);

    const page = await service.listHistory(request.userId, limit, cursor);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
  });

  app.get('/quota', async (request) => {
    const status = await service.getQuotaStatus(request.userId);
    return { ...status, resetsAt: status.resetsAt.toISOString() };
  });
}

/**
 * Defaults to 20; values above 100 are capped at 100. Anything that is not a single positive
 * integer (e.g. `0`, `-1`, `1.5`, `abc`, or a repeated parameter) is rejected.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw invalidLimit();
  }
  const limit = Number(raw);
  if (limit < 1) {
    throw invalidLimit();
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Shape check only; the service decodes and validates the cursor's contents. */
function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  return raw;
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

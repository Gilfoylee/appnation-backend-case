import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { RedisGenerationCache } from '../../src/cache/generation-cache.js';
import { type Generation, GenerationRepository } from '../../src/db/generations.repository.js';
import { QuotaRepository } from '../../src/db/quota.repository.js';
import { GenerationService } from '../../src/domain/generation.service.js';
import { ProviderError } from '../../src/provider/ai-provider.js';
import {
  countGenerations,
  createTestContext,
  getJson,
  MutableClock,
  postGeneration,
  remainingQuota,
  resetState,
  silentLogger,
  type TestContext,
} from '../helpers/test-context.js';

describe('POST /v1/generations', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // A short provider timeout keeps the timeout scenario fast; production uses 3 s.
    ctx = await createTestContext({ providerTimeoutMs: 150 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    ctx.provider.calls.length = 0;
  });

  it('creates a generation and returns 201 with the stored record', async () => {
    const userId = `user-${randomUUID()}`;

    const response = await postGeneration(ctx.baseUrl, userId, { prompt: '  Write   a Haiku  ' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      prompt: 'Write   a Haiku',
      result: 'Sonuç: write a haiku',
      cached: false,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(await countGenerations(ctx.db, userId)).toBe(1);
  });

  describe('identification', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['blank', '   '],
    ])('returns 401 when X-User-Id is %s', async (_label, userId) => {
      const response = await postGeneration(ctx.baseUrl, userId, { prompt: 'hello' });

      expect(response).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(ctx.provider.calls).toHaveLength(0);
    });

    it('returns 401 before looking at the body', async () => {
      const response = await postGeneration(ctx.baseUrl, undefined, '{not json');
      expect(response.status).toBe(401);
    });

    it('returns 401 on the history and quota endpoints too', async () => {
      expect((await getJson(ctx.baseUrl, '/v1/generations')).status).toBe(401);
      expect((await getJson(ctx.baseUrl, '/v1/quota')).status).toBe(401);
    });

    it('returns 400 when X-User-Id is longer than the 128 characters the schema allows', async () => {
      const response = await postGeneration(ctx.baseUrl, 'u'.repeat(129), { prompt: 'hello' });

      expect(response).toEqual({ status: 400, body: { error: 'invalid_user_id' } });
      expect(ctx.provider.calls).toHaveLength(0);
    });

    it('identifies the user by the trimmed header value', async () => {
      const userId = `user-${randomUUID()}`;

      await postGeneration(ctx.baseUrl, `  ${userId}  `, { prompt: 'trimmed id' });

      expect(await countGenerations(ctx.db, userId)).toBe(1);
    });
  });

  describe('validation', () => {
    it.each([
      ['empty', { prompt: '' }],
      ['whitespace only', { prompt: ' \n\t ' }],
      ['longer than 2000 characters', { prompt: 'a'.repeat(2001) }],
      ['not a string', { prompt: 42 }],
      ['missing', {}],
      ['containing a NUL character', { prompt: 'a\u0000b' }],
    ])('returns 400 without calling the provider or touching the quota when the prompt is %s', async (_label, body) => {
      const userId = `user-${randomUUID()}`;

      const response = await postGeneration(ctx.baseUrl, userId, body);

      expect(response).toEqual({ status: 400, body: { error: 'invalid_prompt' } });
      expect(ctx.provider.calls).toHaveLength(0);
      expect(await remainingQuota(ctx.baseUrl, userId)).toBe(5);
      expect(await countGenerations(ctx.db, userId)).toBe(0);
    });

    it('accepts exactly 2000 characters after trimming, counting code points', async () => {
      const userId = `user-${randomUUID()}`;

      const ascii = await postGeneration(ctx.baseUrl, userId, { prompt: `  ${'b'.repeat(2000)}  ` });
      const emoji = await postGeneration(ctx.baseUrl, userId, { prompt: '😀'.repeat(2000) });

      expect(ascii.status).toBe(201);
      expect(emoji.status).toBe(201);
    });

    it('returns 400 for malformed JSON', async () => {
      const response = await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, '{"prompt": ');
      expect(response).toEqual({ status: 400, body: { error: 'invalid_request' } });
    });

    it('returns 413 when the body exceeds the size limit', async () => {
      const response = await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, { prompt: 'x'.repeat(40_000) });
      expect(response).toEqual({ status: 413, body: { error: 'payload_too_large' } });
      expect(ctx.provider.calls).toHaveLength(0);
    });

    it('returns 415 for a body that is not JSON', async () => {
      const response = await fetch(`${ctx.baseUrl}/v1/generations`, {
        method: 'POST',
        headers: { 'x-user-id': `user-${randomUUID()}`, 'content-type': 'application/xml' },
        body: '<prompt>hello</prompt>',
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
      expect(ctx.provider.calls).toHaveLength(0);
    });
  });

  it('answers unknown routes with 404 in the same error shape', async () => {
    expect(await getJson(ctx.baseUrl, '/v1/unknown', `user-${randomUUID()}`)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  describe('provider failures', () => {
    it('returns 502 and does not count the request toward the quota', async () => {
      const userId = `user-${randomUUID()}`;

      const response = await postGeneration(ctx.baseUrl, userId, { prompt: 'error deneme' });

      expect(response).toEqual({ status: 502, body: { error: 'provider_error' } });
      expect(await remainingQuota(ctx.baseUrl, userId)).toBe(5);
      expect(await countGenerations(ctx.db, userId)).toBe(0);
    });

    it('returns 504 once the provider timeout elapses and does not count the request', async () => {
      const userId = `user-${randomUUID()}`;
      const startedAt = performance.now();

      const response = await postGeneration(ctx.baseUrl, userId, { prompt: 'timeout deneme' });

      const elapsedMs = performance.now() - startedAt;
      expect(response).toEqual({ status: 504, body: { error: 'provider_timeout' } });
      expect(elapsedMs).toBeGreaterThanOrEqual(140);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(await remainingQuota(ctx.baseUrl, userId)).toBe(5);
      expect(await countGenerations(ctx.db, userId)).toBe(0);
    });

    it('lets "slow" prompts finish when they answer within the timeout', async () => {
      const response = await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, { prompt: 'slow but fine' });
      expect(response.status).toBe(201);
      expect(response.body.result).toBe('Sonuç: slow but fine');
    });
  });

  describe('quota', () => {
    it('reports limit, used, remaining and the next UTC midnight', async () => {
      const userId = `user-${randomUUID()}`;
      await postGeneration(ctx.baseUrl, userId, { prompt: 'one' });

      const { status, body } = await getJson(ctx.baseUrl, '/v1/quota', userId);

      expect(status).toBe(200);
      expect(body).toMatchObject({ limit: 5, used: 1, remaining: 4 });
      expect(body.resetsAt).toMatch(/T00:00:00\.000Z$/);
    });

    it('does not call the provider once the quota is known to be exhausted', async () => {
      const userId = `user-${randomUUID()}`;
      for (let i = 0; i < 5; i++) {
        await postGeneration(ctx.baseUrl, userId, { prompt: `prompt ${i}` });
      }

      const response = await postGeneration(ctx.baseUrl, userId, { prompt: 'prompt 6' });

      expect(response).toEqual({ status: 429, body: { error: 'quota_exceeded' } });
      expect(ctx.provider.calls).toHaveLength(5);
    });
  });
});

describe('quota persistence', () => {
  it('survives a service restart', async () => {
    const userId = `user-${randomUUID()}`;
    const first = await createTestContext();
    await resetState(first);
    for (let i = 0; i < 5; i++) {
      expect((await postGeneration(first.baseUrl, userId, { prompt: `before restart ${i}` })).status).toBe(201);
    }
    await first.close();

    const restarted = await createTestContext();
    try {
      const response = await postGeneration(restarted.baseUrl, userId, { prompt: 'after restart' });
      expect(response).toEqual({ status: 429, body: { error: 'quota_exceeded' } });
      expect(restarted.provider.calls).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  });

  it('starts a fresh allowance at UTC midnight', async () => {
    const userId = `user-${randomUUID()}`;
    const clock = new MutableClock(new Date('2026-03-01T23:59:58.000Z'));
    const ctx = await createTestContext({ clock });
    try {
      await resetState(ctx);
      for (let i = 0; i < 5; i++) {
        await postGeneration(ctx.baseUrl, userId, { prompt: `late ${i}` });
      }
      expect((await postGeneration(ctx.baseUrl, userId, { prompt: 'late 6' })).status).toBe(429);

      clock.set(new Date('2026-03-02T00:00:01.000Z'));

      expect((await postGeneration(ctx.baseUrl, userId, { prompt: 'early 1' })).status).toBe(201);
      expect(await remainingQuota(ctx.baseUrl, userId)).toBe(4);
    } finally {
      await ctx.close();
    }
  });
});

/** The real repository, except that storing a generation always fails. */
class FailingGenerationRepository extends GenerationRepository {
  override async create(): Promise<Generation> {
    throw new Error('simulated insert failure');
  }
}

describe('quota refunds', () => {
  it('refunds a failed request to the day it was reserved on, even across UTC midnight', async () => {
    const userId = `user-${randomUUID()}`;
    const clock = new MutableClock(new Date('2026-03-01T23:59:59.900Z'));
    const ctx = await createTestContext({
      clock,
      provider: {
        async generate() {
          clock.set(new Date('2026-03-02T00:00:00.100Z')); // midnight passes while the provider works
          throw new ProviderError('failed after midnight');
        },
      },
    });
    try {
      await resetState(ctx);

      const response = await postGeneration(ctx.baseUrl, userId, { prompt: 'crosses midnight' });

      expect(response).toEqual({ status: 502, body: { error: 'provider_error' } });
      const buckets = await ctx.db
        .selectFrom('daily_quota_usage')
        .select(['usage_date', 'used'])
        .where('user_id', '=', userId)
        .execute();
      expect(buckets).toEqual([{ usage_date: '2026-03-01', used: 0 }]);
    } finally {
      await ctx.close();
    }
  });

  it('gives the unit back and answers 500 when the generation cannot be stored', async () => {
    const ctx = await createTestContext();
    const logger = silentLogger();
    const quota = new QuotaRepository(ctx.db);
    const service = new GenerationService({
      generations: new FailingGenerationRepository(ctx.db),
      quota,
      cache: new RedisGenerationCache(ctx.redis, 600, logger),
      provider: ctx.provider,
      clock: new MutableClock(new Date('2026-05-05T12:00:00.000Z')),
      logger,
      dailyQuota: 5,
      providerTimeoutMs: 3_000,
    });
    const app = buildApp({ service, logger, bodyLimitBytes: 32 * 1024 });
    try {
      await resetState(ctx);
      const userId = `user-${randomUUID()}`;

      const response = await app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { 'x-user-id': userId },
        payload: { prompt: 'cannot be stored' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal_error' });
      expect(ctx.provider.calls).toEqual(['cannot be stored']);
      expect(await quota.getUsed(userId, '2026-05-05')).toBe(0);
    } finally {
      await app.close();
      await ctx.close();
    }
  });
});

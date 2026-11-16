import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countGenerations,
  createTestContext,
  getJson,
  MutableClock,
  postGeneration,
  remainingQuota,
  resetState,
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
  });

  describe('validation', () => {
    it.each([
      ['empty', { prompt: '' }],
      ['whitespace only', { prompt: ' \n\t ' }],
      ['longer than 2000 characters', { prompt: 'a'.repeat(2001) }],
      ['not a string', { prompt: 42 }],
      ['missing', {}],
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

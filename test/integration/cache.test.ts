import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cacheKey } from '../../src/cache/generation-cache.js';
import {
  countGenerations,
  createTestContext,
  postGeneration,
  remainingQuota,
  resetState,
  type TestContext,
} from '../helpers/test-context.js';

describe('shared result cache', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
    ctx.provider.calls.length = 0;
  });

  it('serves a differently written prompt from cache without calling the provider or using quota', async () => {
    const userId = `user-${randomUUID()}`;

    const first = await postGeneration(ctx.baseUrl, userId, { prompt: 'merhaba' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ prompt: 'merhaba', result: 'Sonuç: merhaba', cached: false });
    expect(ctx.provider.calls).toHaveLength(1);
    const remainingAfterFirst = await remainingQuota(ctx.baseUrl, userId);
    expect(remainingAfterFirst).toBe(4);

    const second = await postGeneration(ctx.baseUrl, userId, { prompt: 'MERHABA' });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ prompt: 'MERHABA', result: 'Sonuç: merhaba', cached: true });

    expect(ctx.provider.calls).toHaveLength(1);
    expect(await remainingQuota(ctx.baseUrl, userId)).toBe(remainingAfterFirst);
  });

  it('normalizes whitespace and case into the same cache entry, shared across users', async () => {
    await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, { prompt: 'hello   big\tworld' });

    const other = await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, { prompt: '  HELLO big WORLD  ' });

    expect(other.status).toBe(201);
    expect(other.body).toMatchObject({ prompt: 'HELLO big WORLD', cached: true, result: 'Sonuç: hello big world' });
    expect(ctx.provider.calls).toEqual(['hello big world']);
  });

  it('stores results in Redis with a 10 minute TTL', async () => {
    await postGeneration(ctx.baseUrl, `user-${randomUUID()}`, { prompt: 'ttl check' });

    const ttl = await ctx.redis.ttl(cacheKey('ttl check'));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('still serves cached results after the user has exhausted the quota, and saves them to history', async () => {
    const userId = `user-${randomUUID()}`;
    await postGeneration(ctx.baseUrl, `someone-else-${randomUUID()}`, { prompt: 'popular prompt' });
    for (let i = 0; i < 5; i++) {
      expect((await postGeneration(ctx.baseUrl, userId, { prompt: `own prompt ${i}` })).status).toBe(201);
    }
    const callsBefore = ctx.provider.calls.length;

    const rejected = await postGeneration(ctx.baseUrl, userId, { prompt: 'a brand new prompt' });
    expect(rejected).toEqual({ status: 429, body: { error: 'quota_exceeded' } });

    const cached = await postGeneration(ctx.baseUrl, userId, { prompt: 'Popular Prompt' });
    expect(cached.status).toBe(201);
    expect(cached.body.cached).toBe(true);

    expect(ctx.provider.calls).toHaveLength(callsBefore);
    expect(await countGenerations(ctx.db, userId)).toBe(6);
  });

  it('does not cache provider errors', async () => {
    const userId = `user-${randomUUID()}`;

    expect((await postGeneration(ctx.baseUrl, userId, { prompt: 'error deneme' })).status).toBe(502);
    expect((await postGeneration(ctx.baseUrl, userId, { prompt: 'error deneme' })).status).toBe(502);

    expect(ctx.provider.calls).toHaveLength(2);
    expect(await ctx.redis.exists(cacheKey('error deneme'))).toBe(0);
  });
});

describe('when Redis is unavailable', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Nothing listens on port 1: every cache call fails immediately (no offline queue).
    ctx = await createTestContext({ redisUrl: 'redis://127.0.0.1:1' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('fails open: requests are served by the provider and the quota is still enforced', async () => {
    const userId = `user-${randomUUID()}`;

    const first = await postGeneration(ctx.baseUrl, userId, { prompt: `redis down ${userId}` });
    const repeat = await postGeneration(ctx.baseUrl, userId, { prompt: `REDIS DOWN ${userId}` });

    expect(first.status).toBe(201);
    expect(repeat.status).toBe(201);
    expect(repeat.body.cached).toBe(false);
    expect(ctx.provider.calls).toHaveLength(2);
    expect(await remainingQuota(ctx.baseUrl, userId)).toBe(3);
  });
});

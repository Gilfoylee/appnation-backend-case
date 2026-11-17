import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countGenerations,
  createTestContext,
  postGeneration,
  remainingQuota,
  resetState,
  type TestContext,
} from '../helpers/test-context.js';

describe('daily quota under concurrent requests', () => {
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

  it('10 concurrent requests with different prompts yield exactly 5 x 201 and 5 x 429', async () => {
    const userId = `user-${randomUUID()}`;
    const prompts = Array.from({ length: 10 }, (_, i) => `concurrent prompt ${i}`);

    const responses = await Promise.all(prompts.map((prompt) => postGeneration(ctx.baseUrl, userId, { prompt })));

    const created = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 429);
    expect(created).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const response of rejected) {
      expect(response.body).toEqual({ error: 'quota_exceeded' });
    }
    for (const response of created) {
      expect(response.body.cached).toBe(false);
    }

    // Exactly five rows were stored for the user, and rejected requests never reached the provider.
    expect(await countGenerations(ctx.db, userId)).toBe(5);
    expect(ctx.provider.calls).toHaveLength(5);
    expect(await remainingQuota(ctx.baseUrl, userId)).toBe(0);
  });

  it('never exceeds the quota with a larger burst of concurrent requests', async () => {
    const userId = `user-${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => postGeneration(ctx.baseUrl, userId, { prompt: `burst ${i}` })),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(45);
    expect(await countGenerations(ctx.db, userId)).toBe(5);
    expect(ctx.provider.calls).toHaveLength(5);
  });

  it('grants a concurrent burst only the allowance that is left', async () => {
    const userId = `user-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      expect((await postGeneration(ctx.baseUrl, userId, { prompt: `earlier ${i}` })).status).toBe(201);
    }

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => postGeneration(ctx.baseUrl, userId, { prompt: `later ${i}` })),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(8);
    expect(await countGenerations(ctx.db, userId)).toBe(5);
  });

  it('returns the units of concurrently failing requests', async () => {
    const userId = `user-${randomUUID()}`;

    const failures = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postGeneration(ctx.baseUrl, userId, { prompt: `error ${i}` })),
    );
    expect(failures.map((response) => response.status)).toEqual([502, 502, 502, 502, 502]);
    expect(await remainingQuota(ctx.baseUrl, userId)).toBe(5);

    const successes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postGeneration(ctx.baseUrl, userId, { prompt: `fine ${i}` })),
    );
    expect(successes.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await remainingQuota(ctx.baseUrl, userId)).toBe(0);
  });

  it('keeps quotas of different users independent', async () => {
    const [alice, bob] = [`alice-${randomUUID()}`, `bob-${randomUUID()}`];

    const responses = await Promise.all(
      [alice, bob].flatMap((userId) =>
        Array.from({ length: 6 }, (_, i) => postGeneration(ctx.baseUrl, userId, { prompt: `${userId} ${i}` })),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
    expect(await countGenerations(ctx.db, alice)).toBe(5);
    expect(await countGenerations(ctx.db, bob)).toBe(5);
  });
});

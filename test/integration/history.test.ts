import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/lib/cursor.js';
import { createTestContext, getJson, postGeneration, resetState, type TestContext } from '../helpers/test-context.js';

describe('GET /v1/generations', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetState(ctx);
  });

  /** Inserts `count` rows directly; rows are spread over `distinctTimestamps` identical created_at values. */
  async function insertRows(userId: string, count: number, distinctTimestamps: number): Promise<void> {
    await sql`
      INSERT INTO generations (user_id, prompt, result, cached, created_at)
      SELECT ${userId}, 'prompt ' || g, 'result ' || g, false,
             timestamptz '2026-01-01T00:00:00Z' + ((g % ${distinctTimestamps}) * interval '1 second')
      FROM generate_series(1, ${count}) AS g
    `.execute(ctx.db);
  }

  async function fetchAllPages(userId: string, limit: number) {
    const ids: string[] = [];
    const createdAts: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=${limit}&cursor=${cursor}` : `?limit=${limit}`;
      const { status, body } = await getJson(ctx.baseUrl, `/v1/generations${query}`, userId);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(limit);
      for (const item of body.items) {
        ids.push(item.id);
        createdAts.push(item.createdAt);
      }
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 1_000);
    return { ids, createdAts, pages };
  }

  it('pages with limit=2 through rows sharing the same createdAt without duplicates or omissions', async () => {
    const userId = `user-${randomUUID()}`;
    await insertRows(userId, 25, 3); // 25 rows over only 3 distinct timestamps

    const { ids, createdAts, pages } = await fetchAllPages(userId, 2);

    expect(pages).toBe(13);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);

    const expected = await ctx.db
      .selectFrom('generations')
      .select('id')
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    expect(ids).toEqual(expected.map((row) => row.id));
    expect([...createdAts].sort().reverse()).toEqual(createdAts);
  });

  it('ends on a full last page without an extra empty page', async () => {
    const userId = `user-${randomUUID()}`;
    await insertRows(userId, 4, 2);

    const { ids, pages } = await fetchAllPages(userId, 2);

    expect(pages).toBe(2);
    expect(new Set(ids).size).toBe(4);
  });

  it('returns newest first and nextCursor null on the last page', async () => {
    const userId = `user-${randomUUID()}`;
    for (const prompt of ['first', 'second', 'third']) {
      await postGeneration(ctx.baseUrl, userId, { prompt });
    }

    const { status, body } = await getJson(ctx.baseUrl, '/v1/generations', userId);

    expect(status).toBe(200);
    expect(body.items.map((item: { prompt: string }) => item.prompt)).toEqual(['third', 'second', 'first']);
    expect(body.items[0]).toEqual({
      id: expect.any(String),
      prompt: 'third',
      result: 'Sonuç: third',
      cached: false,
      createdAt: expect.any(String),
    });
    expect(body.nextCursor).toBeNull();
  });

  it('includes cached generations in the requesting user history', async () => {
    const userId = `user-${randomUUID()}`;
    await postGeneration(ctx.baseUrl, `other-${randomUUID()}`, { prompt: 'shared' });
    await postGeneration(ctx.baseUrl, userId, { prompt: 'SHARED' });

    const { body } = await getJson(ctx.baseUrl, '/v1/generations', userId);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ prompt: 'SHARED', cached: true });
  });

  it("only returns the requesting user's records", async () => {
    const [alice, bob] = [`alice-${randomUUID()}`, `bob-${randomUUID()}`];
    await insertRows(alice, 5, 5);
    await insertRows(bob, 7, 7);

    const { ids } = await fetchAllPages(alice, 2);
    const { body } = await getJson(ctx.baseUrl, '/v1/generations?limit=100', bob);

    expect(ids).toHaveLength(5);
    expect(body.items).toHaveLength(7);
    expect(body.items.some((item: { id: string }) => ids.includes(item.id))).toBe(false);
  });

  it('defaults limit to 20 and caps it at 100', async () => {
    const userId = `user-${randomUUID()}`;
    await insertRows(userId, 150, 150);

    const byDefault = await getJson(ctx.baseUrl, '/v1/generations', userId);
    const capped = await getJson(ctx.baseUrl, '/v1/generations?limit=1000', userId);
    const huge = await getJson(ctx.baseUrl, '/v1/generations?limit=99999999999', userId);

    expect(byDefault.body.items).toHaveLength(20);
    expect(byDefault.body.nextCursor).toEqual(expect.any(String));
    expect(capped.body.items).toHaveLength(100);
    expect(huge.body.items).toHaveLength(100);
  });

  it.each(['0', '-1', 'abc', '1.5', '', '1e2'])('returns 400 for limit=%s', async (limit) => {
    const response = await getJson(ctx.baseUrl, `/v1/generations?limit=${limit}`, `user-${randomUUID()}`);
    expect(response).toEqual({ status: 400, body: { error: 'invalid_limit' } });
  });

  it.each([
    ['limit=2&limit=3', 'invalid_limit'],
    ['cursor=a&cursor=b', 'invalid_cursor'],
  ])('returns 400 for the repeated parameter in %s', async (query, error) => {
    const response = await getJson(ctx.baseUrl, `/v1/generations?${query}`, `user-${randomUUID()}`);
    expect(response).toEqual({ status: 400, body: { error } });
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['wrong shape', Buffer.from('{"x":1}').toString('base64url')],
    ['invalid uuid', Buffer.from('{"t":"2026-01-01T00:00:00.000Z","id":"nope"}').toString('base64url')],
  ])('returns 400 for a %s cursor', async (_label, cursor) => {
    const response = await getJson(ctx.baseUrl, `/v1/generations?cursor=${cursor}`, `user-${randomUUID()}`);
    expect(response).toEqual({ status: 400, body: { error: 'invalid_cursor' } });
  });

  it("does not leak another user's records through a foreign cursor", async () => {
    const [alice, bob] = [`alice-${randomUUID()}`, `bob-${randomUUID()}`];
    await insertRows(alice, 3, 3);
    const cursor = encodeCursor({ createdAt: new Date('2030-01-01T00:00:00.000Z'), id: randomUUID() });

    const { body } = await getJson(ctx.baseUrl, `/v1/generations?cursor=${cursor}`, bob);

    expect(body).toEqual({ items: [], nextCursor: null });
  });
});

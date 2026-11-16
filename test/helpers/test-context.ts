import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import { pino } from 'pino';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRedisClient, waitForRedis } from '../../src/cache/generation-cache.js';
import { createGenerationService } from '../../src/container.js';
import { createDatabase } from '../../src/db/database.js';
import type { Database } from '../../src/db/schema.js';
import type { Clock } from '../../src/lib/clock.js';
import type { AiProvider } from '../../src/provider/ai-provider.js';
import { FakeAiProvider } from '../../src/provider/fake-ai-provider.js';

/** Wraps a provider and records every call, so tests can assert whether the provider was reached. */
export class RecordingProvider implements AiProvider {
  readonly calls: string[] = [];

  constructor(private readonly inner: AiProvider) {}

  generate(prompt: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(prompt);
    return this.inner.generate(prompt, signal);
  }
}

/** A clock tests can move, e.g. across UTC midnight. */
export class MutableClock implements Clock {
  constructor(private current: Date = new Date()) {}

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date;
  }
}

export interface TestContextOptions {
  dailyQuota?: number;
  providerTimeoutMs?: number;
  cacheTtlSeconds?: number;
  clock?: Clock;
  /** Overrides the Redis URL, e.g. to simulate an unreachable Redis. */
  redisUrl?: string;
}

export interface TestContext {
  app: FastifyInstance;
  baseUrl: string;
  db: Kysely<Database>;
  redis: Redis;
  provider: RecordingProvider;
  close(): Promise<void>;
}

/**
 * Boots the real application on an ephemeral port against the test PostgreSQL and Redis.
 * The fake provider uses short delays so tests stay fast without long real-time waits.
 */
export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const db = createDatabase({ connectionString: inject('databaseUrl'), maxConnections: 10 });
  const redis = createRedisClient({ url: options.redisUrl ?? inject('redisUrl'), commandTimeoutMs: 200 });
  redis.on('error', () => {
    // Connection errors are expected in the "Redis unavailable" scenario.
  });
  await waitForRedis(redis, options.redisUrl ? 200 : 5_000);

  const provider = new RecordingProvider(
    new FakeAiProvider({ normalMs: 50, slowMs: 100, errorMs: 20, hangMs: 60_000 }),
  );
  const logger = pino({ level: 'silent' });
  const service = createGenerationService({
    db,
    redis,
    provider,
    clock: options.clock ?? new MutableClock(),
    logger,
    config: {
      dailyQuota: options.dailyQuota ?? 5,
      cacheTtlSeconds: options.cacheTtlSeconds ?? 600,
      providerTimeoutMs: options.providerTimeoutMs ?? 3_000,
    },
  });

  const app = buildApp({ service, logger, bodyLimitBytes: 32 * 1024 });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    app,
    baseUrl,
    db,
    redis,
    provider,
    async close() {
      await app.close();
      await Promise.allSettled([db.destroy(), redis.quit()]);
      redis.disconnect();
    },
  };
}

export async function resetState(ctx: Pick<TestContext, 'db' | 'redis'>): Promise<void> {
  await sql`TRUNCATE generations, daily_quota_usage`.execute(ctx.db);
  await ctx.redis.flushdb();
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function postGeneration(
  baseUrl: string,
  userId: string | undefined,
  body: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId !== undefined) {
    headers['x-user-id'] = userId;
  }
  const response = await fetch(`${baseUrl}/v1/generations`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function getJson(baseUrl: string, path: string, userId?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (userId !== undefined) {
    headers['x-user-id'] = userId;
  }
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

export async function remainingQuota(baseUrl: string, userId: string): Promise<number> {
  const { body } = await getJson(baseUrl, '/v1/quota', userId);
  return body.remaining as number;
}

export async function countGenerations(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('generations')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

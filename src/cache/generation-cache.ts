import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface GenerationCache {
  /** Cached result for a normalized prompt, or `null` on miss (or when the cache is unavailable). */
  get(normalizedPrompt: string): Promise<string | null>;
  /** Best effort: never throws. */
  set(normalizedPrompt: string, result: string): Promise<void>;
}

/**
 * Shared, cross-user result cache in Redis. It fails open: a Redis error is logged and treated as a
 * miss, so an outage degrades to "no cache" instead of failing requests.
 */
export class RedisGenerationCache implements GenerationCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}

  async get(normalizedPrompt: string): Promise<string | null> {
    try {
      return await this.redis.get(cacheKey(normalizedPrompt));
    } catch (error) {
      this.logger.warn({ err: error }, 'cache read failed; treating as miss');
      return null;
    }
  }

  async set(normalizedPrompt: string, result: string): Promise<void> {
    try {
      await this.redis.set(cacheKey(normalizedPrompt), result, 'EX', this.ttlSeconds);
    } catch (error) {
      this.logger.warn({ err: error }, 'cache write failed; continuing without cache');
    }
  }
}

/** Hashing keeps keys short and fixed-size even for 2,000-character prompts. */
export function cacheKey(normalizedPrompt: string): string {
  const digest = createHash('sha256').update(normalizedPrompt, 'utf8').digest('hex');
  return `generation:v1:${digest}`;
}

export interface RedisClientOptions {
  url: string;
  commandTimeoutMs: number;
}

export function createRedisClient(options: RedisClientOptions): Redis {
  return new Redis(options.url, {
    // Fail fast instead of buffering commands in process memory while Redis is unreachable.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: options.commandTimeoutMs,
    connectTimeout: 2_000,
    // Keep reconnecting in the background with a capped backoff.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
}

/** Resolves once the client is connected, or after `timeoutMs` (the service still starts degraded). */
export async function waitForRedis(redis: Redis, timeoutMs: number): Promise<boolean> {
  if (redis.status === 'ready') {
    return true;
  }
  return new Promise((resolve) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    redis.once('ready', onReady);
  });
}

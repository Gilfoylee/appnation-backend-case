import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { RedisGenerationCache } from './cache/generation-cache.js';
import type { AppConfig } from './config.js';
import { GenerationRepository } from './db/generations.repository.js';
import { QuotaRepository } from './db/quota.repository.js';
import type { Database } from './db/schema.js';
import { GenerationService } from './domain/generation.service.js';
import type { Clock } from './lib/clock.js';
import type { AiProvider } from './provider/ai-provider.js';

export interface ServiceDependencies {
  db: Kysely<Database>;
  redis: Redis;
  provider: AiProvider;
  clock: Clock;
  logger: Logger;
  config: Pick<AppConfig, 'dailyQuota' | 'cacheTtlSeconds' | 'providerTimeoutMs'>;
}

/** Composition root shared by the server entrypoint and the integration tests. */
export function createGenerationService(deps: ServiceDependencies): GenerationService {
  return new GenerationService({
    generations: new GenerationRepository(deps.db),
    quota: new QuotaRepository(deps.db),
    cache: new RedisGenerationCache(deps.redis, deps.config.cacheTtlSeconds, deps.logger),
    provider: deps.provider,
    clock: deps.clock,
    logger: deps.logger,
    dailyQuota: deps.config.dailyQuota,
    providerTimeoutMs: deps.config.providerTimeoutMs,
  });
}

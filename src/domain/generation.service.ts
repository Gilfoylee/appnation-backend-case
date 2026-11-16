import type { Logger } from 'pino';
import type { GenerationCache } from '../cache/generation-cache.js';
import type { Generation, GenerationRepository } from '../db/generations.repository.js';
import type { QuotaRepository } from '../db/quota.repository.js';
import { type Clock, nextUtcMidnight, utcDay } from '../lib/clock.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { type AiProvider, ProviderTimeoutError } from '../provider/ai-provider.js';
import { generateWithTimeout } from '../provider/generate-with-timeout.js';
import { invalidCursor, invalidPrompt, providerFailed, providerTimedOut, quotaExceeded } from './errors.js';
import { normalizePrompt, preparePrompt } from './prompt.js';

export interface GenerationServiceOptions {
  generations: GenerationRepository;
  quota: QuotaRepository;
  cache: GenerationCache;
  provider: AiProvider;
  clock: Clock;
  logger: Pick<Logger, 'warn' | 'error'>;
  dailyQuota: number;
  providerTimeoutMs: number;
}

export interface HistoryPage {
  items: Generation[];
  nextCursor: string | null;
}

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
}

export class GenerationService {
  constructor(private readonly options: GenerationServiceOptions) {}

  /**
   * 1. Validate the prompt (no side effects on failure).
   * 2. Cache hit  -> store in history as cached, no quota, no provider call.
   * 3. Cache miss -> atomically reserve one unit of today's quota BEFORE calling the provider
   *                  (in-flight requests count, so concurrent requests can never overshoot).
   * 4. Provider error/timeout -> give the unit back; nothing is cached.
   * 5. Success -> cache the result, store it in history.
   */
  async generate(userId: string, rawPrompt: string): Promise<Generation> {
    const { generations, quota, cache, provider, clock, dailyQuota, providerTimeoutMs } = this.options;

    const prompt = preparePrompt(rawPrompt);
    if (prompt === null) {
      throw invalidPrompt();
    }
    const normalized = normalizePrompt(prompt);

    const cachedResult = await cache.get(normalized);
    if (cachedResult !== null) {
      return generations.create({ userId, prompt, result: cachedResult, cached: true });
    }

    // The day is captured once so a release always targets the same bucket as its reservation.
    const day = utcDay(clock.now());
    const reserved = await quota.tryReserve(userId, day, dailyQuota);
    if (reserved === null) {
      throw quotaExceeded();
    }

    let result: string;
    try {
      result = await generateWithTimeout(provider, normalized, providerTimeoutMs);
    } catch (error) {
      await this.releaseQuota(userId, day);
      if (error instanceof ProviderTimeoutError) {
        throw providerTimedOut();
      }
      this.options.logger.warn({ err: error }, 'provider call failed');
      throw providerFailed();
    }

    await cache.set(normalized, result);
    try {
      return await generations.create({ userId, prompt, result, cached: false });
    } catch (error) {
      // The user did not get a stored generation, so it must not cost them quota.
      await this.releaseQuota(userId, day);
      throw error;
    }
  }

  /** Newest-first page; reads `limit + 1` rows only to know whether another page exists. */
  async listHistory(userId: string, limit: number, cursor?: string): Promise<HistoryPage> {
    let after;
    if (cursor !== undefined) {
      after = decodeCursor(cursor);
      if (after === null) {
        throw invalidCursor();
      }
    }

    const rows = await this.options.generations.listByUser(userId, limit + 1, after);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  async getQuotaStatus(userId: string): Promise<QuotaStatus> {
    const { quota, clock, dailyQuota } = this.options;
    const now = clock.now();
    const used = Math.min(await quota.getUsed(userId, utcDay(now)), dailyQuota);
    return { limit: dailyQuota, used, remaining: dailyQuota - used, resetsAt: nextUtcMidnight(now) };
  }

  private async releaseQuota(userId: string, day: string): Promise<void> {
    try {
      await this.options.quota.release(userId, day);
    } catch (error) {
      // Fail closed: the unit stays consumed for the day rather than risking an over-grant.
      this.options.logger.error({ err: error, userId, day }, 'failed to release reserved quota');
    }
  }
}

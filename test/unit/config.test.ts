import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const required = { DATABASE_URL: 'postgres://app:app@localhost:5432/generations', REDIS_URL: 'redis://localhost:6379' };

  it('defaults to the business rules of the case', () => {
    expect(loadConfig(required)).toMatchObject({
      port: 3000,
      bodyLimitBytes: 32 * 1024,
      dailyQuota: 5,
      cacheTtlSeconds: 600,
      providerTimeoutMs: 3_000,
    });
  });

  it('reads overrides from the environment', () => {
    expect(loadConfig({ ...required, DAILY_QUOTA: '10', PROVIDER_TIMEOUT_MS: '1500' })).toMatchObject({
      dailyQuota: 10,
      providerTimeoutMs: 1_500,
    });
  });

  it('fails fast on missing or invalid values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...required, DAILY_QUOTA: '0' })).toThrow(/DAILY_QUOTA/);
    expect(() => loadConfig({ ...required, CACHE_TTL_SECONDS: 'ten' })).toThrow(/CACHE_TTL_SECONDS/);
  });
});

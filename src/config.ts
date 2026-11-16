import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(32 * 1024),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(200),

  DAILY_QUOTA: z.coerce.number().int().positive().default(5),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  bodyLimitBytes: number;
  databaseUrl: string;
  dbPoolMax: number;
  redisUrl: string;
  redisCommandTimeoutMs: number;
  dailyQuota: number;
  cacheTtlSeconds: number;
  providerTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    redisUrl: e.REDIS_URL,
    redisCommandTimeoutMs: e.REDIS_COMMAND_TIMEOUT_MS,
    dailyQuota: e.DAILY_QUOTA,
    cacheTtlSeconds: e.CACHE_TTL_SECONDS,
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
  };
}

import { pino } from 'pino';
import { buildApp } from './app.js';
import { createRedisClient, waitForRedis } from './cache/generation-cache.js';
import { loadConfig } from './config.js';
import { createGenerationService } from './container.js';
import { createDatabase } from './db/database.js';
import { systemClock } from './lib/clock.js';
import { FakeAiProvider } from './provider/fake-ai-provider.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });

const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: config.dbPoolMax });
const redis = createRedisClient({ url: config.redisUrl, commandTimeoutMs: config.redisCommandTimeoutMs });
redis.on('error', (error: Error) => logger.warn({ err: error.message }, 'redis connection error'));

if (!(await waitForRedis(redis, 5_000))) {
  logger.warn('redis is not reachable; serving without cache until it reconnects');
}

const service = createGenerationService({
  db,
  redis,
  provider: new FakeAiProvider(),
  clock: systemClock,
  logger,
  config,
});
const app = buildApp({ service, logger, bodyLimitBytes: config.bodyLimitBytes });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
  } finally {
    await Promise.allSettled([db.destroy(), redis.quit()]);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ err: error }, 'failed to start');
  await Promise.allSettled([db.destroy(), redis.quit()]);
  process.exit(1);
}

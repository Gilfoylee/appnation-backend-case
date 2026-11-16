import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../src/db/database.js';
import { migrateToLatest } from '../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Integration tests always run against a real PostgreSQL and Redis. By default both are started
 * with Testcontainers; set TEST_DATABASE_URL / TEST_REDIS_URL to reuse already running instances.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const teardowns: Array<() => Promise<unknown>> = [];

  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    databaseUrl = postgres.getConnectionUri();
    teardowns.push(() => postgres.stop());
  }

  let redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    const redis = await new RedisContainer('redis:7.4-alpine').start();
    redisUrl = redis.getConnectionUrl();
    teardowns.push(() => redis.stop());
  }

  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.all(teardowns.map((teardown) => teardown()));
  };
}

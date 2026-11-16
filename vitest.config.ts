import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Starts PostgreSQL and Redis with Testcontainers (or uses TEST_DATABASE_URL / TEST_REDIS_URL).
          globalSetup: ['./test/global-setup.ts'],
          // Files share one database and one Redis, so they run one at a time.
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});

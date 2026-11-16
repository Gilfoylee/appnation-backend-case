import { sql } from 'kysely';
import { createDatabase } from '../db/database.js';

/**
 * Seeds SEED_COUNT (default 100,000) history rows for a single user (default "seed-user").
 * Every 4 consecutive rows share the same created_at, so pagination ties are exercised for real.
 * Idempotent: the user's previous rows are removed first.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
const userId = process.env.SEED_USER_ID ?? 'seed-user';
const count = Number(process.env.SEED_COUNT ?? 100_000);

const db = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
try {
  const startedAt = performance.now();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('generations').where('user_id', '=', userId).execute();
    await sql`
      INSERT INTO generations (user_id, prompt, result, cached, created_at)
      SELECT ${userId},
             'seed prompt ' || g,
             'Sonuç: seed prompt ' || g,
             g % 3 = 0,
             now() - (g / 4) * interval '1 second'
      FROM generate_series(1, ${count}::int) AS g
    `.execute(trx);
  });
  await sql`ANALYZE generations`.execute(db);
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(`Seeded ${count} generations for "${userId}" in ${seconds}s`);
} finally {
  await db.destroy();
}

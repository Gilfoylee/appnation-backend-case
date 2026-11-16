import { sql } from 'kysely';
import { createDatabase } from '../db/database.js';
import { GenerationRepository } from '../db/generations.repository.js';

/**
 * Prints EXPLAIN (ANALYZE, BUFFERS) for the history query exactly as the service builds it:
 * the first page, and a page deep in the history (after the 50,000th row) via the cursor.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
const userId = process.env.SEED_USER_ID ?? 'seed-user';
const pageSize = 20;

const db = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
const repository = new GenerationRepository(db);

async function explain(title: string, query: ReturnType<GenerationRepository['historyQuery']>): Promise<void> {
  const compiled = query.compile();
  const plan = await query.explain('text', sql`analyze, buffers`);
  console.log(`-- ${title}`);
  console.log(`-- ${compiled.sql.replace(/\s+/g, ' ')}`);
  console.log(plan.map((row) => row['QUERY PLAN']).join('\n'));
  console.log();
}

try {
  const deep = await db
    .selectFrom('generations')
    .select(['created_at', 'id'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(50_000)
    .limit(1)
    .executeTakeFirst();

  await explain('First page', repository.historyQuery(userId, pageSize + 1));
  if (deep) {
    await explain(
      'Page after row 50,000 (cursor)',
      repository.historyQuery(userId, pageSize + 1, { createdAt: deep.created_at, id: deep.id }),
    );
  } else {
    console.log(`No rows for "${userId}"; run the seed script first.`);
  }
} finally {
  await db.destroy();
}

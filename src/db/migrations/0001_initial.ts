import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE generations (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    varchar(128) NOT NULL CHECK (char_length(user_id) > 0),
      prompt     text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
      result     text NOT NULL,
      cached     boolean NOT NULL,
      created_at timestamptz(3) NOT NULL DEFAULT now()
    )
  `.execute(db);

  // Serves the history query: equality on user_id, then ordered range scan on (created_at, id).
  // id breaks ties between rows sharing the same created_at so keyset pages never skip or repeat rows.
  await sql`
    CREATE INDEX generations_user_history_idx
      ON generations (user_id, created_at DESC, id DESC)
  `.execute(db);

  // One row per user per UTC day. The primary key is the row we lock atomically when reserving quota.
  await sql`
    CREATE TABLE daily_quota_usage (
      user_id    varchar(128) NOT NULL,
      usage_date date NOT NULL,
      used       integer NOT NULL DEFAULT 0 CHECK (used >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, usage_date)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS daily_quota_usage`.execute(db);
  await sql`DROP TABLE IF EXISTS generations`.execute(db);
}

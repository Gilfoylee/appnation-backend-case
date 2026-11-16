import { type Kysely, sql } from 'kysely';
import type { Database } from './schema.js';

export class QuotaRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Atomically takes one unit of the user's allowance for `day`.
   * Returns the new usage count, or `null` when the allowance is already exhausted.
   *
   *   INSERT INTO daily_quota_usage (user_id, usage_date, used) VALUES ($1, $2, 1)
   *   ON CONFLICT (user_id, usage_date)
   *   DO UPDATE SET used = daily_quota_usage.used + 1, updated_at = now()
   *   WHERE daily_quota_usage.used < $limit
   *   RETURNING used
   *
   * Concurrent calls for the same user serialize on the row lock taken by ON CONFLICT DO UPDATE,
   * and the WHERE clause is re-evaluated against the latest committed value, so no more than
   * `limit` calls can ever succeed for a given day. A brand-new day is created by whichever insert
   * wins the primary-key race; the others fall through to the conflict branch.
   */
  async tryReserve(userId: string, day: string, limit: number): Promise<number | null> {
    const row = await this.db
      .insertInto('daily_quota_usage')
      .values({ user_id: userId, usage_date: day, used: 1 })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'usage_date'])
          .doUpdateSet((eb) => ({
            used: eb('daily_quota_usage.used', '+', 1),
            updated_at: sql<Date>`now()`,
          }))
          .where('daily_quota_usage.used', '<', limit),
      )
      .returning('used')
      .executeTakeFirst();
    return row?.used ?? null;
  }

  /** Gives back a unit taken by `tryReserve` (provider failure or timeout). Never goes below zero. */
  async release(userId: string, day: string): Promise<void> {
    await this.db
      .updateTable('daily_quota_usage')
      .set((eb) => ({ used: eb('used', '-', 1), updated_at: sql<Date>`now()` }))
      .where('user_id', '=', userId)
      .where('usage_date', '=', day)
      .where('used', '>', 0)
      .execute();
  }

  async getUsed(userId: string, day: string): Promise<number> {
    const row = await this.db
      .selectFrom('daily_quota_usage')
      .select('used')
      .where('user_id', '=', userId)
      .where('usage_date', '=', day)
      .executeTakeFirst();
    return row?.used ?? 0;
  }
}

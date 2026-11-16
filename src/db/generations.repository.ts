import type { Kysely } from 'kysely';
import type { Database, GenerationRow } from './schema.js';

export interface Generation {
  id: string;
  userId: string;
  prompt: string;
  result: string;
  cached: boolean;
  createdAt: Date;
}

export interface NewGeneration {
  userId: string;
  prompt: string;
  result: string;
  cached: boolean;
}

/** Position of the last row of the previous page (keyset pagination). */
export interface HistoryPosition {
  createdAt: Date;
  id: string;
}

export class GenerationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: NewGeneration): Promise<Generation> {
    const row = await this.db
      .insertInto('generations')
      .values({
        user_id: input.userId,
        prompt: input.prompt,
        result: input.result,
        cached: input.cached,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toGeneration(row);
  }

  /**
   * Newest-first page of a user's history, strictly after `after`.
   *
   *   SELECT * FROM generations
   *   WHERE user_id = $1 [AND (created_at, id) < ($2, $3)]
   *   ORDER BY created_at DESC, id DESC
   *   LIMIT $4
   *
   * The row comparison together with the (user_id, created_at DESC, id DESC) index lets PostgreSQL
   * seek directly to the cursor position and read only `limit` rows, regardless of page depth.
   */
  async listByUser(userId: string, limit: number, after?: HistoryPosition): Promise<Generation[]> {
    let query = this.db
      .selectFrom('generations')
      .selectAll()
      .where('user_id', '=', userId);

    if (after) {
      query = query.where(({ eb, refTuple, tuple }) =>
        eb(refTuple('created_at', 'id'), '<', tuple(after.createdAt, after.id)),
      );
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toGeneration);
  }
}

function toGeneration(row: GenerationRow): Generation {
  return {
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    result: row.result,
    cached: row.cached,
    createdAt: row.created_at,
  };
}

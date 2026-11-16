import type { ColumnType, Generated, Selectable } from 'kysely';

export interface GenerationsTable {
  id: Generated<string>;
  user_id: string;
  prompt: string;
  result: string;
  cached: boolean;
  // timestamptz(3): millisecond precision so a JS Date round-trips exactly through the cursor.
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface DailyQuotaUsageTable {
  user_id: string;
  // UTC calendar day as 'YYYY-MM-DD'. The pg driver is configured to return DATE columns as strings.
  usage_date: string;
  used: number;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface Database {
  generations: GenerationsTable;
  daily_quota_usage: DailyQuotaUsageTable;
}

export type GenerationRow = Selectable<GenerationsTable>;

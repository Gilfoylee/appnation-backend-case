import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of local-midnight Date objects,
// so UTC day keys never shift with the process time zone.
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

export interface DatabaseOptions {
  connectionString: string;
  maxConnections: number;
}

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

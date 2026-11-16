import type { Kysely } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import { pathToFileURL } from 'node:url';
import * as initial from './migrations/0001_initial.js';

// Migrations are imported statically instead of scanned from disk, so the same list works
// from compiled JavaScript (dist/) and from TypeScript under Vitest/tsx.
const migrations: Record<string, Migration> = {
  '0001_initial': initial,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  const applied = (results ?? [])
    .filter((result) => result.status === 'Success')
    .map((result) => result.migrationName);
  if (error) {
    const failed = results?.find((result) => result.status === 'Error');
    throw new Error(`Migration ${failed?.migrationName ?? '(unknown)'} failed`, { cause: error });
  }
  return applied;
}

async function main(): Promise<void> {
  const { createDatabase } = await import('./database.js');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  try {
    const applied = await migrateToLatest(db);
    console.log(applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

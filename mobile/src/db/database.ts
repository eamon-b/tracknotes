/**
 * SQLite open helper.
 *
 * Opens the single app database and runs pending migrations. Returns a cached
 * promise so concurrent callers share one connection. Keep this minimal — the
 * schema itself lives in `schema.ts`.
 *
 * The connection is handed out through `guardDatabase`, so a single-statement
 * write waits for any open `withTransaction` instead of landing inside it (see
 * `transaction.ts`).
 */

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './schema';
import { guardDatabase } from './transaction';

const DB_NAME = 'tracknotes.db';

let dbPromise: Promise<SQLiteDatabase> | null = null;

/** Open (once) and migrate the app database. */
export function getDatabase(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openDatabaseAsync(DB_NAME);
      await migrateDatabase(db);
      return guardDatabase(db);
    })().catch((e: unknown) => {
      // Do not cache a failed open: the next call tries again rather than
      // failing every repo call until the app restarts.
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** Test seam: drop the cached connection so the next call re-opens. */
export function resetDatabaseForTests(): void {
  dbPromise = null;
}

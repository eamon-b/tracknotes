/**
 * The one serialised write path onto the shared SQLite connection.
 *
 * Every caller of `getDatabase()` shares ONE connection, and a bare `BEGIN` on
 * it is connection-wide: a second `BEGIN` issued while the first transaction is
 * still open throws "cannot start a transaction within a transaction". That
 * overlap is ordinary, not exotic — a sync ack (`plansRepo.upsertServerAck`)
 * landing while the hiker taps a stop, or a route saved while a pull applies —
 * and the loser's edit was simply dropped. So every repo transaction goes
 * through {@link withTransaction}, which queues them per connection.
 *
 * Single statements need the same queue. A bare `runAsync` from another caller
 * issued while a transaction is open lands INSIDE it (the connection does not
 * know whose statement it is), and is rolled back with it if that transaction
 * fails. So `getDatabase()` hands out {@link guardDatabase}'s view of the
 * connection, whose `runAsync`/`execAsync` wait for the open transaction, and
 * `withTransaction` passes its callback the unguarded connection (`tx`): the
 * callback's own statements must run ON the transaction, not queue behind it.
 * Reads are not queued — a read never loses anything, and reads are the hot
 * path.
 *
 * A plain promise chain rather than expo-sqlite's
 * `withExclusiveTransactionAsync`: that opens a second connection, which the
 * better-sqlite3 test adapter (an in-memory database per test) cannot share,
 * and the chain gives the same guarantee for the writes that need it.
 *
 * Inside the callback use `tx`, never the outer handle: a guarded write from
 * inside the callback waits for the transaction it is part of, forever. For the
 * same reason `withTransaction` is not re-entrant. No repo nests them.
 *
 * Kept out of `database.ts` so the repos stay importable without the native
 * open path (several tests mock that module wholesale).
 */

import type { SqlDatabase } from './sql-database';

/** Per-connection tail of the queue. Never rejects — see {@link withWriteLock}. */
const tails = new WeakMap<object, Promise<void>>();

/** Guarded view → the raw connection it wraps. */
const rawOf = new WeakMap<object, SqlDatabase>();

/** The raw connection behind `db` (itself when it is not a guarded view). */
function unwrap(db: SqlDatabase): SqlDatabase {
  return rawOf.get(db) ?? db;
}

/**
 * Run `fn` once every write queued before it on `db` has settled, and hold the
 * queue until `fn` settles. Its result (or rejection) is passed through. A
 * guarded view and its raw connection share one queue.
 */
export function withWriteLock<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  const key = unwrap(db);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  // The tail swallows the outcome: one failed write must not wedge every write
  // queued behind it.
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * `BEGIN` → `fn(tx)` → `COMMIT` (or `ROLLBACK` on a throw), serialised with
 * every other transaction and guarded write on `db`. `tx` is the raw
 * connection: run the transaction's statements on it.
 */
export function withTransaction<T>(
  db: SqlDatabase,
  fn: (tx: SqlDatabase) => Promise<T>,
): Promise<T> {
  const tx = unwrap(db);
  return withWriteLock(tx, async () => {
    await tx.execAsync('BEGIN');
    try {
      const result = await fn(tx);
      await tx.execAsync('COMMIT');
      return result;
    } catch (e) {
      // A failed ROLLBACK (the transaction already ended) must not mask the
      // error that caused it.
      await tx.execAsync('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
}

/** The statement methods that write, and so wait for an open transaction. */
const QUEUED_METHODS = new Set<PropertyKey>(['runAsync', 'execAsync']);

/**
 * A view of `raw` whose single-statement writes (`runAsync`, `execAsync`) queue
 * behind any open {@link withTransaction} on it, so they can neither land
 * inside another caller's transaction nor be rolled back with it. Everything
 * else passes straight through to `raw`.
 */
export function guardDatabase<T extends SqlDatabase>(raw: T): T {
  const guarded = new Proxy(raw, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (QUEUED_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          withWriteLock(target, () => method.apply(target, args) as Promise<unknown>);
      }
      return method.bind(target);
    },
  });
  rawOf.set(guarded, raw);
  return guarded;
}

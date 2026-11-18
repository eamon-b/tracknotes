/**
 * The serialised write path. Every repo transaction shares one connection, so
 * two of them overlapping — a sync ack landing while the hiker taps a stop —
 * used to nest a BEGIN inside a BEGIN, which SQLite refuses, and the loser's
 * write was lost.
 */

import type { PlanDocument } from '@lib/plan-types';
import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as plansRepo from '../plans-repo';
import * as routesRepo from '../routes-repo';
import { guardDatabase, withTransaction, withWriteLock } from '../transaction';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

function plan(id: string, trailId: string, name: string): PlanDocument {
  return {
    id,
    trailId,
    name,
    direction: 'NOBO',
    startDate: null,
    stops: [],
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

describe('withTransaction', () => {
  it('lets overlapping repo transactions all land', async () => {
    const d = await db();

    await Promise.all([
      plansRepo.upsertLocal(d, plan('p1', 'heysen', 'Tap')),
      plansRepo.upsertServerAck(d, plan('p2', 'larapinta', 'Ack')),
      routesRepo.createRoute(d, {
        trailId: 'heysen',
        name: 'Day 1',
        totalKm: 10,
        ascentM: 100,
        descentM: 100,
        points: [
          { kind: 'snap', lat: -35, lon: 138, km: 0 },
          { kind: 'snap', lat: -35.1, lon: 138, km: 10 },
        ],
      }),
    ]);

    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Tap');
    expect((await plansRepo.getByTrail(d, 'larapinta'))?.name).toBe('Ack');
    expect(await routesRepo.listRoutes(d, 'heysen')).toHaveLength(1);
  });

  it('runs queued transactions one at a time, in order', async () => {
    const d = await db();
    const events: string[] = [];
    const step = (name: string) => async () => {
      events.push(`${name}:start`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`${name}:end`);
    };

    await Promise.all([withTransaction(d, step('a')), withTransaction(d, step('b'))]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('rolls a failed transaction back without wedging the next one', async () => {
    const d = await db();
    const failing = withTransaction(d, async () => {
      await d.runAsync(
        "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_rolled_back')",
      );
      throw new Error('boom');
    });
    const next = withTransaction(d, async () => {
      await d.runAsync("INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_kept')");
    });

    await expect(failing).rejects.toThrow('boom');
    await next;

    const rows = await d.getAllAsync<{ waypoint_id: string }>('SELECT waypoint_id FROM favorites');
    expect(rows.map((r) => r.waypoint_id)).toEqual(['w_kept']);
  });

  it('keeps separate connections independent', async () => {
    const a = await db();
    const b = await db();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const held = withWriteLock(a, async () => {
      await gate;
      order.push('a');
    });
    await withWriteLock(b, async () => {
      order.push('b');
    });
    release();
    await held;

    expect(order).toEqual(['b', 'a']);
  });
});

describe('guardDatabase', () => {
  async function favorites(d: SqlDatabase): Promise<string[]> {
    const rows = await d.getAllAsync<{ waypoint_id: string }>(
      'SELECT waypoint_id FROM favorites ORDER BY waypoint_id',
    );
    return rows.map((r) => r.waypoint_id);
  }

  /**
   * A transaction that writes, waits for `gate`, then fails and rolls back.
   * `written` settles once its own write has landed (the transaction is open).
   */
  function failingTransaction(
    d: SqlDatabase,
    gate: Promise<void>,
  ): { done: Promise<void>; written: Promise<void> } {
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => (markWritten = resolve));
    const done = withTransaction(d, async (tx) => {
      await tx.runAsync(
        "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_rolled_back')",
      );
      markWritten();
      await gate;
      throw new Error('boom');
    });
    return { done, written };
  }

  it('reproduces the lost write on the raw connection', async () => {
    // The bug the guard exists for: a bare write issued while another caller's
    // transaction is open lands inside it and is rolled back with it.
    const d = await db();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { done: failing, written } = failingTransaction(d, gate);
    await written;
    await d.runAsync("INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_bare')");
    release();
    await expect(failing).rejects.toThrow('boom');

    expect(await favorites(d)).toEqual([]);
  });

  it('keeps a bare write out of another caller’s failed transaction', async () => {
    const d = guardDatabase(await db());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { done: failing, written } = failingTransaction(d, gate);
    await written;
    const bare = d.runAsync(
      "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_bare')",
    );
    release();
    await expect(failing).rejects.toThrow('boom');
    await bare;

    expect(await favorites(d)).toEqual(['w_bare']);
  });

  it('queues execAsync too, and lets reads through', async () => {
    const d = guardDatabase(await db());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { done: failing, written } = failingTransaction(d, gate);
    await written;
    const bare = d.execAsync(
      "INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_exec')",
    );
    // A read is not queued: it answers while the transaction is still open.
    expect(await favorites(d)).toEqual(['w_rolled_back']);
    release();
    await expect(failing).rejects.toThrow('boom');
    await bare;

    expect(await favorites(d)).toEqual(['w_exec']);
  });

  it('runs the callback’s own writes on the transaction without waiting for it', async () => {
    const d = guardDatabase(await db());
    await withTransaction(d, async (tx) => {
      await tx.runAsync("INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_in')");
    });
    // Repo transactions through the guarded handle complete too.
    await plansRepo.upsertLocal(d, plan('p1', 'heysen', 'Tap'));
    await routesRepo.deleteRoute(d, 'missing');

    expect(await favorites(d)).toEqual(['w_in']);
    expect((await plansRepo.getByTrail(d, 'heysen'))?.name).toBe('Tap');
  });

  it('shares one queue between the guarded view and its raw connection', async () => {
    const raw = await db();
    const d = guardDatabase(raw);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = withWriteLock(raw, async () => {
      await gate;
      order.push('held');
    });
    const write = d
      .runAsync("INSERT INTO favorites (trail_id, waypoint_id) VALUES ('heysen', 'w_after')")
      .then(() => order.push('write'));
    await Promise.resolve();
    release();
    await Promise.all([held, write]);

    expect(order).toEqual(['held', 'write']);
  });
});

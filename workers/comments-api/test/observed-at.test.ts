import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { clampObservedAt, observedDayIso, publishedObservedAt } from '../src/validation';
import { createComment, registerDevice, url, wpId } from './helpers';
import type { BulkSyncResponse, FeedComment } from '../../../src/lib/comments-api-types';

// Issue #248: a water report's observation time is held and published to the
// day only — midnight UTC of its UTC date.

const MIDNIGHT_UTC = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

describe('observedDayIso / clampObservedAt', () => {
  it('floors an instant to midnight UTC of its UTC date', () => {
    expect(observedDayIso(Date.parse('2026-10-30T17:42:09.123Z'))).toBe('2026-10-30T00:00:00.000Z');
    expect(observedDayIso(Date.parse('2026-10-30T00:00:00.000Z'))).toBe('2026-10-30T00:00:00.000Z');
    expect(observedDayIso(Date.parse('2026-10-30T23:59:59.999Z'))).toBe('2026-10-30T00:00:00.000Z');
  });

  it('uses the UTC date, not the local date the client wrote an offset for', () => {
    // 9 am on the 31st in New Zealand is 8 pm on the 30th UTC.
    expect(clampObservedAt('2026-10-31T09:00:00+13:00', Date.parse('2026-11-01T00:00:00Z'))).toBe(
      '2026-10-30T00:00:00.000Z'
    );
    // 11 pm on the 30th in Perth is 3 pm on the 30th UTC.
    expect(clampObservedAt('2026-10-30T23:00:00+08:00', Date.parse('2026-11-01T00:00:00Z'))).toBe(
      '2026-10-30T00:00:00.000Z'
    );
  });

  it('keeps a date-only value as that day', () => {
    expect(clampObservedAt('2026-10-30', Date.parse('2026-11-01T00:00:00Z'))).toBe('2026-10-30T00:00:00.000Z');
  });

  it('never moves the time later, so a report never looks fresher than it is', () => {
    const raw = '2026-10-30T05:06:07.000Z';
    const out = clampObservedAt(raw, Date.parse('2026-11-01T00:00:00Z'));
    expect(Date.parse(out as string)).toBeLessThanOrEqual(Date.parse(raw));
    expect(Date.parse(raw) - Date.parse(out as string)).toBeLessThan(86_400_000);
  });

  it('clamps the future first, then coarsens, staying within the tolerance', () => {
    // 5 minutes before midnight UTC: now + 10 min is tomorrow, whose midnight
    // is still no later than now + 10 min.
    const now = Date.parse('2026-10-30T23:55:00.000Z');
    const out = clampObservedAt('2027-06-01T12:00:00Z', now) as string;
    expect(out).toBe('2026-10-31T00:00:00.000Z');
    expect(Date.parse(out)).toBeLessThanOrEqual(now + 10 * 60 * 1000);
    expect(clampObservedAt('2027-06-01T12:00:00Z', Date.parse('2026-10-30T12:00:00Z'))).toBe(
      '2026-10-30T00:00:00.000Z'
    );
  });

  it('handles years outside 0000-9999 without breaking', () => {
    expect(clampObservedAt('-000100-01-01T12:00:00Z', Date.now())).toBe('-000100-01-01T00:00:00.000Z');
  });

  it('publishes a stored value coarsened, and null or garbage as null', () => {
    expect(publishedObservedAt('2026-10-30T17:42:09.123Z')).toBe('2026-10-30T00:00:00.000Z');
    expect(publishedObservedAt('2026-10-30T00:00:00.000Z')).toBe('2026-10-30T00:00:00.000Z');
    expect(publishedObservedAt(null)).toBeNull();
    expect(publishedObservedAt('not a time')).toBeNull();
  });
});

describe('observedAt end to end', () => {
  it('stores and publishes only the day', async () => {
    const device = await registerDevice();
    const trail = 'heysen';
    const waypointId = wpId('observed-day-tank');
    const { id, res } = await createComment(device, {
      trailId: trail,
      waypointId,
      text: null,
      waterStatus: 'low',
      observedAt: '2026-10-29T06:31:17.512Z',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as FeedComment).observedAt).toBe('2026-10-29T00:00:00.000Z');

    const row = await env.DB.prepare(`SELECT observed_at FROM comments WHERE id = ?`)
      .bind(id)
      .first<{ observed_at: string }>();
    expect(row?.observed_at).toBe('2026-10-29T00:00:00.000Z');

    const feed = await SELF.fetch(url(`/v1/trails/${trail}/waypoints/${waypointId}/comments`));
    const feedBody = (await feed.json()) as { comments: FeedComment[] };
    expect(feedBody.comments.find((c) => c.id === id)?.observedAt).toBe('2026-10-29T00:00:00.000Z');
  });

  it('publishes a row stored to the second (before migration 0010) only to the day', async () => {
    const device = await registerDevice();
    const trail = 'heysen';
    const waypointId = wpId('observed-legacy-tank');
    const { id } = await createComment(device, { trailId: trail, waypointId, waterStatus: 'dry' });
    await env.DB.prepare(`UPDATE comments SET observed_at = ? WHERE id = ?`).bind('2026-10-20T14:05:33.000Z', id).run();

    const feed = await SELF.fetch(url(`/v1/trails/${trail}/waypoints/${waypointId}/comments`));
    const feedBody = (await feed.json()) as { comments: FeedComment[] };
    expect(feedBody.comments.find((c) => c.id === id)?.observedAt).toBe('2026-10-20T00:00:00.000Z');

    const bulk = await SELF.fetch(url(`/v1/trails/${trail}/comments`));
    const bulkBody = (await bulk.json()) as BulkSyncResponse;
    const entry = bulkBody.comments.find((c) => c.id === id);
    expect(entry && !('deleted' in entry) ? entry.observedAt : undefined).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('migration 0010_observed_at_day: coarsen stored observed_at', () => {
  async function runMigration(): Promise<void> {
    // By full name: `0010_content_review` shares the number (see its header).
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0010_observed_at_day'));
    expect(migration).toBeDefined();
    for (const query of migration!.queries) await env.DB.prepare(query).run();
  }

  it('coarsens precise rows, bumps a live row’s updated_at, and is idempotent', async () => {
    const device = await registerDevice();
    const live = await createComment(device, { waypointId: wpId('mig-live'), waterStatus: 'flowing' });
    const tomb = await createComment(device, { waypointId: wpId('mig-tomb'), waterStatus: 'flowing' });
    const day = await createComment(device, { waypointId: wpId('mig-day'), waterStatus: 'flowing' });
    const none = await createComment(device, { waypointId: wpId('mig-none'), waterStatus: 'flowing' });
    const old = '2026-01-01T00:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare(`UPDATE comments SET observed_at = ?, updated_at = ? WHERE id = ?`).bind(
        '2026-10-20T14:05:33.123Z',
        old,
        live.id
      ),
      env.DB.prepare(
        `UPDATE comments SET observed_at = ?, updated_at = ?, deleted_at = ?, deleted_by = 'owner' WHERE id = ?`
      ).bind('2026-10-21T01:02:03.000Z', old, old, tomb.id),
      env.DB.prepare(`UPDATE comments SET observed_at = ?, updated_at = ? WHERE id = ?`).bind(
        '2026-10-22T00:00:00.000Z',
        old,
        day.id
      ),
      env.DB.prepare(`UPDATE comments SET observed_at = NULL, updated_at = ? WHERE id = ?`).bind(old, none.id),
    ]);

    await runMigration();

    const read = async (id: string) =>
      env.DB.prepare(`SELECT observed_at, updated_at FROM comments WHERE id = ?`)
        .bind(id)
        .first<{ observed_at: string | null; updated_at: string }>();

    const liveRow = await read(live.id);
    expect(liveRow?.observed_at).toBe('2026-10-20T00:00:00.000Z');
    expect(liveRow?.updated_at).not.toBe(old);
    expect(liveRow?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(await read(tomb.id)).toEqual({ observed_at: '2026-10-21T00:00:00.000Z', updated_at: old });
    expect(await read(day.id)).toEqual({ observed_at: '2026-10-22T00:00:00.000Z', updated_at: old });
    expect(await read(none.id)).toEqual({ observed_at: null, updated_at: old });

    const bumped = liveRow!.updated_at;
    await runMigration();
    expect(await read(live.id)).toEqual({ observed_at: '2026-10-20T00:00:00.000Z', updated_at: bumped });
    expect((await read(live.id))?.observed_at).toMatch(MIDNIGHT_UTC);
  });
});

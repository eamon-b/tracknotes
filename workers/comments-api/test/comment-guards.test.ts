import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, createComment, putComment, registerDevice, url, wpId, type Device } from './helpers';
import { validateCommentTarget } from '../src/validation';
import { poiCommentId } from '../../../src/lib/poi-display';
import { userWaypointId } from '../../../src/lib/user-waypoints';
import { mintImportedWaypointIds } from '../../../src/lib/gpx-import';
import waypointRegistry from '../../../data/waypoint-ids.json';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

async function shareWaypoint(device: Device, trailId = 'heysen'): Promise<string> {
  const id = `hw_${crypto.randomUUID()}`;
  const res = await SELF.fetch(url(`/v1/waypoints/${id}`), {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify({
      trailId,
      name: 'Tank behind the shed',
      type: 'water',
      lat: -34.5,
      lon: 138.6,
      description: '',
    }),
  });
  expect(res.status).toBe(201);
  return id;
}

/** Log `count` spent units of a bucket for a user, as `consumeRateLimit` would. */
async function seedRateEvents(bucket: string, userId: string, count: number): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?)`).bind(bucket, userId, now)
    )
  );
}

async function countRateEvents(bucket: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ?`)
    .bind(bucket, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('comment targets — the ids the clients send', () => {
  it('accepts every id in the curated waypoint registry', () => {
    const registry = waypointRegistry as unknown as Record<string, { id: string }[]>;
    const ids = Object.values(registry).flatMap((entries) => entries.map((e) => e.id));
    expect(ids.length).toBeGreaterThan(1000);
    const refused = ids.filter((id) => {
      try {
        return validateCommentTarget(id, 'curated').kind !== 'curated';
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
  });

  it('accepts what poiCommentId and userWaypointId mint, on either kind of trail', () => {
    for (const trail of ['curated', 'community'] as const) {
      for (const type of ['node', 'way', 'relation']) {
        for (const id of [0, 7, 123456789, Number.MAX_SAFE_INTEGER]) {
          const commentId = poiCommentId({ type, id });
          expect(commentId).not.toBeNull();
          expect(validateCommentTarget(commentId, trail).kind).toBe('osm');
        }
      }
      const hiker = userWaypointId(crypto.randomUUID().toUpperCase());
      expect(validateCommentTarget(hiker, trail).kind).toBe('shared');
    }
  });

  it('accepts what an import mints on a community route, and only there', () => {
    const waypoints = [
      { name: 'Creek camp', lat: -37.1, lon: 145.2 },
      { name: 'Lookout', lat: -37.2, lon: 145.3 },
    ] as Parameters<typeof mintImportedWaypointIds>[0];
    const ids = mintImportedWaypointIds(waypoints, { id: 'u_abc123' } as never);
    // The `_2` an import adds when a route passes one place twice.
    ids.push(`${ids[0]}_2`);
    for (const id of ids) {
      expect(validateCommentTarget(id, 'community').kind).toBe('community');
      expect(() => validateCommentTarget(id, 'curated')).toThrow();
    }
    // And a curated id is no waypoint of a community route.
    expect(() => validateCommentTarget('w_00176641', 'community')).toThrow();
  });
});

describe('comment targets — per-prefix ids', () => {
  it.each([
    ['a curated waypoint (8 hex)', 'w_00176641'],
    ['a curated waypoint (12 hex, a registry collision)', 'w_b375dd112326'],
    ['an OSM node', 'osm_node_12345'],
    ['an OSM way', 'osm_way_987654321'],
    ['an OSM relation', 'osm_relation_0'],
    ['an OSM id at the safe-integer ceiling', `osm_node_${Number.MAX_SAFE_INTEGER}`],
  ])('accepts %s', async (_label, waypointId) => {
    const device = await registerDevice();
    const { res } = await createComment(device, { waypointId });
    expect(res.status).toBe(201);
  });

  it.each([
    ['a free-form id the old pattern allowed', 'spring-01'],
    ['an unprefixed hex id', '00176641'],
    ['a short curated id', 'w_0017664'],
    ['upper-case hex', 'w_0017664A'],
    ['a non-hex curated id', 'w_camp-one'],
    ['an import id (never synced)', 'uw_00176641'],
    ['an OSM type that is not an element', 'osm_area_123'],
    ['an OSM id with a leading zero', 'osm_node_0123'],
    ['an OSM id past the safe-integer ceiling', 'osm_node_9007199254740993'],
    ['an OSM id with no number', 'osm_node_'],
    ['a hiker id that is not a uuid', 'hw_not-a-uuid'],
    ['a hiker id with an upper-case uuid', `hw_${crypto.randomUUID().toUpperCase()}`],
  ])('rejects %s', async (_label, waypointId) => {
    const device = await registerDevice();
    const { res } = await createComment(device, { waypointId });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_waypoint');
  });

  it('spends no allowance on a rejected target', async () => {
    const device = await registerDevice();
    await createComment(device, { waypointId: 'spring-01' });
    expect(await countRateEvents('comment_post', device.userId)).toBe(0);
  });
});

describe('comment targets — shared hiker waypoints', () => {
  it('accepts a comment on a shared waypoint on its own trail', async () => {
    const owner = await registerDevice('Owner');
    const visitor = await registerDevice('Visitor');
    const waypointId = await shareWaypoint(owner);
    const { res } = await createComment(visitor, { waypointId });
    expect(res.status).toBe(201);
  });

  it('404s a hiker waypoint the server has never been sent', async () => {
    const device = await registerDevice();
    const { res } = await createComment(device, { waypointId: `hw_${crypto.randomUUID()}` });
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('waypoint_not_found');
    expect(await countRateEvents('comment_post', device.userId)).toBe(0);
  });

  it('404s a shared waypoint filed under another trail', async () => {
    const owner = await registerDevice('Owner');
    const waypointId = await shareWaypoint(owner, 'larapinta');
    const { res } = await createComment(owner, { trailId: 'heysen', waypointId });
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('waypoint_not_found');
  });

  it('410s a waypoint that is no longer shared, but still replays a stored comment', async () => {
    const owner = await registerDevice('Owner');
    const waypointId = await shareWaypoint(owner);
    const commentId = crypto.randomUUID();
    const body = { trailId: 'heysen', waypointId, text: 'Tank was half full.' };
    expect((await putComment(owner, commentId, body)).status).toBe(201);

    const del = await SELF.fetch(url(`/v1/waypoints/${waypointId}`), {
      method: 'DELETE',
      headers: authHeaders(owner),
    });
    expect(del.status).toBe(204);

    const { res } = await createComment(owner, { waypointId });
    expect(res.status).toBe(410);
    expect(errorCode(await res.json())).toBe('waypoint_deleted');

    // An outbox retry of the comment stored before the unshare still settles.
    expect((await putComment(owner, commentId, body)).status).toBe(200);
  });
});

describe('comment post limit under load', () => {
  it('cannot be raced past with parallel PUTs', async () => {
    const device = await registerDevice('Burst');
    await seedRateEvents('comment_post', device.userId, 59);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createComment(device, { waypointId: wpId('burst-wp'), text: `burst ${i}` }))
    );
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    expect(await countRateEvents('comment_post', device.userId)).toBe(60);
  });

  it('counts only the window', async () => {
    const device = await registerDevice('Yesterday');
    await seedRateEvents('comment_post', device.userId, 60);
    expect((await createComment(device)).res.status).toBe(429);

    await env.DB.prepare(`UPDATE rate_events SET created_at = ? WHERE bucket = ? AND key = ?`)
      .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), 'comment_post', device.userId)
      .run();
    expect((await createComment(device)).res.status).toBe(201);
  });
});

describe('comment report limit under load', () => {
  it('cannot be raced past with parallel reports', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Burst Reporter');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id, res } = await createComment(author, { waypointId: wpId('report-burst-wp') });
      expect(res.status).toBe(201);
      ids.push(id);
    }
    await seedRateEvents('comment_report', reporter.userId, 19);

    const results = await Promise.all(
      ids.map((id) =>
        SELF.fetch(url(`/v1/comments/${id}/report`), {
          method: 'POST',
          headers: authHeaders(reporter),
          body: JSON.stringify({ reason: 'spam' }),
        })
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    expect(await countRateEvents('comment_report', reporter.userId)).toBe(20);
  });
});

describe('comment replays', () => {
  it('replays a comment stored under an id the target rules now refuse', async () => {
    const device = await registerDevice('Old Outbox');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Stored before the per-prefix rules, under the old catch-all pattern.
    await env.DB.prepare(
      `INSERT INTO comments (id, trail_id, waypoint_id, user_id, text, created_at, updated_at)
       VALUES (?, 'heysen', 'spring-01', ?, 'Old note', ?, ?)`
    )
      .bind(id, device.userId, now, now)
      .run();

    const res = await putComment(device, id, {
      trailId: 'heysen',
      waypointId: 'spring-01',
      text: 'Old note',
    });
    expect(res.status).toBe(200);
  });

  it('charges a comment once however many copies of its PUT race', async () => {
    const device = await registerDevice('Racing Outbox');
    const id = crypto.randomUUID();
    const body = { trailId: 'heysen', waypointId: wpId('race-wp'), text: 'Once' };
    const results = await Promise.all(Array.from({ length: 5 }, () => putComment(device, id, body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(await countRateEvents('comment_post', device.userId)).toBe(1);
  });

  it('charges a report once however many copies of it race', async () => {
    const author = await registerDevice('Author');
    const reporter = await registerDevice('Racing Reporter');
    const { id } = await createComment(author, { waypointId: wpId('report-race-wp') });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        SELF.fetch(url(`/v1/comments/${id}/report`), {
          method: 'POST',
          headers: authHeaders(reporter),
          body: JSON.stringify({ reason: 'spam' }),
        })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(await countRateEvents('comment_report', reporter.userId)).toBe(1);
  });
});

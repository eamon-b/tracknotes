import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authHeaders,
  makeAdmin,
  putComment,
  putDescription,
  putPlan,
  planBody,
  registerDevice,
  url,
} from './helpers';
import type { Device } from './helpers';
import { submitBody, submitRoute } from './community-fixtures';
import { putComment as putCommentHandler } from '../src/comments';
import { LIVE_CACHE_MS, clearTrailCache } from '../src/trails';
import type { CommunityRouteDetail } from '../../../src/lib/community-types';
import type { BulkSyncResponse, TrailDescriptionsResponse } from '../../../src/lib/comments-api-types';
import type { ProcessedTrail } from '../../../src/lib/trail-types';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

interface Route {
  id: string;
  /** The ids of the waypoints the route was stored with. */
  waypointIds: string[];
}

async function shareRoute(device: Device): Promise<Route> {
  const body = submitBody();
  const res = await submitRoute(device, body);
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  const detail = (await res.json()) as CommunityRouteDetail;
  const trail = body.trail as ProcessedTrail;
  return { id: detail.id, waypointIds: trail.waypoints.map((w) => w.id as string) };
}

async function setStatus(id: string, status: 'hidden' | 'removed'): Promise<void> {
  await env.DB.prepare(`UPDATE community_routes SET status = ? WHERE id = ?`).bind(status, id).run();
}

function commentOn(device: Device, trailId: string, waypointId: string): Promise<Response> {
  return putComment(device, crypto.randomUUID(), { trailId, waypointId, text: 'Creek is running.' });
}

function shareWaypoint(device: Device, trailId: string, id = `hw_${crypto.randomUUID()}`): Promise<Response> {
  return SELF.fetch(url(`/v1/waypoints/${id}`), {
    method: 'PUT',
    headers: authHeaders(device),
    body: JSON.stringify({ trailId, name: 'Spring', type: 'water', lat: -37.5, lon: 145.5, description: '' }),
  });
}

async function bulk(trailId: string): Promise<BulkSyncResponse> {
  const res = await SELF.fetch(url(`/v1/trails/${trailId}/comments`));
  expect(res.status).toBe(200);
  return (await res.json()) as BulkSyncResponse;
}

describe('comments on community routes', () => {
  it('takes a comment on one of the route’s own waypoints and serves it back', async () => {
    const owner = await registerDevice('Owner');
    const hiker = await registerDevice('Hiker');
    const route = await shareRoute(owner);
    const waypointId = route.waypointIds[0];
    const res = await commentOn(hiker, route.id, waypointId);
    expect(res.status).toBe(201);

    const synced = await bulk(route.id);
    expect(synced.comments.map((e) => ('waypointId' in e ? e.waypointId : null))).toEqual([waypointId]);
    const feed = await SELF.fetch(url(`/v1/trails/${route.id}/waypoints/${waypointId}/comments`));
    expect(feed.status).toBe(200);
  });

  it('refuses a curated id on a community route', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    const res = await commentOn(owner, route.id, 'w_00176641');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_waypoint');
  });

  it('refuses a community id that names no route, and any u_ import', async () => {
    const device = await registerDevice();
    for (const trailId of ['c_AAAAAAAAAAAAAAAA', 'c_short', 'u_1a2b3c']) {
      const res = await commentOn(device, trailId, 'uw_abc123');
      expect(res.status).toBe(400);
      expect(errorCode(await res.json())).toBe('invalid_trail');
    }
  });

  it('takes no new comment on a hidden or removed route, but still serves the old ones', async () => {
    const owner = await registerDevice();
    for (const status of ['hidden', 'removed'] as const) {
      const route = await shareRoute(owner);
      // Posted while the route is live: by the SQL, so the cache never sees it.
      await env.DB.prepare(
        `INSERT INTO comments (id, trail_id, waypoint_id, user_id, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Earlier', ?, ?)`
      )
        .bind(crypto.randomUUID(), route.id, route.waypointIds[0], owner.userId, new Date().toISOString(), new Date().toISOString())
        .run();
      await setStatus(route.id, status);

      const res = await commentOn(owner, route.id, route.waypointIds[1]);
      expect(res.status).toBe(403);
      expect(errorCode(await res.json())).toBe('trail_not_live');
      expect((await bulk(route.id)).comments).toHaveLength(1);
    }
  });

  it('re-reads a live route’s status once its cache entry is a minute old', async () => {
    clearTrailCache();
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    const post = async (): Promise<Response> => {
      const request = new Request(url(`/v1/comments/${crypto.randomUUID()}`), {
        method: 'PUT',
        headers: authHeaders(owner),
        body: JSON.stringify({ trailId: route.id, waypointId: route.waypointIds[0], text: 'Still here' }),
      });
      const ctx = createExecutionContext();
      const id = new URL(request.url).pathname.split('/').pop() as string;
      try {
        return await putCommentHandler(request, env, ctx, id);
      } finally {
        await waitOnExecutionContext(ctx);
      }
    };
    expect((await post()).status).toBe(201);
    await setStatus(route.id, 'hidden');
    // Within the minute the cached "live" stands…
    expect((await post()).status).toBe(201);
    // …and after it, the hide is read.
    const realNow = Date.now;
    Date.now = () => realNow() + LIVE_CACHE_MS + 1;
    try {
      await expect(post()).rejects.toMatchObject({ status: 403, code: 'trail_not_live' });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('shared hiker waypoints on community routes', () => {
  it('shares one on a live route, takes comments on it and lists it', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    const id = `hw_${crypto.randomUUID()}`;
    expect((await shareWaypoint(owner, route.id, id)).status).toBe(201);
    expect((await commentOn(owner, route.id, id)).status).toBe(201);
    const res = await SELF.fetch(url(`/v1/trails/${route.id}/waypoints`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { waypoints: { id: string }[] };
    expect(body.waypoints.map((w) => w.id)).toEqual([id]);
  });

  it('refuses a new share on a hidden route but still lists the route’s waypoints', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    await setStatus(route.id, 'hidden');
    const res = await shareWaypoint(owner, route.id);
    expect(res.status).toBe(403);
    expect(errorCode(await res.json())).toBe('trail_not_live');
    expect((await SELF.fetch(url(`/v1/trails/${route.id}/waypoints`))).status).toBe(200);
  });

  it('400s a listing for a community id that names no route', async () => {
    const res = await SELF.fetch(url('/v1/trails/c_BBBBBBBBBBBBBBBB/waypoints'));
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('invalid_trail');
  });
});

describe('plans on community routes', () => {
  it('syncs a plan on a live route, with the route’s waypoint ids on its stops', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    const id = crypto.randomUUID();
    const res = await putPlan(
      owner,
      id,
      planBody(id, {
        trailId: route.id,
        stops: [{ km: 1.2, name: 'Creek camp', nights: 1, waypointId: route.waypointIds[1] }],
        resupplyStops: [route.waypointIds[0]],
      })
    );
    expect(res.status).toBe(201);
  });

  it('keeps syncing a plan on a route that was taken down', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    await setStatus(route.id, 'removed');
    const id = crypto.randomUUID();
    expect((await putPlan(owner, id, planBody(id, { trailId: route.id }))).status).toBe(201);
  });

  it('refuses a plan on a community id that names no route', async () => {
    const owner = await registerDevice();
    const id = crypto.randomUUID();
    const res = await putPlan(owner, id, planBody(id, { trailId: 'c_CCCCCCCCCCCCCCCC' }));
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('trail_not_allowed');
  });
});

describe('curated descriptions and community routes', () => {
  it('answers an empty list for a route, and an admin cannot write one', async () => {
    const owner = await registerDevice();
    const route = await shareRoute(owner);
    const res = await SELF.fetch(url(`/v1/trails/${route.id}/descriptions`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TrailDescriptionsResponse).descriptions).toEqual([]);

    const admin = await registerDevice('Admin');
    await makeAdmin(admin.userId);
    const put = await putDescription(admin, route.id, route.waypointIds[0], { description: 'Hi' });
    expect(put.status).toBe(400);
    expect(errorCode(await put.json())).toBe('invalid_trail');
  });
});

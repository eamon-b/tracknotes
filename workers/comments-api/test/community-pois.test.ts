/**
 * Community routes: the scheduled OSM POI enrichment (`enrichCommunityRoutePois`,
 * `community-pois.ts`). Overpass is a mocked fetch throughout.
 */
import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, deleteMe, makeAdmin, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import { makeTrail, submitBody, submitRoute } from './community-fixtures';
import { POI_RUN_LIMITS, enrichCommunityRoutePois, patchCommunityRoute } from '../src/community';
import type { PoiEnrichDeps } from '../src/community';
import { POI_LIMITS, parseOverpassEndpoints } from '../src/community-pois';
import type { Env } from '../src/http';
import type { CommunityRouteDetail } from '../../../src/lib/community-types';
import type { ProcessedTrail, TrailPOI } from '../../../src/lib/trail-types';

const testEnv = env as unknown as Env;

const ENDPOINT_A = 'https://overpass-a.test/api/interpreter';
const ENDPOINT_B = 'https://overpass-b.test/api/interpreter';

let startCounter = 0;

/** A start no other test in this file uses, so content hashes never collide. */
function freshStart(): { lat: number; lon: number } {
  const n = startCounter++;
  return { lat: -30 + n * 0.3, lon: 120 + n * 0.3 };
}

async function submitAt(
  device: Device,
  start: { lat: number; lon: number },
  trail: ProcessedTrail = makeTrail({ start })
): Promise<CommunityRouteDetail> {
  const res = await submitRoute(device, submitBody({ trail }));
  if (res.status !== 201) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return (await res.json()) as CommunityRouteDetail;
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await env.DB.prepare(`SELECT * FROM community_routes WHERE id = ?`).bind(id).first();
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

async function storedTrail(key: string): Promise<ProcessedTrail> {
  const object = await env.PHOTOS.get(key);
  if (!object) throw new Error(`no object ${key}`);
  return (await object.json()) as ProcessedTrail;
}

/** Make `id` the only route the run will look at. */
async function onlyCandidate(id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE community_routes SET pois_status = 'done', pois_hash = content_hash WHERE id != ?`
  )
    .bind(id)
    .run();
}

interface Call {
  endpoint: string;
  query: string;
}

type Answer = Response | (() => Response | Promise<Response>);

/** A fetch that records each Overpass query and answers from `answers` in turn (the last one repeats). */
function overpass(answers: Answer[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '');
    calls.push({ endpoint: String(input), query: decodeURIComponent(body.replace(/^data=/, '')) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof answer === 'function' ? await answer() : answer.clone();
  };
  return Object.assign(fn as typeof fetch, { calls });
}

function elementsResponse(elements: unknown[]): Response {
  return new Response(JSON.stringify({ version: 0.6, elements }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POIs placed around a `makeTrail` route that starts at `start`. */
function elementsAlong(start: { lat: number; lon: number }): unknown[] {
  const at = (i: number) => ({ lat: start.lat + i * 0.001, lon: start.lon + Math.sin(i / 10) * 0.0005 });
  return [
    // A tap 175 m off the route: kept.
    { type: 'node', id: 1, lat: at(50).lat, lon: at(50).lon + 0.002, tags: { amenity: 'drinking_water' } },
    // The route's own "Creek camp" waypoint, mapped in OSM: kept, flagged.
    {
      type: 'node',
      id: 2,
      lat: at(100).lat + 0.0003,
      lon: at(100).lon,
      tags: { tourism: 'camp_site', name: 'Creek Camp', fee: 'no' },
    },
    // Noise: a plain bus stop.
    { type: 'node', id: 3, lat: at(20).lat, lon: at(20).lon, tags: { highway: 'bus_stop', name: 'Main Rd After Creek Rd' } },
    // A supermarket mapped as a building: kept, with only its display tags.
    {
      type: 'way',
      id: 4,
      center: { lat: at(150).lat, lon: at(150).lon - 0.003 },
      tags: { shop: 'supermarket', name: 'Corner Store', opening_hours: '08:00-18:00', building: 'retail', brand: 'X' },
    },
    // 9 km off the route: dropped.
    { type: 'node', id: 5, lat: at(100).lat, lon: at(100).lon + 0.1, tags: { amenity: 'cafe' } },
    // No category at all: dropped.
    { type: 'node', id: 6, lat: at(60).lat, lon: at(60).lon, tags: { leisure: 'park' } },
  ];
}

/** `makeTrail`, but swinging ~580 m east and back at every point. */
function zigzagTrail(start: { lat: number; lon: number }, count: number): ProcessedTrail {
  const trail = makeTrail({ start, count });
  let dist = 0;
  trail.track.points = trail.track.points.map((p, i, all) => {
    const lon = start.lon + (i % 2) * 0.006;
    if (i > 0) {
      const prev = all[i - 1];
      const prevLon = start.lon + ((i - 1) % 2) * 0.006;
      const dLat = ((p.lat - prev.lat) * Math.PI) / 180;
      const dLon = ((lon - prevLon) * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((prev.lat * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
      dist += 2 * 6371 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return { ...p, lon, dist };
  });
  trail.track.displayPoints = trail.track.points;
  trail.track.totalDistance = dist;
  trail.config.lengthKm = Math.round(dist * 10) / 10;
  for (const w of trail.waypoints) {
    const p = trail.track.points[w.trackIndex as number];
    Object.assign(w, { lat: p.lat, lon: p.lon, distance: p.dist, totalDistance: p.dist });
  }
  return trail;
}

const noSleep = async (): Promise<void> => undefined;

/** Run the enrichment as a scheduled run would, `aheadMs` from now. */
async function run(fetchImpl: typeof fetch, deps: Partial<PoiEnrichDeps> = {}, aheadMs = 10 * 60 * 1000): Promise<void> {
  await enrichCommunityRoutePois(testEnv, {
    endpoints: [ENDPOINT_A, ENDPOINT_B],
    fetchImpl,
    sleep: noSleep,
    nowMs: Date.now() + aheadMs,
    purgeGraceMs: 0,
    ...deps,
  });
}

function keyOf(trailUrl: string): string {
  return trailUrl.replace(/^https:\/\/photos\.test\//, '');
}

describe('POI enrichment', () => {
  it('adds the build’s POIs to a submitted route and republishes it', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    const before = await row(route.id);
    expect(before.pois_status).toBe('pending');
    // A submit never fetches POIs: the stored route has none.
    expect((await storedTrail(before.r2_key as string)).pois).toBeUndefined();
    await onlyCandidate(route.id);

    const fetchImpl = overpass([elementsResponse(elementsAlong(start))]);
    await run(fetchImpl);

    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].endpoint).toBe(ENDPOINT_A);
    expect(fetchImpl.calls[0].query).toContain('(around:2500,');
    expect(fetchImpl.calls[0].query).toContain(`[timeout:${POI_LIMITS.queryTimeoutSeconds}]`);

    const after = await row(route.id);
    expect(after.pois_status).toBe('done');
    expect(after.pois_hash).toBe(after.content_hash);
    expect(after.poi_count).toBe(3);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.md5).not.toBe(before.md5);
    expect((after.updated_at as string) > (before.updated_at as string)).toBe(true);
    expect(after.r2_key).not.toBe(before.r2_key);

    const trail = await storedTrail(after.r2_key as string);
    const pois = trail.pois as TrailPOI[];
    expect(pois.map((p) => `${p.type}/${p.id}`)).toEqual(['node/1', 'node/2', 'way/4']);
    expect(pois.every((p) => p.distanceAlongTrail >= 0 && p.distanceFromTrail <= 2)).toBe(true);
    const camp = pois.find((p) => p.id === 2)!;
    const creek = trail.waypoints.find((w) => w.name === 'Creek camp')!;
    expect(camp.duplicateOf).toBe(creek.id);
    expect(camp.category).toBe('camping');
    // Slimmed as the app's bundled trails are: display tags only.
    const store = pois.find((p) => p.id === 4)!;
    expect(store.tags).toEqual({ shop: 'supermarket', opening_hours: '08:00-18:00' });
    expect(store.name).toBe('Corner Store');
    expect(store.lat).toBeCloseTo(start.lat + 0.15, 4);
    // The private copy is the same bytes; the one it replaced is gone.
    expect(await (await env.PHOTOS.get(after.private_key as string))!.text()).toBe(
      await (await env.PHOTOS.get(after.r2_key as string))!.text()
    );
    expect(await env.PHOTOS.get(before.private_key as string)).toBeNull();

    // The list carries the new md5, so phones download the new copy.
    const list = (await (await SELF.fetch(url('/v1/community/routes'))).json()) as {
      routes: { id: string; md5: string; trailUrl: string }[];
    };
    const listed = list.routes.find((r) => r.id === route.id)!;
    expect(listed.md5).toBe(after.md5);
    expect(keyOf(listed.trailUrl)).toBe(after.r2_key);

    // Done is done: the next run asks for nothing.
    const again = overpass([elementsResponse([])]);
    await run(again, {}, 3 * 60 * 60 * 1000);
    expect(again.calls).toHaveLength(0);
  });

  it('marks a route with no POIs done without rewriting it', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const before = await row(route.id);
    await run(overpass([elementsResponse([])]));
    const after = await row(route.id);
    expect(after.pois_status).toBe('done');
    expect(after.poi_count).toBe(0);
    expect(after.md5).toBe(before.md5);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('waits for a route that changed in the last two minutes', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const fetchImpl = overpass([elementsResponse([])]);
    await run(fetchImpl, {}, 0);
    expect(fetchImpl.calls).toHaveLength(0);
    expect((await row(route.id)).pois_status).toBe('pending');
  });

  it('does nothing when no Overpass endpoint is configured', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    // The test env sets OVERPASS_ENDPOINTS to ''.
    await enrichCommunityRoutePois(testEnv, { nowMs: Date.now() + 10 * 60 * 1000 });
    expect((await row(route.id)).pois_attempts).toBe(0);
    expect(parseOverpassEndpoints(' https://a.test/x , http://b.test/x, nonsense ,')).toEqual(['https://a.test/x']);
  });

  it('fails over to the next endpoint, and fails open when none answers', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    const before = await row(route.id);

    // Both down: nothing stored, the attempt counted, the route unchanged.
    const down = overpass([new Response('busy', { status: 504 })]);
    await run(down);
    expect(down.calls.map((c) => c.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);
    let r = await row(route.id);
    expect(r.pois_status).toBe('pending');
    expect(r.pois_attempts).toBe(1);
    expect(r.pois_error).toMatch(/HTTP 504/);
    expect(r.md5).toBe(before.md5);
    expect(r.updated_at).toBe(before.updated_at);

    // Not retried within the hour.
    const soon = overpass([elementsResponse([])]);
    await run(soon, {}, 30 * 60 * 1000);
    expect(soon.calls).toHaveLength(0);

    // An hour on, A is rate-limited and B answers.
    const failover = overpass([new Response('slow down', { status: 429 }), elementsResponse(elementsAlong(start))]);
    await run(failover, {}, 2 * 60 * 60 * 1000);
    expect(failover.calls.map((c) => c.endpoint)).toEqual([ENDPOINT_A, ENDPOINT_B]);
    r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(r.poi_count).toBe(3);
    expect(r.pois_error).toBeNull();
  });

  it('treats an Overpass runtime error as a failure, and gives up after the last attempt', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const timedOut = () =>
      new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }));
    for (let attempt = 1; attempt <= POI_RUN_LIMITS.maxAttempts; attempt++) {
      await run(overpass([timedOut]), {}, attempt * 2 * 60 * 60 * 1000);
      const r = await row(route.id);
      expect(r.pois_attempts).toBe(attempt);
      expect(r.pois_error).toMatch(/runtime error/);
      expect(r.pois_status).toBe(attempt < POI_RUN_LIMITS.maxAttempts ? 'pending' : 'failed');
    }
    const later = overpass([elementsResponse([])]);
    await run(later, {}, 20 * 60 * 60 * 1000);
    expect(later.calls).toHaveLength(0);
    expect((await storedTrail((await row(route.id)).r2_key as string)).pois).toBeUndefined();
  });

  it('skips a route that needs more queries than one route may make', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    // A zigzag the 500 m corridor simplification cannot thin: every point is a
    // corridor vertex, one more query's worth than a route may make.
    const trail = zigzagTrail(start, (POI_LIMITS.maxQueriesPerRoute + 1) * POI_LIMITS.maxVerticesPerQuery);
    const route = await submitAt(owner, start, trail);
    await onlyCandidate(route.id);
    const fetchImpl = overpass([elementsResponse([])]);
    await run(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(0);
    const r = await row(route.id);
    expect(r.pois_status).toBe('skipped');
    expect(r.pois_error).toBe('route_too_long');
    expect(r.pois_hash).toBe(r.content_hash);
   }, 60_000);

  it('skips a route whose answer is a city’s worth of POIs', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const huge = () =>
      new Response('{}', { headers: { 'Content-Length': String(POI_LIMITS.maxResponseBytes + 1) } });
    await run(overpass([huge]));
    const r = await row(route.id);
    expect(r.pois_status).toBe('skipped');
    expect(r.pois_error).toBe('too_many_pois');
  });

  it('stops at the run’s query budget', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const down = overpass([new Response('busy', { status: 503 })]);
    await run(down, {
      endpoints: Array.from({ length: POI_RUN_LIMITS.queries + 5 }, (_, i) => `https://o${i}.test/api/interpreter`),
    });
    expect(down.calls).toHaveLength(POI_RUN_LIMITS.queries);
    const r = await row(route.id);
    expect(r.pois_status).toBe('pending');
    expect(r.pois_error).toBe('run_budget');
  });

  it('keeps the POIs through an edit, a hide and restore, and a de-attribution', async () => {
    const owner = await registerDevice('Poi Walker');
    const admin = await registerDevice();
    await makeAdmin(admin.userId);
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    await run(overpass([elementsResponse(elementsAlong(start))]));
    const poisOf = async () => ((await storedTrail((await row(route.id)).r2_key as string)).pois ?? []).length;
    expect(await poisOf()).toBe(3);

    // Owner edit: republished from the private copy, POIs and all.
    const ctx = createExecutionContext();
    const res = await patchCommunityRoute(
      new Request(url(`/v1/community/routes/${route.id}`), {
        method: 'PATCH',
        headers: authHeaders(owner),
        body: JSON.stringify({ name: 'Ridge and river loop, renamed' }),
      }),
      testEnv,
      ctx,
      route.id
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await poisOf()).toBe(3);
    expect((await storedTrail((await row(route.id)).r2_key as string)).config.name).toBe('Ridge and river loop, renamed');

    // Hide, then restore: republished from the private copy.
    const status = (body: unknown) =>
      SELF.fetch(url(`/v1/admin/community/routes/${route.id}/status`), {
        method: 'POST',
        headers: authHeaders(admin),
        body: JSON.stringify(body),
      });
    expect((await status({ status: 'hidden' })).status).toBe(200);
    expect((await row(route.id)).r2_key).toBeNull();
    expect((await status({ status: 'unverified' })).status).toBe(200);
    expect(await poisOf()).toBe(3);

    // De-attribution rewrites the JSON without the name, keeping the POIs.
    expect((await deleteMe(owner)).status).toBe(204);
    for (let i = 0; i < 100 && (await row(route.id)).deattribute_pending !== 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const r = await row(route.id);
    const trail = await storedTrail(r.r2_key as string);
    expect(JSON.stringify(trail)).not.toContain('Poi Walker');
    expect(trail.pois).toHaveLength(3);
    // None of that asked Overpass again.
    expect(r.pois_status).toBe('done');
    expect(r.pois_hash).toBe(r.content_hash);
  });

  it('fetches again when the route’s geometry changes', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    await run(overpass([elementsResponse(elementsAlong(start))]));
    expect((await row(route.id)).pois_status).toBe('done');

    // What a geometry edit would leave: a new content hash.
    await env.DB.prepare(`UPDATE community_routes SET content_hash = ? WHERE id = ?`)
      .bind('f'.repeat(64), route.id)
      .run();
    const fetchImpl = overpass([elementsResponse(elementsAlong(start).slice(0, 1))]);
    await run(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(1);
    const r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(r.pois_attempts).toBe(1);
    expect(r.pois_hash).toBe('f'.repeat(64));
    expect(r.poi_count).toBe(1);
    expect((await storedTrail(r.r2_key as string)).pois).toHaveLength(1);
  });

  it('drops its objects when the route changes during the fetch', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    const before = await row(route.id);
    const racing = overpass([
      async () => {
        // An admin hides the route while Overpass is thinking.
        await env.DB.prepare(`UPDATE community_routes SET status = 'hidden', updated_at = ? WHERE id = ?`)
          .bind(new Date(Date.now() + 1000).toISOString(), route.id)
          .run();
        return elementsResponse(elementsAlong(start));
      },
    ]);
    await run(racing);
    const r = await row(route.id);
    expect(r.status).toBe('hidden');
    expect(r.pois_status).toBe('pending');
    expect(r.pois_error).toBe('route_changed');
    expect(r.private_key).toBe(before.private_key);
    const privates = (await env.PHOTOS.list({ prefix: `community/private/${route.id}/` })).objects.map((o) => o.key);
    expect(privates).toEqual([before.private_key]);
  });
});

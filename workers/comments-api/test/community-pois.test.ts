/**
 * Community routes: the scheduled OSM POI enrichment (`enrichCommunityRoutePois`,
 * `community-pois.ts`). Overpass is a mocked fetch throughout.
 */
import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { authHeaders, deleteMe, makeAdmin, registerDevice, url } from './helpers';
import type { Device } from './helpers';
import { makeTrail, submitBody, submitRoute } from './community-fixtures';
import {
  POI_CANDIDATES_SQL,
  POI_DATA_CREDIT,
  POI_RUN_LIMITS,
  enrichCommunityRoutePois,
  poiBackoffMs,
  patchCommunityRoute,
} from '../src/community';
import type { PoiEnrichDeps } from '../src/community';
import {
  POI_LIMITS,
  WORST_REQUEST_MS,
  fetchRoutePois,
  newOverpassBudget,
  parseOverpassEndpoints,
  planPoiQueries,
  readCapped,
  retryAfterMs,
} from '../src/community-pois';
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
    `UPDATE community_routes SET pois_status = 'done', pois_hash = content_hash, pois_due_at = NULL WHERE id != ?`
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

async function privateKeys(id: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix: `community/private/${id}/` })).objects.map((o) => o.key);
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
    // Nothing else is left under the private prefix: the cached answer went.
    expect(await privateKeys(route.id)).toEqual([after.private_key]);
    // The hiker's part is CC0; the POIs are credited to OpenStreetMap (ODbL).
    expect(trail.config.dataSource).toEqual({
      text: `Shared by Trail Angel under CC0. ${POI_DATA_CREDIT}`,
      url: 'https://www.openstreetmap.org/copyright',
      linkText: 'openstreetmap.org/copyright',
    });

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
    // An outage, not the route: the attempt is given back, the route backs off.
    expect(r.pois_attempts).toBe(0);
    expect(r.pois_failures).toBe(1);
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

  it('never uses up a route’s attempts in an outage, and backs off', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const timedOut = () =>
      new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }));
    // Ten failed runs, each as soon as the route is due again: a day-long outage and more.
    let ahead = 10 * 60 * 1000;
    const waits: number[] = [];
    for (let n = 1; n <= 10; n++) {
      const fetchImpl = overpass([n % 2 ? timedOut : new Response('down', { status: 502 })]);
      await run(fetchImpl, {}, ahead);
      expect(fetchImpl.calls.length).toBeGreaterThan(0);
      const r = await row(route.id);
      expect(r.pois_status).toBe('pending');
      expect(r.pois_attempts).toBe(0);
      expect(r.pois_failures).toBe(n);
      const wait = Date.parse(r.pois_due_at as string) - Date.parse(r.pois_attempted_at as string);
      expect(wait).toBe(poiBackoffMs(n));
      waits.push(wait);
      ahead = Date.parse(r.pois_due_at as string) - Date.now() + 60_000;
    }
    // 1 h, 2 h, 4 h, … capped at 2 days.
    expect(waits.slice(0, 3)).toEqual([1, 2, 4].map((h) => h * 60 * 60 * 1000));
    expect(waits[9]).toBe(POI_RUN_LIMITS.maxBackoffMs);
    // Overpass back: the route gets its POIs, and the back-off resets.
    await run(overpass([elementsResponse([])]), {}, ahead);
    const r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(r.pois_failures).toBe(0);
  });

  it('counts only a refusal of the route’s own query, and retries a failed route after two weeks', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    const refused = () => new Response('bad query', { status: 400 });
    let ahead = 10 * 60 * 1000;
    for (let attempt = 1; attempt <= POI_RUN_LIMITS.maxAttempts; attempt++) {
      await run(overpass([refused]), {}, ahead);
      const r = await row(route.id);
      expect(r.pois_error).toMatch(/HTTP 400/);
      if (attempt < POI_RUN_LIMITS.maxAttempts) {
        expect(r.pois_attempts).toBe(attempt);
        expect(r.pois_status).toBe('pending');
        ahead = Date.parse(r.pois_due_at as string) - Date.now() + 60_000;
      } else {
        expect(r.pois_status).toBe('failed');
        expect(r.pois_attempts).toBe(0);
        const wait = Date.parse(r.pois_due_at as string) - Date.parse(r.pois_attempted_at as string);
        expect(wait).toBe(POI_RUN_LIMITS.failedRetryAfterMs);
      }
    }
    // Shown without POIs meanwhile, and not asked about for two weeks.
    const later = overpass([elementsResponse([])]);
    await run(later, {}, ahead + 13 * 24 * 60 * 60 * 1000);
    expect(later.calls).toHaveLength(0);
    expect((await storedTrail((await row(route.id)).r2_key as string)).pois).toBeUndefined();
    // Then it is tried afresh, and recovers on its own.
    const fixed = overpass([elementsResponse(elementsAlong(start))]);
    await run(fixed, {}, ahead + 15 * 24 * 60 * 60 * 1000);
    expect(fixed.calls).toHaveLength(1);
    const r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(r.poi_count).toBe(3);
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
    // Overpass failed every one of them: the attempt counts.
    expect(r.pois_error).toMatch(/^run_budget: o0\.test: HTTP 503/);
    // An outage, not the route: the attempt is given back, the route backs off.
    expect(r.pois_attempts).toBe(0);
    expect(r.pois_failures).toBe(1);
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
    // The OpenStreetMap credit survives every rebuild of the config.
    expect(trail.config.dataSource?.text).toBe(`Shared by a Tracknotes user under CC0. ${POI_DATA_CREDIT}`);
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

    // What a geometry edit would have to do: a new content hash, due again.
    await env.DB.prepare(
      `UPDATE community_routes SET content_hash = ?, pois_due_at = '', pois_attempts = 0 WHERE id = ?`
    )
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
    // Not Overpass's failure: the attempt is given back.
    expect(r.pois_attempts).toBe(0);
    expect(r.private_key).toBe(before.private_key);
    const privates = (await env.PHOTOS.list({ prefix: `community/private/${route.id}/` })).objects.map((o) => o.key);
    // The answer stays cached for the next attempt; the run's trail JSON is gone.
    expect(privates.filter((k) => !k.includes('/overpass-'))).toEqual([before.private_key]);
    expect(privates.filter((k) => k.includes('/overpass-'))).toHaveLength(1);
  });
});


/** A clock the test moves: `now()` for the run's budget, `sleep` advances it. */
function fakeClock(start = Date.now()): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A zigzag route the corridor cannot thin: `groups` Overpass queries' worth. */
function routeOfQueries(start: { lat: number; lon: number }, groups: number): ProcessedTrail {
  return zigzagTrail(start, (groups - 1) * (POI_LIMITS.maxVerticesPerQuery - 1) + 50);
}

describe('POI enrichment: budgets, retries and leftovers', () => {
  it('fits the longest route into one run however slow each answer is', () => {
    expect(POI_LIMITS.maxQueriesPerRoute * WORST_REQUEST_MS).toBeLessThanOrEqual(POI_RUN_LIMITS.wallMs);
    expect(POI_LIMITS.maxQueriesPerRoute).toBeLessThanOrEqual(POI_RUN_LIMITS.queries);
  });

  it('gives the attempt back to a route the run has no time left for', async () => {
    const owner = await registerDevice();
    const first = freshStart();
    const a = await submitAt(owner, first);
    const second = freshStart();
    const b = await submitAt(owner, second, routeOfQueries(second, 3));
    await env.DB.prepare(
      `UPDATE community_routes SET pois_status = 'done', pois_hash = content_hash, pois_due_at = NULL WHERE id NOT IN (?, ?)`
    )
      .bind(a.id, b.id)
      .run();
    const clock = fakeClock();
    // The first route's one answer leaves time for two slow requests, not
    // the three the second route needs: it is claimed, then given back.
    const slow = overpass([
      () => {
        clock.advance(POI_RUN_LIMITS.wallMs - WORST_REQUEST_MS * 2.5);
        return elementsResponse(elementsAlong(first));
      },
    ]);
    await run(slow, { now: clock.now, sleep: clock.sleep });
    expect(slow.calls).toHaveLength(1);
    expect((await row(a.id)).pois_status).toBe('done');
    const rb = await row(b.id);
    expect(rb.pois_status).toBe('pending');
    expect(rb.pois_attempts).toBe(0);
    expect(rb.pois_error).toBe('run_budget');
    // Still at the head of the queue: the next run takes it at once.
    expect(rb.pois_due_at).toBe('');
    const next = overpass([elementsResponse([])]);
    await run(next);
    expect(next.calls).toHaveLength(3);
    expect((await row(b.id)).pois_status).toBe('done');
  }, 60_000);

  it('keeps the answers it got and asks only for the rest next time', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start, routeOfQueries(start, 3));
    await onlyCandidate(route.id);
    // Query 1 answers; query 2 fails on both instances.
    const flaky = overpass([
      elementsResponse(elementsAlong(start)),
      new Response('busy', { status: 504 }),
      new Response('busy', { status: 502 }),
    ]);
    await run(flaky);
    expect(flaky.calls).toHaveLength(3);
    let r = await row(route.id);
    expect(r.pois_status).toBe('pending');
    // An outage, not the route: the attempt is given back, the route backs off.
    expect(r.pois_attempts).toBe(0);
    expect(r.pois_failures).toBe(1);
    expect(r.pois_error).toMatch(/^overpass: overpass-a\.test: HTTP 504; overpass-b\.test: HTTP 502/);
    expect((await privateKeys(route.id)).filter((k) => k.includes('/overpass-'))).toHaveLength(1);

    const rest = overpass([elementsResponse([])]);
    // With the production grace: the answers are deleted by name, not swept by age.
    await run(rest, { purgeGraceMs: 10 * 60 * 1000 }, 2 * 60 * 60 * 1000);
    // Query 1 came from the cache.
    expect(rest.calls).toHaveLength(2);
    expect(rest.calls.map((c) => c.query)).not.toContain(flaky.calls[0].query);
    r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(r.poi_count).toBeGreaterThan(0);
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
  }, 60_000);

  it('waits out a short Retry-After, and leaves a long one for another run', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    const clock = fakeClock();
    const limited = overpass([
      new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
      elementsResponse(elementsAlong(start)),
    ]);
    await run(limited, { endpoints: [ENDPOINT_A], now: clock.now, sleep: clock.sleep });
    expect(limited.calls).toHaveLength(2);
    expect(clock.slept).toContain(7000);
    expect((await row(route.id)).pois_status).toBe('done');

    const other = await submitAt(owner, freshStart());
    await onlyCandidate(other.id);
    const clock2 = fakeClock();
    const hours = overpass([
      new Response('come back tomorrow', { status: 429, headers: { 'Retry-After': '3600' } }),
    ]);
    await run(hours, { endpoints: [ENDPOINT_A], now: clock2.now, sleep: clock2.sleep });
    expect(hours.calls).toHaveLength(1);
    expect(clock2.slept.every((ms) => ms <= POI_LIMITS.maxRetryAfterMs)).toBe(true);
    const r = await row(other.id);
    expect(r.pois_status).toBe('pending');
    expect(r.pois_error).toMatch(/^rate_limited: overpass-a\.test: HTTP 429/);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT'))).toBe(60_000);
    expect(retryAfterMs('soon', Date.now())).toBeNull();
  });

  it('stops reading an answer the moment it passes the byte cap', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk);
          },
        })
      );
    // Chunked (no Content-Length): only the counted bytes stop it.
    await expect(readCapped(endless(), 3 * chunk.byteLength)).rejects.toThrow('too_many_pois');
    expect(pulls).toBeLessThanOrEqual(6);

    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    pulls = 0;
    await run(overpass([endless]));
    const r = await row(route.id);
    expect(r.pois_status).toBe('skipped');
    expect(r.pois_error).toBe('too_many_pois');
    expect(pulls).toBeLessThanOrEqual(POI_LIMITS.maxResponseBytes / chunk.byteLength + 3);
    // Multi-byte text is counted in bytes, not characters.
    const text = 'é'.repeat(10);
    await expect(readCapped(new Response(text), 15)).rejects.toThrow('too_many_pois');
    expect(new TextDecoder().decode(await readCapped(new Response(text), 20))).toBe(text);
  });

  it('sweeps a trail JSON an interrupted run left behind once the route is answered', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start);
    await onlyCandidate(route.id);
    // What a run stopped between its R2 write and its D1 write leaves.
    const orphan = `community/private/${route.id}/${'ab'.repeat(16)}.json`;
    await env.PHOTOS.put(orphan, '{}');
    await env.DB.prepare(`UPDATE community_routes SET pois_attempts = 1 WHERE id = ?`).bind(route.id).run();
    await run(overpass([elementsResponse(elementsAlong(start))]));
    const r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(await env.PHOTOS.get(orphan)).toBeNull();
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
  });

  it('gives up, and sweeps, after the last attempt the platform cut short', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    const orphan = `community/private/${route.id}/${'cd'.repeat(16)}.json`;
    await env.PHOTOS.put(orphan, '{}');
    await env.DB.prepare(`UPDATE community_routes SET pois_attempts = ? WHERE id = ?`)
      .bind(POI_RUN_LIMITS.maxAttempts, route.id)
      .run();
    const fetchImpl = overpass([elementsResponse([])]);
    await run(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(0);
    const r = await row(route.id);
    expect(r.pois_status).toBe('failed');
    expect(r.pois_error).toBe('gave_up');
    // Recoverable: due again in two weeks, attempts reset.
    expect(r.pois_attempts).toBe(0);
    expect(Date.parse(r.pois_due_at as string) - Date.now()).toBeGreaterThan(POI_RUN_LIMITS.failedRetryAfterMs - 60_000);
    expect(await env.PHOTOS.get(orphan)).toBeNull();
  });

  it('leaves a route alone while its AI review is pending', async () => {
    const owner = await registerDevice();
    const route = await submitAt(owner, freshStart());
    await onlyCandidate(route.id);
    await env.DB.prepare(`UPDATE community_routes SET review_status = 'pending' WHERE id = ?`).bind(route.id).run();
    const fetchImpl = overpass([elementsResponse([])]);
    await run(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(0);
    expect((await row(route.id)).pois_attempts).toBe(0);
  });

  it('finds its candidates through the due index', async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${POI_CANDIDATES_SQL}`)
      .bind(new Date().toISOString(), new Date().toISOString(), 3)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join('\n');
    expect(plan).toContain('idx_community_routes_pois_due');
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('does nothing, without throwing, before migration 0009 is applied', async () => {
    const statement = {
      bind: () => statement,
      all: async () => {
        throw new Error('D1_ERROR: no such column: pois_due_at: SQLITE_ERROR');
      },
    };
    const brokenEnv = { ...testEnv, DB: { prepare: () => statement } } as unknown as Env;
    const fetchImpl = overpass([elementsResponse([])]);
    await expect(
      enrichCommunityRoutePois(brokenEnv, { endpoints: [ENDPOINT_A], fetchImpl, sleep: noSleep })
    ).resolves.toBeUndefined();
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('POI enrichment: second review', () => {
  it('keeps the cached answers through an owner’s edit', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start, routeOfQueries(start, 3));
    await onlyCandidate(route.id);
    const flaky = overpass([
      elementsResponse(elementsAlong(start)),
      new Response('busy', { status: 504 }),
      new Response('busy', { status: 502 }),
    ]);
    await run(flaky);
    const before = await row(route.id);

    // The edit rewrites the private copy (a new private key).
    const ctx = createExecutionContext();
    const res = await patchCommunityRoute(
      new Request(url(`/v1/community/routes/${route.id}`), {
        method: 'PATCH',
        headers: authHeaders(owner),
        body: JSON.stringify({ name: 'Zigzag, renamed' }),
      }),
      testEnv,
      ctx,
      route.id
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await row(route.id)).private_key).not.toBe(before.private_key);

    const rest = overpass([elementsResponse([])]);
    await run(rest, {}, 2 * 60 * 60 * 1000);
    expect(rest.calls).toHaveLength(2);
    expect(rest.calls.map((c) => c.query)).not.toContain(flaky.calls[0].query);
    const r = await row(route.id);
    expect(r.pois_status).toBe('done');
    expect(await privateKeys(route.id)).toEqual([r.private_key]);
  }, 60_000);

  it('stops, and leaves nothing behind, when the route is removed during the fetch', async () => {
    const owner = await registerDevice();
    const start = freshStart();
    const route = await submitAt(owner, start, routeOfQueries(start, 3));
    await onlyCandidate(route.id);
    const removing = overpass([
      async () => {
        // The owner deletes the route while Overpass answers: the row is
        // tombstoned and both prefixes purged, as removal does.
        const res = await SELF.fetch(url(`/v1/community/routes/${route.id}`), {
          method: 'DELETE',
          headers: authHeaders(owner),
        });
        expect(res.status).toBeLessThan(300);
        return elementsResponse(elementsAlong(start));
      },
    ]);
    await run(removing);
    // Nothing more was asked or written once the route was gone.
    expect(removing.calls).toHaveLength(1);
    const r = await row(route.id);
    expect(r.status).toBe('removed');
    expect(r.pois_error).toBe('route_removed');
    expect(await privateKeys(route.id)).toEqual([]);
  }, 60_000);

  it('parses each Overpass answer once', async () => {
    const start = freshStart();
    const trail = makeTrail({ start });
    const plan = planPoiQueries(trail);
    const text = JSON.stringify({ version: 0.6, elements: elementsAlong(start) });
    const fetchImpl = overpass([() => new Response(text)]);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const outcome = await fetchRoutePois(
        trail,
        plan,
        plan.queries.map((_, i) => `h${i}`),
        { get: async () => null, put: async () => true },
        newOverpassBudget(1, 5, Date.now() + POI_RUN_LIMITS.wallMs),
        { endpoints: [ENDPOINT_A], fetchImpl, sleep: noSleep }
      );
      expect(outcome.kind).toBe('ok');
      expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});

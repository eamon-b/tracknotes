/**
 * OSM POIs for a community route: the Overpass queries and the passes that
 * turn their answers into the `pois` array a curated trail ships. Nothing here
 * touches D1 or R2 (the answer cache is the caller's `PoiAnswerCache`);
 * `enrichCommunityRoutePois` in `community.ts` decides which route to enrich,
 * claims it, and republishes the result.
 *
 * Same corridor, same catalog, same km scale and the same passes as the build
 * (`scripts/fetch-pois.ts` → `scripts/build-trails.ts` → `build-mobile-trails`)
 * and the phone's search: `@lib/trail-poi-search` `planTrailPoiSearch` cuts the
 * route — main track, alternates and side trips — into 2 km corridor queries
 * (`@lib/poi-enrichment`, `@lib/osm-poi`, held to `gpx-tools` by
 * `scripts/osm-poi-parity.test.ts`), and `finishTrailPois` places the answers on
 * the trail's km (through the `createRouteIndex` grid), drops the noise, flags
 * duplicates of the route's own waypoints, thins cities and keeps the display
 * tags only. Only the HTTP part is the worker's own (`queryOnce`), because it
 * spends a per-run budget and streams answers under a byte cap. A community
 * route has no `TrailPoiConfig` (the client's `config` is rebuilt without
 * one), so only the rules every trail gets apply.
 *
 * Budgets: a run makes at most `budget.queriesLeft` Overpass requests
 * (external subrequests are capped per invocation) and starts none that could
 * outlast `budget.deadline`. Waiting on Overpass costs wall time, not CPU; the
 * CPU goes on parsing the stored trail and the answers, placing POIs and
 * re-encoding the trail — tens to hundreds of milliseconds on a long route,
 * far past Workers Free's 10 ms (`scripts/measure-community-poi-cpu.ts`).
 * Each answered query is cached (`PoiAnswerCache`), so an attempt that does
 * not finish leaves its progress for the next; but nothing is stored on the
 * route until every query has an answer.
 */

import {
  buildOverpassQuery,
  normalizeOverpassElements,
  osmElementKey,
  overpassPayloadError,
} from '../../../src/lib/osm-poi';
import type { OverpassElement, POI } from '../../../src/lib/osm-poi';
import { ALL_POI_TYPES, groupArea } from '../../../src/lib/poi-enrichment';
import { finishTrailPois, planTrailPoiSearch } from '../../../src/lib/trail-poi-search';
import type { TrailPoiSearchPlan } from '../../../src/lib/trail-poi-search';
import type { ProcessedTrail, TrailPOI } from '../../../src/lib/trail-types';

export const POI_LIMITS = {
  /** Corridor vertices per query: the build's default, under `CORRIDOR_LIMITS.maxVertices`. */
  maxVerticesPerQuery: 300,
  /**
   * A route needing more queries than this is skipped, never fetched in part:
   * 10 × 300 simplified vertices is roughly 3,000-6,000 km of trail (the
   * Heysen's 1,200 km take 2). Held so that a route's every query, each
   * taking as long as it may, fits one run's `POI_RUN_LIMITS.wallMs`.
   */
  maxQueriesPerRoute: 10,
  /** Overpass `[timeout:]`, s; the HTTP request is abandoned 5 s later. Under maps.mail.ru's ~60 s gateway. */
  queryTimeoutSeconds: 25,
  /** Pause between two requests: Overpass etiquette is a slow trickle from one address. */
  querySpacingMs: 1000,
  /** One answer larger than this (bytes as received) is a city's worth of POIs: the route is skipped. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Distinct POIs fetched for one route before the passes; more and the route is skipped. */
  maxFetchedPois: 12_000,
  /** POIs a route may ship after the passes; more and the route is skipped. */
  maxStoredPois: 4_000,
  /**
   * The longest `Retry-After` a run waits out, ms. A rate-limited instance
   * asking for longer is left alone for the rest of the run.
   */
  maxRetryAfterMs: 60_000,
} as const;

/** The most one Overpass request can take, spacing included, ms. */
export const WORST_REQUEST_MS = (POI_LIMITS.queryTimeoutSeconds + 5) * 1000 + POI_LIMITS.querySpacingMs;

/** What one scheduled run may spend on Overpass, shared by every route it enriches. */
export interface OverpassBudget {
  /** HTTP requests left this run. */
  queriesLeft: number;
  /** Every request must be able to finish by this (epoch ms). */
  deadline: number;
  /** The endpoint that answered last: tried first next time. */
  preferred: number;
  /** Per endpoint: not asked again before this (epoch ms), after a 429's `Retry-After`. */
  coolUntil: number[];
}

export function newOverpassBudget(endpoints: number, queries: number, deadline: number): OverpassBudget {
  return { queriesLeft: queries, deadline, preferred: 0, coolUntil: new Array<number>(endpoints).fill(0) };
}

export interface OverpassDeps {
  endpoints: readonly string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Answers already fetched for a route, keyed by a hash of the query (and so of
 * the geometry it covers): bytes exactly as Overpass sent them. Lets an
 * attempt that ran out of time or met a failure keep what it got.
 */
export interface PoiAnswerCache {
  get(queryHash: string): Promise<Uint8Array | null>;
  /**
   * Store one answer. False when the route is gone (removed meanwhile): the
   * attempt stops there, and nothing more is fetched or written for it.
   */
  put(queryHash: string, body: Uint8Array): Promise<boolean>;
}

const USER_AGENT = 'trail-maps-comments-api/1.0 (+https://github.com/eamon-b/trail-maps)';

/** The route as the build queries it, and the Overpass requests that takes. */
export interface PoiPlan extends TrailPoiSearchPlan {
  /** One Overpass QL query per corridor group. */
  queries: string[];
}

export function planPoiQueries(trail: ProcessedTrail): PoiPlan {
  const plan = planTrailPoiSearch(trail, {
    maxVerticesPerChunk: POI_LIMITS.maxVerticesPerQuery,
    timeoutSeconds: POI_LIMITS.queryTimeoutSeconds,
  });
  const queries = plan.corridor.groups.map((_, i) =>
    buildOverpassQuery(groupArea(plan.corridor, i), ALL_POI_TYPES, {
      timeoutSeconds: POI_LIMITS.queryTimeoutSeconds,
    })
  );
  return { ...plan, queries };
}

export type PoiOutcome =
  /** Every query answered: the route's POIs, slimmed and ready to store. */
  | { kind: 'ok'; pois: TrailPOI[] }
  /** Not worth retrying for this geometry (too long, a city's worth of POIs). */
  | { kind: 'skip'; reason: string }
  /**
   * Not finished: try again on a later run. `failure` says whose fault it was:
   * - `'route'`: an answer only this route's query gets — an HTTP 4xx other
   *   than 408/429 (Overpass refusing the query itself). Counts against the
   *   route's attempts.
   * - `'transient'`: Overpass being down or busy — a network error, a timeout,
   *   a 5xx, a 408 or 429, a `runtime error` remark, a page that is not JSON.
   *   Never counts (an outage must not use up a route's attempts), but backs
   *   the route off.
   * - `'none'`: nothing failed (the run's budget ran out, or the route was
   *   removed): the attempt is simply given back.
   */
  | { kind: 'fail'; reason: string; failure: PoiFailure };

export type PoiFailure = 'none' | 'transient' | 'route';

export class SkipRoute extends Error {}

/** An HTTP answer that refuses this route's query itself, not a busy or broken server. */
class RouteFault extends Error {}

/** Parse the configured endpoint list (`OVERPASS_ENDPOINTS`): comma-separated https URLs. */
export function parseOverpassEndpoints(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return new URL(s).protocol === 'https:';
      } catch {
        return false;
      }
    });
}

/**
 * A response body, read as it streams in and abandoned as soon as it passes
 * `maxBytes` (SkipRoute 'too_many_pois'). Counts bytes as received, after the
 * platform's decompression; a declared Content-Length over the cap is refused
 * before anything is read.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SkipRoute('too_many_pois');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkipRoute('too_many_pois');
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** An Overpass answer's POIs, or why it is not an answer. */
export function parseOverpassAnswer(body: Uint8Array): POI[] {
  let payload: unknown = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    payload = null;
  }
  const problem = overpassPayloadError(payload);
  if (problem) throw new Error(problem);
  return normalizeOverpassElements((payload as { elements: OverpassElement[] }).elements);
}

/** A 429 or 503's `Retry-After`, ms (delta-seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

class RateLimited extends Error {
  constructor(
    message: string,
    readonly waitMs: number
  ) {
    super(message);
  }
}

/** One request to one endpoint: the answer's bytes and its POIs (parsed once), or why not. Never retries. */
async function queryOnce(
  endpoint: string,
  query: string,
  deps: OverpassDeps,
  nowMs: number
): Promise<{ body: Uint8Array; pois: POI[] }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(endpoint, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout((POI_LIMITS.queryTimeoutSeconds + 5) * 1000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const wait =
      response.status === 429 || response.status === 503
        ? retryAfterMs(response.headers.get('Retry-After'), nowMs)
        : null;
    if (wait !== null) throw new RateLimited(`HTTP ${response.status}`, wait);
    const status = response.status;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      throw new RouteFault(`HTTP ${status}`);
    }
    throw new Error(`HTTP ${status}`);
  }
  const body = await readCapped(response, POI_LIMITS.maxResponseBytes);
  // A `runtime error` remark is a failure, not "nothing here".
  return { body, pois: parseOverpassAnswer(body) };
}

function hex(buffer: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The cache key of one query: sha256 of `salt` and the query text. The caller
 * salts with what stays put while the geometry does (the route's id and
 * `content_hash`), so an edit or a de-attribution, which rewrite the private
 * copy, keep the cached answers usable.
 */
export async function queryHash(salt: string, query: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${query}`))).slice(0, 40);
}

/**
 * Ask Overpass for every query of the plan not already in `cache`, each from
 * the first endpoint that answers it, caching each answer as it comes, and
 * build the route's POIs once all are in. Spends from `budget` as it goes.
 * `hashes[i]` is `queryHash` of `plan.queries[i]`.
 */
export async function fetchRoutePois(
  trail: ProcessedTrail,
  plan: PoiPlan,
  hashes: readonly string[],
  cache: PoiAnswerCache,
  budget: OverpassBudget,
  deps: OverpassDeps
): Promise<PoiOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoints = deps.endpoints;
  if (endpoints.length === 0) return { kind: 'fail', reason: 'no_endpoint', failure: 'none' };
  while (budget.coolUntil.length < endpoints.length) budget.coolUntil.push(0);

  const unique = new Map<string, POI>();
  const add = (pois: POI[]): boolean => {
    // Neighbouring queries overlap, so the same feature comes back twice.
    for (const poi of pois) {
      const key = osmElementKey(poi);
      if (!unique.has(key)) unique.set(key, poi);
    }
    return unique.size <= POI_LIMITS.maxFetchedPois;
  };

  let failure: PoiFailure = 'none';
  const errors: string[] = [];
  const stop = (reason: string): PoiOutcome => ({
    kind: 'fail',
    reason: (errors.length > 0 ? `${reason}: ${errors.join('; ')}` : reason).slice(0, 500),
    failure,
  });

  try {
    // Cached answers first: they cost no request, and may already be too many.
    const missing: number[] = [];
    for (let g = 0; g < plan.queries.length; g++) {
      const cached = await cache.get(hashes[g]);
      let pois: POI[] | null = null;
      if (cached) {
        try {
          pois = parseOverpassAnswer(cached);
        } catch {
          pois = null; // unreadable: ask again
        }
      }
      if (pois === null) missing.push(g);
      else if (!add(pois)) return { kind: 'skip', reason: 'too_many_pois' };
    }

    let first = true;
    for (let m = 0; m < missing.length; m++) {
      const g = missing[m];
      /** Instances that failed this query (a rate limit is not a failure: it is waited out). */
      const tried = new Set<number>();
      let answer: { body: Uint8Array; pois: POI[] } | null = null;
      while (answer === null) {
        // Every request left for this route, each as slow as it may be, must
        // fit: otherwise stop now rather than leave a hole at the deadline.
        const left = missing.length - m;
        if (budget.queriesLeft <= 0 || now() + WORST_REQUEST_MS * left > budget.deadline) {
          return stop('run_budget');
        }
        const untried: number[] = [];
        for (let k = 0; k < endpoints.length; k++) {
          const i = (budget.preferred + k) % endpoints.length;
          if (!tried.has(i)) untried.push(i);
        }
        if (untried.length === 0) return stop('overpass');
        const t = now();
        const index = untried.find((i) => budget.coolUntil[i] <= t);
        if (index === undefined) {
          // Every instance left asked us to wait: wait for the first one free,
          // if that still leaves time for the rest of the route.
          const until = Math.min(...untried.map((i) => budget.coolUntil[i]));
          if (until - t > POI_LIMITS.maxRetryAfterMs || until + WORST_REQUEST_MS * left > budget.deadline) {
            return stop('rate_limited');
          }
          await sleep(until - t);
          continue;
        }
        if (!first) await sleep(POI_LIMITS.querySpacingMs);
        first = false;
        budget.queriesLeft--;
        try {
          answer = await queryOnce(endpoints[index], plan.queries[g], deps, now());
          budget.preferred = index;
        } catch (err) {
          if (err instanceof SkipRoute) throw err;
          if (err instanceof RouteFault) failure = 'route';
          else if (failure === 'none') failure = 'transient';
          errors.push(`${new URL(endpoints[index]).host}: ${err instanceof Error ? err.message : String(err)}`);
          if (err instanceof RateLimited) {
            // Honoured up to the cap; past it, the instance sits out the run.
            budget.coolUntil[index] =
              err.waitMs > POI_LIMITS.maxRetryAfterMs ? Number.POSITIVE_INFINITY : now() + err.waitMs;
          } else {
            tried.add(index);
          }
        }
      }
      let kept = true;
      try {
        kept = await cache.put(hashes[g], answer.body);
      } catch {
        /* best-effort: an uncached answer is only asked for again */
      }
      if (!kept) return { kind: 'fail', reason: 'route_removed', failure: 'none' };
      if (!add(answer.pois)) return { kind: 'skip', reason: 'too_many_pois' };
    }
  } catch (err) {
    if (err instanceof SkipRoute) return { kind: 'skip', reason: err.message };
    throw err;
  }

  return finishRoutePois(trail, plan, [...unique.values()]);
}

/** The CPU-bound end of `fetchRoutePois`: answers in, the route's POIs out. */
export async function finishRoutePois(trail: ProcessedTrail, plan: PoiPlan, fetched: POI[]): Promise<PoiOutcome> {
  const pois = await finishTrailPois(plan, fetched, trail, { indexed: true });
  if (pois.length > POI_LIMITS.maxStoredPois) return { kind: 'skip', reason: 'too_many_pois' };
  return { kind: 'ok', pois };
}

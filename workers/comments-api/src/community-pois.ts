/**
 * OSM POIs for a community route: the Overpass queries and the passes that
 * turn their answers into the `pois` array a curated trail ships. Nothing here
 * touches D1 or R2; `enrichCommunityRoutePois` in `community.ts` decides which
 * route to enrich, claims it, and republishes the result.
 *
 * Same corridor, same catalog, same km scale and the same passes as the build
 * (`scripts/fetch-pois.ts` → `scripts/build-trails.ts` → `build-mobile-trails`)
 * and the phone's search: `@lib/trail-poi-search` `planTrailPoiSearch` cuts the
 * route — main track, alternates and side trips — into 2 km corridor queries
 * (`@lib/poi-enrichment`, `@lib/osm-poi`, held to `gpx-tools` by
 * `scripts/osm-poi-parity.test.ts`), and `finishTrailPois` places the answers on
 * the trail's km, drops the noise, flags duplicates of the route's own
 * waypoints, thins cities and keeps the display tags only. Only the HTTP part
 * is the worker's own (`queryOnce`), because it spends a per-run budget. A
 * community route has no `TrailPoiConfig` (the client's `config` is rebuilt
 * without one), so only the rules every trail gets apply.
 *
 * Workers Free budgets this: a run makes at most `budget.queriesLeft` Overpass
 * requests (external subrequests are capped per invocation) and starts none
 * after `budget.deadline`. Waiting on Overpass costs wall time, not CPU; the
 * CPU goes on parsing answers and placing POIs, which is linear in the POIs
 * (a grid finds each one's nearest segment) and capped by `POI_LIMITS`.
 * Partial answers are never stored: a route whose every query did not succeed
 * is a failed attempt, retried on a later run, and shown without POIs
 * meanwhile.
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
   * 16 × 300 simplified vertices is roughly 2,500-5,000 km of trail.
   */
  maxQueriesPerRoute: 16,
  /** Overpass `[timeout:]`, s; the HTTP request is abandoned 5 s later. Under maps.mail.ru's ~60 s gateway. */
  queryTimeoutSeconds: 25,
  /** Pause between two requests: Overpass etiquette is a slow trickle from one address. */
  querySpacingMs: 1000,
  /** One answer larger than this is a city's worth of POIs: the route is skipped. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Distinct POIs fetched for one route before the passes; more and the route is skipped. */
  maxFetchedPois: 12_000,
  /** POIs a route may ship after the passes; more and the route is skipped. */
  maxStoredPois: 4_000,
} as const;

/** What one scheduled run may spend on Overpass, shared by every route it enriches. */
export interface OverpassBudget {
  /** HTTP requests left this run. */
  queriesLeft: number;
  /** No request starts after this (epoch ms). */
  deadline: number;
  /** The endpoint that answered last: tried first next time. */
  preferred: number;
}

export interface OverpassDeps {
  endpoints: readonly string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const USER_AGENT = 'trail-maps-comments-api/1.0 (+https://github.com/eamon-b/trail-maps)';

/** The route as the build queries it, and the Overpass requests that takes. */
export type PoiPlan = TrailPoiSearchPlan;

export function planPoiQueries(trail: ProcessedTrail): PoiPlan {
  return planTrailPoiSearch(trail, {
    maxVerticesPerChunk: POI_LIMITS.maxVerticesPerQuery,
    timeoutSeconds: POI_LIMITS.queryTimeoutSeconds,
  });
}

export type PoiOutcome =
  /** Every query answered: the route's POIs, slimmed and ready to store. */
  | { kind: 'ok'; pois: TrailPOI[] }
  /** Not worth retrying for this geometry (too long, a city's worth of POIs). */
  | { kind: 'skip'; reason: string }
  /** A query failed or the run's budget ran out: try again on a later run. */
  | { kind: 'fail'; reason: string };

class SkipRoute extends Error {}

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

/** One request to one endpoint: its POIs, or why not. Never retries. */
async function queryOnce(endpoint: string, query: string, deps: OverpassDeps): Promise<POI[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(endpoint, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout((POI_LIMITS.queryTimeoutSeconds + 5) * 1000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(declared) && declared > POI_LIMITS.maxResponseBytes) {
    await response.body?.cancel();
    throw new SkipRoute('too_many_pois');
  }
  const text = await response.text();
  if (text.length > POI_LIMITS.maxResponseBytes) throw new SkipRoute('too_many_pois');
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const problem = overpassPayloadError(payload);
  if (problem) throw new Error(problem);
  return normalizeOverpassElements((payload as { elements: OverpassElement[] }).elements);
}

/**
 * Ask Overpass for every query of the plan, each from the first endpoint that
 * answers it, and build the route's POIs from the answers. Spends from
 * `budget` as it goes.
 */
export async function fetchRoutePois(
  trail: ProcessedTrail,
  plan: PoiPlan,
  budget: OverpassBudget,
  deps: OverpassDeps
): Promise<PoiOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestMs = (POI_LIMITS.queryTimeoutSeconds + 5) * 1000;
  const endpoints = deps.endpoints;
  if (endpoints.length === 0) return { kind: 'fail', reason: 'no_endpoint' };

  const unique = new Map<string, POI>();
  let first = true;
  try {
    for (let g = 0; g < plan.corridor.groups.length; g++) {
      const query = buildOverpassQuery(groupArea(plan.corridor, g), ALL_POI_TYPES, {
        timeoutSeconds: POI_LIMITS.queryTimeoutSeconds,
      });
      let answer: POI[] | null = null;
      const errors: string[] = [];
      for (let k = 0; k < endpoints.length && answer === null; k++) {
        if (budget.queriesLeft <= 0 || now() + requestMs > budget.deadline) {
          return { kind: 'fail', reason: 'run_budget' };
        }
        if (!first) await sleep(POI_LIMITS.querySpacingMs);
        first = false;
        const index = (budget.preferred + k) % endpoints.length;
        budget.queriesLeft--;
        try {
          answer = await queryOnce(endpoints[index], query, deps);
          budget.preferred = index;
        } catch (err) {
          if (err instanceof SkipRoute) throw err;
          errors.push(`${new URL(endpoints[index]).host}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (answer === null) return { kind: 'fail', reason: `overpass: ${errors.join('; ')}`.slice(0, 500) };
      // Neighbouring queries overlap, so the same feature comes back twice.
      for (const poi of answer) {
        const key = osmElementKey(poi);
        if (!unique.has(key)) unique.set(key, poi);
      }
      if (unique.size > POI_LIMITS.maxFetchedPois) return { kind: 'skip', reason: 'too_many_pois' };
    }
  } catch (err) {
    if (err instanceof SkipRoute) return { kind: 'skip', reason: err.message };
    throw err;
  }

  const pois = await finishTrailPois(plan, [...unique.values()], trail);
  if (pois.length > POI_LIMITS.maxStoredPois) return { kind: 'skip', reason: 'too_many_pois' };
  return { kind: 'ok', pois };
}

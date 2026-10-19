/**
 * Searching OpenStreetMap for the points of interest along a whole trail, and
 * turning the answer into the `pois` array a trail ships with.
 *
 * Two halves, both platform-neutral:
 *
 * - **Planning** (`planTrailPoiSearch`): the route the build searches
 *   (`buildRouteScale` — main track, alternates, side trips), cut into the same
 *   corridor queries (`@lib/poi-enrichment` `prepareCorridor`), plus an
 *   estimate of what the search will cost in requests and data, so the person
 *   asking can decide before anything is sent.
 * - **Finishing** (`finishTrailPois`): the same passes `scripts/build-trails.ts`
 *   runs between `pois.json` and a shipped trail — noise (`@lib/poi-noise`),
 *   duplicates of the trail's own waypoints flagged (`@lib/poi-dedup`), city
 *   stretches thinned (`@lib/poi-urban`) — in the build's order, then the
 *   phone's `slimPoi`. A GPX imported on the phone therefore ends up with the
 *   POIs the build would have given it.
 *
 * The fetching itself is the caller's (`@lib/poi-enrichment`
 * `fetchCorridorGroups` with a fetcher from `@lib/overpass-client`), so the
 * caller owns cancellation, retries of failed groups and progress.
 */

import { dedupCandidates, markDuplicatePois, type DedupTrailLike } from './poi-dedup';
import { slimPoi } from './poi-display';
import { dropNoisePois } from './poi-noise';
import { thinUrbanPois } from './poi-urban';
import { buildOverpassQuery } from './osm-poi';
import {
  ALL_POI_TYPES,
  groupArea,
  placePois,
  prepareCorridor,
  type PreparedCorridor,
} from './poi-enrichment';
import type { POI } from './osm-poi';
import { buildRouteScale, toTrailPOIs, type RouteScale } from './trail-pois';
import type { ProcessedTrail, TrailPOI, TrailPoiConfig } from './trail-types';

/** POIs within this distance of the trail are kept — the build's radius. */
export const POI_SEARCH_RADIUS_KM = 2;

/**
 * Public Overpass instances an interactive search tries, in order, query by
 * query (`createFallbackFetcher`). The main instance first; the others are the
 * mirrors `docs/architecture/build-scripts.md` records answering when it did
 * not. `maps.mail.ru` is deliberately absent: it also answers, but this list
 * decides where a hiker's route outline is sent without them choosing it.
 */
export const INTERACTIVE_OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Corridor vertices per query for an interactive search. Smaller than the
 * build's 300: a phone waits on each query with a short timeout, and a mirror
 * refuses expensive queries long before cheap ones (see `fetch-pois.ts`).
 */
export const INTERACTIVE_MAX_VERTICES = 150;

/** Overpass `[timeout:]` for an interactive search, seconds. */
export const INTERACTIVE_TIMEOUT_SECONDS = 25;

/**
 * Bytes of Overpass JSON per km of route, measured on the bundled trails'
 * `pois.json` (2026-10): ~100-400 B/km on remote trails, ~2-10 KB/km where a
 * route runs through towns (Great North Walk, Shikoku). Doubled for the
 * padded query radius and the elements the passes drop. Uncompressed: the
 * transfer is usually smaller, since the platform asks for gzip.
 */
const DOWNLOAD_BYTES_PER_KM_LOW = 500;
const DOWNLOAD_BYTES_PER_KM_HIGH = 15_000;

export interface PoiSearchEstimate {
  /** Overpass queries the corridor is cut into. */
  queries: number;
  /** Route searched, km: main track plus every alternate and side trip. */
  routeKm: number;
  /** What the queries themselves send, bytes (form-encoded query text). */
  uploadBytes: number;
  /** Expected download range, bytes: a remote trail at the low end, towns at the high. */
  downloadBytesLow: number;
  downloadBytesHigh: number;
}

export interface TrailPoiSearchPlan {
  scale: RouteScale;
  corridor: PreparedCorridor;
  estimate: PoiSearchEstimate;
}

export interface PlanOptions {
  maxVerticesPerChunk?: number;
  timeoutSeconds?: number;
}

/**
 * Cut a trail's route into the queries a search would send, and say what that
 * costs. Makes no request. A trail with no usable points plans zero queries.
 */
export function planTrailPoiSearch(
  trail: Pick<ProcessedTrail, 'track' | 'alternates' | 'sideTrips'>,
  options: PlanOptions = {}
): TrailPoiSearchPlan {
  const scale = buildRouteScale(trail);
  const corridor = prepareCorridor(scale.polylines, {
    searchRadiusKm: POI_SEARCH_RADIUS_KM,
    maxVerticesPerChunk: options.maxVerticesPerChunk ?? INTERACTIVE_MAX_VERTICES,
  });
  const cumulative = corridor.geometry.cumulativeKm;
  const routeKm = cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0;
  let uploadBytes = 0;
  for (let i = 0; i < corridor.groups.length; i++) {
    const query = buildOverpassQuery(groupArea(corridor, i), ALL_POI_TYPES, {
      timeoutSeconds: options.timeoutSeconds ?? INTERACTIVE_TIMEOUT_SECONDS,
    });
    uploadBytes += `data=${encodeURIComponent(query)}`.length;
  }
  return {
    scale,
    corridor,
    estimate: {
      queries: corridor.groups.length,
      routeKm,
      uploadBytes,
      downloadBytesLow: Math.round(routeKm * DOWNLOAD_BYTES_PER_KM_LOW),
      downloadBytesHigh: Math.round(routeKm * DOWNLOAD_BYTES_PER_KM_HIGH),
    },
  };
}

/** "320 KB", "4.1 MB": a byte count for the estimate and the result line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** The trail as `finishTrailPois` reads it: its route, its waypoints, its POI rules. */
export type FinishableTrail = Pick<ProcessedTrail, 'track' | 'alternates' | 'sideTrips'> &
  DedupTrailLike & { config: { pois?: TrailPoiConfig } };

export interface FinishOptions {
  signal?: AbortSignal;
  /** Awaited between slices of work, so a UI thread can breathe. */
  pause?: () => Promise<void>;
  /** Place through a grid (`PlaceOptions.indexed`): the same POIs, linear in their number. */
  indexed?: boolean;
}

function abortError(): Error {
  const error = new Error('Search cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Turn fetched OSM elements into a trail's shipped `pois`: placed on the
 * trail's own km scale, then the build's passes in the build's order (noise →
 * duplicates → city thinning, see `scripts/build-trails.ts`), then slimmed.
 * Sorted by km. Never returns `undefined`: a search that found nothing is `[]`,
 * which is "searched, nothing here" — unlike an absent `pois`.
 */
export async function finishTrailPois(
  plan: TrailPoiSearchPlan,
  fetched: readonly POI[],
  trail: FinishableTrail,
  options: FinishOptions = {}
): Promise<TrailPOI[]> {
  const { signal, pause, indexed } = options;
  const step = async (): Promise<void> => {
    if (pause) await pause();
    if (signal?.aborted) throw abortError();
  };

  const enriched = await placePois(plan.corridor, fetched, {
    types: ALL_POI_TYPES,
    signal,
    pause,
    indexed,
  });
  await step();
  const placed = toTrailPOIs(enriched, plan.scale);
  await step();
  const config = trail.config.pois;
  const kept = dropNoisePois(placed, config) ?? [];
  await step();
  const marked = markDuplicatePois(kept, dedupCandidates(trail)) ?? [];
  await step();
  const thinned = thinUrbanPois(marked, config) ?? [];
  await step();
  return thinned.map(slimPoi);
}

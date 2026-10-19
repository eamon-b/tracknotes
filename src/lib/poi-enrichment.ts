/**
 * POI enrichment: fetch the OpenStreetMap POIs within a search radius of a
 * route and annotate each with where along the route it is.
 *
 * Ported from `gpx-tools/lib/poi-enrichment` (see `./osm-poi` for why). The
 * one entry point there, `enrichRoute`, is kept with the same behaviour, and is
 * also split into its three steps — prepare the corridor, fetch its query
 * groups, place what came back — so the phone can run the steps itself: retry
 * just the groups that failed, and hand the UI thread back between slices of
 * the placement (`PlaceOptions.pause`) on a 100,000-point import.
 */

import {
  CORRIDOR_LIMITS,
  POI_TYPES,
  buildCorridorChunks,
  buildRouteGeometry,
  categorizePOI,
  createRouteIndex,
  nearestPointOnRoute,
  osmElementKey,
  packCorridorChunks,
  type LatLon,
  type OverpassArea,
  type POI,
  type POIType,
  type RouteGeometry,
} from './osm-poi';
import type { POIFetcher } from './overpass-client';

export type { LatLon, POI, POIType };

export interface EnrichmentOptions {
  types: POIType[];
  /** POIs within this distance of the route are returned. Default 2 km. */
  searchRadiusKm?: number;
  /** Where POIs come from (`createOverpassFetcher`, or a test double). */
  fetchPOIs: POIFetcher;
  /** Cancellation. `enrichRoute` rejects with an Error named 'AbortError'. */
  signal?: AbortSignal;
  /** Max corridor vertices per Overpass query. Default 300. */
  maxVerticesPerChunk?: number;
}

export type EnrichmentStage = 'prepare' | 'fetch' | 'process' | 'done';

export interface EnrichmentProgress {
  stage: EnrichmentStage;
  /** 1-based position within the stage, when the stage has discrete steps. */
  current?: number;
  total?: number;
  message: string;
}

export interface EnrichedPOI extends POI {
  category: POIType;
  /** Cross-track distance from the route, km. */
  distanceFromRoute: number;
  /** Distance along the route at the closest point, km. */
  distanceAlongRoute: number;
  /** Nearer endpoint of the closest segment, indexing the flattened route. */
  nearestPointIndex: number;
  /** Index of the closest segment (segmentIndex, segmentIndex + 1). */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
}

export interface ChunkFailure {
  chunkIndex: number;
  error: string;
}

export interface EnrichmentResult {
  pois: EnrichedPOI[];
  /** Queries that failed to fetch. Empty when everything succeeded. */
  failedChunks: ChunkFailure[];
  stats: {
    totalFound: number;
    /** Number of Overpass queries issued (corridor groups, not polylines). */
    queryChunks: number;
    failedChunks: number;
    queryTimeMs: number;
  };
}

const DEFAULT_SEARCH_RADIUS_KM = 2;

/**
 * Corridor simplification (Douglas-Peucker at radius/4) can shift the queried
 * polyline off the real track by up to a quarter of the radius, so the
 * `around:` radius is padded; the exact filter runs on the real route after.
 */
const QUERY_RADIUS_MARGIN = 1.25;

/** Largest search radius that can be queried with the margin intact (8 km). */
export const MAX_SEARCH_RADIUS_KM = CORRIDOR_LIMITS.maxRadiusMeters / QUERY_RADIUS_MARGIN / 1000;

/** Smallest usable search radius. */
const MIN_SEARCH_RADIUS_KM = 0.01;

function abortError(): Error {
  const error = new Error('Enrichment aborted');
  error.name = 'AbortError';
  return error;
}

/** A route's corridor, cut into the queries that will be sent. */
export interface PreparedCorridor {
  geometry: RouteGeometry;
  /** One entry per Overpass query: the polylines it carries. */
  groups: LatLon[][][];
  /** The clamped search radius results are filtered to, km. */
  searchRadiusKm: number;
  /** The padded `around:` radius the queries use, metres. */
  queryRadiusMeters: number;
}

/** Clamp the requested radius exactly as `enrichRoute` always has. */
function resolveSearchRadiusKm(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(requested, MIN_SEARCH_RADIUS_KM), MAX_SEARCH_RADIUS_KM)
    : DEFAULT_SEARCH_RADIUS_KM;
}

/**
 * Step 1: the route's geometry and its query groups. Chunking splits long
 * corridors; packing merges short ones (side trips) back into shared queries.
 */
export function prepareCorridor(
  route: LatLon[] | LatLon[][],
  options: { searchRadiusKm?: number; maxVerticesPerChunk?: number } = {}
): PreparedCorridor {
  const searchRadiusKm = resolveSearchRadiusKm(options.searchRadiusKm);
  const maxVertices = options.maxVerticesPerChunk ?? 300;
  const corridorRadiusMeters = Math.min(searchRadiusKm * 1000, CORRIDOR_LIMITS.maxRadiusMeters);
  const queryRadiusMeters = Math.min(
    Math.round(corridorRadiusMeters * QUERY_RADIUS_MARGIN),
    CORRIDOR_LIMITS.maxRadiusMeters
  );
  const geometry = buildRouteGeometry(route);
  const groups = packCorridorChunks(
    buildCorridorChunks(route, corridorRadiusMeters, maxVertices),
    maxVertices
  );
  return { geometry, groups, searchRadiusKm, queryRadiusMeters };
}

/** The Overpass area one query group asks for. */
export function groupArea(corridor: PreparedCorridor, index: number): OverpassArea {
  const group = corridor.groups[index];
  return {
    // Keep a single polyline flat: the shape gpx-tools' proxy caches by.
    corridor: group.length === 1 ? group[0] : group,
    radiusMeters: corridor.queryRadiusMeters,
  };
}

export interface FetchGroupsOptions {
  types: POIType[];
  fetchPOIs: POIFetcher;
  signal?: AbortSignal;
  /** Only these group indices (a retry of the ones that failed). Default: all. */
  only?: readonly number[];
  onProgress?: (progress: EnrichmentProgress) => void;
}

export interface FetchGroupsResult {
  /** Unique elements, first answer wins, in the order they arrived. */
  pois: POI[];
  failedChunks: ChunkFailure[];
}

/**
 * Step 2: send the queries one after another (Overpass grants a couple of
 * slots per IP; parallel queries mostly earn 429s). A query that fails is
 * recorded and skipped. Only the caller's own signal means cancellation — an
 * error merely *named* AbortError (a per-request timeout) is a failed chunk.
 */
export async function fetchCorridorGroups(
  corridor: PreparedCorridor,
  options: FetchGroupsOptions
): Promise<FetchGroupsResult> {
  const { signal, onProgress } = options;
  const indices = options.only ? [...options.only] : corridor.groups.map((_, i) => i);
  const failedChunks: ChunkFailure[] = [];
  const unique = new Map<string, POI>();

  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (signal?.aborted) {
      throw abortError();
    }
    onProgress?.({
      stage: 'fetch',
      current: k + 1,
      total: indices.length,
      message: `Fetching POIs (area ${k + 1} of ${indices.length})...`,
    });
    try {
      const chunkPOIs = await options.fetchPOIs(groupArea(corridor, i), options.types, signal);
      // Chunks overlap, so the same feature routinely comes back twice.
      for (const poi of chunkPOIs) {
        const key = osmElementKey(poi);
        if (!unique.has(key)) {
          unique.set(key, poi);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw abortError();
      }
      failedChunks.push({
        chunkIndex: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { pois: [...unique.values()], failedChunks };
}

export interface PlaceOptions {
  types: POIType[];
  signal?: AbortSignal;
  /**
   * Awaited after every `pauseEvery` POIs: on the phone, a promise that
   * resolves on the next tick, so the UI thread can draw and take a Cancel
   * tap mid-placement. Absent, the loop never awaits anything.
   */
  pause?: () => Promise<void>;
  /** Default 200. */
  pauseEvery?: number;
  /**
   * Find each element's nearest segment through a grid (`createRouteIndex`)
   * instead of measuring it against the whole route: the same placements, at
   * a cost that does not grow with the route's length. Off by default, which
   * keeps `enrichRoute` gpx-tools' code path; the comments API's
   * community-route enrichment turns it on.
   */
  indexed?: boolean;
}

/**
 * Step 3: measure every fetched element against the route, keep those within
 * the search radius whose tags classify as a requested type, and sort them by
 * distance along the route.
 */
export async function placePois(
  corridor: PreparedCorridor,
  fetched: readonly POI[],
  options: PlaceOptions
): Promise<EnrichedPOI[]> {
  const { signal, pause } = options;
  const every = Math.max(1, options.pauseEvery ?? 200);
  const pois: EnrichedPOI[] = [];
  const nearest = options.indexed
    ? createRouteIndex(corridor.geometry, corridor.searchRadiusKm)
    : (poi: LatLon) => nearestPointOnRoute(poi, corridor.geometry);
  for (let n = 0; n < fetched.length; n++) {
    if (pause && n > 0 && n % every === 0) {
      await pause();
    }
    if (signal?.aborted) {
      throw abortError();
    }
    const poi = fetched[n];
    const proximity = nearest(poi);
    if (!proximity || !(proximity.distanceKm <= corridor.searchRadiusKm)) {
      continue;
    }
    // Whatever a requested selector matched is classified as that type.
    const category = categorizePOI(poi.tags, options.types);
    if (!category || !options.types.includes(category)) {
      continue;
    }
    pois.push({
      ...poi,
      category,
      distanceFromRoute: proximity.distanceKm,
      distanceAlongRoute: proximity.distanceAlongRouteKm,
      nearestPointIndex: proximity.nearestPointIndex,
      segmentIndex: proximity.segmentIndex,
      t: proximity.t,
    });
  }
  pois.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
  return pois;
}

/**
 * Enrich a route with POIs from OpenStreetMap: the three steps above in one
 * call. Only an every-query failure throws; partial failures are reported in
 * `failedChunks` with the rest of the results kept.
 */
export async function enrichRoute(
  route: LatLon[] | LatLon[][],
  options: EnrichmentOptions,
  onProgress?: (progress: EnrichmentProgress) => void
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const { signal } = options;
  if (signal?.aborted) {
    throw abortError();
  }
  onProgress?.({ stage: 'prepare', message: 'Preparing route corridor...' });

  const corridor = prepareCorridor(route, {
    searchRadiusKm: options.searchRadiusKm,
    maxVerticesPerChunk: options.maxVerticesPerChunk,
  });
  const queryChunks = corridor.groups.length;

  if (queryChunks === 0) {
    onProgress?.({ stage: 'done', message: 'Route has no usable points' });
    return {
      pois: [],
      failedChunks: [],
      stats: { totalFound: 0, queryChunks: 0, failedChunks: 0, queryTimeMs: Date.now() - startTime },
    };
  }

  const fetched = await fetchCorridorGroups(corridor, {
    types: options.types,
    fetchPOIs: options.fetchPOIs,
    signal,
    onProgress,
  });

  if (fetched.failedChunks.length === queryChunks) {
    const reasons = [...new Set(fetched.failedChunks.map(f => f.error))];
    throw new Error(
      `Failed to fetch POIs for all ${queryChunks} area${queryChunks === 1 ? '' : 's'}: ${reasons.join('; ')}`
    );
  }

  if (signal?.aborted) {
    throw abortError();
  }
  onProgress?.({
    stage: 'process',
    current: 0,
    total: fetched.pois.length,
    message: `Processing ${fetched.pois.length} POIs...`,
  });

  const pois = await placePois(corridor, fetched.pois, { types: options.types, signal });

  onProgress?.({ stage: 'done', message: `Found ${pois.length} POIs along route` });

  return {
    pois,
    failedChunks: fetched.failedChunks,
    stats: {
      totalFound: pois.length,
      queryChunks,
      failedChunks: fetched.failedChunks.length,
      queryTimeMs: Date.now() - startTime,
    },
  };
}

/** Every POI type, in catalog order: what the build and the phone both ask for. */
export const ALL_POI_TYPES: POIType[] = [...POI_TYPES];

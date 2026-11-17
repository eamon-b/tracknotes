/**
 * The elevation of a position, for the `<ele>` of a `<wpt>` the waypoint
 * editor adds or moves.
 *
 * The build never reads a `<wpt>`'s `<ele>`: an on-route waypoint's elevation
 * in the built data is its matched track point's. This is about the source GPX
 * staying complete and consistent, so the lookup gives the answer the build
 * would show wherever it can:
 *  1. **the route**, when the position is on it: within the distance at which
 *     the build matches a waypoint to the main route (`waypointMaxDistance`,
 *     500 m by default), measured to the line and never across a route break,
 *     and only when the track really has elevations. The height is
 *     interpolated between the track points either side;
 *  2. **the Copernicus GLO-30 DEM** otherwise (`scripts/lib/dem-sampler.ts`),
 *     through an injected {@link DemSource} with a bounded wait;
 *  3. nothing, with the reason in words.
 *
 * A lookup never throws: a save goes ahead without an elevation rather than
 * fail or hang on the network.
 */

import { trailElevationIsUsable } from '../../../src/lib/elevation-backfill';
import { snapToTrail } from '../../../src/lib/position-on-trail';
import { routeBreakStarts } from '../../../src/lib/route-breaks';
import { DEFAULT_WAYPOINT_MAX_DISTANCE_METERS } from '../../../src/lib/trail-ingest';
import type { RouteBreak } from '../../../src/lib/trail-types';

/** Longest a save waits for the DEM (ms): the first read of a tile opens it over the network. */
export const DEM_TIMEOUT_MS = 8000;

/** Half-width of the window read around a position, in degrees (about 50 m): the sampler adds its own margin. */
const DEM_WINDOW_DEGREES = 0.0005;

export type ElevationSource = 'route' | 'dem';

/** What a lookup found for one position. */
export interface ElevationLookup {
  lat: number;
  lon: number;
  /** Metres above sea level, unrounded; null when neither source has a height here. */
  metres: number | null;
  /** Where `metres` came from; absent when it is null. */
  source?: ElevationSource;
  /** Distance to the main route's line, in metres, when the trail has one. */
  offRouteMeters?: number;
  /**
   * Why a source that was tried gave nothing, in words for a save's notes:
   * the route's reason alone when the DEM answered, both when neither did.
   */
  why?: string;
}

/**
 * A terrain model: the height in metres at a position, or null where it has
 * none (open sea). It may reject or never settle; the lookup bounds the wait.
 */
export type DemSource = (lat: number, lon: number) => Promise<number | null>;

/** The parts of a built trail (`ProcessedTrail`) the route's elevation is read from. */
export interface ElevationTrail {
  config?: { waypointMaxDistance?: number; elevationSource?: 'gpx' | 'backfilled' | 'none' };
  track: {
    /** `track.points`: the full-resolution main route, `dist` in cumulative km. */
    points: { lat: number; lon: number; ele?: number | null; dist: number }[];
    breaks?: readonly Pick<RouteBreak, 'index' | 'displayIndex'>[];
  };
}

/** How far from the main route's line the build still matches a waypoint to it, in metres. */
export function onRouteMeters(trail: ElevationTrail): number {
  return trail.config?.waypointMaxDistance ?? DEFAULT_WAYPOINT_MAX_DISTANCE_METERS;
}

function distanceText(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/**
 * The route's answer alone, which needs no network: the height of the nearest
 * point on the main route's line, interpolated between the track points either
 * side of it, when the position is on the route (see the file comment).
 */
export function routeElevation(trail: ElevationTrail, lat: number, lon: number): ElevationLookup {
  const lookup: ElevationLookup = { lat, lon, metres: null };
  const points = trail.track.points;
  const starts = routeBreakStarts(trail.track.breaks, 'points');
  const snap = snapToTrail(lat, lon, points, undefined, starts);
  if (!snap) return { ...lookup, why: 'the trail has no route' };
  lookup.offRouteMeters = snap.offTrailMeters;
  if (snap.offTrailMeters > onRouteMeters(trail)) {
    return { ...lookup, why: `it is ${distanceText(snap.offTrailMeters)} from the route` };
  }
  const none = { ...lookup, why: 'the route has no elevations' };
  if (!trailElevationIsUsable(trail)) return none;
  const a = points[snap.index];
  const b = points[snap.index + 1];
  let metres = a.ele;
  // The step into the first point after a break is a ferry, not trail: nothing lies between them.
  if (b && !starts.has(snap.index + 1) && b.dist > a.dist && typeof a.ele === 'number' && typeof b.ele === 'number') {
    const t = Math.max(0, Math.min(1, (snap.currentKm - a.dist) / (b.dist - a.dist)));
    metres = a.ele + t * (b.ele - a.ele);
  }
  if (typeof metres !== 'number' || !Number.isFinite(metres)) return none;
  return { ...lookup, metres, source: 'route' };
}

/** `work`, or a rejection once `ms` has passed. `work` itself is left to finish: a tile it opens is kept. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * The elevation at a position: the route's when the position is on it,
 * otherwise `dem`'s, waiting at most `timeoutMs` for it. Without a `dem` the
 * route's answer is all there is. Never throws.
 */
export async function lookupElevation(
  trail: ElevationTrail,
  lat: number,
  lon: number,
  dem?: DemSource,
  timeoutMs: number = DEM_TIMEOUT_MS
): Promise<ElevationLookup> {
  let route: ElevationLookup;
  try {
    route = routeElevation(trail, lat, lon);
  } catch (error) {
    route = { lat, lon, metres: null, why: `the route could not be read (${message(error)})` };
  }
  if (route.metres !== null || !dem) return route;
  const because = (problem: string): ElevationLookup => ({
    ...route,
    why: route.why ? `${route.why}, and ${problem}` : problem,
  });
  try {
    const metres = await withTimeout(
      Promise.resolve().then(() => dem(lat, lon)),
      timeoutMs
    );
    if (typeof metres !== 'number' || !Number.isFinite(metres)) {
      return because('the Copernicus DEM has no height there');
    }
    return { ...route, metres, source: 'dem' };
  } catch (error) {
    return because(`the Copernicus DEM could not be read (${message(error)})`);
  }
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return cause && cause !== text ? `${text}: ${cause}` : text;
}

/** What {@link copernicusDemSource} needs of `CopernicusDem`. */
export interface DemSampler {
  load(bbox: { west: number; south: number; east: number; north: number }): Promise<void>;
  at(lat: number, lon: number): number | null;
}

/**
 * The Copernicus GLO-30 DEM as a {@link DemSource}: one sampler for the dev
 * server's life, so a tile opened for one save is not opened again for the
 * next. The sampler (and the `geotiff` reader behind it) is imported on first
 * use, so starting the dev server costs nothing and a build never loads it.
 * Node's fetch ignores `HTTPS_PROXY`: behind a proxy, start the dev server
 * with `NODE_USE_ENV_PROXY=1`.
 */
export function copernicusDemSource(
  create: () => Promise<DemSampler> = async () => new (await import('../dem-sampler')).CopernicusDem()
): DemSource {
  let sampler: Promise<DemSampler> | undefined;
  return async (lat, lon) => {
    if (!sampler) {
      const opening = create();
      // A failure is not remembered: the next lookup tries again.
      opening.catch(() => {
        if (sampler === opening) sampler = undefined;
      });
      sampler = opening;
    }
    const dem = await sampler;
    await dem.load({
      west: lon - DEM_WINDOW_DEGREES,
      south: lat - DEM_WINDOW_DEGREES,
      east: lon + DEM_WINDOW_DEGREES,
      north: lat + DEM_WINDOW_DEGREES,
    });
    return dem.at(lat, lon);
  };
}

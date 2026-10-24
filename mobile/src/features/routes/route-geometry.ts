/**
 * Pure geometry for FarOut-style custom routes.
 *
 * A route is an ordered list of tapped points over a distance-sorted trail
 * track. Two point kinds:
 *   - 'snap'   — sits on the trail, carries the trail `km` at that point;
 *   - 'sketch' — an off-trail tap, `km` is null.
 *
 * Legs derive from consecutive points:
 *   - snap → snap        : an on-trail SPAN. Distance is |kmB − kmA| along the
 *                          track; ascent/descent come from the shared
 *                          `calculateElevationBetween`, direction-corrected so
 *                          walking high-km → low-km reports the real climb.
 *   - anything w/ sketch : a STRAIGHT line. Distance is the haversine between
 *                          the two vertices; it contributes 0 ascent/descent
 *                          (nothing is known about the ground between).
 *
 * Everything here is React-/MapLibre-free so the math and the emitted GeoJSON
 * are unit-testable without a device. All distances are kilometres, elevations
 * metres. The track array is whatever the caller draws + snaps against (the
 * guide passes `displayPoints`), so the emitted span polylines line up exactly
 * with the rendered trail line.
 *
 * Route breaks (a ferry, an unbridged river) arrive as `breakStarts`: indices
 * into that same track array of the first point after each break, from
 * `routeBreakStarts`. A span across one climbs nothing over the water and is
 * drawn as two trail lines with a dashed straight crossing between them.
 *
 * Snap km live in two spaces. The track the builder taps and the overlay draws
 * over is direction-applied (km count from the end the hiker walks from), but a
 * saved route stores them NOBO-absolute, as plan stops do, so a route drawn
 * walking one way still marks the same stretch after a direction flip.
 * `routePointsToNobo` converts on save and `routePointsToActive` on the way
 * back to the map and the profile. Routes saved before this rule have no
 * record of the direction they were drawn in; their km are re-derived from
 * their lat/lon on the NOBO track by their first re-snap (below), which puts a
 * route drawn walking SOBO back on its own ground.
 *
 * A snap point's km is only true of the track it was snapped against. A data
 * update that redraws the trail (a re-route, a spur moved to its real fork)
 * shifts every km past the change, so a saved route would mark the wrong
 * stretch. Its stored lat/lon is still right, though: `resnapRoutePoints`
 * snaps each point to the current track again, keyed by `routeTrackKey` so it
 * runs once per change of geometry (see `routes-store`).
 */

import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { haversineDistance } from '@lib/distance';
import {
  calculateElevationBetween,
  findNearestByDistance,
  NO_BREAK_STARTS,
} from '@lib/track-geometry';
import { sliceAcrossRouteBreaks } from '@lib/route-breaks';
import { toActiveKm, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import { snapToTrail, type SnapPoint } from '@lib/position-on-trail';

/** A track point the route is drawn over. */
export interface RouteTrackPoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance along the trail in km. */
  dist: number;
}

/** One ordered route vertex (matches the persisted `route_points` shape). */
export interface RoutePointInput {
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  /** Trail km for snap points; null for sketch points. */
  km: number | null;
}

/** A tap within this many metres of the track snaps onto the trail. */
export const SNAP_THRESHOLD_M = 200;

/**
 * Classify a map tap into a route point. A tap within `thresholdM` of the
 * track becomes a 'snap' point on the nearest track vertex (lat/lon + km taken
 * from that vertex so it sits exactly on the drawn line); a farther tap keeps
 * its raw lat/lon as a 'sketch' point (km null). Reuses the proven
 * `snapToTrail` search from position-on-trail.
 *
 * `snapToTrail` snaps to the nearest *segment* and reports its start vertex,
 * so the nearer of that segment's two ends is picked here: on a thinned track
 * (vertices up to ~1 km apart) taking the start alone could move a tap by most
 * of a segment, back along the trail.
 */
export function classifyTap(
  lat: number,
  lon: number,
  track: RouteTrackPoint[],
  thresholdM: number = SNAP_THRESHOLD_M,
): RoutePointInput {
  const snap = snapToTrail(lat, lon, track as unknown as SnapPoint[]);
  if (snap && snap.offTrailMeters <= thresholdM) {
    const pt = nearerSegmentEnd(track, snap.index, snap.currentKm);
    return { kind: 'snap', lat: pt.lat, lon: pt.lon, km: pt.dist };
  }
  return { kind: 'sketch', lat, lon, km: null };
}

/** Whichever end of segment `index` → `index + 1` is nearer `km` along the trail. */
function nearerSegmentEnd(track: RouteTrackPoint[], index: number, km: number): RouteTrackPoint {
  const start = track[index];
  const end = track[index + 1];
  if (!end) return start;
  return Math.abs(end.dist - km) < Math.abs(km - start.dist) ? end : start;
}

/**
 * A fingerprint of the track a route is snapped against: changes whenever any
 * point's position, km or height does, and only then. FNV-1a over the rounded values,
 * so it is stable across reads of the same data and needs no crypto.
 */
export function routeTrackKey(track: readonly RouteTrackPoint[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const p of track) {
    mix(p.lat.toFixed(6));
    mix(p.lon.toFixed(6));
    mix(p.dist.toFixed(4));
    // The stored ascent and descent come from the heights.
    mix(p.ele.toFixed(1));
  }
  return `${track.length}:${(hash >>> 0).toString(16)}`;
}

/** Km moves smaller than this are floating-point noise, not a moved point. */
const RESNAP_EPSILON_KM = 1e-6;

/** A stored snap point this close to the vertex at its own km is still on it (metres). */
const RESNAP_SAME_VERTEX_M = 1;

/** What `resnapRoutePoints` did to a route. */
export interface ResnapResult<P extends RoutePointInput> {
  points: P[];
  /** True when any point moved or changed kind. */
  changed: boolean;
  /** Snap points no longer within the snap threshold of the track (now sketch). */
  offTrail: number;
}

/**
 * Snap a saved route's on-trail points to `track` again, from their stored
 * lat/lon: each gets the km of the vertex it lands on now, the same rule a
 * tap gets (`classifyTap`). A point the track no longer passes becomes a
 * sketch point where it was, so the route still goes there, in a straight
 * line, and the caller can say so. Sketch points are the hiker's own off-trail
 * taps and are left alone. On an unchanged track every point comes back as the
 * same object.
 *
 * Where the track passes a place twice (an out-and-back), a snap by position
 * alone lands on whichever pass comes first. So a point still at the vertex
 * its stored km names is kept as it is, and any other takes, of the passes at
 * the place it snaps to, the one nearest its stored km moved by the shift seen
 * at the nearest point of the route the track passes only once: the leg it
 * was drawn on, even when the update moved the km by about as much as the
 * legs are apart.
 *
 * Pass the track the km are stored on (the NOBO one: saved routes are
 * NOBO-absolute), so the new km need no conversion.
 */
export function resnapRoutePoints<P extends RoutePointInput>(
  points: readonly P[],
  track: RouteTrackPoint[],
  thresholdM: number = SNAP_THRESHOLD_M,
): ResnapResult<P> {
  // First pass: where each snap point lands now, and on which passes.
  type Landing =
    | { kind: 'kept' }
    | { kind: 'gone' }
    | { kind: 'snapped'; lat: number; lon: number; passes: number[] };
  const landings: (Landing | null)[] = points.map((p) => {
    if (!isSnap(p)) return null;
    const storedKm = p.km as number;
    const atKm = track[findNearestByDistance(track, storedKm)];
    if (
      atKm &&
      Math.abs(atKm.dist - storedKm) < RESNAP_EPSILON_KM &&
      haversineDistance(atKm.lat, atKm.lon, p.lat, p.lon) <= RESNAP_SAME_VERTEX_M
    ) {
      return { kind: 'kept' };
    }
    const snapped = classifyTap(p.lat, p.lon, track, thresholdM);
    if (snapped.kind === 'sketch') return { kind: 'gone' };
    return {
      kind: 'snapped',
      lat: snapped.lat,
      lon: snapped.lon,
      passes: passesAt(track, snapped),
    };
  });

  // How far the km moved under each point the track passes only once (or
  // where it was kept): the shift to expect at an ambiguous point next to it.
  const shifts: (number | null)[] = landings.map((landing, i) => {
    if (landing?.kind === 'kept') return 0;
    if (landing?.kind === 'snapped' && landing.passes.length === 1) {
      return landing.passes[0] - (points[i].km as number);
    }
    return null;
  });
  const nearestShift = (i: number): number => {
    for (let d = 1; d < points.length; d++) {
      const before = shifts[i - d];
      if (before != null) return before;
      const after = shifts[i + d];
      if (after != null) return after;
    }
    return 0;
  };

  let changed = false;
  let offTrail = 0;
  const next = points.map((p, i) => {
    const landing = landings[i];
    if (!landing || landing.kind === 'kept') return p;
    if (landing.kind === 'gone') {
      changed = true;
      offTrail++;
      return { ...p, kind: 'sketch' as const, km: null };
    }
    const storedKm = p.km as number;
    // Of the passes at this place, the one where this point's leg is now.
    const expected = storedKm + (shifts[i] ?? nearestShift(i));
    const km = landing.passes.reduce((best, pass) =>
      Math.abs(pass - expected) < Math.abs(best - expected) ? pass : best,
    );
    if (
      Math.abs(km - storedKm) < RESNAP_EPSILON_KM &&
      landing.lat === p.lat &&
      landing.lon === p.lon
    ) {
      return p;
    }
    changed = true;
    return { ...p, lat: landing.lat, lon: landing.lon, km };
  });
  return { points: changed ? next : (points as P[]), changed, offTrail };
}

/**
 * The km of every vertex at `snapped`'s place, in track order: one for most
 * places, more where the track passes the same ground twice (an out-and-back).
 */
function passesAt(track: readonly RouteTrackPoint[], snapped: RoutePointInput): number[] {
  const passes = track
    .filter(
      (t) => haversineDistance(t.lat, t.lon, snapped.lat, snapped.lon) <= RESNAP_SAME_VERTEX_M,
    )
    .map((t) => t.dist);
  return passes.length > 0 ? passes : [snapped.km as number];
}

/**
 * Mirror every snap km through `convert`; sketch points (km null) and a NOBO
 * walk (the identity) pass through untouched, and the latter hands back the
 * same array so memoised overlays do not rebuild for nothing.
 */
function mapRouteKm<P extends RoutePointInput>(
  points: readonly P[],
  direction: PlanDirection,
  convert: (km: number) => number,
): P[] {
  if (direction === 'NOBO') return points as P[];
  return points.map((p) => (p.km == null ? p : { ...p, km: convert(p.km) }));
}

/** Direction-applied route points (as tapped) → NOBO-absolute, for saving. */
export function routePointsToNobo<P extends RoutePointInput>(
  points: readonly P[],
  direction: PlanDirection,
  totalKm: number,
): P[] {
  return mapRouteKm(points, direction, (km) => toNoboKm(km, direction, totalKm));
}

/** Saved (NOBO-absolute) route points → the active direction, for drawing. */
export function routePointsToActive<P extends RoutePointInput>(
  points: readonly P[],
  direction: PlanDirection,
  totalKm: number,
): P[] {
  return mapRouteKm(points, direction, (km) => toActiveKm(km, direction, totalKm));
}

/** Whether a route point sits on the trail (drives snap→snap span legs). */
function isSnap(p: RoutePointInput): boolean {
  return p.kind === 'snap' && p.km != null;
}

/** Metrics + shape for one leg between two consecutive route points. */
export interface RouteLeg {
  /** Index of the leg's start point in the route's point list. */
  fromIndex: number;
  toIndex: number;
  /** True when either endpoint is a sketch point (haversine, not trail-accurate). */
  straight: boolean;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  /** On-trail span range (present only for snap→snap legs), lo → hi km. */
  startKm?: number;
  endKm?: number;
}

/** Haversine distance between two vertices, in km. */
function legHaversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000;
}

/**
 * Derive the ordered legs of a route. Snap→snap legs measure along the track
 * (with direction-corrected ascent/descent); any leg touching a sketch point
 * is a straight haversine line contributing no elevation.
 */
export function computeRouteLegs(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];

    if (isSnap(from) && isSnap(to)) {
      const kmA = from.km as number;
      const kmB = to.km as number;
      const lo = Math.min(kmA, kmB);
      const hi = Math.max(kmA, kmB);
      const { gain, loss } = calculateElevationBetween(lo, hi, track, breakStarts);
      // calculateElevationBetween accumulates low→high; a leg walked high→low
      // swaps climb and descent.
      const ascending = kmB >= kmA;
      legs.push({
        fromIndex: i - 1,
        toIndex: i,
        straight: false,
        distanceKm: hi - lo,
        ascentM: ascending ? gain : loss,
        descentM: ascending ? loss : gain,
        startKm: lo,
        endKm: hi,
      });
    } else {
      legs.push({
        fromIndex: i - 1,
        toIndex: i,
        straight: true,
        distanceKm: legHaversineKm(from, to),
        ascentM: 0,
        descentM: 0,
      });
    }
  }
  return legs;
}

/** Denormalized route stats (stored on the route row at save time). */
export interface RouteStats {
  totalKm: number;
  ascentM: number;
  descentM: number;
}

/** Sum a route's legs into total distance + ascent + descent. */
export function computeRouteStats(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
  breakStarts: ReadonlySet<number> = NO_BREAK_STARTS,
): RouteStats {
  const legs = computeRouteLegs(points, track, breakStarts);
  let totalKm = 0;
  let ascentM = 0;
  let descentM = 0;
  for (const leg of legs) {
    totalKm += leg.distanceKm;
    ascentM += leg.ascentM;
    descentM += leg.descentM;
  }
  return { totalKm, ascentM, descentM };
}

/**
 * On-trail km ranges of a route, for the elevation-profile highlight bands.
 * Straight (sketch) legs contribute nothing — only trail spans are highlighted.
 */
export function routeHighlightRanges(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
): { startKm: number; endKm: number }[] {
  return computeRouteLegs(points, track)
    .filter((leg) => !leg.straight)
    .map((leg) => ({ startKm: leg.startKm as number, endKm: leg.endKm as number }));
}

export interface RouteOverlayOptions {
  /** Also emit a Point feature per vertex (used for the live builder). */
  includeVertices?: boolean;
  /** Route breaks in `track`, from `routeBreakStarts(breaks, 'displayPoints')`. */
  breakStarts?: ReadonlySet<number>;
}

/**
 * Map-overlay GeoJSON for a route:
 *   - snap→snap legs emit the actual track slice as a LineString
 *     (`straight: false`) so the overlay hugs the trail — one per stretch when
 *     the span crosses a route break, joined by a `straight: true` crossing,
 *     so a ferry is never drawn as trail;
 *   - straight legs emit a 2-point LineString (`straight: true`) the map draws
 *     dashed, so an off-trail leg is never read as trail-accurate;
 *   - with `includeVertices`, each route point is emitted as a Point feature
 *     (`kind` property) for the builder's tapped-dot markers.
 *
 * Mixed geometry in one collection is intentional: the map filters layers by
 * `['geometry-type']` so lines and vertices paint from one GeoJSONSource.
 */
export function buildRouteOverlayGeoJSON(
  points: RoutePointInput[],
  track: RouteTrackPoint[],
  options: RouteOverlayOptions = {},
): FeatureCollection {
  const features: Feature[] = [];
  const breakStarts = options.breakStarts ?? NO_BREAK_STARTS;

  for (const leg of computeRouteLegs(points, track, breakStarts)) {
    const from = points[leg.fromIndex];
    const to = points[leg.toIndex];

    if (!leg.straight) {
      const loIdx = findNearestByDistance(track, leg.startKm as number);
      const hiIdx = findNearestByDistance(track, leg.endKm as number);
      const pieces = sliceAcrossRouteBreaks(track, loIdx, hiIdx, breakStarts);
      if (pieces.length > 1 || (pieces.length === 1 && pieces[0].length >= 2)) {
        pieces.forEach((piece, k) => {
          if (k > 0) {
            const before = pieces[k - 1][pieces[k - 1].length - 1];
            features.push(
              lineFeature(
                [
                  [before.lon, before.lat],
                  [piece[0].lon, piece[0].lat],
                ],
                true,
              ),
            );
          }
          if (piece.length >= 2) {
            features.push(
              lineFeature(
                piece.map((p) => [p.lon, p.lat]),
                false,
              ),
            );
          }
        });
        continue;
      }
      // Degenerate span (both endpoints resolve to the same track point) —
      // fall back to a straight segment between the vertices.
    }

    features.push(
      lineFeature(
        [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ],
        leg.straight,
      ),
    );
  }

  if (options.includeVertices) {
    for (const p of points) {
      features.push(vertexFeature(p));
    }
  }

  return { type: 'FeatureCollection', features };
}

function lineFeature(coordinates: number[][], straight: boolean): Feature<LineString> {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { straight },
  };
}

function vertexFeature(p: RoutePointInput): Feature<Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { kind: p.kind },
  };
}

/**
 * Which listed country, and which of its states/regions, a route is in — from
 * its coordinates alone, offline. Used to prefill the region on the community
 * share forms (web and phone; the hiker can change it) and by the worker's
 * `region` check, which only warns when the chosen region disagrees: the
 * hiker's choice is never overridden. Spec: `plans/community-routes.md`.
 *
 * The shapes (`region-shapes.ts`) are Natural Earth outlines simplified to a
 * few km on coasts (land borders are kept to ~500 m and shared by both
 * neighbours), so a sample point is matched inside a shape first and, failing
 * that, to the nearest shape within `NEAR_KM` (a coastal walk whose line runs
 * just seaward of a coarse coastline). The unlisted countries bordering a
 * listed one have shapes too, so a route in Lesotho or Andorra detects as LS
 * or AD rather than as its neighbour; a route anywhere else unlisted detects
 * as no country.
 */

import { REGION_SHAPES, REGION_SHAPE_SCALE } from './region-shapes';
import type { RegionShape } from './region-shapes';

export interface DetectedRegion {
  /**
   * ISO 3166-1 alpha-2 of the country most of the route is in, or null when no
   * sampled point is in a known shape. May be a country `trail-regions.ts`
   * does not list (one bordering a listed country).
   */
  country: string | null;
  /** The country's states the route passes through, in route order. Empty when it lists none. */
  states: string[];
  /** The state most of the route is in (the one to prefill), or null. */
  state: string | null;
  /**
   * Every country and every `COUNTRY:STATE` any sampled point is in, however
   * few: what a chosen region is checked against, so a short real stretch in
   * a state is never reported as wrong.
   */
  seen: { countries: string[]; states: string[] };
}

/** How many points of a route are tested, evenly spaced, first and last included. */
export const REGION_SAMPLE_POINTS = 256;
/** How far outside every shape a point may be and still take the nearest one. */
export const NEAR_KM = 30;
/**
 * The share of the sampled points a state must hold to be listed: a route
 * along a border that strays a sample over it is not "in" that state.
 */
const MIN_STATE_SHARE = 0.02;

interface LatLon {
  lat: number;
  lon: number;
}

interface PreparedShape {
  country: string;
  state: string | null;
  /** Rings in degrees, flat `[lon, lat, …]`. */
  rings: Float64Array[];
  /** [minLon, minLat, maxLon, maxLat] of each ring. */
  ringBoxes: [number, number, number, number][];
  /** [minLon, minLat, maxLon, maxLat] over every ring. */
  bbox: [number, number, number, number];
}

let prepared: PreparedShape[] | null = null;

/** Decode the stored rings (a first vertex, then steps) into degrees, with a box per ring. */
function prepare(shape: RegionShape): PreparedShape {
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const ringBoxes: [number, number, number, number][] = [];
  const rings = shape.rings.map((ring) => {
    const out = new Float64Array(ring.length);
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    let x = 0;
    let y = 0;
    for (let i = 0; i < ring.length; i += 2) {
      x += ring[i];
      y += ring[i + 1];
      const lon = x / REGION_SHAPE_SCALE;
      const lat = y / REGION_SHAPE_SCALE;
      out[i] = lon;
      out[i + 1] = lat;
      if (lon < box[0]) box[0] = lon;
      if (lat < box[1]) box[1] = lat;
      if (lon > box[2]) box[2] = lon;
      if (lat > box[3]) box[3] = lat;
    }
    ringBoxes.push(box);
    bbox[0] = Math.min(bbox[0], box[0]);
    bbox[1] = Math.min(bbox[1], box[1]);
    bbox[2] = Math.max(bbox[2], box[2]);
    bbox[3] = Math.max(bbox[3], box[3]);
    return out;
  });
  return { country: shape.country, state: shape.state, rings, ringBoxes, bbox };
}

function shapes(): PreparedShape[] {
  prepared ??= REGION_SHAPES.map(prepare);
  return prepared;
}

/** Even-odd ray cast over every ring of the shape. */
function contains(shape: PreparedShape, lon: number, lat: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = shape.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
  let inside = false;
  for (let r = 0; r < shape.rings.length; r++) {
    // A ring whose box misses the point cannot flip the even-odd count.
    const box = shape.ringBoxes[r];
    if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
    const ring = shape.rings[r];
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = ring[i + 1];
      const yj = ring[j + 1];
      if (yi > lat !== yj > lat) {
        const x = ring[i] + ((lat - yi) / (yj - yi)) * (ring[j] - ring[i]);
        if (lon < x) inside = !inside;
      }
    }
  }
  return inside;
}

/** Approximate distance in km from a point to the nearest edge of the shape (equirectangular). */
function distanceKm(shape: PreparedShape, lon: number, lat: number, limitKm: number): number {
  const kmPerLat = 111.32;
  const kmPerLon = kmPerLat * Math.cos((lat * Math.PI) / 180);
  const padLat = limitKm / kmPerLat;
  const padLon = limitKm / Math.max(kmPerLon, 1);
  const [minLon, minLat, maxLon, maxLat] = shape.bbox;
  if (lon < minLon - padLon || lon > maxLon + padLon || lat < minLat - padLat || lat > maxLat + padLat) {
    return Infinity;
  }
  let best = Infinity;
  for (let r = 0; r < shape.rings.length; r++) {
    const box = shape.ringBoxes[r];
    if (lon < box[0] - padLon || lon > box[2] + padLon || lat < box[1] - padLat || lat > box[3] + padLat) continue;
    const ring = shape.rings[r];
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const ax = (ring[j] - lon) * kmPerLon;
      const ay = (ring[j + 1] - lat) * kmPerLat;
      const bx = (ring[i] - lon) * kmPerLon;
      const by = (ring[i + 1] - lat) * kmPerLat;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * The shape a point is in, else the nearest within `NEAR_KM`, else null.
 * Shapes are country-wide or one state each, so a match names both.
 */
export function regionAt(lat: number, lon: number): { country: string; state: string | null } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const all = shapes();
  for (const shape of all) {
    if (contains(shape, lon, lat)) return { country: shape.country, state: shape.state };
  }
  let nearest: PreparedShape | null = null;
  let nearestKm = NEAR_KM;
  for (const shape of all) {
    const d = distanceKm(shape, lon, lat, nearestKm);
    if (d <= nearestKm) {
      nearest = shape;
      nearestKm = d;
    }
  }
  return nearest ? { country: nearest.country, state: nearest.state } : null;
}

/** Evenly spaced indices into `length` points, first and last included. */
function sampleIndices(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(Math.round((k * (length - 1)) / (count - 1)));
  return out;
}

/**
 * The country most of the route is in, and the states it passes through.
 * Takes any `{lat, lon}` list (a trail's `track.points`); points that are not
 * finite numbers are skipped.
 */
export function detectRegion(points: readonly LatLon[]): DetectedRegion {
  const none: DetectedRegion = { country: null, states: [], state: null, seen: { countries: [], states: [] } };
  if (!Array.isArray(points) || points.length === 0) return none;

  const hits: { country: string; state: string | null }[] = [];
  for (const i of sampleIndices(points.length, REGION_SAMPLE_POINTS)) {
    const p = points[i];
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    const hit = regionAt(p.lat, p.lon);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) return none;

  // The country with the most samples; a tie goes to the one reached first.
  const countryCounts = new Map<string, number>();
  for (const h of hits) countryCounts.set(h.country, (countryCounts.get(h.country) ?? 0) + 1);
  let country = hits[0].country;
  for (const [code, n] of countryCounts) {
    if (n > countryCounts.get(country)!) country = code;
  }

  const inCountry = hits.filter((h) => h.country === country && h.state !== null);
  const stateCounts = new Map<string, number>();
  for (const h of inCountry) stateCounts.set(h.state!, (stateCounts.get(h.state!) ?? 0) + 1);
  const minCount = Math.max(1, Math.ceil(MIN_STATE_SHARE * hits.length));
  // Map keys keep insertion order, which is route order.
  const states = [...stateCounts].filter(([, n]) => n >= minCount).map(([code]) => code);
  let state: string | null = null;
  for (const code of states) {
    if (state === null || stateCounts.get(code)! > stateCounts.get(state)!) state = code;
  }
  const seen = {
    countries: [...countryCounts.keys()],
    states: [...new Set(hits.filter((h) => h.state !== null).map((h) => `${h.country}:${h.state}`))],
  };
  return { country, states, state, seen };
}

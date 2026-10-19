/**
 * The OSM POI catalog, the Overpass query builder, corridor chunking and the
 * point-to-route geometry — everything needed to ask Overpass "what is within
 * 2 km of this route" and to measure where each answer sits along it.
 *
 * Ported from `gpx-tools/lib/osm-poi` so the phone can run the same search the
 * build does: that package is a git dependency of the root only, and is not
 * something Metro bundles. `scripts/fetch-pois.ts`, the web's imported-trail
 * search (`src/web/poi-enrich.ts`) and the app all use this copy, so the three
 * cannot drift. `scripts/osm-poi-parity.test.ts` holds it to gpx-tools (which
 * still feeds that project's own API proxy): the same catalog, the same query
 * text, the same chunks and the same nearest point, byte for byte.
 *
 * Pure: no fetch, no DOM, no Node APIs.
 */

import { EARTH_RADIUS_METERS, haversineDistance } from './distance';
import { douglasPeuckerIndices } from './gpx-optimizer';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type POIType = 'water' | 'camping' | 'resupply' | 'restaurant' | 'transport' | 'emergency';

export const POI_TYPES: readonly POIType[] = [
  'water',
  'camping',
  'resupply',
  'restaurant',
  'transport',
  'emergency',
] as const;

/** One OSM tag rule. Generates BOTH the Overpass selector and the client-side predicate. */
export interface POITagRule {
  /** Primary tag key, e.g. 'amenity' */
  key: string;
  /** Primary tag value, e.g. 'drinking_water' */
  value: string;
  /** Extra tag conditions that must hold (key present, and if `value` given, equal). */
  require?: { key: string; value?: string }[];
  /** Tag conditions that must NOT hold. Overpass `["k"!="v"]` semantics: an absent key passes. */
  exclude?: { key: string; value: string }[];
  /**
   * Evaluated only after every non-fallback rule of every category has failed.
   * Lets a broad tag (e.g. `drinking_water=yes`) catch leftovers without stealing
   * features that a more specific category already claims.
   */
  fallback?: boolean;
}

/**
 * The catalog. Order matters: `categorizePOI` returns the first matching rule in
 * catalog order (non-fallback rules first, across all categories).
 */
export const POI_CATALOG: Record<POIType, POITagRule[]> = {
  water: [
    { key: 'amenity', value: 'drinking_water' },
    { key: 'natural', value: 'spring' },
    { key: 'man_made', value: 'water_tap' },
    { key: 'amenity', value: 'water_point' },
    // Fallback: catches toilets/fountains/campsites that happen to have a tap.
    // It must be a fallback so a cafe tagged drinking_water=yes stays "restaurant".
    // (natural=water named lakes are deliberately absent: a lake is not a
    // drinking source.)
    { key: 'drinking_water', value: 'yes', fallback: true },
  ],
  camping: [
    { key: 'tourism', value: 'camp_site' },
    { key: 'tourism', value: 'caravan_site' },
    { key: 'tourism', value: 'alpine_hut' },
    { key: 'tourism', value: 'wilderness_hut' },
    // Bus shelters are tagged amenity=shelter too; they are transport, not camping.
    {
      key: 'amenity',
      value: 'shelter',
      exclude: [{ key: 'shelter_type', value: 'public_transport' }],
    },
  ],
  // Places to buy supplies to carry. Sit-down/takeaway food is "restaurant"
  // so a town's cafes do not swamp the list of actual shops.
  resupply: [
    { key: 'shop', value: 'supermarket' },
    { key: 'shop', value: 'convenience' },
    { key: 'shop', value: 'general' },
    { key: 'shop', value: 'kiosk' },
    { key: 'shop', value: 'bakery' },
    { key: 'shop', value: 'greengrocer' },
    { key: 'shop', value: 'outdoor' },
    { key: 'amenity', value: 'fuel' },
    { key: 'amenity', value: 'post_office' },
  ],
  restaurant: [
    { key: 'amenity', value: 'restaurant' },
    { key: 'amenity', value: 'cafe' },
    { key: 'amenity', value: 'fast_food' },
    { key: 'amenity', value: 'pub' },
    { key: 'amenity', value: 'bar' },
    { key: 'amenity', value: 'food_court' },
  ],
  transport: [
    { key: 'highway', value: 'bus_stop' },
    { key: 'railway', value: 'station' },
    { key: 'railway', value: 'halt' },
    { key: 'railway', value: 'tram_stop' },
    { key: 'amenity', value: 'ferry_terminal' },
  ],
  emergency: [
    { key: 'amenity', value: 'hospital' },
    { key: 'amenity', value: 'clinic' },
    { key: 'amenity', value: 'doctors' },
    { key: 'amenity', value: 'pharmacy' },
    { key: 'amenity', value: 'police' },
    { key: 'amenity', value: 'fire_station' },
    { key: 'amenity', value: 'ranger_station' },
    { key: 'emergency', value: 'phone' },
  ],
};

/** Does a tag set satisfy a single rule (primary tag + require + exclude)? */
function ruleMatches(tags: Record<string, string>, rule: POITagRule): boolean {
  if (tags[rule.key] !== rule.value) {
    return false;
  }
  for (const req of rule.require ?? []) {
    const actual = tags[req.key];
    if (actual === undefined) {
      return false;
    }
    if (req.value !== undefined && actual !== req.value) {
      return false;
    }
  }
  for (const exc of rule.exclude ?? []) {
    // Overpass `["k"!="v"]` semantics: an absent key passes the filter.
    if (tags[exc.key] === exc.value) {
      return false;
    }
  }
  return true;
}

/**
 * Classify a feature from its OSM tags.
 *
 * Two passes: every non-fallback rule of every category first (catalog order),
 * then the fallback rules. That is what keeps `amenity=cafe` + `drinking_water=yes`
 * classified as restaurant while `amenity=toilets` + `drinking_water=yes` becomes water.
 *
 * `preferred` (normally the types a caller asked for) is tried first, both
 * passes, before the remaining types, so whatever a requested type's selector
 * matched is classified as that type (a sheltered bus stop asked for as
 * Transport is transport, not camping).
 */
export function categorizePOI(
  tags: Record<string, string>,
  preferred?: readonly POIType[]
): POIType | null {
  if (!tags) {
    return null;
  }
  const order: POIType[] = preferred
    ? [...POI_TYPES.filter(t => preferred.includes(t)), ...POI_TYPES.filter(t => !preferred.includes(t))]
    : [...POI_TYPES];
  const preferredCount = preferred ? order.filter(t => preferred.includes(t)).length : order.length;

  const scan = (types: POIType[], fallback: boolean): POIType | null => {
    for (const type of types) {
      for (const rule of POI_CATALOG[type]) {
        if (!!rule.fallback === fallback && ruleMatches(tags, rule)) {
          return type;
        }
      }
    }
    return null;
  };

  const first = order.slice(0, preferredCount);
  const rest = order.slice(preferredCount);
  return scan(first, false) ?? scan(first, true) ?? scan(rest, false) ?? scan(rest, true);
}

// ---------------------------------------------------------------------------
// Areas and query building
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

/**
 * Either a bbox or a polyline corridor. Corridor is the preferred mode; one
 * query may carry several polylines (`packCorridorChunks`).
 */
export type OverpassArea =
  | { bounds: BBox }
  | { corridor: LatLon[] | LatLon[][]; radiusMeters: number };

export interface OverpassQueryOptions {
  /** Overpass `[timeout:]` value in seconds. Default 22. */
  timeoutSeconds?: number;
}

/** Metres per degree of latitude, used by the local equirectangular projection. */
const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

/** Round to 4 decimal places (~11 m) so query text and cache keys agree. */
export function roundCoord(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Format a rounded coordinate without exponent notation or trailing noise. */
function fmtCoord(x: number): string {
  return String(roundCoord(x));
}

/** Escape a tag value for use inside an Overpass regex alternation. */
function escapeRegexValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a tag key/value for use inside an Overpass `["k"="v"]` literal. */
function escapeLiteral(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
}

/** Accept both `LatLon[]` and `LatLon[][]`, always returning the nested form. */
function toPolylines(route: LatLon[] | LatLon[][]): LatLon[][] {
  if (route.length === 0) {
    return [];
  }
  return Array.isArray(route[0]) ? (route as LatLon[][]) : [route as LatLon[]];
}

/**
 * Global `[bbox:s,w,n,e]` setting for a corridor query: the extent of every
 * polyline, padded by the search radius. Without it Overpass walks the
 * planet-wide tag index per selector and a long route times out. "" when the
 * extent crosses the antimeridian.
 */
function corridorBBoxSetting(polylines: LatLon[][], radiusMeters: number): string {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const polyline of polylines) {
    for (const p of polyline) {
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
    }
  }
  if (!Number.isFinite(south) || east - west > 180) {
    return '';
  }
  const latPad = radiusMeters / METERS_PER_DEGREE;
  const cosLat = Math.max(Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180), 0.01);
  const lonPad = latPad / cosLat;
  const s = Math.max(-90, south - latPad);
  const n = Math.min(90, north + latPad);
  const w = Math.max(-180, west - lonPad);
  const e = Math.min(180, east + lonPad);
  return `[bbox:${fmtCoord(s)},${fmtCoord(w)},${fmtCoord(n)},${fmtCoord(e)}]`;
}

/** The `(around:...)` or `(s,w,n,e)` suffixes: one per corridor polyline, or one bbox filter. */
function areaFilters(area: OverpassArea): string[] {
  if ('corridor' in area) {
    return toPolylines(area.corridor).map(polyline => {
      const coords = polyline.map(p => `${fmtCoord(p.lat)},${fmtCoord(p.lon)}`).join(',');
      return `(around:${area.radiusMeters},${coords})`;
    });
  }
  const b = area.bounds;
  return [`(${fmtCoord(b.south)},${fmtCoord(b.west)},${fmtCoord(b.north)},${fmtCoord(b.east)})`];
}

/** Render the tag selector part (`["k"="v"]...`) for one rule. */
function ruleSelector(rule: POITagRule): string {
  let out = `["${escapeLiteral(rule.key)}"="${escapeLiteral(rule.value)}"]`;
  for (const req of rule.require ?? []) {
    out +=
      req.value === undefined
        ? `["${escapeLiteral(req.key)}"]`
        : `["${escapeLiteral(req.key)}"="${escapeLiteral(req.value)}"]`;
  }
  for (const exc of rule.exclude ?? []) {
    out += `["${escapeLiteral(exc.key)}"!="${escapeLiteral(exc.value)}"]`;
  }
  return out;
}

/**
 * Build the Overpass QL for an area and a set of POI types.
 *
 * `nwr` + `out center;` so features mapped as areas come back with a point.
 * Plain rules sharing a tag key are unioned into one regex statement; rules
 * with require/exclude conditions get their own. A multi-polyline corridor
 * repeats every statement once per polyline. Throws when `types` yields no
 * statement (an empty union is an Overpass syntax error).
 */
export function buildOverpassQuery(
  area: OverpassArea,
  types: readonly POIType[],
  opts: OverpassQueryOptions = {}
): string {
  const timeout = opts.timeoutSeconds ?? 22;
  const filters = areaFilters(area);
  const bboxSetting =
    'corridor' in area ? corridorBBoxSetting(toPolylines(area.corridor), area.radiusMeters) : '';
  const statements: string[] = [];
  const seen = new Set<string>();

  const push = (selector: string): void => {
    for (const filter of filters) {
      const stmt = `  nwr${selector}${filter};`;
      if (!seen.has(stmt)) {
        seen.add(stmt);
        statements.push(stmt);
      }
    }
  };

  for (const type of types) {
    const rules = POI_CATALOG[type];
    if (!rules) {
      continue;
    }
    // Group the plain rules of this type by tag key, preserving catalog order.
    const groups = new Map<string, string[]>();
    for (const rule of rules) {
      if (rule.require?.length || rule.exclude?.length) {
        continue;
      }
      const values = groups.get(rule.key);
      if (values) {
        if (!values.includes(rule.value)) {
          values.push(rule.value);
        }
      } else {
        groups.set(rule.key, [rule.value]);
      }
    }
    for (const [key, values] of groups) {
      if (values.length === 1) {
        push(`["${escapeLiteral(key)}"="${escapeLiteral(values[0])}"]`);
      } else {
        // Regex-escape first, then escape the result for the QL string literal.
        const alternation = values.map(v => escapeLiteral(escapeRegexValue(v))).join('|');
        push(`["${escapeLiteral(key)}"~"^(${alternation})$"]`);
      }
    }
    // Conditional rules cannot be folded into a regex union.
    for (const rule of rules) {
      if (rule.require?.length || rule.exclude?.length) {
        push(ruleSelector(rule));
      }
    }
  }

  if (statements.length === 0) {
    throw new Error(
      `No POI types to query (got ${JSON.stringify(types)}); known types: ${POI_TYPES.join(', ')}`
    );
  }

  return `[out:json][timeout:${timeout}]${bboxSetting};\n(\n${statements.join('\n')}\n);\nout center;`;
}

// ---------------------------------------------------------------------------
// Overpass element normalisation
// ---------------------------------------------------------------------------

export interface OverpassElement {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: LatLon;
  tags?: Record<string, string>;
}

export interface POI {
  id: number;
  type: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

/** Stable identity for an OSM element: node, way and relation ids collide. */
export function osmElementKey(poi: { type: string; id: number }): string {
  return `${poi.type}/${poi.id}`;
}

/**
 * Flatten raw Overpass elements into POIs. Ways/relations carry their point in
 * `center`. Elements without usable coordinates are dropped. Does NOT dedupe.
 */
export function normalizeOverpassElements(elements: OverpassElement[] | undefined): POI[] {
  if (!Array.isArray(elements)) {
    return [];
  }
  const out: POI[] = [];
  for (const el of elements) {
    if (!el) {
      continue;
    }
    // `??` not `||`: lat/lon of 0 is a real coordinate on the equator/meridian.
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    out.push({ id: el.id, type: el.type, lat, lon, tags: el.tags ?? {} });
  }
  return out;
}

/**
 * Why a 200 response from Overpass is NOT a usable result, or null when it is.
 * Overpass reports a query that ran out of time or memory as HTTP 200 with a
 * `remark`; treating that as "nothing here" would be a lie.
 */
export function overpassPayloadError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return 'Overpass returned a non-JSON response';
  }
  const data = payload as { elements?: unknown; remark?: unknown };
  if (typeof data.remark === 'string' && /runtime error/i.test(data.remark)) {
    return `Overpass ${data.remark.trim()}`;
  }
  if (!Array.isArray(data.elements)) {
    return 'Overpass response has no elements array';
  }
  return null;
}

/** Does an Overpass failure message describe a transient (retryable) condition? */
export function isTransientOverpassError(message: string): boolean {
  return /timed out|out of memory|too busy|load|rate_limited|runtime error/i.test(message);
}

// ---------------------------------------------------------------------------
// Corridor preparation
// ---------------------------------------------------------------------------

/** Limits shared with gpx-tools' API proxy. */
export const CORRIDOR_LIMITS = {
  maxVertices: 400,
  maxRadiusMeters: 10000,
  maxBBoxDegrees: 1.5,
} as const;

function isFinitePoint(p: LatLon | undefined): p is LatLon {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}

/**
 * Split every polyline at its unusable points (NaN, out of range) and drop
 * empty pieces. Splitting rather than filtering keeps a corrupt fix from
 * welding its neighbours into a segment that was never walked.
 */
function splitAtInvalidPoints(route: LatLon[] | LatLon[][]): LatLon[][] {
  const out: LatLon[][] = [];
  for (const polyline of toPolylines(route)) {
    let run: LatLon[] = [];
    for (const p of polyline) {
      if (isFinitePoint(p)) {
        run.push({ lat: p.lat, lon: p.lon });
      } else if (run.length > 0) {
        out.push(run);
        run = [];
      }
    }
    if (run.length > 0) {
      out.push(run);
    }
  }
  return out;
}

/**
 * Prepare `around:` polylines for querying.
 *
 * Each polyline is simplified with Douglas-Peucker at `radiusMeters / 4`;
 * consecutive polylines whose join gap is at most `joinGapMeters` (default
 * 2 x radius) are concatenated; the result is split into chunks of at most
 * `maxVertices` vertices that overlap by one vertex. `maxVertices` is floored
 * at 2. Short polylines are packed into shared queries by `packCorridorChunks`.
 */
export function buildCorridorChunks(
  route: LatLon[] | LatLon[][],
  radiusMeters: number,
  maxVertices = 300,
  joinGapMeters = radiusMeters * 2
): LatLon[][] {
  const limit = Math.max(2, Math.floor(maxVertices));
  const tolerance = Math.max(1, radiusMeters / 4);

  const joined: LatLon[][] = [];
  for (const clean of splitAtInvalidPoints(route)) {
    const simplified = douglasPeuckerIndices(clean, tolerance).map(i => ({
      lat: clean[i].lat,
      lon: clean[i].lon,
    }));

    const previous = joined[joined.length - 1];
    if (previous) {
      const tail = previous[previous.length - 1];
      const gap = haversineDistance(tail.lat, tail.lon, simplified[0].lat, simplified[0].lon);
      if (gap <= joinGapMeters) {
        previous.push(...simplified);
        continue;
      }
    }
    joined.push(simplified);
  }

  const chunks: LatLon[][] = [];
  for (const simplified of joined) {
    if (simplified.length <= limit) {
      chunks.push(simplified);
      continue;
    }
    // Overlap by one vertex so the segment straddling a chunk boundary is
    // still covered by the `around:` corridor of both chunks.
    for (let start = 0; start < simplified.length - 1; start += limit - 1) {
      chunks.push(simplified.slice(start, start + limit));
    }
  }
  return chunks;
}

/**
 * Group corridor polylines into as few queries as possible: in order, while
 * the group's vertex count stays within `maxVertices`.
 */
export function packCorridorChunks(polylines: LatLon[][], maxVertices = 300): LatLon[][][] {
  const limit = Math.max(1, Math.floor(maxVertices));
  const groups: LatLon[][][] = [];
  let current: LatLon[][] = [];
  let count = 0;
  for (const polyline of polylines) {
    if (polyline.length === 0) {
      continue;
    }
    if (current.length > 0 && count + polyline.length > limit) {
      groups.push(current);
      current = [];
      count = 0;
    }
    current.push(polyline);
    count += polyline.length;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

export interface RouteGeometry {
  /** All route points, flattened across tracks. */
  points: LatLon[];
  /** cumulativeKm[i] = km along the route at points[i]; a track gap adds nothing. */
  cumulativeKm: number[];
  /** Indices i where (i, i+1) is NOT a real segment (a track boundary). */
  segmentBreaks: Set<number>;
  /** ~150 m spaced sample indices, always including the first/last point of every track. */
  coarseIndices: number[];
}

/** Coarse sample spacing in km. */
const COARSE_SPACING_KM = 0.15;

/**
 * Flatten one or more tracks into the geometry `nearestPointOnRoute` needs.
 * Track boundaries are recorded in `segmentBreaks` and always forced into
 * `coarseIndices` (the pruning bound would otherwise under-state an interval
 * spanning a boundary).
 */
export function buildRouteGeometry(route: LatLon[] | LatLon[][]): RouteGeometry {
  const points: LatLon[] = [];
  const segmentBreaks = new Set<number>();

  for (const clean of splitAtInvalidPoints(route)) {
    if (points.length > 0) {
      segmentBreaks.add(points.length - 1);
    }
    for (const p of clean) {
      points.push({ lat: p.lat, lon: p.lon });
    }
  }

  const n = points.length;
  const cumulativeKm = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      cumulativeKm[0] = 0;
    } else if (segmentBreaks.has(i - 1)) {
      cumulativeKm[i] = cumulativeKm[i - 1];
    } else {
      cumulativeKm[i] =
        cumulativeKm[i - 1] +
        haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / 1000;
    }
  }

  const coarseIndices: number[] = [];
  let lastKept = -Infinity;
  for (let i = 0; i < n; i++) {
    const isTrackEdge = i === 0 || i === n - 1 || segmentBreaks.has(i) || segmentBreaks.has(i - 1);
    if (isTrackEdge || cumulativeKm[i] - lastKept >= COARSE_SPACING_KM) {
      coarseIndices.push(i);
      lastKept = cumulativeKm[i];
    }
  }

  return { points, cumulativeKm, segmentBreaks, coarseIndices };
}

export interface RouteProximity {
  /** Cross-track distance (km) to the nearest point of the polyline. */
  distanceKm: number;
  /** Index i of the segment (i, i+1) carrying the nearest point (or the vertex index). */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
  /** Nearer endpoint of that segment. */
  nearestPointIndex: number;
  /** cumulativeKm interpolated with t. */
  distanceAlongRouteKm: number;
}

/** Slack (km) applied to the coarse pruning bound. */
const PRUNE_EPSILON_KM = 1e-3;

/** Normalise a longitude difference into [-180, 180] so antimeridian routes work. */
function wrapLonDelta(dLon: number): number {
  let d = dLon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Local equirectangular projection centred on the POI, in metres. */
function projectMeters(poi: LatLon, cosLat0: number, p: LatLon): { x: number; y: number } {
  return {
    x: wrapLonDelta(p.lon - poi.lon) * cosLat0 * METERS_PER_DEGREE,
    y: (p.lat - poi.lat) * METERS_PER_DEGREE,
  };
}

/**
 * Nearest point on a route to a POI: exact point-to-SEGMENT distance, with a
 * coarse/fine two-pass search. Pass 1 measures every coarse sample; pass 2 only
 * opens a coarse interval whose triangle-inequality lower bound
 * `(d_a + d_b - along(a, b)) / 2` could beat the best so far. Segments in
 * `segmentBreaks` are never formed.
 */
export function nearestPointOnRoute(poi: LatLon, geom: RouteGeometry): RouteProximity {
  const { points, cumulativeKm, segmentBreaks, coarseIndices } = geom;
  const n = points.length;

  if (n === 0 || coarseIndices.length === 0) {
    return { distanceKm: Infinity, segmentIndex: 0, t: 0, nearestPointIndex: 0, distanceAlongRouteKm: 0 };
  }

  const cosLat0 = Math.cos((poi.lat * Math.PI) / 180);

  const coarseDistances = new Array<number>(coarseIndices.length);
  let bestVertexKm = Infinity;
  let bestVertexIndex = coarseIndices[0];
  for (let k = 0; k < coarseIndices.length; k++) {
    const p = projectMeters(poi, cosLat0, points[coarseIndices[k]]);
    const d = Math.hypot(p.x, p.y) / 1000;
    coarseDistances[k] = d;
    if (d < bestVertexKm) {
      bestVertexKm = d;
      bestVertexIndex = coarseIndices[k];
    }
  }

  let best = bestVertexKm;
  let bestSegKm = Infinity;
  let bestSegIndex = -1;
  let bestT = 0;

  for (let k = 0; k + 1 < coarseIndices.length; k++) {
    const a = coarseIndices[k];
    const b = coarseIndices[k + 1];
    const along = cumulativeKm[b] - cumulativeKm[a];
    const lowerBound = (coarseDistances[k] + coarseDistances[k + 1] - along) / 2;
    if (lowerBound - PRUNE_EPSILON_KM >= best) {
      continue;
    }

    for (let i = a; i < b; i++) {
      if (segmentBreaks.has(i)) {
        continue;
      }
      const A = projectMeters(poi, cosLat0, points[i]);
      const B = projectMeters(poi, cosLat0, points[i + 1]);
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = -(A.x * dx + A.y * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const px = A.x + t * dx;
      const py = A.y + t * dy;
      const d = Math.hypot(px, py) / 1000;
      if (d < bestSegKm) {
        bestSegKm = d;
        bestSegIndex = i;
        bestT = t;
        if (d < best) {
          best = d;
        }
      }
    }
  }

  if (bestSegIndex < 0 || bestVertexKm < bestSegKm) {
    return {
      distanceKm: bestVertexKm,
      segmentIndex: bestVertexIndex,
      t: 0,
      nearestPointIndex: bestVertexIndex,
      distanceAlongRouteKm: cumulativeKm[bestVertexIndex],
    };
  }

  const startKm = cumulativeKm[bestSegIndex];
  const endKm = cumulativeKm[bestSegIndex + 1];
  return {
    distanceKm: bestSegKm,
    segmentIndex: bestSegIndex,
    t: bestT,
    nearestPointIndex: bestT <= 0.5 ? bestSegIndex : bestSegIndex + 1,
    distanceAlongRouteKm: startKm + bestT * (endKm - startKm),
  };
}

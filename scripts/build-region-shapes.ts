/**
 * Builds `src/lib/region-shapes.ts`: coarse outlines of every country and
 * state/region listed in `src/lib/trail-regions.ts`, for `@lib/region-detect`,
 * plus the unlisted countries that share a land border with one of them.
 *
 * Source: Natural Earth 1:50m Admin 0 (countries) and Admin 1 (Australia's
 * states and territories), public domain. New Zealand's regions (North,
 * South, Stewart Island) are the country's own island polygons, picked out by
 * where each one lies.
 *
 * - **Borders are simplified once.** A run of vertices two shapes share (a
 *   land border) is cut out at its ends and simplified at `BORDER_DEG`, so
 *   both neighbours keep the same line and a point near a border is not in
 *   both shapes, or in neither. Coastlines are simplified at `COAST_DEG`.
 * - **Unlisted neighbours** (Lesotho, Andorra, Mexico, Russia, …) are kept as
 *   `other` shapes, at a coarser coastline, so a route inside one is reported
 *   as that country instead of being pulled into the listed one next door by
 *   the detector's nearest-shape fallback.
 * - **Small islands are dropped** below `MIN_RING_AREA`, a larger one in the
 *   Arctic, where Canada's archipelago would be most of the file; hiking
 *   islands (Kauai, Lofoten's Moskenesøya) stay. The longest coastlines
 *   (`LONG_COAST`) are simplified more; their borders are not.
 *
 * Coordinates are stored as integer thousandths of a degree, each vertex as
 * its step from the one before.
 *
 *   NODE_USE_ENV_PROXY=1 npm run build:region-shapes   (behind a proxy)
 *   npm run build:region-shapes -- <dir>   (read the two .geojson files from <dir>)
 *
 * Run it again only when a country or state is added to `trail-regions.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from '../src/lib/trail-regions';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'region-shapes.ts');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const COUNTRY_FILE = 'ne_50m_admin_0_countries.geojson';
const STATE_FILE = 'ne_50m_admin_1_states_provinces.geojson';

/** Stored precision: thousandths of a degree (~100 m). Vertices are matched across shapes at this precision. */
const SCALE = 1000;
/** Simplification tolerance for a shared land border, degrees (~500 m). */
const BORDER_DEG = 0.005;
/** Simplification tolerance for a listed shape's coastline, degrees (~5 km) … */
const COAST_DEG = 0.05;
/** … and ~10 km for the countries whose coastlines would be most of the file. */
const LONG_COAST_DEG = 0.1;
const LONG_COAST = new Set(['CA', 'US', 'NO', 'CL', 'AR']);
/** … and for an unlisted neighbour's coastline (~20 km): only its land borders need to be exact. */
const OTHER_COAST_DEG = 0.2;
/** Rings smaller than this (square degrees, ~100 km² in the tropics) are dropped … */
const MIN_RING_AREA = 0.01;
/** … and in the Arctic, smaller than this: above 70°, or above 60° in Canada (Hudson Bay, Baffin). */
const ARCTIC_MIN_RING_AREA = 0.5;
const ARCTIC_LAT = 70;
const CANADA_ARCTIC_LAT = 60;
/** An unlisted neighbour's rings that touch no listed shape are kept only above this area. */
const OTHER_MIN_RING_AREA = 0.5;

/** Natural Earth's postal codes → ours. Jervis Bay Territory is left out (the nearest shape, NSW, takes it). */
const AU_STATES: Record<string, string> = {
  NS: 'NSW',
  CT: 'ACT',
  VI: 'VIC',
  TS: 'TAS',
  SA: 'SA',
  WA: 'WA',
  NT: 'NT',
  QL: 'QLD',
};

type Ring = [number, number][];
type Polygon = Ring[];
interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: 'Polygon'; coordinates: Polygon } | { type: 'MultiPolygon'; coordinates: Polygon[] };
}

async function load(dir: string | undefined, file: string): Promise<Feature[]> {
  const text = dir ? readFileSync(join(dir, file), 'utf8') : await (await fetch(`${BASE}/${file}`)).text();
  return (JSON.parse(text) as { features: Feature[] }).features;
}

function polygons(f: Feature): Polygon[] {
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
}

/** A ring as integer vertices at `SCALE`, open (no repeated closing point), no repeated neighbours. */
type IntRing = [number, number][];

function quantise(ring: Ring): IntRing {
  const out: IntRing = [];
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * SCALE);
    const y = Math.round(lat * SCALE);
    const last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function ringArea(ring: IntRing): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a) / 2 / (SCALE * SCALE);
}

function centroidLat(ring: IntRing): number {
  let lat = 0;
  for (const [, y] of ring) lat += y;
  return lat / ring.length / SCALE;
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker over an open run, ends kept; tolerance in degrees. */
function simplifyRun(run: IntRing, toleranceDeg: number): IntRing {
  if (run.length <= 2) return run;
  const tolerance = toleranceDeg * SCALE;
  const keep = new Uint8Array(run.length);
  keep[0] = 1;
  keep[run.length - 1] = 1;
  const stack: [number, number][] = [[0, run.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(run[i], run[from], run[to]);
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  return run.filter((_, i) => keep[i] === 1);
}

const key = ([x, y]: [number, number]): string => `${x},${y}`;

interface SourceShape {
  country: string;
  state: string | null;
  other: boolean;
  rings: IntRing[];
}

interface Shape {
  country: string;
  state: string | null;
  other: boolean;
  rings: number[][];
}

/**
 * Simplify every shape's rings so that a run of vertices shared with another
 * ring is simplified the same way in both: each ring is cut where it joins or
 * leaves a shared run, and each piece is simplified with its ends fixed.
 */
function simplifyAll(sources: SourceShape[], shared: Map<string, number>, listedVertices: Set<string>): Shape[] {
  return sources.map(source => {
    const rings: number[][] = [];
    for (const ring of source.rings) {
      const n = ring.length;
      const sharedAt = ring.map(p => (shared.get(key(p)) ?? 0) > 1);
      // A cut where a shared run begins or ends, or where three shapes meet.
      const cuts: number[] = [];
      for (let i = 0; i < n; i++) {
        const prev = sharedAt[(i - 1 + n) % n];
        const next = sharedAt[(i + 1) % n];
        if (sharedAt[i] && (!prev || !next || (shared.get(key(ring[i])) ?? 0) > 2)) cuts.push(i);
      }
      if (cuts.length === 0) {
        // No border: an island, or a ring wholly shared. Cut at its first vertex and its farthest from that.
        let far = 0;
        let farDist = -1;
        for (let i = 1; i < n; i++) {
          const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
          if (d > farDist) {
            far = i;
            farDist = d;
          }
        }
        cuts.push(0, far);
      }
      const out: IntRing = [];
      for (let c = 0; c < cuts.length; c++) {
        const from = cuts[c];
        const to = cuts[(c + 1) % cuts.length];
        const run: IntRing = [];
        for (let i = from; ; i = (i + 1) % n) {
          run.push(ring[i]);
          if (i === to && run.length > 1) break;
          if (run.length > n + 1) break;
        }
        // A border with a listed shape on it; one between two unlisted neighbours is drawn like their coast.
        const border = run.every(p => (shared.get(key(p)) ?? 0) > 1 && listedVertices.has(key(p)));
        const tolerance = border
          ? BORDER_DEG
          : source.other
            ? OTHER_COAST_DEG
            : LONG_COAST.has(source.country)
              ? LONG_COAST_DEG
              : COAST_DEG;
        const simplified = simplifyRun(run, tolerance);
        out.push(...simplified.slice(0, -1));
      }
      if (out.length >= 3) rings.push(deltaEncode(out));
    }
    return { country: source.country, state: source.state, other: source.other, rings };
  });
}

/** `[x0, y0, dx1, dy1, …]`: the first vertex, then each one's step from the last (most steps are two or three digits). */
function deltaEncode(ring: IntRing): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of ring) {
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

/** Which of New Zealand's regions an island ring belongs to, or null (Chathams, sub-Antarctic islands). */
function nzRegion(ring: Ring): string | null {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  lon /= ring.length;
  lat /= ring.length;
  if (lon < 165 || lon > 179) return null;
  if (lat < -47.4) return null;
  if (lat < -46.6 && lon > 167.3 && lon < 168.5) return 'STI';
  if (lat > -40.3 || (lat > -41.7 && lon > 174.5)) return 'NI';
  if (lat > -47) return 'SI';
  return null;
}

function keepRing(ring: IntRing, country: string): boolean {
  if (ring.length < 3) return false;
  const arctic = Math.abs(centroidLat(ring)) > (country === 'CA' ? CANADA_ARCTIC_LAT : ARCTIC_LAT);
  const min = arctic ? ARCTIC_MIN_RING_AREA : MIN_RING_AREA;
  return ringArea(ring) >= min;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const [countries, states] = await Promise.all([load(dir, COUNTRY_FILE), load(dir, STATE_FILE)]);
  const listed: SourceShape[] = [];
  const listedCodes = new Set(COUNTRIES.map(c => c.code));

  for (const def of COUNTRIES) {
    const feature = countries.find(f => f.properties.ISO_A2_EH === def.code && f.properties.TYPE !== 'Dependency');
    if (!feature) throw new Error(`Natural Earth has no country ${def.code}`);
    const rings = (raw: Ring[]): IntRing[] => raw.map(quantise).filter(r => keepRing(r, def.code));
    // A country with states is the union of its states' shapes: no outline of its own.
    if (def.states.length === 0) {
      listed.push({ country: def.code, state: null, other: false, rings: rings(polygons(feature).flat()) });
    } else if (def.code === 'AU') {
      for (const f of states) {
        if (f.properties.iso_a2 !== 'AU') continue;
        const code = AU_STATES[String(f.properties.postal)];
        if (code) listed.push({ country: 'AU', state: code, other: false, rings: rings(polygons(f).flat()) });
      }
    } else if (def.code === 'NZ') {
      for (const region of def.states) {
        const raw = polygons(feature)
          .filter(poly => nzRegion(poly[0]) === region.code)
          .flat();
        listed.push({ country: 'NZ', state: region.code, other: false, rings: rings(raw) });
      }
    } else {
      throw new Error(`No source for ${def.code}'s states`);
    }
    for (const region of def.states) {
      if (!listed.some(s => s.country === def.code && s.state === region.code && s.rings.length > 0)) {
        throw new Error(`No shape for ${def.code} ${region.code}`);
      }
    }
  }

  const listedVertices = new Set<string>();
  for (const s of listed) for (const r of s.rings) for (const p of r) listedVertices.add(key(p));

  // Unlisted countries with a land border on a listed shape.
  const others: SourceShape[] = [];
  for (const f of countries) {
    const code = String(f.properties.ISO_A2_EH);
    if (!/^[A-Z]{2}$/.test(code) || listedCodes.has(code)) continue;
    const all = polygons(f).flat().map(quantise);
    if (!all.some(r => r.some(p => listedVertices.has(key(p))))) continue;
    const rings = all.filter(
      r =>
        r.length >= 3 &&
        (r.some(p => listedVertices.has(key(p))) || (keepRing(r, code) && ringArea(r) >= OTHER_MIN_RING_AREA))
    );
    const existing = others.find(o => o.country === code);
    if (existing) existing.rings.push(...rings);
    else others.push({ country: code, state: null, other: true, rings });
  }

  const sources = [...listed, ...others];
  // How many rings each vertex is on, counting a ring once.
  const shared = new Map<string, number>();
  for (const s of sources) {
    for (const r of s.rings) {
      for (const k of new Set(r.map(key))) shared.set(k, (shared.get(k) ?? 0) + 1);
    }
  }
  const shapes = simplifyAll(sources, shared, listedVertices);

  const body = shapes
    .map(
      s =>
        `  {\n    country: '${s.country}',\n    state: ${s.state ? `'${s.state}'` : 'null'},\n` +
        (s.other ? '    other: true,\n' : '') +
        '    rings: [\n' +
        s.rings.map(r => `      [${r.join(',')}],\n`).join('') +
        '    ],\n  },\n'
    )
    .join('');
  const out =
    '/**\n' +
    ' * Coarse outlines of the countries and states in `trail-regions.ts`, and of\n' +
    ' * the unlisted countries bordering them (`other`), for `region-detect.ts`.\n' +
    ' * Generated by `scripts/build-region-shapes.ts` from Natural Earth 1:50m\n' +
    ' * (public domain); do not edit by hand.\n' +
    ' *\n' +
    ' * Each ring is a flat `[lon, lat, dLon, dLat, …]` list in thousandths of a\n' +
    ' * degree: the first vertex, then each one as its step from the one before.\n' +
    " * Rings close implicitly. A shape's rings are tested even-odd, so holes\n" +
    ' * (Lesotho in South Africa) need no marking.\n' +
    ' */\n\n' +
    'export interface RegionShape {\n' +
    '  /** ISO 3166-1 alpha-2. */\n' +
    '  country: string;\n' +
    '  /** A state code from `trail-regions.ts`, or null for the whole country. */\n' +
    '  state: string | null;\n' +
    '  /** A country `trail-regions.ts` does not list, kept so a route inside it is not taken for its neighbour. */\n' +
    '  other?: true;\n' +
    '  rings: readonly (readonly number[])[];\n' +
    '}\n\n' +
    `export const REGION_SHAPE_SCALE = ${SCALE};\n\n` +
    'export const REGION_SHAPES: readonly RegionShape[] = [\n' +
    body +
    '];\n';
  writeFileSync(OUT, out);
  const points = shapes.reduce((n, s) => n + s.rings.reduce((m, r) => m + r.length / 2, 0), 0);
  console.log(
    `Wrote ${OUT}: ${shapes.length} shapes (${others.length} unlisted neighbours: ${others.map(o => o.country).join(' ')}), ` +
      `${points} points, ${(out.length / 1024).toFixed(0)} kB`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

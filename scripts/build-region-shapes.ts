/**
 * Builds `src/lib/region-shapes.ts`: coarse outlines of every country and
 * state/region listed in `src/lib/trail-regions.ts`, for `@lib/region-detect`.
 *
 * Source: Natural Earth 1:50m Admin 0 (countries) and Admin 1 (Australia's
 * states and territories), public domain. New Zealand's regions (North,
 * South, Stewart Island) are the country's own island polygons, picked out by
 * where each one lies. The shapes are simplified (Douglas-Peucker at
 * `DETAIL`, coarser for the largest coastlines), small islands are dropped, and coordinates are stored as
 * integer hundredths of a degree, so the detector ships in the web and phone
 * bundles at a few tens of kB. Coastal tracks that fall just outside a coarse
 * coastline are caught by the detector's nearest-shape fallback, not here.
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

/** Simplification tolerance, degrees (~5 km), and rings smaller than this (square degrees, ~100 km²) are dropped. */
const DETAIL = { toleranceDeg: 0.05, minRingArea: 0.01 };
/**
 * Coarser for the countries whose coastlines are most of the file (Canada's
 * and the US's Arctic and Alaskan islands, Norway's and Chile's fjords).
 */
const COARSE = { toleranceDeg: 0.1, minRingArea: 0.2 };
const COARSE_COUNTRIES = new Set(['CA', 'US', 'NO', 'CL']);
/** Stored precision: hundredths of a degree (~1 km). */
const SCALE = 100;

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

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a) / 2;
}

function ringCentroid(ring: Ring): [number, number] {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(ring: Ring, toleranceDeg: number): Ring {
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let worstDist = toleranceDeg;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(ring[i], ring[from], ring[to]);
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
  return ring.filter((_, i) => keep[i] === 1);
}

/** Simplified, rounded rings as flat integer arrays; the closing point is implied. */
function encode(rings: Ring[], detail = DETAIL): number[][] {
  const out: number[][] = [];
  for (const ring of rings) {
    if (ringArea(ring) < detail.minRingArea) continue;
    const flat: number[] = [];
    let prev = '';
    for (const [lon, lat] of simplify(ring.slice(0, -1).concat([ring[0]]), detail.toleranceDeg)) {
      const x = Math.round(lon * SCALE);
      const y = Math.round(lat * SCALE);
      const key = `${x},${y}`;
      if (key === prev) continue;
      prev = key;
      flat.push(x, y);
    }
    // Drop the repeated closing point.
    if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) flat.length -= 2;
    if (flat.length >= 6) out.push(flat);
  }
  return out;
}

/** Which of New Zealand's regions an island ring belongs to, or null (Chathams, sub-Antarctic islands). */
function nzRegion(ring: Ring): string | null {
  const [lon, lat] = ringCentroid(ring);
  if (lon < 165 || lon > 179) return null;
  if (lat < -47.4) return null;
  if (lat < -46.6 && lon > 167.3 && lon < 168.5) return 'STI';
  if (lat > -40.3 || (lat > -41.7 && lon > 174.5)) return 'NI';
  if (lat > -47) return 'SI';
  return null;
}

interface Shape {
  country: string;
  state: string | null;
  rings: number[][];
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const [countries, states] = await Promise.all([load(dir, COUNTRY_FILE), load(dir, STATE_FILE)]);
  const shapes: Shape[] = [];

  for (const def of COUNTRIES) {
    const feature = countries.find((f) => f.properties.ISO_A2_EH === def.code && f.properties.TYPE !== 'Dependency');
    if (!feature) throw new Error(`Natural Earth has no country ${def.code}`);
    // A country with states is the union of its states' shapes: no outline of its own.
    if (def.states.length === 0) {
      shapes.push({ country: def.code, state: null, rings: encode(polygons(feature).flat(), COARSE_COUNTRIES.has(def.code) ? COARSE : DETAIL) });
    }

    if (def.code === 'AU') {
      for (const f of states) {
        if (f.properties.iso_a2 !== 'AU') continue;
        const code = AU_STATES[String(f.properties.postal)];
        if (!code) continue;
        shapes.push({ country: 'AU', state: code, rings: encode(polygons(f).flat()) });
      }
    } else if (def.code === 'NZ') {
      for (const region of def.states) {
        const rings = polygons(feature)
          .filter((poly) => nzRegion(poly[0]) === region.code)
          .flat();
        shapes.push({ country: 'NZ', state: region.code, rings: encode(rings) });
      }
    }
    for (const region of def.states) {
      if (!shapes.some((s) => s.country === def.code && s.state === region.code && s.rings.length > 0)) {
        throw new Error(`No shape for ${def.code} ${region.code}`);
      }
    }
  }

  const body = shapes
    .map(
      (s) =>
        `  {\n    country: '${s.country}',\n    state: ${s.state ? `'${s.state}'` : 'null'},\n    rings: [\n` +
        s.rings.map((r) => `      [${r.join(',')}],\n`).join('') +
        '    ],\n  },\n'
    )
    .join('');
  const out =
    '/**\n' +
    ' * Coarse outlines of the countries and states in `trail-regions.ts`, for\n' +
    ' * `region-detect.ts`. Generated by `scripts/build-region-shapes.ts` from\n' +
    ' * Natural Earth 1:50m (public domain); do not edit by hand.\n' +
    ' *\n' +
    ' * Each ring is a flat `[lon, lat, lon, lat, …]` list in hundredths of a\n' +
    ' * degree, closed implicitly. A shape\'s rings are tested even-odd, so holes\n' +
    ' * (Lesotho in South Africa) need no marking.\n' +
    ' */\n\n' +
    'export interface RegionShape {\n' +
    '  /** ISO 3166-1 alpha-2. */\n' +
    '  country: string;\n' +
    '  /** A state code from `trail-regions.ts`, or null for the whole country. */\n' +
    '  state: string | null;\n' +
    '  rings: readonly (readonly number[])[];\n' +
    '}\n\n' +
    'export const REGION_SHAPE_SCALE = 100;\n\n' +
    'export const REGION_SHAPES: readonly RegionShape[] = [\n' +
    body +
    '];\n';
  writeFileSync(OUT, out);
  const points = shapes.reduce((n, s) => n + s.rings.reduce((m, r) => m + r.length / 2, 0), 0);
  console.log(`Wrote ${OUT}: ${shapes.length} shapes, ${points} points, ${(out.length / 1024).toFixed(0)} kB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

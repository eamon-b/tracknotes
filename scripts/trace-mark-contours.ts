/**
 * Traces the contour lines drawn in the Tracknotes mark (app icon, splash,
 * favicons) from real terrain: Mt Sonder (Rwetyepme), the high point of the
 * Larapinta Trail, out of Copernicus GLO-30.
 *
 * Hand-drawn rings read as a target or a fingerprint; real contours have spurs
 * and gullies, crowd where the slope steepens and wrap a ridge rather than a
 * point. Writes `mobile/scripts/data/mark-contours.json`, which
 * `mobile/scripts/build-app-icons.mjs` draws without touching the network.
 *
 *   NODE_USE_ENV_PROXY=1 npm run trace:mark-contours   (behind a proxy)
 *
 * Elevation: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and
 * © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the
 * European Union and ESA; all rights reserved.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contours } from 'd3-contour';
import { CopernicusDem } from './lib/dem-sampler';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'scripts', 'data', 'mark-contours.json');

/** Mt Sonder's summit, approximately; the highest point within SEARCH_M is used. */
const PEAK = { lat: -23.583, lon: 132.574 };
const SEARCH_M = 600;
/** The square the icon shows, and the grid it is sampled on. */
const VIEW_M = 4000;
const CELL_M = 30;
/** Sampled wider than shown, so the smoothing has no edge effects in view. */
const MARGIN_M = 1000;
/** Gaussian smoothing in cells: GLO-30 is a surface model, so canopy reads as bumps. */
const SIGMA = 3.5;
/** Levels: LEVELS steps down from TOP steps below the summit to the lowest point in view. */
const LEVELS = 6;
const TOP = 1.3;
/** Where the summit sits on the 1024 canvas. */
const SUMMIT = [584, 392] as const;
/** Rings enclosing less than this (canvas units²) are dropped: knolls read as noise. */
const MIN_AREA = 1500;

type Pt = [number, number];

function blur(a: Float64Array, n: number, s: number): Float64Array {
  const r = Math.ceil(s * 3);
  const k: number[] = [];
  let t = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) / (2 * s * s));
    k.push(w);
    t += w;
  }
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  const b = new Float64Array(a.length);
  const c = new Float64Array(a.length);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let q = -r; q <= r; q++) v += k[q + r] * a[j * n + clamp(i + q)];
      b[j * n + i] = v / t;
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let q = -r; q <= r; q++) v += k[q + r] * b[clamp(j + q) * n + i];
      c[j * n + i] = v / t;
    }
  return c;
}

/** Two rounds of Chaikin corner cutting (marching squares draws in steps), then thinned to ~12 units. */
function smooth(ring: Pt[]): Pt[] {
  let p = ring;
  for (let round = 0; round < 2; round++) {
    const q: Pt[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      q.push(
        [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
        [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]
      );
    }
    p = q;
  }
  const out: Pt[] = [p[0]];
  for (const pt of p) {
    const last = out[out.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 12) out.push(pt);
  }
  return out;
}

function area(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

async function main(): Promise<void> {
  const half = VIEW_M / 2 + MARGIN_M;
  const n = Math.round((2 * half) / CELL_M);
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((PEAK.lat * Math.PI) / 180);
  const dem = new CopernicusDem();
  await dem.load({
    west: PEAK.lon - half / mPerDegLon,
    east: PEAK.lon + half / mPerDegLon,
    south: PEAK.lat - half / mPerDegLat,
    north: PEAK.lat + half / mPerDegLat,
  });
  // Row 0 is north: the grid is the map as drawn.
  let grid: Float64Array = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * CELL_M;
      const y = half - (j + 0.5) * CELL_M;
      const h = dem.at(PEAK.lat + y / mPerDegLat, PEAK.lon + x / mPerDegLon);
      if (h === null) throw new Error(`No elevation at cell ${i},${j}`);
      grid[j * n + i] = h;
    }
  grid = blur(grid, n, SIGMA);

  let summit = -Infinity;
  let si = 0;
  let sj = 0;
  const search = Math.round(SEARCH_M / CELL_M);
  for (let j = n / 2 - search; j < n / 2 + search; j++)
    for (let i = n / 2 - search; i < n / 2 + search; i++) {
      const v = grid[Math.floor(j) * n + Math.floor(i)];
      if (v > summit) [summit, si, sj] = [v, Math.floor(i), Math.floor(j)];
    }
  const cellsInView = VIEW_M / CELL_M;
  const toCanvas = ([i, j]: Pt): Pt => [
    SUMMIT[0] + ((i - si - 0.5) / cellsInView) * 1024,
    SUMMIT[1] + ((j - sj - 0.5) / cellsInView) * 1024,
  ];

  let lowest = Infinity;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [x, y] = toCanvas([i + 0.5, j + 0.5]);
      if (x >= 0 && x <= 1024 && y >= 0 && y <= 1024) lowest = Math.min(lowest, grid[j * n + i]);
    }
  const step = (summit - lowest) / (LEVELS + TOP - 0.1);
  const thresholds = Array.from({ length: LEVELS }, (_, k) => summit - step * (k + TOP));

  const traced = contours().size([n, n]).thresholds(thresholds)(Array.from(grid));
  const levels = traced
    .map(level => ({
      elevation: Math.round(level.value),
      rings: level.coordinates
        .flatMap(polygon => polygon.map(ring => smooth((ring as Pt[]).map(toCanvas))))
        .filter(ring => area(ring) > MIN_AREA)
        .map(ring => ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])),
    }))
    .sort((a, b) => b.elevation - a.elevation);

  const out = {
    source: 'Copernicus GLO-30 (traced by scripts/trace-mark-contours.ts)',
    attribution:
      'Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.',
    place: 'Mt Sonder (Rwetyepme), Larapinta Trail',
    summitM: Math.round(summit),
    intervalM: Math.round(step),
    viewM: VIEW_M,
    summit: SUMMIT,
    levels,
  };
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.log(`wrote ${OUT}: ${levels.length} levels, ${Math.round(step)} m apart, summit ${Math.round(summit)} m`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

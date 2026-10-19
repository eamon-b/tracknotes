/**
 * How much CPU the comments API's community-route POI enrichment spends on one
 * route, step by step, so its cost can be weighed against the Workers plan's
 * CPU limit (Free: 10 ms per invocation; see `docs/architecture/workers.md`,
 * "community route POIs"). Waiting on Overpass is wall time and is not
 * measured; everything the Worker computes is.
 *
 *   npx tsx scripts/measure-community-poi-cpu.ts [trail-id ...]
 *
 * Reads `public/data/generated/<id>.json` (run `npm run build:trails` first;
 * default: heysen, bibbulmun) as the stored route, and times, as the
 * enrichment runs them: parsing the stored JSON, planning the corridor
 * queries and hashing them, parsing the Overpass answers, placing and
 * finishing the POIs (`finishRoutePois`, grid placement), the change check,
 * and re-encoding the trail with its md5. Two answers per trail: the trail's
 * real POIs (`data/trails/<dir>/pois.json`, as Overpass elements) and a
 * synthetic dense one at the enrichment's own cap (`POI_LIMITS.maxFetchedPois`
 * elements within 2.5 km of the route, ~2 MB of JSON). Node's V8 is the
 * engine workerd runs, so the numbers carry over within a small factor; the
 * first run is closer to a cold isolate than the median.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import * as communityPois from '../workers/comments-api/src/community-pois';
import type { POI } from '../src/lib/osm-poi';
import type { ProcessedTrail } from '../src/lib/trail-types';

// The worker's package is CommonJS (no "type": "module"), so under tsx its
// exports arrive as the namespace's default.
const { POI_LIMITS, finishRoutePois, parseOverpassAnswer, planPoiQueries, queryHash } =
  (communityPois as unknown as { default?: typeof communityPois }).default ?? communityPois;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 5;

interface Timing {
  first: number;
  median: number;
}

async function time<T>(fn: () => T | Promise<T>): Promise<{ result: T; timing: Timing }> {
  const samples: number[] = [];
  let result!: T;
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    result = await fn();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { result, timing: { first: samples[0], median: sorted[Math.floor(sorted.length / 2)] } };
}

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTHETIC_TAGS: Record<string, string>[] = [
  { amenity: 'drinking_water' },
  { tourism: 'camp_site', name: 'Synthetic Camp', fee: 'no', toilets: 'yes' },
  { shop: 'supermarket', name: 'Corner Store', opening_hours: 'Mo-Su 08:00-18:00', brand: 'X', building: 'retail' },
  { amenity: 'cafe', name: 'Trailside Cafe', opening_hours: 'Mo-Fr 07:00-15:00', website: 'https://example.com' },
  { highway: 'bus_stop', name: 'Main Rd After Creek Rd' },
  { amenity: 'shelter', shelter_type: 'basic_hut' },
  { amenity: 'toilets', access: 'yes' },
  { tourism: 'alpine_hut', name: 'Synthetic Hut' },
];

/** `count` Overpass elements scattered within ~2.5 km of the route, as Overpass would send them. */
function syntheticAnswer(points: { lat: number; lon: number }[], count: number): Uint8Array {
  const random = rng(count);
  const elements = Array.from({ length: count }, (_, i) => {
    const p = points[Math.floor(random() * points.length)];
    const lat = p.lat + (random() * 2 - 1) * 0.0225;
    const lon = p.lon + (random() * 2 - 1) * 0.0225;
    const tags = SYNTHETIC_TAGS[i % SYNTHETIC_TAGS.length];
    return i % 5 === 0
      ? { type: 'way', id: 10_000_000 + i, center: { lat, lon }, tags }
      : { type: 'node', id: 10_000_000 + i, lat, lon, tags };
  });
  return new TextEncoder().encode(JSON.stringify({ version: 0.6, generator: 'synthetic', elements }));
}

/** The trail's committed `pois.json`, turned back into an Overpass answer. */
function realAnswer(id: string): Uint8Array | null {
  const dirs = readdirSync(join(ROOT, 'data/trails'));
  const dir = dirs.find((d) => d.toLowerCase().replace(/[-_]/g, '') === id.toLowerCase().replace(/[-_]/g, ''));
  const file = dir ? join(ROOT, 'data/trails', dir, 'pois.json') : null;
  if (!file || !existsSync(file)) return null;
  const { pois } = JSON.parse(readFileSync(file, 'utf8')) as {
    pois: { id: number; type: string; lat: number; lon: number; tags?: Record<string, string> }[];
  };
  const elements = pois.map((p) =>
    p.type === 'node'
      ? { type: p.type, id: p.id, lat: p.lat, lon: p.lon, tags: p.tags ?? {} }
      : { type: p.type, id: p.id, center: { lat: p.lat, lon: p.lon }, tags: p.tags ?? {} }
  );
  return new TextEncoder().encode(JSON.stringify({ version: 0.6, elements }));
}

function fmt(t: Timing): string {
  return `${t.median.toFixed(1).padStart(7)} ms (first ${t.first.toFixed(1)})`;
}

async function measure(id: string): Promise<void> {
  const file = join(ROOT, 'public/data/generated', `${id}.json`);
  if (!existsSync(file)) {
    console.error(`${id}: ${file} is missing — run npm run build:trails`);
    return;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ProcessedTrail;
  // Stored as a submit stores it: no POIs yet.
  const { pois: _bundled, ...withoutPois } = raw;
  const storedText = JSON.stringify(withoutPois);
  const mb = storedText.length / 1e6;
  console.log(`\n${id}: stored JSON ${mb.toFixed(1)} MB (community routes are capped at 4 MB), ${raw.track.points.length} track points`);

  const parse = await time(() => JSON.parse(storedText) as ProcessedTrail);
  const trail = parse.result;
  const plan = await time(() => planPoiQueries(trail));
  const hashes = await time(() => Promise.all(plan.result.queries.map((q) => queryHash('salt', q))));
  console.log(`  parse stored trail      ${fmt(parse.timing)}`);
  console.log(`  plan ${String(plan.result.queries.length).padStart(2)} queries         ${fmt(plan.timing)}`);
  console.log(`  hash queries            ${fmt(hashes.timing)}`);
  const fixed = parse.timing.median + plan.timing.median + hashes.timing.median;

  const answers: [string, Uint8Array | null][] = [
    ['real POIs', realAnswer(id)],
    [`synthetic ${POI_LIMITS.maxFetchedPois}`, syntheticAnswer(plan.result.corridor.geometry.points, POI_LIMITS.maxFetchedPois)],
  ];
  for (const [label, answer] of answers) {
    if (!answer) continue;
    const parsed = await time(() => parseOverpassAnswer(answer));
    const fetched: POI[] = parsed.result;
    const finished = await time(() => finishRoutePois(trail, plan.result, fetched));
    const pois = finished.result.kind === 'ok' ? finished.result.pois : [];
    const compare = await time(() => JSON.stringify(pois) !== JSON.stringify(trail.pois ?? []));
    const encode = await time(() => {
      const body = new TextEncoder().encode(JSON.stringify({ ...trail, pois }));
      return createHash('md5').update(body).digest('hex');
    });
    const total = fixed + parsed.timing.median + finished.timing.median + compare.timing.median + encode.timing.median;
    console.log(`  — ${label}: ${(answer.byteLength / 1e6).toFixed(2)} MB answer, ${fetched.length} elements → ${pois.length} POIs (${finished.result.kind})`);
    console.log(`    parse answer          ${fmt(parsed.timing)}`);
    console.log(`    place + finish        ${fmt(finished.timing)}`);
    console.log(`    change check          ${fmt(compare.timing)}`);
    console.log(`    encode + md5          ${fmt(encode.timing)}`);
    console.log(`    total (medians)       ${total.toFixed(1).padStart(7)} ms`);
  }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  for (const id of ids.length > 0 ? ids : ['heysen', 'bibbulmun']) await measure(id);
}

void main();

/**
 * The `src/lib` port of gpx-tools' POI search must stay byte-for-byte the
 * library it came from: `scripts/fetch-pois.ts` moved onto the port, and the
 * committed `data/trails/<dir>/pois.json` files were written by the library.
 * Same catalog, same query text, same corridor chunks, same placement — given
 * the same Overpass answers, the same `pois.json`.
 *
 * Runs over real trail geometry (the bundled mobile assets) so the corridor
 * simplification, chunking and packing are exercised on shapes that matter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import * as upstreamOsm from 'gpx-tools/lib/osm-poi';
import * as upstreamClient from 'gpx-tools/lib/overpass-client';
import * as upstreamEnrich from 'gpx-tools/lib/poi-enrichment';

import * as osm from '../src/lib/osm-poi.js';
import * as client from '../src/lib/overpass-client.js';
import * as enrich from '../src/lib/poi-enrichment.js';
import { buildRouteScale, toTrailPOIs } from '../src/lib/trail-pois.js';
import type { ProcessedTrail } from '../src/lib/trail-types.js';

const TRAILS_DIR = path.resolve(__dirname, '../mobile/assets/trails');
const TRAILS = ['cape_to_cape', 'heysen', 'overland', 'three_capes', 'te_araroa'];
/** Placement is the slow part (every fake element against the whole route); Te Araroa's chunks are enough. */
const PLACED_TRAILS = new Set(['cape_to_cape', 'heysen', 'overland', 'three_capes']);

function loadTrail(id: string): ProcessedTrail {
  return JSON.parse(fs.readFileSync(path.join(TRAILS_DIR, `${id}.json`), 'utf-8')) as ProcessedTrail;
}

/** Every rule's primary tag, plus a few conflicting combinations. */
function tagCases(): Record<string, string>[] {
  const cases: Record<string, string>[] = [];
  for (const rules of Object.values(osm.POI_CATALOG)) {
    for (const rule of rules) {
      cases.push({ [rule.key]: rule.value });
      cases.push({ [rule.key]: rule.value, drinking_water: 'yes' });
      cases.push({ [rule.key]: rule.value, shelter_type: 'public_transport', highway: 'bus_stop' });
    }
  }
  cases.push({ amenity: 'toilets', drinking_water: 'yes' });
  cases.push({ amenity: 'shelter', shelter_type: 'public_transport' });
  cases.push({ tourism: 'viewpoint' });
  return cases;
}

/**
 * A deterministic stand-in for Overpass: for every corridor vertex, a few
 * elements at fixed offsets (some inside the 2 km radius, some outside), with
 * tags drawn round-robin from `tagCases`, and repeated ids across queries so
 * the dedupe path is exercised.
 */
function fakeElements(area: upstreamOsm.OverpassArea): upstreamOsm.POI[] {
  if (!('corridor' in area)) return [];
  const cases = tagCases();
  const polylines = (Array.isArray(area.corridor[0]) ? area.corridor : [area.corridor]) as upstreamOsm.LatLon[][];
  const out: upstreamOsm.POI[] = [];
  for (const polyline of polylines) {
    for (const vertex of polyline) {
      const seed = Math.abs(Math.round(vertex.lat * 1e4) * 31 + Math.round(vertex.lon * 1e4));
      for (const [k, offset] of [0.004, 0.012, 0.025, -0.018].entries()) {
        out.push({
          id: seed * 10 + k,
          type: k % 2 === 0 ? 'node' : 'way',
          lat: vertex.lat + offset,
          lon: vertex.lon - offset / 2,
          tags: { ...cases[(seed + k) % cases.length], name: `Place ${seed % 997}` },
        });
      }
    }
  }
  return out;
}

describe('src/lib osm-poi matches gpx-tools', () => {
  it('has the same catalog and type order', () => {
    expect(osm.POI_TYPES).toEqual(upstreamOsm.POI_TYPES);
    expect(osm.POI_CATALOG).toEqual(upstreamOsm.POI_CATALOG);
    expect(osm.CORRIDOR_LIMITS).toEqual(upstreamOsm.CORRIDOR_LIMITS);
  });

  it('classifies every tag case the same way, with and without preferred types', () => {
    const preferences: (upstreamOsm.POIType[] | undefined)[] = [
      undefined,
      [...upstreamOsm.POI_TYPES],
      ['transport'],
      ['water', 'emergency'],
    ];
    for (const tags of tagCases()) {
      for (const preferred of preferences) {
        expect(osm.categorizePOI(tags, preferred)).toBe(upstreamOsm.categorizePOI(tags, preferred));
      }
    }
  });

  it('normalises elements and judges payloads the same way', () => {
    const elements = [
      { id: 1, type: 'node', lat: 0, lon: 0, tags: { amenity: 'cafe' } },
      { id: 2, type: 'way', center: { lat: -34.1, lon: 115.2 } },
      { id: 3, type: 'node', lat: Number.NaN, lon: 1 },
    ] as upstreamOsm.OverpassElement[];
    expect(osm.normalizeOverpassElements(elements)).toEqual(upstreamOsm.normalizeOverpassElements(elements));
    for (const payload of [null, 'x', {}, { elements: [] }, { elements: [], remark: 'runtime error: timed out' }]) {
      expect(osm.overpassPayloadError(payload)).toBe(upstreamOsm.overpassPayloadError(payload));
    }
  });

  for (const id of TRAILS) {
    it(`cuts ${id} into the same chunks and the same query text`, { timeout: 60_000 }, () => {
      const scale = buildRouteScale(loadTrail(id));
      for (const maxVertices of [60, 150, 300]) {
        const ours = osm.buildCorridorChunks(scale.polylines, 2000, maxVertices);
        const theirs = upstreamOsm.buildCorridorChunks(scale.polylines, 2000, maxVertices);
        expect(ours).toEqual(theirs);
        const groups = osm.packCorridorChunks(ours, maxVertices);
        expect(groups).toEqual(upstreamOsm.packCorridorChunks(theirs, maxVertices));
        for (const group of groups) {
          const area = { corridor: group.length === 1 ? group[0] : group, radiusMeters: 2500 };
          for (const timeoutSeconds of [22, 55, 120]) {
            expect(osm.buildOverpassQuery(area, [...osm.POI_TYPES], { timeoutSeconds })).toBe(
              upstreamOsm.buildOverpassQuery(area, [...upstreamOsm.POI_TYPES], { timeoutSeconds })
            );
          }
        }
      }
    });

    it.runIf(PLACED_TRAILS.has(id))(
      `places ${id}'s POIs identically (same pois.json for the same answers)`,
      async () => {
        const trail = loadTrail(id);
        const scale = buildRouteScale(trail);
        const fetchPOIs = async (area: upstreamOsm.OverpassArea) => fakeElements(area);
        const options = { types: [...osm.POI_TYPES], searchRadiusKm: 2, maxVerticesPerChunk: 300, fetchPOIs };
        const ours = await enrich.enrichRoute(scale.polylines, options);
        const theirs = await upstreamEnrich.enrichRoute(scale.polylines, options);
        expect(ours.pois).toEqual(theirs.pois);
        expect(ours.failedChunks).toEqual(theirs.failedChunks);
        expect(ours.stats.queryChunks).toBe(theirs.stats.queryChunks);
        expect(JSON.stringify(toTrailPOIs(ours.pois, scale))).toBe(JSON.stringify(toTrailPOIs(theirs.pois, scale)));
      },
      60_000
    );
  }
});

describe('src/lib overpass-client matches gpx-tools', () => {
  it('sends the same request and reads the same answer', async () => {
    const calls: { url: string; init: RequestInit }[][] = [[], []];
    const makeFetch = (log: { url: string; init: RequestInit }[]) =>
      (async (url: string, init: RequestInit) => {
        log.push({ url, init: { ...init, signal: undefined } });
        return new Response(
          JSON.stringify({
            elements: [{ id: 7, type: 'node', lat: -34, lon: 115, tags: { amenity: 'drinking_water' } }],
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;
    const area = {
      corridor: [
        { lat: -34, lon: 115 },
        { lat: -34.1, lon: 115.1 },
      ],
      radiusMeters: 2500,
    };
    const opts = {
      endpoint: 'https://example.test/api/interpreter',
      minDelayMs: 0,
      timeoutSeconds: 55,
      userAgent: 'test/1',
    };
    const ours = await client.createOverpassFetcher({ ...opts, fetch: makeFetch(calls[0]) })(area, ['water']);
    const theirs = await upstreamClient.createOverpassFetcher({ ...opts, fetch: makeFetch(calls[1]) })(area, ['water']);
    expect(ours).toEqual(theirs);
    expect(calls[0]).toEqual(calls[1]);
  });
});

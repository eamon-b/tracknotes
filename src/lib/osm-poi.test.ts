/**
 * `createRouteIndex`: the grid placement must give exactly what
 * `nearestPointOnRoute` gives for every POI within the radius, and nothing
 * beyond it. (The rest of `osm-poi` is held to gpx-tools by
 * `scripts/osm-poi-parity.test.ts`.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { buildRouteGeometry, createRouteIndex, nearestPointOnRoute, type LatLon } from './osm-poi';
import { ALL_POI_TYPES, placePois, prepareCorridor } from './poi-enrichment';
import { buildRouteScale } from './trail-pois';
import type { ProcessedTrail } from './trail-types';

const TRAILS_DIR = path.resolve(__dirname, '../../mobile/assets/trails');

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

/** POIs scattered around the route's points, up to ~`spreadKm` off it. */
function scatter(points: LatLon[], count: number, spreadKm: number, seed: number): LatLon[] {
  const random = rng(seed);
  const spread = spreadKm / 111;
  return Array.from({ length: count }, () => {
    const p = points[Math.floor(random() * points.length)];
    return { lat: p.lat + (random() * 2 - 1) * spread, lon: p.lon + (random() * 2 - 1) * spread };
  });
}

function expectSameAsScan(route: LatLon[] | LatLon[][], pois: LatLon[], radiusKm: number): number {
  const geom = buildRouteGeometry(route);
  const nearest = createRouteIndex(geom, radiusKm);
  let inRange = 0;
  for (const poi of pois) {
    const full = nearestPointOnRoute(poi, geom);
    const indexed = nearest(poi);
    if (full.distanceKm <= radiusKm) {
      inRange++;
      expect(indexed).toEqual(full);
    } else {
      expect(indexed).toBeNull();
    }
  }
  return inRange;
}

describe('createRouteIndex', () => {
  for (const id of ['cape_to_cape', 'heysen', 'te_araroa', 'shikoku']) {
    it(`places POIs along ${id} exactly as the full scan does`, () => {
      const trail = JSON.parse(fs.readFileSync(path.join(TRAILS_DIR, `${id}.json`), 'utf-8')) as ProcessedTrail;
      const { polylines } = buildRouteScale(trail);
      const flat = polylines.flat();
      const inRange = expectSameAsScan(polylines, scatter(flat, 1500, 3, id.length), 2);
      expect(inRange).toBeGreaterThan(500);
    });
  }

  it('handles lone points, track breaks, repeated points and zigzags', () => {
    const random = rng(7);
    const zigzag: LatLon[] = Array.from({ length: 400 }, (_, i) => ({
      lat: -33 + i * 0.002,
      lon: 151 + (i % 2) * 0.01,
    }));
    const repeated: LatLon[] = [
      { lat: -32, lon: 151 },
      { lat: -32, lon: 151 },
      { lat: -31.99, lon: 151.01 },
      { lat: -31.99, lon: 151.01 },
    ];
    const route: LatLon[][] = [zigzag, [{ lat: -32.5, lon: 151.2 }], repeated, [{ lat: -32.2, lon: 150.9 }]];
    const pois = scatter(route.flat(), 3000, 4, 11);
    // And some exactly on vertices, where ties are decided.
    for (const p of route.flat()) pois.push({ ...p });
    pois.push({ lat: -32.5 + random() * 1e-9, lon: 151.2 });
    expectSameAsScan(route, pois, 2);
  });

  it('falls back to the full scan near the antimeridian and near the poles', () => {
    const fiji: LatLon[] = Array.from({ length: 50 }, (_, i) => ({ lat: -17 + i * 0.01, lon: 179.99 - i * 0.0001 }));
    const across = [...fiji, { lat: -16.4, lon: -179.99 }];
    expectSameAsScan(fiji, [{ lat: -16.9, lon: -179.995 }, ...scatter(fiji, 200, 3, 3)], 2);
    expectSameAsScan(across, scatter(across, 200, 3, 4), 2);
    const arctic: LatLon[] = Array.from({ length: 50 }, (_, i) => ({ lat: 88.9 + i * 0.001, lon: 10 + i * 0.1 }));
    expectSameAsScan(arctic, scatter(arctic, 200, 3, 5), 2);
  });

  it('answers null for an empty route and for unusable POIs', () => {
    expect(createRouteIndex(buildRouteGeometry([]), 2)({ lat: 0, lon: 0 })).toBeNull();
    const nearest = createRouteIndex(
      buildRouteGeometry([
        { lat: 1, lon: 1 },
        { lat: 1.01, lon: 1 },
      ]),
      2
    );
    expect(nearest({ lat: Number.NaN, lon: 1 })).toBeNull();
    expect(nearest({ lat: 5, lon: 5 })).toBeNull();
  });
});

describe('placePois indexed', () => {
  it('keeps exactly the POIs the full scan keeps', async () => {
    const trail = JSON.parse(fs.readFileSync(path.join(TRAILS_DIR, 'heysen.json'), 'utf-8')) as ProcessedTrail;
    const corridor = prepareCorridor(buildRouteScale(trail).polylines, { searchRadiusKm: 2 });
    const fetched = scatter(corridor.geometry.points, 2000, 3, 1).map((p, i) => ({
      type: 'node',
      id: i,
      ...p,
      tags: { amenity: i % 2 ? 'drinking_water' : 'toilets' },
    }));
    const full = await placePois(corridor, fetched, { types: ALL_POI_TYPES });
    const indexed = await placePois(corridor, fetched, { types: ALL_POI_TYPES, indexed: true });
    expect(indexed.length).toBeGreaterThan(500);
    expect(indexed).toEqual(full);
  });
});

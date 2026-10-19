import { describe, expect, it, vi } from 'vitest';

import type { OverpassArea, POI } from './osm-poi';
import { createFallbackFetcher, createOverpassFetcher, type POIFetcher } from './overpass-client';
import { ALL_POI_TYPES, fetchCorridorGroups, placePois } from './poi-enrichment';
import {
  INTERACTIVE_MAX_VERTICES,
  finishTrailPois,
  formatBytes,
  planTrailPoiSearch,
} from './trail-poi-search';
import type { EnrichedWaypoint, ProcessedTrail, TrackPoint } from './trail-types';

/** A due-north track, one point per 0.01° (~1.1 km), with its own km. */
function makeTrail(points = 40, waypoints: Partial<EnrichedWaypoint>[] = []): ProcessedTrail {
  const track: TrackPoint[] = Array.from({ length: points }, (_, i) => ({
    lat: -34 + i * 0.01,
    lon: 115,
    ele: 0,
    dist: i * 1.1,
  }));
  return {
    config: {
      id: 'u_test',
      name: 'Test',
      shortName: 'Test',
      region: 'Imported',
      lengthKm: (points - 1) * 1.1,
      gpxFile: '',
      source: 'imported',
    },
    track: { points: track, displayPoints: track, totalDistance: (points - 1) * 1.1, totalAscent: 0, totalDescent: 0 },
    waypoints: waypoints as EnrichedWaypoint[],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: null,
  } as ProcessedTrail;
}

function node(id: number, lat: number, lon: number, tags: Record<string, string>): POI {
  return { id, type: 'node', lat, lon, tags };
}

describe('planTrailPoiSearch', () => {
  it('plans the queries and estimates the data without a request', () => {
    const plan = planTrailPoiSearch(makeTrail());
    expect(plan.estimate.queries).toBe(plan.corridor.groups.length);
    expect(plan.estimate.queries).toBeGreaterThan(0);
    expect(plan.estimate.routeKm).toBeCloseTo(39 * 1.11, 0);
    expect(plan.estimate.uploadBytes).toBeGreaterThan(100);
    expect(plan.estimate.downloadBytesLow).toBeLessThan(plan.estimate.downloadBytesHigh);
  });

  it('cuts a long wiggly route into several interactive-sized queries', () => {
    // A zig-zag DP cannot simplify away: every vertex 5 km off the line.
    const trail = makeTrail(2);
    trail.track.points = Array.from({ length: 1000 }, (_, i) => ({
      lat: -34 + i * 0.05,
      lon: 115 + (i % 2) * 0.05,
      ele: 0,
      dist: i * 7,
    }));
    const plan = planTrailPoiSearch(trail);
    expect(plan.estimate.queries).toBe(Math.ceil((1000 - 1) / (INTERACTIVE_MAX_VERTICES - 1)));
  });

  it('plans nothing for a trail with no usable points', () => {
    const trail = makeTrail(2);
    trail.track.points = [];
    expect(planTrailPoiSearch(trail).estimate.queries).toBe(0);
  });
});

describe('formatBytes', () => {
  it('reads in KB below a megabyte and MB above', () => {
    expect(formatBytes(0)).toBe('1 KB');
    expect(formatBytes(320_400)).toBe('320 KB');
    expect(formatBytes(4_120_000)).toBe('4.1 MB');
    expect(formatBytes(24_600_000)).toBe('25 MB');
  });
});

describe('fetchCorridorGroups', () => {
  it('fetches only the groups asked for, and dedupes repeated elements', async () => {
    const trail = makeTrail(2);
    trail.track.points = Array.from({ length: 1000 }, (_, i) => ({
      lat: -34 + i * 0.05,
      lon: 115 + (i % 2) * 0.05,
      ele: 0,
      dist: i * 7,
    }));
    const plan = planTrailPoiSearch(trail);
    const asked: OverpassArea[] = [];
    const fetchPOIs: POIFetcher = async area => {
      asked.push(area);
      return [node(1, -34, 115, { amenity: 'drinking_water' })];
    };
    const result = await fetchCorridorGroups(plan.corridor, {
      types: ALL_POI_TYPES,
      fetchPOIs,
      only: [1, 3],
    });
    expect(asked).toHaveLength(2);
    expect(result.pois).toHaveLength(1);
    expect(result.failedChunks).toEqual([]);
  });

  it('records a failed group by its own index and keeps going', async () => {
    const plan = planTrailPoiSearch(makeTrail());
    const result = await fetchCorridorGroups(plan.corridor, {
      types: ALL_POI_TYPES,
      fetchPOIs: async () => {
        throw new Error('Overpass request failed: 504');
      },
    });
    expect(result.failedChunks).toEqual([{ chunkIndex: 0, error: 'Overpass request failed: 504' }]);
  });

  it('turns the caller cancelling into an AbortError', async () => {
    const plan = planTrailPoiSearch(makeTrail());
    const controller = new AbortController();
    const fetchPOIs: POIFetcher = async () => {
      controller.abort();
      throw new Error('fetch failed');
    };
    await expect(
      fetchCorridorGroups(plan.corridor, { types: ALL_POI_TYPES, fetchPOIs, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('placePois', () => {
  it('pauses every N elements and gives the same answer as without pauses', async () => {
    const plan = planTrailPoiSearch(makeTrail());
    const fetched = Array.from({ length: 50 }, (_, i) =>
      node(i, -34 + i * 0.005, 115.005, { amenity: 'drinking_water' })
    );
    const pause = vi.fn(async () => {});
    const paused = await placePois(plan.corridor, fetched, { types: ALL_POI_TYPES, pause, pauseEvery: 10 });
    const plain = await placePois(plan.corridor, fetched, { types: ALL_POI_TYPES });
    expect(pause).toHaveBeenCalledTimes(4);
    expect(paused).toEqual(plain);
  });
});

describe('finishTrailPois', () => {
  it('runs the build passes: drops noise, flags duplicates, slims tags, keeps km order', async () => {
    const trail = makeTrail(40, [
      { id: 'w_hut', name: 'Mill Hut', type: 'hut', lat: -33.9, lon: 115.001, totalDistance: 11 } as Partial<EnrichedWaypoint>,
    ]);
    const plan = planTrailPoiSearch(trail);
    const fetched = [
      node(1, -33.8, 115.003, { amenity: 'drinking_water', check_date: '2024-01-01', name: 'Tank' }),
      node(2, -33.9, 115.0015, { tourism: 'wilderness_hut', name: 'Mill Hut' }),
      // Noise: a bus stop is dropped by @lib/poi-noise.
      node(3, -33.7, 115.002, { highway: 'bus_stop', name: 'Stop' }),
      // Far outside the 2 km radius.
      node(4, -33.8, 115.2, { amenity: 'drinking_water' }),
    ];
    const pois = await finishTrailPois(plan, fetched, trail);
    expect(pois.map(p => p.id)).toEqual([2, 1]);
    expect(pois[0].duplicateOf).toBe('w_hut');
    expect(pois[1].tags).toEqual({ amenity: 'drinking_water' });
    expect(pois[1].distanceAlongTrail).toBeCloseTo(22, 0);
  });

  it('returns [] — searched, found nothing — rather than undefined', async () => {
    const trail = makeTrail();
    const plan = planTrailPoiSearch(trail);
    await expect(finishTrailPois(plan, [], trail)).resolves.toEqual([]);
  });

  it('stops between passes when cancelled', async () => {
    const trail = makeTrail();
    const plan = planTrailPoiSearch(trail);
    const controller = new AbortController();
    const pause = async () => controller.abort();
    await expect(
      finishTrailPois(plan, [], trail, { signal: controller.signal, pause })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createFallbackFetcher', () => {
  const area: OverpassArea = { corridor: [{ lat: -34, lon: 115 }], radiusMeters: 2500 };

  it('tries the next instance when one refuses, then starts with the one that answered', async () => {
    const a = vi.fn<POIFetcher>(async () => {
      throw new Error('Overpass request failed: 504');
    });
    const b = vi.fn<POIFetcher>(async () => [node(1, -34, 115, {})]);
    const seen: string[] = [];
    const fetcher = createFallbackFetcher(
      [
        { endpoint: 'a', fetchPOIs: a },
        { endpoint: 'b', fetchPOIs: b },
      ],
      endpoint => seen.push(endpoint)
    );
    await expect(fetcher(area, ['water'])).resolves.toHaveLength(1);
    await fetcher(area, ['water']);
    expect(seen).toEqual(['a', 'b', 'b']);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when every instance refuses', async () => {
    const fail = (message: string): POIFetcher => async () => {
      throw new Error(message);
    };
    const fetcher = createFallbackFetcher([
      { endpoint: 'a', fetchPOIs: fail('first') },
      { endpoint: 'b', fetchPOIs: fail('second') },
    ]);
    await expect(fetcher(area, ['water'])).rejects.toThrow('second');
  });

  it('never retries a cancellation on another instance', async () => {
    const controller = new AbortController();
    const a: POIFetcher = async () => {
      controller.abort();
      throw new Error('aborted');
    };
    const b = vi.fn<POIFetcher>(async () => []);
    const fetcher = createFallbackFetcher([
      { endpoint: 'a', fetchPOIs: a },
      { endpoint: 'b', fetchPOIs: b },
    ]);
    await expect(fetcher(area, ['water'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(b).not.toHaveBeenCalled();
  });
});

describe('createOverpassFetcher', () => {
  it('reports how much each answer weighed', async () => {
    const body = JSON.stringify({ elements: [{ id: 1, type: 'node', lat: -34, lon: 115, tags: {} }] });
    const onResponseBytes = vi.fn();
    const fetcher = createOverpassFetcher({
      minDelayMs: 0,
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      onResponseBytes,
    });
    await fetcher({ corridor: [{ lat: -34, lon: 115 }], radiusMeters: 2500 }, ['water']);
    expect(onResponseBytes).toHaveBeenCalledWith(body.length);
  });

  it('does not retry a 400 (a bad query will not get better)', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }));
    const fetcher = createOverpassFetcher({ minDelayMs: 0, fetch: fetchMock as unknown as typeof fetch });
    await expect(
      fetcher({ corridor: [{ lat: -34, lon: 115 }], radiusMeters: 2500 }, ['water'])
    ).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

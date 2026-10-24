/**
 * The on-phone OpenStreetMap search, minus the screen: plan → fetch (with a
 * mocked `fetch`) → the build's passes → saved into the import's JSON.
 *
 * What is unique here, beyond the `@lib` logic Vitest covers: that a result
 * reaches the file on disk (slimmed, noise gone, duplicates flagged), that a
 * mirror refusing hands the query to the next one, that a partial result is
 * saved and a retry of the missed areas saves the union, and that a failure
 * or a cancel leaves the file exactly as it was.
 */

import { roundCoord } from '@lib/osm-poi';
import { readImportedTrail } from '../../../services/imported-trail-store';
import type { TrailJson } from '../../../services/trail-assets';
import {
  PoiSearchFailedError,
  canSearchPois,
  preparePoiSearch,
  removeSearchedPois,
  runPoiSearch,
  type PoiSearchProgress,
} from '../poi-search';

// ---------------------------------------------------------------------------
// Mock filesystem (the shape imported-trail-store.test.ts uses)
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};

jest.mock('expo-file-system', () => {
  function join(args: unknown[]): string {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') {
        parts.push(a.replace('file://', '').replace(/\/$/, ''));
      } else if (a && typeof a === 'object' && 'uri' in a) {
        parts.push((a as { uri: string }).uri.replace('file://', '').replace(/\/$/, ''));
      }
    }
    return 'file://' + parts.join('/');
  }
  const MockFile = jest.fn().mockImplementation((...args: unknown[]) => {
    const uri = join(args);
    return {
      get uri() {
        return uri;
      },
      get exists() {
        return mockFiles[uri] !== undefined;
      },
      text: jest.fn(async () => {
        if (mockFiles[uri] === undefined) throw new Error('ENOENT');
        return mockFiles[uri];
      }),
      writeSync: jest.fn((data: string) => {
        mockFiles[uri] = data;
      }),
      delete: jest.fn(() => {
        delete mockFiles[uri];
      }),
    };
  });
  const MockDirectory = jest.fn().mockImplementation((...args: unknown[]) => {
    const uri = join(args);
    return { uri, exists: true, create: jest.fn() };
  });
  return {
    __esModule: true,
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: '/mock/document', cache: '/mock/cache' },
  };
});

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const TRAIL_ID = 'u_poitest';
const FILE = `file:///mock/document/trails/${TRAIL_ID}.json`;

/**
 * A due-north zig-zag Douglas-Peucker cannot simplify away, long enough
 * (`points` vertices) to need more than one interactive-sized query.
 */
function makeTrail(points: number): TrailJson {
  const track = Array.from({ length: points }, (_, i) => ({
    lat: -34 + i * 0.02,
    lon: 115 + (i % 2) * 0.03,
    ele: 0,
    dist: i * 3,
  }));
  return {
    config: {
      id: TRAIL_ID,
      name: 'Zig Zag',
      shortName: 'Zig Zag',
      region: 'Imported',
      lengthKm: (points - 1) * 3,
      direction: { default: 'northbound', reversed: 'southbound' },
      source: 'imported',
    },
    waypoints: [
      {
        id: 'w_hut',
        name: 'Mill Hut',
        type: 'hut',
        lat: -34 + 2 * 0.02,
        lon: 115.0005,
        totalDistance: 6,
      },
    ],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    track: {
      points: track,
      displayPoints: track,
      totalDistance: (points - 1) * 3,
      totalAscent: 0,
      totalDescent: 0,
    },
  };
}

function storeTrail(trail: TrailJson): void {
  mockFiles[FILE] = JSON.stringify(trail);
}

/** An Overpass element near track vertex `i` of `makeTrail`. */
function element(id: number, i: number, tags: Record<string, string>) {
  return { type: 'node', id, lat: -34 + i * 0.02 + 0.001, lon: 115 + (i % 2) * 0.03, tags };
}

/** A minimal fetch Response. */
function respond(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** The Overpass QL a mocked request carried. */
function queryOf(init: { body?: unknown } | undefined): string {
  return decodeURIComponent(String(init?.body ?? '').replace(/^data=/, ''));
}

const A = 'https://a.example/api/interpreter';
const B = 'https://b.example/api/interpreter';

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
});

describe('canSearchPois', () => {
  it('is offered for an import only', () => {
    expect(canSearchPois('u_abc')).toBe(true);
    expect(canSearchPois('heysen')).toBe(false);
    expect(canSearchPois('c_shared')).toBe(false);
  });
});

describe('preparePoiSearch', () => {
  it('plans from the file on disk without a request', async () => {
    storeTrail(makeTrail(20));
    const fetchImpl = jest.fn();
    global.fetch = fetchImpl as unknown as typeof fetch;
    const setup = await preparePoiSearch(TRAIL_ID);
    expect(setup?.plan.estimate.queries).toBe(1);
    expect(setup?.plan.estimate.downloadBytesHigh).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is null for a bundled trail or a missing file', async () => {
    await expect(preparePoiSearch('heysen')).resolves.toBeNull();
    await expect(preparePoiSearch(TRAIL_ID)).resolves.toBeNull();
  });
});

describe('runPoiSearch', () => {
  it('falls back to the next mirror, runs the build passes and saves the result', async () => {
    storeTrail(makeTrail(20));
    const setup = (await preparePoiSearch(TRAIL_ID))!;
    const elements = [
      element(1, 5, { amenity: 'drinking_water', name: 'Tank', check_date: '2024-01-01' }),
      // Same place as the guide's hut: flagged, not dropped.
      element(2, 2, { tourism: 'wilderness_hut', name: 'Mill Hut' }),
      // A bus stop is noise (@lib/poi-noise).
      element(3, 8, { highway: 'bus_stop', name: 'Stop' }),
    ];
    const fetchImpl = jest.fn(async (url: string) =>
      url === A ? respond(504, 'busy') : respond(200, { elements }),
    );
    const progress: PoiSearchProgress[] = [];

    const run = await runPoiSearch(setup, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoints: [A, B],
      minDelayMs: 0,
      onProgress: (p) => progress.push(p),
    });

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([A, A, B]);
    expect(run.failures).toEqual([]);
    expect(run.bytes).toBe(JSON.stringify({ elements }).length);
    expect(progress.some((p) => p.phase === 'fetching' && p.host === 'b.example')).toBe(true);
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['processing', 'saving']));

    const saved = await readImportedTrail(TRAIL_ID);
    expect(saved?.pois?.map((p) => p.id)).toEqual([2, 1]);
    expect(saved?.pois?.[0].duplicateOf).toBe('w_hut');
    // Slimmed: `check_date` is not a key the app reads.
    expect(saved?.pois?.[1].tags).toEqual({ amenity: 'drinking_water' });
    // Nothing else in the file moved.
    expect(saved?.waypoints).toEqual(makeTrail(20).waypoints);
  });

  it('saves a partial result, then a retry of the missed area saves the union', async () => {
    storeTrail(makeTrail(400));
    const setup = (await preparePoiSearch(TRAIL_ID))!;
    expect(setup.plan.corridor.groups.length).toBeGreaterThan(1);
    // A vertex only the second query carries (chunks share their end vertices).
    const second = setup.plan.corridor.groups[1][0];
    const middle = second[Math.floor(second.length / 2)];
    const marker = `${roundCoord(middle.lat)},${roundCoord(middle.lon)}`;
    let secondAnswers = false;
    const fetchImpl = jest.fn(async (_url: string, init?: { body?: unknown }) => {
      const query = queryOf(init);
      if (query.includes(marker)) {
        return secondAnswers
          ? respond(200, { elements: [element(20, 390, { shop: 'supermarket', name: 'Shop' })] })
          : respond(504, 'busy');
      }
      return respond(200, { elements: [element(10, 3, { amenity: 'drinking_water' })] });
    });
    const options = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoints: [A],
      minDelayMs: 0,
    };

    const first = await runPoiSearch(setup, options);
    expect(first.failures.map((f) => f.chunkIndex)).toEqual([1]);
    expect((await readImportedTrail(TRAIL_ID))?.pois?.map((p) => p.id)).toEqual([10]);

    secondAnswers = true;
    fetchImpl.mockClear();
    const retry = await runPoiSearch(setup, {
      ...options,
      only: first.failures.map((f) => f.chunkIndex),
      previous: first.fetched,
    });
    // Only the missed query was sent again.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retry.failures).toEqual([]);
    expect((await readImportedTrail(TRAIL_ID))?.pois?.map((p) => p.id)).toEqual([10, 20]);
  });

  it('saves nothing when no server answers', async () => {
    const trail = { ...makeTrail(20), pois: [] };
    storeTrail(trail);
    const before = mockFiles[FILE];
    const setup = (await preparePoiSearch(TRAIL_ID))!;
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(
      runPoiSearch(setup, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        endpoints: [A, B],
        minDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(PoiSearchFailedError);
    // Two tries on each mirror.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(mockFiles[FILE]).toBe(before);
  });

  it('saves nothing when cancelled', async () => {
    storeTrail(makeTrail(20));
    const before = mockFiles[FILE];
    const setup = (await preparePoiSearch(TRAIL_ID))!;
    const controller = new AbortController();
    const fetchImpl = jest.fn(async () => {
      controller.abort();
      return respond(200, { elements: [element(1, 5, { amenity: 'drinking_water' })] });
    });
    await expect(
      runPoiSearch(setup, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        endpoints: [A],
        minDelayMs: 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFiles[FILE]).toBe(before);
  });

  it('saves [] — searched, nothing here — when the answer is empty', async () => {
    storeTrail(makeTrail(20));
    const setup = (await preparePoiSearch(TRAIL_ID))!;
    const fetchImpl = jest.fn(async () => respond(200, { elements: [] }));
    await runPoiSearch(setup, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoints: [A],
      minDelayMs: 0,
    });
    expect((await readImportedTrail(TRAIL_ID))?.pois).toEqual([]);
  });
});

describe('removeSearchedPois', () => {
  it('puts the guide back to never-searched', async () => {
    storeTrail({ ...makeTrail(20), pois: [] });
    await expect(removeSearchedPois(TRAIL_ID)).resolves.toBe(true);
    expect('pois' in JSON.parse(mockFiles[FILE])).toBe(false);
  });

  it('reports a guide that is gone', async () => {
    await expect(removeSearchedPois(TRAIL_ID)).resolves.toBe(false);
  });
});

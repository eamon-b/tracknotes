/**
 * Building a corridor pack on the phone: fetching, writing, validating and
 * promoting it into the same on-disk shape as a bundled pack.
 */

import { gunzipSync } from 'fflate';

import {
  CorridorCancelledError,
  MAX_CORRIDOR_TILES,
  corridorSourceVersion,
  downloadCorridorPack,
  hasCorridorProgress,
  planCorridor,
  readCorridorProgress,
  readCorridorRecord,
  resetRequestPacing,
  retryAfterMs,
  TileServerNotReadyError,
  TileSourceMissingError,
} from '../corridor-pack';
import * as tileService from '../tile-service';
import { getTrailTileStatus, packHasContours, readStoredManifest } from '../tile-service';
import { dbAt, packDirNames, resetStorage, storage } from './fake-tile-storage';

// jest.mock factories cannot import; requiring the fake shares its state with the test.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('expo-file-system', () => require('./fake-tile-storage').fileSystemModule);
jest.mock('expo-sqlite', () => require('./fake-tile-storage').sqliteModule);
/* eslint-enable @typescript-eslint/no-require-imports */

const TILE_URL = 'https://tiles.example.net';
const TRAIL_ID = 'u_route';
/** ~1.8 km in South Australia. */
const TRAIL = {
  track: {
    points: [
      { lat: -35, lon: 140 },
      { lat: -35.001, lon: 140.02 },
    ],
  },
};

/** A worker whose `/health` serves both sources. */
const HEALTHY = { ok: true, sources: { base: { ok: true }, world: { ok: true } } };

type Responder = (
  url: string,
) => { status: number; body?: Uint8Array; headers?: Record<string, string> } | Error;

const PBF = new Uint8Array([0x1a, 0x02, 0x08, 0x01]);
const fetchMock = jest.fn();
let calls: string[] = [];
let healthCalls = 0;

function respondWith(responder: Responder, health: unknown = HEALTHY): void {
  fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal?.aborted) throw new Error('Aborted');
    if (url.endsWith('/health')) {
      healthCalls++;
      if (health instanceof Error) throw health;
      return { status: 200, ok: true, text: async () => JSON.stringify(health) };
    }
    calls.push(url);
    const result = responder(url);
    if (result instanceof Error) throw result;
    const { status, body, headers = {} } = result;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headers[name] ?? null },
      arrayBuffer: async () => (body ?? new Uint8Array(0)).buffer.slice(0),
    };
  });
}

/** Parse `/{source}/{z}/{x}/{y}.pbf`. */
function parse(url: string) {
  const m = /\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url)!;
  return { source: m[1], z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

const options = (overrides: Partial<Parameters<typeof downloadCorridorPack>[2]> = {}) => ({
  tileUrl: TILE_URL,
  bufferKm: 1,
  retryDelaysMs: [0, 0],
  concurrency: 4,
  // Pacing is tested on its own below; everywhere else it would only slow the suite.
  requestsPerSecond: 1e6,
  rateLimitWaitMs: 1,
  now: () => new Date('2026-10-30T00:00:00Z'),
  ...overrides,
});

beforeAll(() => {
  (global as { fetch: unknown }).fetch = fetchMock;
});

beforeEach(() => {
  resetStorage();
  resetRequestPacing();
  fetchMock.mockReset();
  calls = [];
  healthCalls = 0;
  tileService.clearMbtilesValidationCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('planCorridor', () => {
  it('counts basemap tiles at z4–15 and contour tiles at z9–15', () => {
    const plan = planCorridor(TRAIL, 1)!;
    expect(plan.baseTiles).toBeGreaterThan(plan.contourTiles);
    expect(plan.totalTiles).toBe(plan.baseTiles + plan.contourTiles);
    expect(plan.tooLarge).toBe(false);
    expect(plan.sourceVersion).toBe(corridorSourceVersion(TRAIL));
  });

  it('refuses a corridor over the tile cap', () => {
    // ~2,000 km of route at 20 km either side.
    const long = {
      track: {
        points: [
          { lat: -30, lon: 120 },
          { lat: -30, lon: 140 },
        ],
      },
    };
    const plan = planCorridor(long, 20)!;
    expect(plan.totalTiles).toBeGreaterThan(MAX_CORRIDOR_TILES);
    expect(plan.tooLarge).toBe(true);
  });

  it('is null for a route with no points', () => {
    expect(planCorridor({ track: { points: [] } }, 5)).toBeNull();
  });
});

describe('retryAfterMs', () => {
  it('reads seconds or an HTTP date, else falls back', () => {
    expect(retryAfterMs('3', 11_000)).toBe(3000);
    expect(retryAfterMs(null, 11_000)).toBe(11_000);
    expect(retryAfterMs('soon', 11_000)).toBe(11_000);
    const inFive = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs(inFive, 11_000)).toBeGreaterThan(3000);
    expect(retryAfterMs(inFive, 11_000)).toBeLessThanOrEqual(5000);
  });
});

describe('downloadCorridorPack', () => {
  it('writes both files as gzipped TMS-row mbtiles, validates and promotes them, and records the corridor', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    const progress: number[] = [];
    await downloadCorridorPack(
      TRAIL_ID,
      TRAIL,
      options({ onProgress: (p) => progress.push(p.tilesDone) }),
    );

    const plan = planCorridor(TRAIL, 1)!;
    const base = calls.filter((u) => parse(u).source === 'base');
    // Contours come from `world` everywhere, Australia included (#228).
    const contours = calls.filter((u) => parse(u).source === 'world');
    expect(base.length + contours.length).toBe(calls.length);
    expect(base).toHaveLength(plan.baseTiles);
    expect(contours).toHaveLength(plan.contourTiles);
    expect(Math.min(...base.map((u) => parse(u).z))).toBe(4);
    expect(Math.min(...contours.map((u) => parse(u).z))).toBe(9);
    expect(progress[progress.length - 1]).toBe(plan.totalTiles);

    // Live under fresh generation names; no staging file left behind.
    expect(packDirNames(TRAIL_ID)).toEqual([
      'base-1.mbtiles',
      'contours-1.mbtiles',
      'manifest.json',
    ]);

    const db = dbAt(`${TRAIL_ID}/base-1.mbtiles`)!;
    for (const url of base) {
      const { z, x, y } = parse(url);
      const row = (1 << z) - 1 - y;
      const tile = db.tiles.get(`${z}/${x}/${row}`);
      expect(tile).toBeDefined();
      expect(tile!.data[0]).toBe(0x1f); // gzip magic
      expect(gunzipSync(tile!.data)).toEqual(PBF);
    }
    expect(db.metadata.get('format')).toBe('pbf');
    expect(db.metadata.get('minzoom')).toBe('4');
    expect(db.metadata.get('maxzoom')).toBe('15');
    const bounds = db.metadata.get('bounds')!.split(',').map(Number);
    expect(bounds).toHaveLength(4);
    expect(bounds[0]).toBeLessThan(140);
    expect(bounds[2]).toBeGreaterThan(140.02);
    expect(dbAt(`${TRAIL_ID}/contours-1.mbtiles`)!.metadata.get('minzoom')).toBe('9');

    const manifest = readStoredManifest(TRAIL_ID)!;
    expect(manifest.files.map((f) => f.name)).toEqual(['base.mbtiles', 'contours.mbtiles']);
    expect(manifest.localNames).toEqual({
      'base.mbtiles': 'base-1.mbtiles',
      'contours.mbtiles': 'contours-1.mbtiles',
    });
    expect(manifest.corridor).toEqual({
      bufferKm: 1,
      sourceVersion: corridorSourceVersion(TRAIL),
      builtAt: '2026-10-30T00:00:00.000Z',
      contours: true,
      tileCount: plan.totalTiles,
    });
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(storage.open.size).toBe(0);
  });

  it('skips empty (204) tiles and records only the zooms present', async () => {
    respondWith((url) => (parse(url).z < 8 ? { status: 204 } : { status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    const db = dbAt(`${TRAIL_ID}/base-1.mbtiles`)!;
    expect([...db.tiles.values()].every((t) => t.z >= 8)).toBe(true);
    expect(db.metadata.get('minzoom')).toBe('8');
  });

  it('makes a base-only pack when no contour tile exists along the route', async () => {
    respondWith((url) =>
      parse(url).source === 'base' ? { status: 200, body: PBF } : { status: 204 },
    );
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());

    expect(packDirNames(TRAIL_ID)).toEqual(['base-1.mbtiles', 'manifest.json']);
    const manifest = readStoredManifest(TRAIL_ID)!;
    expect(manifest.files.map((f) => f.name)).toEqual(['base.mbtiles']);
    expect(manifest.corridor?.contours).toBe(false);
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(packHasContours(TRAIL_ID)).toBe(false);
  });

  it('fails when no basemap tile comes back at all', async () => {
    respondWith(() => ({ status: 204 }));
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options())).rejects.toThrow(
      /No map tiles came back/,
    );
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
  });

  it('fails at once on a 404 for the basemap: the worker does not serve the source', async () => {
    respondWith(() => ({ status: 404 }));
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options())).rejects.toBeInstanceOf(
      TileSourceMissingError,
    );
    // One per worker at most, not the whole corridor.
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
  });

  it('fails on a 404 for contours rather than recording a pack without them', async () => {
    respondWith((url) =>
      parse(url).source === 'base' ? { status: 200, body: PBF } : { status: 404 },
    );
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options())).rejects.toThrow(
      /can't provide offline maps/,
    );
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('absent');
  });

  it('stops every worker when one tile fails, and reports that failure, not a cancel', async () => {
    let n = 0;
    // One worker's first request fails hard (not the first worker's, so the
    // others' cancellations come first in the results); the rest would succeed.
    respondWith(() => (n++ === 5 ? { status: 400 } : { status: 200, body: PBF }));
    const error = await downloadCorridorPack(
      TRAIL_ID,
      TRAIL,
      options({ concurrency: 8, requestsPerSecond: 1000 }),
    ).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(CorridorCancelledError);
    expect((error as Error).message).toMatch(/HTTP 400/);
    expect(calls.length).toBeLessThan(planCorridor(TRAIL, 1)!.baseTiles);
  });

  it("checks the worker's /health once before any tile", async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    expect(healthCalls).toBe(1);
  });

  it('fails before any tile when /health says a source is not served', async () => {
    respondWith(() => ({ status: 200, body: PBF }), {
      ok: true,
      sources: {
        world: { ok: true },
        base: { ok: false, error: 'basemap/planet.pmtiles not found' },
      },
    });
    const error = await downloadCorridorPack(TRAIL_ID, TRAIL, options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TileServerNotReadyError);
    expect((error as Error).message).toMatch(/base: basemap\/planet\.pmtiles not found/);
    expect(calls).toHaveLength(0);
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
  });

  it('fails before any tile when /health lacks a source entirely (an older worker)', async () => {
    respondWith(() => ({ status: 200, body: PBF }), { ok: true, sources: { world: { ok: true } } });
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options())).rejects.toThrow(
      /base not served/,
    );
    expect(calls).toHaveLength(0);
  });

  it('says to check the connection when /health cannot be reached', async () => {
    respondWith(() => ({ status: 200, body: PBF }), new TypeError('Network request failed'));
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options())).rejects.toThrow(
      /Check the connection/,
    );
    // One try plus one per retry delay.
    expect(healthCalls).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('records which corridor an interrupted build holds, and clears it on success', async () => {
    let ok = 0;
    respondWith(() => (ok++ < 10 ? { status: 200, body: PBF } : { status: 500 }));
    await expect(
      downloadCorridorPack(
        TRAIL_ID,
        TRAIL,
        options({ bufferKm: 2, concurrency: 1, retryDelaysMs: [] }),
      ),
    ).rejects.toThrow();
    expect(readCorridorProgress(TRAIL_ID)).toEqual({
      bufferKm: 2,
      sourceVersion: corridorSourceVersion(TRAIL),
    });

    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }));
    expect(readCorridorProgress(TRAIL_ID)).toBeNull();
    expect(packDirNames(TRAIL_ID)).not.toContain('corridor-progress.json');
  });

  it('honours a cancel that comes in while the files are validated', async () => {
    const controller = new AbortController();
    respondWith(() => ({ status: 200, body: PBF }));
    const validate = tileService.validateMbtilesFile;
    jest.spyOn(tileService, 'validateMbtilesFile').mockImplementation(async (...args) => {
      controller.abort();
      return validate(...args);
    });
    await expect(
      downloadCorridorPack(TRAIL_ID, TRAIL, options({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(CorridorCancelledError);
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
    // Everything fetched stays for a resume.
    expect(readCorridorProgress(TRAIL_ID)?.bufferKm).toBe(1);
  });

  it('retries a 5xx and a network error, then succeeds', async () => {
    const seen = new Map<string, number>();
    respondWith((url) => {
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n === 1) return { status: 503 };
      if (n === 2) return new TypeError('Network request failed');
      return { status: 200, body: PBF };
    });
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect([...seen.values()].every((n) => n === 3)).toBe(true);
  });

  it('waits out 429s on their own budget, not the 5xx retries', async () => {
    const seen = new Map<string, number>();
    respondWith((url) => {
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      // Three 429s per tile, with no 5xx retries allowed at all.
      return n <= 3
        ? {
            status: 429,
            headers: n === 1 ? { 'Retry-After': '0' } : ({} as Record<string, string>),
          }
        : { status: 200, body: PBF };
    });
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ retryDelaysMs: [] }));
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
  });

  it('paces request starts to the rate, whatever the concurrency', async () => {
    const starts: number[] = [];
    respondWith(() => {
      starts.push(Date.now());
      return { status: 204 };
    });
    // Base tiles only matter here: every one is empty, so the build stops after them.
    await expect(
      downloadCorridorPack(TRAIL_ID, TRAIL, options({ requestsPerSecond: 200, concurrency: 16 })),
    ).rejects.toThrow(/No map tiles/);
    const n = starts.length;
    expect(n).toBeGreaterThan(20);
    // 200/s is 5 ms apart: n starts span at least (n - 1) * 5 ms, less timer slack.
    expect(starts[n - 1] - starts[0]).toBeGreaterThanOrEqual((n - 1) * 5 - 20);
  });

  it('gives up after its retries, keeps what it fetched, and resumes from it', async () => {
    let ok = 0;
    respondWith(() => (ok++ < 10 ? { status: 200, body: PBF } : { status: 500 }));
    await expect(
      downloadCorridorPack(TRAIL_ID, TRAIL, options({ concurrency: 1, retryDelaysMs: [] })),
    ).rejects.toThrow(/HTTP 500/);
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
    expect(hasCorridorProgress(TRAIL_ID)).toBe(true);
    const kept = dbAt(`${TRAIL_ID}/base.mbtiles.part`)!.tiles.size;
    expect(kept).toBe(10);

    calls = [];
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    const plan = planCorridor(TRAIL, 1)!;
    expect(calls.filter((u) => parse(u).source === 'base')).toHaveLength(plan.baseTiles - kept);
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
    expect(hasCorridorProgress(TRAIL_ID)).toBe(false);
  });

  it('starts afresh when the interrupted build was for another corridor width', async () => {
    let ok = 0;
    respondWith(() => (ok++ < 10 ? { status: 200, body: PBF } : { status: 500 }));
    await expect(
      downloadCorridorPack(TRAIL_ID, TRAIL, options({ concurrency: 1, retryDelaysMs: [] })),
    ).rejects.toThrow();

    calls = [];
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }));
    expect(calls.filter((u) => parse(u).source === 'base')).toHaveLength(
      planCorridor(TRAIL, 2)!.baseTiles,
    );
    expect(readCorridorRecord(TRAIL_ID)?.bufferKm).toBe(2);
  });

  it('stops on cancel without promoting anything', async () => {
    const controller = new AbortController();
    respondWith(() => {
      if (calls.length === 5) controller.abort();
      return { status: 200, body: PBF };
    });
    await expect(
      downloadCorridorPack(TRAIL_ID, TRAIL, options({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(CorridorCancelledError);
    expect(readStoredManifest(TRAIL_ID)).toBeNull();
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('absent');
    expect(calls.length).toBeLessThan(planCorridor(TRAIL, 1)!.totalTiles);
  });

  it('validates the staging files before promotion and leaves the live pack alone when one fails', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    const before = readStoredManifest(TRAIL_ID);

    jest
      .spyOn(tileService, 'validateMbtilesFile')
      .mockResolvedValueOnce({ ok: false, reason: 'metadata maxzoom is not an integer' });
    await expect(downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }))).rejects.toThrow(
      /not a usable tile database/,
    );
    expect(tileService.validateMbtilesFile).toHaveBeenCalledWith(TRAIL_ID, 'base.mbtiles.part');
    expect(readStoredManifest(TRAIL_ID)).toEqual(before);
    expect(packDirNames(TRAIL_ID)).toEqual([
      'base-1.mbtiles',
      'contours-1.mbtiles',
      'manifest.json',
    ]);
  });

  it('rebuilds onto the next generation and sweeps the old one', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }));
    expect(packDirNames(TRAIL_ID)).toEqual([
      'base-2.mbtiles',
      'contours-2.mbtiles',
      'manifest.json',
    ]);
    expect(readCorridorRecord(TRAIL_ID)?.bufferKm).toBe(2);
  });

  it('a rebuild that turns out base-only sweeps the old contours', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    respondWith((url) =>
      parse(url).source === 'base' ? { status: 200, body: PBF } : { status: 204 },
    );
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }));
    expect(packDirNames(TRAIL_ID)).toEqual(['base-2.mbtiles', 'manifest.json']);
    expect(getTrailTileStatus(TRAIL_ID).state).toBe('complete');
  });

  it('keeps counting contours generations up across a base-only rebuild (#45)', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options());
    respondWith((url) =>
      parse(url).source === 'base' ? { status: 200, body: PBF } : { status: 204 },
    );
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 2 }));
    respondWith(() => ({ status: 200, body: PBF }));
    await downloadCorridorPack(TRAIL_ID, TRAIL, options({ bufferKm: 5 }));
    // contours-1 may still be open in MapLibre: the new one must not reuse it.
    expect(packDirNames(TRAIL_ID)).toEqual([
      'base-3.mbtiles',
      'contours-2.mbtiles',
      'manifest.json',
    ]);
  });

  it('refuses a corridor over the cap before fetching anything', async () => {
    respondWith(() => ({ status: 200, body: PBF }));
    const long = {
      track: {
        points: [
          { lat: -30, lon: 120 },
          { lat: -30, lon: 140 },
        ],
      },
    };
    await expect(downloadCorridorPack(TRAIL_ID, long, options({ bufferKm: 20 }))).rejects.toThrow(
      /narrower corridor/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

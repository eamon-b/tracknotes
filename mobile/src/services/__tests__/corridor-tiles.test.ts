/**
 * The corridor tile set: which z/x/y tiles a corridor pack holds.
 */

import {
  BASE_MIN_ZOOM,
  CONTOUR_MIN_ZOOM,
  CORRIDOR_MAX_ZOOM,
  corridorFingerprint,
  corridorLines,
  corridorTileSet,
  countTiles,
  levelBounds,
  listTiles,
  type CorridorPoint,
} from '../corridor-tiles';

/** XYZ tile of a point, as the slippy-map formula has it. */
function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function keys(tiles: { z: number; x: number; y: number }[]): Set<string> {
  return new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
}

/** A straight line of `count` points from a to b. */
function line(a: CorridorPoint, b: CorridorPoint, count = 2): CorridorPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1);
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  });
}

describe('corridorLines', () => {
  it('cuts the main track at its breaks, by index into points', () => {
    const points = line({ lat: -35, lon: 140 }, { lat: -35, lon: 141 }, 6);
    const lines = corridorLines({
      track: { points, breaks: [{ index: 3, displayIndex: 1 } as never] },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(3);
    expect(lines[1]).toHaveLength(3);
  });

  it('adds every alternate and side trip whole, and drops empty and non-finite input', () => {
    const lines = corridorLines({
      track: { points: [{ lat: 1, lon: 1 }] },
      alternates: [{ points: [{ lat: 2, lon: 2 }] }, { points: [] }],
      sideTrips: [
        {
          points: [
            { lat: NaN, lon: 3 },
            { lat: 3, lon: 3 },
          ],
        },
      ],
    });
    expect(lines).toEqual([[{ lat: 1, lon: 1 }], [{ lat: 2, lon: 2 }], [{ lat: 3, lon: 3 }]]);
  });

  it('is empty for a trail with no points', () => {
    expect(corridorLines(null)).toEqual([]);
    expect(corridorLines({ track: { points: [] } })).toEqual([]);
  });
});

describe('corridorTileSet', () => {
  const route = line({ lat: -35, lon: 140 }, { lat: -35.05, lon: 140.2 }, 3);

  it('holds the tiles under the route at the deepest zoom', () => {
    const set = corridorTileSet([route], 0, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM);
    const tiles = keys(listTiles(set, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM));
    for (const p of route) {
      const { x, y } = tileOf(p.lat, p.lon, CORRIDOR_MAX_ZOOM);
      expect(tiles.has(`${CORRIDOR_MAX_ZOOM}/${x}/${y}`)).toBe(true);
    }
    // And the line between the vertices — the walk samples along it.
    const mid = tileOf(-35.025, 140.1, CORRIDOR_MAX_ZOOM);
    expect(tiles.has(`${CORRIDOR_MAX_ZOOM}/${mid.x}/${mid.y}`)).toBe(true);
  });

  it('spans the buffer either side of the route', () => {
    // Due east along the equator: a z15 tile is ~1.22 km wide there, so ±5 km
    // is ~8–9 rows of tiles, and never fewer than the buffer needs.
    const eastward = line({ lat: 0.5, lon: 10 }, { lat: 0.5, lon: 10.1 });
    const set = corridorTileSet([eastward], 5000, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM);
    const rows = set.levels.get(CORRIDOR_MAX_ZOOM)!.rows;
    expect(rows.size).toBeGreaterThanOrEqual(8);
    expect(rows.size).toBeLessThanOrEqual(10);
  });

  it('grows with the buffer', () => {
    const narrow = corridorTileSet([route], 2000, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    const wide = corridorTileSet([route], 10_000, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    expect(countTiles(wide, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM)).toBeGreaterThan(
      countTiles(narrow, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM),
    );
  });

  it('makes every shallower zoom exactly the parents of the zoom below', () => {
    const set = corridorTileSet([route], 3000, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    for (let z = BASE_MIN_ZOOM; z < CORRIDOR_MAX_ZOOM; z++) {
      const parents = keys(listTiles(set, z, z));
      const fromChildren = keys(
        listTiles(set, z + 1, z + 1).map((t) => ({ z, x: t.x >> 1, y: t.y >> 1 })),
      );
      expect(parents).toEqual(fromChildren);
    }
  });

  it('counts what it lists, per zoom range', () => {
    const set = corridorTileSet([route], 5000, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    expect(countTiles(set, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM)).toBe(
      listTiles(set, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM).length,
    );
    expect(countTiles(set, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM)).toBe(
      listTiles(set, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM).length,
    );
    // Listing is shallowest zoom first, with no duplicates.
    const all = listTiles(set, BASE_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    expect(all[0].z).toBe(BASE_MIN_ZOOM);
    expect(keys(all).size).toBe(all.length);
  });

  it('never spans a route break', () => {
    // Two stretches 50 km apart, with a ferry between them.
    const points = [
      ...line({ lat: -40, lon: 170 }, { lat: -40, lon: 170.01 }),
      ...line({ lat: -40, lon: 170.6 }, { lat: -40, lon: 170.61 }),
    ];
    const across = tileOf(-40, 170.3, CORRIDOR_MAX_ZOOM);
    const key = `${CORRIDOR_MAX_ZOOM}/${across.x}/${across.y}`;

    const joined = corridorTileSet(
      corridorLines({ track: { points } }),
      1000,
      CORRIDOR_MAX_ZOOM,
      CORRIDOR_MAX_ZOOM,
    );
    expect(keys(listTiles(joined, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM)).has(key)).toBe(true);

    const broken = corridorTileSet(
      corridorLines({ track: { points, breaks: [{ index: 2, displayIndex: 2 } as never] } }),
      1000,
      CORRIDOR_MAX_ZOOM,
      CORRIDOR_MAX_ZOOM,
    );
    expect(keys(listTiles(broken, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM)).has(key)).toBe(false);
  });

  it('covers an alternate that strays from the main track', () => {
    const lines = corridorLines({
      track: { points: line({ lat: -35, lon: 140 }, { lat: -35, lon: 140.01 }) },
      alternates: [{ points: line({ lat: -35.5, lon: 140.5 }, { lat: -35.5, lon: 140.51 }) }],
    });
    const set = corridorTileSet(lines, 500, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM);
    const alt = tileOf(-35.5, 140.505, CORRIDOR_MAX_ZOOM);
    expect(
      keys(listTiles(set, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM)).has(
        `${CORRIDOR_MAX_ZOOM}/${alt.x}/${alt.y}`,
      ),
    ).toBe(true);
  });

  it('wraps a corridor across the antimeridian instead of spanning the globe', () => {
    const n = 2 ** CORRIDOR_MAX_ZOOM;
    const set = corridorTileSet(
      [
        [
          { lat: -17, lon: 179.995 },
          { lat: -17, lon: -179.995 },
        ],
      ],
      1000,
      CORRIDOR_MAX_ZOOM,
      CORRIDOR_MAX_ZOOM,
    );
    const tiles = listTiles(set, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM);
    const xs = new Set(tiles.map((t) => t.x));
    expect(xs.has(0)).toBe(true);
    expect(xs.has(n - 1)).toBe(true);
    expect(tiles.length).toBeLessThan(100);
    expect(levelBounds(set.levels.get(CORRIDOR_MAX_ZOOM)!)).toEqual([
      -180,
      expect.any(Number),
      180,
      expect.any(Number),
    ]);
  });

  it('clamps to Web Mercator near the poles without throwing', () => {
    const set = corridorTileSet(
      [
        [
          { lat: 89.9, lon: 0 },
          { lat: 89.9, lon: 1 },
        ],
      ],
      1000,
      10,
      12,
    );
    for (const t of listTiles(set, 10, 12)) {
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(2 ** t.z);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(2 ** t.z);
    }
  });
});

describe('levelBounds', () => {
  it('encloses the route, as w,s,e,n', () => {
    const route = line({ lat: -35, lon: 140 }, { lat: -35.05, lon: 140.2 });
    const set = corridorTileSet([route], 1000, CORRIDOR_MAX_ZOOM, CORRIDOR_MAX_ZOOM);
    const [w, s, e, n] = levelBounds(set.levels.get(CORRIDOR_MAX_ZOOM)!)!;
    expect(w).toBeLessThan(140);
    expect(e).toBeGreaterThan(140.2);
    expect(s).toBeLessThan(-35.05);
    expect(n).toBeGreaterThan(-35);
  });
});

describe('corridorFingerprint', () => {
  const a = line({ lat: -35, lon: 140 }, { lat: -35, lon: 141 }, 4);

  it('is stable for the same geometry', () => {
    expect(corridorFingerprint([a])).toBe(corridorFingerprint([a.map((p) => ({ ...p }))]));
  });

  it('changes when a point moves, or the same points are split differently', () => {
    const moved = a.map((p, i) => (i === 2 ? { ...p, lat: p.lat + 0.001 } : p));
    expect(corridorFingerprint([moved])).not.toBe(corridorFingerprint([a]));
    expect(corridorFingerprint([a.slice(0, 2), a.slice(2)])).not.toBe(corridorFingerprint([a]));
  });
});

describe('corridorTileSet on a dense track', () => {
  it('covers the same ground as the same line given by its ends', () => {
    // A straight 20 km line east along a parallel, as a GPS track with a fix every ~5 m.
    const start = { lat: -33.5, lon: 150.2 };
    const endLon = 150.2 + 20_000 / (111_320 * Math.cos((33.5 * Math.PI) / 180));
    const dense: CorridorPoint[] = [];
    for (let i = 0; i <= 4000; i++) {
      dense.push({ lat: start.lat, lon: start.lon + ((endLon - start.lon) * i) / 4000 });
    }
    const sparse = [start, { lat: start.lat, lon: endLon }];

    const denseSet = corridorTileSet([dense], 5_000, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    const sparseSet = corridorTileSet([sparse], 5_000, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM);
    expect(keys(listTiles(denseSet, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM))).toEqual(
      keys(listTiles(sparseSet, CONTOUR_MIN_ZOOM, CORRIDOR_MAX_ZOOM)),
    );
  });
});

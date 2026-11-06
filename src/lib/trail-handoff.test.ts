import { describe, expect, it } from 'vitest';
import {
  HANDOFF_EXTENSION,
  HANDOFF_FORMAT,
  HANDOFF_MAX_POINTS,
  HANDOFF_PLAN_UNREADABLE,
  HANDOFF_PLAN_VERSION,
  HANDOFF_TRAIL_VERSION,
  HANDOFF_VERSION,
  handoffFileName,
  handoffImportReport,
  looksLikeHandoffJson,
  parseHandoff,
  parseHandoffJson,
  serializeTrailHandoff,
  trailSlug,
  wrapTrailForHandoff,
} from './trail-handoff';
import type { PlanDocument } from './plan-types';
import type { ProcessedTrail } from './trail-types';

function makeTrail(overrides: Partial<ProcessedTrail> = {}): ProcessedTrail {
  const points = [
    { lat: -33.8688, lon: 151.2093, ele: 10, dist: 0 },
    { lat: -33.87, lon: 151.21, ele: 25, dist: 0.15 },
    { lat: -33.875, lon: 151.215, ele: 40, dist: 0.85 },
  ];
  return {
    config: {
      id: 'u_abc123',
      name: 'Weekend Loop',
      shortName: 'Weekend Loop',
      region: 'Imported',
      lengthKm: 0.85,
      gpxFile: '',
      source: 'imported',
    },
    track: {
      points,
      displayPoints: points,
      totalDistance: 0.85,
      totalAscent: 30,
      totalDescent: 0,
    },
    waypoints: [],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: { default: 'Start → End', reversed: 'End → Start' },
    ...overrides,
  };
}

/** A copy of `source` without one key — the "field is absent" fixture shape. */
function omit<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** Round-trip a trail through the envelope and back. */
function roundTrip(trail: ProcessedTrail): ProcessedTrail {
  return parseHandoffJson(serializeTrailHandoff(trail));
}

describe('wrapTrailForHandoff', () => {
  it('wraps the trail verbatim in a versioned envelope', () => {
    const trail = makeTrail();
    const wrapped = wrapTrailForHandoff(trail);
    expect(wrapped.format).toBe(HANDOFF_FORMAT);
    expect(wrapped.version).toBe(HANDOFF_TRAIL_VERSION);
    expect(wrapped).not.toHaveProperty('plan');
    expect(wrapped.trail).toBe(trail);
  });

  it('serializes to JSON the parser accepts', () => {
    expect(roundTrip(makeTrail()).config.id).toBe('u_abc123');
  });
});

describe('trailSlug / handoffFileName', () => {
  it('slugifies the name for imported ids', () => {
    expect(trailSlug({ id: 'u_abc123', name: 'Weekend Loop!' })).toBe('weekend-loop');
  });

  it('keeps a bundled trail id as-is', () => {
    expect(trailSlug({ id: 'bibbulmun-track', name: 'Bibbulmun Track' })).toBe('bibbulmun-track');
  });

  it('falls back when the name has nothing slug-shaped in it', () => {
    expect(trailSlug({ id: 'u_x', name: '???' })).toBe('u_x');
    expect(trailSlug({})).toBe('trail');
  });

  it('names the download with the double extension', () => {
    expect(handoffFileName(makeTrail())).toBe(`weekend-loop${HANDOFF_EXTENSION}`);
  });
});

describe('looksLikeHandoffJson', () => {
  it('recognises JSON regardless of leading whitespace', () => {
    expect(looksLikeHandoffJson('  \n {"format":"x"}')).toBe(true);
  });

  it('rejects XML', () => {
    expect(looksLikeHandoffJson('<?xml version="1.0"?><gpx/>')).toBe(false);
  });
});

describe('parseHandoffJson', () => {
  it('round-trips a full trail', () => {
    const trail = makeTrail();
    const parsed = roundTrip(trail);
    expect(parsed.track.points).toEqual(trail.track.points);
    expect(parsed.track.totalAscent).toBe(30);
    expect(parsed.config.name).toBe('Weekend Loop');
    expect(parsed.direction).toEqual({ default: 'Start → End', reversed: 'End → Start' });
  });

  it('always marks the result as imported', () => {
    const parsed = roundTrip(makeTrail());
    expect(parsed.config.source).toBe('imported');
  });

  it('mints a fresh u_ id when the file carries a non-imported one', () => {
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: makeTrail({
        config: { ...makeTrail().config, id: 'bibbulmun-track', source: undefined },
      }),
    });
    const parsed = parseHandoffJson(text);
    expect(parsed.config.id).toMatch(/^u_[a-z0-9]+$/);
    // Deterministic: the same bytes always land on the same trail.
    expect(parseHandoffJson(text).config.id).toBe(parsed.config.id);
  });

  it('keeps an existing u_ id so re-importing is not a duplicate', () => {
    expect(roundTrip(makeTrail()).config.id).toBe('u_abc123');
  });

  it('falls back to the full track when displayPoints is missing', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: { ...trail, track: { ...trail.track, displayPoints: undefined } },
    });
    expect(parseHandoffJson(text).track.displayPoints).toEqual(trail.track.points);
  });

  it('defaults the optional collections rather than failing', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: {
        config: trail.config,
        track: trail.track,
        waypoints: [],
      },
    });
    const parsed = parseHandoffJson(text);
    expect(parsed.alternates).toEqual([]);
    expect(parsed.sideTrips).toEqual([]);
    expect(parsed.offTrailWaypoints).toEqual([]);
    expect(parsed.climate).toBeNull();
  });

  it('derives lengthKm from the track when the config omits it', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: { ...trail, config: { ...trail.config, lengthKm: undefined } },
    });
    expect(parseHandoffJson(text).config.lengthKm).toBe(0.85);
  });

  describe('rejections', () => {
    const cases: [string, unknown, RegExp][] = [
      ['a non-object payload', '"hello"', /expected a JSON object/],
      [
        'a foreign format',
        JSON.stringify({ format: 'gaia-trail', version: 1, trail: {} }),
        /not a Tracknotes trail file \(format "gaia-trail"/,
      ],
      ['a missing format', JSON.stringify({ version: 1, trail: {} }), /format missing/],
      ['a non-integer version', JSON.stringify({ format: HANDOFF_FORMAT, version: '1', trail: {} }), /invalid version/],
      [
        'a future version',
        JSON.stringify({ format: HANDOFF_FORMAT, version: 99, trail: {} }),
        /newer version of Tracknotes/,
      ],
      ['a missing trail', JSON.stringify({ format: HANDOFF_FORMAT, version: 1 }), /missing its "trail" object/],
      [
        'a missing config',
        JSON.stringify({ format: HANDOFF_FORMAT, version: 1, trail: { track: {} } }),
        /missing "trail.config"/,
      ],
    ];

    it.each(cases)('rejects %s', (_label, text, pattern) => {
      expect(() => parseHandoffJson(text as string)).toThrow(pattern);
    });

    it('rejects text that is not JSON at all', () => {
      expect(() => parseHandoffJson('<gpx/>')).toThrow(/not valid JSON/);
    });

    it('rejects an empty track', () => {
      const trail = makeTrail();
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points: [] } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/no track points/);
    });

    it('rejects a point with a non-numeric dist rather than zeroing it', () => {
      const trail = makeTrail();
      const points = trail.track.points.map(p => ({ ...p }) as Record<string, unknown>);
      delete points[1].dist;
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/non-numeric track\.points\[1\]\.dist/);
    });

    it('rejects an out-of-range latitude', () => {
      const trail = makeTrail();
      const points = trail.track.points.map(p => ({ ...p }));
      points[0].lat = 991;
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/out-of-range track\.points\[0\]\.lat/);
    });

    it('rejects a missing waypoints array', () => {
      const trail = makeTrail();
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { config: trail.config, track: trail.track },
      });
      expect(() => parseHandoffJson(text)).toThrow(/missing its "waypoints" array/);
    });

    it('rejects a track longer than the handoff point cap', () => {
      const trail = makeTrail();
      // One over the cap, built cheaply — only the length is inspected before
      // the rejection, so the points never have to be well-formed.
      const points = new Array(HANDOFF_MAX_POINTS + 1).fill(trail.track.points[0]);
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/more than the 100000 this app will load/);
    });
  });

  /**
   * A handoff file arrives from a share sheet — i.e. from whoever sent it — and
   * its `config.id` becomes a *path* on mobile
   * (`{documentDir}/trails/{id}.json`). Anything that isn't an id this build
   * could have minted has to be replaced, not trusted.
   */
  describe('untrusted ids', () => {
    const hostile = [
      'u_../../../../databases/tracknotes.db',
      'u_/etc/passwd',
      'u_a/b',
      'u_..',
      'u_UPPER', // outside the minter's base36 alphabet
      `u_${'a'.repeat(64)}`, // longer than anything hashString emits
    ];

    it.each(hostile)('re-mints a hostile id (%s) instead of keeping it', hostileId => {
      const trail = makeTrail();
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, config: { ...trail.config, id: hostileId } },
      });
      const parsed = parseHandoffJson(text);
      expect(parsed.config.id).not.toBe(hostileId);
      expect(parsed.config.id).toMatch(/^u_[a-z0-9]{1,40}$/);
    });

    it('still keeps a well-formed minted id', () => {
      expect(roundTrip(makeTrail()).config.id).toBe('u_abc123');
    });
  });

  describe('waypoints', () => {
    /** Build a handoff file whose single waypoint is `waypoint`. */
    function withWaypoint(waypoint: unknown): string {
      const trail = makeTrail();
      return JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, waypoints: [waypoint] },
      });
    }

    const good = {
      id: 'uw_deadbeef01',
      name: 'Hut',
      type: 'hut',
      lat: -33.87,
      lon: 151.21,
      elevation: 20,
      distance: 0.15,
      totalDistance: 0.15,
      ascent: 10,
      descent: 0,
      totalAscent: 10,
      totalDescent: 0,
      trackIndex: 1,
    };

    it('keeps a well-formed waypoint verbatim', () => {
      const [wp] = parseHandoffJson(withWaypoint(good)).waypoints;
      expect(wp).toMatchObject(good);
    });

    it('rejects a non-numeric latitude rather than plotting NaN', () => {
      expect(() => parseHandoffJson(withWaypoint({ ...good, lat: 'north' }))).toThrow(
        /non-numeric waypoints\[0\]\.lat/
      );
    });

    it('rejects an out-of-range longitude', () => {
      expect(() => parseHandoffJson(withWaypoint({ ...good, lon: 999 }))).toThrow(/out-of-range waypoints\[0\]\.lon/);
    });

    it('zeroes a missing cumulative stat rather than letting NaN reach the plan', () => {
      const [wp] = parseHandoffJson(withWaypoint(omit(good, 'totalDistance'))).waypoints;
      expect(wp.totalDistance).toBe(0);
    });

    it('re-mints a registry waypoint id so no server id enters a local guide', () => {
      const [wp] = parseHandoffJson(withWaypoint({ ...good, id: 'w_4f29a5cf' })).waypoints;
      expect(wp.id).toMatch(/^uw_[a-z0-9]+$/);
    });

    it('mints an id for a waypoint that carries none', () => {
      const text = withWaypoint(omit(good, 'id'));
      const [wp] = parseHandoffJson(text).waypoints;
      expect(wp.id).toMatch(/^uw_[a-z0-9]+$/);
      // Deterministic, so re-importing the same file is not a new waypoint.
      expect(parseHandoffJson(text).waypoints[0].id).toBe(wp.id);
    });

    it('keeps well-formed off-trail access fields', () => {
      const [wp] = parseHandoffJson(
        withWaypoint({
          ...good,
          type: 'town-access',
          offTrailKm: 35.4,
          accessMode: 'hitch',
          acceptsBoxes: true,
          store: 'full',
          accessName: '  Monarch Pass  ',
        })
      ).waypoints;
      expect(wp).toMatchObject({
        offTrailKm: 35.4,
        accessMode: 'hitch',
        acceptsBoxes: true,
        store: 'full',
        accessName: 'Monarch Pass',
      });
    });

    it('keeps the suffixed id an import gives a waypoint the route passes twice', () => {
      // `resolveDuplicateWaypointIds` mints `uw_<hash>_2`; refusing the suffix
      // re-minted it on every handoff, and anything keyed by it was lost.
      const [wp] = parseHandoffJson(withWaypoint({ ...good, id: 'uw_deadbeef01_2' })).waypoints;
      expect(wp.id).toBe('uw_deadbeef01_2');
    });

    it('still re-mints an id that only looks suffixed', () => {
      for (const id of ['uw_deadbeef01_', 'uw_deadbeef01_x', 'uw_dead_beef_01_2', 'uw_a_../x']) {
        const [wp] = parseHandoffJson(withWaypoint({ ...good, id })).waypoints;
        expect(wp.id).not.toBe(id);
        expect(wp.id).toMatch(/^uw_[a-z0-9]+$/);
      }
    });

    it('drops malformed access fields instead of letting them through the spread', () => {
      const [wp] = parseHandoffJson(
        withWaypoint({
          ...good,
          offTrailKm: 'thirty five',
          accessMode: 'teleport',
          acceptsBoxes: 'yes',
          store: 'supermarket',
          accessName: '   ',
        })
      ).waypoints;
      expect('store' in wp).toBe(false);
      // Absent, not zeroed: 0 km off-trail would read as "the route goes there".
      expect('offTrailKm' in wp).toBe(false);
      expect('accessMode' in wp).toBe(false);
      expect('acceptsBoxes' in wp).toBe(false);
      expect('accessName' in wp).toBe(false);
    });

    it('keeps a well-formed walk-in path and drops a malformed one', () => {
      const path = [
        [-34.005, 138],
        [-34.03, 138.012],
      ];
      const [kept] = parseHandoffJson(withWaypoint({ ...good, offTrailKm: 2.5, offTrailPath: path })).waypoints;
      expect(kept.offTrailPath).toEqual(path);
      for (const bad of [
        [[-34, 138]],
        [
          [-34, 138],
          [-34, 'x'],
        ],
        [
          [-34, 138],
          [95, 138],
        ],
        'path',
        [
          [-34, 138, 5],
          [-34, 138],
        ],
      ]) {
        const [wp] = parseHandoffJson(withWaypoint({ ...good, offTrailPath: bad })).waypoints;
        expect('offTrailPath' in wp).toBe(false);
      }
    });
  });
});

describe('parseHandoffJson: variants and off-trail waypoints', () => {
  const variantWaypoint = {
    id: 'w_registry1',
    name: 'Hut',
    type: 'hut',
    lat: -33.871,
    lon: 151.211,
    elevation: 30,
    distance: 0.2,
    totalDistance: 0.35,
    ascent: 5,
    descent: 0,
    totalAscent: 5,
    totalDescent: 0,
    variantTrackIndex: 1,
  };
  const variant = {
    name: 'Alt: High route',
    type: 'alternate',
    points: [
      { lat: -33.87, lon: 151.21, ele: 25 },
      { lat: -33.871, lon: 151.211, ele: 30 },
      { lat: -33.875, lon: 151.215, ele: 40 },
    ],
    distance: 0.7,
    elevation: { ascent: 15, descent: 0 },
    startDistance: 0.15,
    endDistance: 0.85,
    startTrackIndex: 1,
    endTrackIndex: 2,
    waypoints: [variantWaypoint],
  };
  const offTrail = {
    id: 'w_registry2',
    name: 'Far Spring',
    type: 'water',
    lat: -33.9,
    lon: 151.3,
    distanceFromTrail: 4200,
  };

  function file(trail: Record<string, unknown>): string {
    return JSON.stringify({ format: HANDOFF_FORMAT, version: 1, trail: { ...makeTrail(), ...trail } });
  }

  it('carries well-formed variants and off-trail waypoints through', () => {
    const parsed = parseHandoffJson(file({ alternates: [variant], sideTrips: [], offTrailWaypoints: [offTrail] }));
    expect(parsed.alternates[0]).toMatchObject({
      name: 'Alt: High route',
      type: 'alternate',
      points: variant.points,
      startDistance: 0.15,
      endDistance: 0.85,
    });
    expect(parsed.alternates[0].waypoints![0]).toMatchObject({ name: 'Hut', totalDistance: 0.35 });
    expect(parsed.offTrailWaypoints[0]).toMatchObject({ name: 'Far Spring', distanceFromTrail: 4200 });
  });

  it('gives no registry id to a variant or off-trail waypoint either', () => {
    const parsed = parseHandoffJson(file({ alternates: [variant], offTrailWaypoints: [offTrail] }));
    expect(parsed.alternates[0].waypoints![0].id).toMatch(/^uw_[a-z0-9]+$/);
    expect(parsed.offTrailWaypoints[0].id).toMatch(/^uw_[a-z0-9]+$/);
  });

  it('re-mints a waypoint the same way on a variant as on the main route', () => {
    const mainWaypoint = {
      ...variantWaypoint,
      distance: 0.15,
      totalDistance: 0.15,
      trackIndex: 1,
    };
    const parsed = parseHandoffJson(file({ waypoints: [mainWaypoint], alternates: [variant] }));
    expect(parsed.alternates[0].waypoints![0].id).toBe(parsed.waypoints[0].id);
  });

  it('rejects a variant point that is not a number rather than drawing NaN', () => {
    const bad = { ...variant, points: [variant.points[0], { lat: 'north', lon: 151.2, ele: 3 }] };
    expect(() => parseHandoffJson(file({ alternates: [bad] }))).toThrow(
      /non-numeric alternates\[0\]\.points\[1\]\.lat/
    );
  });

  it('rejects a variant off the globe', () => {
    const bad = { ...variant, points: [{ lat: -33.87, lon: 251.2, ele: 3 }] };
    expect(() => parseHandoffJson(file({ sideTrips: [{ ...bad, type: 'side-trip' }] }))).toThrow(
      /out-of-range sideTrips\[0\]\.points\[0\]\.lon/
    );
  });

  it('rejects a junction km that is not a number', () => {
    expect(() => parseHandoffJson(file({ alternates: [{ ...variant, startDistance: '0.15' }] }))).toThrow(
      /non-numeric alternates\[0\]\.startDistance/
    );
  });

  it('rejects an unknown variant type and a variant with no point list', () => {
    expect(() => parseHandoffJson(file({ alternates: [{ ...variant, type: 'shortcut' }] }))).toThrow(
      /unknown alternates\[0\]\.type/
    );
    expect(() => parseHandoffJson(file({ alternates: [{ ...variant, points: 'none' }] }))).toThrow(
      /no point list on alternates\[0\]/
    );
  });

  it('rejects a list that is not a list', () => {
    expect(() => parseHandoffJson(file({ sideTrips: { 0: variant } }))).toThrow(/malformed sideTrips/);
    expect(() => parseHandoffJson(file({ offTrailWaypoints: 'none' }))).toThrow(/malformed offTrailWaypoints/);
  });

  it('rejects an off-trail waypoint with no usable position', () => {
    expect(() => parseHandoffJson(file({ offTrailWaypoints: [{ ...offTrail, lat: null }] }))).toThrow(
      /non-numeric offTrailWaypoints\[0\]\.lat/
    );
  });

  it('rejects a variant waypoint with no usable position', () => {
    const bad = { ...variant, waypoints: [{ ...variantWaypoint, lon: 'east' }] };
    expect(() => parseHandoffJson(file({ alternates: [bad] }))).toThrow(
      /non-numeric alternates\[0\]\.waypoints\[0\]\.lon/
    );
  });
});

describe('parseHandoffJson: points of interest', () => {
  /** A POI as `@lib/trail-pois` writes one. */
  const poi = {
    id: 12345,
    type: 'node',
    category: 'water',
    lat: -33.87,
    lon: 151.21,
    name: 'Tap',
    tags: { amenity: 'drinking_water', name: 'Tap' },
    distanceAlongTrail: 0.4,
    distanceFromTrail: 0.02,
  };

  /** Round-trip a trail whose `pois` array is exactly `pois`. */
  function withPois(pois: unknown): ProcessedTrail {
    const trail = { ...makeTrail(), pois } as ProcessedTrail;
    return roundTrip(trail);
  }

  it('carries POIs through the envelope', () => {
    expect(withPois([poi]).pois).toEqual([poi]);
  });

  it('leaves pois absent when the file has none', () => {
    expect(roundTrip(makeTrail()).pois).toBeUndefined();
    expect(withPois([]).pois).toBeUndefined();
  });

  it('drops a malformed POI rather than rejecting the file', () => {
    const parsed = withPois([
      poi,
      { ...poi, id: 2, lat: 'north' },
      { ...poi, id: 3, category: 'unicorn' },
      { ...poi, id: 4, lon: 999 },
      'not an object',
    ]);
    expect(parsed.pois?.map(p => p.id)).toEqual([12345]);
    // The trail itself is untouched by a bad POI.
    expect(parsed.track.points).toHaveLength(3);
  });

  it('defaults the optional fields of an otherwise valid POI', () => {
    const [parsed] = withPois([{ id: 9, type: 'way', category: 'camping', lat: -33.87, lon: 151.21 }]).pois!;
    expect(parsed).toEqual({
      id: 9,
      type: 'way',
      category: 'camping',
      lat: -33.87,
      lon: 151.21,
      name: null,
      tags: {},
      distanceAlongTrail: 0,
      distanceFromTrail: 0,
    });
  });

  it('carries the POI-duplicate flag, but drops one naming a POI the file lacks', () => {
    const parsed = withPois([
      poi,
      { ...poi, id: 2, duplicateOfPoi: 'node/12345', duplicateOfPoiDistanceM: 12 },
      { ...poi, id: 3, duplicateOfPoi: 'node/999', duplicateOfPoiDistanceM: 4 },
      { ...poi, id: 4, duplicateOfPoi: 7 },
    ]).pois!;
    expect(parsed[1]).toMatchObject({ duplicateOfPoi: 'node/12345', duplicateOfPoiDistanceM: 12 });
    // A dangling key would hide the place with nothing left to show it.
    expect(parsed[2]).not.toHaveProperty('duplicateOfPoi');
    expect(parsed[2]).not.toHaveProperty('duplicateOfPoiDistanceM');
    expect(parsed[3]).not.toHaveProperty('duplicateOfPoi');
  });

  it('drops a POI-duplicate flag pointing at another hidden repeat, or at itself', () => {
    const parsed = withPois([
      poi,
      { ...poi, id: 2, duplicateOfPoi: 'node/12345' },
      { ...poi, id: 3, duplicateOfPoi: 'node/2' },
      { ...poi, id: 4, duplicateOfPoi: 'node/4' },
    ]).pois!;
    expect(parsed[1]).toMatchObject({ duplicateOfPoi: 'node/12345' });
    // Pointing at a record that is itself hidden would hide the place twice over.
    expect(parsed[2]).not.toHaveProperty('duplicateOfPoi');
    expect(parsed[3]).not.toHaveProperty('duplicateOfPoi');
  });
});

describe('handoffImportReport', () => {
  it('reports counts from the already-built trail', () => {
    const trail = makeTrail();
    const report = handoffImportReport(trail);
    expect(report).toMatchObject({
      trailId: 'u_abc123',
      name: 'Weekend Loop',
      hasElevation: true,
      elevationLooksNoisy: false,
      pointCount: 3,
      sourcePointCount: 3,
      waypointCount: 0,
      tracksFound: 1,
      tracksCombined: 1,
      simplified: false,
      warnings: [],
      gapWarnings: [],
    });
  });

  it('flags a flat profile as having no elevation', () => {
    const trail = makeTrail();
    const flat = makeTrail({
      track: {
        ...trail.track,
        points: trail.track.points.map(p => ({ ...p, ele: 0 })),
      },
    });
    expect(handoffImportReport(flat).hasElevation).toBe(false);
  });

  it('counts nothing for a trail that was never enriched', () => {
    expect(handoffImportReport(makeTrail()).poiCount).toBe(0);
  });

  it('counts the POIs the app will actually show, skipping flagged duplicates', () => {
    const base = {
      type: 'node',
      category: 'camping' as const,
      lat: -33.87,
      lon: 151.21,
      name: 'Hut',
      tags: {},
      distanceAlongTrail: 0.4,
      distanceFromTrail: 0.02,
    };
    const trail = makeTrail({
      pois: [
        { ...base, id: 1 },
        { ...base, id: 2, duplicateOf: 'w_hut' },
        { ...base, id: 3 },
        { ...base, id: 4, duplicateOfPoi: 'node/3' },
      ],
    });
    expect(handoffImportReport(trail).poiCount).toBe(2);
  });

  it('counts variants', () => {
    const variant = {
      name: 'Alt',
      type: 'alternate' as const,
      points: [],
      distance: 1,
      elevation: { ascent: 0, descent: 0 },
    };
    const report = handoffImportReport(makeTrail({ alternates: [variant], sideTrips: [variant] }));
    expect(report.alternateCount).toBe(1);
    expect(report.sideTripCount).toBe(1);
  });
});

describe('route breaks over the handoff', () => {
  const breaks = [
    {
      index: 2,
      displayIndex: 2,
      km: 0.15,
      straightLineKm: 52.7,
      fromTrack: 'Stretch 1',
      toTrack: 'Stretch 2',
    },
  ];

  function brokenTrail() {
    const trail = makeTrail();
    return { ...trail, track: { ...trail.track, breaks } };
  }

  it('survives the round trip intact', () => {
    expect(roundTrip(brokenTrail()).track.breaks).toEqual(breaks);
  });

  it('leaves a continuous trail without a breaks field', () => {
    expect(roundTrip(makeTrail()).track.breaks).toBeUndefined();
  });

  it('re-points displayIndex when the file carries no displayPoints', () => {
    // parseHandoffJson falls back to `points` for the display copy, so a stored
    // displayIndex would then be indexing an array that is not there.
    const trail = brokenTrail();
    const wrapped = JSON.parse(serializeTrailHandoff(trail));
    delete wrapped.trail.track.displayPoints;
    wrapped.trail.track.breaks[0].displayIndex = 999;

    const parsed = parseHandoffJson(JSON.stringify(wrapped));

    expect(parsed.track.displayPoints).toEqual(parsed.track.points);
    expect(parsed.track.breaks?.[0].displayIndex).toBe(2);
  });

  it('rejects a break with a non-finite index rather than drawing one line', () => {
    const trail = brokenTrail();
    const wrapped = JSON.parse(serializeTrailHandoff(trail));
    wrapped.trail.track.breaks[0].index = 'ferry';

    expect(() => parseHandoffJson(JSON.stringify(wrapped))).toThrow();
  });
});

describe('the plan in the handoff', () => {
  const hut = {
    id: 'uw_hut0001',
    name: 'Hut',
    type: 'hut',
    lat: -33.87,
    lon: 151.21,
    elevation: 25,
    distance: 0.15,
    totalDistance: 0.15,
    ascent: 15,
    descent: 0,
    totalAscent: 15,
    totalDescent: 0,
    trackIndex: 1,
  };
  const shop = { ...hut, id: 'uw_shop0001', name: 'Store', type: 'resupply', lat: -33.875, lon: 151.215 };

  function plannedTrail(): ProcessedTrail {
    return makeTrail({ waypoints: [hut, shop] });
  }

  function makePlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
    return {
      id: '6f1c2e9a-4b7d-4c1e-9a3f-2d8b5e7c1a90',
      trailId: 'u_abc123',
      name: 'Easter trip',
      direction: 'NOBO',
      startDate: '2026-04-03',
      stops: [{ waypointId: 'uw_hut0001', km: 0.15, name: 'Hut', nights: 2, note: 'Book ahead', booked: true }],
      resupplyStops: ['uw_shop0001'],
      resupplyZeroDays: { uw_shop0001: 0.5 },
      updatedAt: '2026-03-01T10:00:00.000Z',
      version: 1,
      ...overrides,
    };
  }

  it('writes a trail-only file as version 1, unchanged, so an older app still opens it', () => {
    const trail = plannedTrail();
    expect(serializeTrailHandoff(trail)).toBe(
      JSON.stringify({ format: HANDOFF_FORMAT, version: HANDOFF_TRAIL_VERSION, trail })
    );
    expect(serializeTrailHandoff(trail, { plan: null })).toBe(serializeTrailHandoff(trail));
  });

  it('writes version 2 when a plan is included, and reads both', () => {
    const wrapped = wrapTrailForHandoff(plannedTrail(), { plan: makePlan() });
    expect(wrapped.version).toBe(HANDOFF_PLAN_VERSION);
    expect(HANDOFF_VERSION).toBe(HANDOFF_PLAN_VERSION);
    expect(parseHandoff(serializeTrailHandoff(plannedTrail())).plan).toBeNull();
  });

  it('round-trips the plan, re-keyed to the imported trail', () => {
    const { trail, plan, warnings } = parseHandoff(serializeTrailHandoff(plannedTrail(), { plan: makePlan() }));
    expect(warnings).toEqual([]);
    expect(plan).toEqual({ ...makePlan(), trailId: trail.config.id });
  });

  it('round-trips every optional field a plan can hold', () => {
    const full = makePlan({
      stops: [
        { waypointId: 'uw_hut0001', km: 0.15, name: 'Hut', nights: 2, note: 'Book ahead', booked: true },
        { km: 0.4, name: 'Camp on the alternate', nights: 1, alternate: 'High route' },
      ],
      alternates: ['High route'],
      startZeroDays: 1.5,
      dataUpdatedAt: '2026-02-01T00:00:00.000Z',
    });
    const { trail, plan, warnings } = parseHandoff(serializeTrailHandoff(plannedTrail(), { plan: full }));
    expect(warnings).toEqual([]);
    expect(plan).toEqual({ ...full, trailId: trail.config.id });
  });

  it('re-keys a plan saved under another id (a community route’s local copy) to the trail’s', () => {
    const source = plannedTrail();
    source.config = { ...source.config, id: 'c_route42', source: 'community' };
    const { trail, plan } = parseHandoff(serializeTrailHandoff(source, { plan: makePlan({ trailId: 'u_cxyz' }) }));
    expect(trail.config.id).toMatch(/^u_[a-z0-9]+$/);
    expect(plan?.trailId).toBe(trail.config.id);
  });

  it('gives a re-minted trail the same id with or without its plan, and whatever the plan says', () => {
    const source = plannedTrail();
    source.config = { ...source.config, id: 'c_route42', source: 'community' };
    const without = parseHandoff(serializeTrailHandoff(source)).trail.config.id;
    const withPlan = parseHandoff(serializeTrailHandoff(source, { plan: makePlan() })).trail.config.id;
    const edited = parseHandoff(serializeTrailHandoff(source, { plan: makePlan({ name: 'Edited' }) })).trail.config.id;
    expect(withPlan).toBe(without);
    expect(edited).toBe(without);
  });

  it('follows the waypoint ids the trail was re-minted to', () => {
    const source = makeTrail({
      waypoints: [
        { ...hut, id: 'w_registryhut' },
        { ...shop, id: 'w_registryshop' },
      ],
    });
    const plan = makePlan({
      stops: [{ waypointId: 'w_registryhut', km: 0.15, name: 'Hut', nights: 1 }],
      resupplyStops: ['w_registryshop'],
      resupplyZeroDays: { w_registryshop: 1 },
    });
    const parsed = parseHandoff(serializeTrailHandoff(source, { plan }));
    const [hutId, shopId] = parsed.trail.waypoints.map(w => w.id);
    expect(hutId).toMatch(/^uw_/);
    expect(parsed.plan?.stops[0].waypointId).toBe(hutId);
    expect(parsed.plan?.resupplyStops).toEqual([shopId]);
    expect(parsed.plan?.resupplyZeroDays).toEqual({ [String(shopId)]: 1 });
  });

  it('follows an id re-minted only off the main route', () => {
    const offTrail = { id: 'w_farspring', name: 'Far Spring', type: 'water', lat: -33.9, lon: 151.3 };
    const source = makeTrail({ offTrailWaypoints: [offTrail as never] });
    const plan = makePlan({ stops: [], resupplyStops: ['w_farspring'], resupplyZeroDays: undefined });
    const parsed = parseHandoff(serializeTrailHandoff(source, { plan }));
    expect(parsed.plan?.resupplyStops).toEqual([parsed.trail.offTrailWaypoints[0].id]);
  });

  it('carries only the document — never per-device inputs a record picked up', () => {
    const polluted = {
      ...makePlan(),
      pace: 'fast',
      dailyHours: 11,
      thresholds: { dryStretchKm: 30 },
      stops: [{ ...makePlan().stops[0], extra: 'x' }],
    } as unknown as PlanDocument;
    const text = serializeTrailHandoff(plannedTrail(), { plan: polluted });
    expect(text).not.toMatch(/pace|dailyHours|thresholds|extra/);

    // A crafted file is trimmed on the way in too.
    const crafted = JSON.parse(text) as Record<string, unknown>;
    crafted.plan = polluted;
    const { plan } = parseHandoff(JSON.stringify(crafted));
    expect(Object.keys(plan!).sort()).toEqual(Object.keys(makePlan()).sort());
    expect(plan!.stops[0]).not.toHaveProperty('extra');
  });

  it.each<[string, unknown]>([
    ['not an object', 'a plan'],
    ['a stop with a string km', { ...makePlan(), stops: [{ km: '1', name: 'Hut', nights: 1 }] }],
    ['an unknown direction', { ...makePlan(), direction: 'EAST' }],
    ['a name over the limit', { ...makePlan(), name: 'x'.repeat(500) }],
    ['two stops on one waypoint', { ...makePlan(), stops: [makePlan().stops[0], { ...makePlan().stops[0], km: 0.5 }] }],
    ['a malformed waypoint id', { ...makePlan(), resupplyStops: ['not an id!'] }],
  ])('drops a plan that is %s, with a warning, and still imports the trail', (_label, badPlan) => {
    const file = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: HANDOFF_PLAN_VERSION,
      trail: plannedTrail(),
      plan: badPlan,
    });
    const parsed = parseHandoff(file);
    expect(parsed.plan).toBeNull();
    expect(parsed.warnings).toEqual([HANDOFF_PLAN_UNREADABLE]);
    expect(parsed.trail.config.id).toBe('u_abc123');
    expect(handoffImportReport(parsed.trail, parsed.warnings).warnings).toEqual([HANDOFF_PLAN_UNREADABLE]);
  });

  it('ignores a plan key on a version-1 file, which no build ever wrote', () => {
    const file = JSON.stringify({ format: HANDOFF_FORMAT, version: 1, trail: plannedTrail(), plan: makePlan() });
    expect(parseHandoff(file)).toMatchObject({ plan: null, warnings: [] });
  });

  it('treats a null plan on a version-2 file as no plan', () => {
    const file = JSON.stringify({ format: HANDOFF_FORMAT, version: 2, trail: plannedTrail(), plan: null });
    expect(parseHandoff(file)).toMatchObject({ plan: null, warnings: [] });
  });

  it('keeps parseHandoffJson returning just the trail', () => {
    const text = serializeTrailHandoff(plannedTrail(), { plan: makePlan() });
    expect(parseHandoffJson(text)).toEqual(parseHandoff(text).trail);
  });
});

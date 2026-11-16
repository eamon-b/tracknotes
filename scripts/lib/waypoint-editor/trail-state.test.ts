import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignWaypointIds, MATCH_RADIUS_METERS, type WaypointRegistry } from '../waypoint-ids';
import { haversineDistance } from '../../../src/lib/distance';
import type { WaypointEditRequest } from './api-types';
import {
  EditorError,
  editorPaths,
  listTrails,
  loadEditorTrail,
  saveWaypointEdit,
  type EditorPaths,
} from './trail-state';

const GPX = [
  '<gpx version="1.1">',
  '  <wpt lat="-36.5" lon="148.25"><name>H Upper Hut</name><desc>Hut with a tank</desc><type>hut</type></wpt>',
  '  <wpt lat="-36.52" lon="148.3"><name>Spring</name><type>water</type></wpt>',
  '  <wpt lat="-36.55" lon="148.35"><name>Saddle Camp</name><type>campsite</type></wpt>',
  '  <trk><trkseg><trkpt lat="-36.5" lon="148.2"/><trkpt lat="-36.6" lon="148.4"/></trkseg></trk>',
  '</gpx>',
  '',
].join('\n');

const track = [
  { lat: -36.5, lon: 148.2, dist: 0, ele: 0 },
  { lat: -36.55, lon: 148.3, dist: 10, ele: 0 },
  { lat: -36.6, lon: 148.4, dist: 20, ele: 0 },
];

const BUILT = {
  config: { id: 'demo', name: 'Demo Track' },
  track: { points: track, displayPoints: track, totalDistance: 20, totalAscent: 0, totalDescent: 0 },
  waypoints: [
    {
      id: 'w_aaaa1111',
      name: 'Upper Hut',
      type: 'hut',
      lat: -36.5,
      lon: 148.25,
      totalDistance: 4,
      description: 'Hut with a tank',
    },
    { id: 'w_cccc3333', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35, totalDistance: 14 },
  ],
  offTrailWaypoints: [
    { id: 'w_bbbb2222', name: 'Spring', type: 'water', lat: -36.52, lon: 148.3, distanceFromTrail: 0.4 },
  ],
  alternates: [],
  sideTrips: [],
  pois: [{ id: 1, type: 'node', category: 'water', lat: -36.5201, lon: 148.3001, name: 'Spring tap', tags: {} }],
};

const REGISTRY: WaypointRegistry = {
  demo: [
    { id: 'w_aaaa1111', name: 'Upper Hut', type: 'hut', lat: -36.5, lon: 148.25 },
    { id: 'w_bbbb2222', name: 'Spring', type: 'water', lat: -36.52, lon: 148.3 },
    { id: 'w_cccc3333', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35 },
  ],
};

const DESCRIPTIONS = {
  trailId: 'demo',
  descriptions: [{ waypointId: 'w_cccc3333', name: 'Saddle Camp', description: 'A flat saddle.' }],
};

let root: string;
let paths: EditorPaths;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of ['data/trails/demo/demo.gpx', 'data/trails/demo/descriptions.json', 'data/waypoint-ids.json']) {
    out[rel] = read(rel);
  }
  return out;
}

function request(dir: string, id: string, edit: Omit<WaypointEditRequest, 'expected'>) {
  const w = loadEditorTrail(paths, dir).waypoints.find(x => x.id === id)!;
  return saveWaypointEdit(paths, dir, id, {
    expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description },
    ...edit,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-'));
  paths = editorPaths(root);
  write('data/trails/demo/trail.json', JSON.stringify({ id: 'demo', name: 'Demo Track', gpxFile: 'demo.gpx' }));
  write('data/trails/demo/demo.gpx', GPX);
  write('data/trails/demo/descriptions.json', `${JSON.stringify(DESCRIPTIONS, null, 2)}\n`);
  write('data/trails/te_araroa/trail.json', JSON.stringify({ id: 'te_araroa', name: 'Te Araroa', gpxFile: 'ta.gpx' }));
  write('data/trails/te_araroa/ta.gpx', GPX);
  write('public/data/generated/demo.json', JSON.stringify(BUILT));
  write('public/data/generated/te_araroa.json', JSON.stringify({ ...BUILT, config: { id: 'te_araroa' } }));
  write('data/waypoint-ids.json', `${JSON.stringify({ ...REGISTRY, te_araroa: REGISTRY.demo }, null, 2)}\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadEditorTrail', () => {
  it('joins each built waypoint to its source', () => {
    const trail = loadEditorTrail(paths, 'demo');
    expect(trail.waypoints.map(w => [w.id, w.name, w.canMove])).toEqual([
      ['w_aaaa1111', 'Upper Hut', true],
      ['w_bbbb2222', 'Spring', true],
      ['w_cccc3333', 'Saddle Camp', true],
    ]);
    const hut = trail.waypoints[0];
    expect(hut.description).toBe('');
    expect(hut.sourceDescription).toBe('Hut with a tank');
    expect(trail.waypoints[2].description).toBe('A flat saddle.');
    expect(trail.waypoints[1].placements).toEqual([{ kind: 'off-trail' }]);
    expect(trail.pois).toEqual([{ id: 'node/1', name: 'Spring tap', category: 'water', lat: -36.5201, lon: 148.3001 }]);
  });

  it('refuses a directory that is not a trail', () => {
    expect(() => loadEditorTrail(paths, '../..')).toThrow(EditorError);
  });

  it('keeps Te Araroa read-only', () => {
    expect(listTrails(paths).find(t => t.dir === 'te_araroa')?.readOnlyReason).toMatch(/upstream/);
    const w = loadEditorTrail(paths, 'te_araroa').waypoints[0];
    expect([w.canMove, w.canRename, w.canDescribe]).toEqual([false, false, false]);
    expect(() => request('te_araroa', w.id, { description: 'x' })).toThrow(/upstream/);
  });
});

describe('saveWaypointEdit', () => {
  it('moves and renames in the GPX, the registry and the description aid, and the id survives the next build', () => {
    request('demo', 'w_cccc3333', { lat: -36.554, lon: 148.356, name: 'Saddle Campsite' });

    const gpx = read('data/trails/demo/demo.gpx');
    expect(gpx).toBe(
      GPX.replace(
        '<wpt lat="-36.55" lon="148.35"><name>Saddle Camp</name>',
        '<wpt lat="-36.554" lon="148.356"><name>Saddle Campsite</name>'
      )
    );
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    const entry = registry.demo.find(e => e.id === 'w_cccc3333')!;
    expect(entry).toEqual({ id: 'w_cccc3333', name: 'Saddle Campsite', type: 'campsite', lat: -36.554, lon: 148.356 });
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions[0].name).toBe('Saddle Campsite');

    // The move was further than the registry's match radius: without the entry
    // moving too, the next build would mint a new id and orphan its comments.
    expect(haversineDistance(-36.55, 148.35, -36.554, 148.356)).toBeGreaterThan(MATCH_RADIUS_METERS);
    const ids = assignWaypointIds(
      'demo',
      [
        { name: 'Upper Hut', type: 'hut', lat: -36.5, lon: 148.25 },
        { name: 'Spring', type: 'water', lat: -36.52, lon: 148.3 },
        { name: 'Saddle Campsite', type: 'campsite', lat: -36.554, lon: 148.356 },
      ],
      registry
    );
    expect(ids).toEqual(['w_aaaa1111', 'w_bbbb2222', 'w_cccc3333']);

    // And the editor still finds it before any rebuild.
    const after = loadEditorTrail(paths, 'demo').waypoints.find(w => w.id === 'w_cccc3333')!;
    expect([after.name, after.lat, after.lon, after.canMove]).toEqual(['Saddle Campsite', -36.554, 148.356, true]);
    expect([after.builtName, after.builtLat]).toEqual(['Saddle Camp', -36.55]);
  });

  it('keeps the type prefix on a rename', () => {
    request('demo', 'w_aaaa1111', { name: 'Upper Huts' });
    expect(read('data/trails/demo/demo.gpx')).toContain('<name>H Upper Huts</name>');
  });

  it('adds a description in km order (main route first), replaces it, and removes it when emptied', () => {
    request('demo', 'w_bbbb2222', { description: '  A spring below the track.  ' });
    request('demo', 'w_aaaa1111', { description: 'A two-room hut.' });
    const order = () =>
      (JSON.parse(read('data/trails/demo/descriptions.json')).descriptions as { waypointId: string }[]).map(
        d => d.waypointId
      );
    expect(order()).toEqual(['w_aaaa1111', 'w_cccc3333', 'w_bbbb2222']);
    const file = JSON.parse(read('data/trails/demo/descriptions.json'));
    expect(file.descriptions[2]).toEqual({
      waypointId: 'w_bbbb2222',
      name: 'Spring',
      description: 'A spring below the track.',
    });
    expect(read('data/trails/demo/descriptions.json').endsWith('}\n')).toBe(true);

    request('demo', 'w_aaaa1111', { description: '' });
    expect(order()).toEqual(['w_cccc3333', 'w_bbbb2222']);
  });

  it('creates descriptions.json for a trail without one', () => {
    fs.rmSync(path.join(root, 'data/trails/demo/descriptions.json'));
    const result = request('demo', 'w_aaaa1111', { description: 'A two-room hut.' });
    expect(result.changedFiles).toEqual(['data/trails/demo/descriptions.json']);
    const file = JSON.parse(read('data/trails/demo/descriptions.json'));
    expect(file.trailId).toBe('demo');
    expect(file.descriptions).toEqual([
      { waypointId: 'w_aaaa1111', name: 'Upper Hut', description: 'A two-room hut.' },
    ]);
  });

  it('refuses an edit made against stale content, writing nothing', () => {
    const before = snapshot();
    expect(() =>
      saveWaypointEdit(paths, 'demo', 'w_cccc3333', {
        expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'Something else' },
        description: 'New text.',
      })
    ).toThrow(expect.objectContaining({ status: 409 }));
    expect(snapshot()).toEqual(before);
  });

  it('refuses a move that is surely a slip, and an over-long description', () => {
    expect(() => request('demo', 'w_aaaa1111', { lat: -37.5, lon: 148.25 })).toThrow(/more than 50 km/);
    expect(() => request('demo', 'w_aaaa1111', { description: 'x'.repeat(4001) })).toThrow(/longer than/);
  });

  it('writes nothing when one of the files cannot be rewritten without reformatting it', () => {
    write('data/trails/demo/descriptions.json', JSON.stringify(DESCRIPTIONS, null, 3));
    const before = snapshot();
    expect(() => request('demo', 'w_cccc3333', { name: 'Saddle Campsite', description: 'A saddle.' })).toThrow(
      /cannot be reproduced/
    );
    expect(snapshot()).toEqual(before);
  });

  it('notes what a move leaves for a human', () => {
    write(
      'data/trails/demo/access.json',
      JSON.stringify({ places: { w_bbbb2222: { name: 'Spring', method: 'osm', junction: [-36.52, 148.29] } } })
    );
    const result = request('demo', 'w_bbbb2222', { lat: -36.521, lon: 148.301 });
    expect(result.notes.join('\n')).toMatch(/fetch:access/);
    expect(result.changedFiles.sort()).toEqual(['data/trails/demo/demo.gpx', 'data/waypoint-ids.json']);
  });
});

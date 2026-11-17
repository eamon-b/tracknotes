import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignWaypointIds, MATCH_RADIUS_METERS, type WaypointRegistry } from '../waypoint-ids';
import { haversineDistance } from '../../../src/lib/distance';
import { PENDING_KEY_PREFIX, type WaypointEditRequest } from './api-types';
import type { DemSource } from './elevation';
import {
  addWaypoint,
  deleteWaypoint,
  EditorError,
  editorPaths,
  listTrails,
  loadEditorTrail,
  lookupWaypointElevation,
  registryId,
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

// A CalTopo-typed trail: the GPX carries names only, the export's folders type them.
const TOPO_GPX =
  '<?xml version="1.0"?>\n<gpx creator="CALTOPO" version="1.1">' +
  '<wpt lat="-36.5" lon="148.25"><name>C Flat</name></wpt>' +
  '<wpt lat="-36.52" lon="148.3"><name>W Creek</name></wpt>' +
  '<wpt lat="-36.55" lon="148.35"><name>T Hamlet</name></wpt>' +
  '<trk><trkseg><trkpt lat="-36.5" lon="148.2"/><trkpt lat="-36.6" lon="148.4"/></trkseg></trk></gpx>';

const TOPO_GEOJSON =
  '{"features":[' +
  '{"geometry":null,"id":"f1","type":"Feature","properties":{"title":"Campsites","class":"Folder"}},' +
  '{"geometry":null,"id":"f2","type":"Feature","properties":{"title":"Water Sources","class":"Folder"}},' +
  '{"geometry":{"coordinates":[148.25,-36.5,0,0],"type":"Point"},"id":"m1","type":"Feature","properties":{"title":"C Flat","class":"Marker","folderId":"f1","description":"A flat."}},' +
  '{"geometry":{"coordinates":[148.3,-36.52,0,0],"type":"Point"},"id":"m2","type":"Feature","properties":{"title":"W Creek","class":"Marker","folderId":"f2"}}' +
  '],"type":"FeatureCollection"}';

const TOPO_REGISTRY = [
  { id: 'w_dddd4444', name: 'Flat', type: 'campsite', lat: -36.5, lon: 148.25 },
  { id: 'w_eeee5555', name: 'Creek', type: 'water', lat: -36.52, lon: 148.3 },
  { id: 'w_ffff6666', name: 'Hamlet', type: 'town', lat: -36.55, lon: 148.35 },
];

const TOPO_BUILT = {
  ...BUILT,
  config: { id: 'topo', name: 'Topo Track' },
  waypoints: [
    { id: 'w_dddd4444', name: 'Flat', type: 'campsite', lat: -36.5, lon: 148.25, totalDistance: 4 },
    { id: 'w_eeee5555', name: 'Creek', type: 'water', lat: -36.52, lon: 148.3, totalDistance: 8 },
    { id: 'w_ffff6666', name: 'Hamlet', type: 'town', lat: -36.55, lon: 148.35, totalDistance: 14 },
  ],
  offTrailWaypoints: [],
  pois: [],
};

function writeTopo(): void {
  write('data/trails/topo/trail.json', JSON.stringify({ id: 'topo', name: 'Topo Track', gpxFile: 'topo.gpx' }));
  write('data/trails/topo/topo.gpx', TOPO_GPX);
  write('data/trails/topo/topo.json', TOPO_GEOJSON);
  write('public/data/generated/topo.json', JSON.stringify(TOPO_BUILT));
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  write('data/waypoint-ids.json', `${JSON.stringify({ ...registry, topo: TOPO_REGISTRY }, null, 2)}\n`);
}

function topoFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of ['data/trails/topo/topo.gpx', 'data/trails/topo/topo.json', 'data/waypoint-ids.json']) {
    out[rel] = read(rel);
  }
  return out;
}

/** What the build hands `assignWaypointIds` for a trail as its sources stand now. */
function buildInputs(dir: string): { name: string; type: string; lat: number; lon: number }[] {
  return loadEditorTrail(paths, dir)
    .waypoints.filter(w => !w.deleted)
    .map(w => ({ name: w.name, type: w.type, lat: w.lat, lon: w.lon }));
}

describe('registryId', () => {
  it('strips a revisit suffix, and only that', () => {
    expect(registryId('w_07233ee1_2')).toBe('w_07233ee1');
    expect(registryId('w_00176641')).toBe('w_00176641');
    expect(registryId('w_00176641_3')).toBe('w_00176641');
  });
});

describe('type changes', () => {
  it('rewrites the GPX <type> and the registry entry, so the id survives the next build', () => {
    const result = request('demo', 'w_bbbb2222', { type: 'water-tank' });
    expect(read('data/trails/demo/demo.gpx')).toBe(
      GPX.replace('<name>Spring</name><type>water</type>', '<name>Spring</name><type>water-tank</type>')
    );
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.demo.find(e => e.id === 'w_bbbb2222')?.type).toBe('water-tank');
    expect(result.waypoint).toMatchObject({ type: 'water-tank', builtType: 'water', typeSource: 'its GPX <type>' });
    expect(result.changedFiles.sort()).toEqual(['data/trails/demo/demo.gpx', 'data/waypoint-ids.json']);

    // The registry matches on type: with the entry migrated the id holds…
    const inputs = buildInputs('demo');
    expect(assignWaypointIds('demo', inputs, structuredClone(registry))).toEqual([
      'w_aaaa1111',
      'w_bbbb2222',
      'w_cccc3333',
    ]);
    // …and without it the next build would have minted a new one and orphaned its comments.
    const unmigrated = assignWaypointIds('demo', inputs, structuredClone(REGISTRY));
    expect(unmigrated[1]).not.toBe('w_bbbb2222');
  });

  it('moves a CalTopo marker into an existing folder for the type, keeping the id', () => {
    writeTopo();
    const result = request('topo', 'w_dddd4444', { type: 'water' });
    expect(read('data/trails/topo/topo.json')).toBe(
      TOPO_GEOJSON.replace('"C Flat","class":"Marker","folderId":"f1"', '"C Flat","class":"Marker","folderId":"f2"')
    );
    expect(read('data/trails/topo/topo.gpx')).toBe(TOPO_GPX);
    expect(result.notes.join('\n')).toMatch(/folder “Water Sources”/);
    expect(result.notes.join('\n')).toMatch(/now counts as water/);
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(assignWaypointIds('topo', buildInputs('topo'), registry)).toEqual([
      'w_dddd4444',
      'w_eeee5555',
      'w_ffff6666',
    ]);
  });

  it('adds a CalTopo folder when the export has none for the type', () => {
    writeTopo();
    request('topo', 'w_eeee5555', { type: 'water-tank' });
    const geojson = read('data/trails/topo/topo.json');
    const folder = (JSON.parse(geojson) as { features: { id: string; properties: { title: string } }[] }).features[0];
    expect(folder.properties.title).toBe('Water tanks');
    expect(geojson).toContain(`"W Creek","class":"Marker","folderId":"${folder.id}"`);
    const after = loadEditorTrail(paths, 'topo').waypoints.find(w => w.id === 'w_eeee5555')!;
    expect([after.type, after.builtType]).toEqual(['water-tank', 'water']);
    expect(after.typeSource).toMatch(/folder “Water tanks”/);
  });

  it('gives a name-typed <wpt> a <type> and drops the prefix that typed it', () => {
    writeTopo();
    const result = request('topo', 'w_ffff6666', { type: 'hut' });
    expect(read('data/trails/topo/topo.gpx')).toBe(
      TOPO_GPX.replace('<name>T Hamlet</name>', '<name>Hamlet</name><type>hut</type>')
    );
    expect(result.notes.join('\n')).toMatch(/Dropped the type prefix “T”/);
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.topo.find(e => e.id === 'w_ffff6666')?.type).toBe('hut');
    expect(assignWaypointIds('topo', buildInputs('topo'), registry)[2]).toBe('w_ffff6666');
  });

  it('refuses a type no CalTopo folder can give, and one the editor does not offer, writing nothing', () => {
    writeTopo();
    const before = topoFiles();
    expect(() => request('topo', 'w_dddd4444', { type: 'town-access' })).toThrow(/no folder title means/);
    expect(() => request('topo', 'w_dddd4444', { type: 'water-access' })).toThrow(/not one of the waypoint types/);
    expect(topoFiles()).toEqual(before);
  });

  it('refuses when a CalTopo marker types another waypoint too', () => {
    writeTopo();
    // A second <wpt> named "Flat" nearer the same marker than to any other.
    write(
      'data/trails/topo/topo.gpx',
      TOPO_GPX.replace('<trk>', '<wpt lat="-36.501" lon="148.251"><name>Flat</name></wpt><trk>')
    );
    expect(() => request('topo', 'w_dddd4444', { type: 'hut' })).toThrow(/also types/);
  });

  it('refuses a stale type', () => {
    const w = loadEditorTrail(paths, 'demo').waypoints.find(x => x.id === 'w_bbbb2222')!;
    expect(() =>
      saveWaypointEdit(paths, 'demo', w.id, {
        expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: 'hut' },
        type: 'water-tank',
      })
    ).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe('adding waypoints', () => {
  it('inserts a <wpt> after the last one and lists it as pending until a rebuild mints its id', () => {
    const before = snapshot();
    const result = addWaypoint(paths, 'demo', {
      name: 'Lower Tank',
      type: 'water-tank',
      lat: -36.58,
      lon: 148.38,
      description: 'A rainwater tank.',
    });
    expect(read('data/trails/demo/demo.gpx')).toBe(
      GPX.replace(
        '<type>campsite</type></wpt>\n',
        '<type>campsite</type></wpt>\n  <wpt lat="-36.58" lon="148.38"><name>Lower Tank</name><desc>A rainwater tank.</desc><type>water-tank</type></wpt>\n'
      )
    );
    expect(read('data/waypoint-ids.json')).toBe(before['data/waypoint-ids.json']);
    expect(read('data/trails/demo/descriptions.json')).toBe(before['data/trails/demo/descriptions.json']);
    expect(result.changedFiles).toEqual(['data/trails/demo/demo.gpx']);
    expect(result.waypoint).toMatchObject({ pending: true, name: 'Lower Tank', type: 'water-tank', canDelete: true });
    expect(result.waypoint.id.startsWith(PENDING_KEY_PREFIX)).toBe(true);
    // It has no id for descriptions.json: its description is its <desc>, and it is editable like any other.
    expect(result.waypoint.description).toBe('A rainwater tank.');
    expect(result.waypoint.sourceDescription).toBeUndefined();
    expect(result.waypoint.lockedReason).toBeUndefined();
    expect([
      result.waypoint.canMove,
      result.waypoint.canRename,
      result.waypoint.canDescribe,
      result.waypoint.canChangeType,
    ]).toEqual([true, true, true, true]);

    // The next build mints the id the note names, and every other id holds.
    const minted = /mints (w_[0-9a-f]+)/.exec(result.notes.join('\n'))?.[1];
    const ids = assignWaypointIds(
      'demo',
      buildInputs('demo')
        .filter(w => w.name !== 'Lower Tank')
        .concat([{ name: 'Lower Tank', type: 'water-tank', lat: -36.58, lon: 148.38 }]),
      JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry
    );
    expect(ids).toEqual(['w_aaaa1111', 'w_bbbb2222', 'w_cccc3333', minted]);

    // Deleting it again gives the file back byte for byte.
    const pending = loadEditorTrail(paths, 'demo').waypoints.find(w => w.pending)!;
    const removed = deleteWaypoint(paths, 'demo', pending.id, {
      expected: { name: pending.name, lat: pending.lat, lon: pending.lon, description: 'A rainwater tank.' },
    });
    expect(removed.removed).toEqual([pending.id]);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a prefixed name, an unknown type, a clash with a CalTopo marker, and Te Araroa', () => {
    writeTopo();
    const at = { lat: -36.58, lon: 148.38 };
    expect(() => addWaypoint(paths, 'demo', { name: 'C New Camp', type: 'campsite', ...at })).toThrow(/type prefix/);
    expect(() => addWaypoint(paths, 'demo', { name: 'Camp', type: 'water-access', ...at })).toThrow(/not one of/);
    const before = topoFiles();
    expect(() => addWaypoint(paths, 'topo', { name: 'Creek', type: 'hut', ...at })).toThrow(/would type it as water/);
    expect(topoFiles()).toEqual(before);
    expect(() => addWaypoint(paths, 'te_araroa', { name: 'Camp', type: 'campsite', ...at })).toThrow(/upstream/);
    expect(() => addWaypoint(paths, 'demo', { name: 'Far', type: 'hut', lat: -38, lon: 148.3 })).toThrow(/50 km/);
  });

  it('types a new <wpt> on a CalTopo trail from its <type> when no marker has its name', () => {
    writeTopo();
    const result = addWaypoint(paths, 'topo', { name: 'Tank', type: 'water-tank', lat: -36.58, lon: 148.38 });
    expect(read('data/trails/topo/topo.gpx')).toBe(
      TOPO_GPX.replace(
        '<name>T Hamlet</name></wpt>',
        '<name>T Hamlet</name></wpt><wpt lat="-36.58" lon="148.38"><name>Tank</name><type>water-tank</type></wpt>'
      )
    );
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    expect(result.waypoint.typeSource).toBe('its GPX <type>');
  });
});

describe('editing a pending waypoint', () => {
  const NEW = { name: 'Lower Tank', type: 'water-tank', lat: -36.58, lon: 148.38 };
  const NEW_WPT = '<wpt lat="-36.58" lon="148.38"><name>Lower Tank</name><type>water-tank</type></wpt>';

  /** The ids the next build assigns: every `<wpt>` as the editor lists it, the pending one last (as in the file). */
  function nextBuildIds(dir: string): string[] {
    const listed = loadEditorTrail(paths, dir).waypoints.filter(w => !w.deleted);
    const inputs = [...listed.filter(w => !w.pending), ...listed.filter(w => w.pending)];
    return assignWaypointIds(
      dir,
      inputs.map(w => ({ name: w.name, type: w.type, lat: w.lat, lon: w.lon })),
      JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry
    );
  }

  it('renames, moves, retypes and describes it in its <wpt> alone, under a key that follows it', () => {
    const added = addWaypoint(paths, 'demo', NEW).waypoint;
    const others = snapshot();
    const result = request('demo', added.id, {
      name: 'Lower Dam',
      lat: -36.581,
      lon: 148.381,
      type: 'water',
      description: '  A stock dam.  ',
    });

    expect(read('data/trails/demo/demo.gpx')).toBe(
      GPX.replace(
        '<type>campsite</type></wpt>\n',
        '<type>campsite</type></wpt>\n  <wpt lat="-36.581" lon="148.381"><name>Lower Dam</name><desc>A stock dam.</desc><type>water</type></wpt>\n'
      )
    );
    // Nothing that keys by id is written: it has none.
    expect(read('data/waypoint-ids.json')).toBe(others['data/waypoint-ids.json']);
    expect(read('data/trails/demo/descriptions.json')).toBe(others['data/trails/demo/descriptions.json']);
    expect(result.changedFiles).toEqual(['data/trails/demo/demo.gpx']);

    // The answer carries it under its new key, and the old key is gone.
    expect(result.waypoint).toMatchObject({
      pending: true,
      name: 'Lower Dam',
      lat: -36.581,
      lon: 148.381,
      type: 'water',
      description: 'A stock dam.',
    });
    expect(result.waypoint.id.startsWith(PENDING_KEY_PREFIX)).toBe(true);
    expect(result.waypoint.id).not.toBe(added.id);
    const listed = loadEditorTrail(paths, 'demo').waypoints.filter(w => w.pending);
    expect(listed.map(w => w.id)).toEqual([result.waypoint.id]);

    // The notes name the id the next build mints, and every other id holds.
    const notes = result.notes.join('\n');
    const minted = /mints (w_[0-9a-f]+)/.exec(notes)?.[1];
    expect(minted).toBeDefined();
    expect(nextBuildIds('demo')).toEqual(['w_aaaa1111', 'w_bbbb2222', 'w_cccc3333', minted]);
    expect(notes).toMatch(/Type water-tank → water\./);
    expect(notes).toMatch(/GPX <desc>/);
    expect(notes).not.toMatch(/registry entry/);
  });

  it('keeps the key through a retype or a description, and removes an emptied <desc>', () => {
    const added = addWaypoint(paths, 'demo', NEW).waypoint;
    const described = request('demo', added.id, { description: 'A rainwater tank.' });
    expect(described.waypoint.id).toBe(added.id);
    expect(read('data/trails/demo/demo.gpx')).toContain(
      '<name>Lower Tank</name><desc>A rainwater tank.</desc><type>water-tank</type>'
    );
    expect(described.notes.join('\n')).toMatch(/GPX <desc>/);
    const retyped = request('demo', added.id, { type: 'water' });
    expect(retyped.waypoint).toMatchObject({ id: added.id, type: 'water', builtType: 'water' });
    const emptied = request('demo', added.id, { description: '' });
    expect(emptied.waypoint.description).toBe('');
    expect(read('data/trails/demo/demo.gpx')).toBe(
      GPX.replace(
        '<type>campsite</type></wpt>\n',
        `<type>campsite</type></wpt>\n  ${NEW_WPT.replace('water-tank', 'water')}\n`
      )
    );
    expect(() => request('demo', added.id, { description: 'x'.repeat(4001) })).toThrow(/longer than/);
  });

  it('refuses what an add refuses, and a stale edit, writing nothing', () => {
    const added = addWaypoint(paths, 'demo', NEW).waypoint;
    const before = snapshot();
    expect(() => request('demo', added.id, { name: 'WT: Lower Tank' })).toThrow(/type prefix/);
    expect(() => request('demo', added.id, { lat: -36.3, lon: 149.3 })).toThrow(/more than 50 km/);
    expect(() => request('demo', added.id, { lat: -36.52, lon: 148.3 })).toThrow(/exactly this position/);
    expect(() => request('demo', added.id, { type: 'water-access' })).toThrow(/not one of the waypoint types/);
    // A second "Spring" of the same type beside the first would stop the build.
    expect(() => request('demo', added.id, { name: 'Spring', type: 'water', lat: -36.5201, lon: 148.3 })).toThrow(
      /would stop the next build/
    );
    expect(() =>
      saveWaypointEdit(paths, 'demo', added.id, {
        expected: { name: 'Lower Tank', lat: -36.58, lon: 148.38, description: 'Edited elsewhere.' },
        name: 'Lower Dam',
      })
    ).toThrow(expect.objectContaining({ status: 409 }));
    expect(snapshot()).toEqual(before);
    // The key it was read under is gone once it is renamed.
    request('demo', added.id, { name: 'Lower Dam' });
    expect(() =>
      saveWaypointEdit(paths, 'demo', added.id, {
        expected: { name: 'Lower Tank', lat: -36.58, lon: 148.38, description: '' },
        type: 'water',
      })
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('says when the next build will hand it an id back instead of minting one', () => {
    // A retired entry of its type and name, where it is moved to.
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    registry.demo.push({
      id: 'w_dead0001',
      name: 'Lower Tank',
      type: 'water-tank',
      lat: -36.59,
      lon: 148.39,
      retired: true,
    });
    write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);
    const added = addWaypoint(paths, 'demo', NEW);
    expect(added.notes.join('\n')).toMatch(/mints w_/);
    const moved = request('demo', added.waypoint.id, { lat: -36.5901, lon: 148.39 });
    expect(moved.notes.join('\n')).toMatch(/retired id w_dead0001 back/);
    expect(read('data/waypoint-ids.json')).toBe(`${JSON.stringify(registry, null, 2)}\n`);

    // An entry whose <wpt> was deleted since the build is not retired yet: a
    // newcomer of its type within reach is, to the build, that waypoint moved.
    deleteWaypoint(paths, 'demo', 'w_cccc3333', {
      expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'A flat saddle.' },
    });
    const near = addWaypoint(paths, 'demo', { name: 'Ridge Camp', type: 'campsite', lat: -36.5503, lon: 148.35 });
    expect(near.notes.join('\n')).toMatch(/the id w_cccc3333 of “Saddle Camp”.*moved or renamed/);
  });

  it('refuses a name a CalTopo marker would type differently, and a marker that types another waypoint too', () => {
    writeTopo();
    const added = addWaypoint(paths, 'topo', { name: 'Tank', type: 'water-tank', lat: -36.58, lon: 148.38 }).waypoint;
    const before = topoFiles();
    // "W Creek" is a water marker: under that name the build would type it water, not water-tank.
    expect(() => request('topo', added.id, { name: 'Creek' })).toThrow(/would type it as water/);
    expect(topoFiles()).toEqual(before);
    // With the type the marker gives, the rename goes through: the editor shows what the build will make of it.
    const renamed = request('topo', added.id, { name: 'Creek', type: 'water' }).waypoint;
    expect(renamed).toMatchObject({ name: 'Creek', type: 'water' });
    expect(renamed.typeSource).toMatch(/CalTopo folder “Water Sources”/);
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    // That marker is the built Creek's: this one cannot be moved, renamed or retyped through it.
    const after = topoFiles();
    expect(() => request('topo', renamed.id, { lat: -36.581, lon: 148.381 })).toThrow(/types this waypoint and also/);
    expect(() => request('topo', renamed.id, { type: 'hut' })).toThrow(/types this waypoint and also/);
    expect(topoFiles()).toEqual(after);
  });

  it('edits a hand-added <wpt> with its own CalTopo marker as a normal save does, the registry apart', () => {
    writeTopo();
    write(
      'data/trails/topo/topo.gpx',
      TOPO_GPX.replace('<trk>', '<wpt lat="-36.58" lon="148.38"><name>C Bivvy</name></wpt><trk>')
    );
    write(
      'data/trails/topo/topo.json',
      TOPO_GEOJSON.replace(
        '],"type":"FeatureCollection"}',
        ',{"geometry":{"coordinates":[148.38,-36.58,0,0],"type":"Point"},"id":"m3","type":"Feature","properties":{"title":"C Bivvy","class":"Marker","folderId":"f1","description":"A ledge."}}],"type":"FeatureCollection"}'
      )
    );
    const registryBefore = read('data/waypoint-ids.json');
    const pending = loadEditorTrail(paths, 'topo').waypoints.find(w => w.pending)!;
    expect(pending).toMatchObject({ name: 'Bivvy', type: 'campsite', canMove: true, canDescribe: false });
    // The build shows the marker's text, not a <desc>: there is nothing to edit until it has an id.
    expect(pending.sourceDescription).toBe('A ledge.');
    expect(pending.lockedReason).toMatch(/in place of the GPX <desc>/);
    expect(() => request('topo', pending.id, { description: 'A rock ledge.' })).toThrow(/in place of the GPX <desc>/);

    const result = request('topo', pending.id, { name: 'Bivvy Ledge', lat: -36.581, lon: 148.381, type: 'water' });
    expect(read('data/trails/topo/topo.gpx')).toContain(
      '<wpt lat="-36.581" lon="148.381"><name>C Bivvy Ledge</name></wpt>'
    );
    expect(read('data/trails/topo/topo.json')).toContain(
      '{"geometry":{"coordinates":[148.381,-36.581,0,0],"type":"Point"},"id":"m3","type":"Feature","properties":{"title":"C Bivvy Ledge","class":"Marker","folderId":"f2","description":"A ledge."}}'
    );
    expect(read('data/waypoint-ids.json')).toBe(registryBefore);
    expect(result.waypoint).toMatchObject({ pending: true, name: 'Bivvy Ledge', type: 'water' });
    expect(result.changedFiles.sort()).toEqual(['data/trails/topo/topo.gpx', 'data/trails/topo/topo.json']);
  });

  it('keeps a pending waypoint on Te Araroa read-only', () => {
    write('data/trails/te_araroa/ta.gpx', GPX.replace('  <trk>', `  ${NEW_WPT}\n  <trk>`));
    const pending = loadEditorTrail(paths, 'te_araroa').waypoints.find(w => w.pending)!;
    expect([pending.canMove, pending.canRename, pending.canDescribe, pending.canChangeType, pending.canDelete]).toEqual(
      [false, false, false, false, false]
    );
    expect(() => request('te_araroa', pending.id, { name: 'Lower Dam' })).toThrow(/upstream/);
  });
});

describe('deleting waypoints', () => {
  it('removes the <wpt> and its description, and leaves the registry for the build to retire', () => {
    const registryBefore = read('data/waypoint-ids.json');
    const result = deleteWaypoint(paths, 'demo', 'w_cccc3333', {
      expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'A flat saddle.' },
    });
    expect(read('data/trails/demo/demo.gpx')).toBe(
      GPX.replace('\n  <wpt lat="-36.55" lon="148.35"><name>Saddle Camp</name><type>campsite</type></wpt>', '')
    );
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions).toEqual([]);
    expect(read('data/waypoint-ids.json')).toBe(registryBefore);
    expect(result.notes.join('\n')).toMatch(/retired.*orphaned/);
    // Until the rebuild it is still listed, as deleted and locked.
    const listed = loadEditorTrail(paths, 'demo').waypoints.find(w => w.id === 'w_cccc3333')!;
    expect([listed.deleted, listed.canDelete, listed.canDescribe, listed.canMove]).toEqual([true, false, false, false]);

    const registry = JSON.parse(registryBefore) as WaypointRegistry;
    expect(assignWaypointIds('demo', buildInputs('demo'), registry)).toEqual(['w_aaaa1111', 'w_bbbb2222']);
    expect(registry.demo.find(e => e.id === 'w_cccc3333')?.retired).toBe(true);
  });

  it('removes the CalTopo marker that typed it', () => {
    writeTopo();
    deleteWaypoint(paths, 'topo', 'w_dddd4444', {
      expected: { name: 'Flat', lat: -36.5, lon: 148.25, description: '' },
    });
    expect(read('data/trails/topo/topo.gpx')).toBe(
      TOPO_GPX.replace('<wpt lat="-36.5" lon="148.25"><name>C Flat</name></wpt>', '')
    );
    const geojson = JSON.parse(read('data/trails/topo/topo.json')) as { features: { id: string }[] };
    expect(geojson.features.map(f => f.id)).toEqual(['f1', 'f2', 'm2']);
  });

  it("refuses a revisited place's later pass, and takes every pass with the first", () => {
    write(
      'public/data/generated/demo.json',
      JSON.stringify({
        ...BUILT,
        alternates: [
          {
            name: 'Loop',
            type: 'alternate',
            points: track,
            waypoints: [
              { id: 'w_cccc3333_2', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35, distance: 3 },
            ],
          },
        ],
      })
    );
    write(
      'data/trails/demo/descriptions.json',
      `${JSON.stringify({ trailId: 'demo', descriptions: [DESCRIPTIONS.descriptions[0], { waypointId: 'w_cccc3333_2', description: 'Again.' }] }, null, 2)}\n`
    );
    const second = loadEditorTrail(paths, 'demo').waypoints.find(w => w.id === 'w_cccc3333_2')!;
    expect(second.canDelete).toBe(false);
    expect(() =>
      deleteWaypoint(paths, 'demo', second.id, {
        expected: { name: second.name, lat: second.lat, lon: second.lon, description: second.description },
      })
    ).toThrow(/later pass of w_cccc3333/);
    const result = deleteWaypoint(paths, 'demo', 'w_cccc3333', {
      expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'A flat saddle.' },
    });
    expect(result.removed).toEqual(['w_cccc3333', 'w_cccc3333_2']);
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions).toEqual([]);
  });

  it('refuses a stale delete and Te Araroa, writing nothing', () => {
    const before = snapshot();
    expect(() =>
      deleteWaypoint(paths, 'demo', 'w_cccc3333', {
        expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: '' },
      })
    ).toThrow(expect.objectContaining({ status: 409 }));
    expect(() =>
      deleteWaypoint(paths, 'te_araroa', 'w_aaaa1111', {
        expected: { name: 'Upper Hut', lat: -36.5, lon: 148.25, description: '' },
      })
    ).toThrow(/upstream/);
    expect(snapshot()).toEqual(before);
  });
});

// A trail whose <wpt>s carry an <ele> (two of the three: enough), on a track with real heights.
const ELE_GPX = [
  '<gpx version="1.1">',
  '  <wpt lat="-36.525" lon="148.25"><ele>1100.0</ele><name>Upper Hut</name><type>hut</type></wpt>',
  '  <wpt lat="-36.52" lon="148.3"><name>Spring</name><type>water</type></wpt>',
  '  <wpt lat="-36.55" lon="148.35"><ele>1105.5</ele><name>Saddle Camp</name><desc>A flat saddle.</desc><type>campsite</type></wpt>',
  '  <trk><trkseg><trkpt lat="-36.5" lon="148.2"/><trkpt lat="-36.6" lon="148.4"/></trkseg></trk>',
  '</gpx>',
  '',
].join('\n');

const ELE_REGISTRY = [
  { id: 'w_11112222', name: 'Upper Hut', type: 'hut', lat: -36.525, lon: 148.25 },
  { id: 'w_33334444', name: 'Spring', type: 'water', lat: -36.52, lon: 148.3 },
  { id: 'w_55556666', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35 },
];

// The same line as `track`, falling from 1200 m to 1000 m and climbing to 1400 m.
const ELE_TRACK = [
  { lat: -36.5, lon: 148.2, dist: 0, ele: 1200 },
  { lat: -36.55, lon: 148.3, dist: 10, ele: 1000 },
  { lat: -36.6, lon: 148.4, dist: 20, ele: 1400 },
];

const ELE_BUILT = {
  ...BUILT,
  config: { id: 'ele', name: 'Ele Track' },
  track: { points: ELE_TRACK, displayPoints: ELE_TRACK, totalDistance: 20, totalAscent: 400, totalDescent: 200 },
  waypoints: [
    { id: 'w_11112222', name: 'Upper Hut', type: 'hut', lat: -36.525, lon: 148.25, totalDistance: 5 },
    { id: 'w_55556666', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35, totalDistance: 14 },
  ],
  offTrailWaypoints: [
    { id: 'w_33334444', name: 'Spring', type: 'water', lat: -36.52, lon: 148.3, distanceFromTrail: 2.6 },
  ],
  pois: [],
};

function writeEle(): void {
  write('data/trails/ele/trail.json', JSON.stringify({ id: 'ele', name: 'Ele Track', gpxFile: 'ele.gpx' }));
  write('data/trails/ele/ele.gpx', ELE_GPX);
  write('public/data/generated/ele.json', JSON.stringify(ELE_BUILT));
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  write('data/waypoint-ids.json', `${JSON.stringify({ ...registry, ele: ELE_REGISTRY }, null, 2)}\n`);
}

/** A DEM that answers `metres` (or fails), recording where it was asked. */
function fakeDem(metres: number | Error): DemSource & { asked: [number, number][] } {
  const asked: [number, number][] = [];
  const dem = async (lat: number, lon: number) => {
    asked.push([lat, lon]);
    if (metres instanceof Error) throw metres;
    return metres;
  };
  return Object.assign(dem, { asked });
}

// 30% of the way down the first segment, which falls 200 m from 1200 m: on the route at 1140 m.
const ON_ROUTE = { lat: -36.515, lon: 148.23 };
// A few km off the line.
const OFF_ROUTE = { lat: -36.58, lon: 148.3 };

describe('waypoint elevations', () => {
  beforeEach(writeEle);
  const gpx = () => read('data/trails/ele/ele.gpx');
  const tank = { name: 'Tank', type: 'water-tank' };
  const SADDLE = '<wpt lat="-36.55" lon="148.35"><ele>1105.5</ele>';

  it("gives a new <wpt> on the route the route's elevation, written like its neighbours'", () => {
    const result = addWaypoint(paths, 'ele', { ...tank, ...ON_ROUTE });
    expect(gpx()).toBe(
      ELE_GPX.replace(
        '<type>campsite</type></wpt>\n',
        '<type>campsite</type></wpt>\n  <wpt lat="-36.515" lon="148.23"><ele>1140.0</ele><name>Tank</name><type>water-tank</type></wpt>\n'
      )
    );
    expect(result.notes).toContain("Its <ele> is 1140.0 m, from the route (the track's own elevations).");
    expect(result.waypoint).toMatchObject({ pending: true, ele: 1140 });
    expect(result.changedFiles).toEqual(['data/trails/ele/ele.gpx']);

    // A little off the line is still on the route, as the build matches it (500 m by default).
    const beside = addWaypoint(paths, 'ele', { name: 'Bore', type: 'water', lat: ON_ROUTE.lat, lon: 148.232 });
    expect(beside.notes.join('\n')).toMatch(
      /Its <ele> is 11\d\d\.\d m, from the route \(the track's own elevations, read \d+ m away\)/
    );
  });

  it('gives one off the route the DEM height its caller looked up, and none when there is no answer', async () => {
    const dem = fakeDem(987.64);
    // The page sends more decimals than a save writes: the lookup is for the position written.
    const at = { lat: OFF_ROUTE.lat + 4e-8, lon: OFF_ROUTE.lon };
    const elevation = await lookupWaypointElevation(paths, 'ele', at, dem);
    expect(dem.asked).toEqual([[OFF_ROUTE.lat, OFF_ROUTE.lon]]);
    expect(elevation).toMatchObject({ metres: 987.64, source: 'dem' });
    const result = addWaypoint(paths, 'ele', { ...tank, ...at }, elevation);
    expect(gpx()).toContain('<wpt lat="-36.58" lon="148.3"><ele>987.6</ele><name>Tank</name>');
    expect(result.notes.join('\n')).toMatch(
      /Its <ele> is 987\.6 m, from the Copernicus DEM \(it is \d\.\d km from the route\)/
    );

    // A DEM that cannot be read never fails the save: the <wpt> goes in without an <ele>.
    const bore = { lat: -36.59, lon: 148.3 };
    const failed = await lookupWaypointElevation(paths, 'ele', bore, fakeDem(new Error('offline')));
    expect(failed?.metres).toBeNull();
    const second = addWaypoint(paths, 'ele', { name: 'Bore', type: 'water', ...bore }, failed);
    expect(gpx()).toContain('<wpt lat="-36.59" lon="148.3"><name>Bore</name><type>water</type></wpt>');
    expect(second.notes.join('\n')).toMatch(
      /No <ele> written, though the other <wpt>s in this GPX have one: it is \d\.\d km from the route, and the Copernicus DEM could not be read \(offline\)/
    );

    // Called as the tests above call it, with no lookup: the route alone is asked.
    const third = addWaypoint(paths, 'ele', { name: 'Soak', type: 'water', lat: -36.6, lon: 148.3 });
    expect(gpx()).toContain('<wpt lat="-36.6" lon="148.3"><name>Soak</name><type>water</type></wpt>');
    expect(third.notes.join('\n')).toMatch(/No <ele> written.*the Copernicus DEM was not asked/);
    // And a lookup made for some other position is not this save's.
    const other = addWaypoint(paths, 'ele', { name: 'Well', type: 'water', lat: -36.61, lon: 148.3 }, elevation);
    expect(other.notes.join('\n')).toMatch(/No <ele> written/);
  });

  it('writes no <ele>, and asks no DEM, where the file’s <wpt>s carry none', async () => {
    const dem = fakeDem(500);
    expect(await lookupWaypointElevation(paths, 'demo', { lat: -36.58, lon: 148.38 }, dem)).toBeUndefined();
    expect(dem.asked).toEqual([]);
    const result = addWaypoint(paths, 'demo', { ...tank, lat: -36.58, lon: 148.38 });
    expect(read('data/trails/demo/demo.gpx')).toContain(
      '<wpt lat="-36.58" lon="148.38"><name>Tank</name><type>water-tank</type></wpt>'
    );
    expect(result.notes).toContain('No <ele> written: the <wpt>s in this GPX carry none.');
    expect(result.waypoint.ele).toBeUndefined();
  });

  it('looks nothing up for a request the save will refuse, and never throws', async () => {
    const dem = fakeDem(500);
    const refused: [string, { lat?: unknown; lon?: unknown } | null][] = [
      ['te_araroa', OFF_ROUTE],
      ['no-such-trail', OFF_ROUTE],
      ['ele', { lat: 'north', lon: 148.3 }],
      ['ele', {}],
      ['ele', null],
    ];
    for (const [dir, at] of refused) expect(await lookupWaypointElevation(paths, dir, at, dem)).toBeUndefined();
    fs.rmSync(path.join(root, 'public/data/generated/ele.json'));
    expect(await lookupWaypointElevation(paths, 'ele', OFF_ROUTE, dem)).toBeUndefined();
    expect(dem.asked).toEqual([]);
  });

  it('rewrites a moved <wpt>’s <ele> in place, changing nothing else in the GPX', () => {
    const result = request('ele', 'w_55556666', ON_ROUTE);
    expect(gpx()).toBe(ELE_GPX.replace(SADDLE, '<wpt lat="-36.515" lon="148.23"><ele>1140.0</ele>'));
    expect(result.notes).toContain(
      "Its <ele> went from 1105.5 to 1140.0 m, from the route (the track's own elevations)."
    );
    expect(result.waypoint).toMatchObject({ lat: -36.515, lon: 148.23, ele: 1140 });
    expect(result.changedFiles.sort()).toEqual(['data/trails/ele/ele.gpx', 'data/waypoint-ids.json']);
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.ele.find(e => e.id === 'w_55556666')).toMatchObject({ lat: -36.515, lon: 148.23 });
  });

  it('rewrites it from the DEM off the route, and leaves it, saying it may be stale, when nothing is found', async () => {
    const stale = request('ele', 'w_55556666', OFF_ROUTE);
    expect(gpx()).toBe(ELE_GPX.replace(SADDLE, '<wpt lat="-36.58" lon="148.3"><ele>1105.5</ele>'));
    expect(stale.notes.join('\n')).toMatch(
      /Its <ele> is left at 1105\.5 m, which may be stale for the new position: it is \d\.\d km from the route, and the Copernicus DEM was not asked/
    );

    const w = loadEditorTrail(paths, 'ele').waypoints.find(x => x.id === 'w_55556666')!;
    const to = { lat: -36.59, lon: 148.3 };
    const result = saveWaypointEdit(
      paths,
      'ele',
      w.id,
      { expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description }, ...to },
      await lookupWaypointElevation(paths, 'ele', to, fakeDem(951.26))
    );
    expect(gpx()).toBe(ELE_GPX.replace(SADDLE, '<wpt lat="-36.59" lon="148.3"><ele>951.3</ele>'));
    expect(result.notes.join('\n')).toMatch(/Its <ele> went from 1105\.5 to 951\.3 m, from the Copernicus DEM/);
  });

  it('adds no <ele> to a moved <wpt> that has none, and leaves one alone on a rename', () => {
    const moved = request('ele', 'w_33334444', ON_ROUTE);
    expect(gpx()).toBe(
      ELE_GPX.replace(
        '<wpt lat="-36.52" lon="148.3"><name>Spring</name>',
        '<wpt lat="-36.515" lon="148.23"><name>Spring</name>'
      )
    );
    expect(moved.notes.join('\n')).not.toMatch(/<ele>/);
    expect(moved.waypoint.ele).toBeUndefined();
    request('ele', 'w_11112222', { name: 'Top Hut' });
    expect(gpx()).toContain('<wpt lat="-36.525" lon="148.25"><ele>1100.0</ele><name>Top Hut</name>');
  });

  it('shows each waypoint’s <ele> from its <wpt>', () => {
    expect(loadEditorTrail(paths, 'ele').waypoints.map(w => [w.name, w.ele])).toEqual([
      ['Upper Hut', 1100],
      ['Spring', undefined],
      ['Saddle Camp', 1105.5],
    ]);
  });
});

describe('a pending waypoint’s elevation', () => {
  beforeEach(writeEle);
  const gpx = () => read('data/trails/ele/ele.gpx');
  const added = (wpt: string) =>
    ELE_GPX.replace('<type>campsite</type></wpt>\n', `<type>campsite</type></wpt>\n  ${wpt}\n`);

  it('carries its <ele>, and a move refreshes it as for any waypoint, whatever else the save edits', async () => {
    const pending = addWaypoint(paths, 'ele', { name: 'Tank', type: 'water-tank', ...ON_ROUTE }).waypoint;
    expect(pending).toMatchObject({ pending: true, ele: 1140 });
    const registryBefore = read('data/waypoint-ids.json');

    // 60% of the way down the first segment: on the route at 1080 m.
    const result = request('ele', pending.id, { lat: -36.53, lon: 148.26, name: 'Low Tank', description: 'A tank.' });
    expect(gpx()).toBe(
      added(
        '<wpt lat="-36.53" lon="148.26"><ele>1080.0</ele><name>Low Tank</name><desc>A tank.</desc><type>water-tank</type></wpt>'
      )
    );
    expect(result.notes).toContain(
      "Its <ele> went from 1140.0 to 1080.0 m, from the route (the track's own elevations)."
    );
    expect(result.waypoint).toMatchObject({ pending: true, name: 'Low Tank', lat: -36.53, lon: 148.26, ele: 1080 });
    expect(result.waypoint.id).not.toBe(pending.id);
    expect(read('data/waypoint-ids.json')).toBe(registryBefore);

    // Off the route: the lookup the plugin makes takes the position from the
    // request, not the waypoint's key, so it serves a pending waypoint as well.
    const w = result.waypoint;
    const dem = fakeDem(951.26);
    const moved = saveWaypointEdit(
      paths,
      'ele',
      w.id,
      { expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type }, ...OFF_ROUTE },
      await lookupWaypointElevation(paths, 'ele', OFF_ROUTE, dem)
    );
    expect(dem.asked).toEqual([[OFF_ROUTE.lat, OFF_ROUTE.lon]]);
    expect(gpx()).toBe(
      added(
        '<wpt lat="-36.58" lon="148.3"><ele>951.3</ele><name>Low Tank</name><desc>A tank.</desc><type>water-tank</type></wpt>'
      )
    );
    expect(moved.notes.join('\n')).toMatch(/Its <ele> went from 1080\.0 to 951\.3 m, from the Copernicus DEM/);
    expect(moved.waypoint.ele).toBe(951.3);

    // A rename or a retype alone leaves the <ele> as it is, and deleting it gives the file back.
    const renamed = request('ele', moved.waypoint.id, { name: 'Far Tank', type: 'water' }).waypoint;
    expect(gpx()).toContain('<wpt lat="-36.58" lon="148.3"><ele>951.3</ele><name>Far Tank</name>');
    deleteWaypoint(paths, 'ele', renamed.id, {
      expected: { name: renamed.name, lat: renamed.lat, lon: renamed.lon, description: renamed.description },
    });
    expect(gpx()).toBe(ELE_GPX);
  });
});

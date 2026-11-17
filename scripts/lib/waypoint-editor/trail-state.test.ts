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
  commitWrites,
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

// A marker no <wpt> has the name of, to splice in before the end of the features.
const ORPHAN_AT = '],"type":"FeatureCollection"}';
const ORPHAN_MARKER =
  '{"geometry":{"coordinates":[148.39,-36.59,0,0],"type":"Point"},"id":"m8","type":"Feature","properties":{"title":"W Bore","class":"Marker","folderId":"f2","description":"A windmill."}}';

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
    // A marker with no <wpt> of its own: nothing shares it, but it would type the new waypoint its way.
    write('data/trails/topo/topo.json', TOPO_GEOJSON.replace(ORPHAN_AT, `,${ORPHAN_MARKER}${ORPHAN_AT}`));
    const before = topoFiles();
    expect(() => addWaypoint(paths, 'topo', { name: 'Bore', type: 'hut', ...at })).toThrow(/would type it as water/);
    // One that types a <wpt> already would be shared, whatever type is asked for.
    expect(() => addWaypoint(paths, 'topo', { name: 'Creek', type: 'hut', ...at })).toThrow(/also types “W Creek”/);
    expect(() => addWaypoint(paths, 'topo', { name: 'Creek', type: 'water', ...at })).toThrow(/also types “W Creek”/);
    expect(topoFiles()).toEqual(before);
    expect(() => addWaypoint(paths, 'te_araroa', { name: 'Camp', type: 'campsite', ...at })).toThrow(/upstream/);
    expect(() => addWaypoint(paths, 'demo', { name: 'Far', type: 'hut', lat: -38, lon: 148.3 })).toThrow(/50 km/);
  });

  it('adds a <wpt> for a CalTopo marker that has none, and says whose description the build shows', () => {
    writeTopo();
    write('data/trails/topo/topo.json', TOPO_GEOJSON.replace(ORPHAN_AT, `,${ORPHAN_MARKER}${ORPHAN_AT}`));
    const result = addWaypoint(paths, 'topo', {
      name: 'Bore',
      type: 'water',
      lat: -36.58,
      lon: 148.38,
      description: 'A stock bore.',
    });
    expect(result.waypoint).toMatchObject({ pending: true, type: 'water', canDescribe: false });
    expect(result.waypoint.typeSource).toMatch(/CalTopo folder “Water Sources”/);
    expect(result.waypoint.sourceDescription).toBe('A windmill.');
    const notes = result.notes.join('\n');
    expect(notes).toMatch(/the build shows the description of the CalTopo marker “W Bore”/);
    expect(notes).not.toMatch(/it can become curated text/);
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
    // newcomer of its type within reach is, to the build, that waypoint moved,
    // so the add is refused until a rebuild ("an id that is not retired yet", below).
    deleteWaypoint(paths, 'demo', 'w_cccc3333', {
      expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'A flat saddle.' },
    });
    expect(() =>
      addWaypoint(paths, 'demo', { name: 'Ridge Camp', type: 'campsite', lat: -36.5503, lon: 148.35 })
    ).toThrow(/moved or renamed.*Rebuild first so w_cccc3333 is retired/);
  });

  it('refuses a name a CalTopo marker would type differently, or types another waypoint by', () => {
    writeTopo();
    const withOrphan = TOPO_GEOJSON.replace(ORPHAN_AT, `,${ORPHAN_MARKER}${ORPHAN_AT}`);
    write('data/trails/topo/topo.json', withOrphan);
    const added = addWaypoint(paths, 'topo', { name: 'Tank', type: 'water-tank', lat: -36.58, lon: 148.38 }).waypoint;
    const before = topoFiles();
    // "W Bore" is a water marker with no <wpt>: under its name the build would type this water, not water-tank.
    expect(() => request('topo', added.id, { name: 'Bore' })).toThrow(/would type it as water/);
    // "W Creek" types the built Creek: under its name the two would share the marker.
    expect(() => request('topo', added.id, { name: 'Creek' })).toThrow(/also types “W Creek”/);
    expect(() => request('topo', added.id, { name: 'Creek', type: 'water' })).toThrow(/also types “W Creek”/);
    expect(topoFiles()).toEqual(before);
    // With the type the marker gives, the rename goes through: the editor shows what the build will make of
    // it, and the marker, which types nothing else, is this waypoint's from then on.
    const renamed = request('topo', added.id, { name: 'Bore', type: 'water' }).waypoint;
    expect(renamed).toMatchObject({ name: 'Bore', type: 'water' });
    expect(renamed.typeSource).toMatch(/CalTopo folder “Water Sources”/);
    expect(read('data/trails/topo/topo.json')).toBe(withOrphan);
    request('topo', renamed.id, { lat: -36.581, lon: 148.381 });
    expect(read('data/trails/topo/topo.json')).toBe(withOrphan.replace('[148.39,-36.59,0,0]', '[148.381,-36.581,0,0]'));
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

// A trail that merges near-duplicates (`dedupeWaypoints`): three taps under one
// name, 89 m apart in a line, so the third is within the radius of the first
// only through the second. The build kept the first and dropped the others.
const DUP_GPX = [
  '<gpx version="1.1">',
  '  <wpt lat="-36.5" lon="148.25"><name>Tap</name><type>water</type></wpt>',
  '  <wpt lat="-36.5008" lon="148.25"><ele>412.5</ele><name>Tap</name><desc>By the gate.</desc><type>water</type></wpt>',
  '  <wpt lat="-36.5016" lon="148.25"><name>Tap</name><type>water</type></wpt>',
  '  <wpt lat="-36.55" lon="148.35"><name>Saddle Camp</name><type>campsite</type></wpt>',
  '  <trk><trkseg><trkpt lat="-36.5" lon="148.2"/><trkpt lat="-36.6" lon="148.4"/></trkseg></trk>',
  '</gpx>',
  '',
].join('\n');

const DUP_REGISTRY = [
  { id: 'w_d0000001', name: 'Tap', type: 'water', lat: -36.5, lon: 148.25 },
  { id: 'w_d0000002', name: 'Tap', type: 'water', lat: -36.5008, lon: 148.25 },
  { id: 'w_d0000003', name: 'Tap', type: 'water', lat: -36.5016, lon: 148.25 },
  { id: 'w_cccc3333', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35 },
];

function writeDup(dir = 'dup', dedupeWaypoints: unknown = true): void {
  write(
    `data/trails/${dir}/trail.json`,
    JSON.stringify({ id: dir, name: 'Dup Track', gpxFile: 'dup.gpx', dedupeWaypoints })
  );
  write(`data/trails/${dir}/dup.gpx`, DUP_GPX);
  write(
    `public/data/generated/${dir}.json`,
    JSON.stringify({
      ...BUILT,
      config: { id: dir, name: 'Dup Track' },
      waypoints: [
        {
          id: 'w_d0000001',
          name: 'Tap',
          type: 'water',
          lat: -36.5,
          lon: 148.25,
          totalDistance: 4,
          description: 'By the gate.',
          mergedIds: ['w_d0000002', 'w_d0000003'],
        },
        { id: 'w_cccc3333', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35, totalDistance: 14 },
      ],
      offTrailWaypoints: [],
      pois: [],
    })
  );
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  write('data/waypoint-ids.json', `${JSON.stringify({ ...registry, [dir]: DUP_REGISTRY }, null, 2)}\n`);
}

function dupFiles(): Record<string, string> {
  return { gpx: read('data/trails/dup/dup.gpx'), registry: read('data/waypoint-ids.json') };
}

function row(dir: string, id: string) {
  return loadEditorTrail(paths, dir).waypoints.find(w => w.id === id)!;
}

function remove(dir: string, id: string) {
  const w = row(dir, id);
  return deleteWaypoint(paths, dir, id, {
    expected: { name: w.name, lat: w.lat, lon: w.lon, description: w.description, type: w.type },
  });
}

describe('near-duplicates the build merged', () => {
  it('lists each merged-away <wpt> as a row of its own, joined through its registry entry', () => {
    writeDup();
    const waypoints = loadEditorTrail(paths, 'dup').waypoints;
    expect(waypoints.map(w => [w.id, w.name, w.mergedInto])).toEqual([
      ['w_d0000001', 'Tap', undefined],
      ['w_d0000002', 'Tap', 'w_d0000001'],
      ['w_d0000003', 'Tap', 'w_d0000001'],
      ['w_cccc3333', 'Saddle Camp', undefined],
    ]);
    expect(waypoints.some(w => w.pending)).toBe(false);
    const [survivor, second, third] = waypoints;
    expect(survivor.mergedIds).toEqual(['w_d0000002', 'w_d0000003']);
    expect([survivor.canMove, survivor.canDelete, survivor.lockedReason]).toEqual([true, true, undefined]);

    expect(second).toMatchObject({
      type: 'water',
      builtName: 'Tap',
      lat: -36.5008,
      lon: 148.25,
      placements: [],
      sortKm: survivor.sortKm,
      description: '',
      sourceDescription: 'By the gate.',
      typeSource: 'its GPX <type>',
    });
    expect(Math.round(second.mergedDistanceM!)).toBe(89);
    // Its <wpt>'s <ele> shows like any other row's.
    expect([survivor.ele, second.ele, third.ele]).toEqual([undefined, 412.5, undefined]);
    expect(Math.round(third.mergedDistanceM!)).toBe(178);
    // Deleting is the point; a rename takes it out of the merge; the rest is the survivor's to correct.
    for (const w of [second, third]) {
      expect([w.canDelete, w.canRename, w.canMove, w.canChangeType, w.canDescribe]).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(w.unmerges).toBeUndefined();
      expect(w.deleted).toBeUndefined();
    }
    expect(second.lockedReason).toMatch(/merged this <wpt> into “Tap” \(w_d0000001\), 89 m away/);
    expect(second.lockedReason).toMatch(/Delete it if it is a redundant duplicate/);
    expect(second.lockedReason).toMatch(/rename it/);
  });

  it('refuses a move, a retype and a description on one, saying what to do, and writes nothing', () => {
    writeDup();
    const before = dupFiles();
    expect(() => request('dup', 'w_d0000002', { lat: -36.5009, lon: 148.25 })).toThrow(/rename it/);
    expect(() => request('dup', 'w_d0000002', { type: 'water-tank' })).toThrow(/locked while it is merged/);
    expect(() => request('dup', 'w_d0000002', { description: 'A tap.' })).toThrow(/appends this one's description/);
    expect(() => request('dup', 'w_d0000002', { name: 'W Gate Tap' })).toThrow(/type prefix/);
    expect(dupFiles()).toEqual(before);
  });

  it('deletes one through the usual path, and its id alone is retired by the next build', () => {
    writeDup();
    const before = dupFiles();
    const result = remove('dup', 'w_d0000003');
    expect(result.removed).toEqual(['w_d0000003']);
    expect(read('data/trails/dup/dup.gpx')).toBe(
      DUP_GPX.replace('\n  <wpt lat="-36.5016" lon="148.25"><name>Tap</name><type>water</type></wpt>', '')
    );
    expect(read('data/waypoint-ids.json')).toBe(before.registry);
    const notes = result.notes.join('\n');
    expect(notes).toMatch(/marks w_d0000003 retired/);
    expect(notes).toMatch(/drops it from the ids merged into “Tap” \(w_d0000001\)/);
    // What is true of its comments: the app never showed them, so nothing is newly orphaned.
    expect(notes).toMatch(/Comments keyed to w_d0000003 were already out of sight/);
    expect(notes).not.toMatch(/orphaned/);
    expect(notes).not.toMatch(/only through this one/);

    // Until the rebuild it is listed as deleted, still flagged with what it merged into.
    expect(row('dup', 'w_d0000003')).toMatchObject({ deleted: true, mergedInto: 'w_d0000001', canDelete: false });
    const registry = JSON.parse(before.registry) as WaypointRegistry;
    const inputs = buildInputs('dup');
    expect(assignWaypointIds('dup', inputs, registry)).toEqual(['w_d0000001', 'w_d0000002', 'w_cccc3333']);
    expect(registry.dup.filter(e => e.retired).map(e => e.id)).toEqual(['w_d0000003']);
  });

  it('says which other duplicate comes back when the one that chained it is deleted, and what goes with its text', () => {
    writeDup();
    const notes = remove('dup', 'w_d0000002').notes.join('\n');
    expect(notes).toMatch(/w_d0000003 was merged into “Tap” \(w_d0000001\) only through this one/);
    expect(notes).toMatch(/lists it again too, under its own id/);
    expect(notes).toMatch(/appended its description to that of “Tap” \(w_d0000001\)/);
    // The editor already shows the third as leaving the merge.
    expect(row('dup', 'w_d0000003')).toMatchObject({ mergedInto: 'w_d0000001', unmerges: true });
    expect(row('dup', 'w_d0000003').lockedReason).toMatch(/no longer a duplicate/);
  });

  it('says, on deleting the waypoint they merged into, that the duplicates come back under their own ids', () => {
    writeDup();
    const result = remove('dup', 'w_d0000001');
    const notes = result.notes.join('\n');
    expect(notes).toMatch(/comments keyed to w_d0000001 are orphaned/);
    expect(notes).toMatch(/w_d0000002, w_d0000003 are near-duplicates the build merged into it/);
    expect(notes).toMatch(/lists them again as rows of their own, under their own ids/);
    expect(notes).toMatch(/Comments keyed to w_d0000001 do not move to them/);
    expect(result.removed).toEqual(['w_d0000001']);
    expect(read('data/trails/dup/dup.gpx')).toContain('<wpt lat="-36.5008" lon="148.25">');
    expect(row('dup', 'w_d0000002')).toMatchObject({ unmerges: true, canDelete: true });
  });

  it('renames one apart: its registry entry follows, it keeps its id, and the next build lists it', () => {
    writeDup();
    const result = request('dup', 'w_d0000003', { name: 'Gate Tap' });
    expect(read('data/trails/dup/dup.gpx')).toBe(
      DUP_GPX.replace(
        '<wpt lat="-36.5016" lon="148.25"><name>Tap</name>',
        '<wpt lat="-36.5016" lon="148.25"><name>Gate Tap</name>'
      )
    );
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.dup.find(e => e.id === 'w_d0000003')).toEqual({
      id: 'w_d0000003',
      name: 'Gate Tap',
      type: 'water',
      lat: -36.5016,
      lon: 148.25,
    });
    expect(result.waypoint).toMatchObject({
      id: 'w_d0000003',
      name: 'Gate Tap',
      builtName: 'Tap',
      mergedInto: 'w_d0000001',
      unmerges: true,
    });
    expect(result.waypoint.lockedReason).toMatch(/no longer a duplicate of it/);
    expect(result.notes.join('\n')).toMatch(/no longer merges it into “Tap” \(w_d0000001\).*under w_d0000003/);
    const inputs = buildInputs('dup');
    const ids = assignWaypointIds('dup', inputs, registry);
    expect(Object.fromEntries(inputs.map((w, i) => [`${w.name} ${w.lat}`, ids[i]]))).toEqual({
      'Tap -36.5': 'w_d0000001',
      'Tap -36.5008': 'w_d0000002',
      'Gate Tap -36.5016': 'w_d0000003',
      'Saddle Camp -36.55': 'w_cccc3333',
    });
    expect(registry.dup.some(e => e.retired)).toBe(false);

    // Renaming the middle one frees the far one too; renaming it back merges it again.
    const middle = request('dup', 'w_d0000002', { name: 'Yard Tap' });
    expect(middle.waypoint.unmerges).toBe(true);
    const back = request('dup', 'w_d0000002', { name: 'Tap' });
    expect(back.waypoint.unmerges).toBeUndefined();
    expect(back.notes.join('\n')).toMatch(/still merges it into “Tap” \(w_d0000001\)/);
  });

  it('names the duplicate a rename frees from the chain', () => {
    writeDup();
    const notes = request('dup', 'w_d0000002', { name: 'Yard Tap' }).notes.join('\n');
    expect(notes).toMatch(/w_d0000003 was merged into “Tap” \(w_d0000001\) only through this one/);
  });

  it('says when an edit to the waypoint they merged into ends the merge', () => {
    writeDup();
    // 60 m north: the nearer duplicate is still within the radius, and chains the far one.
    expect(request('dup', 'w_d0000001', { lat: -36.49946, lon: 148.25 }).notes.join('\n')).not.toMatch(/no longer/);
    const notes = request('dup', 'w_d0000001', { name: 'Hut Tap' }).notes.join('\n');
    expect(notes).toMatch(/w_d0000002, w_d0000003, which the build merged into it, are no longer duplicates of it/);
    expect(notes).toMatch(/rows of their own, under their own ids/);
    expect(row('dup', 'w_d0000002').unmerges).toBe(true);
  });

  it('follows trail.json: a smaller radius, or no merging, means the next build lists them', () => {
    writeDup('dup', { radiusMeters: 100 });
    expect(row('dup', 'w_d0000002').unmerges).toBeUndefined();
    writeDup('dup', false);
    expect(row('dup', 'w_d0000002')).toMatchObject({ mergedInto: 'w_d0000001', unmerges: true });
  });

  it('lists nothing it cannot place, and keeps Te Araroa read-only', () => {
    writeDup();
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    registry.dup = registry.dup.filter(e => e.id !== 'w_d0000003');
    write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);
    const waypoints = loadEditorTrail(paths, 'dup').waypoints;
    // No registry entry says where w_d0000003's <wpt> is: the <wpt> shows as pending, the id stays on the survivor.
    expect(waypoints.map(w => w.id).filter(id => id.startsWith('w_'))).toEqual([
      'w_d0000001',
      'w_d0000002',
      'w_cccc3333',
    ]);
    expect(waypoints.find(w => w.id === 'w_d0000001')?.mergedIds).toEqual(['w_d0000002', 'w_d0000003']);
    expect(waypoints.filter(w => w.pending)).toHaveLength(1);

    writeDup('te_araroa');
    const merged = row('te_araroa', 'w_d0000002');
    expect([merged.canDelete, merged.canRename, merged.canMove]).toEqual([false, false, false]);
    expect(merged.lockedReason).toMatch(/upstream/);
    expect(() => remove('te_araroa', 'w_d0000002')).toThrow(/upstream/);
  });
});

// Two towns hitched from one pass: two <wpt>s on the same coordinates, as the CDT has 18 times over.
const PASS_GPX = [
  '<gpx version="1.1">',
  '  <wpt lat="-36.52" lon="148.24"><name>Leadore (access: Bannock Pass)</name><type>resupply-access</type></wpt>',
  '  <wpt lat="-36.52" lon="148.24"><name>Salmon (access: Bannock Pass)</name><type>town-access</type></wpt>',
  '  <trk><trkseg><trkpt lat="-36.5" lon="148.2"/><trkpt lat="-36.6" lon="148.4"/></trkseg></trk>',
  '</gpx>',
  '',
].join('\n');

const PASS_REGISTRY = [
  { id: 'w_5aaaaf44', name: 'Leadore (access: Bannock Pass)', type: 'resupply-access', lat: -36.52, lon: 148.24 },
  { id: 'w_e7d8d267', name: 'Salmon (access: Bannock Pass)', type: 'town-access', lat: -36.52, lon: 148.24 },
];

function writePass(): void {
  write('data/trails/pass/trail.json', JSON.stringify({ id: 'pass', name: 'Pass Track', gpxFile: 'pass.gpx' }));
  write('data/trails/pass/pass.gpx', PASS_GPX);
  write(
    'public/data/generated/pass.json',
    JSON.stringify({
      ...BUILT,
      config: { id: 'pass', name: 'Pass Track' },
      waypoints: PASS_REGISTRY.map(e => ({ ...e, totalDistance: 4 })),
      offTrailWaypoints: [],
      pois: [],
    })
  );
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  write('data/waypoint-ids.json', `${JSON.stringify({ ...registry, pass: PASS_REGISTRY }, null, 2)}\n`);
}

describe('joining a built waypoint to its <wpt>', () => {
  it('never hands a deleted waypoint the <wpt> of another that shares its coordinates', () => {
    writePass();
    remove('pass', 'w_5aaaaf44');
    const salmonWpt =
      '<wpt lat="-36.52" lon="148.24"><name>Salmon (access: Bannock Pass)</name><type>town-access</type></wpt>';
    expect(read('data/trails/pass/pass.gpx')).toContain(salmonWpt);

    // Until the rebuild it stays in the list as deleted, locked; it is not Salmon under another id.
    const leadore = row('pass', 'w_5aaaaf44');
    expect(leadore).toMatchObject({ deleted: true, type: 'resupply-access', name: 'Leadore (access: Bannock Pass)' });
    expect([leadore.canDelete, leadore.canMove, leadore.canRename, leadore.canChangeType]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(leadore.sharesSourceWith).toBeUndefined();
    const salmon = row('pass', 'w_e7d8d267');
    expect(salmon.deleted).toBeUndefined();
    expect(salmon.sharesSourceWith).toBeUndefined();

    // Deleting or moving it "again" does not reach Salmon's <wpt> or either registry entry.
    const before = { gpx: read('data/trails/pass/pass.gpx'), registry: read('data/waypoint-ids.json') };
    expect(() => remove('pass', 'w_5aaaaf44')).toThrow(/no longer in the GPX/);
    expect(() => request('pass', 'w_5aaaaf44', { lat: -36.521, lon: 148.241 })).toThrow(/no longer in the GPX/);
    expect({ gpx: read('data/trails/pass/pass.gpx'), registry: read('data/waypoint-ids.json') }).toEqual(before);

    // The next build retires Leadore's id and leaves Salmon's alone.
    const registry = JSON.parse(before.registry) as WaypointRegistry;
    expect(assignWaypointIds('pass', buildInputs('pass'), registry)).toEqual(['w_e7d8d267']);
    expect(registry.pass.filter(e => e.retired).map(e => e.id)).toEqual(['w_5aaaaf44']);
  });

  it('tells apart two <wpt>s on one position by name, and follows each through a rename', () => {
    writePass();
    const renamed = request('pass', 'w_e7d8d267', { name: 'Salmon (access: the pass)' });
    expect(renamed.waypoint).toMatchObject({ id: 'w_e7d8d267', name: 'Salmon (access: the pass)' });
    expect(row('pass', 'w_5aaaaf44')).toMatchObject({ name: 'Leadore (access: Bannock Pass)', canMove: true });
    expect(read('data/trails/pass/pass.gpx')).toBe(
      PASS_GPX.replace('Salmon (access: Bannock Pass)', 'Salmon (access: the pass)')
    );
  });

  it('adds a waypoint where a deleted one stood without mistaking it for that one', () => {
    remove('demo', 'w_cccc3333');
    // A different type, so the build cannot read it as the campsite moved or renamed.
    const added = addWaypoint(paths, 'demo', { name: 'Saddle Lookout', type: 'poi', lat: -36.55, lon: 148.35 });
    expect(added.waypoint).toMatchObject({ pending: true, name: 'Saddle Lookout', type: 'poi' });
    expect(row('demo', 'w_cccc3333')).toMatchObject({ deleted: true, name: 'Saddle Camp', canMove: false });
    expect(loadEditorTrail(paths, 'demo').waypoints.filter(w => w.pending)).toHaveLength(1);
  });

  it('lists a <wpt> that has a registry id the last build here does not know, locked', () => {
    // The registry (committed) is ahead of the generated data (built on this machine): a pull without a rebuild.
    write(
      'data/trails/demo/demo.gpx',
      GPX.replace(
        '  <trk>',
        '  <wpt lat="-36.58" lon="148.38"><name>Lower Tank</name><type>water-tank</type></wpt>\n  <trk>'
      )
    );
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    registry.demo.push({ id: 'w_ffff0001', name: 'Lower Tank', type: 'water-tank', lat: -36.58, lon: 148.38 });
    write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);

    const waypoints = loadEditorTrail(paths, 'demo').waypoints;
    expect(waypoints.some(w => w.pending)).toBe(false);
    const tank = waypoints.find(w => w.id === 'w_ffff0001')!;
    expect(tank).toMatchObject({ notBuilt: true, name: 'Lower Tank', type: 'water-tank', lat: -36.58, lon: 148.38 });
    expect([tank.canMove, tank.canRename, tank.canDescribe, tank.canChangeType, tank.canDelete]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(tank.lockedReason).toMatch(/last build .* does not list it.*Rebuild/);
    const before = snapshot();
    expect(() => request('demo', 'w_ffff0001', { lat: -36.581, lon: 148.381 })).toThrow(/Rebuild/);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a GPX the build would stop on, naming the file', () => {
    write('data/trails/demo/demo.gpx', GPX.replace(' lat="-36.52"', ''));
    expect(() => loadEditorTrail(paths, 'demo')).toThrow(/demo\.gpx.*Missing lat/);
    expect(() => loadEditorTrail(paths, 'demo')).toThrow(EditorError);
  });

  it('locks twins it cannot tell apart, and lists neither <wpt> as pending', () => {
    // A second <wpt> on Spring's position under its name and type: nothing says which is w_bbbb2222's.
    const spring = '  <wpt lat="-36.52" lon="148.3"><name>Spring</name><type>water</type></wpt>\n';
    write('data/trails/demo/demo.gpx', GPX.replace(spring, spring + spring));
    const waypoints = loadEditorTrail(paths, 'demo').waypoints;
    expect(waypoints.map(w => w.id)).toEqual(['w_aaaa1111', 'w_bbbb2222', 'w_cccc3333']);
    const twin = waypoints[1];
    expect(twin.deleted).toBeUndefined();
    expect([twin.canMove, twin.canRename, twin.canDescribe, twin.canChangeType, twin.canDelete]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(twin.lockedReason).toMatch(/More than one <wpt> stands on its position under its name and type/);
    // A twin of another type is a waypoint of its own: the name and the type together say whose a <wpt> is.
    write('data/trails/demo/demo.gpx', GPX.replace(spring, spring + spring.replace('water', 'poi')));
    const told = loadEditorTrail(paths, 'demo').waypoints;
    expect(told.find(w => w.id === 'w_bbbb2222')).toMatchObject({ type: 'water', canMove: true });
    expect(told.filter(w => w.pending).map(w => [w.name, w.type])).toEqual([['Spring', 'poi']]);
  });

  it('shows a <wpt> renamed by hand as what the build will make of it, and holds its edits until a rebuild', () => {
    write('data/trails/demo/demo.gpx', GPX.replace('<name>Saddle Camp</name>', '<name>Col Camp</name>'));
    const waypoints = loadEditorTrail(paths, 'demo').waypoints;
    const gone = waypoints.find(w => w.id === 'w_cccc3333')!;
    expect(gone.deleted).toBe(true);
    // Not "the next build retires its id": the build reads the renamed <wpt> as this waypoint.
    expect(gone.lockedReason).toMatch(/gives its id to “Col Camp”, a <wpt> of its type 0 m away/);
    const pending = waypoints.find(w => w.pending)!;
    expect(pending).toMatchObject({ name: 'Col Camp', type: 'campsite', takesId: 'w_cccc3333' });
    const before = snapshot();
    expect(() => request('demo', pending.id, { lat: -36.551, lon: 148.351 })).toThrow(
      /gives this <wpt> the id w_cccc3333 of “Saddle Camp”.*Rebuild before editing it/
    );
    expect(snapshot()).toEqual(before);
    // Renamed back, it is the waypoint again.
    const back = request('demo', pending.id, { name: 'Saddle Camp' });
    expect(back.waypoint).toMatchObject({ id: 'w_cccc3333', name: 'Saddle Camp' });
    expect(back.waypoint.pending).toBeUndefined();
    expect(read('data/trails/demo/demo.gpx')).toBe(GPX);
  });
});

// A second <wpt> named "Flat" 9 km from the first: the build types both from
// the one marker titled "C Flat" (the nearest marker with the name, however far).
function writeSharedMarker(): void {
  writeTopo();
  write(
    'data/trails/topo/topo.gpx',
    TOPO_GPX.replace('<trk>', '<wpt lat="-36.58" lon="148.38"><name>Flat</name></wpt><trk>')
  );
  write(
    'public/data/generated/topo.json',
    JSON.stringify({
      ...TOPO_BUILT,
      waypoints: [
        ...TOPO_BUILT.waypoints,
        { id: 'w_99990001', name: 'Flat', type: 'campsite', lat: -36.58, lon: 148.38, totalDistance: 18 },
      ],
    })
  );
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  registry.topo.push({ id: 'w_99990001', name: 'Flat', type: 'campsite', lat: -36.58, lon: 148.38 });
  write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);
}

/** Every id the next build assigns, by the name and latitude of its `<wpt>`. */
function nextIds(dir: string): Record<string, string> {
  const inputs = buildInputs(dir);
  const ids = assignWaypointIds(dir, inputs, JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry);
  return Object.fromEntries(inputs.map((w, i) => [`${w.name} ${w.lat}`, ids[i]]));
}

describe('a CalTopo marker that types more than one waypoint', () => {
  it('refuses to add a waypoint under a name a marker already types another by', () => {
    writeTopo();
    const before = topoFiles();
    // The same type as the marker gives: it would still share the marker with the built "Flat".
    expect(() => addWaypoint(paths, 'topo', { name: 'Flat', type: 'campsite', lat: -36.58, lon: 148.38 })).toThrow(
      /also types “C Flat”.*name of its own/
    );
    expect(topoFiles()).toEqual(before);
  });

  it('leaves a shared marker where it is on a move, and says so', () => {
    writeSharedMarker();
    const result = request('topo', 'w_99990001', { lat: -36.581, lon: 148.381 });
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    expect(read('data/trails/topo/topo.gpx')).toContain('<wpt lat="-36.581" lon="148.381"><name>Flat</name></wpt>');
    expect(result.notes.join('\n')).toMatch(/Left its CalTopo marker “C Flat” .* where it is: it also types/);
    // Both keep their type and their id.
    expect(row('topo', 'w_dddd4444')).toMatchObject({ type: 'campsite', lat: -36.5 });
    expect(nextIds('topo')).toMatchObject({ 'Flat -36.5': 'w_dddd4444', 'Flat -36.581': 'w_99990001' });
  });

  it('leaves its title alone on a rename, pinning the type in the GPX, and refuses a retype through it', () => {
    writeSharedMarker();
    expect(() => request('topo', 'w_99990001', { type: 'hut' })).toThrow(/also types/);
    const result = request('topo', 'w_99990001', { name: 'Far Flat' });
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    expect(read('data/trails/topo/topo.gpx')).toContain(
      '<wpt lat="-36.58" lon="148.38"><name>Far Flat</name><type>campsite</type></wpt>'
    );
    const notes = result.notes.join('\n');
    expect(notes).toMatch(/Left its CalTopo marker “C Flat”/);
    expect(notes).toMatch(/Added a GPX <type> \(campsite\)/);
    expect(result.waypoint).toMatchObject({ name: 'Far Flat', type: 'campsite', typeSource: 'its GPX <type>' });
    // The marker still types the waypoint it was made for, and no id moves.
    expect(row('topo', 'w_dddd4444')).toMatchObject({ type: 'campsite', name: 'Flat' });
    expect(nextIds('topo')).toMatchObject({ 'Flat -36.5': 'w_dddd4444', 'Far Flat -36.58': 'w_99990001' });
  });

  it('holds a pending waypoint to the same rules', () => {
    writeTopo();
    write(
      'data/trails/topo/topo.gpx',
      TOPO_GPX.replace('<trk>', '<wpt lat="-36.58" lon="148.38"><name>Flat</name><type>campsite</type></wpt><trk>')
    );
    const pending = loadEditorTrail(paths, 'topo').waypoints.find(w => w.pending)!;
    expect(() => request('topo', pending.id, { type: 'hut' })).toThrow(/also types/);
    const moved = request('topo', pending.id, { lat: -36.581, lon: 148.381 });
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    expect(moved.notes.join('\n')).toMatch(/Left its CalTopo marker/);
    const renamed = request('topo', moved.waypoint.id, { name: 'Far Flat' });
    expect(read('data/trails/topo/topo.json')).toBe(TOPO_GEOJSON);
    expect(renamed.waypoint).toMatchObject({ pending: true, type: 'campsite', typeSource: 'its GPX <type>' });
    // Renaming into a name a marker types another waypoint by is what an add refuses.
    expect(() => request('topo', renamed.waypoint.id, { name: 'Creek', type: 'water' })).toThrow(
      /also types “W Creek”/
    );
  });

  it('refuses to edit a waypoint whose registry entry no longer matches it', () => {
    // A hand edit: the entry says water-tank, the <wpt> water, so the next build already re-keys it.
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    registry.demo.find(e => e.id === 'w_bbbb2222')!.type = 'water-tank';
    write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);
    const before = snapshot();
    expect(() => request('demo', 'w_bbbb2222', { lat: -36.521, lon: 148.301 })).toThrow(
      /would already give it .* rather than w_bbbb2222/
    );
    expect(() => request('demo', 'w_bbbb2222', { name: 'Soak' })).toThrow(/would already give it/);
    expect(snapshot()).toEqual(before);
  });
});

// "Retreat": typed by the title of a marker that is in no folder, as the AAWT's Glen Wills Wilderness Retreat is.
function writeRetreat(): void {
  writeTopo();
  write(
    'data/trails/topo/topo.gpx',
    TOPO_GPX.replace('<trk>', '<wpt lat="-36.58" lon="148.38"><name>Retreat</name></wpt><trk>')
  );
  write(
    'data/trails/topo/topo.json',
    TOPO_GEOJSON.replace(
      '],"type":"FeatureCollection"}',
      ',{"geometry":{"coordinates":[148.38,-36.58,0,0],"type":"Point"},"id":"m9","type":"Feature","properties":{"title":"Retreat","class":"Marker"}}],"type":"FeatureCollection"}'
    )
  );
  write(
    'public/data/generated/topo.json',
    JSON.stringify({
      ...TOPO_BUILT,
      waypoints: [
        ...TOPO_BUILT.waypoints,
        { id: 'w_a9b5ab88', name: 'Retreat', type: 'waypoint', lat: -36.58, lon: 148.38, totalDistance: 18 },
      ],
    })
  );
  const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
  registry.topo.push({ id: 'w_a9b5ab88', name: 'Retreat', type: 'waypoint', lat: -36.58, lon: 148.38 });
  write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);
}

describe('a rename and the type the build gives the new name', () => {
  it('refuses a name that would retype a waypoint its marker’s title types, writing nothing', () => {
    writeRetreat();
    const before = topoFiles();
    expect(() => request('topo', 'w_a9b5ab88', { name: 'Thredbo' })).toThrow(
      /the build would type it town, not waypoint/
    );
    // A prefixed name is stripped by the build: "Camp Thing", a campsite, under a new id.
    expect(() => request('topo', 'w_a9b5ab88', { name: 'C Camp Thing' })).toThrow(/type prefix/);
    // A prefix-typed <wpt> ("T Hamlet") and a folder-typed marker ("W Creek") alike.
    expect(() => request('topo', 'w_ffff6666', { name: 'W Hamlet' })).toThrow(/type prefix/);
    expect(() => request('topo', 'w_eeee5555', { name: 'WT: Creek' })).toThrow(/type prefix/);
    expect(topoFiles()).toEqual(before);
    // An ordinary name goes through, and keeps the id.
    request('topo', 'w_a9b5ab88', { name: 'Glen Retreat' });
    expect(nextIds('topo')).toMatchObject({ 'Glen Retreat -36.58': 'w_a9b5ab88' });
  });

  it('pins the type with a <type> when only the name of a GPX-typed waypoint would change it', () => {
    write(
      'data/trails/demo/demo.gpx',
      GPX.replace('  <trk>', '  <wpt lat="-36.58" lon="148.38"><name>Retreat</name></wpt>\n  <trk>')
    );
    write(
      'public/data/generated/demo.json',
      JSON.stringify({
        ...BUILT,
        waypoints: [
          ...BUILT.waypoints,
          { id: 'w_a9b5ab88', name: 'Retreat', type: 'waypoint', lat: -36.58, lon: 148.38, totalDistance: 18 },
        ],
      })
    );
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    registry.demo.push({ id: 'w_a9b5ab88', name: 'Retreat', type: 'waypoint', lat: -36.58, lon: 148.38 });
    write('data/waypoint-ids.json', `${JSON.stringify(registry, null, 2)}\n`);

    const result = request('demo', 'w_a9b5ab88', { name: 'Thredbo' });
    expect(read('data/trails/demo/demo.gpx')).toContain(
      '<wpt lat="-36.58" lon="148.38"><name>Thredbo</name><type>waypoint</type></wpt>'
    );
    expect(result.notes.join('\n')).toMatch(/Added a GPX <type> \(waypoint\).*known town/);
    expect(result.waypoint).toMatchObject({ name: 'Thredbo', type: 'waypoint' });
    expect(nextIds('demo')).toMatchObject({ 'Thredbo -36.58': 'w_a9b5ab88' });
  });

  it('renames a marker title and a <name> with whitespace at an end without touching anything else', () => {
    writeTopo();
    // The AAWT's "W Gurrangorambla Creek " (a trailing space in both files) and Larapinta's " C: Brinkley Bluff".
    const gpx = TOPO_GPX.replace('<name>W Creek</name>', '<name>W Creek </name>').replace(
      '<name>C Flat</name>',
      '<name> C Flat</name>'
    );
    const geojson = TOPO_GEOJSON.replace('"title":"W Creek"', '"title":"W Creek "').replace(
      '"title":"C Flat"',
      '"title":" C Flat"'
    );
    write('data/trails/topo/topo.gpx', gpx);
    write('data/trails/topo/topo.json', geojson);
    request('topo', 'w_eeee5555', { name: 'Ck' });
    request('topo', 'w_dddd4444', { name: 'Flats' });
    expect(read('data/trails/topo/topo.gpx')).toBe(
      gpx
        .replace('<name>W Creek </name>', '<name>W Ck </name>')
        .replace('<name> C Flat</name>', '<name> C Flats</name>')
    );
    expect(read('data/trails/topo/topo.json')).toBe(
      geojson.replace('"title":"W Creek "', '"title":"W Ck "').replace('"title":" C Flat"', '"title":" C Flats"')
    );
    expect(nextIds('topo')).toMatchObject({ 'Ck -36.52': 'w_eeee5555', 'Flats -36.5': 'w_dddd4444' });
  });
});

// A route that passes Saddle Camp twice: trail.json lists it by name, and the build makes the later pass `_2`.
const REVISIT_TRAIL_JSON =
  '{\n  "id": "demo",\n  "name": "Demo Track",\n  "gpxFile": "demo.gpx",\n  "revisitedWaypoints": ["Elsewhere", "Saddle Camp"]\n}\n';

function writeRevisit(descriptions: { waypointId: string; name?: string; description: string }[] = []): void {
  write('data/trails/demo/trail.json', REVISIT_TRAIL_JSON);
  write(
    'public/data/generated/demo.json',
    JSON.stringify({
      ...BUILT,
      waypoints: [
        ...BUILT.waypoints,
        { id: 'w_cccc3333_2', name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35, totalDistance: 19 },
      ],
    })
  );
  if (descriptions.length) {
    write('data/trails/demo/descriptions.json', `${JSON.stringify({ trailId: 'demo', descriptions }, null, 2)}\n`);
  }
}

describe('a revisited place', () => {
  it('shows the place’s description on every pass, and takes it only on the first', () => {
    writeRevisit();
    const second = row('demo', 'w_cccc3333_2');
    expect(second.description).toBe('A flat saddle.');
    expect(second.canDescribe).toBe(false);
    expect(second.lockedReason).toMatch(/later pass of “Saddle Camp” \(w_cccc3333\).*description.*w_cccc3333/);
    const before = snapshot();
    expect(() => request('demo', 'w_cccc3333_2', { description: 'Second time round.' })).toThrow(/w_cccc3333/);
    expect(snapshot()).toEqual(before);
    // Described on the first pass, it shows on both, as it will in the build.
    request('demo', 'w_cccc3333', { description: 'A broad saddle.' });
    expect(row('demo', 'w_cccc3333_2').description).toBe('A broad saddle.');
    request('demo', 'w_cccc3333', { description: '' });
    expect(row('demo', 'w_cccc3333_2').description).toBe('');
  });

  it('surfaces a descriptions.json entry under a later pass’s id, which the build never applies', () => {
    writeRevisit([
      DESCRIPTIONS.descriptions[0],
      { waypointId: 'w_cccc3333_2', name: 'Saddle Camp', description: 'Second time round.' },
    ]);
    const second = row('demo', 'w_cccc3333_2');
    expect(second.description).toBe('A flat saddle.');
    expect(second.lockedReason).toMatch(
      /descriptions\.json has an entry under w_cccc3333_2, which the build never applies/
    );
  });

  it('renames the place in trail.json’s revisitedWaypoints with it, in the same save', () => {
    writeRevisit();
    const result = request('demo', 'w_cccc3333', { name: 'Saddle Campsite' });
    expect(read('data/trails/demo/trail.json')).toBe(REVISIT_TRAIL_JSON.replace('"Saddle Camp"', '"Saddle Campsite"'));
    expect(result.changedFiles).toContain('data/trails/demo/trail.json');
    expect(result.notes.join('\n')).toMatch(/revisitedWaypoints/);
    // Every pass shows the new name.
    expect(row('demo', 'w_cccc3333_2')).toMatchObject({ name: 'Saddle Campsite', builtName: 'Saddle Camp' });

    // A rename through the later pass renames the place: the <wpt>, the registry entry, the list and the aid.
    const back = request('demo', 'w_cccc3333_2', { name: 'Saddle Camp' });
    expect(back.waypoint).toMatchObject({ id: 'w_cccc3333_2', name: 'Saddle Camp' });
    expect(back.notes.join('\n')).toMatch(/Also renames w_cccc3333/);
    expect(read('data/trails/demo/trail.json')).toBe(REVISIT_TRAIL_JSON);
    expect(read('data/trails/demo/demo.gpx')).toBe(GPX);
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.demo.find(e => e.id === 'w_cccc3333')?.name).toBe('Saddle Camp');
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions[0].name).toBe('Saddle Camp');
    expect(row('demo', 'w_cccc3333').name).toBe('Saddle Camp');
  });

  it('writes nothing when trail.json cannot be edited in place', () => {
    writeRevisit();
    // The list is there but not as an array of strings the editor can splice.
    write('data/trails/demo/trail.json', REVISIT_TRAIL_JSON.replace('["Elsewhere", "Saddle Camp"]', '"Saddle Camp"'));
    const before = snapshot();
    expect(() => request('demo', 'w_cccc3333', { name: 'Saddle Campsite' })).toThrow(/revisitedWaypoints/);
    expect(snapshot()).toEqual(before);
  });
});

describe('an id that is not retired yet', () => {
  const SADDLE = { expected: { name: 'Saddle Camp', lat: -36.55, lon: 148.35, description: 'A flat saddle.' } };

  it('refuses a waypoint of the same type added within reach of one deleted since the build', () => {
    deleteWaypoint(paths, 'demo', 'w_cccc3333', SADDLE);
    const before = snapshot();
    // 33 m away: the build would read it as Saddle Camp moved and renamed, and hand it the id and its comments.
    expect(() =>
      addWaypoint(paths, 'demo', { name: 'Ridge Camp', type: 'campsite', lat: -36.5503, lon: 148.35 })
    ).toThrow(/Rebuild first so w_cccc3333 is retired/);
    expect(snapshot()).toEqual(before);
    // The same goes for a pending waypoint moved, or retyped, into that state.
    const far = addWaypoint(paths, 'demo', { name: 'Ridge Camp', type: 'campsite', lat: -36.58, lon: 148.38 }).waypoint;
    expect(() => request('demo', far.id, { lat: -36.5503, lon: 148.35 })).toThrow(
      /Rebuild first so w_cccc3333 is retired/
    );
    const tank = addWaypoint(paths, 'demo', {
      name: 'Ridge Tank',
      type: 'water-tank',
      lat: -36.5503,
      lon: 148.35,
    }).waypoint;
    expect(() => request('demo', tank.id, { type: 'campsite' })).toThrow(/Rebuild first so w_cccc3333 is retired/);
  });

  it('lets the deleted waypoint itself be restored, and says the id comes back', () => {
    deleteWaypoint(paths, 'demo', 'w_cccc3333', SADDLE);
    const restored = addWaypoint(paths, 'demo', { name: 'Saddle Camp', type: 'campsite', lat: -36.5503, lon: 148.35 });
    expect(restored.notes.join('\n')).toMatch(/gives it back the id w_cccc3333/);
    expect(restored.waypoint).toMatchObject({ pending: true, takesId: 'w_cccc3333' });
    // The deleted row no longer claims its id is about to be retired.
    const deleted = row('demo', 'w_cccc3333');
    expect(deleted.deleted).toBe(true);
    expect(deleted.lockedReason).toMatch(/gives its id to “Saddle Camp”/);
    expect(deleted.lockedReason).not.toMatch(/retires its id/);
    expect(nextIds('demo')).toMatchObject({ 'Saddle Camp -36.5503': 'w_cccc3333' });
  });

  it('joins a waypoint restored at its exact position straight back to its id', () => {
    deleteWaypoint(paths, 'demo', 'w_cccc3333', SADDLE);
    const restored = addWaypoint(paths, 'demo', { name: 'Saddle Camp', type: 'campsite', lat: -36.55, lon: 148.35 });
    expect(restored.waypoint).toMatchObject({ id: 'w_cccc3333', name: 'Saddle Camp' });
    expect(restored.waypoint.pending).toBeUndefined();
    expect(restored.waypoint.deleted).toBeUndefined();
    expect(restored.notes.join('\n')).toMatch(/w_cccc3333/);
    expect(read('data/trails/demo/demo.gpx')).toBe(GPX);
  });
});

describe('what a save writes, and how', () => {
  it('leaves the name aid of a descriptions.json entry alone unless the save renames', () => {
    const aided = {
      ...DESCRIPTIONS,
      descriptions: [{ ...DESCRIPTIONS.descriptions[0], name: 'Saddle camp (the old one)' }],
    };
    write('data/trails/demo/descriptions.json', `${JSON.stringify(aided, null, 2)}\n`);
    request('demo', 'w_cccc3333', { description: 'A broad saddle.' });
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions[0]).toEqual({
      waypointId: 'w_cccc3333',
      name: 'Saddle camp (the old one)',
      description: 'A broad saddle.',
    });
    request('demo', 'w_cccc3333', { description: 'A wide saddle.', name: 'Saddle Campsite' });
    expect(JSON.parse(read('data/trails/demo/descriptions.json')).descriptions[0].name).toBe('Saddle Campsite');
  });

  it('rounds a position once, so a move and a retype in one save find the <wpt> again', () => {
    const result = request('demo', 'w_bbbb2222', { lat: -36.5212345678, lon: 148.3012345678, type: 'water-tank' });
    expect(read('data/trails/demo/demo.gpx')).toContain(
      '<wpt lat="-36.521235" lon="148.301235"><name>Spring</name><type>water-tank</type></wpt>'
    );
    expect(result.waypoint).toMatchObject({ lat: -36.521235, lon: 148.301235, type: 'water-tank' });
    const registry = JSON.parse(read('data/waypoint-ids.json')) as WaypointRegistry;
    expect(registry.demo.find(e => e.id === 'w_bbbb2222')).toMatchObject({ lat: -36.521235, lon: 148.301235 });
    // A position that rounds to where it is is not a move.
    const still = request('demo', 'w_bbbb2222', { lat: -36.5212350001, lon: 148.301235 });
    expect(still.changedFiles).toEqual([]);
  });

  it('replaces every file or none: a write that fails leaves the others as they were', () => {
    // descriptions.json is a link into a directory that is not there, so it cannot be written.
    fs.rmSync(path.join(root, 'data/trails/demo/descriptions.json'));
    fs.symlinkSync(
      path.join(root, 'nowhere', 'descriptions.json'),
      path.join(root, 'data/trails/demo/descriptions.json')
    );
    const gpx = read('data/trails/demo/demo.gpx');
    const registry = read('data/waypoint-ids.json');
    expect(() => request('demo', 'w_cccc3333', { name: 'Saddle Campsite', description: 'A saddle.' })).toThrow(
      /nothing was changed/
    );
    expect(read('data/trails/demo/demo.gpx')).toBe(gpx);
    expect(read('data/waypoint-ids.json')).toBe(registry);
    expect(fs.readdirSync(path.join(root, 'data/trails/demo')).sort()).toEqual([
      'demo.gpx',
      'descriptions.json',
      'trail.json',
    ]);
    expect(fs.readdirSync(path.join(root, 'data')).sort()).toEqual(['trails', 'waypoint-ids.json']);
  });

  it('puts back the files already replaced when a later one cannot be', () => {
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    const c = path.join(root, 'c.txt');
    fs.writeFileSync(a, 'A1');
    fs.writeFileSync(c, 'C1');
    const failing = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === c) throw new Error('disk full');
        fs.renameSync(from, to);
      },
    };
    const writes = [
      { file: a, text: 'A2' },
      { file: b, text: 'B2' },
      { file: c, text: 'C2' },
    ];
    expect(() => commitWrites(writes, failing)).toThrow(/disk full.*put back/);
    expect(fs.readFileSync(a, 'utf-8')).toBe('A1');
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.readFileSync(c, 'utf-8')).toBe('C1');
    expect(
      fs
        .readdirSync(root)
        .filter(f => f.endsWith('.txt') || f.startsWith('.'))
        .sort()
    ).toEqual(['a.txt', 'c.txt']);

    commitWrites(writes);
    expect([a, b, c].map(f => fs.readFileSync(f, 'utf-8'))).toEqual(['A2', 'B2', 'C2']);
    expect(
      fs
        .readdirSync(root)
        .filter(f => f.endsWith('.txt') || f.startsWith('.'))
        .sort()
    ).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });
});

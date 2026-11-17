import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WaypointDescription } from '@lib/comments-api-types';
import {
  MAX_DESCRIPTION_LENGTH,
  buildRows,
  checkDraft,
  exportFileText,
  exportableDrift,
  matchesRow,
  parseCuratedFile,
  patchSnippet,
  rowHtml,
  shownText,
  summaryHtml,
  trailDirFor,
  trailDirOf,
  trailWaypoints,
  type TrailWaypoint,
} from './admin-descriptions-view';

const ROOT = path.resolve(__dirname, '../..');
const XSS = '<img src=x onerror=alert(1)>';

function enriched(id: string | undefined, name: string, km: number, description = '') {
  return { id, name, type: 'campsite', lat: 0, lon: km / 111, description, totalDistance: km };
}

const trail = {
  track: {
    points: [
      { lat: 0, lon: 0, ele: 0, dist: 0 },
      { lat: 0, lon: 1, ele: 0, dist: 111 },
    ],
  },
  waypoints: [
    enriched('w_main2', 'Second', 20, 'B2'),
    enriched('w_main1', 'First', 5, 'B1'),
    enriched(undefined, 'No id', 1),
  ],
  alternates: [
    { name: 'High route', waypoints: [enriched('w_alt1', 'Alt hut', 12), enriched('w_main1', 'First again', 5)] },
  ],
  sideTrips: [],
  // Near km ~2 of the route, 0.1° north of it.
  offTrailWaypoints: [
    { id: 'w_off1', name: 'Pub', type: 'accommodation', lat: 0.1, lon: 0.018, distanceFromTrail: 11000 },
  ],
} as unknown as Parameters<typeof trailWaypoints>[0];

const live = (waypointId: string, description: string): WaypointDescription => ({
  waypointId,
  description,
  updatedAt: '2026-11-01T00:00:00.000Z',
});

describe('trailWaypoints', () => {
  it('lists each id once: main route by km, then the rest by their place along it', () => {
    const list = trailWaypoints(trail);
    expect(list.map(w => w.id)).toEqual(['w_main1', 'w_main2', 'w_off1', 'w_alt1']);
    expect(list[0]).toMatchObject({ placement: 'main', km: 5, bundled: 'B1', name: 'First' });
    expect(list[2].placement).toBe('off-trail');
    expect(list[2].km).toBeGreaterThan(1.5);
    expect(list[2].km).toBeLessThan(2.5);
    expect(list[3]).toMatchObject({ placement: 'variant', variant: 'High route', km: 12 });
  });
});

describe('buildRows', () => {
  const waypoints: TrailWaypoint[] = [
    { id: 'w_sync', name: 'Sync', type: 'water', placement: 'main', km: 1, bundled: 'File text.' },
    { id: 'w_drift', name: 'Drift', type: 'water', placement: 'main', km: 2, bundled: 'Old file text.' },
    { id: 'w_new', name: 'New', type: 'water', placement: 'main', km: 3, bundled: 'GPX text' },
    { id: 'w_clear', name: 'Clear', type: 'water', placement: 'main', km: 4, bundled: 'Kept.' },
    { id: 'w_pend', name: 'Pending', type: 'water', placement: 'main', km: 5, bundled: 'Not uploaded.' },
    { id: 'w_none', name: 'None', type: 'water', placement: 'off-trail', km: 6, bundled: '' },
  ];
  const file = parseCuratedFile(
    JSON.stringify({
      trailId: 'demo',
      descriptions: [
        { waypointId: 'w_sync', description: 'File text.' },
        { waypointId: 'w_drift', description: 'Old file text.' },
        { waypointId: 'w_clear', description: 'Kept.' },
        { waypointId: 'w_pend', description: 'Not uploaded.' },
      ],
    })
  );
  const rows = buildRows(waypoints, file, [
    live('w_sync', 'File text.'),
    live('w_drift', 'Corrected live.'),
    live('w_new', 'Written live.'),
    live('w_clear', ''),
    live('w_gone', 'On an id the trail lost.'),
  ]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  it('classifies each waypoint against the file and the synced set', () => {
    expect(byId.w_sync.state).toBe('in-sync');
    expect(byId.w_drift.state).toBe('drift');
    expect(byId.w_new.state).toBe('drift');
    expect(byId.w_clear.state).toBe('cleared');
    expect(byId.w_pend.state).toBe('pending');
    expect(byId.w_none.state).toBe('bundled');
    expect(byId.w_gone).toMatchObject({ placement: 'unknown', state: 'drift' });
  });

  it('says what a phone shows: synced text, else (also when cleared) the bundled', () => {
    expect(shownText(byId.w_drift)).toBe('Corrected live.');
    expect(shownText(byId.w_clear)).toBe('Kept.');
    expect(shownText(byId.w_none)).toBe('');
  });

  it('filters by drift, synced, differs, curated and empty', () => {
    const ids = (f: Parameters<typeof matchesRow>[1], q = '') => rows.filter(r => matchesRow(r, f, q)).map(r => r.id);
    expect(ids('drift')).toEqual(['w_drift', 'w_new', 'w_gone']);
    expect(ids('differs')).toEqual(['w_drift', 'w_new', 'w_gone']);
    expect(ids('synced')).toEqual(['w_sync', 'w_drift', 'w_new', 'w_clear', 'w_gone']);
    expect(ids('curated')).toEqual(['w_sync', 'w_drift', 'w_clear', 'w_pend']);
    expect(ids('none')).toEqual(['w_none']);
    expect(ids('all', 'pend')).toEqual(['w_pend']);
    expect(ids('all', 'w_new')).toEqual(['w_new']);
  });

  it('exports the drift into the file: in place for an entry, in route order for a new one', () => {
    const fileText = `${JSON.stringify(file, null, 2)}\n`;
    const out = JSON.parse(exportFileText('demo', fileText, rows));
    expect(out.descriptions).toEqual([
      { waypointId: 'w_sync', description: 'File text.' },
      { waypointId: 'w_drift', description: 'Corrected live.' },
      { waypointId: 'w_new', name: 'New', description: 'Written live.' },
      { waypointId: 'w_clear', description: 'Kept.' },
      { waypointId: 'w_pend', description: 'Not uploaded.' },
    ]);
    // The unknown id is left out of the export, but counted in the summary.
    expect(exportableDrift(rows).map(r => r.id)).toEqual(['w_drift', 'w_new']);
    expect(JSON.parse(patchSnippet(rows))).toEqual([
      { waypointId: 'w_drift', name: 'Drift', description: 'Corrected live.' },
      { waypointId: 'w_new', name: 'New', description: 'Written live.' },
    ]);
  });

  it('starts a new file for a trail that has none', () => {
    const out = JSON.parse(exportFileText('demo', null, rows));
    expect(out.trailId).toBe('demo');
    expect(typeof out.note).toBe('string');
    expect(out.descriptions.map((e: { waypointId: string }) => e.waypointId)).toEqual(['w_drift', 'w_new']);
  });

  it('shows the drift warning with the export, and the trail file path', () => {
    const html = summaryHtml(rows, 'data/trails/demo/descriptions.json');
    expect(html).toContain('2 synced descriptions are not in descriptions.json');
    expect(html).toContain('data/trails/demo/descriptions.json');
    expect(html).toContain('1 more is on ids this trail no longer has');
    expect(html).toContain('id="desc-download"');
    const calm = summaryHtml([byId.w_sync], 'x');
    expect(calm).toContain('No drift');
    expect(calm).not.toContain('desc-download');
  });
});

describe('every committed descriptions.json', () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, 'data/trails'))
    .filter(dir => fs.existsSync(path.join(ROOT, 'data/trails', dir, 'descriptions.json')));

  it.each(dirs)('%s round-trips byte for byte through an export with no drift', dir => {
    const text = fs.readFileSync(path.join(ROOT, 'data/trails', dir, 'descriptions.json'), 'utf8');
    const file = parseCuratedFile(text)!;
    const rows = buildRows(
      [],
      file,
      file.descriptions.map(e => live(e.waypointId, e.description))
    );
    expect(exportFileText(file.trailId, text, rows)).toBe(text);
  });
});

describe('checkDraft', () => {
  it('trims, counts against the API limit and reuses the voice hints', () => {
    expect(checkDraft(`  ${'a'.repeat(MAX_DESCRIPTION_LENGTH)}  `)).toMatchObject({ tooLong: false });
    expect(checkDraft('a'.repeat(MAX_DESCRIPTION_LENGTH + 1)).tooLong).toBe(true);
    const check = checkDraft('You should treat the water');
    expect(check.hints.map(h => h.match)).toEqual(expect.arrayContaining(['You', 'should', 'ending']));
  });
});

describe('trail directories', () => {
  it('reads the directory from a glob key and finds it by build id', () => {
    expect(trailDirOf('../../data/trails/AAWT/descriptions.json')).toBe('AAWT');
    const ids = { '../../data/trails/AAWT/trail.json': 'aawt', '../../data/trails/heysen/trail.json': 'heysen' };
    expect(trailDirFor('aawt', ids)).toBe('AAWT');
    expect(trailDirFor('nope', ids)).toBeNull();
  });
});

describe('rowHtml', () => {
  const row = buildRows(
    [{ id: 'w_x', name: `Name ${XSS}`, type: 'water', placement: 'main', km: 1, bundled: `Bundled ${XSS}` }],
    null,
    [live('w_x', `Synced ${XSS}\nline two`)]
  )[0];

  it('escapes every text, and offers editing only to an admin', () => {
    const host = document.createElement('div');
    host.innerHTML = rowHtml(row, { canEdit: false, editing: false });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(`Name ${XSS}`);
    expect(host.textContent).toContain(`Bundled ${XSS}`);
    expect(host.textContent).toContain(`Synced ${XSS}`);
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('.desc-cell.is-different')).not.toBeNull();

    host.innerHTML = rowHtml(row, { canEdit: true, editing: true, draft: `Draft ${XSS} you` });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('textarea')!.value).toBe(`Draft ${XSS} you`);
    expect(host.querySelector('.desc-hints')!.textContent).toContain('you');
    expect([...host.querySelectorAll('button')].map(b => b.dataset.action)).toEqual(['save', 'cancel', 'clear']);
  });
});

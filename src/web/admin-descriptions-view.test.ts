import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DescriptionSource, WaypointDescription } from '@lib/comments-api-types';
import {
  MAX_DESCRIPTION_LENGTH,
  buildRows,
  checkDraft,
  exportFileText,
  exportableDrift,
  fileContext,
  firstPassIdOf,
  liveEditAdvice,
  matchesRow,
  nextUploadText,
  parseCuratedFile,
  patchSnippet,
  rowHtml,
  shownText,
  stateLabel,
  summaryHtml,
  trailDirFor,
  trailDirOf,
  trailWaypoints,
  type FileContext,
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

/** A synced row; `source` left out is an API that does not say (a worker that predates the marker). */
const live = (waypointId: string, description: string, source?: DescriptionSource): WaypointDescription => ({
  waypointId,
  description,
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...(source ? { source } : {}),
});

/** A trail with a descriptions.json in the build. */
const WITH_FILE: FileContext = { path: 'data/trails/demo/descriptions.json', hasFile: true };
/** One without: no upload ever visits it. */
const NO_FILE: FileContext = { path: 'data/trails/demo/descriptions.json', hasFile: false };

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
    { id: 'w_wait', name: 'Waiting', type: 'water', placement: 'main', km: 7, bundled: 'Newly committed.' },
    { id: 'w_gonefile', name: 'Deleted entry', type: 'water', placement: 'main', km: 8, bundled: 'GPX' },
    { id: 'w_back', name: 'Listed again', type: 'water', placement: 'main', km: 9, bundled: 'Back.' },
    { id: 'w_wiped', name: 'Wiped', type: 'water', placement: 'main', km: 10, bundled: 'GPX' },
    { id: 'w_old', name: 'Old worker', type: 'water', placement: 'main', km: 11, bundled: 'File says.' },
  ];
  const file = parseCuratedFile(
    JSON.stringify({
      trailId: 'demo',
      descriptions: [
        { waypointId: 'w_sync', description: 'File text.' },
        { waypointId: 'w_drift', description: 'Old file text.' },
        { waypointId: 'w_clear', description: 'Kept.' },
        { waypointId: 'w_pend', description: 'Not uploaded.' },
        { waypointId: 'w_wait', description: 'Newly committed.' },
        { waypointId: 'w_back', description: 'Back.' },
        { waypointId: 'w_old', description: 'File says.' },
      ],
    })
  );
  const rows = buildRows(waypoints, file, [
    live('w_sync', 'File text.', 'upload'),
    live('w_drift', 'Corrected live.', 'live'),
    live('w_new', 'Written live.', 'live'),
    // An admin cleared an id the file lists.
    live('w_clear', '', 'live'),
    // A merged file change whose upload has not run: the API still has the old upload.
    live('w_wait', 'What the last upload sent.', 'upload'),
    // An entry deleted from the file on purpose; the upload will withdraw it.
    live('w_gonefile', 'Uploaded before the entry was deleted.', 'upload'),
    // Withdrawn by an upload, then listed in the file again.
    live('w_back', '', 'upload'),
    // A live clear of an id the file does not list: the file agrees.
    live('w_wiped', '', 'live'),
    // A worker that predates the marker.
    live('w_old', 'Who wrote this?'),
    live('w_gone', 'On an id the trail lost.', 'live'),
  ]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  it('classifies each waypoint against the file, the synced set and what wrote it', () => {
    expect(byId.w_sync.state).toBe('in-sync');
    expect(byId.w_drift.state).toBe('drift');
    expect(byId.w_new.state).toBe('drift');
    expect(byId.w_pend.state).toBe('pending');
    expect(byId.w_none.state).toBe('bundled');
    expect(byId.w_wiped.state).toBe('cleared');
    expect(byId.w_gone).toMatchObject({ placement: 'unknown', state: 'drift' });
  });

  it('never calls an uploaded row the file has moved past drift: it awaits the upload', () => {
    for (const id of ['w_wait', 'w_gonefile', 'w_back']) {
      expect(byId[id].state).toBe('awaiting');
      expect(nextUploadText(byId[id], WITH_FILE)).toContain('Nothing to commit');
    }
    expect(stateLabel(byId.w_wait)).toBe('awaiting upload');
    expect(nextUploadText(byId.w_wait, WITH_FILE)).toContain('newer text than the API');
    expect(nextUploadText(byId.w_gonefile, WITH_FILE)).toContain('no longer has this entry');
    expect(nextUploadText(byId.w_back, WITH_FILE)).toContain('lists it again');
  });

  it('flags a live clear of an id the file lists, and says the upload re-sends the file’s text', () => {
    expect(byId.w_clear.state).toBe('drift');
    expect(stateLabel(byId.w_clear)).toBe('drift: cleared live');
    expect(nextUploadText(byId.w_clear, WITH_FILE)).toContain('the next upload re-sends the file’s text');
  });

  it('claims nothing about a row an older worker gives no origin for', () => {
    expect(byId.w_old.state).toBe('unknown');
    expect(stateLabel(byId.w_old)).toBe('origin unknown');
    expect(nextUploadText(byId.w_old, WITH_FILE)).toContain('does not say whether a live edit or an upload wrote it');
  });

  it('says what a phone shows: synced text, else (also when cleared) the bundled', () => {
    expect(shownText(byId.w_drift)).toBe('Corrected live.');
    expect(shownText(byId.w_clear)).toBe('Kept.');
    expect(shownText(byId.w_none)).toBe('');
  });

  it('filters by drift, awaiting upload, synced, differs, curated and empty', () => {
    const ids = (f: Parameters<typeof matchesRow>[1], q = '') => rows.filter(r => matchesRow(r, f, q)).map(r => r.id);
    expect(ids('drift')).toEqual(['w_drift', 'w_new', 'w_clear', 'w_gone']);
    expect(ids('awaiting')).toEqual(['w_wait', 'w_gonefile', 'w_back']);
    expect(ids('differs')).toEqual(['w_drift', 'w_new', 'w_wait', 'w_gonefile', 'w_old', 'w_gone']);
    expect(ids('synced')).toEqual([
      'w_sync',
      'w_drift',
      'w_new',
      'w_clear',
      'w_wait',
      'w_gonefile',
      'w_back',
      'w_wiped',
      'w_old',
      'w_gone',
    ]);
    expect(ids('curated')).toEqual(['w_sync', 'w_drift', 'w_clear', 'w_pend', 'w_wait', 'w_back', 'w_old']);
    expect(ids('none')).toEqual(['w_none']);
    expect(ids('all', 'pend')).toEqual(['w_pend']);
    expect(ids('all', 'w_new')).toEqual(['w_new']);
  });

  it('exports only the live edits: in place for an entry, in route order for a new one', () => {
    const fileText = `${JSON.stringify(file, null, 2)}\n`;
    const out = JSON.parse(exportFileText('demo', fileText, rows));
    expect(out.descriptions).toEqual([
      { waypointId: 'w_sync', description: 'File text.' },
      { waypointId: 'w_drift', description: 'Corrected live.' },
      { waypointId: 'w_new', name: 'New', description: 'Written live.' },
      // The live clear leaves its entry alone.
      { waypointId: 'w_clear', description: 'Kept.' },
      { waypointId: 'w_pend', description: 'Not uploaded.' },
      // The newly committed text is not overwritten with the API's older upload,
      { waypointId: 'w_wait', description: 'Newly committed.' },
      { waypointId: 'w_back', description: 'Back.' },
      // nor is text of unknown origin written in.
      { waypointId: 'w_old', description: 'File says.' },
    ]);
    // The deliberately deleted entry is not put back.
    expect(out.descriptions.some((e: { waypointId: string }) => e.waypointId === 'w_gonefile')).toBe(false);
    // The unknown id is left out of the export, but counted in the summary.
    expect(exportableDrift(rows).map(r => r.id)).toEqual(['w_drift', 'w_new']);
    expect(JSON.parse(patchSnippet(rows))).toEqual([
      { waypointId: 'w_drift', name: 'Drift', description: 'Corrected live.' },
      { waypointId: 'w_new', name: 'New', description: 'Written live.' },
    ]);
  });

  it('exports the file unchanged when rows only await an upload', () => {
    const fileText = `${JSON.stringify(file, null, 2)}\n`;
    const waiting = buildRows(waypoints, file, [
      live('w_sync', 'File text.', 'upload'),
      live('w_wait', 'What the last upload sent.', 'upload'),
      live('w_gonefile', 'Uploaded before the entry was deleted.', 'upload'),
    ]);
    expect(exportableDrift(waiting)).toEqual([]);
    expect(exportFileText('demo', fileText, waiting)).toBe(fileText);
    const html = summaryHtml(waiting, WITH_FILE);
    expect(html).toContain('No drift');
    expect(html).toContain('2 rows wait for an Upload descriptions run');
    expect(html).not.toContain('desc-download');
    expect(html).not.toContain('desc-drift');
  });

  it('starts a new file for a trail that has none', () => {
    const out = JSON.parse(exportFileText('demo', null, rows));
    expect(out.trailId).toBe('demo');
    expect(typeof out.note).toBe('string');
    expect(out.descriptions.map((e: { waypointId: string }) => e.waypointId)).toEqual(['w_drift', 'w_new']);
  });

  it('shows the drift warning with the export, and the trail file path', () => {
    const html = summaryHtml(rows, WITH_FILE);
    expect(html).toContain('2 live edits are not in descriptions.json');
    expect(html).toContain('data/trails/demo/descriptions.json');
    expect(html).toContain('1 waypoint was cleared live while descriptions.json still lists it');
    expect(html).toContain('1 live edit is on an id this trail no longer has');
    expect(html).toContain('3 rows wait for an Upload descriptions run');
    expect(html).toContain('1 synced row differs from descriptions.json, and this API does not say');
    expect(html).toContain('id="desc-download"');
    const calm = summaryHtml([byId.w_sync], WITH_FILE);
    expect(calm).toContain('No drift');
    expect(calm).not.toContain('desc-download');
  });
});

describe('a trail with no descriptions.json', () => {
  const waypoints: TrailWaypoint[] = [
    { id: 'w_a', name: 'Hut', type: 'hut', placement: 'main', km: 1, bundled: 'GPX text' },
  ];
  const rows = buildRows(waypoints, null, [live('w_a', 'Closed for the season.', 'live')]);

  it('does not claim an upload overwrites a live edit: none visits the trail', () => {
    expect(rows[0].state).toBe('drift');
    const text = nextUploadText(rows[0], NO_FILE);
    expect(text).toContain('no upload touches it');
    expect(text).not.toContain('next upload');
    const html = summaryHtml(rows, NO_FILE);
    expect(html).toContain('1 live edit is held only by the API');
    expect(html).toContain('no <em>Upload descriptions</em> run touches it');
    expect(html).toContain('Download a new descriptions.json');
    expect(html).not.toContain('The next <em>Upload descriptions</em> run');
    expect(liveEditAdvice(rows[0], NO_FILE)).toContain('no upload overwrites it');
    expect(liveEditAdvice(rows[0], WITH_FILE)).toContain('the next Upload descriptions run overwrites it');
  });

  it('sends Te Araroa’s live edits upstream, and offers no file to create', () => {
    const ctx = fileContext('te_araroa', 'te_araroa', null);
    expect(ctx).toEqual({
      path: 'data/trails/te_araroa/descriptions.json',
      hasFile: false,
      upstream: 'te-araroa-data',
    });
    expect(nextUploadText(rows[0], ctx)).toContain('built upstream in te-araroa-data');
    const html = summaryHtml(rows, ctx);
    expect(html).toContain('built upstream in te-araroa-data');
    expect(html).toContain('no descriptions.json to commit it to');
    expect(html).not.toContain('desc-download');
    expect(html).not.toContain('desc-copy');
    expect(liveEditAdvice(rows[0], ctx)).toContain('te-araroa-data');
    // Every other trail without a file may get one; one that has a file is curated here.
    expect(fileContext('three_passes', 'three_passes', null).upstream).toBeUndefined();
    expect(fileContext('te_araroa', 'te_araroa', '{}').upstream).toBeUndefined();
  });
});

describe('a revisited place (<id>_2)', () => {
  const waypoints: TrailWaypoint[] = [
    { id: 'w_07233ee1', name: 'Lobuche', type: 'town', placement: 'main', km: 60, bundled: 'First pass text.' },
    { id: 'w_12345678', name: 'Hex id ending in digits', type: 'hut', placement: 'main', km: 70, bundled: '' },
    { id: 'w_07233ee1_2', name: 'Lobuche', type: 'town', placement: 'main', km: 95, bundled: 'First pass text.' },
  ];
  const rows = buildRows(waypoints, null, [
    live('w_07233ee1', 'Lodge closed.', 'live'),
    live('w_07233ee1_2', 'Lodge closed.', 'live'),
  ]);
  const [first, plain, later] = rows;

  it('tells a later pass from an id that merely ends in digits', () => {
    const ids = new Set(waypoints.map(w => w.id));
    expect(firstPassIdOf('w_07233ee1_2', ids)).toBe('w_07233ee1');
    expect(firstPassIdOf('w_12345678', ids)).toBeNull();
    expect(firstPassIdOf('w_07233ee1', ids)).toBeNull();
    expect(later.firstPassId).toBe('w_07233ee1');
    expect(first.laterPassIds).toEqual(['w_07233ee1_2']);
    expect(plain.firstPassId).toBeUndefined();
    expect(plain.laterPassIds).toBeUndefined();
  });

  it('never exports a later-pass id, which the build cannot apply', () => {
    expect(exportableDrift(rows).map(r => r.id)).toEqual(['w_07233ee1']);
    const out = JSON.parse(exportFileText('three_passes', null, rows));
    expect(out.descriptions).toEqual([{ waypointId: 'w_07233ee1', name: 'Lobuche', description: 'Lodge closed.' }]);
    expect(patchSnippet(rows)).not.toContain('w_07233ee1_2');
  });

  it('marks both passes, and counts the later one apart from what can be committed', () => {
    const host = document.createElement('div');
    host.innerHTML = rowHtml(later, { canEdit: true, editing: false, ctx: NO_FILE });
    expect(host.querySelector('.desc-badge-pass')!.textContent).toBe('later pass');
    expect(host.querySelector('.desc-pass')!.textContent).toContain('cannot be committed to the file');
    expect(host.querySelector('.desc-pass')!.textContent).toContain('w_07233ee1');
    host.innerHTML = rowHtml(first, { canEdit: true, editing: false, ctx: NO_FILE });
    expect(host.querySelector('.desc-badge-pass')).toBeNull();
    expect(host.querySelector('.desc-pass')!.textContent).toContain('has to be made on each pass');
    host.innerHTML = rowHtml(plain, { canEdit: true, editing: false, ctx: NO_FILE });
    expect(host.querySelector('.desc-pass')).toBeNull();

    const html = summaryHtml(rows, NO_FILE);
    expect(html).toContain('1 live edit is held only by the API');
    expect(html).toContain('1 live edit is on a later pass of a revisited place');
    expect(liveEditAdvice(later, NO_FILE)).toContain('Make the lasting fix on the first pass (w_07233ee1)');
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
      file.descriptions.map(e => live(e.waypointId, e.description, 'upload'))
    );
    expect(exportFileText(file.trailId, text, rows)).toBe(text);
  });

  it.each(dirs)('%s is left byte for byte by an export while every row awaits an upload', dir => {
    const text = fs.readFileSync(path.join(ROOT, 'data/trails', dir, 'descriptions.json'), 'utf8');
    const file = parseCuratedFile(text)!;
    const rows = buildRows(
      [],
      file,
      file.descriptions.map(e => live(e.waypointId, `Older: ${e.description}`, 'upload'))
    );
    expect(rows.every(r => r.state === 'awaiting')).toBe(true);
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
    [live('w_x', `Synced ${XSS}\nline two`, 'live')]
  )[0];

  it('escapes every text, and offers editing only to an admin', () => {
    const host = document.createElement('div');
    host.innerHTML = rowHtml(row, { canEdit: false, editing: false, ctx: NO_FILE });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain(`Name ${XSS}`);
    expect(host.textContent).toContain(`Bundled ${XSS}`);
    expect(host.textContent).toContain(`Synced ${XSS}`);
    expect(host.textContent).toContain('Synced (2026-11-01, live edit)');
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('.desc-cell.is-different')).not.toBeNull();

    host.innerHTML = rowHtml(row, { canEdit: true, editing: true, draft: `Draft ${XSS} you`, ctx: NO_FILE });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('textarea')!.value).toBe(`Draft ${XSS} you`);
    expect(host.querySelector('.desc-hints')!.textContent).toContain('you');
    expect(host.querySelector('[data-conflict]')).toBeNull();
    expect([...host.querySelectorAll('button')].map(b => b.dataset.action)).toEqual(['save', 'cancel', 'clear']);
  });

  it('shows the server’s text beside a draft whose save it refused, escaped', () => {
    const host = document.createElement('div');
    host.innerHTML = rowHtml(row, {
      canEdit: true,
      editing: true,
      draft: 'My draft.',
      conflict: { ...live('w_x', `Theirs ${XSS}`, 'live'), updatedAt: '2026-11-17T09:30:00.000Z' },
      ctx: NO_FILE,
    });
    const conflict = host.querySelector('[data-conflict]')!;
    expect(conflict.querySelector('img')).toBeNull();
    expect(conflict.textContent).toContain('Not saved');
    expect(conflict.textContent).toContain(`Theirs ${XSS}`);
    expect(conflict.textContent).toContain('saved 2026-11-17 09:30 UTC, live edit');
    expect(host.querySelector('textarea')!.value).toBe('My draft.');

    host.innerHTML = rowHtml(row, { canEdit: true, editing: true, draft: 'My draft.', conflict: null, ctx: NO_FILE });
    expect(host.querySelector('[data-conflict]')!.textContent).toContain('The synced row is gone');
  });
});

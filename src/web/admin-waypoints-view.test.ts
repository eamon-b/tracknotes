import { describe, expect, it } from 'vitest';
import type { EditorWaypoint } from '../../scripts/lib/waypoint-editor/api-types';
import {
  compareWaypoints,
  deleteConfirmText,
  descriptionField,
  dotStyle,
  dotTooltipHtml,
  draftChanges,
  draftOf,
  hasCuratedText,
  isInMerge,
  isReviewed,
  knownCommentIds,
  matchesFilter,
  mergeCommentsNote,
  mergeMetaHtml,
  nearbyPois,
  parseLatLon,
  reviewFingerprint,
  rowHtml,
  typeOptionsHtml,
  voiceHints,
} from './admin-waypoints-view';

function waypoint(extra: Partial<EditorWaypoint> = {}): EditorWaypoint {
  return {
    id: 'w_1',
    name: 'Upper Hut',
    type: 'hut',
    builtType: 'hut',
    lat: -36.5,
    lon: 148.25,
    builtLat: -36.5,
    builtLon: 148.25,
    builtName: 'Upper Hut',
    placements: [{ kind: 'main', km: 4 }],
    sortKm: 4,
    description: '',
    canMove: true,
    canRename: true,
    canDescribe: true,
    canChangeType: true,
    canDelete: true,
    ...extra,
  };
}

/** A duplicate the build merged into `w_1` (the default waypoint), 95 m from it. */
function merged(extra: Partial<EditorWaypoint> = {}): EditorWaypoint {
  return waypoint({
    id: 'w_2',
    lat: -36.50085,
    builtLat: -36.50085,
    placements: [],
    mergedInto: 'w_1',
    mergedDistanceM: 94.6,
    canMove: false,
    canDescribe: false,
    canChangeType: false,
    ...extra,
  });
}

describe('merged near-duplicates', () => {
  const survivor = waypoint({ mergedIds: ['w_2', 'w_9'] });
  const duplicate = merged();
  const byId = new Map([survivor, duplicate].map(w => [w.id, w]));
  const marks = {};
  const row = { selected: false, dirty: false, reviewed: false };

  it('badges a merged-away duplicate and the waypoint it merged into, and filters to both', () => {
    const html = rowHtml(duplicate, row);
    expect(html).toContain('wpe-badge-merged"');
    expect(html).toContain('merged it into w_1');
    // It is in no list and takes no text of its own: neither is said of it.
    expect(html).not.toContain('off route');
    expect(html).not.toContain('no text');
    expect(rowHtml(merged({ unmerges: true }), row)).toContain('the next build lists it on its own');
    expect(rowHtml(merged({ deleted: true }), row)).not.toContain('wpe-badge-merged');
    expect(rowHtml(survivor, row)).toContain('+2 merged');
    expect(rowHtml(waypoint({ mergedIds: ['<i>'] }), row)).not.toContain('<i>');

    const filter = { query: '', type: '', status: 'merged' } as const;
    expect([duplicate, survivor, waypoint()].map(w => matchesFilter(w, filter, marks))).toEqual([true, true, false]);
    expect(matchesFilter(duplicate, { query: '', type: '', status: 'no-text' }, marks)).toBe(false);
    expect(matchesFilter(duplicate, { query: '', type: '', status: 'off-route' }, marks)).toBe(false);
    expect(isInMerge(waypoint())).toBe(false);
  });

  it('says in the form which waypoint it merged into and how far apart they are, escaped', () => {
    const html = mergeMetaHtml(duplicate, byId);
    expect(html).toContain('Merged by the last build into “Upper Hut”');
    expect(html).toContain('data-goto="w_1"');
    expect(html).toContain(', 95 m away: no row in the app');
    expect(mergeMetaHtml(merged({ unmerges: true }), byId)).toContain('the next build lists it on its own');
    const hostile = waypoint({ name: '<b>x</b>' });
    expect(mergeMetaHtml(merged({ mergedInto: '"><i>' }), new Map([['"><i>', hostile]]))).not.toMatch(/<b>|<i>/);

    // On the survivor: each id merged into it, linked when it has a row here.
    const into = mergeMetaHtml(survivor, byId);
    expect(into).toContain('The last build merged into it:');
    expect(into).toContain('data-goto="w_2"');
    expect(into).toContain('(95 m away)');
    expect(into).toContain('<code>w_9</code>');
    expect(into).not.toContain('data-goto="w_9"');
    expect(mergeMetaHtml(waypoint(), byId)).toBe('');

    // Its description box never claims the app shows its source text: the survivor's row does.
    const field = descriptionField(merged({ sourceDescription: 'A tank.' }));
    expect(field.placeholder).toMatch(/takes no description of its own/);
    expect(field.sourceSummary).toMatch(/appends it to the description of the waypoint it merged into/);
    expect(descriptionField(merged({ unmerges: true })).placeholder).toMatch(/until a rebuild/);
  });

  it('never reports a merged-away id as lost, and says the app shows none of its comments', () => {
    expect([...knownCommentIds([survivor, duplicate])].sort()).toEqual(['w_1', 'w_2', 'w_9']);
    const counts = new Map([
      ['w_2', 2],
      ['w_9', 1],
    ]);
    expect(mergeCommentsNote(duplicate, byId, counts)).toMatch(
      /The app does not show these.*merged this waypoint into “Upper Hut” \(w_1\)/
    );
    expect(mergeCommentsNote(duplicate, byId, new Map())).toBeUndefined();
    expect(mergeCommentsNote(survivor, byId, counts)).toMatch(/3 more comments are filed under w_2, w_9/);
    expect(mergeCommentsNote(survivor, byId, new Map([['w_9', 1]]))).toMatch(/1 more comment is filed under w_9/);
    expect(mergeCommentsNote(waypoint(), byId, counts)).toBeUndefined();
  });

  it('draws it apart from built and pending waypoints on the map', () => {
    const [built, pending, away] = [waypoint(), waypoint({ pending: true }), duplicate].map(w =>
      dotStyle(w, '#123456')
    );
    expect(built).toMatchObject({ fillColor: '#123456', color: '#ffffff', dashArray: undefined, fillOpacity: 1 });
    expect(pending).toMatchObject({ fillColor: '#123456', color: '#222222', dashArray: '2 2' });
    expect(away).toMatchObject({ fillColor: '#ffffff', color: '#123456', dashArray: '1 4' });
    expect(away.radius).toBeLessThan(built.radius);
    expect(dotTooltipHtml(duplicate)).toContain('merged into w_1');
    expect(dotTooltipHtml(waypoint({ name: '<img>' }))).not.toContain('<img>');
  });
});

describe('parseLatLon', () => {
  it('reads plain pairs and the usual map links', () => {
    expect(parseLatLon('-36.1234, 148.5678')).toEqual({ lat: -36.1234, lon: 148.5678 });
    expect(parseLatLon('-36.1234 148.5678')).toEqual({ lat: -36.1234, lon: 148.5678 });
    expect(parseLatLon('https://www.google.com/maps/@-33.837,151.1765,17z')).toEqual({ lat: -33.837, lon: 151.1765 });
    expect(parseLatLon('https://www.google.com/maps/search/?api=1&query=-33.8,151.2')).toEqual({
      lat: -33.8,
      lon: 151.2,
    });
    expect(parseLatLon('https://www.openstreetmap.org/#map=17/-36.5/148.25')).toEqual({ lat: -36.5, lon: 148.25 });
    expect(parseLatLon('https://www.openstreetmap.org/?mlat=-36.5&mlon=148.25')).toEqual({ lat: -36.5, lon: 148.25 });
  });

  it('refuses what is not a position', () => {
    expect(parseLatLon('Upper Hut')).toBeNull();
    expect(parseLatLon('95, 10')).toBeNull();
    expect(parseLatLon('')).toBeNull();
  });
});

describe('voiceHints', () => {
  it('flags addressing and instructing the walker', () => {
    const matches = voiceHints('You should treat the water. Treat it.').map(h => h.match);
    expect(matches).toEqual(expect.arrayContaining(['You', 'should', 'Treat']));
  });

  it('leaves the house voice alone', () => {
    expect(voiceHints('A tank beside the hut, filled from the roof. The creek below is untreated.')).toEqual([]);
  });

  it('notices a missing full stop and doubled spaces', () => {
    expect(voiceHints('A hut.  With a tank').map(h => h.match)).toEqual(['double space', 'ending']);
  });
});

describe('drafts, filters and review marks', () => {
  it('compares a draft with the saved waypoint, ignoring surrounding space', () => {
    const w = waypoint({ description: 'A hut.' });
    expect(draftChanges(w, { ...draftOf(w), description: ' A hut. ' })).toEqual({
      name: false,
      position: false,
      description: false,
      type: false,
    });
    expect(draftChanges(w, { ...draftOf(w), lat: -36.501 }).position).toBe(true);
    expect(draftChanges(w, { ...draftOf(w), type: 'campsite' }).type).toBe(true);
  });

  it('filters by status, type and name or id', () => {
    const marks = {};
    const w = waypoint();
    expect(matchesFilter(w, { query: '', type: '', status: 'no-text' }, marks)).toBe(true);
    expect(matchesFilter(w, { query: 'upper', type: 'hut', status: 'all' }, marks)).toBe(true);
    expect(matchesFilter(w, { query: 'w_1', type: '', status: 'all' }, marks)).toBe(true);
    expect(matchesFilter(w, { query: '', type: 'water', status: 'all' }, marks)).toBe(false);
    expect(matchesFilter(waypoint({ lat: -36.6 }), { query: '', type: '', status: 'changed' }, marks)).toBe(true);
    expect(matchesFilter(waypoint({ type: 'campsite' }), { query: '', type: '', status: 'changed' }, marks)).toBe(true);
    expect(matchesFilter(waypoint(), { query: '', type: '', status: 'pending' }, marks)).toBe(false);
    expect(matchesFilter(waypoint({ pending: true }), { query: '', type: '', status: 'pending' }, marks)).toBe(true);
    expect(
      matchesFilter(
        waypoint({ placements: [{ kind: 'off-trail' }] }),
        { query: '', type: '', status: 'off-route' },
        marks
      )
    ).toBe(true);
    const hasComments = { query: '', type: '', status: 'has-comments' } as const;
    expect(matchesFilter(w, hasComments, marks)).toBe(false);
    expect(matchesFilter(w, hasComments, marks, new Map([['w_1', 2]]))).toBe(true);
  });

  it("never counts a pending waypoint's <desc> as curated text, and says where its description is saved", () => {
    const pending = waypoint({ id: 'new:abc', pending: true, description: 'A tank.' });
    const marks = {};
    expect(hasCuratedText(pending)).toBe(false);
    expect(hasCuratedText(waypoint({ description: 'A hut.' }))).toBe(true);
    expect(matchesFilter(pending, { query: '', type: '', status: 'no-text' }, marks)).toBe(true);
    expect(matchesFilter(pending, { query: '', type: '', status: 'has-text' }, marks)).toBe(false);

    const field = descriptionField(pending);
    expect(field.label).toMatch(/GPX <desc>/);
    expect(field.where).toMatch(/not curated text/);
    expect(field.where).toMatch(/descriptions\.json/);
    expect(field.removeConfirm).toMatch(/<desc>/);
    const curated = descriptionField(waypoint({ sourceDescription: 'From the GPX.' }));
    expect(curated).toMatchObject({ label: 'Description', where: '' });
    expect(curated.placeholder).toMatch(/source text below/);
    expect(curated.removeConfirm).toMatch(/curated description/);
  });

  it('orders the list by km, then name', () => {
    const rows = [waypoint({ name: 'B', sortKm: 4 }), waypoint({ name: 'A', sortKm: 4 }), waypoint({ sortKm: 1 })];
    expect(rows.sort(compareWaypoints).map(w => [w.sortKm, w.name])).toEqual([
      [1, 'Upper Hut'],
      [4, 'A'],
      [4, 'B'],
    ]);
  });

  it('lets a review mark lapse when the content changes', () => {
    const w = waypoint();
    const marks = { [w.id]: reviewFingerprint(w) };
    expect(isReviewed(marks, w)).toBe(true);
    expect(isReviewed(marks, { ...w, description: 'Edited elsewhere.' })).toBe(false);
  });
});

describe('markup', () => {
  it('escapes names in the list', () => {
    const html = rowHtml(waypoint({ name: '<img src=x onerror=alert(1)>' }), {
      selected: true,
      dirty: true,
      reviewed: false,
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('unsaved');
    expect(html).not.toContain('comment');
    expect(rowHtml(waypoint(), { selected: false, dirty: false, reviewed: false, comments: 2 })).toContain(
      '2 comments'
    );
  });

  it('marks a pending waypoint, and offers the classifier types plus a foreign current one, escaped', () => {
    const html = rowHtml(waypoint({ id: 'new:abc', pending: true }), {
      selected: false,
      dirty: false,
      reviewed: false,
    });
    expect(html).toContain('pending rebuild');
    expect(html).not.toContain('no text');
    const options = typeOptionsHtml('<b>x</b>');
    expect(options.startsWith('<option value="&lt;b&gt;x&lt;/b&gt;">')).toBe(true);
    expect(options).toContain('<option value="water-tank">Water tank (water-tank)</option>');
    expect(typeOptionsHtml('hut').match(/value="hut"/g)).toHaveLength(1);
  });

  it('says in the delete confirmation that the id is retired and its comments orphaned', () => {
    const text = deleteConfirmText(waypoint({ sharesSourceWith: ['w_1_2'] }));
    expect(text).toMatch(/retired/);
    expect(text).toMatch(/Comments keyed to w_1 are orphaned/);
    expect(text).toMatch(/Also deletes w_1_2/);
    expect(deleteConfirmText(waypoint({ pending: true }))).toMatch(/no id yet/);
  });

  it('says what is true of a merged-away duplicate when deleting it, and of the waypoint it merged into', () => {
    const duplicate = merged();
    const text = deleteConfirmText(duplicate, 2);
    expect(text).toMatch(/Delete the merged duplicate “Upper Hut” \(w_2\)/);
    expect(text).toMatch(/merged it into “Upper Hut” \(w_1\), 95 m away, so the app shows no row for it/);
    expect(text).toMatch(/marks the id retired/);
    // Its comments were never shown, so they are not newly orphaned.
    expect(text).toMatch(/Comments keyed to w_2 are already out of sight/);
    expect(text).not.toMatch(/orphaned/);
    expect(text).toMatch(/It has 2 comments: read them in the form first/);
    expect(deleteConfirmText(duplicate)).not.toMatch(/It has/);
    expect(deleteConfirmText(merged({ sourceDescription: 'A tank.' }))).toMatch(/appended its description/);

    const survivor = deleteConfirmText(waypoint({ mergedIds: ['w_2'] }));
    expect(survivor).toMatch(/Comments keyed to w_1 are orphaned/);
    expect(survivor).toMatch(/The build merged w_2 into it: that <wpt> stays/);
    expect(survivor).toMatch(/a row of its own, under its own id/);
    expect(survivor).toMatch(/Comments keyed to w_1 do not move to it/);
    expect(deleteConfirmText(waypoint({ mergedIds: ['w_2', 'w_3'] }))).toMatch(
      /rows of their own, under their own ids/
    );
  });

  it('lists nearby POIs nearest first, within the radius', () => {
    const pois = [
      { id: 'node/1', name: 'Far', category: 'water', lat: -36.51, lon: 148.25 },
      { id: 'node/2', name: 'Near', category: 'water', lat: -36.5001, lon: 148.25 },
    ];
    expect(nearbyPois(pois, { lat: -36.5, lon: 148.25 }, 400).map(p => p.name)).toEqual(['Near']);
  });
});

import { describe, expect, it } from 'vitest';
import type { EditorWaypoint } from '../../scripts/lib/waypoint-editor/api-types';
import {
  compareWaypoints,
  deleteConfirmText,
  descriptionField,
  dotStyle,
  dotTooltipHtml,
  draftAfterSave,
  draftChanges,
  draftValues,
  formatDistance,
  hasCuratedText,
  isDirty,
  isInMerge,
  isReviewable,
  isReviewed,
  knownCommentIds,
  laterPassOf,
  matchesFilter,
  mergeCommentsNote,
  mergeMetaHtml,
  nearbyPois,
  nearestLineSnap,
  parseCoordinate,
  parseLatLon,
  positionReadout,
  pruneDraft,
  readoutText,
  reviewFingerprint,
  routeLines,
  rowContentHtml,
  rowHtml,
  saveAffectsOtherRows,
  saveNotes,
  sharedSourceText,
  stepTarget,
  takesIdMetaHtml,
  typeOptionsHtml,
  typePrefixProblem,
  variantLabel,
  voiceHints,
  type ReviewMarks,
  type WaypointFilter,
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

  it("reads a Google Maps place link from its pin, not the view's centre", () => {
    const link =
      'https://www.google.com/maps/place/Lobuche/@27.9512,86.8034,14z/data=!3m1!4b1!4m6!3m5!1s0x39e9:0x1!8m2!3d27.9481!4d86.8102!16s%2Fg%2F1';
    expect(parseLatLon(link)).toEqual({ lat: 27.9481, lon: 86.8102 });
    // No pin: the centre is all there is.
    expect(parseLatLon('https://www.google.com/maps/@27.9512,86.8034,14z')).toEqual({ lat: 27.9512, lon: 86.8034 });
  });

  it('does not read a position typed by hand until it is whole', () => {
    // The page applies the box on a paste, Enter or blur, never per keystroke: every prefix
    // from the first digit of the longitude on parses as a (wrong) position.
    expect(parseLatLon('27.6901, 8')).toEqual({ lat: 27.6901, lon: 8 });
    expect(parseLatLon('27.6901, 86.7215')).toEqual({ lat: 27.6901, lon: 86.7215 });
  });
});

describe('parseCoordinate', () => {
  it('reads a decimal within its range', () => {
    expect(parseCoordinate(' -36.1234 ', 90)).toBe(-36.1234);
    expect(parseCoordinate('148', 180)).toBe(148);
    expect(parseCoordinate('+27.5', 90)).toBe(27.5);
    expect(parseCoordinate('\u221236.5', 90)).toBe(-36.5);
    expect(parseCoordinate('0', 90)).toBe(0);
  });

  it('never reads an empty or unparsable field as 0, or a value out of range', () => {
    // Number('') and Number(' ') are 0, which is a place off West Africa.
    expect(parseCoordinate('', 90)).toBeNull();
    expect(parseCoordinate('   ', 180)).toBeNull();
    expect(parseCoordinate('abc', 90)).toBeNull();
    expect(parseCoordinate('27.6, 86.7', 90)).toBeNull();
    expect(parseCoordinate('1e2', 180)).toBeNull();
    expect(parseCoordinate('-', 90)).toBeNull();
    expect(parseCoordinate('91', 90)).toBeNull();
    expect(parseCoordinate('148.5', 90)).toBeNull();
    expect(parseCoordinate('-180.1', 180)).toBeNull();
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
    expect(draftChanges(w, { description: ' A hut. ' })).toEqual({
      name: false,
      position: false,
      description: false,
      type: false,
    });
    expect(draftChanges(w, { lat: -36.501, lon: w.lon }).position).toBe(true);
    expect(draftChanges(w, { type: 'campsite' }).type).toBe(true);
    expect(draftChanges(w, undefined)).toEqual({ name: false, position: false, description: false, type: false });
    expect(isDirty(w, undefined)).toBe(false);
    expect(isDirty(w, { name: 'Upper Hut ' })).toBe(false);
    expect(isDirty(w, { name: 'Lower Hut' })).toBe(true);
  });

  it('keeps in a draft only the fields that were changed', () => {
    const w = waypoint({ description: 'A hut.' });
    expect(draftValues(w, { description: 'A hut with a tank.' })).toEqual({
      name: 'Upper Hut',
      lat: -36.5,
      lon: 148.25,
      description: 'A hut with a tank.',
      type: 'hut',
    });
    // Every field the form holds, of which one differs: only that one is the draft.
    const whole = { name: 'Upper Hut', lat: -36.5, lon: 148.25, description: 'A hut with a tank.', type: 'hut' };
    expect(pruneDraft(w, whole)).toEqual({ description: 'A hut with a tank.' });
    // A position is kept whole, even when one coordinate is as saved.
    expect(pruneDraft(w, { ...whole, lat: -36.6 })).toEqual({
      lat: -36.6,
      lon: 148.25,
      description: 'A hut with a tank.',
    });
    expect(pruneDraft(w, { name: 'Upper Hut', description: ' A hut. ' })).toBeUndefined();
    expect(pruneDraft(w, undefined)).toBeUndefined();
  });

  it('lets untouched fields follow the server when the trail is read again', () => {
    // A description-only draft, then the sources change under the page (a rebuild, a pull, a save of another pass).
    const draft = pruneDraft(waypoint(), { description: 'A hut.' });
    const reloaded = waypoint({ name: 'Upper Hut (new)', lat: -36.6, type: 'campsite' });
    const rebased = pruneDraft(reloaded, draft);
    expect(rebased).toEqual({ description: 'A hut.' });
    // The old name, position and type are not edits: a save sends the description alone.
    expect(draftChanges(reloaded, rebased)).toEqual({ name: false, position: false, description: true, type: false });
    expect(draftValues(reloaded, rebased)).toMatchObject({ name: 'Upper Hut (new)', lat: -36.6, type: 'campsite' });
    // An edit the sources have caught up with is no longer one.
    expect(pruneDraft(waypoint({ description: 'A hut.' }), draft)).toBeUndefined();
  });

  it('keeps what was typed during a save as a new draft on the saved state', () => {
    const before = waypoint();
    const sent = { description: 'A hut.' };
    const after = waypoint({ description: 'A hut.' });
    // Nothing typed since: the draft is spent.
    expect(draftAfterSave(before, after, sent, sent)).toBeUndefined();
    // More text typed while the save was in flight.
    expect(draftAfterSave(before, after, sent, { description: 'A hut. With a tank.' })).toEqual({
      description: 'A hut. With a tank.',
    });
    // Another field edited meanwhile: only that one is left to save.
    expect(draftAfterSave(before, after, sent, { description: 'A hut.', name: 'Lower Hut' })).toEqual({
      name: 'Lower Hut',
    });
    // The sent text taken back out during the save: an edit against what is now saved.
    expect(draftAfterSave(before, after, sent, undefined)).toEqual({ description: '' });
    // What the server made of the sent value (trimmed, rounded) is followed, not fought.
    const moved = { lat: -36.6000004, lon: 148.25 };
    expect(draftAfterSave(before, waypoint({ lat: -36.6 }), moved, moved)).toBeUndefined();
    expect(draftAfterSave(before, after, { description: 'A hut. ' }, { description: 'A hut. ' })).toBeUndefined();
  });

  it('knows which saves can change other rows, and names the waypoint in notes shown elsewhere', () => {
    const plain = waypoint();
    expect(saveAffectsOtherRows(plain, plain)).toBe(false);
    expect(saveAffectsOtherRows(waypoint({ sharesSourceWith: ['w_1_2'] }), plain)).toBe(true);
    expect(saveAffectsOtherRows(plain, waypoint({ mergedIds: ['w_2'] }))).toBe(true);
    expect(saveAffectsOtherRows(merged(), merged())).toBe(true);

    const result = { waypoint: { name: 'Upper Hut' }, changedFiles: ['a.gpx', 'b.json'], notes: ['Moved 12 m.'] };
    expect(saveNotes(result, true)).toEqual(['Saved to a.gpx, b.json.', 'Moved 12 m.']);
    expect(saveNotes(result, false)).toEqual(['Saved “Upper Hut” to a.gpx, b.json.', '“Upper Hut”: Moved 12 m.']);
    expect(saveNotes({ ...result, changedFiles: [], notes: [] }, true)).toEqual([
      'Saved to no file (nothing changed).',
    ]);
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
    // Its CalTopo marker has a description, which the build shows instead: the box is locked, and says so.
    const locked = descriptionField({ ...pending, canDescribe: false, sourceDescription: 'Town.' });
    expect(locked.where).toMatch(/Read-only until a rebuild/);
    expect(locked.where).not.toMatch(/it is saved as/);
    const curated = descriptionField(waypoint({ sourceDescription: 'From the GPX.' }));
    expect(curated).toMatchObject({ label: 'Description', where: '' });
    expect(curated.placeholder).toMatch(/source text below/);
    expect(curated.removeConfirm).toMatch(/curated description/);
  });

  it('lists a waypoint the last build does not have as locked work for a rebuild, never as text or review to do', () => {
    const unbuilt = waypoint({
      id: 'w_9',
      notBuilt: true,
      placements: [],
      canMove: false,
      canRename: false,
      canDescribe: false,
      canChangeType: false,
      canDelete: false,
    });
    const marks = {};
    const status = (s: WaypointFilter['status']) => matchesFilter(unbuilt, { query: '', type: '', status: s }, marks);
    expect(status('changed')).toBe(true);
    expect(status('no-text')).toBe(false);
    expect(status('off-route')).toBe(false);
    expect(status('pending')).toBe(false);
    expect(isReviewable(unbuilt)).toBe(false);
    expect(isReviewable(waypoint({ id: 'new:abc', pending: true }))).toBe(false);
    expect(isReviewable(waypoint())).toBe(true);
    expect(isReviewable(waypoint({ deleted: true }))).toBe(true);

    const row = rowHtml(unbuilt, { selected: false, dirty: false, reviewed: false });
    expect(row).toContain('>not built<');
    expect(row).toContain('locked until a rebuild');
    expect(row).not.toContain('no text');
    expect(row).not.toContain('off route');
    expect(row).not.toContain('>saved<');
  });

  it('tells a later pass of a revisited place from an id that only ends in digits', () => {
    expect(laterPassOf('w_07233ee1_2')).toBe('w_07233ee1');
    expect(laterPassOf('w_07233ee1_12')).toBe('w_07233ee1');
    expect(laterPassOf('w_07233ee1')).toBeNull();
    // All digits after the one underscore is a whole id, not pass 176641 of "w".
    expect(laterPassOf('w_00176641')).toBeNull();
    expect(laterPassOf('new:0123456789')).toBeNull();
  });

  it("shows a later pass's description as the place's, read-only, and says where to edit it", () => {
    const pass = waypoint({
      id: 'w_07233ee1_2',
      description: 'Lodges and a bakery.',
      canDescribe: false,
      canDelete: false,
      sharesSourceWith: ['w_07233ee1'],
    });
    const field = descriptionField(pass);
    expect(field.label).toMatch(/read-only/);
    expect(field.where).toMatch(/later pass of w_07233ee1\b/);
    expect(field.where).toMatch(/edit it on w_07233ee1\./);
    expect(field.placeholder).toMatch(/w_07233ee1/);
    // The first pass is described as usual; a locked row that is not a later pass says nothing extra.
    expect(descriptionField(waypoint({ id: 'w_07233ee1', sharesSourceWith: ['w_07233ee1_2'] })).where).toBe('');
    expect(descriptionField(waypoint({ id: 'w_00176641', canDescribe: false })).where).toBe('');

    // Either pass: what is done to the <wpt> is done to the place.
    for (const w of [pass, waypoint({ id: 'w_07233ee1', sharesSourceWith: ['w_07233ee1_2'] })]) {
      const text = sharedSourceText(w);
      expect(text).toMatch(/a move, a rename or a type change/);
      expect(text).toMatch(/every pass/);
      expect(text).toContain(w.sharesSourceWith![0]);
    }
    expect(sharedSourceText(waypoint())).toBe('');
  });

  it("catches a new waypoint's type prefix before it is sent, as the server would refuse it", () => {
    expect(typePrefixProblem('Mount Solitary')).toBeNull();
    expect(typePrefixProblem('  ')).toBeNull();
    // A known town is typed by its name, but shown as typed.
    expect(typePrefixProblem('Thredbo')).toBeNull();
    const problem = typePrefixProblem(' C Camp Thing ');
    expect(problem).toMatch(/type prefix “C ”/);
    expect(problem).toMatch(/would show “Camp Thing”/);
    expect(typePrefixProblem('WT: Tank')).toMatch(/“Tank”/);
  });

  it('steps to the next row from the place in the whole list, in or out of the filter', () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map(id => waypoint({ id }));
    const every = () => true;
    expect(stepTarget(all, every, 'b', 1)).toBe('c');
    expect(stepTarget(all, every, 'b', -1)).toBe('a');
    // The ends: nowhere to go.
    expect(stepTarget(all, every, 'e', 1)).toBeNull();
    expect(stepTarget(all, every, 'a', -1)).toBeNull();
    // Nothing selected (or an id the list no longer has): the first row.
    expect(stepTarget(all, every, null, 1)).toBe('a');
    expect(stepTarget(all, every, 'gone', -1)).toBe('a');
    expect(stepTarget([], every, null, 1)).toBeNull();

    // "Not reviewed", with b just marked reviewed: b has left the filtered list,
    // and the next row is still the one after it, not the top of the list.
    const marks: ReviewMarks = { b: reviewFingerprint(all[1]), d: reviewFingerprint(all[3]) };
    const filter: WaypointFilter = { query: '', type: '', status: 'unreviewed' };
    const unreviewed = (w: (typeof all)[number]) => matchesFilter(w, filter, marks);
    expect(all.filter(unreviewed).map(w => w.id)).toEqual(['a', 'c', 'e']);
    expect(stepTarget(all, unreviewed, 'b', 1)).toBe('c');
    expect(stepTarget(all, unreviewed, 'b', -1)).toBe('a');
    // Rows the filter hides are stepped over.
    expect(stepTarget(all, unreviewed, 'c', 1)).toBe('e');
    expect(stepTarget(all, unreviewed, 'e', -1)).toBe('c');
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
    // It has no placements yet, which is not the same as being off the route.
    const unplaced = waypoint({ id: 'new:abc', pending: true, placements: [] });
    const unplacedRow = rowHtml(unplaced, { selected: false, dirty: false, reviewed: false });
    expect(unplacedRow).not.toContain('off route');
    expect(unplacedRow).toContain('come from that build');
    expect(matchesFilter(unplaced, { query: '', type: '', status: 'off-route' }, {})).toBe(false);
    expect(rowHtml(waypoint({ placements: [] }), { selected: false, dirty: false, reviewed: false })).toContain(
      'off route'
    );
    // One the next build hands an existing id says so: on the badge, and in the form with a link to that row.
    const taking = waypoint({ id: 'new:abc', pending: true, takesId: 'w_5aaaaf44', name: 'Leadore <b>' });
    const takingRow = rowHtml(taking, { selected: false, dirty: false, reviewed: false });
    expect(takingRow).toContain('pending rebuild → w_5aaaaf44');
    expect(takingRow).toContain('gives it the id w_5aaaaf44');
    expect(unplacedRow).not.toContain('→');
    const owner = waypoint({ id: 'w_5aaaaf44', name: 'Leadore <i>', deleted: true });
    const withOwner = takesIdMetaHtml(taking, new Map([[owner.id, owner]]));
    expect(withOwner).toContain('data-goto="w_5aaaaf44"');
    expect(withOwner).toContain('of “Leadore &lt;i&gt;”');
    expect(withOwner).toMatch(/in place of minting one/);
    // A retired entry coming back has no row to link to.
    const alone = takesIdMetaHtml(taking, new Map());
    expect(alone).toContain('<code>w_5aaaaf44</code>');
    expect(alone).not.toContain('data-goto');
    expect(takesIdMetaHtml(unplaced, new Map())).toBe('');
    expect(takesIdMetaHtml(waypoint({ takesId: 'w_x' }), new Map())).toBe('');
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

  it('renders a row and its content apart, so one row can be updated in place', () => {
    const state = { selected: true, dirty: true, reviewed: true, comments: 1 };
    const content = rowContentHtml(waypoint(), state);
    expect(content.startsWith('<span class="wpe-row-km">')).toBe(true);
    expect(content).toContain('unsaved');
    const row = rowHtml(waypoint(), state);
    expect(row).toBe(
      `<li class="wpe-row is-selected" data-id="w_1" role="option" aria-selected="true" tabindex="-1">${content}</li>`
    );
  });

  it('formats a distance in metres under a kilometre and kilometres above', () => {
    expect(formatDistance(0.4)).toBe('0 m');
    expect(formatDistance(412.6)).toBe('413 m');
    expect(formatDistance(999.6)).toBe('1.00 km');
    // Thodung on the Three Passes: 1125 m, not "1125000 m".
    expect(formatDistance(1125)).toBe('1.13 km');
    expect(formatDistance(25340)).toBe('25.3 km');
  });

  it('lists nearby POIs nearest first, within the radius', () => {
    const pois = [
      { id: 'node/1', name: 'Far', category: 'water', lat: -36.51, lon: 148.25 },
      { id: 'node/2', name: 'Near', category: 'water', lat: -36.5001, lon: 148.25 },
    ];
    expect(nearbyPois(pois, { lat: -36.5, lon: 148.25 }, 400).map(p => p.name)).toEqual(['Near']);
  });
});

describe("the route's lines", () => {
  // A main route running south along lon 148, with a break (a ferry) between its 2nd and 3rd points,
  // and a side trip leaving it eastwards at lat -36.01.
  const track = {
    points: [
      { lat: -36.0, lon: 148.0, dist: 0 },
      { lat: -36.02, lon: 148.0, dist: 2.2 },
      { lat: -36.1, lon: 148.0, dist: 2.2 },
      { lat: -36.12, lon: 148.0, dist: 4.4 },
    ],
    breaks: undefined,
    variants: [
      {
        name: 'Side trip: Lookout',
        type: 'side-trip',
        line: [
          [-36.01, 148.0],
          [-36.01, 148.02],
        ] as [number, number][],
      },
    ],
  };
  const lines = routeLines(track, new Set([2]));

  it('names a variant without repeating a kind its name opens with', () => {
    expect(variantLabel({ name: 'Side trip: Deurali > Thodung', type: 'side-trip' })).toBe(
      'side trip “Deurali > Thodung”'
    );
    expect(variantLabel({ name: 'Alternative: Khunde high route', type: 'alternate' })).toBe(
      'alternate “Khunde high route”'
    );
    expect(variantLabel({ name: 'Mt Bogong', type: 'side-trip' })).toBe('side trip “Mt Bogong”');
    expect(lines.map(l => l.label)).toEqual([null, 'side trip “Lookout”']);
    expect(lines[1].points[1].dist).toBeCloseTo(1.8, 1);
  });

  it('snaps to the nearest line, the main route or a variant', () => {
    // 1 km out along the side trip, a few metres off it: nearest is the side trip, not the main route.
    const out = nearestLineSnap(lines, -36.0101, 148.011);
    expect(out.nearest?.label).toBe('side trip “Lookout”');
    expect(out.nearest?.lat).toBeCloseTo(-36.01, 6);
    expect(out.nearest?.lon).toBeCloseTo(148.011, 4);
    expect(out.nearest?.offM).toBeLessThan(15);
    expect(out.main?.label).toBeNull();
    expect(out.main?.lon).toBeCloseTo(148.0, 6);
    expect(out.main?.offM).toBeGreaterThan(900);

    // Beside the main route, away from the side trip: the main route.
    const beside = nearestLineSnap(lines, -36.11, 148.0005);
    expect(beside.nearest?.label).toBeNull();
    expect(beside.nearest?.lat).toBeCloseTo(-36.11, 4);
    expect(beside.nearest?.lon).toBeCloseTo(148.0, 6);
    expect(beside.nearest?.km).toBeCloseTo(3.3, 1);
    expect(nearestLineSnap([], -36, 148)).toEqual({ main: null, nearest: null });
  });

  it('never snaps onto the straight line of a route break', () => {
    // Halfway across the break: the nearest trail is one of its two landings, not the line between them.
    const { nearest } = nearestLineSnap(lines, -36.06, 148.0);
    expect([-36.02, -36.1]).toContain(nearest?.lat);
    expect(nearest?.offM).toBeGreaterThan(4000);
    // Without the break the same position would sit on the line.
    expect(nearestLineSnap(routeLines(track, new Set()), -36.06, 148.0).nearest?.offM).toBeLessThan(1);
  });

  it('says in the readout which line it measured to', () => {
    expect(readoutText({ km: 17.186, offRouteM: 4.4, movedM: 0 })).toBe(
      'nearest main route km 17.19 · 4 m from the main route'
    );
    expect(
      readoutText({
        km: 17.19,
        offRouteM: 1125,
        nearer: { label: 'side trip “Deurali > Thodung”', offM: 3 },
        movedM: 12.4,
      })
    ).toBe(
      '3 m from side trip “Deurali > Thodung” · 1.13 km from the main route (nearest at km 17.19) · moved 12 m from the saved position'
    );
    expect(positionReadout(lines, -36.0101, 148.011, 0)).toMatch(
      /^\d+ m from side trip “Lookout” · \d+ m from the main route \(nearest at km 1\.\d\d\)$/
    );
    expect(positionReadout(lines, -36.11, 148.0005, 2500)).toMatch(
      /^nearest main route km 3\.\d\d · \d+ m from the main route · moved 2\.50 km from the saved position$/
    );
    expect(positionReadout([], -36, 148, 0)).toBe('');
  });
});

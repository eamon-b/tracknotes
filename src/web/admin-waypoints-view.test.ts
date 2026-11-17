import { describe, expect, it } from 'vitest';
import type { EditorWaypoint } from '../../scripts/lib/waypoint-editor/api-types';
import {
  deleteConfirmText,
  draftChanges,
  draftOf,
  isReviewed,
  matchesFilter,
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

  it('lists nearby POIs nearest first, within the radius', () => {
    const pois = [
      { id: 'node/1', name: 'Far', category: 'water', lat: -36.51, lon: 148.25 },
      { id: 'node/2', name: 'Near', category: 'water', lat: -36.5001, lon: 148.25 },
    ];
    expect(nearbyPois(pois, { lat: -36.5, lon: 148.25 }, 400).map(p => p.name)).toEqual(['Near']);
  });
});

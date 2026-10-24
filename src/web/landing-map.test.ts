import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRouteSummary } from '@lib/community-types';
import {
  communityMapPoint,
  curatedMapPoint,
  isLatLon,
  landingMapPoints,
  mapPopupHtml,
  mapTooltipHtml,
  mountLandingMap,
  unwrapLongitudes,
  type LandingMapPoint,
} from './landing-map';

function route(over: Partial<CommunityRouteSummary>): CommunityRouteSummary {
  return {
    id: 'c_AAAAAAAAAAAAAAAA',
    name: 'Route',
    status: 'unverified',
    country: 'AU',
    state: 'VIC',
    lengthKm: 12,
    ascentM: 100,
    hasElevation: true,
    waypointCount: 0,
    bbox: [145, -38, 146, -37],
    start: { lat: -37.5, lon: 145.5 },
    submittedBy: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    verifiedAt: null,
    reviewed: false,
    trailUrl: 'https://example.test/x.json',
    md5: '0'.repeat(32),
    bytes: 10,
    ...over,
  };
}

describe('isLatLon', () => {
  it('accepts a position and rejects absent, non-finite, out-of-range and (0, 0)', () => {
    expect(isLatLon({ lat: -37.8, lon: 144.9 })).toBe(true);
    expect(isLatLon(undefined)).toBe(false);
    expect(isLatLon(null)).toBe(false);
    expect(isLatLon({ lat: NaN, lon: 1 })).toBe(false);
    expect(isLatLon({ lat: 91, lon: 1 })).toBe(false);
    expect(isLatLon({ lat: 1, lon: -181 })).toBe(false);
    expect(isLatLon({ lat: '1', lon: 1 })).toBe(false);
    expect(isLatLon({ lat: 0, lon: 0 })).toBe(false);
  });
});

describe('curatedMapPoint', () => {
  it('places a trail at its start and links to its page', () => {
    const p = curatedMapPoint({
      id: 'aawt',
      name: 'Australian Alps Walking Track',
      lengthKm: 688.3,
      country: 'AU',
      states: ['VIC', 'NSW'],
      start: { lat: -37.85, lon: 145.35 },
    });
    expect(p).toMatchObject({
      kind: 'curated',
      lat: -37.85,
      lon: 145.35,
      href: './trails/aawt/',
      place: 'Victoria, New South Wales, Australia',
    });
  });

  it('skips a trail whose index entry has no start (an older index)', () => {
    expect(curatedMapPoint({ id: 'x', name: 'X', lengthKm: 1 })).toBeNull();
    expect(curatedMapPoint({ id: 'x', name: 'X', lengthKm: 1, start: null })).toBeNull();
  });
});

describe('communityMapPoint', () => {
  it('places a route at its start, with its status as the kind', () => {
    expect(communityMapPoint(route({ status: 'verified' }))).toMatchObject({
      kind: 'verified',
      lat: -37.5,
      lon: 145.5,
      href: './community-route.html?id=c_AAAAAAAAAAAAAAAA',
      place: 'Victoria, Australia',
    });
    expect(communityMapPoint(route({}))!.kind).toBe('unverified');
  });

  it('falls back to the bbox centre, then leaves the route off the map', () => {
    const noStart = route({ start: undefined as unknown as CommunityRouteSummary['start'] });
    expect(communityMapPoint(noStart)).toMatchObject({ lat: -37.5, lon: 145.5 });
    const neither = route({
      start: undefined as unknown as CommunityRouteSummary['start'],
      bbox: undefined as unknown as CommunityRouteSummary['bbox'],
    });
    expect(communityMapPoint(neither)).toBeNull();
    // The worker's fallback for an unreadable bbox is all zeros.
    expect(communityMapPoint(route({ start: { lat: 0, lon: 0 }, bbox: [0, 0, 0, 0] }))).toBeNull();
  });
});

describe('landingMapPoints', () => {
  it('lists curated trails first and verified routes last, skipping unplaceable ones', () => {
    const points = landingMapPoints(
      [
        { id: 'a', name: 'A', lengthKm: 1, start: { lat: -33, lon: 151 } },
        { id: 'b', name: 'B', lengthKm: 1 },
      ],
      [
        route({ id: 'c_VVVVVVVVVVVVVVVV', status: 'verified' }),
        route({ id: 'c_UUUUUUUUUUUUUUUU' }),
        route({ id: 'c_NNNNNNNNNNNNNNNN', start: { lat: NaN, lon: 0 }, bbox: [NaN, 0, 0, 0] }),
      ]
    );
    expect(points.map(p => p.id)).toEqual(['a', 'c_UUUUUUUUUUUUUUUU', 'c_VVVVVVVVVVVVVVVV']);
  });
});

describe('unwrapLongitudes', () => {
  const at = (id: string, lon: number): LandingMapPoint => ({
    id,
    kind: 'curated',
    name: id,
    lat: 0,
    lon,
    href: './',
    lengthKm: 1,
    place: '',
    submittedBy: null,
  });

  it('moves the Americas east of New Zealand when that spans less', () => {
    const out = unwrapLongitudes([at('aawt', 147), at('ta', 172.5), at('cdt', -108)]);
    expect(out.map(p => p.lon)).toEqual([147, 172.5, 252]);
  });

  it('leaves a set that is tighter as it is', () => {
    const points = [at('a', -10), at('b', 20), at('c', 147)];
    expect(unwrapLongitudes(points).map(p => p.lon)).toEqual([-10, 20, 147]);
    expect(unwrapLongitudes([at('one', -108)]).map(p => p.lon)).toEqual([-108]);
  });
});

describe('mapPopupHtml', () => {
  const base: LandingMapPoint = {
    id: 'c_AAAAAAAAAAAAAAAA',
    kind: 'unverified',
    name: '<img src=x onerror=alert(1)>',
    lat: -37,
    lon: 145,
    href: './community-route.html?id=c_AAAAAAAAAAAAAAAA',
    lengthKm: 12.345,
    place: 'Victoria, Australia',
    submittedBy: '"><script>x</script>',
  };

  it('escapes the user-supplied name and submitter', () => {
    const html = mapPopupHtml(base);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('by &quot;&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(mapTooltipHtml(base)).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('links to the page and shows length, place and the badge', () => {
    const html = mapPopupHtml(base);
    expect(html).toContain('href="./community-route.html?id=c_AAAAAAAAAAAAAAAA"');
    expect(html).toContain('12.3 km · Victoria, Australia');
    expect(html).toContain('list-badge-unverified');
    expect(mapPopupHtml({ ...base, kind: 'verified' })).toContain('list-badge-verified');
    const curated = mapPopupHtml({ ...base, kind: 'curated', name: 'Six Foot Track', submittedBy: null, place: '' });
    expect(curated).not.toContain('list-badge');
    expect(curated).not.toContain(' · ');
  });
});

describe('mountLandingMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads Leaflet only once the container nears the viewport', async () => {
    let fire: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          fire = cb;
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    const loadLeaflet = vi.fn(() => Promise.reject(new Error('blocked')));
    const container = document.createElement('div');
    const handle = mountLandingMap(container, { loadLeaflet });
    handle.update([]);
    expect(loadLeaflet).not.toHaveBeenCalled();

    fire!([{ isIntersecting: false }]);
    expect(loadLeaflet).not.toHaveBeenCalled();
    fire!([{ isIntersecting: true }]);
    expect(loadLeaflet).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();

    // A failed load says so in place of the map.
    await vi.waitFor(() => expect(container.textContent).toContain('The map could not be loaded'));
  });
});

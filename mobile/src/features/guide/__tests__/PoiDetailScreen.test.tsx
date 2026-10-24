/**
 * The POI detail screen, rendered with the router, theme, guide contexts,
 * settings store and `Linking` mocked out — so this is a pure assertion about
 * what a walker sees and what a tap actually opens.
 *
 * The load-bearing case is the last one: an OSM `website` tag holding
 * `javascript:` must render as inert text. The scheme check lives in
 * `summarisePoiTags` (shared with the web), and the screen's contract is that
 * it opens `line.href` and never builds a URL from a tag itself — so the way
 * to test the contract is to feed the screen a hostile tag and assert that no
 * link appears.
 */

import React from 'react';
import { Linking, Platform } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { TrailPOI } from '@lib/trail-types';
import { googleMapsUrl, mapsUrlFor } from '../poi-detail';
import { takeMapTarget } from '../map-target';
import PoiDetailScreen from '../../../../app/guide/[trailId]/poi/[poiKey]';

// Mutated per test, then returned by the mocked router hook.
let mockParams: { trailId: string; poiKey: string } = { trailId: 'heysen', poiKey: 'node-1' };
let mockPois: TrailPOI[] = [];
let mockCurrentKm: number | null = null;
let mockStatus = 'no-permission';
let mockOffTrailMeters: number | null = null;
let mockPaceKmh = 4;
// A flat 50 km line: the trip card's climb is zero, so its time is pace alone.
const mockTrack = {
  points: [
    { lat: 0, lon: 0, ele: 0, dist: 0 },
    { lat: 0, lon: 0.45, ele: 0, dist: 50 },
  ],
};

const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ dismissTo: mockDismissTo }),
  Stack: { Screen: () => null },
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../GuideContext', () => ({
  useGuide: () => ({
    trailId: 'heysen',
    direction: 'default',
    trail: { pois: mockPois, track: mockTrack },
  }),
}));

jest.mock('../GuidePositionContext', () => ({
  useGuidePositionContext: () => ({
    currentKm: mockCurrentKm,
    offTrailMeters: mockOffTrailMeters,
    position: null,
    status: mockStatus,
  }),
}));

jest.mock('../../plan/plan-inputs-store', () => ({
  usePlanInputsStore: (selector: (s: unknown) => unknown) => selector({}),
  selectPaceBaseKmh: () => () => mockPaceKmh,
}));

// The comments block has its own tests; here it only has to be handed the
// right place to file comments under.
const mockCommentsProps: Record<string, unknown>[] = [];
jest.mock('../../comments/CommentsSection', () => ({
  CommentsSection: (props: Record<string, unknown>) => {
    mockCommentsProps.push(props);
    return null;
  },
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

function poi(over: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'water',
    lat: -34.9285,
    lon: 138.6007,
    name: 'Mount Lofty Tank',
    tags: { amenity: 'drinking_water', operator: 'SA Water' },
    distanceAlongTrail: 42.5,
    distanceFromTrail: 0.12,
    ...over,
  };
}

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join(' ');
}

/** Every pressable control, keyed by its spoken label. */
function controls(tree: ReactTestRenderer): Map<string, () => void> {
  const found = new Map<string, () => void>();
  tree.root
    .findAll(
      (n) =>
        typeof n.props.onPress === 'function' && typeof n.props.accessibilityLabel === 'string',
    )
    .forEach((n) => {
      const label = n.props.accessibilityLabel as string;
      if (!found.has(label)) found.set(label, n.props.onPress as () => void);
    });
  return found;
}

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<PoiDetailScreen />);
  });
  return tree;
}

describe('PoiDetailScreen', () => {
  beforeEach(() => {
    mockParams = { trailId: 'heysen', poiKey: 'node-1' };
    mockPois = [poi()];
    mockCurrentKm = null;
    mockStatus = 'no-permission';
    mockOffTrailMeters = null;
    mockPaceKmh = 4;
    mockCommentsProps.length = 0;
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the name, category, position along the trail and off-trail distance', () => {
    const text = allText(render());
    expect(text).toContain('Mount Lofty Tank');
    expect(text).toContain('Water · 42.5 km along the trail · 0.12 km off trail');
  });

  it('leaves out the off-trail distance for a POI on the trail', () => {
    mockPois = [poi({ distanceFromTrail: 0.017 })];
    const text = allText(render());
    expect(text).toContain('Water · 42.5 km along the trail');
    expect(text).not.toContain('off trail');
  });

  it('marks the data as OpenStreetMap and credits it', () => {
    const text = allText(render());
    expect(text).toContain('OpenStreetMap');
    expect(text).toContain('© OpenStreetMap contributors');
    expect(text).toContain('Uncurated OpenStreetMap data');
  });

  it('lists the summarised tags', () => {
    const text = allText(render());
    expect(text).toContain('OSM tag');
    expect(text).toContain('amenity=drinking_water');
    expect(text).toContain('Operator');
    expect(text).toContain('SA Water');
  });

  it('shows no trip without a fix', () => {
    mockCurrentKm = 40;
    expect(allText(render())).not.toContain('From your location');
  });

  it("shows the trip from the hiker at the trail's own pace", () => {
    mockCurrentKm = 40;
    mockStatus = 'fix';
    mockPaceKmh = 3;
    const text = allText(render());
    expect(text).toContain('From your location');
    expect(text).toContain('2.5 km ahead');
    // 2.5 km at 3 km/h on the flat: 0.8 h → "~50 min" (4 km/h would be ~35).
    expect(text).toContain('~50 min');
  });

  it('never says "You are here" for a POI off the trail', () => {
    mockCurrentKm = 42.5;
    mockStatus = 'fix';
    const text = allText(render());
    expect(text).toContain('At its nearest point on the trail');
    expect(text).toContain('Then 0.12 km off the trail to reach it');
    expect(text).not.toContain('You are here');
  });

  it('says so when the hiker is off the trail, and is not "here"', () => {
    mockPois = [poi({ distanceFromTrail: 0.01 })];
    mockCurrentKm = 42.5;
    mockStatus = 'off-trail';
    mockOffTrailMeters = 3000;
    const text = allText(render());
    expect(text).toContain('From the nearest point on the trail');
    expect(text).toContain('Level with you on the trail');
    expect(text).toContain('You are 3.00 km off the trail');
    expect(text).not.toContain('You are here');
  });

  it('says "You are here" only when both are on the trail', () => {
    mockPois = [poi({ distanceFromTrail: 0.01 })];
    mockCurrentKm = 42.5;
    mockStatus = 'fix';
    expect(allText(render())).toContain('You are here');
  });

  it('opens the element on openstreetmap.org', () => {
    const press = controls(render()).get('Open in OpenStreetMap');
    expect(press).toBeDefined();
    act(() => press?.());
    expect(Linking.openURL).toHaveBeenCalledWith('https://www.openstreetmap.org/node/1');
  });

  it("shows the POI's own position on the guide's map", () => {
    const press = controls(render()).get('Show on map');
    expect(press).toBeDefined();
    act(() => press?.());
    expect(takeMapTarget('heysen')).toEqual({ lat: -34.9285, lon: 138.6007 });
    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/guide/[trailId]',
      params: { trailId: 'heysen' },
    });
  });

  it("opens a new OpenStreetMap note at the POI's position", () => {
    const press = controls(render()).get('Report a problem on OpenStreetMap');
    expect(press).toBeDefined();
    act(() => press?.());
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://www.openstreetmap.org/note/new?lat=-34.928500&lon=138.600700#map=19/-34.928500/138.600700',
    );
  });

  it('files comments under the OSM element, on this trail', () => {
    mockPois = [poi({ type: 'way', id: 1386690615 })];
    mockParams = { trailId: 'shikoku', poiKey: 'way-1386690615' };
    render();
    expect(mockCommentsProps.at(-1)).toMatchObject({
      trailId: 'shikoku',
      waypointId: 'osm_way_1386690615',
      waypointType: 'water',
    });
  });

  it('hands the platform maps app the POI, falling back to Google Maps when it cannot open', async () => {
    const press = controls(render()).get('Open in Maps');
    expect(press).toBeDefined();

    await act(async () => press?.());
    expect(Linking.openURL).toHaveBeenCalledWith(
      mapsUrlFor(-34.9285, 138.6007, 'Mount Lofty Tank', Platform.OS),
    );

    // No maps app: opening the geo:/maps: URL rejects, and the Google Maps link opens.
    // (canOpenURL is never asked — it says no on Android 11+ without <queries>.)
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('No activity'));
    const fallback = controls(render()).get('Open in Maps');
    await act(async () => fallback?.());
    expect(Linking.openURL).toHaveBeenLastCalledWith(googleMapsUrl(-34.9285, 138.6007));
  });

  it('links a website tag the shared guards cleared', () => {
    mockPois = [poi({ tags: { amenity: 'cafe', website: 'example.com' } })];
    const press = controls(render()).get('Website: example.com');
    expect(press).toBeDefined();
    act(() => press?.());
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/');
  });

  it('renders a javascript: website as inert text, with nothing to tap', () => {
    // The untrusted tag under test: an OSM `website` can hold anything.
    mockPois = [poi({ tags: { amenity: 'cafe', website: 'javascript:alert(1)' } })];
    const tree = render();

    // The value is still shown (a walker should see what OSM holds)…
    expect(allText(tree)).toContain('javascript:alert(1)');
    // …but no control exists for it, so nothing can open it.
    expect([...controls(tree).keys()]).toEqual([
      'Show on map',
      'Open in OpenStreetMap',
      'Open in Maps',
      'Report a problem on OpenStreetMap',
    ]);
  });

  it('shows a not-found state for a key no POI matches', () => {
    mockParams = { trailId: 'heysen', poiKey: 'node-999' };
    expect(allText(render())).toContain('Point of interest not found');
  });

  it('shows a not-found state for a malformed key', () => {
    mockParams = { trailId: 'heysen', poiKey: 'not-a-key' };
    expect(allText(render())).toContain('Point of interest not found');
  });
});

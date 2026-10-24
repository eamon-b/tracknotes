/**
 * The search screen informs before it acts: the request count, the download
 * range, the connection and the ODbL credit are on screen before anything is
 * sent, the search starts only on the button, and offline it cannot start.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import FindPoisScreen from '../guide/[trailId]/find-pois';
import { usePoiSearch, type UsePoiSearch } from '../../src/features/import/use-poi-search';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('expo-linking', () => ({ openURL: jest.fn() }));
jest.mock('../../src/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), isDark: false }),
}));
jest.mock('../../src/features/guide/GuideContext', () => ({
  useGuide: () => ({ trailId: 'u_x', baseTrail: { pois: undefined }, reloadTrail: jest.fn() }),
}));
jest.mock('../../src/features/import/use-poi-search', () => ({ usePoiSearch: jest.fn() }));

const SETUP = {
  trailId: 'u_x',
  trail: {},
  plan: {
    estimate: {
      queries: 3,
      routeKm: 245,
      uploadBytes: 18_000,
      downloadBytesLow: 122_500,
      downloadBytesHigh: 3_675_000,
    },
  },
};

function hookWith(over: Partial<UsePoiSearch>): UsePoiSearch {
  return {
    state: { kind: 'ready', setup: SETUP as never },
    connection: 'cellular',
    start: jest.fn(),
    retryMissed: jest.fn(),
    cancel: jest.fn(),
    remove: jest.fn(async () => true),
    ...over,
  };
}

function texts(tree: ReactTestRenderer): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') found.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else {
      const children = (node as { children?: unknown } | null)?.children;
      if (children) walk(children);
    }
  };
  walk(tree.toJSON());
  return found.join('');
}

function searchButton(tree: ReactTestRenderer) {
  return tree.root.findAll(
    (n: TestInstance) =>
      n.props.accessibilityLabel === 'Search OpenStreetMap' &&
      typeof n.props.onPress === 'function',
  )[0];
}

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

function render(hook: UsePoiSearch): ReactTestRenderer {
  (usePoiSearch as jest.Mock).mockReturnValue(hook);
  act(() => {
    tree = TestRenderer.create(<FindPoisScreen />);
  });
  return tree!;
}

describe('FindPoisScreen', () => {
  it('says what the search costs and where the route goes before anything is sent', () => {
    const hook = hookWith({});
    const text = texts(render(hook));
    expect(text).toContain('245.0 km · 3 requests');
    expect(text).toContain('About 123 KB to 3.7 MB');
    expect(text).toContain('Mobile data');
    expect(text).toContain('overpass-api.de');
    expect(text).toContain('© OpenStreetMap contributors, under the Open Database Licence');
    expect(hook.start).not.toHaveBeenCalled();
  });

  it('starts only when asked', () => {
    const hook = hookWith({});
    const screen = render(hook);
    act(() => {
      (searchButton(screen).props.onPress as () => void)();
    });
    expect(hook.start).toHaveBeenCalledTimes(1);
  });

  it('cannot start offline', () => {
    const screen = render(hookWith({ connection: 'offline' }));
    expect(texts(screen)).toContain('Offline — connect to search');
    expect(searchButton(screen).props.disabled).toBe(true);
  });

  it('offers a retry of just the missed areas after a partial result', () => {
    const hook = hookWith({
      state: {
        kind: 'done',
        setup: SETUP as never,
        run: {
          fetched: [],
          failures: [{ chunkIndex: 2, error: 'Overpass request failed: 504' }],
          pois: [],
          bytes: 50_000,
        },
      },
    });
    const screen = render(hook);
    expect(texts(screen)).toContain('Overpass request failed: 504');
    const retry = screen.root.findAll(
      (n: TestInstance) =>
        n.props.accessibilityLabel === 'Retry the 1 missed area' &&
        typeof n.props.onPress === 'function',
    )[0];
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(hook.retryMissed).toHaveBeenCalledTimes(1);
  });
});

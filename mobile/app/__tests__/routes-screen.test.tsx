/**
 * The Routes screen never fails silently: a load that rejects offers a retry
 * instead of an empty screen, and a show/hide/delete that rejects says so.
 */

import React from 'react';
import { Alert } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import RoutesScreen from '../guide/[trailId]/routes';
import { useRoutesStore } from '../../src/features/routes/routes-store';
import type { Route } from '../../src/db/routes-repo';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('../../src/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), isDark: false }),
}));
jest.mock('../../src/features/guide/GuideContext', () => ({
  useGuide: () => ({ trailId: 'larapinta' }),
}));
jest.mock('../../src/navigation/bottom-inset', () => ({
  useBottomInsetContentStyle: (style: unknown) => style,
}));
jest.mock('../../src/db/database', () => ({ getDatabase: jest.fn(async () => ({})) }));

const ROUTE: Route = {
  id: 'r1',
  trailId: 'larapinta',
  name: 'Day loop',
  totalKm: 10,
  ascentM: 300,
  descentM: 200,
  trackKey: null,
  offTrailPoints: 0,
  createdAt: '2026-07-29T00:00:00Z',
  updatedAt: '2026-07-29T00:00:00Z',
};

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
  return found.join('|');
}

function pressable(tree: ReactTestRenderer, label: string): TestInstance {
  const found = tree.root.findAll(
    (n: TestInstance) =>
      typeof n.props.onPress === 'function' &&
      (n.props.accessibilityLabel === label ||
        n.findAll((c: TestInstance) => c.props.children === label).length > 0),
  );
  return found[found.length - 1];
}

/** Press the element that answers to `label`. */
function press(tree: ReactTestRenderer, label: string): void {
  (pressable(tree, label).props.onPress as () => void)();
}

const flush = () => act(async () => {});

describe('RoutesScreen', () => {
  const realState = useRoutesStore.getState();

  let tree: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => tree?.unmount());
    tree = undefined;
    useRoutesStore.setState(realState, true);
    jest.restoreAllMocks();
  });

  it('offers a retry when the routes fail to load', async () => {
    const hydrate = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('db'))
      .mockImplementationOnce(async () => {
        useRoutesStore.setState({ byTrail: { larapinta: [ROUTE] } });
      });
    useRoutesStore.setState({ byTrail: {}, hydrate });

    await act(async () => {
      tree = TestRenderer.create(<RoutesScreen />);
    });
    await flush();
    expect(texts(tree!)).toContain('Couldn’t load your routes.');

    await act(async () => press(tree!, 'Retry'));
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(texts(tree!)).toContain('Day loop');
    expect(texts(tree!)).not.toContain('Couldn’t load');
  });

  it('says so when showing a route fails', async () => {
    useRoutesStore.setState({
      byTrail: { larapinta: [ROUTE] },
      hydrate: jest.fn(async () => {}),
      activate: jest.fn(async () => {
        throw new Error('db');
      }),
    });

    await act(async () => {
      tree = TestRenderer.create(<RoutesScreen />);
    });
    await act(async () => press(tree!, 'Show Day loop on map'));
    await flush();
    expect(texts(tree!)).toContain('Couldn’t show “Day loop” on the map. Try again.');
  });

  it('says so when deleting a route fails', async () => {
    useRoutesStore.setState({
      byTrail: { larapinta: [ROUTE] },
      hydrate: jest.fn(async () => {}),
      remove: jest.fn(async () => {
        throw new Error('db');
      }),
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await act(async () => {
      tree = TestRenderer.create(<RoutesScreen />);
    });
    act(() => press(tree!, 'Delete Day loop'));
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Delete')!.onPress!());
    await flush();
    expect(texts(tree!)).toContain('Couldn’t delete “Day loop”. Try again.');
  });
});

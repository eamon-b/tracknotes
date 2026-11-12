/**
 * Shallow render smoke test for the Skia elevation profile.
 *
 * Skia and the theme are mocked locally (jest.setup.js must not change);
 * gesture-handler + reanimated use the global mocks. The goal is to prove the
 * component mounts, builds its Skia paths after layout, and handles taps/window
 * changes without throwing — not to verify pixel output.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Circle, Line } from '@shopify/react-native-skia';
import { ElevationProfile } from '../ElevationProfile';
import type { ProfilePoint } from '../lod';

// --- Local Skia mock (no native canvas in Jest) ---------------------------
// Container elements pass their children through; leaf primitives render null.
// Plain function components avoid importing React/View inside the factory.
jest.mock('@shopify/react-native-skia', () => {
  const container = ({ children }: { children?: unknown }) => children ?? null;
  // A fresh component per primitive, so a test can pick the Circles out of the
  // tree by type and read the paint props off them.
  const leaf = () => () => null;
  const makePath = () => ({ dispose: jest.fn() });
  type MockBuilder = {
    moveTo: jest.Mock;
    lineTo: jest.Mock;
    close: jest.Mock;
    detach: () => ReturnType<typeof makePath>;
    dispose: jest.Mock;
  };
  const makeBuilder = () => {
    const builder: MockBuilder = {
      moveTo: jest.fn(() => builder),
      lineTo: jest.fn(() => builder),
      close: jest.fn(() => builder),
      detach: () => makePath(),
      dispose: jest.fn(),
    };
    return builder;
  };
  return {
    Canvas: container,
    Group: container,
    Path: container,
    Line: leaf(),
    Circle: leaf(),
    Rect: leaf(),
    LinearGradient: leaf(),
    vec: (x: number, y: number) => ({ x, y }),
    Skia: { PathBuilder: { Make: () => makeBuilder(), MakeFromPath: () => makeBuilder() } },
  };
});

// --- Local theme mock -----------------------------------------------------
// Every colour resolves to its own token name, so a test can say *which* token
// a marker was painted with rather than only that it got a colour.
jest.mock('../../../theme', () => ({
  useTheme: () => ({
    colors: new Proxy({}, { get: (_t: unknown, key: string) => `token:${key}` }),
  }),
  useReduceMotion: () => false,
}));

// --- Local gesture-handler mock (v3 hook API) ------------------------------
// `mockGestureConfigs` records every config object each gesture hook is called
// with, by hook, so a test can assert a gesture's config is built once and not
// rebuilt on window changes, and can fire a gesture's callbacks itself (a tap's
// `onDeactivate` at a pixel the component placed a marker on).
// The hooks return a tagged stand-in; the composition hooks nest them, so a
// test can check the composition too.
const mockGestureConfigs: Record<string, Record<string, unknown>[]> = {};
/** The `gesture` prop of each GestureDetector render. */
const mockDetectorGestures: unknown[] = [];
jest.mock('react-native-gesture-handler', () => {
  const single = (kind: string) => (config: Record<string, unknown>) => {
    (mockGestureConfigs[kind] ??= []).push(config);
    return { kind, config };
  };
  const composed =
    (kind: string) =>
    (...gestures: unknown[]) => ({ kind, gestures });
  return {
    GestureDetector: ({ children, gesture }: { children: unknown; gesture: unknown }) => {
      mockDetectorGestures.push(gesture);
      return children;
    },
    usePanGesture: single('pan'),
    usePinchGesture: single('pinch'),
    useTapGesture: single('tap'),
    useCompetingGestures: composed('competing'),
    useSimultaneousGestures: composed('simultaneous'),
  };
});

/** The distinct config objects a gesture hook has been called with. */
function distinctConfigs(kind: string): Record<string, unknown>[] {
  return [...new Set(mockGestureConfigs[kind] ?? [])];
}

/** The tap gesture's end callback, as the component configured it. */
function tapHandler(): (e: { x: number; y: number }) => void {
  const configs = distinctConfigs('tap');
  expect(configs).toHaveLength(1);
  return configs[0].onDeactivate as (e: { x: number; y: number }) => void;
}

function makePoints(n: number): ProfilePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 0,
    lon: 0,
    dist: (i / (n - 1)) * 100,
    ele: 100 + Math.sin(i / 5) * 50,
  }));
}

function layoutAll(root: ReactTestRenderer) {
  act(() => {
    root.root
      .findAll((n) => typeof n.props.onLayout === 'function')
      .forEach((n) => {
        n.props.onLayout?.({ nativeEvent: { layout: { width: 360, height: 240 } } });
      });
  });
}

describe('ElevationProfile', () => {
  beforeEach(() => {
    for (const kind of Object.keys(mockGestureConfigs)) delete mockGestureConfigs[kind];
    mockDetectorGestures.length = 0;
  });

  const baseProps = {
    points: makePoints(300),
    totalKm: 100,
    unit: 'km' as const,
    window: { startKm: 0, endKm: 100 },
    eleWindow: { minM: 0, maxM: 200 },
    eleBounds: { floorM: 0, ceilingM: 200 },
    onEleWindowChange: jest.fn(),
    waypoints: [
      { id: 'w1', type: 'water', totalDistance: 25, elevation: 120 },
      { id: 'w2', type: 'campsite', totalDistance: 60, elevation: 80 },
    ],
  };

  it('renders and builds paths after layout', () => {
    const onWindowChange = jest.fn();
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile {...baseProps} onWindowChange={onWindowChange} />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('does not rebuild its gesture when the window changes', () => {
    // gesture-handler cancels an in-flight gesture if the GestureDetector's
    // config is swapped, so panning would die on its own first frame if the
    // composed gesture depended on the window.
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<ElevationProfile {...baseProps} onWindowChange={jest.fn()} />);
    });
    layoutAll(root);
    for (const kind of ['pan', 'pinch', 'tap']) expect(distinctConfigs(kind)).toHaveLength(1);

    for (const window of [
      { startKm: 10, endKm: 60 },
      { startKm: 20, endKm: 22 },
      { startKm: 21, endKm: 23 },
    ]) {
      act(() => {
        root.update(<ElevationProfile {...baseProps} window={window} onWindowChange={jest.fn()} />);
      });
    }
    for (const kind of ['pan', 'pinch', 'tap']) expect(distinctConfigs(kind)).toHaveLength(1);
    act(() => root.unmount());
  });

  it('configures the gestures as the builder API did', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<ElevationProfile {...baseProps} onWindowChange={jest.fn()} />);
    });
    const [pan] = distinctConfigs('pan');
    const [pinch] = distinctConfigs('pinch');
    const [tap] = distinctConfigs('tap');
    expect(pan).toMatchObject({ minDistance: 6, maxPointers: 1 });
    expect(tap).toMatchObject({ maxDistance: 12 });
    // onStart/onEnd became onActivate/onDeactivate in v3; nothing may still use
    // the old names, which the hooks would ignore.
    for (const config of [pan, pinch]) {
      for (const name of ['onActivate', 'onUpdate', 'onDeactivate']) {
        expect(typeof config[name]).toBe('function');
      }
    }
    expect(typeof pinch.onTouchesDown).toBe('function');
    expect(typeof tap.onDeactivate).toBe('function');
    for (const config of [pan, pinch, tap]) {
      expect(config).not.toHaveProperty('onStart');
      expect(config).not.toHaveProperty('onEnd');
    }
    // Simultaneous(Race(pinch, pan), tap), as before.
    layoutAll(root);
    expect(mockDetectorGestures.at(-1)).toEqual({
      kind: 'simultaneous',
      gestures: [
        {
          kind: 'competing',
          gestures: [
            { kind: 'pinch', config: pinch },
            { kind: 'pan', config: pan },
          ],
        },
        { kind: 'tap', config: tap },
      ],
    });
    act(() => root.unmount());
  });

  it('renders a zoomed window without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          window={{ startKm: 40, endKm: 41 }}
          currentKm={40.5}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders an empty state with no points', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          points={[]}
          totalKm={0}
          unit="km"
          window={{ startKm: 0, endKm: 0 }}
          onWindowChange={jest.fn()}
          eleWindow={{ minM: 0, maxM: 50 }}
          eleBounds={{ floorM: 0, ceilingM: 50 }}
          onEleWindowChange={jest.fn()}
        />,
      );
    });
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders a current-position marker without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile {...baseProps} currentKm={40} onWindowChange={jest.fn()} />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders active-route highlight bands without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          highlightRanges={[
            { startKm: 10, endKm: 40 },
            { startKm: 70, endKm: 90 },
          ]}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders favorited markers (imperial units) without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          unit="mi"
          favoriteIds={new Set(['w1'])}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  describe('elevation axis', () => {
    interface CircleProps {
      cx: number;
      cy: number;
    }
    const circles = (root: ReactTestRenderer): CircleProps[] =>
      root.root.findAllByType(Circle).map((n) => n.props as unknown as CircleProps);

    it('keeps a marker at the same height when the km window zooms', () => {
      // The y-axis is the elevation window, not a fit to the visible points:
      // zooming in on km must not move a waypoint up or down the plot.
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(<ElevationProfile {...baseProps} onWindowChange={jest.fn()} />);
      });
      layoutAll(root);
      const whole = circles(root)[0].cy;
      act(() => {
        root.update(
          <ElevationProfile
            {...baseProps}
            window={{ startKm: 20, endKm: 30 }}
            onWindowChange={jest.fn()}
          />,
        );
      });
      expect(circles(root)[0].cy).toBeCloseTo(whole, 6);
      act(() => root.unmount());
    });

    it('drops markers above a zoomed-in elevation window', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile
            {...baseProps}
            eleWindow={{ minM: 0, maxM: 100 }}
            onWindowChange={jest.fn()}
          />,
        );
      });
      layoutAll(root);
      // w1 (120 m) is off the top; w2 (80 m) stays.
      expect(circles(root)).toHaveLength(1);
      act(() => root.unmount());
    });
  });

  describe('planned resupply markers', () => {
    interface CircleProps {
      r: number;
      color: string;
      style?: string;
    }
    const circles = (root: ReactTestRenderer): CircleProps[] =>
      root.root.findAllByType(Circle).map((n) => n.props as unknown as CircleProps);

    it('draws a planned stop in the planned colour, at the favorite radius', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile
            {...baseProps}
            plannedIds={new Set(['w1'])}
            onWindowChange={jest.fn()}
          />,
        );
      });
      layoutAll(root);

      const drawn = circles(root);
      expect(drawn[0]).toMatchObject({ color: 'token:resupplyPlanned', r: 6 });
      // The unplanned waypoint keeps its category colour and the smaller dot.
      expect(drawn[1]).toMatchObject({ color: 'token:waypointCamp', r: 4 });
      act(() => root.unmount());
    });

    it('draws a waypoint that is both planned and favorited as planned', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile
            {...baseProps}
            favoriteIds={new Set(['w1'])}
            plannedIds={new Set(['w1'])}
            onWindowChange={jest.fn()}
          />,
        );
      });
      layoutAll(root);
      expect(circles(root)[0].color).toBe('token:resupplyPlanned');
      act(() => root.unmount());
    });

    it('marks nothing when no plan has been made', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(<ElevationProfile {...baseProps} onWindowChange={jest.fn()} />);
      });
      layoutAll(root);
      expect(circles(root).some((c) => c.color === 'token:resupplyPlanned')).toBe(false);
      act(() => root.unmount());
    });
  });

  describe('POI ticks', () => {
    const poiProps = {
      ...baseProps,
      waypoints: [
        ...baseProps.waypoints,
        { id: 'node-9', type: 'water', kind: 'poi' as const, totalDistance: 30, elevation: 120 },
      ],
    };

    interface CircleProps {
      cx: number;
      cy: number;
      r: number;
      color: string;
      style?: string;
      strokeWidth?: number;
    }

    /** Every Circle the canvas drew, in render order. */
    function circles(root: ReactTestRenderer): CircleProps[] {
      return root.root.findAllByType(Circle).map((n) => n.props as unknown as CircleProps);
    }

    it('draws a POI marker as a stroke-only ring, waypoints as filled dots', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(<ElevationProfile {...poiProps} onWindowChange={jest.fn()} />);
      });
      layoutAll(root);

      const drawn = circles(root);
      const rings = drawn.filter((c) => c.style === 'stroke');
      expect(rings).toHaveLength(1);
      expect(rings[0]).toMatchObject({ r: 3, style: 'stroke', strokeWidth: 1.5 });
      // The two curated waypoints stay filled dots, and bigger.
      const dots = drawn.filter((c) => c.style !== 'stroke');
      expect(dots).toHaveLength(2);
      expect(dots.every((c) => c.r === 4)).toBe(true);
      act(() => root.unmount());
    });

    it('reports a tapped POI with kind "poi" and a tapped waypoint with "waypoint"', () => {
      const onWaypointTap = jest.fn();
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile
            {...poiProps}
            onWaypointTap={onWaypointTap}
            onWindowChange={jest.fn()}
          />,
        );
      });
      layoutAll(root);

      const drawn = circles(root);
      const ring = drawn.find((c) => c.style === 'stroke');
      const dot = drawn.find((c) => c.style !== 'stroke');
      if (!ring || !dot) throw new Error('expected both a POI ring and a waypoint dot');
      const onTap = tapHandler();

      // Tap dead centre of each marker the component itself placed.
      act(() => onTap({ x: ring.cx, y: ring.cy }));
      expect(onWaypointTap).toHaveBeenLastCalledWith('node-9', 'poi');

      act(() => onTap({ x: dot.cx, y: dot.cy }));
      expect(onWaypointTap).toHaveBeenLastCalledWith('w1', 'waypoint');
      act(() => root.unmount());
    });
  });

  describe('day-boundary ticks', () => {
    /** The full-height rules (grid lines are hairlines; ticks are 1.5 px). */
    function tickLines(root: ReactTestRenderer) {
      return root.root
        .findAllByType(Line)
        .map((n) => n.props as unknown as { strokeWidth: number; p1: { x: number } })
        .filter((l) => l.strokeWidth === 1.5);
    }

    it('draws one tick per planned stop inside the window', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile {...baseProps} stopKms={[25, 60]} onWindowChange={jest.fn()} />,
        );
      });
      layoutAll(root);

      const ticks = tickLines(root);
      expect(ticks).toHaveLength(2);
      // Ordered along the axis, like the km that produced them.
      expect(ticks[0].p1.x).toBeLessThan(ticks[1].p1.x);
      act(() => root.unmount());
    });

    it('draws nothing for a guide with no plan', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile {...baseProps} stopKms={[]} onWindowChange={jest.fn()} />,
        );
      });
      layoutAll(root);
      expect(tickLines(root)).toHaveLength(0);
      act(() => root.unmount());
    });

    it('drops a boundary that has been scrolled out of the window', () => {
      let root!: ReactTestRenderer;
      act(() => {
        root = TestRenderer.create(
          <ElevationProfile
            {...baseProps}
            window={{ startKm: 0, endKm: 30 }}
            stopKms={[25, 60]}
            onWindowChange={jest.fn()}
          />,
        );
      });
      layoutAll(root);
      // Only km 25 is on screen; km 60 is not clamped to the edge.
      expect(tickLines(root)).toHaveLength(1);
      act(() => root.unmount());
    });
  });
});

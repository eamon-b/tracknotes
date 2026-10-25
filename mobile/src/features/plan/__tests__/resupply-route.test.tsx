/**
 * The resupply screen against the real stores: what its controls persist.
 *
 * The selection and the zero days are fields of the trail's plan document, so
 * this runs the whole way down — screen, `plans-store.apply`, the shared
 * editors, SQLite — and asserts on the stored document. That is the point:
 * what the hiker chooses here is what a linked browser reads.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import { createMigratedTestDb } from '../../../db/__tests__/test-helpers';
import { getDatabase } from '../../../db/database';
import * as plansRepo from '../../../db/plans-repo';
import type { SqlDatabase } from '../../../db/sql-database';
import { usePlansStore } from '../../../state/plans-store';
import { DEFAULT_PREFS, usePlanInputsStore } from '../plan-inputs-store';
import ResupplyScreen from '../../../../app/guide/[trailId]/resupply';

const trail = {
  config: { id: 'cdt', name: 'CDT' },
  waypoints: [
    { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
    {
      id: 'w_salida',
      name: 'Salida',
      type: 'town',
      totalDistance: 100,
      accessName: 'Monarch Pass',
    },
    { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
    { id: 'w_camp', name: 'Camp', type: 'campsite', totalDistance: 180 },
  ],
  track: {
    points: [
      { lat: 0, lon: 0, ele: 1000, dist: 0 },
      { lat: 0, lon: 1, ele: 1200, dist: 150 },
      { lat: 0, lon: 2, ele: 1100, dist: 300 },
    ],
    totalDistance: 300,
  },
};

let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../guide/GuideContext', () => ({
  useGuide: () => ({ trailId: 'cdt', direction: 'default', trail, baseTrail: trail }),
}));

jest.mock('../../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ units: 'km' }),
}));

jest.mock('../../../db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('../../../api/uuid', () => ({ uuidv4: () => 'plan-uuid' }));

const mockGetDatabase = getDatabase as jest.Mock;
let db: SqlDatabase;

let mounted: ReactTestRenderer | null = null;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ResupplyScreen />);
    // FlatList schedules its first cell pass on a timer; run it inside act so
    // the update is not reported as an un-acted render.
    jest.runOnlyPendingTimers();
  });
  mounted = tree;
  return tree;
}

interface ControlProps {
  onPress?: () => void;
  onValueChange?: (value?: boolean) => void;
  accessibilityState?: unknown;
  value?: unknown;
}

/** The props of the control speaking this label (a Pressable, or a Switch). */
function control(tree: ReactTestRenderer, label: string): ControlProps {
  const [node] = tree.root.findAll(
    (n) =>
      n.props.accessibilityLabel === label &&
      (typeof n.props.onPress === 'function' || typeof n.props.onValueChange === 'function'),
  );
  if (!node) throw new Error(`no control "${label}"`);
  return node.props as unknown as ControlProps;
}

/** Fire a control and let the write reach SQLite. */
async function fire(tree: ReactTestRenderer, label: string, value?: boolean): Promise<void> {
  await act(async () => {
    const props = control(tree, label);
    if (props.onPress) props.onPress();
    else props.onValueChange?.(value);
    await Promise.resolve();
    await Promise.resolve();
    jest.runOnlyPendingTimers();
  });
}

function text(tree: ReactTestRenderer): string {
  const out: string[] = [];
  tree.root
    .findAll(() => true)
    .forEach((n) => {
      if (typeof n.props.children === 'string') out.push(n.props.children);
    });
  return out.join('\n');
}

async function stored(): Promise<PlanDocument | undefined> {
  return (await plansRepo.getByTrail(db, 'cdt')) ?? undefined;
}

describe('resupply screen', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockParams = {};
    db = (await createMigratedTestDb()) as unknown as SqlDatabase;
    mockGetDatabase.mockResolvedValue(db);
    usePlansStore.setState({ byTrail: {}, lastError: {} });
    // Block bodies throughout: a persisted `set` returns the storage write's
    // promise, and act() would treat a returned thenable as an async act.
    act(() => {
      usePlanInputsStore.setState({ byTrail: {} });
    });
  });

  afterEach(() => {
    // Unmount before the next test resets the stores: a live subscriber would
    // re-render outside act().
    act(() => mounted?.unmount());
    mounted = null;
    jest.useRealTimers();
  });

  it('starts with no plan made: the turn-off undecided, the lone town chosen', async () => {
    const tree = render();
    expect((await stored())?.resupplyStops).toBeUndefined();
    expect(text(tree)).toContain('Not decided yet');
    expect(control(tree, 'Resupply at Creede').value).toBe(true);
    // The legs run start → Monarch Pass → Creede → end.
    expect(text(tree)).toContain('Trail Start → Monarch Pass (not decided)');
    expect(text(tree)).toContain('Creede → Trail End');
  });

  it('picks one place at a turn-off, minting the plan and keeping the other group', async () => {
    const tree = render();
    await fire(tree, 'Salida');

    const plan = await stored();
    expect(plan?.id).toBe('plan-uuid');
    expect(plan?.name).toBe('CDT');
    expect(plan?.resupplyStops).toEqual(['w_salida', 'w_creede']);
    expect(text(tree)).not.toContain('Not decided yet');
  });

  it('carries through a turn-off, and switches a lone town off', async () => {
    const tree = render();
    await fire(tree, 'None – carry through');
    expect((await stored())?.resupplyStops).toEqual(['w_creede']);

    await fire(tree, 'Resupply at Creede', false);
    expect((await stored())?.resupplyStops).toEqual([]);
    expect(text(tree)).toContain('Trail Start → Trail End');
  });

  it('stores zero days on the chosen stop, in half days', async () => {
    const tree = render();
    await fire(tree, 'More zero days');
    await fire(tree, 'More zero days');
    expect((await stored())?.resupplyZeroDays).toEqual({ w_creede: 1 });
    await fire(tree, 'Fewer zero days');
    expect((await stored())?.resupplyZeroDays).toEqual({ w_creede: 0.5 });
  });

  it('Clear choices drops the selection back to no plan at all', async () => {
    const tree = render();
    await fire(tree, 'Salida');
    await fire(tree, 'Clear choices');

    expect((await stored())?.resupplyStops).toBeUndefined();
    // The plan itself survives — only the selection was cleared.
    expect((await stored())?.id).toBe('plan-uuid');
  });

  it('Clear choices also clears a selection left by a build before the document', async () => {
    act(() => {
      usePlanInputsStore.setState({
        byTrail: { cdt: { ...DEFAULT_PREFS, resupplyStops: ['w_creede'] } },
      });
    });
    const tree = render();
    await fire(tree, 'Clear choices');

    // Otherwise it would come straight back as the fallback.
    expect(usePlanInputsStore.getState().byTrail.cdt?.resupplyStops).toBeUndefined();
    expect((await stored())?.resupplyStops).toBeUndefined();
  });

  it('builds a choice on the device-local selection while the document has none', async () => {
    act(() => {
      usePlanInputsStore.setState({
        byTrail: { cdt: { ...DEFAULT_PREFS, resupplyStops: ['w_pass'] } },
      });
    });
    const tree = render();
    await fire(tree, 'Salida');
    expect((await stored())?.resupplyStops).toEqual(['w_salida']);
  });

  it('shows the selection a sync brought in', async () => {
    await plansRepo.upsertServer(db, {
      id: 'from-the-browser',
      trailId: 'cdt',
      name: 'CDT',
      direction: 'NOBO',
      startDate: null,
      stops: [],
      resupplyStops: ['w_creede'],
      updatedAt: '2026-09-21T00:00:00Z',
      version: 1,
    });

    const tree = render();
    // The mount hydrate lands a tick later; flush it and re-run the list pass.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
    });

    expect(control(tree, 'None – carry through').accessibilityState).toEqual({
      checked: true,
    });
    expect(control(tree, 'Resupply at Creede').value).toBe(true);
  });

  it('scopes the legs to the section the Plan screen passed, and dims the rest', () => {
    mockParams = { startKm: '120', endKm: '300', startName: 'Camp', endName: 'Trail end' };
    const tree = render();
    const all = text(tree);
    expect(all).toContain('Camp → Trail end');
    expect(all).toContain('outside section');
    expect(all).toContain('Trail Start → Creede');
  });

  it('falls back to the whole trail for a section the route does not hold', () => {
    mockParams = { startKm: '0', endKm: '900' };
    expect(text(render())).toContain('Whole trail');
  });

  it('edits the hiker’s inputs from the screen', async () => {
    const tree = render();
    await fire(tree, 'Resupply inputs');
    await fire(tree, 'More daily hours');
    expect(usePlanInputsStore.getState().byTrail.cdt?.dailyHours).toBe(
      DEFAULT_PREFS.dailyHours + 1,
    );
    await fire(tree, 'More long-carry days');
    expect(usePlanInputsStore.getState().byTrail.cdt?.longCarryDays).toBe(
      DEFAULT_PREFS.longCarryDays + 1,
    );
  });
});

/**
 * The import review screen's Save, for a `.tracknotes.json` that carries a
 * plan: it must ask before replacing a plan the phone already has, and a
 * second tap while it is still looking that plan up must not start a second
 * save.
 */

import React from 'react';
import { Alert } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanDocument } from '@lib/plan-types';
import ImportScreen from '../import';
import { importGpxFromUri, saveImport } from '../../src/features/import/import-gpx';
import { existingPlanFor, saveImportedPlan } from '../../src/features/import/import-plan';

jest.mock('../../src/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({
    uri: 'file:///trail.tracknotes.json',
    fileName: 'trail.tracknotes.json',
  }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
}));

jest.mock('../../src/navigation/KeyboardAwareScrollView', () => {
  const { View } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: View };
});

jest.mock('../../src/features/import/import-gpx', () => ({
  importGpxFromUri: jest.fn(),
  saveImport: jest.fn(),
}));

jest.mock('../../src/features/import/import-plan', () => ({
  existingPlanFor: jest.fn(),
  saveImportedPlan: jest.fn(),
}));

jest.mock('../../src/features/import/elevation-backfill-flow', () => ({
  backfillImportElevation: jest.fn(),
  elevationRequestEstimate: () => ({ requests: 1, seconds: 1 }),
}));

const TRAIL_ID = 'u_abc123';

const PLAN: PlanDocument = {
  id: 'web-plan',
  trailId: TRAIL_ID,
  name: 'Easter trip',
  direction: 'NOBO',
  startDate: '2026-04-03',
  stops: [{ km: 0.5, name: 'Camp', nights: 1 }],
  updatedAt: '2026-03-01T10:00:00.000Z',
  version: 1,
};

const IMPORTED = {
  trail: {
    config: { id: TRAIL_ID, name: 'Weekend Loop' },
    track: { points: [], totalDistance: 0.85, totalAscent: 30, totalDescent: 0 },
    waypoints: [],
  },
  report: {
    trailId: TRAIL_ID,
    name: 'Weekend Loop',
    pointCount: 2,
    waypointCount: 0,
    totalDistanceKm: 0.85,
    totalAscentM: 30,
    totalDescentM: 0,
    hasElevation: true,
    poiCount: 0,
    simplified: false,
    warnings: [],
  },
  plan: PLAN,
  suggestedName: 'Weekend Loop',
};

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  (importGpxFromUri as jest.Mock).mockResolvedValue(IMPORTED);
  (saveImport as jest.Mock).mockResolvedValue(TRAIL_ID);
  (saveImportedPlan as jest.Mock).mockResolvedValue(PLAN);
});

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    mounted = TestRenderer.create(<ImportScreen />);
  });
  return mounted!;
}

/** Press "Save guide" (as `onPress` would; the promise is the screen's own). */
function pressSave(tree: ReactTestRenderer): void {
  const [button] = tree.root.findAll(
    (n) => n.props.accessibilityLabel === 'Save guide' && typeof n.props.onPress === 'function',
  );
  if (!button) throw new Error('no Save guide button');
  (button.props.onPress as () => void)();
}

type AlertButtons = { text?: string; onPress?: () => void }[];

describe('ImportScreen — Save with a plan', () => {
  it('starts one save, however many times Save is tapped while it looks up the existing plan', async () => {
    let resolveLookup: (plan: PlanDocument | null) => void = () => {};
    (existingPlanFor as jest.Mock).mockReturnValue(
      new Promise<PlanDocument | null>((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const tree = await render();

    await act(async () => {
      pressSave(tree);
      pressSave(tree);
    });
    await act(async () => {
      resolveLookup(null);
    });

    expect(existingPlanFor).toHaveBeenCalledTimes(1);
    expect(saveImport).toHaveBeenCalledTimes(1);
    expect(saveImportedPlan).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('asks before replacing a plan the phone already has, and lets Save be tapped again after Cancel', async () => {
    (existingPlanFor as jest.Mock).mockResolvedValue({ ...PLAN, id: 'phone-plan' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();

    await act(async () => {
      pressSave(tree);
    });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(saveImport).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as AlertButtons;
    act(() => buttons.find((b) => b.text === 'Cancel')!.onPress!());

    await act(async () => {
      pressSave(tree);
    });
    expect(alert).toHaveBeenCalledTimes(2);
    const again = alert.mock.calls[1][2] as AlertButtons;
    await act(async () => {
      again.find((b) => b.text === 'Replace')!.onPress!();
    });
    expect(saveImport).toHaveBeenCalledTimes(1);
    expect(saveImportedPlan).toHaveBeenCalledWith(PLAN, TRAIL_ID);
    alert.mockRestore();
  });

  it('shows the failure, and saves nothing, when the existing plan cannot be read', async () => {
    (existingPlanFor as jest.Mock).mockRejectedValue(new Error('database is locked'));
    const tree = await render();

    await act(async () => {
      pressSave(tree);
    });

    expect(saveImport).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('database is locked');
  });
});

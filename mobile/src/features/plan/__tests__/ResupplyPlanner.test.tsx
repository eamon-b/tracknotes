/**
 * The resupply screen's body. What a hiker has to be able to read and do: the
 * summary's figures; a turn-off's places as a radio list with "None – carry
 * through", and a lone place as a Yes/No switch; "Not decided yet" on a group
 * with more than one place still ticked; each option's store, access, boxes
 * and lead sentence (the rest behind More); each leg's distance with its side
 * trip, its rides, climb, days, food and long-carry flag; and a zero-days
 * stepper on a chosen stop only.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  listResupplyOptions,
  type ResupplyCandidateWaypoint,
  type ResupplyLeg,
  type ResupplyPlanSummary,
} from '@lib/resupply-plan';
import { ResupplyPlanner, type ResupplyPlannerProps } from '../ResupplyPlanner';
import { plannerRows } from '../resupply-planner';

// Every component here calls useTheme once per render, so the call count
// doubles as a render count for the memo test.
const mockUseTheme = jest.fn(() => ({ colors: new Proxy({}, { get: () => '#123456' }) }));
jest.mock('../../../theme', () => ({ useTheme: () => mockUseTheme() }));

const waypoints: ResupplyCandidateWaypoint[] = [
  { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
  {
    id: 'w_salida',
    name: 'Salida',
    type: 'town',
    totalDistance: 100,
    offTrailKm: 22.5,
    accessMode: 'hitch',
    acceptsBoxes: true,
    store: 'full',
    accessName: 'Monarch Pass (US 50)',
    description: 'mi 1947.3 | CO | Leave the CDT here for Salida. Safeway and hot springs.',
  },
  { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250, offTrailKm: 2.8 },
];

const groups = listResupplyOptions(waypoints);
const range = { startKm: 0, endKm: 300, startName: 'Trail start', endName: 'Trail end' };

function leg(fromKm: number, toKm: number, over: Partial<ResupplyLeg> = {}): ResupplyLeg {
  return {
    fromName: 'Trail Start',
    toName: 'Creede',
    fromKm,
    toKm,
    distanceKm: toKm - fromKm,
    offTrailWalkKm: 0,
    sideTripKm: 0,
    sideTripAscentM: 0,
    sideTripDescentM: 0,
    zeroDays: 0,
    walkedKm: toKm - fromKm,
    rides: [],
    estimatedDays: 6,
    isLong: false,
    ascentM: 5120,
    descentM: 4870,
    estimatedHours: 44.6,
    food: { weightGrams: 4080, weightKg: 4.1, days: 6 },
    ...over,
  };
}

const summary: ResupplyPlanSummary = {
  stopsChosen: 1,
  longestLegKm: 255.6,
  mostClimbM: 5120,
  longestCarryDays: 6,
  heaviestFoodKg: 4.1,
  totalWalkingKm: 305.6,
  totalDays: 9.5,
  zeroDays: 1.5,
  hasData: true,
};

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('\n');
}

function props(
  selected: string[] | undefined,
  over: Partial<ResupplyPlannerProps> = {},
  legs: ResupplyLeg[] = [],
  zeroDays?: Record<string, number>,
): ResupplyPlannerProps {
  return {
    rows: plannerRows(groups, selected, legs, range, zeroDays),
    summary,
    undecided: 0,
    hasOptions: true,
    units: 'km',
    sectionLabel: 'Whole trail',
    inputsLine: 'Average pace · 8 h/day · 680 g food/day · long carry over 5 days',
    onEditInputs: jest.fn(),
    planMade: true,
    onReset: jest.fn(),
    onChoose: jest.fn(),
    onZeroDays: jest.fn(),
    ...over,
  };
}

function render(p: ResupplyPlannerProps): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ResupplyPlanner {...p} />);
    // FlatList schedules its first cell pass on a timer.
    jest.runOnlyPendingTimers();
  });
  return tree;
}

interface ControlProps {
  onPress: () => void;
  onValueChange: (value: boolean) => void;
  accessibilityState?: unknown;
  value?: unknown;
}

/** The props of the pressable (or switchable) control with this accessibility label. */
function control(tree: ReactTestRenderer, label: string): ControlProps {
  const [node] = tree.root.findAll(
    (n) =>
      n.props.accessibilityLabel === label &&
      (typeof n.props.onPress === 'function' || typeof n.props.onValueChange === 'function'),
  );
  if (!node) throw new Error(`no control "${label}"`);
  return node.props as unknown as ControlProps;
}

describe('ResupplyPlanner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('puts the headline figures on top', () => {
    const text = allText(render(props(['w_salida', 'w_creede'])));
    expect(text).toContain('Whole trail');
    expect(text).toContain('255.6 km');
    expect(text).toContain('5,120 m');
    expect(text).toContain('6 days');
    expect(text).toContain('4.1 kg');
    expect(text).toContain('305.6 km');
    expect(text).toContain('Days (incl. 1½ days off)');
    expect(text).toContain('9.5');
    expect(text).toContain('Average pace · 8 h/day · 680 g food/day · long carry over 5 days');
  });

  it('says how many turn-offs are not decided yet', () => {
    const tree = render(props(undefined, { undecided: 1 }));
    const text = allText(tree);
    expect(text).toContain('1 turn-off is not decided yet');
    expect(text).toContain('Not decided yet');
  });

  it('draws a turn-off as radios with "None – carry through", and picks by id', () => {
    const p = props(['w_salida', 'w_creede']);
    const tree = render(p);
    expect(control(tree, 'Salida').accessibilityState).toEqual({ checked: true });
    expect(control(tree, 'Monarch Pass').accessibilityState).toEqual({ checked: false });
    expect(
      control(tree, 'None – carry through at Monarch Pass (US 50)').accessibilityState,
    ).toEqual({
      checked: false,
    });

    act(() => control(tree, 'Monarch Pass').onPress());
    expect(p.onChoose).toHaveBeenCalledWith('w_pass', 'w_pass');
    act(() => control(tree, 'None – carry through at Monarch Pass (US 50)').onPress());
    expect(p.onChoose).toHaveBeenCalledWith('w_pass', null);
  });

  it('draws a lone place as a switch', () => {
    const p = props(['w_salida']);
    const tree = render(p);
    const creede = control(tree, 'Resupply at Creede');
    expect(creede.value).toBe(false);
    act(() => creede.onValueChange(true));
    expect(p.onChoose).toHaveBeenCalledWith('w_creede', 'w_creede');
  });

  it('gives each option its store, access, boxes and lead sentence, the rest behind More', () => {
    const tree = render(props(['w_salida']));
    let text = allText(tree);
    expect(text).toContain('Full resupply · 22.5 km hitch · Accepts boxes');
    expect(text).toContain('On trail');
    expect(text).toContain('2.8 km off trail');
    expect(text).toContain('Leave the CDT here for Salida.');
    expect(text).not.toContain('Safeway and hot springs.');

    act(() => control(tree, 'More about Salida').onPress());
    text = allText(tree);
    expect(text).toContain('Leave the CDT here for Salida. Safeway and hot springs.');
  });

  it('shows each leg’s distance and side trip, rides, climb, days, food and long carry', () => {
    const legs = [
      leg(0, 100, { toName: 'Salida', rides: [{ km: 22.5, mode: 'hitch', end: 'to' }] }),
      leg(100, 250, {
        fromName: 'Salida',
        sideTripKm: 5.6,
        walkedKm: 155.6,
        offTrailWalkKm: 5.6,
        isLong: true,
      }),
      leg(250, 300, { fromName: 'Creede', toName: 'Trail End' }),
    ];
    const text = allText(render(props(['w_salida', 'w_creede'], {}, legs)));
    expect(text).toContain('Salida → Creede');
    expect(text).toContain('155.6 km · +5,120 m / −4,870 m · ≈ 6 days · 4.1 kg food');
    expect(text).toContain('incl. 5.6 km to Creede and back');
    expect(text).toContain('22.5 km hitch in, not walked');
    expect(text).toContain('Long carry');
    // No arrival days on this screen.
    expect(text).not.toContain('Arrive Day');
  });

  it('offers zero days on a chosen stop only, and steps them by option id', () => {
    const p = props(['w_salida', 'w_creede'], {}, [], { w_salida: 1.5 });
    const tree = render(p);
    expect(allText(tree)).toContain('1½ days');
    act(() => control(tree, 'More zero days at Salida').onPress());
    expect(p.onZeroDays).toHaveBeenCalledWith('w_salida', 1);

    // Monarch Pass is undecided by default: no stepper there, only Creede's.
    const undecided = render(props(undefined));
    const stepperLabels = undecided.root
      .findAllByType(Text)
      .filter((n) => n.props.children === 'Zero days');
    expect(stepperLabels).toHaveLength(1);
  });

  it('opens the inputs and clears the choices', () => {
    const p = props(['w_salida']);
    const tree = render(p);
    act(() => control(tree, 'Resupply inputs').onPress());
    expect(p.onEditInputs).toHaveBeenCalled();
    act(() => control(tree, 'Clear choices').onPress());
    expect(p.onReset).toHaveBeenCalled();
  });

  it('hides Clear choices until a selection is stored', () => {
    const tree = render(props(undefined, { planMade: false }));
    expect(() => control(tree, 'Clear choices')).toThrow();
  });

  it('names places inside a turn-off without repeating it, and an undecided stop by its group', () => {
    const cdtGroups = listResupplyOptions([
      {
        id: 'w_store',
        name: 'Monarch Pass (Monarch Crest Store)',
        type: 'resupply',
        totalDistance: 100,
        accessName: 'Monarch Pass (US 50)',
      },
      {
        id: 'w_salida',
        name: 'Salida (access: Monarch Pass (US 50))',
        type: 'town-access',
        totalDistance: 100,
        offTrailKm: 1.4,
        accessMode: 'foot',
        accessName: 'Monarch Pass (US 50)',
      },
    ]);
    const legs = [
      leg(0, 100, {
        toName: 'Monarch Pass (Monarch Crest Store) / Salida (access: Monarch Pass (US 50))',
        sideTripKm: 2.8,
      }),
    ];
    const tree = render({
      ...props(undefined),
      rows: plannerRows(cdtGroups, undefined, legs, range, undefined),
    });
    const text = allText(tree);
    expect(text).toContain('Monarch Crest Store');
    expect(text).not.toContain('(access:');
    expect(text).toContain('Trail Start → Monarch Pass (US 50) (not decided)');
    // An undecided stop's side trip goes to no one place.
    expect(text).toContain('incl. 2.8 km off trail and back');
    // A screen reader still hears the full name.
    expect(control(tree, 'Salida (access: Monarch Pass (US 50))').accessibilityState).toEqual({
      checked: false,
    });
  });

  it('heads a one-place turn-off with its short name and says where it leaves the route', () => {
    const chamaGroups = listResupplyOptions([
      {
        id: 'w_chama',
        name: 'Chama (access: Cumbres Pass (CO 17))',
        type: 'town-access',
        totalDistance: 100,
        offTrailKm: 19.3,
        accessMode: 'hitch',
        accessName: 'Cumbres Pass (CO 17)',
      },
    ]);
    const legs = [leg(0, 100, { toName: 'Chama (access: Cumbres Pass (CO 17))' })];
    const tree = render({
      ...props(undefined),
      rows: plannerRows(chamaGroups, undefined, legs, range, undefined),
    });
    const text = allText(tree);
    expect(text).toContain('Chama');
    expect(text).toContain('turn-off at Cumbres Pass (CO 17)');
    expect(text).toContain('Trail Start → Chama');
    expect(text).not.toContain('(access:');
    // The full name is what a screen reader hears, on the heading and the switch.
    const heading = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Chama (access: Cumbres Pass (CO 17))',
    );
    expect(heading.length).toBeGreaterThan(0);
    expect(control(tree, 'Resupply at Chama (access: Cumbres Pass (CO 17))').value).toBe(true);
  });

  it('keeps an option’s facts and More outside its radio, and reads the facts as its hint', () => {
    const tree = render(props(['w_salida']));
    const [radio] = tree.root.findAll(
      (n) =>
        n.props.accessibilityRole === 'radio' &&
        n.props.accessibilityLabel === 'Salida' &&
        typeof n.props.onPress === 'function',
    );
    expect(radio.props.accessibilityHint).toBe('Full resupply · 22.5 km hitch · Accepts boxes');
    // Nothing focusable or textual about the place is swallowed by the radio.
    const inside = radio.findAll(() => true).map((n) => n.props.accessibilityLabel);
    expect(inside).not.toContain('More about Salida');
    const texts: string[] = [];
    radio.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
    expect(texts.join('')).not.toContain('Full resupply');
    // …but both are on screen, More as its own button.
    expect(control(tree, 'More about Salida')).toBeDefined();
  });

  it('names the place or turn-off on every repeated control', () => {
    const tree = render(props(['w_salida', 'w_creede'], {}, [], { w_salida: 1 }));
    expect(control(tree, 'Fewer zero days at Salida')).toBeDefined();
    expect(control(tree, 'More zero days at Creede')).toBeDefined();
    expect(control(tree, 'None – carry through at Monarch Pass (US 50)')).toBeDefined();
  });

  it('re-renders only the rows an edit changed, though every row object is new', () => {
    const legs = [
      leg(0, 100, { toName: 'Salida' }),
      leg(100, 250, { fromName: 'Salida' }),
      leg(250, 300, { fromName: 'Creede', toName: 'Trail End' }),
    ];
    const base = props(['w_salida', 'w_creede'], {}, legs);
    mockUseTheme.mockClear();
    const tree = render(base);
    const first = mockUseTheme.mock.calls.length;

    // The same plan, rows rebuilt (as every edit rebuilds them): only the
    // header re-renders.
    const fresh = {
      ...base,
      rows: plannerRows(groups, ['w_salida', 'w_creede'], legs, range, undefined),
    };
    mockUseTheme.mockClear();
    act(() => tree.update(<ResupplyPlanner {...fresh} />));
    const same = mockUseTheme.mock.calls.length;
    expect(same).toBeLessThan(first / 2);

    // One group changed: that row re-renders, the rest do not.
    const changed = {
      ...base,
      rows: plannerRows(groups, ['w_salida', 'w_creede'], legs, range, { w_creede: 1 }),
    };
    mockUseTheme.mockClear();
    act(() => tree.update(<ResupplyPlanner {...changed} />));
    expect(mockUseTheme.mock.calls.length).toBeGreaterThan(same);
    expect(mockUseTheme.mock.calls.length).toBeLessThan(first);
  });

  it('follows the unit setting', () => {
    const text = allText(render(props(['w_salida'], { units: 'mi' })));
    expect(text).toContain('14.0 mi hitch');
  });
});

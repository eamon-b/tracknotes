/**
 * The resupply screen's view-model. What matters to a hiker: the screen reads
 * top to bottom as start → leg → stop → … → end, with each leg just above the
 * stop it arrives at; a group of several places with more than one still
 * ticked is "not decided", never a plan to visit both; and the controls' edits
 * build on the document they run against, not on what the screen last drew.
 */

import {
  listResupplyOptions,
  type ResupplyCandidateWaypoint,
  type ResupplyLeg,
  type ResupplyPlanSummary,
} from '@lib/resupply-plan';
import type { PlanDocument } from '@lib/plan-types';
import {
  chooseResupplyEditor,
  formatZeroDays,
  optionFacts,
  plannerRows,
  resupplyEntryText,
  resupplyInputsLine,
  stepZeroDays,
  undecidedCount,
  waypointResupplyEditor,
  zeroDaysStepEditor,
  ZERO_DAYS_MAX,
  type PlannerRange,
  type PlannerRow,
} from '../resupply-planner';

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
  { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
];

const groups = listResupplyOptions(waypoints);
const whole: PlannerRange = {
  startKm: 0,
  endKm: 300,
  startName: 'Trail start',
  endName: 'Trail end',
};

function leg(fromKm: number, toKm: number, over: Partial<ResupplyLeg> = {}): ResupplyLeg {
  return {
    fromName: fromKm === 0 ? 'Trail Start' : `km ${fromKm}`,
    toName: toKm === 300 ? 'Trail End' : `km ${toKm}`,
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
    estimatedDays: 3,
    isLong: false,
    ascentM: 1000,
    descentM: 900,
    estimatedHours: 20,
    food: { weightGrams: 2040, weightKg: 2, days: 3 },
    ...over,
  };
}

/** A compact picture of the rows: 'start', 'leg 0→100', 'group w_pass', … */
function shape(rows: PlannerRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'leg') return `leg ${row.leg.fromKm}→${row.leg.toKm}`;
    if (row.kind === 'group') return `group ${row.group.key}${row.inSection ? '' : ' (outside)'}`;
    return row.kind;
  });
}

function plan(over: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'p1',
    trailId: 'cdt',
    name: 'CDT',
    direction: 'NOBO',
    startDate: null,
    stops: [],
    updatedAt: '2026-10-01T00:00:00Z',
    version: 1,
    ...over,
  };
}

describe('plannerRows', () => {
  it('interleaves each leg just above the stop it arrives at', () => {
    const legs = [leg(0, 100), leg(100, 250), leg(250, 300)];
    expect(shape(plannerRows(groups, undefined, legs, whole, undefined))).toEqual([
      'start',
      'leg 0→100',
      'group w_pass',
      'leg 100→250',
      'group w_creede',
      'leg 250→300',
      'end',
    ]);
  });

  it('lists a group carried through without a leg of its own', () => {
    const legs = [leg(0, 250), leg(250, 300)];
    expect(shape(plannerRows(groups, ['w_creede'], legs, whole, undefined))).toEqual([
      'start',
      'group w_pass',
      'leg 0→250',
      'group w_creede',
      'leg 250→300',
      'end',
    ]);
  });

  it('shows groups outside the section where they fall, dimmed and with no leg', () => {
    const range = { startKm: 120, endKm: 240, startName: 'A', endName: 'B' };
    const legs = [leg(120, 240)];
    expect(shape(plannerRows(groups, undefined, legs, range, undefined))).toEqual([
      'group w_pass (outside)',
      'start',
      'leg 120→240',
      'end',
      'group w_creede (outside)',
    ]);
  });

  it('reads each group’s choice and the chosen option’s zero days', () => {
    const rows = plannerRows(groups, ['w_salida', 'w_creede'], [], whole, {
      w_salida: 1.5,
      w_creede: -2,
    });
    const byKey = new Map(
      rows.flatMap((row) => (row.kind === 'group' ? [[row.group.key, row] as const] : [])),
    );
    expect(byKey.get('w_pass')).toMatchObject({
      choice: { kind: 'chosen', optionId: 'w_salida' },
      zeroDays: 1.5,
    });
    // Unusable stored figures read as none, as the calculator reads them.
    expect(byKey.get('w_creede')).toMatchObject({ zeroDays: 0 });
  });

  it('keeps no zero days on a group that is not decided', () => {
    const rows = plannerRows(groups, undefined, [], whole, { w_salida: 2 });
    const pass = rows.find((row) => row.kind === 'group' && row.group.key === 'w_pass');
    expect(pass).toMatchObject({ choice: { kind: 'undecided' }, zeroDays: 0 });
  });
});

describe('undecidedCount', () => {
  it('counts groups with more than one place still ticked, the default included', () => {
    expect(undecidedCount(groups, undefined, null)).toBe(1);
    expect(undecidedCount(groups, ['w_salida'], null)).toBe(0);
    expect(undecidedCount(groups, [], null)).toBe(0);
  });

  it('counts only the section', () => {
    expect(undecidedCount(groups, undefined, { startKm: 200, endKm: 300 })).toBe(0);
  });
});

describe('resupplyEntryText', () => {
  const summary = (over: Partial<ResupplyPlanSummary> = {}): ResupplyPlanSummary => ({
    stopsChosen: 5,
    longestLegKm: 180,
    mostClimbM: 4200,
    longestCarryDays: 7,
    heaviestFoodKg: 4.8,
    totalWalkingKm: 900,
    totalDays: 40,
    zeroDays: 3,
    hasData: true,
    ...over,
  });

  it('gives the stops and the longest carry', () => {
    expect(resupplyEntryText(summary(), { hasOptions: true, undecided: 0 })).toBe(
      '5 stops · longest 7 days',
    );
    expect(
      resupplyEntryText(summary({ stopsChosen: 1, longestCarryDays: 1 }), {
        hasOptions: true,
        undecided: 0,
      }),
    ).toBe('1 stop · longest 1 day');
  });

  it('says how many turn-offs are still to decide', () => {
    expect(resupplyEntryText(summary(), { hasOptions: true, undecided: 2 })).toBe(
      '5 stops · longest 7 days · 2 to decide',
    );
  });

  it('calls no stop a full carry, and tells a trail with no resupply apart', () => {
    expect(resupplyEntryText(summary({ stopsChosen: 0 }), { hasOptions: true, undecided: 0 })).toBe(
      'No stops · full carry 7 days',
    );
    expect(
      resupplyEntryText(summary({ stopsChosen: 0 }), { hasOptions: false, undecided: 0 }),
    ).toBe('No resupply on this trail · full carry 7 days');
  });
});

describe('optionFacts', () => {
  const km = (value: number) => `${value.toFixed(1)} km`;
  const [salida, pass] = [groups[0].options[1], groups[0].options[0]];

  it('says what the place sells, how it is reached, and whether it takes boxes', () => {
    expect(optionFacts(salida, km)).toEqual({
      store: 'Full resupply',
      access: '22.5 km hitch',
      acceptsBoxes: true,
      lead: 'Leave the CDT here for Salida.',
      more: 'Leave the CDT here for Salida. Safeway and hot springs.',
    });
  });

  it('says "On trail" and nothing it does not know', () => {
    expect(optionFacts(pass, km)).toEqual({
      store: null,
      access: 'On trail',
      acceptsBoxes: false,
      lead: '',
      more: null,
    });
  });
});

describe('zero days', () => {
  it('steps in half days between 0 and the ceiling', () => {
    expect(stepZeroDays(0, 1)).toBe(0.5);
    expect(stepZeroDays(0.5, 1)).toBe(1);
    expect(stepZeroDays(0, -1)).toBe(0);
    expect(stepZeroDays(ZERO_DAYS_MAX, 1)).toBe(ZERO_DAYS_MAX);
    // An off-grid figure from elsewhere snaps first.
    expect(stepZeroDays(1.3, 1)).toBe(2);
  });

  it('words them', () => {
    expect(formatZeroDays(0)).toBe('None');
    expect(formatZeroDays(0.5)).toBe('½ day');
    expect(formatZeroDays(1)).toBe('1 day');
    expect(formatZeroDays(2.5)).toBe('2½ days');
  });

  it('steps from the figure the document holds when the edit runs', () => {
    const edit = zeroDaysStepEditor('w_creede', 1);
    const once = edit(plan());
    expect(once.resupplyZeroDays).toEqual({ w_creede: 0.5 });
    expect(edit(once).resupplyZeroDays).toEqual({ w_creede: 1 });
  });
});

describe('chooseResupplyEditor', () => {
  it('picks one place in a group, keeping every other group as it read', () => {
    const next = chooseResupplyEditor(groups, 'w_pass', 'w_salida', () => undefined)(plan());
    expect(next.resupplyStops).toEqual(['w_salida', 'w_creede']);
  });

  it('carries a group through with null', () => {
    const next = chooseResupplyEditor(groups, 'w_creede', null, () => undefined)(plan());
    expect(next.resupplyStops).toEqual(['w_pass', 'w_salida']);
  });

  it('starts from a selection an older build left on the device', () => {
    const next = chooseResupplyEditor(groups, 'w_pass', 'w_salida', () => ['w_pass'])(plan());
    expect(next.resupplyStops).toEqual(['w_salida']);
  });

  it('prefers the document’s selection over the device-local one', () => {
    const next = chooseResupplyEditor(groups, 'w_pass', null, () => ['w_pass'])(
      plan({ resupplyStops: ['w_salida', 'w_creede'] }),
    );
    expect(next.resupplyStops).toEqual(['w_creede']);
  });
});

describe('waypointResupplyEditor', () => {
  const none = () => undefined;

  it('plans a place by choosing it in its group', () => {
    expect(waypointResupplyEditor(groups, 'w_salida', true, none)(plan()).resupplyStops).toEqual([
      'w_salida',
      'w_creede',
    ]);
  });

  it('removes the chosen place by carrying the group through', () => {
    const next = waypointResupplyEditor(
      groups,
      'w_salida',
      false,
      none,
    )(plan({ resupplyStops: ['w_salida', 'w_creede'] }));
    expect(next.resupplyStops).toEqual(['w_creede']);
  });

  it('is Yes/No on a lone place', () => {
    const off = waypointResupplyEditor(groups, 'w_creede', false, none)(plan());
    expect(off.resupplyStops).toEqual(['w_pass', 'w_salida']);
    expect(waypointResupplyEditor(groups, 'w_creede', true, none)(off).resupplyStops).toEqual([
      'w_pass',
      'w_salida',
      'w_creede',
    ]);
  });

  it('takes a single tick out of an undecided group', () => {
    const next = waypointResupplyEditor(groups, 'w_salida', false, none)(plan());
    expect(next.resupplyStops).toEqual(['w_pass', 'w_creede']);
  });

  it('leaves the plan alone for an id no group offers', () => {
    const doc = plan();
    expect(waypointResupplyEditor(groups, 'w_nowhere', true, none)(doc)).toBe(doc);
  });

  it('builds on the device-local selection while the document has none', () => {
    const next = waypointResupplyEditor(groups, 'w_salida', true, () => ['w_pass'])(plan());
    expect(next.resupplyStops).toEqual(['w_salida']);
  });
});

describe('resupplyInputsLine', () => {
  it('names every figure the legs were measured with, in the hiker’s units', () => {
    const inputs = {
      pace: 'average' as const,
      dailyHours: 8,
      foodGramsPerDay: 680,
      longCarryDays: 5,
    };
    expect(resupplyInputsLine(inputs, 'km')).toBe(
      'Average pace · 8 h/day · 680 g food/day · long carry over 5 days',
    );
    expect(resupplyInputsLine(inputs, 'mi')).toContain('24.0 oz food/day');
  });
});

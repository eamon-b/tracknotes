/**
 * The resupply page's view model and markup, from the shared calculators'
 * real output over a small hand-checked trail — the same fixture as the
 * planner's Resupply-tab tests:
 *
 *     km      0     10     20     30     40     50
 *     ele     0    100    300    200    600    700
 *
 *     w_001  Alpha    town          km 10      on trail, full resupply
 *     w_002  Bravo    town-access   km 20    ┐ one turn-off, "Mill Road": a
 *     w_003  Charlie  food          km 20.05 ┘ decision (one of them, or none);
 *                                              named "Charlie (access: Mill Road)"
 *     w_004  Delta    resupply      km 30      a long description
 *     w_005  Echo     town          km 40
 */

import { describe, it, expect } from 'vitest';
import {
  computeResupplyLegs,
  listResupplyOptions,
  resolveResupplyStops,
  resupplyCandidates,
  summariseResupplyPlan,
} from '@lib/resupply-plan';
import { PACE_KMH } from '@lib/plan-types';
import {
  accessModeText,
  buildResupplyView,
  renderResupplySummary,
  renderResupplyTable,
  type ResupplyView,
} from './resupply-view';

function makeTrail() {
  const ELE = [0, 100, 300, 200, 600, 700];
  const points = ELE.map((ele, i) => ({ lat: -34 - i / 100, lon: 138 + i / 100, ele, dist: i * 10 }));
  const wp = (id: string, name: string, type: string, totalDistance: number, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    type,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
    totalDistance,
    ...extra,
  });
  return {
    config: { id: 'resupply-view-fixture', name: 'Fixture' },
    track: { points, totalDistance: 50, totalAscent: 800, totalDescent: 100 },
    waypoints: [
      wp('w_001', 'Alpha', 'town', 10, { store: 'full' }),
      wp('w_002', 'Bravo <b>', 'town-access', 20, {
        accessName: 'Mill Road',
        offTrailKm: 22,
        accessMode: 'hitch',
        acceptsBoxes: true,
        store: 'limited',
        description: 'General store and post office. Closed Sundays.',
      }),
      wp('w_003', 'Charlie (access: Mill Road)', 'food', 20.05, {
        accessName: 'Mill Road',
        offTrailKm: 1.4,
        accessMode: 'foot',
      }),
      wp('w_004', 'Delta', 'resupply', 30, { description: 'Store beside U.S. 50 with a hiker box. Closed Mondays.' }),
      wp('w_005', 'Echo', 'town', 40),
    ],
  };
}

const trail = makeTrail();
const groups = listResupplyOptions(resupplyCandidates(trail));

function viewFor(selected: string[] | undefined, zeroDays?: Record<string, number>): ResupplyView {
  const legs = computeResupplyLegs(trail, resolveResupplyStops(groups, selected), {
    dailyHours: 8,
    baseKmh: PACE_KMH.average,
    longThresholdDays: 5,
    gramsPerDay: 800,
    zeroDays,
  });
  return buildResupplyView({ groups, selectedIds: selected, legs, zeroDays, totalKm: 50 });
}

const tableDom = (html: string): HTMLElement => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

const render = (view: ResupplyView): HTMLElement =>
  tableDom(renderResupplyTable(view, { mapHref: id => `plan.html?focus=${id}` }));

describe('buildResupplyView', () => {
  it('reads a fresh plan as every single-option stop chosen and the decision open', () => {
    const view = viewFor(undefined);
    expect(view.groups.map(row => row.choice.kind)).toEqual(['chosen', 'undecided', 'chosen', 'chosen']);
    expect(view.undecidedCount).toBe(1);

    // The undecided group's leg sits on the group, not on either option.
    const mill = view.groups[1];
    expect(mill.isDecision).toBe(true);
    expect(mill.undecidedLeg?.toKm).toBe(20);
    expect(mill.options.every(option => option.leg === null && !option.chosen)).toBe(true);

    expect(view.groups[0].options[0].leg?.fromName).toBe('Trail Start');
    expect(view.endLeg?.fromName).toBe('Echo');
  });

  it('puts each leg on the stop it arrives at, measured from the previous chosen stop', () => {
    // Bravo at Mill Road, carry through Delta.
    const view = viewFor(['w_001', 'w_002', 'w_005']);
    const [alpha, mill, delta, echo] = view.groups;

    expect(mill.choice).toEqual({ kind: 'chosen', optionId: 'w_002' });
    const bravo = mill.options.find(option => option.option.id === 'w_002')!;
    expect(bravo.chosen).toBe(true);
    expect(bravo.leg?.fromName).toBe('Alpha');
    // A hitch is reported, never walked.
    expect(bravo.leg?.rides).toEqual([{ km: 22, end: 'to', mode: 'hitch' }]);

    expect(delta.choice.kind).toBe('none');
    expect(delta.options[0].leg).toBeNull();
    // Echo's leg runs from Mill Road straight past Delta.
    expect(echo.options[0].leg?.distanceKm).toBe(20);
    expect(alpha.options[0].leg?.distanceKm).toBe(10);
    expect(view.undecidedCount).toBe(0);
  });

  it('carries the zero days a stop was given', () => {
    const view = viewFor(['w_001', 'w_003', 'w_005'], { w_001: 1.5, w_002: 2 });
    expect(view.groups[0].options[0].zeroDays).toBe(1.5);
    expect(view.groups[0].options[0].leg?.zeroDays).toBe(1.5);
    // Bravo's stored value stays with Bravo; Charlie is the choice.
    expect(view.groups[1].options.map(option => option.zeroDays)).toEqual([2, 0]);
  });
});

describe('renderResupplyTable', () => {
  it('draws the decision as radios, "none" included, and says it is not decided', () => {
    const dom = render(viewFor(undefined));
    const mill = dom.querySelector<HTMLElement>('tbody.rs-group.is-decision')!;
    expect(mill.dataset.groupKey).toBe(groups[1].key);
    expect(mill.classList.contains('is-undecided')).toBe(true);
    expect(mill.textContent).toContain('Not decided yet');
    expect(mill.textContent).toContain('Mill Road');

    const radios = [...mill.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => radio.value)).toEqual(['w_002', 'w_003', '']);
    expect(radios.some(radio => radio.checked)).toBe(false);
    expect(mill.querySelector('.rs-none')?.textContent).toContain('None – carry through');
    // The leg the open decision implies is shown on its header row: 10 km of
    // trail plus the longest walk among the ticked places (Charlie, 1.4 km each way).
    expect(mill.querySelector('.rs-group-head .rs-c-leg .rs-figure')?.textContent).toBe('12.8');
  });

  it('names options inside a decision without repeating the turn-off, the full name as a tooltip', () => {
    const name = render(viewFor(undefined)).querySelector<HTMLElement>('tr[data-option-id="w_003"] .rs-name')!;
    expect(name.textContent).toBe('Charlie');
    expect(name.title).toBe('Charlie (access: Mill Road)');
  });

  it('shortens a one-place turn-off and says where it leaves the route', () => {
    const access = {
      config: { id: 'turn-off-fixture', name: 'Fixture' },
      track: trail.track,
      waypoints: [
        {
          id: 'w_chama',
          name: 'Chama (access: Cumbres Pass (CO 17))',
          type: 'town-access',
          lat: -34.01,
          lon: 138.01,
          totalDistance: 10,
          accessName: 'Cumbres Pass (CO 17)',
          offTrailKm: 19.3,
          accessMode: 'hitch' as const,
        },
      ],
    };
    const one = listResupplyOptions(resupplyCandidates(access));
    const legs = computeResupplyLegs(access, resolveResupplyStops(one, undefined), {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      longThresholdDays: 5,
      gramsPerDay: 800,
    });
    const dom = render(
      buildResupplyView({ groups: one, selectedIds: undefined, legs, zeroDays: undefined, totalKm: 50 })
    );
    const row = dom.querySelector('tr[data-option-id="w_chama"]')!;
    const name = row.querySelector<HTMLElement>('.rs-name')!;
    expect(name.textContent).toBe('Chama');
    expect(name.title).toBe('Chama (access: Cumbres Pass (CO 17))');
    expect(row.querySelector('.rs-c-stop .rs-sub')?.textContent).toBe(
      'Town · turn-off at Cumbres Pass (CO 17) show on map'
    );
    expect(dom.querySelector('.rs-end .rs-c-leg')?.textContent).toContain('from Chama');
  });

  it('calls an undecided stop by its group on the legs either side of it', () => {
    const dom = render(viewFor(undefined));
    const head = dom.querySelector('.rs-group-head .rs-c-leg')!;
    // The walk counted is the longest of the places still ticked: no name for it.
    expect(head.textContent).toContain('incl. 2.8 km off trail and back');
    expect(head.textContent).not.toContain('Charlie');
    const delta = dom.querySelector('tr[data-option-id="w_004"] .rs-c-leg')!;
    expect(delta.textContent).toContain('from Mill Road (not decided)');
    expect(delta.textContent).not.toContain('Bravo');
  });

  it('draws a single-option stop as Yes / No', () => {
    const dom = render(viewFor(['w_002', 'w_005']));
    const alpha = dom.querySelector<HTMLElement>('tr[data-option-id="w_001"]')!;
    const radios = [...alpha.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => [radio.value, radio.checked])).toEqual([
      ['w_001', false],
      ['', true],
    ]);
    expect(alpha.querySelector('.rs-c-go')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Yes No');
  });

  it('shows store, off-trail km, access and boxes per option, and nothing for what the data does not say', () => {
    const dom = render(viewFor(undefined));
    const cell = (id: string, col: string) =>
      (dom.querySelector(`tr[data-option-id="${id}"] .rs-c-${col}`)?.textContent ?? '').trim();

    expect(cell('w_001', 'store')).toBe('Full resupply');
    expect(cell('w_001', 'off')).toBe('');
    expect(cell('w_001', 'access')).toBe('On trail');
    expect(cell('w_002', 'store')).toBe('Small store');
    expect(cell('w_002', 'off')).toBe('22.0');
    expect(cell('w_002', 'access')).toBe('Hitch');
    expect(cell('w_002', 'boxes')).toBe('Yes');
    expect(cell('w_003', 'access')).toBe('Walk');
    expect(cell('w_005', 'store')).toBe('');
    expect(cell('w_005', 'boxes')).toBe('');
  });

  it('escapes names from the data and links each stop to the planner', () => {
    const html = renderResupplyTable(viewFor(undefined), { mapHref: id => `plan.html?focus=${id}` });
    expect(html).not.toContain('Bravo <b>');
    expect(html).toContain('Bravo &lt;b&gt;');
    const dom = tableDom(html);
    const link = dom.querySelector<HTMLAnchorElement>('tr[data-option-id="w_004"] .rs-map-link')!;
    expect(link.getAttribute('href')).toBe('plan.html?focus=w_004');
    expect(link.textContent).toBe('show on map');
  });

  it('gives the lead sentence, with the full description behind it', () => {
    const dom = render(viewFor(undefined));
    const notes = dom.querySelector('tr[data-option-id="w_004"] details.rs-notes')!;
    expect(notes.querySelector('summary')?.textContent).toBe('Store beside U.S. 50 with a hiker box.');
    expect(notes.querySelector('p')?.textContent).toBe('Store beside U.S. 50 with a hiker box. Closed Mondays.');
  });

  it('offers zero days only at a chosen stop', () => {
    const dom = render(viewFor(['w_001', 'w_003', 'w_005'], { w_001: 1.5 }));
    const inputs = [...dom.querySelectorAll<HTMLInputElement>('input.rs-zero')];
    expect(inputs.map(input => input.dataset.optionId)).toEqual(['w_001', 'w_003', 'w_005']);
    expect(inputs[0].value).toBe('1.5');
    expect(inputs[0].step).toBe('0.5');
  });

  it('words the side trip and the ride under the leg', () => {
    const charlie = render(viewFor(['w_003'])).querySelector('tr[data-option-id="w_003"] .rs-c-leg')!;
    expect(charlie.textContent).toContain('incl. 2.8 km to Charlie and back');
    const bravo = render(viewFor(['w_002'])).querySelector('tr[data-option-id="w_002"] .rs-c-leg')!;
    expect(bravo.textContent).toContain('22.0 km hitch in, not walked');
  });

  it('starts at the trail start and ends with the carry to the trail end', () => {
    const dom = render(viewFor(['w_001']));
    const end = dom.querySelector('.rs-end')!;
    expect(end.textContent).toContain('Trail End');
    expect(end.querySelector('.rs-c-leg .rs-figure')?.textContent).toBe('40.0');
    expect(dom.querySelector('.rs-start')?.textContent).toContain('Trail Start');
  });

  it('labels every cell for the stacked phone layout', () => {
    const dom = render(viewFor(undefined));
    const labels = [...dom.querySelectorAll('tr[data-option-id="w_001"] td')].map(td => td.getAttribute('data-label'));
    expect(labels).toContain('Zero days');
    expect(labels).toContain('Food kg');
    expect(labels.every(label => label)).toBe(true);
  });
});

describe('renderResupplySummary', () => {
  it('shows the plan figures and counts the open decisions', () => {
    const view = viewFor(undefined, { w_001: 1 });
    const legs = computeResupplyLegs(trail, resolveResupplyStops(groups, undefined), {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      longThresholdDays: 5,
      gramsPerDay: 800,
      zeroDays: { w_001: 1 },
    });
    const dom = tableDom(renderResupplySummary(summariseResupplyPlan(legs), view.undecidedCount));
    const tiles = [...dom.querySelectorAll('.rs-tile')].map(tile => ({
      label: tile.querySelector('.rs-tile-label')?.textContent,
      value: tile.querySelector('.rs-tile-value')?.textContent,
      note: tile.querySelector('.rs-tile-note')?.textContent ?? '',
    }));
    expect(tiles.map(tile => tile.label)).toEqual([
      'Stops chosen',
      'Longest leg',
      'Most climbing on a leg',
      'Longest carry',
      'Heaviest food carry',
      'Total walking',
      'Total days',
    ]);
    expect(tiles[0].value).toBe('4');
    expect(tiles[6].note).toBe('incl. 1 zero day');
    expect(dom.querySelector('.rs-open-note')?.textContent).toContain('1 decision not made yet');
  });
});

describe('Clear choices', () => {
  it('sits beside the open-decisions warning only when there is something to clear', () => {
    const legs = computeResupplyLegs(trail, resolveResupplyStops(groups, undefined), {
      dailyHours: 8,
      baseKmh: PACE_KMH.average,
      longThresholdDays: 5,
      gramsPerDay: 800,
    });
    const summary = summariseResupplyPlan(legs);
    expect(tableDom(renderResupplySummary(summary, 1)).querySelector('#rs-clear')).toBeNull();
    const dom = tableDom(renderResupplySummary(summary, 1, { canClear: true }));
    const row = dom.querySelector('.rs-open-row')!;
    expect(row.querySelector('.rs-open-note')).not.toBeNull();
    expect(row.querySelector('#rs-clear')?.textContent).toBe('Clear choices');
    expect(
      tableDom(renderResupplySummary(summary, 0, { canClear: true, readOnly: true })).querySelector('#rs-clear')
    ).toBeNull();
  });
});

describe('accessModeText', () => {
  it('names the way to the place, or says the data gives none', () => {
    const base = { id: 'x', name: 'X', type: 'town-access', km: 0 };
    expect(accessModeText(base)).toBe('On trail');
    expect(accessModeText({ ...base, offTrailKm: 3, accessMode: 'foot' })).toBe('Walk');
    expect(accessModeText({ ...base, offTrailKm: 30, accessMode: 'shuttle' })).toBe('Shuttle');
    expect(accessModeText({ ...base, offTrailKm: 30, accessMode: 'boat' })).toBe('Boat');
    expect(accessModeText({ ...base, offTrailKm: 30 })).toBe('Way not given (not walked)');
  });
});

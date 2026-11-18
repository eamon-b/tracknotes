/**
 * Day-split list smoke: it renders one card per computed day and surfaces the
 * subtle over-target hint only when a day's Naismith hours exceed the splitter's
 * snap window around the target (Decision 8). Theme is mocked (jest.setup.js);
 * only the text surface of the local react-test-renderer shim is used.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DaySplitList, dayPoiSummary } from '../DaySplitList';
import type { PlanDay } from '../plan-adapters';
import type { ComputedDay } from '@lib/plan-types';
import type { TrailPOI } from '@lib/trail-types';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('');
}

function day(overrides: Partial<PlanDay>): PlanDay {
  return {
    dayNumber: 1,
    startName: 'Start',
    endName: 'Camp',
    startKm: 0,
    endKm: 20,
    distanceKm: 20,
    ascentM: 100,
    descentM: 100,
    estimatedHours: 8,
    waterSources: 2,
    endKind: 'camp',
    ...overrides,
  };
}

function render(
  days: PlanDay[],
  unplanned?: ComputedDay | null,
  pois?: TrailPOI[],
  onDayPress?: (day: PlanDay) => void,
): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <DaySplitList
        days={days}
        unplanned={unplanned}
        units="km"
        pois={pois}
        onDayPress={onDayPress}
      />,
    );
  });
  return tree;
}

describe('DaySplitList', () => {
  it('renders a card per day with its route and est. time', () => {
    const tree = render([day({ dayNumber: 1 }), day({ dayNumber: 2, endName: 'Town' })]);
    const text = allText(tree);
    expect(text).toContain('Day 1');
    expect(text).toContain('Day 2');
    expect(text).toContain('8.0 h');
  });

  it('shows the date when the plan has a start date', () => {
    const tree = render([day({ date: '2026-10-01' }), day({ dayNumber: 2, date: '2026-10-02' })]);
    const text = allText(tree);
    expect(text).toContain('2026-10-01');
    expect(text).toContain('2026-10-02');
    // No start date, no date line.
    expect(allText(render([day({})]))).not.toContain('2026-');
  });

  it('states the daylight beside the date, in the estimate\u2019s own form, and a walk longer than it', () => {
    // Melbourne's latitude at midwinter: 9.5 h of daylight.
    const short = allText(
      render([day({ date: '2026-06-21', latitude: -37.81, estimatedHours: 8 })]),
    );
    expect(short).toContain('2026-06-21 · 9.5 h daylight');
    expect(short).not.toContain('more walking than daylight');

    const long = allText(
      render([day({ date: '2026-06-21', latitude: -37.81, estimatedHours: 11 })]),
    );
    expect(long).toContain('About 1.5 h more walking than daylight');
    // The difference of the two figures on the card, never finer than they are.
    expect(
      allText(render([day({ date: '2026-06-21', latitude: -37.81, estimatedHours: 9.6 })])),
    ).toContain('About 0.1 h more walking than daylight');

    // No start date: no daylight, whatever the latitude.
    const undated = allText(render([day({ latitude: -37.81, estimatedHours: 11 })]));
    expect(undated).not.toContain('daylight');
    // A date without a latitude shows the date alone.
    expect(allText(render([day({ date: '2026-06-21' })]))).not.toContain('daylight');
  });

  it('calls out the rest days taken at a day\u2019s end stop', () => {
    expect(allText(render([day({ endName: 'Salida', restDays: 1 })]))).toContain(
      '+1 rest day at Salida',
    );
    expect(allText(render([day({ endName: 'Salida', restDays: 3 })]))).toContain(
      '+3 rest days at Salida',
    );
    expect(allText(render([day({ restDays: 0 })]))).not.toContain('rest day');
  });

  it('renders a hand-picked stop plainly — no campsite claim', () => {
    const text = allText(render([day({ endKind: 'stop', endName: 'Ghost Town' })]));
    expect(text).toContain('Ghost Town');
    expect(text).not.toContain('⛺');
  });

  it('renders the empty state for no days', () => {
    const tree = render([]);
    expect(allText(tree)).toContain('Choose a section');
  });

  describe('the unplanned tail', () => {
    function tail(): ComputedDay {
      return day({
        dayNumber: 3,
        startName: 'Serpentine Chalet',
        endName: 'Redbank Gorge',
        startKm: 60,
        endKm: 145,
        distanceKm: 85,
        ascentM: 2100,
        estimatedHours: 29,
      });
    }

    function unplannedCards(tree: ReactTestRenderer) {
      return tree.root.findAll(
        (n) =>
          typeof (n as unknown as { type?: unknown }).type === 'string' &&
          n.props.accessibilityLabel === 'Not planned yet',
      );
    }

    it('renders a muted card after the planned days', () => {
      const tree = render([day({})], tail());
      expect(unplannedCards(tree)).toHaveLength(1);
      const text = allText(tree);
      expect(text).toContain('Day 1');
      expect(text).toContain('Not planned yet: Serpentine Chalet → Redbank Gorge');
      expect(text).toContain('85.0 km');
      expect(text).toContain('29.0 h of walking');
      // Not a day card, so no day number.
      expect(text).not.toContain('Day 3');
    });

    it('shows the card instead of the empty state when no day is planned', () => {
      const tree = render([], tail());
      expect(unplannedCards(tree)).toHaveLength(1);
      expect(allText(tree)).not.toContain('Choose a section');
    });

    it('is absent by default and for null', () => {
      expect(unplannedCards(render([day({})]))).toHaveLength(0);
      expect(unplannedCards(render([day({})], null))).toHaveLength(0);
      expect(allText(render([], null))).toContain('Choose a section');
    });
  });

  describe('what OSM knows of along each day', () => {
    const poi = (id: number, km: number, category: TrailPOI['category']): TrailPOI => ({
      id,
      type: 'node',
      category,
      lat: 0,
      lon: 0,
      name: null,
      tags: {},
      distanceAlongTrail: km,
      distanceFromTrail: 0,
    });
    const pois = [
      poi(1, 5, 'restaurant'),
      poi(2, 6, 'restaurant'),
      poi(3, 12, 'resupply'),
      poi(4, 15, 'water'),
      poi(5, 30, 'resupply'),
      { ...poi(6, 8, 'restaurant'), duplicateOf: 'w1' },
    ];

    it('counts each category on the day, shops first, duplicates left out', () => {
      expect(dayPoiSummary(pois, { startKm: 0, endKm: 20 })).toEqual({
        text: '🛒 1 · 🍽 2 · 💧 1',
        label: 'Resupply 1, Food & drink 2, Water 1',
      });
      expect(dayPoiSummary(pois, { startKm: 40, endKm: 60 })).toBeNull();
    });

    it('counts a POI at a stop on the day that ends there, not the next one too', () => {
      expect(dayPoiSummary(pois, { startKm: 0, endKm: 12 })?.text).toBe('🛒 1 · 🍽 2');
      expect(dayPoiSummary(pois, { startKm: 12, endKm: 20 }, { includeStart: false })?.text).toBe(
        '💧 1',
      );
      expect(dayPoiSummary(pois, { startKm: 12, endKm: 20 })?.text).toBe('🛒 1 · 💧 1');
    });

    it('puts the line on the card when POIs are given', () => {
      expect(allText(render([day({})], null, pois))).toContain(
        'Along the way (OSM): 🛒 1 · 🍽 2 · 💧 1',
      );
      expect(allText(render([day({})], null))).not.toContain('Along the way');
      expect(allText(render([day({ startKm: 40, endKm: 60 })], null, pois))).not.toContain(
        'Along the way',
      );
    });
  });
});

describe('opening a day', () => {
  const buttons = (tree: ReactTestRenderer) =>
    tree.root.findAll(
      (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    );

  it('opens the pressed day', () => {
    const onDayPress = jest.fn();
    const days = [day({ dayNumber: 1 }), day({ dayNumber: 2, endName: 'Town' })];
    const tree = render(days, null, undefined, onDayPress);
    const cards = buttons(tree);
    expect(cards).toHaveLength(2);
    act(() => (cards[1].props.onPress as () => void)());
    expect(onDayPress).toHaveBeenCalledWith(days[1]);
  });

  it('is not pressable without a handler, and the unplanned tail never is', () => {
    expect(buttons(render([day({})]))).toHaveLength(0);
    const tail: ComputedDay = { ...day({ dayNumber: 2, startKm: 20, endKm: 90 }) };
    expect(buttons(render([day({})], tail, undefined, jest.fn()))).toHaveLength(1);
  });
});

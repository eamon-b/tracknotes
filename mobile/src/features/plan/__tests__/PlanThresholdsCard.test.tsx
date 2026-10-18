/**
 * Mount smoke for the carry thresholds card: it shows each figure in the
 * hiker's unit, its steppers move in that unit, and they stop at the shared
 * bounds. Same renderer surface as PlanInputsCard.test.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_PLAN_THRESHOLDS, PLAN_THRESHOLD_BOUNDS } from '@lib/plan-types';
import { PlanThresholdsCard, stepThreshold } from '../PlanThresholdsCard';

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
  return texts.join('|');
}

function button(tree: ReactTestRenderer, accessibilityLabel: string) {
  return tree.root.findAll(
    (n) => n.props.accessibilityLabel === accessibilityLabel && typeof n.props.onPress === 'function',
  )[0];
}

function press(tree: ReactTestRenderer, accessibilityLabel: string): void {
  act(() => (button(tree, accessibilityLabel).props.onPress as () => void)());
}

function render(props: Partial<React.ComponentProps<typeof PlanThresholdsCard>> = {}) {
  const onChange = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <PlanThresholdsCard {...DEFAULT_PLAN_THRESHOLDS} units="km" onChange={onChange} {...props} />,
    );
  });
  return { tree, onChange };
}

describe('PlanThresholdsCard', () => {
  it('shows the three figures in metric', () => {
    const text = allText(render().tree);
    expect(text).toContain('15 km');
    expect(text).toContain('680 g');
    expect(text).toContain('5 days');
  });

  it('shows miles and ounces to an imperial hiker', () => {
    const text = allText(render({ units: 'mi' }).tree);
    expect(text).toContain('9.3 mi');
    expect(text).toContain('24.0 oz');
  });

  it('steps each figure in the stored unit', () => {
    const { tree, onChange } = render();
    press(tree, 'More dry-stretch distance');
    press(tree, 'Less food per day');
    press(tree, 'More long-carry days');
    expect(onChange.mock.calls).toEqual([
      ['dryStretchKm', 16],
      ['foodGramsPerDay', 660],
      ['longCarryDays', 6],
    ]);
  });

  it('steps a mile at a time for an imperial hiker', () => {
    const { tree, onChange } = render({ units: 'mi' });
    press(tree, 'More dry-stretch distance');
    // 15 km is 9.3 mi: snapped to 9, stepped to 10 mi, stored as 16.1 km.
    expect(onChange.mock.calls[0][1]).toBe(16.1);
  });

  it('keeps every step on the grid, so a figure stepped away from can be stepped back to', () => {
    // Down to the floor and back up returns to 680 g.
    let grams = DEFAULT_PLAN_THRESHOLDS.foodGramsPerDay;
    for (let i = 0; i < 30; i++) grams = Math.max(200, stepThreshold('foodGramsPerDay', grams, -1, 'km'));
    expect(grams).toBe(200);
    for (let i = 0; i < 24; i++) grams = stepThreshold('foodGramsPerDay', grams, 1, 'km');
    expect(grams).toBe(680);

    // A threshold set in miles snaps back onto whole km when stepped in km.
    expect(stepThreshold('dryStretchKm', 16.1, 1, 'km')).toBe(17);
    // Ounces store whole grams.
    expect(stepThreshold('foodGramsPerDay', 680, 1, 'mi')).toBe(709);
  });

  it('disables a stepper at its bound', () => {
    const { tree } = render({ longCarryDays: PLAN_THRESHOLD_BOUNDS.longCarryDays.min });
    expect(button(tree, 'Less long-carry days').props.disabled).toBe(true);
    expect(button(tree, 'More long-carry days').props.disabled).toBe(false);
  });
});

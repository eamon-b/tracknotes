/**
 * The Plan screen's "needs checking" card and day-card warning: the rows the
 * shared `planStopIssues` turns into (which day a placed stop ends; that an
 * unplaced one's nights are not in the dates), the card that lists them with a
 * Remove button, and the warning on the day a placed one ends. Theme is mocked;
 * only the text surface of the local react-test-renderer shim is used.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { StopIssue } from '@lib/plan-stop-issues';
import { stopIssuesNotice } from '@lib/plan-stop-issues';
import { dayEndWarning, stopIssueRows } from '../stop-issues';
import { StopIssuesCard } from '../StopIssuesCard';
import { DaySplitList } from '../DaySplitList';
import type { PlanDay } from '../plan-adapters';

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

const TOTAL = 100;

/** Old Camp ends a day at route km 15; Past the End has no place at all. */
const ISSUES: StopIssue[] = [
  {
    stop: { waypointId: 'w_gone', km: 15, name: 'Old Camp', nights: 1 },
    reason: 'waypoint-missing',
    routeKm: 15,
  },
  {
    stop: { km: 104, name: 'Past the End', nights: 2 },
    reason: 'off-route',
    routeKm: null,
  },
];

function day(overrides: Partial<PlanDay>): PlanDay {
  return {
    dayNumber: 1,
    startName: 'Start',
    endName: 'Camp',
    startKm: 0,
    endKm: 20,
    distanceKm: 20,
    ascentM: 0,
    descentM: 0,
    estimatedHours: 5,
    waterSources: 0,
    snappedToCamp: false,
    endKind: 'stop',
    ...overrides,
  };
}

const DAYS = [
  day({ dayNumber: 1, endKm: 8, endName: 'Camp 8' }),
  day({ dayNumber: 2, startKm: 8, endKm: 15, endName: 'Old Camp' }),
  day({ dayNumber: 3, startKm: 15, endKm: 100, endName: 'End', endKind: 'finish' }),
];

describe('stopIssueRows', () => {
  it('says which day a placed stop ends and that an unplaced one is not in the dates', () => {
    const rows = stopIssueRows(ISSUES, DAYS, 'NOBO', TOTAL);
    expect(rows.map((r) => [r.name, r.reason, r.where])).toEqual([
      ['Old Camp', 'This place is no longer in the trail data', 'Ends day 2'],
      ['Past the End', 'Past the end of the updated trail', '2 nights, not in the dates'],
    ]);
  });

  it('reads a placed stop in the direction walked', () => {
    // SOBO, route km 15 is active km 85.
    const sobo = [day({ dayNumber: 4, startKm: 70, endKm: 85, endName: 'Old Camp' })];
    expect(stopIssueRows(ISSUES, sobo, 'SOBO', TOTAL)[0].where).toBe('Ends day 4');
    expect(stopIssueRows(ISSUES, [], 'NOBO', TOTAL)[0].where).toBe('Outside the section shown');
  });
});

describe('dayEndWarning', () => {
  it('warns on the day a placed stop ends, and nowhere else', () => {
    const warn = dayEndWarning(ISSUES, 'NOBO', TOTAL);
    expect(warn(15)).toBe('This place is no longer in the trail data');
    expect(warn(8)).toBeNull();
    expect(warn(100)).toBeNull();
  });
});

describe('StopIssuesCard', () => {
  it('renders nothing when no stop needs checking', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<StopIssuesCard notice={null} rows={[]} onRemove={() => {}} />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('lists each stop with a Remove button that hands back the stop', () => {
    const removed: string[] = [];
    const rows = stopIssueRows(ISSUES, DAYS, 'NOBO', TOTAL);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <StopIssuesCard
          notice={stopIssuesNotice(ISSUES)}
          rows={rows}
          onRemove={(row) => removed.push(row.issue.stop.name)}
        />,
      );
    });
    const text = allText(tree);
    expect(text).toContain(
      '⚠ 2 stops need checking after a trail data update. 2 nights are left out of the dates until you move or remove them.',
    );
    expect(text).toContain('This place is no longer in the trail data · Ends day 2');
    expect(text).toContain('Past the end of the updated trail · 2 nights, not in the dates');

    // The shim repeats a prop down the composite and host layers: one label per row.
    const labelOf = (n: { props: Record<string, unknown> }) =>
      String(n.props.accessibilityLabel ?? '');
    const buttons = tree.root.findAll(
      (n) => typeof n.props.onPress === 'function' && labelOf(n).startsWith('Remove '),
    );
    expect([...new Set(buttons.map(labelOf))]).toEqual([
      'Remove Old Camp from the plan',
      'Remove Past the End from the plan',
    ]);
    const removePastTheEnd = buttons.find(
      (b) => labelOf(b) === 'Remove Past the End from the plan',
    );
    act(() => (removePastTheEnd!.props.onPress as () => void)());
    expect(removed).toEqual(['Past the End']);
  });

  it('offers no Remove on a plan the reader cannot edit', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <StopIssuesCard
          notice={stopIssuesNotice(ISSUES)}
          rows={stopIssueRows(ISSUES, DAYS, 'NOBO', TOTAL)}
        />,
      );
    });
    expect(tree.root.findAll((n) => n.props.accessibilityRole === 'button')).toHaveLength(0);
    expect(allText(tree)).not.toContain('Remove');
  });
});

describe('DaySplitList with stops that need checking', () => {
  it('warns on the card of the day that ends at one', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <DaySplitList
          days={DAYS}
          targetHours={8}
          units="km"
          endWarning={dayEndWarning(ISSUES, 'NOBO', TOTAL)}
        />,
      );
    });
    expect(allText(tree)).toContain('⚠ This place is no longer in the trail data');
    // Without the warnings the cards say nothing of it.
    act(() => {
      tree.update(<DaySplitList days={DAYS} targetHours={8} units="km" />);
    });
    expect(allText(tree)).not.toContain('⚠');
  });
});

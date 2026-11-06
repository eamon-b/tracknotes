/**
 * The Plan screen's Export card: both shares call through, the calendar is
 * disabled (and says why) without a start date, and a failure shows inline.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ICS_REEXPORT_NOTE } from '@lib/plan-export';
import { ICS_NEEDS_START_DATE, PlanExportCard } from '../PlanExportCard';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

function mount(props: React.ComponentProps<typeof PlanExportCard>): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<PlanExportCard {...props} />);
  });
  mounted = tree;
  return tree;
}

const text = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((n) => String(n.props.children))
    .join(' ');

const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];

async function press(r: ReactTestRenderer, label: string) {
  await act(async () => {
    (button(r, label).props.onPress as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('PlanExportCard', () => {
  it('shares GPX and the calendar', async () => {
    const onExport = jest.fn().mockResolvedValue(undefined);
    const r = mount({ canExportCalendar: true, onExport });
    await press(r, 'Share GPX');
    await press(r, 'Share calendar (.ics)');
    expect(onExport.mock.calls).toEqual([['gpx'], ['ics']]);
    expect(text(r)).not.toContain(ICS_NEEDS_START_DATE);
    // What a re-export leaves behind (#284).
    expect(text(r)).toContain(ICS_REEXPORT_NOTE);
  });

  it('disables the calendar without a start date, and says why', () => {
    const r = mount({ canExportCalendar: false, onExport: jest.fn() });
    expect(button(r, 'Share calendar (.ics)').props.disabled).toBe(true);
    expect(button(r, 'Share GPX').props.disabled).toBe(false);
    expect(text(r)).toContain(ICS_NEEDS_START_DATE);
    expect(text(r)).not.toContain(ICS_REEXPORT_NOTE);
  });

  it('shows a failure inline', async () => {
    const onExport = jest
      .fn()
      .mockRejectedValue(new Error('Sharing is not available on this device'));
    const r = mount({ canExportCalendar: true, onExport });
    await press(r, 'Share GPX');
    expect(text(r)).toContain('Sharing is not available on this device');
  });
});

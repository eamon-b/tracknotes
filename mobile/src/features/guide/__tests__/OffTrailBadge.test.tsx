/**
 * The off-trail badge: its wording in either unit, and that a place on the
 * trail gets none.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { OffTrailBadge, offTrailA11y, offTrailDistance, offTrailLabel } from '../OffTrailBadge';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: (_t, key) => `#${String(key)}` }) }),
}));

function render(metres: number | null): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<OffTrailBadge metres={metres} units="km" />);
  });
  return tree;
}

describe('offTrailLabel', () => {
  it('words a short walk in metres or feet, a long one in km or miles', () => {
    expect(offTrailLabel(350, 'km')).toBe('350 m off trail');
    expect(offTrailLabel(2500, 'km')).toBe('2.5 km off trail');
    expect(offTrailDistance(350, 'mi')).toMatch(/ft$/);
    expect(offTrailDistance(3219, 'mi')).toMatch(/mi$/);
  });
});

describe('offTrailA11y', () => {
  it("gives a row's label the badge's words, and nothing on the trail", () => {
    expect(offTrailA11y(1200, 'km')).toBe(', 1.2 km off trail');
    expect(offTrailA11y(30, 'km')).toBe('');
    expect(offTrailA11y(undefined, 'km')).toBe('');
  });
});

describe('OffTrailBadge', () => {
  it('draws the distance in the off-trail colour', () => {
    const [text] = render(1200).root.findAllByType(Text);
    expect(text.props.children).toBe('1.2 km off trail');
    expect([text.props.style].flat()).toContainEqual({ color: '#offTrail' });
  });

  it('draws nothing for a place on the trail or with no figure', () => {
    expect(render(30).toJSON()).toBeNull();
    expect(render(null).toJSON()).toBeNull();
  });
});

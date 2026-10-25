/**
 * The Plan screen's Resupply row: labelled, carrying the summary, one press.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ResupplyEntryRow } from '../ResupplyEntryRow';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function render(onPress: () => void): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ResupplyEntryRow summary="5 stops · longest 7 days" onPress={onPress} />,
    );
  });
  return tree;
}

describe('ResupplyEntryRow', () => {
  it('is a labelled button showing the summary', () => {
    const onPress = jest.fn();
    const tree = render(onPress);
    const texts = tree.root
      .findAll((n) => typeof n.props.children === 'string')
      .map((n) => n.props.children as string);
    expect(texts).toContain('Resupply');
    expect(texts).toContain('5 stops · longest 7 days');

    const [button] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Resupply' && typeof n.props.onPress === 'function',
    );
    act(() => (button.props.onPress as () => void)());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

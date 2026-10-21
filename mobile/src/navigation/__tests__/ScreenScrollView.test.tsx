/**
 * A screen's scroll content must end above the navigation bar. The Today
 * screen shipped with a bare FlatList, after the inset fix for the other
 * screens, and its last rows could not be scrolled into view; the screen
 * components pad every list the same way.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, ScrollView, SectionList, StyleSheet, Text, type ViewStyle } from 'react-native';
import { ScreenFlatList, ScreenScrollView, ScreenSectionList } from '../ScreenScrollView';

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

function paddingBottom(tree: ReactTestRenderer, type: React.ElementType): number | undefined {
  const style = StyleSheet.flatten<ViewStyle>(
    tree.root.findAllByType(type)[0].props.contentContainerStyle as ViewStyle,
  );
  return style?.paddingBottom as number | undefined;
}

let insets: jest.SpyInstance;
beforeEach(() => {
  insets = jest
    .spyOn(jest.requireMock('react-native-safe-area-context'), 'useSafeAreaInsets')
    .mockReturnValue({ top: 0, right: 0, bottom: 48, left: 0 });
});
afterEach(() => insets.mockRestore());

describe('screen scroll components', () => {
  it('ScreenScrollView pads its content for the bottom system bar', () => {
    const tree = render(
      <ScreenScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>row</Text>
      </ScreenScrollView>,
    );
    expect(paddingBottom(tree, ScrollView)).toBe(64);
  });

  it('ScreenFlatList pads its content for the bottom system bar', () => {
    const tree = render(
      <ScreenFlatList
        data={['a']}
        renderItem={({ item }) => <Text>{item}</Text>}
        contentContainerStyle={{ paddingBottom: 8 }}
      />,
    );
    expect(paddingBottom(tree, FlatList)).toBe(56);
  });

  it('ScreenSectionList pads unpadded content by the inset alone', () => {
    const tree = render(
      <ScreenSectionList
        sections={[{ data: ['a'] }]}
        renderItem={({ item }) => <Text>{item}</Text>}
      />,
    );
    expect(paddingBottom(tree, SectionList)).toBe(48);
  });

  it('forwards the ref to the list', () => {
    const ref = React.createRef<FlatList<string>>();
    render(<ScreenFlatList ref={ref} data={['a']} renderItem={({ item }) => <Text>{item}</Text>} />);
    expect(ref.current).toBeInstanceOf(FlatList);
  });
});

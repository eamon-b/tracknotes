/**
 * The scroll containers a screen is built on: a ScrollView, FlatList and
 * SectionList whose content is padded for the bottom system bar
 * (`bottom-inset.ts`), so the last item can always be scrolled clear of it.
 *
 * Android is edge-to-edge, so a screen's scroll view runs to the bottom of the
 * window, under the navigation bar. A bare `ScrollView` / `FlatList` there
 * stops its last rows under the bar: Settings' About card did, and then the
 * Today screen, added after that fix, did again, because the padding was a
 * hook each screen had to remember to call. Screens therefore never import
 * the bare components from `react-native` (lint-enforced in `app/` and in the
 * full-screen panes, see `eslint.config.js`); they use these, or
 * `KeyboardAwareScrollView` when they have a text field, which pads the same
 * way. A horizontal strip or a scroll inside a sheet is not a screen and keeps
 * the bare component.
 */

import type { Ref } from 'react';
import {
  FlatList,
  ScrollView,
  SectionList,
  type DefaultSectionT,
  type FlatListProps,
  type ScrollViewProps,
  type SectionListProps,
} from 'react-native';
import { useBottomInsetContentStyle } from './bottom-inset';

export function ScreenScrollView({
  contentContainerStyle,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  return (
    <ScrollView {...props} contentContainerStyle={useBottomInsetContentStyle(contentContainerStyle)} />
  );
}

export function ScreenFlatList<T>({
  contentContainerStyle,
  ...props
}: FlatListProps<T> & { ref?: Ref<FlatList<T>> }) {
  return (
    <FlatList<T> {...props} contentContainerStyle={useBottomInsetContentStyle(contentContainerStyle)} />
  );
}

export function ScreenSectionList<T, S = DefaultSectionT>({
  contentContainerStyle,
  ...props
}: SectionListProps<T, S> & { ref?: Ref<SectionList<T, S>> }) {
  return (
    <SectionList<T, S>
      {...props}
      contentContainerStyle={useBottomInsetContentStyle(contentContainerStyle)}
    />
  );
}

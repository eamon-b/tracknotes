/**
 * The sheet behind the map's credit label: who the base map, contours and this trail's
 * data come from (`credits/credits.ts`). A plain bottom-anchored `Modal`, like the
 * layers sheet beside it.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { CreditList } from '../../credits/CreditList';
import type { CreditLine } from '../../credits/credits';

export interface MapCreditsSheetProps {
  visible: boolean;
  onClose: () => void;
  lines: readonly CreditLine[];
}

export function MapCreditsSheet({ visible, onClose, lines }: MapCreditsSheetProps) {
  const { colors } = useTheme();
  const { bottom } = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        accessibilityRole="button"
        accessibilityLabel="Close map credits"
        onPress={onClose}
      >
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.surfaceElevated, paddingBottom: spacing.xl + bottom },
          ]}
          accessibilityViewIsModal
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>Map and data credits</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close map credits"
              style={({ pressed }) => [styles.done, pressed && styles.pressed]}
            >
              <Text style={[styles.doneText, { color: colors.accent }]}>Done</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} bounces={false}>
            <CreditList lines={lines} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.lg,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  title: { ...typography.titleLarge, flex: 1 },
  done: { minHeight: touchTarget.min, justifyContent: 'center', paddingHorizontal: spacing.sm },
  doneText: { ...typography.titleSmall },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  pressed: { opacity: 0.6 },
});

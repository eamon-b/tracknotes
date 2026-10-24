/**
 * "Show on map" from a screen above the guide: leave the place for the map
 * (`map-target`) and go back down to the guide, which shows it on the Map pane
 * with any walk in to it dotted. One hook, so the waypoint, POI, Today, Day and
 * Plan screens all go back the same way, and one compact icon button for rows
 * whose own tap already does something else.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { glyphSizes, spacing, touchTarget } from '../../tokens';
import type { MapPoint } from './GuideFocusContext';
import { requestMapTarget } from './map-target';

/** Show `point` on this trail's map, dismissing back to the guide. */
export function useShowOnMap(trailId: string): (point: MapPoint) => void {
  const router = useRouter();
  return useCallback(
    (point: MapPoint) => {
      requestMapTarget(trailId, point);
      router.dismissTo({ pathname: '/guide/[trailId]', params: { trailId } });
    },
    [router, trailId],
  );
}

/** A row's map-marker button; `name` is the place, for the spoken label. */
export function ShowOnMapIconButton({ name, onPress }: { name: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Show ${name} on map`}
      hitSlop={spacing.xs}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <MaterialCommunityIcons
        name="map-marker-outline"
        size={glyphSizes.lg}
        color={colors.accent}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: touchTarget.min,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});

/**
 * "From your location" card for the waypoint and POI detail screens: how far
 * the place is along the trail from the hiker's GPS position, the climb and
 * descent in the direction walked, and a Naismith time at the trail's pace.
 *
 * When the place is off the trail and the data has the walk in to it
 * (`@lib/day-calculator` `placeWalk`: its km and climb in), the climb and the
 * time include that walk, and the line under them says how far it is and what
 * it climbs. Otherwise — the hiker off the trail, a ride, or a place measured
 * only in a straight line — the card says how far rather than folding a walk
 * it cannot measure into the time. It never says "You are here" unless both
 * are on the line.
 *
 * Renders nothing without a usable fix.
 *
 * `along` measures on another line than the guide's main route: the route as
 * planned, for a place on an alternate the plan takes. Its `currentKm` is the
 * fix on that line (null when the hiker is not on it, and then there is no
 * card).
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { AccessMode } from '@lib/types';
import { estimateHikingTime, type PlaceWalk } from '@lib/day-calculator';
import { routeBreakStarts } from '@lib/route-breaks';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore, type Units } from '../../state/settings-store';
import { formatEtaMinutes } from '../../services/distance-calculator';
import type { TrailJson } from '../../services/trail-assets';
import { selectPaceBaseKmh, usePlanInputsStore } from '../plan/plan-inputs-store';
import { useGuide } from './GuideContext';
import { useGuidePositionContext } from './GuidePositionContext';
import { isPlaceOffTrail, tripToWaypoint } from './waypoint-detail';

export function TripCard({
  placeKm,
  placeOffTrailM,
  placeAccessMode,
  placeWalk,
  along,
}: {
  /** The place's km on the guide's direction-applied scale (or on `along`'s). */
  placeKm: number;
  /** How far the place sits from the trail line, in metres (null: unknown). */
  placeOffTrailM: number | null;
  /** How the data says that distance is covered, when it says (a turn-off's `accessMode`). */
  placeAccessMode?: AccessMode;
  /** The walk in from the route to the place (`placeWalk`), counted in the climb and time. */
  placeWalk?: PlaceWalk | null;
  /** Measure along this direction-applied trail, from this km of the fix on it. */
  along?: { trail: TrailJson; currentKm: number | null };
}) {
  const { colors } = useTheme();
  const { trailId, trail: guideTrail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const baseKmh = usePlanInputsStore(selectPaceBaseKmh(trailId));
  const position = useGuidePositionContext();
  const trail = along?.trail ?? guideTrail;
  // On another line the hiker is either on it (a km) or there is nothing to say.
  const status = along ? (along.currentKm != null ? 'fix' : 'acquiring') : position.status;
  const currentKm = along ? along.currentKm : position.currentKm;
  const offTrailMeters = along ? null : position.offTrailMeters;

  const hasFix = status === 'fix' || status === 'off-trail';
  const trip = useMemo(
    () =>
      hasFix && currentKm != null
        ? tripToWaypoint(
            currentKm,
            placeKm,
            trail.track.points,
            baseKmh,
            routeBreakStarts(trail.track.breaks, 'points'),
          )
        : null,
    [hasFix, currentKm, placeKm, trail, baseKmh],
  );

  if (!hasFix || currentKm == null) return null;

  const walk = placeWalk ?? null;
  const walkMinutes = walk
    ? estimateHikingTime(walk.km, walk.ascentM, walk.descentM, baseKmh) * 60
    : 0;

  const hikerOff = status === 'off-trail' && offTrailMeters != null;
  const placeOff = walk !== null || isPlaceOffTrail(placeOffTrailM);
  const heading = hikerOff ? 'From the nearest point on the trail' : 'From your location';
  // Level on the trail is only "here" when neither of you is off it.
  const levelLabel = hikerOff
    ? 'Level with you on the trail'
    : placeOff
      ? 'At its nearest point on the trail'
      : 'You are here';

  return (
    <View
      accessible
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.gps }]}
    >
      <Text style={[styles.label, { color: colors.textSecondary }]}>{heading}</Text>
      {trip ? (
        <View style={styles.row}>
          <Text style={[styles.distance, { color: colors.textPrimary }]}>
            {`${formatDistance(trip.distanceKm, units)} ${trip.direction}`}
          </Text>
          <Text
            style={[styles.value, { color: colors.textPrimary }]}
            accessibilityLabel={`${formatElevation(trip.ascentM + (walk?.ascentM ?? 0), units)} up`}
          >
            {`↑ ${formatElevation(trip.ascentM + (walk?.ascentM ?? 0), units)}`}
          </Text>
          <Text
            style={[styles.value, { color: colors.textPrimary }]}
            accessibilityLabel={`${formatElevation(trip.descentM + (walk?.descentM ?? 0), units)} down`}
          >
            {`↓ ${formatElevation(trip.descentM + (walk?.descentM ?? 0), units)}`}
          </Text>
          <Text style={[styles.value, { color: colors.textSecondary }]}>
            {formatEtaMinutes(trip.etaMinutes + walkMinutes)}
          </Text>
        </View>
      ) : (
        <Text style={[styles.distance, { color: colors.textPrimary }]}>{levelLabel}</Text>
      )}
      {hikerOff && (
        <Text style={[styles.note, { color: colors.textSecondary }]}>
          {`You are ${formatDistance(offTrailMeters / 1000, units, { decimals: 2 })} off the trail`}
        </Text>
      )}
      {walk ? (
        <Text style={[styles.note, { color: colors.offTrail }]}>
          {walkLine(walk, units, trip ? 'counted above' : formatEtaMinutes(walkMinutes))}
        </Text>
      ) : placeOff && placeOffTrailM != null && (
        <Text style={[styles.note, { color: colors.offTrail }]}>
          {`Then ${formatDistance(placeOffTrailM / 1000, units, { decimals: 2 })} ${beyondWord(placeAccessMode)} to reach it`}
        </Text>
      )}
    </View>
  );
}

/**
 * "Then 1.20 km off the trail to reach it, ↑ 80 m ↓ 10 m, counted above": the
 * walk in, with its climb, and either where its time went or its own time.
 */
function walkLine(walk: PlaceWalk, units: Units, tail: string): string {
  const climb = `↑ ${formatElevation(walk.ascentM, units)} ↓ ${formatElevation(walk.descentM, units)}`;
  return `Then ${formatDistance(walk.km, units, { decimals: 2 })} off the trail to reach it, ${climb}, ${tail}`;
}

/** "off the trail" on foot (or unsaid); "by hitch", "by shuttle", "by boat" otherwise. */
function beyondWord(mode: AccessMode | undefined): string {
  return mode === 'hitch' || mode === 'shuttle' || mode === 'boat' ? `by ${mode}` : 'off the trail';
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  label: { ...typography.caption },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: spacing.md,
    rowGap: spacing.xs,
  },
  distance: { ...typography.titleLarge, fontVariant: ['tabular-nums'] },
  value: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },
  note: { ...typography.caption },
});

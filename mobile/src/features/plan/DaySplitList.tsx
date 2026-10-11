/**
 * Day-split list — one card per computed day. Every number comes from the
 * shared day-calculator (`computeDays` → distance, ascent/descent, est. hours,
 * water-source count). The end indicator is keyed off the day's `endKind`: a
 * campsite/shelter (`camp`), any other place the hiker chose to stop (`stop`),
 * a wild camp the generator invented (`wild`), or the section finish (`finish`
 * — a town/hut/trailhead at the end).
 *
 * With a plan behind it each card also carries the day's date and, when the
 * hiker is staying more than one night at its end, the rest days that push
 * every later date along. A rest day is never a card of its own: it is a night
 * spent at a stop, not a day walked.
 *
 * Given the POIs the guide's filter shows, each card also says what
 * OpenStreetMap knows of along that day — "🛒 2 · 🍽 5 · 💧 3" — so a day with
 * no shop or café on it stands out while the plan is still being made. They are
 * counts of uncurated leads, labelled OSM, never folded into the day's figures.
 *
 * Given `onDayPress`, a card opens that day waypoint by waypoint (the Plan
 * screen's Day screen). The "not planned yet" tail is not a day and never opens.
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { ComputedDay } from '@lib/plan-types';
import { countPoisByCategory, POI_CATEGORY_LABELS, poisBetween } from '@lib/poi-display';
import type { TrailPOI, TrailPOICategory } from '@lib/trail-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { ThemeColors } from '../../tokens/themes';
import type { Units } from '../../state/settings-store';
import { planFloorHours, planWindowHours, type PlanDay } from './plan-adapters';
import { formatHours } from './plan-format';

/** One glyph per POI category, in the order a hiker scans for them. */
const POI_GLYPHS: { category: TrailPOICategory; glyph: string }[] = [
  { category: 'resupply', glyph: '🛒' },
  { category: 'restaurant', glyph: '🍽' },
  { category: 'water', glyph: '💧' },
  { category: 'camping', glyph: '⛺' },
  { category: 'transport', glyph: '🚌' },
  { category: 'emergency', glyph: '➕' },
];

/**
 * What OSM knows of along a day, as glyph counts and as words; null for nothing.
 *
 * `includeStart: false` leaves out the POIs at the day's start (within a
 * metre, as `poisBetween`): back-to-back days share that km, so every day
 * after the first passes it and a shop in the town a day ends at is counted
 * on that day alone.
 */
export function dayPoiSummary(
  pois: readonly TrailPOI[],
  day: Pick<ComputedDay, 'startKm' | 'endKm'>,
  { includeStart = true }: { includeStart?: boolean } = {},
): { text: string; label: string } | null {
  const lo = Math.min(day.startKm, day.endKm);
  const inDay = includeStart
    ? poisBetween(pois, day.startKm, day.endKm)
    : poisBetween(pois, day.startKm, day.endKm).filter((p) => p.distanceAlongTrail > lo + 0.001);
  const counts = countPoisByCategory(inDay);
  const present = POI_GLYPHS.filter(({ category }) => counts[category] > 0);
  if (present.length === 0) return null;
  return {
    text: present.map(({ category, glyph }) => `${glyph} ${counts[category]}`).join(' · '),
    label: present
      .map(({ category }) => `${POI_CATEGORY_LABELS[category]} ${counts[category]}`)
      .join(', '),
  };
}

/** Footer end-of-day label, keyed off the day's three-state `endKind`. */
function endLabel(day: PlanDay): string {
  switch (day.endKind) {
    case 'finish':
      return `🏁 ${day.endName}`;
    case 'camp':
      return `⛺ ${day.endName}`;
    case 'stop':
      return day.endName;
    default:
      return 'No campsite nearby — wild camp';
  }
}

/** Footer end-of-day color: finish reads positive, camp branded, wild muted. */
function endColor(day: PlanDay, colors: ThemeColors): string {
  switch (day.endKind) {
    case 'finish':
      return colors.success;
    case 'camp':
      return colors.waypointCamp;
    case 'stop':
      return colors.textPrimary;
    default:
      return colors.textSecondary;
  }
}

export function DaySplitList({
  days,
  unplanned = null,
  targetHours,
  units,
  pois,
  onDayPress,
}: {
  days: PlanDay[];
  /** Opens a day's waypoints. Absent: the cards are not pressable. */
  onDayPress?: (day: PlanDay) => void;
  /**
   * The POIs the guide's filter shows, on the days' km scale (`useVisiblePois`
   * over the route the plan walks). Absent: no "along the way" line.
   */
  pois?: readonly TrailPOI[];
  /**
   * The stretch after the last stop, when it is too long to be a day
   * (`@lib/plan-editor` `splitUnplannedTail`). Shown as one muted line rather
   * than a day card: a plan made a few days at a time has not decided it yet.
   */
  unplanned?: ComputedDay | null;
  targetHours: number;
  units: Units;
}) {
  const { colors } = useTheme();
  // Once per plan or filter change, not on every render: the Plan screen
  // re-renders on each GPS fix, and a long trail has thousands of POIs.
  const poiSummaries = useMemo(
    () =>
      pois === undefined
        ? null
        : days.map((day, i) => dayPoiSummary(pois, day, { includeStart: i === 0 })),
    [pois, days],
  );

  // A snapped camp can (rarely, by construction) push a day past the window the
  // splitter allows around the target. Surface that overshoot subtly so the card
  // stays honest about the terrain the hiker asked for. Each day is judged
  // against the allowance the splitter actually grants IT (Decision 8): interior
  // days may snap up to the window; the final day absorbs the remainder up to
  // the floor, which exceeds the window once the target passes 10 h.
  const windowH = planWindowHours(targetHours);
  const finishAllowanceH = Math.max(windowH, planFloorHours(targetHours));
  const allowanceFor = (day: PlanDay) =>
    targetHours + (day.endKind === 'finish' ? finishAllowanceH : windowH);

  if (days.length === 0 && unplanned === null) {
    return (
      <Text style={[styles.empty, { color: colors.textSecondary }]}>
        Choose a section with some distance to see day splits.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      {days.map((day, i) => (
        <Pressable
          key={day.dayNumber}
          onPress={onDayPress ? () => onDayPress(day) : undefined}
          disabled={!onDayPress}
          accessibilityRole={onDayPress ? 'button' : undefined}
          accessibilityHint={onDayPress ? "Shows the day's waypoints" : undefined}
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
            pressed && onDayPress && styles.pressed,
          ]}
        >
          <View style={styles.head}>
            <Text
              style={[styles.dayNum, { color: colors.accentText, backgroundColor: colors.accent }]}
            >
              Day {day.dayNumber}
            </Text>
            <Text style={[styles.route, { color: colors.textPrimary }]} numberOfLines={1}>
              {day.startName} → {day.endName}
            </Text>
            {onDayPress && (
              <Text
                style={[styles.chevron, { color: colors.textSecondary }]}
                importantForAccessibility="no"
                accessibilityElementsHidden
              >
                ›
              </Text>
            )}
          </View>

          {day.date !== undefined && (
            <Text style={[styles.date, { color: colors.textSecondary }]}>{day.date}</Text>
          )}

          <View style={styles.stats}>
            <Stat label="Distance" value={formatDistance(day.distanceKm, units)} />
            <Stat label="Ascent" value={`↑ ${formatElevation(day.ascentM, units)}`} />
            <Stat label="Descent" value={`↓ ${formatElevation(day.descentM, units)}`} />
            <Stat label="Est. time" value={formatHours(day.estimatedHours)} />
          </View>

          {day.offTrailKm !== undefined && day.offTrailKm > 0 && (
            <Text style={[styles.water, { color: colors.textSecondary }]}>
              {`Includes ${formatDistance(day.offTrailKm, units)} off the route, to or from a stop`}
            </Text>
          )}

          <View style={styles.footer}>
            <Text style={[styles.camp, { color: endColor(day, colors) }]}>{endLabel(day)}</Text>
            <Text style={[styles.water, { color: colors.textSecondary }]}>
              {day.waterSources} water source{day.waterSources === 1 ? '' : 's'}
            </Text>
          </View>

          {poiSummaries?.[i] && <AlongTheWay summary={poiSummaries[i]} />}

          {day.restDays !== undefined && day.restDays > 0 && (
            <Text style={[styles.rest, { color: colors.accent }]}>
              {`+${day.restDays} rest day${day.restDays === 1 ? '' : 's'} at ${day.endName}`}
            </Text>
          )}

          {day.estimatedHours > allowanceFor(day) && (
            <Text style={[styles.overHint, { color: colors.warning }]}>
              {`+${formatHours(day.estimatedHours - targetHours)} over target`}
            </Text>
          )}
        </Pressable>
      ))}
      {unplanned !== null && (
        <View
          style={[styles.card, styles.unplanned, { borderColor: colors.border }]}
          accessibilityLabel="Not planned yet"
        >
          <Text style={[styles.route, { color: colors.textSecondary }]} numberOfLines={1}>
            {`Not planned yet: ${unplanned.startName} → ${unplanned.endName}`}
          </Text>
          <Text style={[styles.date, { color: colors.textSecondary }]}>
            {`${formatDistance(unplanned.distanceKm, units)} · ↑ ${formatElevation(unplanned.ascentM, units)} · ${formatHours(unplanned.estimatedHours)} of walking`}
          </Text>
        </View>
      )}
    </View>
  );
}

function AlongTheWay({ summary }: { summary: { text: string; label: string } }) {
  const { colors } = useTheme();
  return (
    <Text
      style={[styles.along, { color: colors.textSecondary }]}
      accessibilityLabel={`Along the way, from OpenStreetMap: ${summary.label}`}
    >
      {`Along the way (OSM): ${summary.text}`}
    </Text>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  empty: { ...typography.bodySmall, paddingVertical: spacing.md },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  unplanned: { borderStyle: 'dashed', borderWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayNum: {
    ...typography.caption,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  route: { ...typography.titleSmall, flexShrink: 1, flexGrow: 1 },
  chevron: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
  date: { ...typography.caption, fontVariant: ['tabular-nums'] },
  rest: { ...typography.caption },
  along: { ...typography.caption, fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  stat: { gap: 2 },
  statLabel: { ...typography.caption },
  statValue: { ...typography.bodySmall, fontVariant: ['tabular-nums'], fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  camp: { ...typography.caption, flexShrink: 1 },
  water: { ...typography.caption, fontVariant: ['tabular-nums'] },
  overHint: { ...typography.caption, fontVariant: ['tabular-nums'] },
});

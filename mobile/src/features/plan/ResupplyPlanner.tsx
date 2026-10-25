/**
 * The resupply screen's body: the summary on top, then the trail read like the
 * hiker's planning spreadsheet — start, then each decision group with the leg
 * that arrives at it, to the end (`resupply-planner.ts` `plannerRows`).
 *
 * A decision group is the places reached from one turn-off, and the hiker
 * picks one of them or none ("None – carry through"); a group of one is a
 * Yes/No switch. A group with more than one place still ticked (the
 * every-option default, or a selection from before groups were decisions)
 * says "Not decided yet": the legs count it as one stop, but it is not a plan.
 *
 * Presentational — the route owns the stores and every handler. Every figure
 * comes from `@lib/resupply-plan` and every phrase about a place or a leg from
 * `@lib/resupply-display`; this only lays them out.
 *
 * Rows are memoised by value (`sameGroupRow`, `sameLegRow`): `plannerRows`
 * builds fresh row objects on every edit, so identity would re-render all of
 * the CDT's 70 groups and legs on each tap. The handlers they take are the
 * route's stable callbacks.
 *
 * Screen readers: each place's radio (or switch) speaks its full name, with
 * its facts as the hint; the facts and the More/Less button sit beside the
 * radio, not inside it, so each is its own focusable element. Every repeated
 * control names its place or turn-off ("More zero days at Salida",
 * "None – carry through at Monarch Pass (US 50)").
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { ResupplyLeg, ResupplyOption, ResupplyPlanSummary } from '@lib/resupply-plan';
import {
  legRidesText,
  legSideTripText,
  resupplyGroupName,
  resupplyOptionShortName,
  type LegEndpointNames,
} from '@lib/resupply-display';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { ScreenFlatList } from '../../navigation/ScreenScrollView';
import { StepButton } from './PlanInputsCard';
import { formatDays, formatFoodWeight } from './plan-format';
import {
  formatZeroDays,
  groupHeading,
  sameGroupRow,
  sameLegRow,
  optionFacts,
  ZERO_DAYS_MAX,
  type PlannerRow,
} from './resupply-planner';

export interface ResupplyPlannerProps {
  rows: PlannerRow[];
  summary: ResupplyPlanSummary;
  /** Groups in the section with no decision made yet. */
  undecided: number;
  /** Whether the trail offers any resupply option at all. */
  hasOptions: boolean;
  units: Units;
  /** "Whole trail" or "Start → End": the section the legs cover. */
  sectionLabel: string;
  /** One line of the hiker's inputs the legs are measured with. */
  inputsLine: string;
  onEditInputs: () => void;
  /** Whether a selection is stored at all; "Clear choices" is meaningless without one. */
  planMade: boolean;
  onReset: () => void;
  onChoose: (groupKey: string, optionId: string | null) => void;
  onZeroDays: (optionId: string, direction: 1 | -1) => void;
}

export function ResupplyPlanner(props: ResupplyPlannerProps) {
  const { rows, units, onChoose, onZeroDays } = props;

  const renderItem = useCallback(
    ({ item }: { item: PlannerRow }) => {
      switch (item.kind) {
        case 'start':
        case 'end':
          return <EndRow kind={item.kind} name={item.name} km={item.km} units={units} />;
        case 'leg':
          return <LegRow leg={item.leg} names={item.names} units={units} />;
        case 'group':
          return <GroupRow row={item} units={units} onChoose={onChoose} onZeroDays={onZeroDays} />;
      }
    },
    [units, onChoose, onZeroDays],
  );

  return (
    <ScreenFlatList
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderItem}
      ListHeaderComponent={<PlannerHeader {...props} />}
      contentContainerStyle={styles.listContent}
    />
  );
}

function PlannerHeader({
  summary,
  undecided,
  hasOptions,
  units,
  sectionLabel,
  inputsLine,
  onEditInputs,
  planMade,
  onReset,
}: ResupplyPlannerProps) {
  const { colors } = useTheme();
  const km = (value: number) => formatDistance(value, units);
  return (
    <View style={styles.header}>
      <View
        style={[
          styles.summary,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
        accessibilityLabel="Resupply summary"
      >
        <Text style={[styles.summaryTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {sectionLabel}
        </Text>
        {summary.hasData ? (
          <View style={styles.statGrid}>
            <Stat label="Stops" value={String(summary.stopsChosen)} />
            <Stat label="Longest leg" value={km(summary.longestLegKm)} />
            <Stat label="Most climb" value={formatElevation(summary.mostClimbM, units)} />
            <Stat
              label="Longest carry"
              value={`${summary.longestCarryDays} ${summary.longestCarryDays === 1 ? 'day' : 'days'}`}
            />
            <Stat label="Heaviest food" value={formatFoodWeight(summary.heaviestFoodKg, units)} />
            <Stat label="Walking" value={km(summary.totalWalkingKm)} />
            <Stat
              label={
                summary.zeroDays > 0
                  ? `Days (incl. ${formatZeroDays(summary.zeroDays)} off)`
                  : 'Days'
              }
              value={String(summary.totalDays)}
            />
          </View>
        ) : (
          <Text style={[styles.caption, { color: colors.textSecondary }]}>
            No legs to show: this trail has no length to plan over.
          </Text>
        )}
        {!hasOptions && summary.hasData && (
          <Text style={[styles.caption, { color: colors.textSecondary }]}>
            No towns or resupply points on this trail — full carry.
          </Text>
        )}
        {undecided > 0 && (
          <Text style={[styles.caption, { color: colors.warning }]}>
            {`${undecided} ${undecided === 1 ? 'turn-off is' : 'turn-offs are'} not decided yet — each counts as one stop until you pick.`}
          </Text>
        )}
        {planMade && (
          <Pressable
            onPress={onReset}
            accessibilityRole="button"
            accessibilityLabel="Clear choices"
            hitSlop={spacing.sm}
            style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
          >
            <Text style={[styles.link, { color: colors.accent }]}>Clear choices</Text>
          </Pressable>
        )}
      </View>

      <Pressable
        onPress={onEditInputs}
        accessibilityRole="button"
        accessibilityLabel="Resupply inputs"
        accessibilityHint="Daily hours, pace, food per day and long-carry days"
        style={({ pressed }) => [
          styles.inputs,
          { backgroundColor: colors.surface, borderColor: colors.border },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.inputsLine, { color: colors.textSecondary }]} numberOfLines={2}>
          {inputsLine}
        </Text>
        <Text style={[styles.link, { color: colors.accent }]}>Edit</Text>
      </Pressable>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

function EndRow({
  kind,
  name,
  km,
  units,
}: {
  kind: 'start' | 'end';
  name: string;
  km: number;
  units: Units;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.endRow}>
      <Text style={[styles.endLabel, { color: colors.textSecondary }]}>
        {kind === 'start' ? 'Start' : 'End'}
      </Text>
      <Text style={[styles.endName, { color: colors.textPrimary }]} numberOfLines={1}>
        {name}
      </Text>
      <Text style={[styles.km, { color: colors.textSecondary }]}>{formatDistance(km, units)}</Text>
    </View>
  );
}

function LegRowView({
  leg,
  names,
  units,
}: {
  leg: ResupplyLeg;
  names: LegEndpointNames;
  units: Units;
}) {
  const { colors } = useTheme();
  const km = (value: number) => formatDistance(value, units);
  // An undecided stop's side trip is its longest place's: named by no one place.
  const sideTrip = legSideTripText(leg, km, names.toDecided ? names.to : null);
  const rides = legRidesText(leg, km);
  return (
    <View
      style={[
        styles.leg,
        {
          borderColor: leg.isLong ? colors.warning : colors.border,
          backgroundColor: colors.surface,
        },
      ]}
    >
      <View style={styles.legHead}>
        <Text style={[styles.legRoute, { color: colors.textSecondary }]} numberOfLines={1}>
          {`${names.from} → ${names.to}`}
        </Text>
        {leg.isLong && (
          <View style={[styles.badge, { backgroundColor: colors.warning }]}>
            <Text style={[styles.badgeText, { color: colors.warningText }]}>Long carry</Text>
          </View>
        )}
      </View>
      <Text style={[styles.legStats, { color: colors.textPrimary }]}>
        {[
          km(leg.walkedKm),
          `+${formatElevation(leg.ascentM, units)} / −${formatElevation(leg.descentM, units)}`,
          formatDays(leg.estimatedDays),
          `${formatFoodWeight(leg.food.weightKg, units)} food`,
        ].join(' · ')}
      </Text>
      {sideTrip !== '' && (
        <Text style={[styles.caption, { color: colors.textSecondary }]}>{sideTrip}</Text>
      )}
      {rides !== '' && (
        <Text style={[styles.caption, { color: colors.textSecondary }]}>{rides}</Text>
      )}
    </View>
  );
}

const LegRow = React.memo(
  LegRowView,
  (a, b) =>
    a.units === b.units &&
    sameLegRow(
      { kind: 'leg', key: '', leg: a.leg, names: a.names },
      { kind: 'leg', key: '', leg: b.leg, names: b.names },
    ),
);

type GroupRowData = Extract<PlannerRow, { kind: 'group' }>;

interface GroupRowProps {
  row: GroupRowData;
  units: Units;
  onChoose: (groupKey: string, optionId: string | null) => void;
  onZeroDays: (optionId: string, direction: 1 | -1) => void;
}

const GroupRow = React.memo(
  GroupRowView,
  (a: GroupRowProps, b: GroupRowProps) =>
    a.units === b.units &&
    a.onChoose === b.onChoose &&
    a.onZeroDays === b.onZeroDays &&
    sameGroupRow(a.row, b.row),
);

function GroupRowView({
  row,
  units,
  onChoose,
  onZeroDays,
}: {
  row: GroupRowData;
  units: Units;
  onChoose: (groupKey: string, optionId: string | null) => void;
  onZeroDays: (optionId: string, direction: 1 | -1) => void;
}) {
  const { colors } = useTheme();
  const { group, choice, inSection, zeroDays } = row;
  const single = group.options.length === 1;
  const chosenId = choice.kind === 'chosen' ? choice.optionId : null;
  const chosen = group.options.find((option) => option.id === chosenId) ?? null;
  const chosenName = chosen ? resupplyOptionShortName(chosen, group) : '';
  const turnOff = resupplyGroupName(group);
  const heading = groupHeading(group);

  return (
    <View
      style={[
        styles.group,
        { borderColor: colors.border, backgroundColor: colors.background },
        !inSection && styles.outside,
      ]}
    >
      <View style={styles.groupHead}>
        <Text
          style={[styles.groupTitle, { color: colors.textPrimary }]}
          numberOfLines={2}
          accessibilityLabel={heading.spokenTitle}
        >
          {heading.title}
        </Text>
        <Text style={[styles.km, { color: colors.textSecondary }]}>
          {inSection ? formatDistance(group.km, units) : 'outside section'}
        </Text>
      </View>
      {heading.subtitle !== '' && (
        <Text style={[styles.caption, { color: colors.textSecondary }]}>{heading.subtitle}</Text>
      )}
      {choice.kind === 'undecided' && (
        <Text style={[styles.undecided, { color: colors.warning }]}>Not decided yet</Text>
      )}

      {single ? (
        <View style={styles.switchRow}>
          <View style={styles.optionText}>
            <OptionFacts option={group.options[0]} units={units} />
          </View>
          <Switch
            value={chosenId !== null}
            onValueChange={(on) => onChoose(group.key, on ? group.options[0].id : null)}
            accessibilityRole="switch"
            accessibilityLabel={`Resupply at ${group.options[0].name}`}
            accessibilityState={{ checked: chosenId !== null }}
            trackColor={{ true: colors.accentMuted, false: colors.border }}
            thumbColor={chosenId !== null ? colors.accent : colors.surface}
          />
        </View>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={`Resupply at ${turnOff}`}>
          {group.options.map((option) => (
            <View key={option.id} style={styles.option}>
              <Radio
                // The header names the turn-off; the row only what is beyond it.
                label={resupplyOptionShortName(option, group)}
                spokenLabel={option.name}
                hint={factsLine(optionFacts(option, (km) => formatDistance(km, units)))}
                checked={chosenId === option.id}
                onPress={() => onChoose(group.key, option.id)}
              />
              {/* Beside the radio, not inside it: an accessible Pressable is one
                  focus element, which would swallow these and the More button. */}
              <View style={styles.optionFacts}>
                <OptionFacts option={option} units={units} />
              </View>
            </View>
          ))}
          <Radio
            label="None – carry through"
            spokenLabel={`None – carry through at ${turnOff}`}
            checked={choice.kind === 'none'}
            onPress={() => onChoose(group.key, null)}
          />
        </View>
      )}

      {chosen !== null && inSection && (
        <View style={styles.zeroRow}>
          <Text style={[styles.zeroLabel, { color: colors.textSecondary }]}>Zero days</Text>
          <View style={styles.stepper}>
            <StepButton
              label="−"
              accessibilityLabel={`Fewer zero days at ${chosenName}`}
              disabled={zeroDays <= 0}
              onPress={() => onZeroDays(chosen.id, -1)}
            />
            <Text style={[styles.zeroValue, { color: colors.textPrimary }]}>
              {formatZeroDays(zeroDays)}
            </Text>
            <StepButton
              label="+"
              accessibilityLabel={`More zero days at ${chosenName}`}
              disabled={zeroDays >= ZERO_DAYS_MAX}
              onPress={() => onZeroDays(chosen.id, 1)}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function Radio({
  label,
  spokenLabel = label,
  hint,
  checked,
  onPress,
}: {
  label: string;
  /** What a screen reader says; the place's full name where the label is the short one. */
  spokenLabel?: string;
  /** The place's facts, read after the name. */
  hint?: string;
  checked: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={spokenLabel}
      accessibilityHint={hint || undefined}
      accessibilityState={{ checked }}
      style={({ pressed }) => [styles.radioRow, pressed && styles.pressed]}
    >
      <View style={[styles.radio, { borderColor: checked ? colors.accent : colors.border }]}>
        {checked && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
      </View>
      <Text style={[styles.optionName, styles.optionText, { color: colors.textPrimary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "Full resupply · 22.5 km hitch · Accepts boxes" — what the place is, in one line. */
function factsLine(facts: ReturnType<typeof optionFacts>): string {
  return [facts.store, facts.access, facts.acceptsBoxes ? 'Accepts boxes' : null]
    .filter((part): part is string => !!part)
    .join(' · ');
}

/** Store, access, boxes and the description's lead sentence (tap "More" for the rest). */
function OptionFacts({ option, units }: { option: ResupplyOption; units: Units }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const facts = optionFacts(option, (km) => formatDistance(km, units));
  const line = factsLine(facts);
  return (
    <View style={styles.facts}>
      <Text style={[styles.factsLine, { color: colors.textSecondary }]}>{line}</Text>
      {facts.lead !== '' && (
        <Text style={[styles.caption, { color: colors.textSecondary }]}>
          {expanded && facts.more ? facts.more : facts.lead}
        </Text>
      )}
      {facts.more !== null && (
        <Pressable
          onPress={() => setExpanded((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Less about ${option.name}` : `More about ${option.name}`}
          hitSlop={spacing.sm}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={[styles.more, { color: colors.accent }]}>{expanded ? 'Less' : 'More'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: { padding: spacing.lg, gap: spacing.sm },

  header: { gap: spacing.md, marginBottom: spacing.md },
  summary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  summaryTitle: { ...typography.titleSmall },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.md },
  stat: { width: '33%', gap: spacing.xs },
  statValue: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },
  statLabel: { ...typography.caption },
  clear: { alignSelf: 'flex-start' },
  link: { ...typography.bodySmall, fontWeight: '700' },
  caption: { ...typography.caption },

  inputs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  inputsLine: { ...typography.caption, flex: 1, fontVariant: ['tabular-nums'] },

  endRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  endLabel: { ...typography.caption, fontWeight: '700' },
  endName: { ...typography.titleSmall, flex: 1 },
  km: { ...typography.bodySmall, fontVariant: ['tabular-nums'], textAlign: 'right' },

  leg: {
    marginLeft: spacing.lg,
    borderLeftWidth: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  legHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legRoute: { ...typography.caption, flexShrink: 1 },
  legStats: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radii.full },
  badgeText: { ...typography.caption, fontWeight: '700' },

  group: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  outside: { opacity: 0.45 },
  groupHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  groupTitle: { ...typography.titleSmall, flex: 1 },
  undecided: { ...typography.caption, fontWeight: '700' },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: touchTarget.min,
    paddingVertical: spacing.sm,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: radii.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioDot: { width: 10, height: 10, borderRadius: radii.full },
  optionText: { flex: 1, gap: spacing.xs },
  option: { gap: spacing.xs },
  // Under the radio's label, clear of the radio circle (22 + the row gap).
  optionFacts: { marginLeft: 22 + spacing.md, marginTop: -spacing.sm, paddingBottom: spacing.sm },
  optionName: { ...typography.bodySmall, fontWeight: '700' },
  facts: { gap: spacing.xs },
  factsLine: { ...typography.caption },
  more: { ...typography.caption, fontWeight: '700' },

  zeroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  zeroLabel: { ...typography.bodySmall },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  zeroValue: {
    ...typography.titleSmall,
    minWidth: 72,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },

  pressed: { opacity: 0.6 },
});

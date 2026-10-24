/**
 * "Find places along this route" — the on-phone OpenStreetMap search for a GPX
 * imported on the device (`src/features/import/poi-search.ts`).
 *
 * The screen informs; the hiker decides. Before anything is sent it says what
 * the search covers, how many requests it makes, roughly how much data that is
 * (and whether the phone is on Wi-Fi or mobile data), and where the route's
 * outline goes. The search runs only on "Search OpenStreetMap", can be
 * cancelled at any point without changing the guide, and a partial result
 * offers a retry of just the areas that did not answer. Results are saved into
 * the guide, so they are there offline from then on; "Remove" puts the guide
 * back to never-searched.
 *
 * Reached from the map's layers sheet (`PoiLayersSheet` `onFindPois`), only for
 * an import (`canSearchPois`).
 */

import React, { useCallback, useMemo } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { countPoisByCategory, POI_CATEGORIES, POI_CATEGORY_LABELS } from '@lib/poi-display';
import { countDuplicatePois } from '@lib/poi-dedup';
import {
  INTERACTIVE_OVERPASS_ENDPOINTS,
  POI_SEARCH_RADIUS_KM,
  formatBytes,
} from '@lib/trail-poi-search';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { ScreenScrollView } from '../../../src/navigation/ScreenScrollView';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { CreditList } from '../../../src/credits/CreditList';
import { POI_SEARCH_CREDIT } from '../../../src/credits/credits';
import { useSettingsStore } from '../../../src/state/settings-store';
import { formatDistance } from '@lib/format-distance';
import {
  usePoiSearch,
  type ConnectionKind,
  type PoiSearchState,
} from '../../../src/features/import/use-poi-search';
import type { PoiSearchProgress } from '../../../src/features/import/poi-search';

const CREDITS = [POI_SEARCH_CREDIT];

function hostList(): string {
  return INTERACTIVE_OVERPASS_ENDPOINTS.map((e) =>
    e.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
  ).join(', ');
}

export default function FindPoisScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { trailId, baseTrail, reloadTrail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const { state, connection, start, retryMissed, cancel, remove } = usePoiSearch(
    trailId,
    reloadTrail,
  );
  const existing = baseTrail.pois;

  const confirmRemove = useCallback(() => {
    Alert.alert(
      'Remove points of interest',
      'Remove the OpenStreetMap points of interest from this guide? You can search again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void remove().then((ok) => {
              if (!ok) Alert.alert('Couldn’t remove them', 'This guide is no longer on the phone.');
            });
          },
        },
      ],
    );
  }, [remove]);

  if (state.kind === 'loading') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>Measuring the route…</Text>
      </View>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Only a guide imported on this phone can be searched here.
        </Text>
      </View>
    );
  }

  const estimate = state.setup.plan.estimate;
  const running = state.kind === 'running';

  return (
    <ScreenScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          Find places along this route
        </Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Searches OpenStreetMap for water, campsites and huts, shops, places to eat, transport and
          emergency services within {formatDistance(POI_SEARCH_RADIUS_KM, units, { decimals: 0 })}{' '}
          of the route and its alternates. What it finds is saved with this guide, so it works
          offline afterwards.
        </Text>
        {existing && !running && state.kind !== 'done' && state.kind !== 'removed' ? (
          <Text style={[styles.body, { color: colors.textPrimary }]}>
            This guide has {existing.length} {existing.length === 1 ? 'point' : 'points'} of
            interest. Searching again replaces them.
          </Text>
        ) : null}
      </View>

      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Before you search</Text>
        <Fact
          label="Route searched"
          value={`${formatDistance(estimate.routeKm, units)} · ${estimate.queries} ${
            estimate.queries === 1 ? 'request' : 'requests'
          }`}
        />
        <Fact
          label="Download"
          value={`About ${formatBytes(estimate.downloadBytesLow)} to ${formatBytes(
            estimate.downloadBytesHigh,
          )} — the high end where the route runs through towns`}
        />
        <Fact label="Upload" value={`About ${formatBytes(estimate.uploadBytes)}`} />
        <Fact label="Connection" value={connectionLine(connection)} />
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          The route’s outline (simplified to a point every few hundred metres) is sent to a public
          Overpass server — {hostList()}, tried in that order. Nothing else about you or this guide
          is sent. Requests go one at a time, a couple of seconds apart, as the servers ask.
        </Text>
      </View>

      <StatePanel state={state} />

      <View style={styles.actions}>
        {running ? (
          <Button label="Cancel" onPress={cancel} kind="secondary" />
        ) : (
          <>
            {state.kind === 'done' && state.run.failures.length > 0 ? (
              <Button
                label={`Retry the ${state.run.failures.length} missed ${
                  state.run.failures.length === 1 ? 'area' : 'areas'
                }`}
                onPress={retryMissed}
                disabled={connection === 'offline'}
              />
            ) : null}
            {state.kind === 'done' ? (
              <Button label="Done" onPress={() => router.back()} kind="secondary" />
            ) : (
              <Button
                label={state.kind === 'failed' ? 'Try again' : 'Search OpenStreetMap'}
                onPress={start}
                disabled={connection === 'offline' || estimate.queries === 0}
              />
            )}
            {existing && state.kind !== 'removed' ? (
              <Button label="Remove points of interest" onPress={confirmRemove} kind="danger" />
            ) : null}
          </>
        )}
      </View>

      <Text style={[styles.meta, { color: colors.textSecondary }]}>
        Points of interest are uncurated OpenStreetMap data, shown beside this guide’s own waypoints
        so you can judge them. They never change your plan’s figures.
      </Text>
      <CreditList lines={CREDITS} />
    </ScreenScrollView>
  );
}

function connectionLine(kind: ConnectionKind): string {
  switch (kind) {
    case 'wifi':
      return 'Wi-Fi';
    case 'cellular':
      return 'Mobile data';
    case 'offline':
      return 'Offline — connect to search';
    case 'other':
      return 'Connected';
    default:
      return 'Unknown';
  }
}

function progressLine(progress: PoiSearchProgress | null, retrying: boolean): string {
  if (!progress) return 'Starting…';
  if (progress.phase === 'processing') return 'Placing what was found along the route…';
  if (progress.phase === 'saving') return 'Saving to the guide…';
  const what = retrying ? 'Retrying missed areas' : 'Asking OpenStreetMap';
  const step =
    progress.current && progress.total ? ` — area ${progress.current} of ${progress.total}` : '';
  const host = progress.host ? ` (${progress.host})` : '';
  return `${what}${step}${host}`;
}

function StatePanel({ state }: { state: PoiSearchState }) {
  const { colors } = useTheme();
  const counts = useMemo(
    () => (state.kind === 'done' ? countPoisByCategory(state.run.pois) : null),
    [state],
  );

  if (state.kind === 'running') {
    const { progress } = state;
    const fraction =
      progress?.phase === 'fetching' && progress.total
        ? Math.max(0, ((progress.current ?? 1) - 1) / progress.total)
        : progress && progress.phase !== 'fetching'
          ? 1
          : 0;
    return (
      <View
        style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}
        accessibilityLiveRegion="polite"
      >
        <Text style={[styles.body, { color: colors.textPrimary }]}>
          {progressLine(progress, state.retrying)}
        </Text>
        <View
          style={[styles.progressTrack, { backgroundColor: colors.borderSubtle }]}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        >
          <View
            style={[
              styles.progressFill,
              { backgroundColor: colors.accent, width: `${fraction * 100}%` },
            ]}
          />
        </View>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Received {formatBytes(progress?.bytes ?? 0)}. Cancel at any time — the guide is only
          changed once the search finishes.
        </Text>
      </View>
    );
  }

  if (state.kind === 'done' && counts) {
    const { run } = state;
    const hidden = countDuplicatePois(run.pois);
    const shown = run.pois.length - hidden;
    return (
      <View
        style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}
        accessibilityLiveRegion="polite"
      >
        <Text style={[styles.heading, { color: colors.textPrimary }]}>
          {shown === 0
            ? 'No points of interest found along this route'
            : `Found ${shown} ${shown === 1 ? 'point' : 'points'} of interest`}
        </Text>
        {POI_CATEGORIES.filter((c) => counts[c] > 0).map((c) => (
          <Fact key={c} label={POI_CATEGORY_LABELS[c]} value={String(counts[c])} />
        ))}
        {hidden > 0 ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {hidden} more {hidden === 1 ? 'is' : 'are'} the same place as one of this guide’s own
            waypoints, and {hidden === 1 ? 'shows' : 'show'} on that waypoint instead.
          </Text>
        ) : null}
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Saved to this guide. Received {formatBytes(run.bytes)}. Turn categories on and off from
          the map’s layers button.
        </Text>
        {run.failures.length > 0 ? (
          <Text style={[styles.body, { color: colors.warning }]}>
            {run.failures.length} {run.failures.length === 1 ? 'area' : 'areas'} of the route got no
            answer from any server, so {run.failures.length === 1 ? 'it has' : 'they have'} no
            results yet. ({run.failures[0].error})
          </Text>
        ) : null}
        {state.retryError ? (
          <Text style={[styles.body, { color: colors.warning }]}>
            The retry failed too: {state.retryError} What was found before is still saved.
          </Text>
        ) : null}
      </View>
    );
  }

  if (state.kind === 'failed') {
    return (
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.danger }]}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>
          Couldn’t reach OpenStreetMap
        </Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>{state.message}</Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Nothing was changed. The public servers are sometimes busy; trying again in a few minutes
          often works.
        </Text>
      </View>
    );
  }

  if (state.kind === 'cancelled') {
    return (
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Search cancelled. Nothing was changed.
        </Text>
      </View>
    );
  }

  if (state.kind === 'removed') {
    return (
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Points of interest removed from this guide.
        </Text>
      </View>
    );
  }

  return null;
}

function Fact({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.factValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  kind = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'danger';
}) {
  const { colors } = useTheme();
  const bg =
    kind === 'primary' ? colors.accent : kind === 'danger' ? colors.surface : colors.surface;
  const fg =
    kind === 'primary' ? colors.accentText : kind === 'danger' ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'primary' ? bg : colors.border },
        disabled && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    ...typography.titleLarge,
  },
  heading: {
    ...typography.titleSmall,
  },
  body: {
    ...typography.body,
  },
  meta: {
    ...typography.caption,
  },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  factLabel: {
    ...typography.bodySmall,
  },
  factValue: {
    ...typography.bodySmall,
    flexShrink: 1,
    textAlign: 'right',
  },
  progressTrack: {
    height: spacing.sm,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.full,
  },
  actions: {
    gap: spacing.md,
  },
  button: {
    minHeight: touchTarget.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    ...typography.body,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
});

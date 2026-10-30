/**
 * Offline maps screen — download / cancel / delete a guide's map tiles.
 *
 * Download state comes from the downloads store (which wraps the filesystem
 * tile manager). The tile base URL is read from EXPO_PUBLIC_TILE_BASE_URL and
 * passed into the store — services never read env themselves.
 *
 * The screen never assumes the guide owns a pack. `offline-pack-resolver`
 * decides which tile directory this guide actually maps to: its own for a
 * bundled trail, a *borrowed* bundled pack for an import whose track sits
 * inside one's coverage, or none at all. Everything below — the store key, the
 * on-disk size, the update check, download / cancel / delete — is driven by
 * that resolved pack id rather than by the route's trailId, so borrowing is a
 * single substitution and an uncovered import disables the actions instead of
 * requesting a pack the server has never heard of.
 *
 * An import or community route outside every bundled pack gets a **corridor
 * pack** instead (`plan.corridor`): built on the phone from the tiles along the
 * route (`services/corridor-pack`), under the guide's own id. How far either
 * side of the route it covers is the hiker's call — a chip row whose initial
 * value is visible and editable (the width of the pack on disk, else
 * {@link INITIAL_CORRIDOR_KM}), with the tile count it comes to shown before
 * anything is fetched. The width is recorded in the pack's manifest, on this
 * device only. Its "update" is the route having changed since the pack was
 * built (the manifest's `sourceVersion` against the route's fingerprint now) —
 * never a request to the pack bucket.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { ScreenScrollView } from '../../../src/navigation/ScreenScrollView';
import { ChoiceChips } from '../../../src/features/community/CommunityUi';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { useTrailTitle } from '../../../src/features/guide/use-trail-title';
import {
  hasCorridorProgress,
  planCorridor,
  readCorridorRecord,
  tooLargeMessage,
} from '../../../src/services/corridor-pack';
import { offlinePackPlan, resolveOfflinePack } from '../../../src/services/offline-pack-resolver';
import { tileManager } from '../../../src/services/tile-manager';
import { useDownloadsStore, type TrailDownload } from '../../../src/state/downloads-store';

const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';
/** The tile worker a corridor pack is built from. */
const CONTOUR_TILE_URL = process.env.EXPO_PUBLIC_CONTOUR_TILE_URL ?? '';

/** Corridor widths offered, in km either side of the route. */
const CORRIDOR_WIDTH_CHOICES_KM = [2, 5, 10, 20] as const;
/** The chip selected before the hiker picks one, when no pack is on disk yet. */
const INITIAL_CORRIDOR_KM = 5;

const IDLE: TrailDownload = { state: 'absent', downloading: false, progress: 0 };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export default function DownloadsScreen() {
  const { colors } = useTheme();
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { trail } = useGuide();
  const title = useTrailTitle(trailId, trailId);

  // Which pack this guide maps to (its own, a borrowed bundled one, or none).
  const plan = useMemo(
    () => offlinePackPlan(resolveOfflinePack(trailId, trail), trailId),
    [trailId, trail],
  );
  const packTrailId = plan.packTrailId;

  const download =
    useDownloadsStore((s) => (packTrailId ? s.byTrail[packTrailId] : undefined)) ?? IDLE;
  const startDownload = useDownloadsStore((s) => s.startDownload);
  const startCorridorDownload = useDownloadsStore((s) => s.startCorridorDownload);
  const cancel = useDownloadsStore((s) => s.cancel);
  const deleteTiles = useDownloadsStore((s) => s.deleteTiles);
  const refreshStatus = useDownloadsStore((s) => s.refreshStatus);
  const checkForUpdates = useDownloadsStore((s) => s.checkForUpdates);

  // Re-derive the store's on-disk state on open and whenever it moves. This is
  // the only part of the pair that belongs in an effect: it writes to an
  // external store, it doesn't set local state.
  useEffect(() => {
    if (packTrailId) refreshStatus(packTrailId);
  }, [packTrailId, refreshStatus, download.state]);

  // On-disk size, re-read whenever the download state changes. Derived rather
  // than held in state: `getTrailStatus` is a handful of file stats, and the
  // download state is exactly what makes the previous answer stale. `absent`
  // means no pack file exists, so it short-circuits the stat calls.
  const sizeBytes = useMemo(
    () =>
      packTrailId && download.state !== 'absent'
        ? tileManager.getTrailStatus(packTrailId).totalSizeBytes
        : 0,
    [packTrailId, download.state],
  );

  // --- Corridor packs -------------------------------------------------------
  // What is on disk now: re-read whenever a build starts, ends or is deleted.
  const record = useMemo(
    () => (plan.corridor && packTrailId ? readCorridorRecord(packTrailId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- download moves the disk
    [plan.corridor, packTrailId, download],
  );
  const interrupted = useMemo(
    () =>
      plan.corridor && packTrailId != null && !download.downloading
        ? hasCorridorProgress(packTrailId)
        : false,
    [plan.corridor, packTrailId, download],
  );
  // The hiker's pick; until they make one, the pack's own width or the initial.
  const [pickedKm, setPickedKm] = useState<number | null>(null);
  const bufferKm = pickedKm ?? record?.bufferKm ?? INITIAL_CORRIDOR_KM;
  const corridor = useMemo(
    () => (plan.corridor ? planCorridor(trail, bufferKm) : null),
    [plan.corridor, trail, bufferKm],
  );
  const routeChanged =
    record != null && corridor != null && record.sourceVersion !== corridor.sourceVersion;
  const widthChanged = record != null && record.bufferKm !== bufferKm;

  const missingBaseUrl = plan.corridor ? CONTOUR_TILE_URL.length === 0 : TILE_BASE_URL.length === 0;
  const canDownload =
    plan.packAvailable &&
    !missingBaseUrl &&
    packTrailId != null &&
    (!plan.corridor || (corridor != null && !corridor.tooLarge));

  const onDownload = () => {
    if (!packTrailId) return;
    if (plan.corridor) {
      void startCorridorDownload(packTrailId, trail, {
        bufferKm,
        tileUrl: CONTOUR_TILE_URL,
        name: title,
      });
    } else {
      void startDownload(packTrailId, TILE_BASE_URL);
    }
  };

  // Ask the server whether a newer pack exists — on open, and again once a
  // download finishes so the badge is re-derived rather than guessed. The store
  // ignores anything that isn't a complete pack and swallows network failures,
  // so this is a no-op when there is nothing to say.
  // A corridor pack is never asked about: it has no server manifest.
  useEffect(() => {
    if (missingBaseUrl || !packTrailId || plan.corridor) return;
    void checkForUpdates([packTrailId], TILE_BASE_URL);
  }, [
    packTrailId,
    checkForUpdates,
    missingBaseUrl,
    plan.corridor,
    download.state,
    download.downloading,
  ]);

  const updateAvailable =
    !!download.updateAvailable && download.state === 'complete' && !download.downloading;

  const statusText = useMemo(() => {
    if (!plan.packAvailable) return 'Offline maps unavailable';
    if (download.downloading) {
      const pct = Math.round(download.progress * 100);
      if (plan.corridor && download.tilesTotal) {
        return `Downloading… ${pct}% (${download.tilesDone ?? 0} of ${download.tilesTotal} tiles)`;
      }
      return `Downloading… ${pct}%`;
    }
    if (download.error) return `Error: ${download.error}`;
    switch (download.state) {
      case 'complete':
        return 'Offline maps ready';
      case 'partial':
        return 'Partial download — re-download to finish';
      default:
        return interrupted ? 'Download interrupted — resume to finish' : 'Not downloaded';
    }
  }, [download, plan.packAvailable, plan.corridor, interrupted]);

  const actionLabel = plan.corridor
    ? download.state === 'complete'
      ? widthChanged
        ? `Rebuild at ${bufferKm} km`
        : 'Rebuild'
      : interrupted
        ? 'Resume download'
        : 'Download'
    : updateAvailable
      ? 'Update'
      : download.state === 'complete'
        ? 'Re-download'
        : 'Download';

  return (
    <ScreenScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.status, { color: colors.textSecondary }]}>{statusText}</Text>
        {plan.note && (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{plan.note}</Text>
        )}
        {updateAvailable && (
          <Text
            style={[
              styles.badge,
              { color: colors.downloadActive, borderColor: colors.downloadActive },
            ]}
          >
            Update available{download.remoteVersion ? ` (${download.remoteVersion})` : ''}
          </Text>
        )}
        {routeChanged && !download.downloading && (
          <Text
            style={[
              styles.badge,
              { color: colors.downloadActive, borderColor: colors.downloadActive },
            ]}
          >
            Route changed since this map was built — rebuild to match it
          </Text>
        )}
        {sizeBytes > 0 && (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            On device: {formatBytes(sizeBytes)}
            {record ? ` · ${record.bufferKm} km either side` : ''}
          </Text>
        )}
        {record && !record.contours && (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            No contour lines were available along this route, so this map has none.
          </Text>
        )}

        {download.downloading && (
          <View style={[styles.progressTrack, { backgroundColor: colors.surface }]}>
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: colors.downloadActive,
                  width: `${Math.round(download.progress * 100)}%`,
                },
              ]}
            />
          </View>
        )}
      </View>

      {plan.corridor && corridor && (
        <View
          style={[
            styles.panel,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.status, { color: colors.textPrimary }]}>
            Cover how far either side of the route?
          </Text>
          <ChoiceChips
            accessibilityLabel="Distance either side of the route"
            choices={CORRIDOR_WIDTH_CHOICES_KM.map((km) => ({
              value: String(km),
              label: `${km} km`,
            }))}
            selected={String(bufferKm)}
            onSelect={(value) => {
              if (!download.downloading) setPickedKm(Number(value));
            }}
          />
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {corridor.totalTiles.toLocaleString('en')} map tiles to fetch at {bufferKm} km either
            side. A wider corridor shows more around the route and takes more space.
          </Text>
          {corridor.tooLarge && (
            <Text style={[styles.warning, { color: colors.warning }]}>
              {tooLargeMessage(corridor.totalTiles)}
            </Text>
          )}
        </View>
      )}

      {missingBaseUrl && plan.packAvailable && (
        <Text style={[styles.warning, { color: colors.warning }]}>
          {plan.corridor ? 'EXPO_PUBLIC_CONTOUR_TILE_URL' : 'EXPO_PUBLIC_TILE_BASE_URL'} is not set
          — downloads are disabled.
        </Text>
      )}

      <View style={styles.actions}>
        {download.downloading && packTrailId ? (
          <ActionButton label="Cancel" variant="danger" onPress={() => cancel(packTrailId)} />
        ) : (
          <ActionButton
            label={actionLabel}
            variant="accent"
            disabled={!canDownload}
            onPress={onDownload}
          />
        )}

        {packTrailId &&
          (download.state === 'complete' || download.state === 'partial' || interrupted) &&
          !download.downloading && (
            <ActionButton
              label="Delete"
              variant="danger"
              onPress={() => deleteTiles(packTrailId)}
            />
          )}
      </View>
    </ScreenScrollView>
  );
}

function ActionButton({
  label,
  variant,
  onPress,
  disabled,
}: {
  label: string;
  variant: 'accent' | 'danger';
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const bg = variant === 'accent' ? colors.accent : colors.danger;
  const fg = variant === 'accent' ? colors.accentText : colors.dangerText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.button, { backgroundColor: bg }, disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    ...typography.displaySmall,
  },
  status: {
    ...typography.body,
  },
  meta: {
    ...typography.caption,
  },
  badge: {
    ...typography.caption,
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  progressTrack: {
    height: spacing.sm,
    borderRadius: radii.full,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.full,
  },
  warning: {
    ...typography.bodySmall,
  },
  actions: {
    gap: spacing.md,
  },
  button: {
    minHeight: touchTarget.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    ...typography.body,
    fontWeight: '600',
  },
});

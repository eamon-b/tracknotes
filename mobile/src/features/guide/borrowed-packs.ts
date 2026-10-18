/**
 * Which bundled offline pack each imported or community guide on My Guides
 * borrows, so its card can show that pack's download status.
 *
 * The rule is `services/offline-pack-resolver`'s, the one the Offline maps
 * screen and the map pane use; it needs the guide's track, and My Guides reads
 * index metadata only. So this loads each local guide's JSON once, after the
 * list has drawn, one at a time, and remembers the answer for the process: an
 * import's track never changes, and a community route's is keyed by its
 * `updatedAt`, which an owner's edit moves.
 */

import { useEffect, useMemo, useState } from 'react';

import { resolveOfflinePack } from '../../services/offline-pack-resolver';
import { loadTrail, type TrailIndexEntry } from '../../services/trail-loader';

/** The bundled pack a local guide uses offline. */
export interface BorrowedPack {
  /** Bundled trail id: the tile directory and the downloads-store key. */
  packTrailId: string;
  packName: string;
}

type Loader = (id: string) => Promise<Parameters<typeof resolveOfflinePack>[1]>;

/** Answers so far, by {@link borrowedPackKey}; null = no pack covers it. */
const cache = new Map<string, BorrowedPack | null>();

/** Only guides with no pack of their own, and whose track is on the phone. */
export function needsBorrowedPack(entry: TrailIndexEntry): boolean {
  if (entry.source === 'imported') return true;
  return entry.source === 'community' && entry.downloaded === true;
}

export function borrowedPackKey(entry: TrailIndexEntry): string {
  return `${entry.id}|${entry.updatedAt ?? ''}`;
}

/**
 * The pack an entry borrows, or null. A guide that cannot be read is not
 * cached, so the next visit to the list tries again.
 */
export async function resolveBorrowedPack(
  entry: TrailIndexEntry,
  load: Loader = loadTrail,
): Promise<BorrowedPack | null> {
  const key = borrowedPackKey(entry);
  const known = cache.get(key);
  if (known !== undefined) return known;

  let trail;
  try {
    trail = await load(entry.id);
  } catch {
    return null;
  }
  if (!trail) return null;

  const resolution = resolveOfflinePack(entry.id, trail);
  const pack =
    resolution.kind === 'bundled'
      ? { packTrailId: resolution.packTrailId, packName: resolution.packName }
      : null;
  cache.set(key, pack);
  return pack;
}

/** Test seam — forget every answer. */
export function resetBorrowedPacks(): void {
  cache.clear();
}

/**
 * Borrowed packs for the listed guides, by guide id. Starts from what is
 * already known and fills in as each guide's JSON is read.
 */
export function useBorrowedPacks(
  trails: readonly TrailIndexEntry[],
  load: Loader = loadTrail,
): Record<string, BorrowedPack> {
  // Bumped as each answer lands in the cache, which is what the list reads.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const entry of trails.filter(needsBorrowedPack)) {
        if (cache.has(borrowedPackKey(entry))) continue;
        const pack = await resolveBorrowedPack(entry, load);
        if (cancelled) return;
        if (pack) setRevision((r) => r + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trails, load]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- revision re-reads the cache
  return useMemo(() => known(trails), [trails, revision]);
}

function known(trails: readonly TrailIndexEntry[]): Record<string, BorrowedPack> {
  const out: Record<string, BorrowedPack> = {};
  for (const entry of trails) {
    if (!needsBorrowedPack(entry)) continue;
    const pack = cache.get(borrowedPackKey(entry));
    if (pack) out[entry.id] = pack;
  }
  return out;
}

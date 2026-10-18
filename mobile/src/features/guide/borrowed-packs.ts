/**
 * Which bundled offline pack each imported or community guide on My Guides
 * borrows, so its card can show that pack's download status.
 *
 * The rule is `services/offline-pack-resolver`'s, the one the Offline maps
 * screen and the map pane use; it needs the guide's track, and My Guides reads
 * index metadata only. So this loads each local guide's JSON once, after the
 * list has drawn, one at a time, and remembers the answer for the process: an
 * import's track never changes, and a community route's is keyed by the MD5 of
 * the copy on the phone (`installedMd5`) — the copy `loadTrail` reads, which can
 * trail the list until a re-download lands. A guide that cannot be read is
 * remembered as having no pack too: a torn import stays torn, and a community
 * route's next copy has a new MD5.
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

/** Settled answers, by {@link borrowedPackKey}; null = no pack covers it. */
const cache = new Map<string, BorrowedPack | null>();
/** Reads under way, so two passes over the list never load one guide twice. */
const inFlight = new Map<string, Promise<BorrowedPack | null>>();

/** Only guides with no pack of their own, and whose track is on the phone. */
export function needsBorrowedPack(entry: TrailIndexEntry): boolean {
  if (entry.source === 'imported') return true;
  return entry.source === 'community' && entry.downloaded === true;
}

export function borrowedPackKey(entry: TrailIndexEntry): string {
  return `${entry.id}|${entry.installedMd5 ?? ''}`;
}

/** The pack an entry borrows, or null. Reads the guide at most once per key. */
export function resolveBorrowedPack(
  entry: TrailIndexEntry,
  load: Loader = loadTrail,
): Promise<BorrowedPack | null> {
  const key = borrowedPackKey(entry);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const read = (async () => {
    let pack: BorrowedPack | null = null;
    try {
      const trail = await load(entry.id);
      const resolution = trail ? resolveOfflinePack(entry.id, trail) : null;
      if (resolution?.kind === 'bundled') {
        pack = { packTrailId: resolution.packTrailId, packName: resolution.packName };
      }
    } catch {
      // Unreadable: no pack, the same answer the guide's own screens give.
    }
    cache.set(key, pack);
    inFlight.delete(key);
    return pack;
  })();
  inFlight.set(key, read);
  return read;
}

/** Test seam — forget every answer. */
export function resetBorrowedPacks(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Borrowed packs for the listed guides, by guide id: what is known now, filled
 * in as each guide's JSON is read.
 */
export function useBorrowedPacks(
  trails: readonly TrailIndexEntry[],
  load: Loader = loadTrail,
): Record<string, BorrowedPack> {
  // Bumped whenever the cache knows something `packs` does not show.
  const [revision, setRevision] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- revision re-reads the cache
  const packs = useMemo(() => known(trails), [trails, revision]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const entry of trails.filter(needsBorrowedPack)) {
        // Every entry, settled or not: an answer an earlier, cancelled pass
        // stored after this render read the cache is still not on screen.
        const pack = await resolveBorrowedPack(entry, load);
        if (cancelled) return;
        if (pack?.packTrailId !== packs[entry.id]?.packTrailId) {
          setRevision((r) => r + 1);
          return; // the re-render starts a fresh pass from `packs` as it then is
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trails, load, packs]);

  return packs;
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

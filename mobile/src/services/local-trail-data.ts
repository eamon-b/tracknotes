/**
 * Everything the phone keeps about one guide, apart from the guide itself —
 * cleared when the guide leaves the phone, so a trail id that comes back later
 * (a re-import of the same file, a community route downloaded again) starts
 * clean, and nothing lingers that no screen can reach any more:
 *
 * - SQLite: custom routes and their points, favourites, sync marks, comments,
 *   outbox rows, waypoint metadata (`db/trail-data-repo`) and the plan
 *   (`plans-repo`), in one transaction;
 * - the in-memory caches over those (`plans-store`, `favorites-store`,
 *   `routes-store`);
 * - the device-local preferences: pace and daily hours (`plan-inputs-store`),
 *   the hiking direction, and the "Hiking now" pin (`settings-store`);
 * - its own offline map: the corridor pack built on the phone under
 *   `tiles/{trailId}/` (`corridor-pack`), with any interrupted build's staging
 *   files, and its download state. A *borrowed* bundled pack is a different
 *   directory and stays — other guides may use it.
 *
 * The plan is HARD-deleted, not tombstoned: only local-only guides (`u_`
 * imports, `c_` community routes) are ever removed, and their plans were never
 * sent to the server (`isServerKnown`), so there is no one to tell.
 *
 * Callers: `imported-trail-store.deleteImportedTrailEverywhere` and the
 * community route removals in `community-routes`. A bundled or catalog id is
 * refused (a no-op): those guides never leave the phone, and their plans sync.
 */

import * as plansRepo from '../db/plans-repo';
import type { SqlDatabase } from '../db/sql-database';
import { deleteTrailScopedRows } from '../db/trail-data-repo';
import { withTransaction } from '../db/transaction';
import { usePlanInputsStore } from '../features/plan/plan-inputs-store';
import { useRoutesStore } from '../features/routes/routes-store';
import { useFavoritesStore } from '../state/favorites-store';
import { usePlansStore } from '../state/plans-store';
import { useUserWaypointsStore } from '../state/user-waypoints-store';
import { useSettingsStore } from '../state/settings-store';
import { useDownloadsStore } from '../state/downloads-store';
import { isLocalOnlyTrailId } from './server-trails';
import { tileManager } from './tile-manager';

export async function deleteLocalTrailData(db: SqlDatabase, trailId: string): Promise<void> {
  if (!isLocalOnlyTrailId(trailId)) return;
  await withTransaction(db, async () => {
    await deleteTrailScopedRows(db, trailId);
    await plansRepo.deleteForTrail(db, trailId);
  });

  usePlansStore.getState().clear(trailId);
  useFavoritesStore.getState().forgetTrail(trailId);
  useRoutesStore.getState().forgetTrail(trailId);
  useUserWaypointsStore.getState().forgetTrail(trailId);
  usePlanInputsStore.getState().clearTrail(trailId);
  const settings = useSettingsStore.getState();
  settings.clearDirection(trailId);
  settings.clearCurrentTrailIf(trailId);

  // Last, and never fatal: a pack that will not delete is wasted space, not a
  // reason to keep a removed guide's other data.
  // A build in flight is waited out first: it holds its staging files open and
  // patches its final state on the way out, which must land before both the
  // directory goes and the entry is forgotten.
  const downloads = useDownloadsStore.getState();
  await downloads.cancel(trailId);
  try {
    tileManager.deleteTrail(trailId);
  } catch (err) {
    console.warn(`[local-trail-data] could not delete offline maps for ${trailId}`, err);
  }
  downloads.forget(trailId);
}

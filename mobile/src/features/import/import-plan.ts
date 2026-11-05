/**
 * Bringing the plan a `.tracknotes.json` carried into the phone's plan store.
 *
 * Kept apart from `./import-gpx` so the file-reading side (which
 * `incoming-file` and `poi-search` also import) does not pull in the plans
 * store. The plan arrives validated and re-keyed by `@lib/trail-handoff`; the
 * review screen (`app/import.tsx`) saves the trail first, then the plan.
 */

import type { PlanDocument } from '@lib/plan-types';

import { uuidv4 } from '../../api/uuid';
import { usePlansStore } from '../../state/plans-store';

/**
 * The plan this phone already has for a trail, or null — what decides whether
 * importing a file's plan needs the hiker's say-so. Reads through to SQLite
 * when the cache has not been hydrated: deciding from an unread cache is how a
 * plan gets replaced without anyone being asked (the shared-plan screen's
 * rule, `app/plan/[shareId].tsx`).
 */
export async function existingPlanFor(trailId: string): Promise<PlanDocument | null> {
  if (!(trailId in usePlansStore.getState().byTrail)) {
    await usePlansStore.getState().hydrate(trailId);
  }
  return usePlansStore.getState().byTrail[trailId] ?? null;
}

/**
 * Store a file's plan as this trail's plan, replacing any it has — so call it
 * only once the hiker has agreed to that (see {@link existingPlanFor}).
 *
 * The copy gets a new id and a fresh clock, as a shared plan saved on the phone
 * does: it is this device's document from now on, not a second writer on the
 * browser's. It goes through the plans store's one write path, so the limits
 * are checked again and an imported trail's plan stays local.
 *
 * @returns the stored plan, or null when the store refused it (its
 *   `lastError` says why).
 */
export async function saveImportedPlan(
  plan: PlanDocument,
  trailId: string,
): Promise<PlanDocument | null> {
  const copy: PlanDocument = {
    ...plan,
    id: uuidv4(),
    trailId,
    updatedAt: new Date().toISOString(),
  };
  return usePlansStore.getState().apply(trailId, () => copy, { name: plan.name });
}

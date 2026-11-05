/**
 * The "Export for Tracknotes" button and its "Include my plan" checkbox, shared
 * by `my-trail.ts` and `community-route.ts`.
 *
 * The download is the `.tracknotes.json` handoff (`@lib/trail-handoff`) the
 * phone imports. When this browser holds a plan for the trail, the checkbox
 * appears (ticked) and the plan rides along in the same file, so a trail
 * planned here arrives on the phone planned. Only the `PlanDocument` goes —
 * pace, hours per day and the thresholds stay in this browser's `PlanUiPrefs`.
 *
 * A file with a plan is envelope version 2, which a phone on an older app
 * refuses ("exported by a newer version"); unticking the box writes the
 * version-1, trail-only file every app reads.
 */

import { handoffFileName, serializeTrailHandoff } from '@lib/trail-handoff';
import type { ProcessedTrail } from '@lib/trail-types';
import { loadPlanDocument, planStorageKind } from './trails/plan-state';

export interface TracknotesExportOptions {
  /** The trail to export, built at click time (a page may rename it in between). */
  trail: () => ProcessedTrail;
  /**
   * The id this browser keeps the trail's plan under: the import's own id on
   * `my-trail`, the saved local copy's on a community route.
   */
  planTrailId: string;
}

/** Wire the button and the checkbox. Missing elements are skipped, not errors. */
export function initTracknotesExport(options: TracknotesExportOptions): void {
  const button = document.getElementById('export-tracknotes-btn') as HTMLButtonElement | null;
  if (!button) return;
  const toggle = document.getElementById('export-tracknotes-plan-toggle');
  const checkbox = document.getElementById('export-tracknotes-plan') as HTMLInputElement | null;

  // Read fresh each time: the plan page, open in another tab, may have made
  // or deleted the plan since this page loaded.
  const syncToggle = (): void => {
    if (toggle) toggle.hidden = loadPlanDocument(options.planTrailId) === null;
  };
  syncToggle();
  window.addEventListener('storage', event => {
    if (planStorageKind(event.key, options.planTrailId) === 'document') syncToggle();
  });

  button.disabled = false;
  button.addEventListener('click', () => {
    const trail = options.trail();
    // Only a box the hiker could see and left ticked sends the plan.
    const include = checkbox !== null && checkbox.checked && toggle?.hidden !== true;
    const plan = include ? loadPlanDocument(options.planTrailId) : null;
    // Built lazily: a full-resolution track serializes to megabytes, and most
    // visitors never press this.
    const blob = new Blob([serializeTrailHandoff(trail, { plan })], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = handoffFileName(trail);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
}

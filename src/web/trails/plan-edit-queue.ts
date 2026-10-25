/**
 * Keeping two pages that edit one plan from overwriting each other.
 *
 * The planner and the resupply page both hold the trail's `PlanDocument` in
 * memory and write it whole to `localStorage` (`plan-state.ts`). Open side by
 * side, each would save its own copy over the other's edits. So neither page
 * writes a document it holds; it writes the edits it made, replayed on the
 * newest stored copy:
 *
 * - Every edit is recorded as a function of the document (`record`), applied
 *   to the page's copy at once so the page shows it.
 * - When another tab saves (`storage` event), the page takes the stored copy
 *   and replays its own unsaved edits on top (`rebase`).
 * - At save time, if storage no longer holds the copy the edits were made
 *   against, they are replayed on what it does hold (`resolveForSave`) —
 *   which also covers a `storage` event that has not been delivered yet.
 *
 * An edit the newer copy refuses (the editor throws: a stop that is no longer
 * there, a limit now reached) is dropped rather than failing the save.
 */

import type { PlanDocument } from '@lib/plan-types';

/** One edit, as a function of the document it applies to. */
export type PlanEdit = (doc: PlanDocument) => PlanDocument;

/** Apply edits in order; one the document refuses is skipped. */
export function replayPlanEdits(doc: PlanDocument, edits: readonly PlanEdit[]): PlanDocument {
  let next = doc;
  for (const edit of edits) {
    try {
      next = edit(next);
    } catch {
      // Refused on the newer copy: the edit no longer applies.
    }
  }
  return next;
}

const fingerprint = (doc: PlanDocument | null): string => (doc ? JSON.stringify(doc) : '');

export class PlanEditQueue {
  private base: string;
  private edits: PlanEdit[] = [];

  /** @param stored the document as storage holds it right now. */
  constructor(stored: PlanDocument | null) {
    this.base = fingerprint(stored);
  }

  /** An edit made on this page and not yet saved. */
  record(edit: PlanEdit): void {
    this.edits.push(edit);
  }

  get hasPending(): boolean {
    return this.edits.length > 0;
  }

  /** True when `stored` is the copy this page's edits were made against. */
  isBase(stored: PlanDocument | null): boolean {
    return fingerprint(stored) === this.base;
  }

  /**
   * Another page saved `stored`: the document this page should now show — the
   * stored copy with this page's unsaved edits replayed on it.
   */
  rebase(stored: PlanDocument): PlanDocument {
    this.base = fingerprint(stored);
    return replayPlanEdits(stored, this.edits);
  }

  /**
   * The document to write, given what this page holds (`ours`) and what
   * storage holds now (`stored`): `ours` while storage is still the copy the
   * edits were made against (or holds nothing), else the stored copy with the
   * edits replayed. Clears the edits; call {@link saved} once it is written.
   */
  resolveForSave(ours: PlanDocument, stored: PlanDocument | null): PlanDocument {
    const next = stored === null || this.isBase(stored) ? ours : replayPlanEdits(stored, this.edits);
    this.edits = [];
    return next;
  }

  /** `doc` is now what storage holds, and nothing is pending. */
  saved(doc: PlanDocument): void {
    this.base = fingerprint(doc);
    this.edits = [];
  }

  /** `doc` is now what storage holds; edits still pending stay pending (they are already in it). */
  stored(doc: PlanDocument): void {
    this.base = fingerprint(doc);
  }
}

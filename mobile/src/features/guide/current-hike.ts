/**
 * The "currently hiking" guide — the pure rule behind a fresh launch opening
 * straight into it. The choice itself is `currentTrailId` in the settings
 * store; My Guides puts it first in `guide-sections.ts` (`buildGuideSections`).
 */

/**
 * The trail a fresh launch should open, or null to stay on My Guides: only a
 * current trail the phone still lists, and never when the launch was for
 * something else (a file opened from outside the app).
 */
export function launchTrailId(
  currentTrailId: string | null,
  knownTrailIds: readonly string[],
  launchedForSomethingElse: boolean,
): string | null {
  if (!currentTrailId || launchedForSomethingElse) return null;
  return knownTrailIds.includes(currentTrailId) ? currentTrailId : null;
}

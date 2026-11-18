import type { DescriptionWriteFeature } from './comments-api-types';

/**
 * The capability marker of the comments API's curated-description routes.
 *
 * Two tools write `waypoint_descriptions`: the live description editor on the
 * deployed site and `scripts/upload-descriptions.ts`. Both rely on the worker
 * recording which of them wrote a row (`source`) and refusing a write over a
 * row that changed since the writer read it (`ifUpdatedAt`). A worker that
 * predates those ignores both fields of the PUT without an error: a save is
 * then last-write-wins, and the row is stored with no origin and later reads
 * as an upload, so a live edit made in that window is silently replaced by the
 * next upload.
 *
 * The site and the worker deploy separately, so a writer cannot assume the
 * worker it reaches is the one it was written against. The worker therefore
 * says so itself, in the public descriptions read
 * (`TrailDescriptionsResponse.writeFeatures`), and each writer checks that
 * before it sends anything: never by probing with a write.
 */

/** What the worker lists once it honours both. */
export const DESCRIPTION_WRITE_FEATURES: readonly DescriptionWriteFeature[] = ['source', 'ifUpdatedAt'];

/**
 * Whether a descriptions read came from a worker that records the origin of a
 * description and honours a write's precondition. Anything else, a missing
 * field included, is "no": the writer must not write.
 */
export function guardsDescriptionWrites(response: { writeFeatures?: unknown } | null | undefined): boolean {
  const features = response?.writeFeatures;
  return Array.isArray(features) && DESCRIPTION_WRITE_FEATURES.every(feature => features.includes(feature));
}

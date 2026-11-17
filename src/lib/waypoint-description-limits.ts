/**
 * The longest curated waypoint description, in one place for everything that
 * writes one: the trail build and `upload-descriptions` (through
 * `scripts/lib/waypoint-descriptions.ts`), the comments API's admin PUT
 * (`validateDescription` in `workers/comments-api/src/validation.ts`) and the
 * live description editor (`src/web/admin-descriptions.ts`). Counted on the
 * trimmed text, as all of them trim before checking.
 */
export const MAX_DESCRIPTION_LENGTH = 4000;

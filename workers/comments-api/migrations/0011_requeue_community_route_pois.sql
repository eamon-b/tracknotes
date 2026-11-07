-- Tracknotes comments API — re-run POI enrichment on community routes already
-- answered, so they get the POI self-dedup flags (issue #286).
--
-- #282 added the pass that sets `duplicateOfPoi` on an OSM POI repeating
-- another (`@lib/poi-dedup`, run by `finishTrailPois`). Routes the cron
-- enriched before that deploy still carry both records of a duplicated place.
-- This makes each of them due again, as 0009 made every route due at first:
-- the cron (`enrichCommunityRoutePois`, 3 routes a run) asks Overpass again,
-- runs the current passes, and republishes the route only if its POIs changed
-- (a new md5 and `updated_at`); one whose POIs come out the same is marked done
-- without a rewrite.
--
-- Which rows:
-- - `done`: the only routes whose stored POIs predate the pass. `pending` and
--   due routes run the new code anyway; a `failed` route is retried 14 days
--   after it was given up on; a `skipped` one has no POIs.
-- - Not `removed` (a tombstone, never republished). A `hidden` route is
--   included: the candidate query passes over it while it is hidden, and a
--   restore puts it back in the queue rather than republishing stale POIs.
--
-- `pois_status` stays 'done' (the stored JSON still carries POIs) until a run
-- claims the route. Re-running this file is harmless: it only requeues again.
--
-- Apply it after deploying the self-dedup pass (#282, deployed 6 Nov 2026).
-- Each requeued route costs one Overpass round, inside the cron's usual budget.

UPDATE community_routes
   SET pois_due_at = '', pois_attempts = 0, pois_failures = 0
 WHERE pois_status = 'done'
   AND status != 'removed';

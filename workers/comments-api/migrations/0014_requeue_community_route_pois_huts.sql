-- Tracknotes comments API — re-run POI enrichment on community routes already
-- answered, so a hut or shelter folded into its camp site shows again (#286).
--
-- The POI self-dedup pass (`@lib/poi-dedup` `markSelfDuplicatePois`, run by
-- `finishTrailPois`) used to fold a hut or shelter into a same-named camp site
-- (`Karta Burnu` under `Karta Burnu Camp Site`). It no longer does. Routes the
-- cron enriched before this deploy, including any 0011 requeued, may still carry
-- the roof flagged `duplicateOfPoi`. This makes each of them due again, exactly
-- as 0011 did: the cron (3 routes a run) asks Overpass again, runs the current
-- passes, and republishes a route only if its POIs changed.
--
-- The same rows as 0011: `done` and not `removed`. Re-running this file is
-- harmless: it only requeues again. *Deploy comments API* applies it and then
-- deploys, so a cron run landing between the two steps could re-run up to 3
-- routes with the previous rule; requeue again by hand if that matters.

UPDATE community_routes
   SET pois_due_at = '', pois_attempts = 0, pois_failures = 0
 WHERE pois_status = 'done'
   AND status != 'removed';

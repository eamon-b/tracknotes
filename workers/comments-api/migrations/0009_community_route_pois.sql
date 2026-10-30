-- Tracknotes comments API — OSM POIs for community routes (issue #163,
-- `plans/community-routes.md` "POI enrichment").
--
-- A submitted route is stored without POIs (`runCommunityChecks` drops any the
-- client sent). The scheduled handler (`enrichCommunityRoutePois` in
-- src/community.ts) later asks Overpass for the POIs along it, runs the
-- build's passes over them, and republishes the trail JSON with a `pois`
-- array. These columns are its bookkeeping; none of them is ever returned.
--
-- Apply this before deploying the code that reads it. (Deployed first, the
-- enrichment logs that the migration is missing and does nothing; the rest of
-- the API never reads these columns.)
--
-- `pois_status`: 'pending' (to do, or to retry), 'done' (the stored JSON
--   carries the POIs), 'failed' (gave up after the retry limit: the route is
--   shown without POIs), 'skipped' (too long, or too many POIs, to enrich: a
--   permanent answer for this geometry).
-- `pois_hash`: the `content_hash` the last final answer was for (NULL before
--   one).
-- `poi_count`: POIs in the stored JSON.
-- `pois_attempts` / `pois_attempted_at`: attempts for the current geometry
--   that failed for a reason tied to the route (Overpass refusing its query,
--   the platform stopping the run on it), and when the last one was claimed
--   (also the claim's guard). An outage (timeouts, 5xx, 429) never counts, and
--   an attempt that only ran out of the run's budget is given back.
-- `pois_failures`: consecutive failed attempts of any kind, for the back-off
--   (1 h, doubling, up to 2 days); 0 after an answer.
-- `pois_due_at`: when the route is next due — '' at once (a route never
--   tried), an ISO time after an attempt (the claim sets it an hour on, a
--   failure further), NULL once it has an answer or was skipped. A `failed`
--   route is due again 14 days after it was given up on, attempts reset.
--   The candidate query reads only this column (and the index below), oldest
--   due first. Whatever changes a
--   route's geometry in future must set it back to '' (and `pois_attempts` to
--   0) for the route to be enriched again.
-- `pois_error`: why the last attempt failed, was deferred or skipped, for the
--   admin and logs.
--
-- Every route already stored starts due (''), so the cron backfills them: each
-- live route is republished once with its POIs (a new md5 and `updated_at`).

ALTER TABLE community_routes ADD COLUMN pois_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (pois_status IN ('pending', 'done', 'failed', 'skipped'));
ALTER TABLE community_routes ADD COLUMN pois_hash TEXT;
ALTER TABLE community_routes ADD COLUMN poi_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN pois_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN pois_attempted_at TEXT;
ALTER TABLE community_routes ADD COLUMN pois_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN pois_due_at TEXT DEFAULT '';
ALTER TABLE community_routes ADD COLUMN pois_error TEXT;

CREATE INDEX idx_community_routes_pois_due
  ON community_routes(pois_due_at, created_at, id) WHERE pois_due_at IS NOT NULL;

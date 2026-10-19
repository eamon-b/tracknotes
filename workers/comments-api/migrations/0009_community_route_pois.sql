-- FarOut comments API — OSM POIs for community routes (issue #163,
-- `plans/community-routes.md` "POI enrichment").
--
-- A submitted route is stored without POIs (`runCommunityChecks` drops any the
-- client sent). The scheduled handler (`enrichCommunityRoutePois` in
-- src/community.ts) later asks Overpass for the POIs along it, runs the
-- build's passes over them, and republishes the trail JSON with a `pois`
-- array. These columns are its bookkeeping; none of them is ever returned.
--
-- `pois_status`: 'pending' (to do, or to retry), 'done' (the stored JSON
--   carries the POIs), 'failed' (gave up after the retry limit: the route is
--   shown without POIs), 'skipped' (too long, or too many POIs, to enrich: a
--   permanent answer for this geometry).
-- `pois_hash`: the `content_hash` that answer was for. A route whose
--   `content_hash` no longer matches (its geometry changed) is enriched again
--   whatever its status. NULL until the first answer.
-- `poi_count`: POIs in the stored JSON.
-- `pois_attempts` / `pois_attempted_at`: Overpass runs claimed for the current
--   geometry, and when the last one started (it is also the claim's guard).
-- `pois_error`: why the last run failed or skipped, for the admin and logs.
--
-- Every route already stored starts 'pending', so the cron backfills them.

ALTER TABLE community_routes ADD COLUMN pois_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (pois_status IN ('pending', 'done', 'failed', 'skipped'));
ALTER TABLE community_routes ADD COLUMN pois_hash TEXT;
ALTER TABLE community_routes ADD COLUMN poi_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN pois_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN pois_attempted_at TEXT;
ALTER TABLE community_routes ADD COLUMN pois_error TEXT;

CREATE INDEX idx_community_routes_pois_pending
  ON community_routes(created_at) WHERE pois_status = 'pending';

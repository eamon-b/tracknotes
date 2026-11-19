-- Additive: an index for the unfiltered admin comment listing
-- (`GET /v1/admin/comments`, newest first). Without it the listing scans and
-- sorts the whole table on every load; with it SQLite walks the index
-- backwards and stops at the LIMIT.
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at, id);

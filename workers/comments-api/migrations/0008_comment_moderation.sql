-- Trail Maps comments API — comment moderation brought up to the shared-waypoint
-- level (issue #156).
--
--   1. comments.deleted_by gains 'reports': `reportsToHide` distinct reports
--      from accounts a day old hide a comment, as they hide a shared waypoint.
--      A report hide is provisional: an admin restores it or deletes it.
--   2. comments.restored_at: the last admin restore. Only reports filed after
--      it count towards hiding the comment again.
--   3. users.banned_at: when an admin banned the account
--      (POST /v1/admin/users/:id/ban), and users.deleted_at: when it was
--      deleted (DELETE /v1/me). Both set `is_banned`, and a deleted account
--      must never be unbanned, so the two are told apart by `deleted_at`.
--      Deleted accounts are backfilled from what DELETE /v1/me leaves behind
--      (the fixed display name and every token revoked); every other banned
--      account was banned by hand in D1 and gets `banned_at`, so it can be
--      lifted. Both backfilled stamps are approximate.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Dropping a
-- parent table counts every row that references it as a foreign-key violation,
-- even with the check deferred and the table recreated under the same name
-- before commit, so comment_reports is rebuilt beside it: the new reports table
-- references the new comments table, the old pair is dropped child first, and
-- the rename carries the reference over to `comments`.

ALTER TABLE users ADD COLUMN banned_at TEXT;
ALTER TABLE users ADD COLUMN deleted_at TEXT;

UPDATE users SET deleted_at = COALESCE(last_seen_at, created_at)
 WHERE is_banned = 1 AND display_name = 'Deleted user'
   AND NOT EXISTS (SELECT 1 FROM device_tokens t
                    WHERE t.user_id = users.id AND t.revoked_at IS NULL);
UPDATE users SET banned_at = COALESCE(last_seen_at, created_at)
 WHERE is_banned = 1 AND deleted_at IS NULL;

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,                -- uuid v4, CLIENT-minted = idempotency key
  trail_id TEXT NOT NULL,
  waypoint_id TEXT NOT NULL,          -- opaque, ^[a-z0-9_-]{4,64}$
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT,
  water_status TEXT CHECK (water_status IN ('flowing','low','dry')),
  observed_at TEXT,                   -- clamped <= now+10min server-side
  created_at TEXT NOT NULL,           -- server clock, feed ordering
  updated_at TEXT NOT NULL,           -- bumped on delete/hide/restore; drives delta sync
  deleted_at TEXT,
  deleted_by TEXT CHECK (deleted_by IN ('owner','admin','reports')),
  photo_urls_json TEXT,
  photo_hashes_json TEXT,
  restored_at TEXT,                   -- last admin restore: only reports filed after it count
  CHECK (text IS NOT NULL OR water_status IS NOT NULL)
);

INSERT INTO comments_new
  (id, trail_id, waypoint_id, user_id, text, water_status, observed_at, created_at,
   updated_at, deleted_at, deleted_by, photo_urls_json, photo_hashes_json)
SELECT id, trail_id, waypoint_id, user_id, text, water_status, observed_at, created_at,
       updated_at, deleted_at, deleted_by, photo_urls_json, photo_hashes_json
  FROM comments;

CREATE TABLE comment_reports_new (
  id TEXT PRIMARY KEY,                -- uuid v4, server-minted
  comment_id TEXT NOT NULL REFERENCES comments_new(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('spam','offensive','inaccurate','other')),
  detail TEXT,                        -- optional free text, <= 500 chars
  created_at TEXT NOT NULL,
  UNIQUE (comment_id, user_id)        -- one report per reporter per comment
);

INSERT INTO comment_reports_new (id, comment_id, user_id, reason, detail, created_at)
SELECT id, comment_id, user_id, reason, detail, created_at FROM comment_reports;

DROP TABLE comment_reports;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
ALTER TABLE comment_reports_new RENAME TO comment_reports;

CREATE INDEX idx_comments_feed ON comments(trail_id, waypoint_id, created_at DESC);
CREATE INDEX idx_comments_sync ON comments(trail_id, updated_at, id);
CREATE INDEX idx_comments_user ON comments(user_id);
CREATE INDEX idx_comment_reports_comment ON comment_reports(comment_id);

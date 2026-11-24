-- Tracknotes comments API — releasing an established community route (#386).
--
-- `released_at`: when the owner deleted a route that had become established
-- (`COMMUNITY_ESTABLISHED` in `src/lib/community-types.ts`: shared for 30 days
-- and posted on by 3 other accounts). The route stays live but is de-attributed
-- as an account deletion de-attributes one (`submitted_by_name` cleared, the
-- stored JSON rewritten, the uploaded GPX deleted), and it is no longer its
-- owner's to edit or delete: it leaves their list and only admins can act on
-- it. `user_id` keeps pointing at the account, so the moderation trail is
-- intact. NULL on every route never released.

ALTER TABLE community_routes ADD COLUMN released_at TEXT;

# Reading comments through the public API

The comments API (`workers/comments-api/`, served at
`https://api.contour-map-tiles.net`) is what Tracknotes and the website read
hikers' comments, water reports and shared waypoints from. Those reads need no
account and allow any origin, so anyone can use them. This page says what they
return and asks a few things of anyone who keeps a copy.

It is a reference for people who find the API, not an invitation to mirror it:
the project does not offer a bulk export or a dataset download. Why is in
`docs/content-legal-posture.md` (decision 4).

## Licence

What hikers post is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (see
`docs/terms-of-service.md`). Points of interest are OpenStreetMap data, ©
OpenStreetMap contributors under the ODbL, and are not CC0. A display name is
shown as a courtesy, not as an attribution requirement.

## If you keep a copy

- **Drop what is deleted.** Hikers delete comments, moderators hide them and
  accounts are deleted. Poll with `?since=` and remove every id that comes back
  as a tombstone (`"deleted": true`).
- **Leave display names out of anything you republish in bulk.** With
  to-the-second times, a name's comments show where and when one person was on
  a trail.
- **Show a water report's age.** A report is what one hiker saw at
  `observedAt`. The app ignores reports older than 120 days and weights the
  rest by age, so an old "flowing" is not presented as current.
- **Be gentle.** These reads are not cached at the edge and run on a hobby
  budget. Page with the cursor, sync deltas rather than snapshots, and poll no
  more than hourly.

## Endpoints

Every response is JSON. Times are ISO 8601 UTC. Paging is keyset: pass the
response's `nextCursor` back as `?cursor=` until it is `null`. Types are in
`src/lib/comments-api-types.ts`.

Trail ids are the bundled trails' ids (`heysen`, `larapinta`, …; the list is
`ALLOWED_TRAILS` in `workers/comments-api/src/validation.ts`) and community
routes' ids (`c_…`, listed by `GET /v1/community/routes`). Waypoint ids are
`w_…` (curated waypoints, `data/waypoint-ids.json`), `uw_…` (a community
route's own), `hw_…` (a hiker's shared waypoint) or `osm_<node|way|relation>_<id>`
(an OpenStreetMap point of interest).

### `GET /v1/trails/:trailId/comments`

A trail's comments, oldest change first (`BulkSyncResponse`).

- `limit`: 1-1000, default 500.
- `since`: an ISO time. Without it the response is a snapshot of live comments.
  With it, it is every comment changed since then, deletions included as
  tombstones (`{ id, waypointId, deleted: true, updatedAt }`). Store the first
  page's `syncedAt` and pass it as the next `since`.

A live comment carries `id`, `waypointId`, `displayName`, `text`,
`waterStatus` (`flowing` | `low` | `dry` | null), `observedAt` (the day only:
midnight UTC of the observation's UTC date), `createdAt`, `updatedAt` and, when
it has any, `photoUrls`.

### `GET /v1/trails/:trailId/waypoints/:waypointId/comments`

One waypoint's live comments, newest first (`FeedResponse`). `limit`: 1-100,
default 20. No tombstones: use the trail-wide read to keep a copy current.

### `GET /v1/trails/:trailId/waypoints`

Hikers' shared waypoints on a trail (`SharedWaypointsResponse`), with the same
`since`, tombstone and cursor rules as the comments read.

## Your own comments

`GET /v1/me/comments` is the personal export, the one export the project
offers. It needs the account's token, so in practice it is the phone's
Settings → Your comments → Export my comments. It returns every comment the
account posted, oldest first, including deleted and hidden ones with
`deletedAt` and `deletedBy` (`owner` | `admin` | `reports`), and no display
name (`MyCommentsResponse`; `limit` 1-1000, default 500).

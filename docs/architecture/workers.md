# Cloudflare workers (`workers/`)

Moved out of `CLAUDE.md` (issue #160) so the per-module detail is read on demand rather than loaded into every session.
`CLAUDE.md` keeps the commands, the rules and a pointer here;
keep this file in step with the code it describes.
Both workers deploy from GitHub Actions on a merge to `main` that changes them (`docs/deploys.md`).
Comments API migrations must be additive (expand, then contract in a later release): the deploy applies them while the previous worker is still serving, and refuses one that drops or renames anything, which is then applied by hand (`docs/deploys.md`, "Migrations are additive").
A migration that adds routes adds a line to `scripts/probe-comments-api.sh`, which the deploy runs against the live API;
its probes are unauthenticated GETs, so a POST-only route is probed for its 405 (the router answers 405 for a known path with the wrong method, 404 for an unknown one), and `workers/comments-api/test/probes.test.ts` runs every line against the worker so a wrong expectation fails CI rather than a deploy.

## Comments API Worker: staging (`workers/comments-api/`, `[env.staging]`)

**What exists.**
A second copy of the comments API, for testing a branch end to end without touching production: Worker `tracknotes-comments-staging` on its `workers.dev` URL (`https://tracknotes-comments-staging.<account subdomain>.workers.dev`, no custom domain), D1 `tracknotes-comments-staging` (created 2026-11-11 with `--location oc`) and R2 bucket `tracknotes-data-staging` for `PHOTOS`, read publicly through the bucket's `r2.dev` URL (`PHOTOS_PUBLIC_BASE`).
It is `[env.staging]` in `wrangler.toml`.
Wrangler environments inherit `routes`, `workers_dev` and `triggers` but no bindings or vars, so the section redeclares every binding and var, and sets `routes = []` (else a staging deploy would claim `api.tracknotes.info`) and `crons = []`.
The tests read only the top-level (production) config, with their own overrides in `vitest.config.mts`.

**How it differs from production.**
No cron, so nothing runs `runCommunityMaintenance`: de-attribution retries, stale-review re-runs and POI enrichment do not happen (to test `scheduled`, add a cron to `[env.staging.triggers]` on the branch, deploy, and take it out again).
`OVERPASS_ENDPOINTS` is empty: staging never sends a route outline to the Overpass operators.
`AI_GATEWAY_ID` is empty.
The `AI` binding is kept, but Llama Guard is only called when `ANTHROPIC_API_KEY` is set, and staging has no secrets by default, so nothing is screened or reviewed and it costs nothing;
set the key (`wrangler secret put ANTHROPIC_API_KEY --env staging`) only to test the reviews, and every new comment with text, waypoint create or edit, and review is then billed as in production.
`SITE_BASE` (share links) is a never-resolving `.invalid` placeholder unless the workflow is given a preview origin (next paragraph).
No CSAM scanning: the `r2.dev` URL is on no zone of ours.
The bucket needs a CORS rule allowing `GET`/`HEAD` from any origin, as the production bucket has: the web page of a community route downloads its trail JSON from `PHOTOS_PUBLIC_BASE` with `fetch` (`fetchCommunityTrail`), which a preview origin can only read with CORS.

**Share links from previews.**
Vercel Preview builds take `VITE_API_BASE_URL` = the staging URL, so every preview deployment reads and writes staging (CORS is `*`, so any preview origin may call it).
`shared-plan.html` reads the share from its own build's API, so a staging share opens on *any* preview and on no production page.
The Worker mints links as `SITE_BASE/shared-plan.html?s=<id>`: set the variable `STAGING_SITE_BASE` on the `staging` environment to a stable preview origin (a branch alias, or a domain assigned to Preview) and the workflow deploys with `--var SITE_BASE:<it>`.
It is set to `https://tracknotes-git-staging-eamons-projects-081eddcd.vercel.app`, the Vercel branch alias of the long-lived `staging` git branch, which exists only for this: Vercel builds it as a Preview, so it is built against the staging API and sits behind Vercel Authentication.
Do not delete that branch, and fast-forward it to `main` now and then (`git push origin origin/main:staging`) so the page that opens shared plans stays current.
Not a custom domain: the project's deployment protection exempts custom domains, so a preview on one would let anyone write to staging.
Without it the link's host is the placeholder, deliberately not `tracknotes.info` (which would answer "not found"): swap in any preview's host.
"Open in Tracknotes" (`tracknotes://plan/<id>`) opens whichever API the phone's build was given, so it finds a staging share only on a build pointed at staging.

**Deploying.**
Agents may deploy staging; production deploys only from `main` (`docs/deploys.md`).
Two workflows deploy it, so that the staging token never shares a job with a branch's code (`docs/deploys.md`, "staging", for why that matters).
*Staging comments API (build)* (`.github/workflows/staging-comments-api.yml`) runs on every same-repo PR that touches `workers/comments-api/**` or `src/lib/**` (never a fork's), and from *Run workflow* on any branch.
It holds no secrets and names no environment: it bundles the branch with `wrangler deploy --dry-run --env staging --outdir` and uploads the bundle and the migration SQL as an artifact.
*Staging comments API (deploy)* (`.github/workflows/staging-comments-api-deploy.yml`) follows a successful build (`workflow_run`), so GitHub runs `main`'s copy of it whatever the branch changed.
It checks out `main`, takes the Worker name, D1, R2 and vars from `main`'s `[env.staging]`, and treats the artifact as data: it refuses symlinks and unexpected file names, runs `scripts/check-worker-migrations.ts` on the SQL, applies it to the staging D1, uploads the bundle with `--no-bundle`, runs `main`'s `scripts/probe-comments-api.sh` against the staging URL (in the run's summary), and posts a `staging` commit status on the PR's head.
Its `wrangler` is the version `main`'s `package-lock.json` resolves (as production deploys with), installed outside the checkout, and every call passes `--env-file /dev/null`, since wrangler otherwise loads `.env` files and one setting `CLOUDFLARE_API_BASE_URL` would send the token elsewhere.
What that costs: a PR's own `wrangler.toml` changes (a new binding, var or compatibility flag) are not deployed to staging until they merge, so test those by hand;
a PR's new probe lines are not run against staging (the *Tests* workflow runs every line against the worker, `test/probes.test.ts`);
and a change to either workflow takes effect only once it is on `main`.
Runs never overlap, and GitHub keeps one pending run: a third run cancels the one waiting, so re-run a cancelled run (the deploy, or the build) to put that branch back on staging.
A PR run deploys the PR merged into its base, as CI tests it.
The deploy uses only the staging secrets `CLOUDFLARE_STAGING_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `STAGING_API_BASE_URL` (the staging URL, which it probes), all on the GitHub environment `staging`, never production's `CLOUDFLARE_API_TOKEN`;
without them its `configured` job ends with a notice, the `staging` job is skipped and no status is posted, so a green `staging` status always means the branch was deployed and probed.
By hand, from `workers/comments-api/` with the staging token in `CLOUDFLARE_API_TOKEN`: `npm run migrate:staging && npm run deploy:staging`, `npm run tail:staging` for its logs, and `scripts/probe-comments-api.sh <staging URL>` (or `COMMENTS_API_BASE_URL=<staging URL>`).

**Shared, last deploy wins.**
There is one staging Worker and one staging database.
Runs never overlap (`concurrency: staging-comments-api`), but the latest deploy replaces the code of every earlier one, so check the run's summary for which branch is live before testing, and re-run your branch's workflow if another has deployed since.
Every PR's migrations stay applied to the one D1, including a migration later renamed or dropped before it merged; reset staging when it drifts from `main`: delete and recreate the database (`wrangler d1 delete tracknotes-comments-staging`, then `wrangler d1 create tracknotes-comments-staging --location oc`, put the new id in `[env.staging]`, `npm run migrate:staging`), and empty the bucket if its objects matter.

**Data policy: test data only.**
Post nothing real to staging, and anyone may wipe it at any time.
Accounts there are separate from production's (another database): an admin is made the same way, by setting `users.is_admin` on the staging D1.
Real users cannot reach it while two things hold: shipped app builds and `tracknotes.info` call production only, and Vercel previews stay behind Vercel's deployment protection (Vercel Authentication), so only team members open a preview that writes to staging.
That protection is an owner-managed Vercel project setting (Settings → Deployment Protection), not anything in this repository, and this privacy reasoning depends on it staying on for Preview.
So `docs/privacy-policy.md` and `docs/data-residency.md` need no line for it (both describe where real users' data is stored); if previews were ever made public, or a build shipped pointed at staging, staging would hold real users' posts and would need both, with an OC placement check like production's.

**Pointing a client at staging.**
- Phone (dev build, Metro): `EXPO_PUBLIC_API_BASE_URL=<staging URL>` in `mobile/.env.local`, then restart Metro (it inlines `EXPO_PUBLIC_*` at bundle time).
  An EAS build takes its value from `eas.json` instead (`docs/mobile-test-build.md`).
  The phone keeps one identity: its production token gets a 401 from staging and the app registers a new staging account, forgetting the production one, and switching back registers yet another production account (the old one's comments stop being "mine").
  Use an emulator or an install whose production identity does not matter.
- Web, local: `VITE_API_BASE_URL=<staging URL> npm run dev`.
- Web, Vercel Preview: the project's `VITE_API_BASE_URL` for the **Preview** environment is the staging URL, Production keeps `https://api.tracknotes.info`;
  a change takes effect on the next preview build (Vite inlines it).
  It is the web's only API setting: nothing else in `src/web/` names the production API (the `tracknotes.info` strings in `src/lib/contribution-licence.ts`, `plan-export` UIDs and the GPX namespace are the site's own identity, not API calls), and browser sessions are per origin, so a preview never sees a production session.

## Comments API Worker: community routes (`workers/comments-api/`)

`src/community.ts` / `src/community-review.ts` (migrations `0005`, `0006`; `0009` and `0011` for POIs): D1 `community_routes` + `community_route_reports`.
A submit re-runs `@lib/community-checks` (with the uploaded GPX as `gpxText`, for the `speed` check) and stores *its* rebuilt trail, never the client's JSON, with `config` rewritten server-side (id, name, `source: 'community'`, country/states, description, CC0 `dataSource`).
The bucket has no private area (all of it is served at `PHOTOS_PUBLIC_BASE`), so private objects live at unguessable keys recorded in the row and never returned (the admin trail route below returns the canonical JSON's bytes, not its key): the canonical trail JSON at `community/private/<id>/<32 random hex>.json` (`private_key`) and the optional raw GPX (≤ 5 MB) beside it as `.gpx` (`gpx_key`; a file whose head is not `<gpx` is dropped, not refused).
While a route is live, a public copy of the same bytes sits at `community/v1/<id>.<md5[0..12]>.json` (`r2_key`; `max-age=300`, so an edge copy outlives a hide by minutes, not a year).
An owner's edit writes new objects, keeps the public version it replaced (cached lists still name it) and purges older ones;
a de-attribution purges the old public versions at once, since they name the deleted account;
hiding a route (AI review, reports or admin) deletes every object under `community/v1/<id>.` and NULLs `r2_key`, so owner/admin detail of a hidden route has `trailUrl: null`;
an admin sees its line through `GET /v1/admin/community/routes/:id/trail` (`adminGetCommunityTrail`), which streams the private copy's bytes for any status but `removed` (`requireAdmin` before the row is read, so a non-admin gets 401/403 for any id; 404 for an unknown or removed id; 409 `conflict` when an edit replaced the copy mid-read; `Cache-Control: private, no-store`), and never the key or the raw GPX;
an admin restore from hidden always republishes from the private copy (if it is gone: 404 when removed meanwhile, 409 `conflict` when the row changed, else 500 `trail_missing`), and a hide re-reads the row after its purge and republishes a route a restore made live meanwhile;
removal purges both prefixes.
Every row change sets `updated_at` strictly later than the value it read (`stampAfter`);
an owner's PATCH, an admin status change, a de-attribution, the AI review and the POI enrichment write only if `status`/`updated_at` still match the row they read — a lost race returns 409 `conflict` (PATCH, admin) or retries (de-attribution) and deletes the objects it wrote, and a stale review writes nothing (its verdict write leaves `updated_at` alone).
`@lib/community-checks` rebuilds every distance and climb from the coordinates (point km, length, display points, waypoint and variant km, 3 m-hysteresis climb) and drops client route breaks, POIs and `cumAscent`/`cumDescent`, so no client-claimed distance or climb is stored.
The duplicate hash is sha256 of the trail without its `config`, so a rename does not get past it (the 409 carries `existingId` only for the caller's own route; the near-duplicate warning names the other route by id);
a body whose non-GPX part exceeds 4 MB + 64 KB is refused 413 `trail_too_large` before it is checked;
the 10-a-day `communitySubmit` limit is spent only after the checks pass and the stored JSON measures ≤ 4 MB, `communitySubmitAttempt` (30 a day) is spent by every submit before its body is parsed, and `communityEdit` (20 a day) by every PATCH that changes something.
The `claude-sonnet-5-5` review (structured output, `fallbacks: 'default'`, all route text fenced as untrusted) runs from `waitUntil` (SDK client with a 20 s timeout and 1 retry) and **fails open** — `skipped` without the `ANTHROPIC_API_KEY` secret (`wrangler secret put ANTHROPIC_API_KEY`), `failed` on an API error or refusal.
The review also sees a bounded sample of waypoint descriptions, the variant names, and a sample of off-trail and variant waypoint names (≤ 200 names in all, at least 50 of them off-trail/variant when there are that many).
A reject with confidence ≥ 0.8, or 3 distinct reports filed after the route's last admin status change (`status_changed_at`) by accounts at least 24 h old when they reported (`REPORTER_MIN_ACCOUNT_AGE_MS`; younger accounts' reports are stored but do not count), hides an *unverified* route;
a verified one stays up and rises to the top of the admin queue.
An owner's detail of a hidden route (`GET /v1/me/community/routes`, or `GET /v1/community/routes/:id` with their token) carries `hiddenReason` (`'review' | 'reports' | 'admin'`).
It is derived from the hide's `status_note`: the review and report hides write the fixed `REVIEW_HIDE_NOTE`/`REPORTS_HIDE_NOTE`, and anything else counts as an admin hide.
`statusNote` itself stays admin-only, and an admin note equal to either fixed note is refused 400 `invalid_note`.
Only an admin verifies.
Deleting an account de-attributes its routes (CC0) rather than removing them;
`deattribute_pending` keeps that durable, and a Cron Trigger (`*/15 * * * *`, `runCommunityMaintenance` in `src/index.ts`'s `scheduled`) retries pending de-attributions, re-runs AI reviews left `pending` over 10 minutes, and adds OSM POIs to routes that have none (see "community route POIs" below; on while `OVERPASS_ENDPOINTS` lists instances).
A submit also adds the `region` check (`checkCommunityRegion`: a warning when the coordinates are in another country or state, never a change to the hiker's choice), and a PATCH that changes the region re-runs it.
A PATCH re-runs the `metadata` check.
Reports spend the `communityReport` bucket (20 a day) through `consumeRateLimit`, and a report that loses its insert race to a parallel repeat hands the unit back (`refundRateLimit`).
A banned account may still report a route (reporting is a safety action, as for comments and shared waypoints).
The public list and "my routes" are keyset-paged (`?cursor=` / `nextCursor`).
A route an admin removed (or its owner deleted while an admin had it hidden) sets `blocks_resubmit`, refusing the same track again.
**Established routes** (issue #386, migration `0015`): a live route shared at least `COMMUNITY_ESTABLISHED.minAgeDays` (30) ago, by `created_at`, with a live comment or shared waypoint from at least `minOtherPosters` (3) accounts other than its owner, is established.
Only posts made when their account was at least `REPORTER_MIN_ACCOUNT_AGE_MS` (24 h) old count, as for reports, so fresh accounts cannot lock an owner out of deleting.
The owner's and admins' detail (`GET /v1/community/routes/:id`, `GET /v1/me/community/routes`) carries `established` and `otherPosters` for a live route (`otherPosterCounts`: one statement for a whole page, the ids passed as one JSON array through `json_each`); the public detail never does.
The owner's plain `DELETE` of an established route is refused 409 `route_established`, so an app from before releases never tells its hiker a route was deleted when it was not, and a current client that read the route before it became established asks again, as a release.
An owner's `?release=1` always releases a live route, established or not by then (what they confirmed), is 409 `conflict` on one hidden since, and repeated by the account that released it answers the same 200 (a lost response, a double tap, another device), never a 404 a phone would take for "deleted";
`releaseCommunityRoute` sets `released_at`, clears `submitted_by_name` and sets `deattribute_pending` in one statement guarded on `updated_at` (409 `conflict` if the route changed), answers 200 `{ released: true }`, and runs the account-deletion de-attribution (`deattributeRoute`: the JSON rewritten without the name, the GPX and older copies purged; retried by the cron).
A released route stays live but is no longer its owner's (`ownsRoute`): it leaves "my routes", their detail is the public one, a PATCH or DELETE from them is 404, and they may report it like anyone; admins keep every power over it and see `releasedAt`.
`deattributeStatement` leaves a released route's `deattribute_pending` as it is.
An admin's delete is always a removal, of their own route too, and a hidden route is never established.
Comments, plan sync and shared hiker waypoints take a community route's id as well as `ALLOWED_TRAILS` (next section).

## Comments API Worker: which trails (`workers/comments-api/src/trails.ts`)

`resolveTrail(env, trailId, use)` is the one trail gate for comments, plans, shared waypoints and the descriptions read.
A trail is either curated (`ALLOWED_TRAILS`, held equal to the bundled trails by `scripts/server-trail-allowlist.test.ts`) or a community route (`isCommunityRouteId`, plus a row in `community_routes`: one primary-key read).
Anything else — a `u_` import above all — is 400 (`invalid_trail`; `trail_not_allowed` for a plan).
What a route takes depends on its status: a **public write** (`PUT /v1/comments/:id`, `PUT /v1/waypoints/:id`, a new share or an edit) needs a live route (`unverified`/`verified`), else 403 `trail_not_live`, so nothing new is published on a route nobody can see;
a **private write** (`PUT /v1/plans/:id`) and the **reads** (`GET /v1/trails/:id/waypoints`, `/descriptions`) take any route the server has a row for, hidden or removed included — a plan is the hiker's own, and the phone keeps a route that was taken down ("No longer shared").
The public feeds of a removed route close `REMOVED_ROUTE_FEED_DAYS` (30) after its `removed_at` (issue #386): `resolveTrail` returns `feedOpen`, and the shared-waypoint list, the bulk comment sync and the waypoint comment feed answer an empty page (with `syncedAt` where they carry one) once it is false, so a phone keeps what it already holds.
The comment feeds take any trail id, so they ask `publicFeedOpen`, which looks up only a `c_` id and answers open for one with no row (empty, as before);
a hidden route's feeds stay open, and the admin comment list ignores `feedOpen`.
Deletes, reports and replays are not gated by trail.
Rows are never deleted (removal is a tombstone), so "is a community route" is cached for the isolate's life and "is live" for `LIVE_CACHE_MS` (60 s, live results only): a hide stops new comments within a minute on every isolate, and a restore is read at once.
A read re-reads any entry older than `LIVE_CACHE_MS` that is not yet removed (a removal is final, and the cache keeps its `removed_at`), so a feed closes on time on every isolate.
The descriptions read answers an empty list for a route (its descriptions are in the route itself);
the admin description PUT stays curated-only (`validateTrailId`).
That PUT is `requireAdmin`, which takes any live token of an admin account, a linked browser's included, so the live description editor (`src/web/admin-descriptions.html`) writes with the browser's own token and needs no route of its own;
`TRACKNOTES_ADMIN_TOKEN` (what `upload-descriptions` sends) is just one such token.
Its length limit is `MAX_DESCRIPTION_LENGTH` in `src/lib/waypoint-description-limits.ts`, shared with the trail build and the editor.
Each row records which tool last changed its text, in `waypoint_descriptions.source` (migration `0012_description_source`, one nullable column): `live` for the editor page, `upload` for the script.
It comes from the PUT's body (`source`, validated: 400 `invalid_source`), not from the token, because both writers present an admin account's bearer token and nothing fixes whether the upload's is a `primary` or a `linked` one.
It is stored whenever a write changes the text, and the read and the PUT answer it on every row (`WaypointDescription.source`);
a row with none stored — every row from before the migration, and a write that names none — is served as `upload`, which is true of the older rows, since the editor did not exist before the column did.
So only a worker that predates the migration omits the field, and a reader treats its absence as "unknown";
the phone ignores it.
The descriptions read also says what the PUT honours: `writeFeatures: ["source", "ifUpdatedAt"]`, a top-level field beside `descriptions` and `syncedAt`, on every answer (a delta, a trail with no rows and a community route's empty list included).
It exists because the site and this worker deploy separately, and a worker from before `source` and `ifUpdatedAt` ignores both in a PUT without an error: a write to it is last-write-wins and leaves no origin, so the row later reads as an upload.
A trail with no synced rows shows nothing to tell such a worker by, so both writers read the field instead of inferring (`guardsDescriptionWrites` in `src/lib/description-write-features.ts`, which also holds the list the worker sends):
the live description editor is read-only without it, and `upload-descriptions` sends nothing without it unless told to (`--allow-unchecked-live`).
Neither probes with a write.
The phone's sync reads `descriptions` and `syncedAt` only (`mobile/src/sync/comment-sync.ts`), so shipped builds ignore the extra field.
It names the tool, never the account or the token: the table has no column about who wrote a description, and curated descriptions are editorial text, not a hiker's data, so `docs/privacy-policy.md` and `docs/data-residency.md` need no line for it.
A PUT of the text a row already holds changes nothing, `updated_at` included, with one exception: an `upload` of the text a `live` row holds sets `source` to `upload` and leaves `updated_at` alone.
That is how a live edit that has been committed to `descriptions.json` stops counting as one (`upload-descriptions` re-sends it for that) without any phone downloading it again.
`ifUpdatedAt` in the body is the writer's optimistic check: the `updatedAt` it last read for the row, or `null` for "no row" (anything else is 400 `invalid_precondition`).
When the row has changed since and does not already hold the text sent, nothing is written and the answer is 409 `description_conflict`, with `current` (the row as stored, or `null`) beside the error envelope;
each conditional write is one statement, so two editors cannot both pass the check.
Both writers send it: the editor, so that two admins do not overwrite each other, and `upload-descriptions`, so that it never replaces a row edited after it read the live set (the file is the source of truth only over what its plan showed; `docs/architecture/build-scripts.md`).
A PUT without `ifUpdatedAt` is unconditional, as before: that is what an older client sends.
The migration adds no route, so `scripts/probe-comments-api.sh` has no probe for it.

## Comments API Worker: community route POIs (`workers/comments-api/`)

**On (Workers Paid).**
`OVERPASS_ENDPOINTS` in `wrangler.toml` `[vars]` lists the instances;
empty switches the enrichment off (routes are shared without POIs).
It was shipped off and switched on once the account moved to Workers Paid (2026-10-20): its CPU (below) is far over Workers Free's 10 ms per invocation but well inside Paid's default 30 s of CPU per invocation (`wrangler.toml` sets no `[limits] cpu_ms`; the 15 minutes often quoted is a Cron Trigger's wall-clock limit, which the run's own `wallMs` of 6 minutes stays inside), so a move back to Free means emptying it again.
How it was turned on: apply migration `0009` (`npm run migrate:remote`), then set `OVERPASS_ENDPOINTS` to comma-separated https URLs — the list `wrangler.toml` suggests is `overpass-api.de`, `overpass.private.coffee`, `overpass.kumi.systems`, the three `INTERACTIVE_OVERPASS_ENDPOINTS` the phone uses — and `npm run deploy`.
Every instance listed receives each live route's outline, so `docs/privacy-policy.md` and `public/privacy.html` name their operators;
add an instance there before adding it here (`maps.mail.ru`, which `fetch-pois` sometimes needs, is deliberately not listed).
Migrations `0009` and `0011` are applied in production, so the enrichment assumes their columns exist.

**CPU on Workers Free.**
Free allows 10 ms of CPU per invocation, cron included;
waiting on Overpass is wall time and does not count, but what the run computes does, and it is well over 10 ms for any real route.
`scripts/measure-community-poi-cpu.ts` (`npx tsx scripts/measure-community-poi-cpu.ts [trail-id …]`, after `npm run build:trails`) times each step on bundled trails standing in for community routes;
on 2026-10-19 (Node, the same V8 as workerd; medians): Cape to Cape (0.5 MB stored JSON, 39 POIs) ~20 ms in all;
Larapinta (1.2 MB) ~60 ms;
the Heysen and the Bibbulmun (5-6 MB, more than the 4 MB a community route may be, so an upper bound) ~350-400 ms — parsing the stored JSON ~35 ms, planning the corridor ~200-270 ms (almost all `buildCorridorChunks`' Douglas-Peucker, the build's own), placing and finishing the real answer ~20-25 ms, re-encoding with its md5 ~65-80 ms.
A synthetic answer at the enrichment's own cap (12,000 elements, ~1.8 MB) adds ~15 ms to parse and 140-260 ms to finish (mostly the duplicate and city-thinning passes; the placement itself goes through `createRouteIndex`, without which it alone took seconds).
On Free the platform may stop the run at any of these points (the limit is enforced with some leniency, not reliably);
on the Paid plan (30 s CPU per invocation by default, the cron included) it fits with room to spare.
What a stopped run costs is bounded: the claim is written before any work, so the attempt counts and the route is given up on after 4 (`failed`: shown without POIs, tried afresh 14 days later) rather than retried every hour;
one stopped after writing its R2 objects but before its D1 write leaves a private JSON (and possibly a public copy) the row does not name — the private one is swept the next time the route is answered or given up on (`sweepPoiLeftovers`: everything under its private prefix the row does not name, older than the purge grace), and a public copy, content-addressed and listed nowhere, goes at the route's next republish (`purgeSuperseded`), hide or removal.

**What it does.**
`enrichCommunityRoutePois` in `src/community.ts` is the third task of the `*/15` cron's `runCommunityMaintenance`, after the de-attribution retry and the stale-review re-run;
`src/community-pois.ts` does the Overpass part.
A submit stores the route without POIs (`runCommunityChecks` drops any the client sent; that stays so — POIs come only from the server) and never waits on Overpass.
A later run asks Overpass for the POIs within 2 km of the route — main track, alternates and side trips — exactly as `scripts/fetch-pois.ts` and the phone do: `@lib/trail-poi-search` `planTrailPoiSearch` cuts it into the build's corridor queries (`@lib/osm-poi`/`@lib/poi-enrichment`, the `gpx-tools` port), and its `finishTrailPois` places the answers on the trail's km (`indexed`: the `createRouteIndex` grid) and runs the build's passes (noise, duplicates of the route's own waypoints, city thinning, OSM's own repeats — `duplicateOfPoi`; no `TrailPoiConfig`, which a community route never has) and `slimPoi`.
Only the HTTP is the worker's own (`queryOnce`), because it spends the run's budget.
The trail JSON is then republished with a `pois` array, its config rebuilt as an edit rebuilds it (`withServerConfig`) with the OpenStreetMap credit in `dataSource` (`communityDataSource`: the hiker's part CC0, the POIs © OpenStreetMap contributors under the ODbL, linking openstreetmap.org/copyright; every later rebuild — an edit, a de-attribution — keeps it while the route has POIs): a new private and public object, `md5`/`bytes`/`updated_at` moved (phones see the md5 change and download it again; `updated_at` is the row's version and the public "updated" time of the JSON, which did change — `status_changed_at`, which the report count runs from, and the review are untouched), guarded on `status`/`updated_at` like an owner's edit (a lost race drops its objects and gives the attempt back), the old private object deleted and older public versions purged as after an edit.
A route whose stored POIs come out unchanged is marked done without a rewrite.
Because the POIs live in the canonical private JSON, every republish keeps them: an owner's edit and a de-attribution re-store from it, a restore republishes it.
`content_hash` is never recomputed, so the duplicate check is unaffected.
Backfill: migration `0009` makes every stored route due, so after it is switched on each live route is republished once with its POIs (a new md5 and `updated_at` each).
Re-run: migration `0011` makes every `done` route that is not removed due again (`pois_due_at = ''`, attempts and failures 0), so the cron re-runs the current passes over routes enriched before the POI self-dedup pass (#282) and they get `duplicateOfPoi`.
Migration `0014` does the same again for #286, which stopped the pass folding a hut or shelter into the camp site mapped round it: a route 0011 re-ran under the old rule still has the roof hidden until it is re-run.
*Deploy comments API* migrates and then deploys, so a cron run landing between those two steps (at most 3 routes) can still use the previous rule.
Each costs one Overpass round per route, 3 routes a run;
a route whose POIs come out the same is marked done without a rewrite, one that changed is republished (a new md5 and `updated_at`).
A hidden route is requeued too, and waits until a restore makes it a candidate.
It needs nothing beyond the normal deploy (`npm run migrate:remote` applies it), and it is idempotent: a second application only requeues, and a re-run that finds the flags already stored rewrites nothing.
Flagging lazily on read was not an option: phones and the web download the trail JSON straight from R2 (`trailUrl`, content-addressed and md5-checked), so no worker code sees a read, and a changed body needs a new md5 in the list anyway.
The tests cover a route stored without the flags (as a pre-#282 worker left it) re-enriched from the same Overpass answer.
Apply it after the code it re-runs is deployed, and reuse the same pattern (a migration that sets `pois_due_at = ''` on `done` routes) whenever a change to `finishTrailPois` should reach stored routes.

**Which routes, in what order.**
`pois_due_at` alone decides (index `idx_community_routes_pois_due` on `(pois_due_at, created_at, id)` where it is set, which serves both the range and the order; the query keeps the planner off the status index with `+status`): `''` for a route never tried, an ISO time once an attempt has claimed it (an hour on; further after failures, see below), NULL once it has an answer or was skipped;
a `failed` route is due again 14 days after it was given up on.
Candidates are live routes (`unverified`/`verified`) due by now, untouched for 2 minutes and with no AI review `pending` (so the enrichment's write can never make a review lose its guard or push back the stale-review re-run), oldest due first, then oldest created — a route a run had to pass over keeps its place at the head of the next. 3 a run.
Whatever changes a route's geometry in future must set `pois_due_at = ''` and `pois_attempts = 0` (and should drop the old `pois`);
nothing does yet (replacing the GPX is a new submission).

**Budget and failure.**
At most 20 Overpass requests a run across every route and endpoint (`POI_RUN_LIMITS`; on Paid the platform's subrequest cap is far above that, so the budget is ours, to keep a run's load on the volunteer-run instances small; Free would allow 50 external subrequests an invocation, of which the stale-review re-run may spend 10), 25 s Overpass `[timeout:]` with the request abandoned 5 s later, 1 s between requests — so one request takes at most `WORST_REQUEST_MS` (31 s), and every request must be able to finish within 6 minutes of the run's start.
A route needing more than 10 corridor queries (`POI_LIMITS.maxQueriesPerRoute`, roughly 3,000-6,000 km; the Heysen takes 2) is `skipped`, never fetched in part;
10 × 31 s fits the 6 minutes, so any route that is fetched fits a fresh run however slow each answer is.
A route is claimed (attempt counted, retry time set) before any work;
it then starts only if all its missing answers fit what the run has left (requests and time, at the worst case each), else gives the attempt back untouched.
Each answer is streamed under an 8 MB cap counted in bytes as received (`readCapped`: a declared `Content-Length` over it is refused unread, a chunked body is cancelled the moment it passes it);
an answer over it, more than 12,000 distinct POIs fetched, more than 4,000 to ship, or a JSON over 4 MB makes the route `skipped`.
Each answered query is cached in R2 beside the route's private copies (`community/private/<id>/overpass-<hash>.json`, the hash of the query salted with the route's id and `content_hash` — what stays put while the geometry does — so an owner's edit or a de-attribution, which rewrite the private copy, keep it usable; the content is public OSM data, so the key need not be secret; deleted once the route is answered or given up on).
A route removed during an attempt stops it at the next answer (`PoiAnswerCache.put` re-reads the row and writes nothing for a removed route), and the private prefix is purged again afterwards in case an answer landed after the removal's own purge, so removal still leaves neither prefix behind, so a later attempt asks only for what is missing.
A query goes to the instance that answered last, then the others;
a 429 or 503 with `Retry-After` is honoured — that instance is left alone for the time asked, and the run waits for the first one free when every other has failed or is waiting, if the wait is at most 60 s and still leaves time for the route's remaining queries — and a longer `Retry-After` benches the instance for the rest of the run.
**Fails open**: an attempt that ends without every answer stores nothing on the route, which stays as it is, without POIs.
What happens next depends on why (`PoiFailure`): **an outage never uses up a route's attempts** — a network error, a timeout, a 5xx, a 408 or 429, a `runtime error` remark or a page that is not JSON gives the attempt back, and the route backs off instead (`pois_failures` consecutive failures: due again 1 h, 2 h, 4 h … after the attempt, capped at 2 days by `poiBackoffMs`; reset by an answer), so even a week-long outage of every instance (all three were unreachable from a cloud session on 2026-09-30, see `build-scripts.md`) costs each route a few requests a day and recovers by itself.
Only a failure tied to the route counts: an HTTP 4xx other than 408/429 (Overpass refusing its query), its stored copy missing, or the platform stopping the run while on it (the claim, never recorded).
Those back off the same way;
the 4th marks the route `failed`, with its attempts reset and due again 14 days later (`failedRetryAfterMs`), so no state needs a hand-run SQL fix.
An attempt that only ran out of the run's budget, lost a race with an edit, or met a removal is given back without backing off.
A route too long, with too many POIs or too large a JSON is `skipped` for its geometry, for good.
`pois_error` records why (`run_budget`, `rate_limited`, `overpass: <host>: <error>; …`, `route_too_long`, `too_many_pois`, `trail_too_large`, `route_changed`, `gave_up`).

**Not kept across attempts, and why:** a partial set of POIs is never published (a route would look as if it had nothing on the stretch that failed);
the per-query cache is what carries progress, and it lives only until the route is answered.

## Comments API Worker: comment targets and limits (`workers/comments-api/`)

A comment's `waypointId` is checked by its prefix (`validateCommentTarget` in `src/validation.ts`, over `@lib/comment-targets`), and the kind must fit the trail's: `w_` + 8-40 hex with an optional `_<n>`, n from 2 (the curated registry, and the later passes of a revisited place, `<id>_2`, as the build writes them; curated trails only), `uw_` + 1-40 lowercase alphanumerics with an optional `_<n>` (a community route's own waypoints, the ids its import minted and the server stored as submitted; `c_` routes only — form only, like the curated ids: the worker carries neither the registry, a route's stored trail nor the POI lists, so a route whose file holds some other id for a place takes no comments on it, and the phone offers no composer there), `hw_` + a lowercase v4 uuid (must be a shared waypoint the server holds on that trail: 404 `waypoint_not_found` if not, 410 `waypoint_deleted` once tombstoned), or `osm_<node|way|relation>_<safe integer>` (`poiCommentId`).
Anything else is 400 `invalid_waypoint`, since no screen would show it.
`test/comment-guards.test.ts` holds every id in `data/waypoint-ids.json` to it.
The phone's drain holds a comment on the hiker's own `hw_` waypoint while that waypoint's share is still pending or in flight (`outboxRepo.hasPending`; gated like a photo on its comment, re-checked pass after pass until a pass sends nothing).
A share that failed is not waited on: the comment goes and takes the 404.
A replay of a stored comment is answered before the body is validated, and a request that loses the insert race to its own replay hands its rate-limit unit back (`refundRateLimit`).
Plans and curated descriptions still take the looser `^[a-z0-9_-]{4,64}$`.
A comment's optional `observedAt` (when the hiker saw the water) is kept **to the day only** (issue #248; why in `docs/content-legal-posture.md`): `clampObservedAt` refuses a malformed value 400 `invalid_observed_at`, clamps one more than 10 minutes ahead to `now + 10 min`, then floors it with `observedDayIso` to midnight UTC of its **UTC** date, still a full ISO timestamp (`2026-10-30T00:00:00.000Z`) because the phone `Date.parse`s it and compares it as a string with `created_at` (`water-status-repo`).
The UTC date, not the hiker's local one: clients send `toISOString()`, so the offset is unknown, and flooring only ever makes a report look older (under a day), never fresher.
Every read that returns it (the PUT response and replay, the per-waypoint feed, the bulk/delta feed, the admin listing) passes the stored value through `publishedObservedAt`, which floors it again, so a row written to the second before migration `0010` (which coarsens stored rows and bumps a live row's `updated_at` so phones re-sync it) never publishes the time.
`created_at` stays exact.
Every rate limit, the comment post (60 a day), comment report (20 a day) and photo upload (`photoUpload`, 40 a day) limits included, goes through `consumeRateLimit` in `src/rate-limit.ts`;
never count a table's rows and insert after, which a parallel burst gets past.
A photo upload spends its unit once, after the replay and "comment full" checks and before the R2 put, and hands it back (`refundRateLimit`) unless the photo ends up attached (a later round that finds a replay, a full comment or a conflict), so a delete-and-repost still counts.
Each spent unit prunes its own subject's rows outside the window (indexed by `(bucket, key, created_at)`);
rows of every subject past the longest window go in the `*/15` cron's `pruneStaleRateEvents`, a full-table delete that is deliberately not on the request path.

## Comments API Worker: reading comments, and the personal export (`workers/comments-api/`)

The comment reads are public and unauthenticated: `GET /v1/trails/:trailId/waypoints/:waypointId/comments` (newest first) and `GET /v1/trails/:trailId/comments` (snapshot, or delta with tombstones under `?since=`), both carrying the author's display name because the app shows it.
They are documented for outside readers in `docs/public-api.md`, deliberately not promoted as a bulk export.
`GET /v1/me/comments` (`getMyComments` in `src/comments.ts`) is the hiker's personal export: every comment the caller's account posted, oldest first, keyset-paged by `(created_at, id)` (500 a page, at most 1,000), **deleted and hidden ones included** with `deletedAt`/`deletedBy` (an owner's delete keeps the text in D1, so the export shows what the server holds), `private, no-store`, any token of the account (a linked browser too).
It carries **no display name**: names are left out of every export.
After `DELETE /v1/me` the token is gone, so there is nothing to export;
the tombstones' text is already erased.

## Comments API Worker: shared hiker waypoints (`workers/comments-api/`)

`src/shared-waypoints.ts` (migration `0007`): D1 `shared_waypoints` + `shared_waypoint_reports`.
`PUT /v1/waypoints/:id` creates (the client-minted `hw_` id is the idempotency key) or is the owner's edit — an identical PUT is a replay that leaves `updated_at` alone;
one its owner deleted (made private) is revived by the owner's next PUT, under the same id;
one an admin or reports hid answers 410;
every write stamps `updated_at` just before the statement that commits it, so a concurrent delta read cannot get ahead of it;
`sharedWaypointCreate` (20 a day) and `sharedWaypointEdit` (60) rate buckets.
`DELETE` is owner or admin.
`POST /v1/waypoints/:id/report` is one per reporter (`sharedWaypointReport`, 20 a day, handed back when the insert loses a race to a parallel repeat; not your own), the first qualifying one starts the automated review ("comment and waypoint review" below), which may tombstone it at once, and `USER_WAYPOINT_LIMITS.reportsToHide` (3) distinct reporters tombstone it whatever the review said (`deleted_by = 'reports'`), counting only accounts at least 24 h old when they reported (`REPORTER_MIN_ACCOUNT_AGE_MS`) and only reports filed after the last admin restore (`restored_at`).
`POST /v1/admin/waypoints/:id/restore` undoes an admin or report hide (not an owner's delete).
`GET /v1/trails/:trailId/waypoints?since=` is the public full/delta read (tombstones in delta mode, 2,000 rows a page, keyset-paged by `(updated_at, id)` through `nextCursor` like the comments feed);
a token, when sent, adds `mine`.
`GET /v1/admin/waypoints` lists them reported first.
The trail must be curated or a live community route (`resolveTrail`; the listing takes a hidden one too), so imports keep their waypoints private.
Deleting an account tombstones its shared waypoints, as it does its comments.

## Comments API Worker: comment moderation (`workers/comments-api/`)

`src/reports.ts`, `src/comments.ts`, `src/moderation.ts` (migration `0008`, which rebuilds `comments` and `comment_reports` because SQLite cannot widen a CHECK — dropping a referenced table fails D1's foreign-key check even deferred, so the pair is rebuilt together).
Comments are moderated like shared waypoints: the first qualifying report starts the automated review (next section), which may hide one at once, and `COMMENT_REPORTS_TO_HIDE` (3) distinct reporters tombstone one whatever it said (`deleted_by = 'reports'`), counting only accounts at least 24 h old when they reported (`REPORTER_MIN_ACCOUNT_AGE_MS`), never the author, and only reports filed after the last admin restore (`restored_at`).
A comment's author cannot report it (400 `own_comment`, as for routes and waypoints).
A report hide keeps the photos, but moves them off the URLs clients already hold (`hideCommentPhotos` in `src/photos.ts`, from `waitUntil` after a report hide and awaited after a review hide): each object is copied to a fresh uuid key under the same `comments/<id>/` prefix, `photo_urls_json` is swapped to the new URLs by compare-and-swap on the row still being report-hidden (leaving `updated_at` alone, since a tombstone carries no photos), and only then are the old objects deleted;
a restore or final delete meanwhile makes the swap miss and the copies are deleted instead, and an R2 failure leaves the hide standing with the photos at their old URLs (logged, not retried).
An edge-cached copy of an old URL can outlive the delete until its cache expires.
The new URLs are what the admin listing and the author's export show, and an admin restore needs nothing more: its `updated_at` bump delivers them to phones in the next delta, where the client upserts the row and its photo URLs.
`POST /v1/admin/comments/:id/restore` undoes it (the restore reaches the author's phone through the public `GET /v1/trails/:trailId/comments?since=` feed, which, like the waypoints feed, adds `mine` to live rows when a token is sent — a bad or expired token reads as anonymous, and a token-bearing response is `Cache-Control: private, no-store`), and an owner's or admin's `DELETE` (or account deletion) makes it final and purges them (from R2 and from `photo_urls_json`) — an owner or admin delete cannot be restored.
`GET /v1/admin/comments?reported=1` and `GET /v1/admin/waypoints` carry every report (reason, detail, reporter) and whether the author is banned.
`POST /v1/admin/users/:id/ban` `{ banned, removeContent? }` bans or unbans (never an admin);
`removeContent` admin-deletes the account's comments and shared waypoints, and revokes its plans' share links in the same batch (`share_id = NULL`, `updated_at` and the document's own `updatedAt` stamped, as `stampDocument` does, so the owner's devices learn it on their next pull; the plans stay the account's).
A ban without `removeContent` leaves share links up, as it leaves posts up.
A ban sets `users.banned_at`;
account deletion sets `is_banned` and `users.deleted_at`, and a deleted account can never be unbanned (the migration backfills both columns: deleted accounts by their fixed display name and revoked tokens, every other banned account as banned).
The admin listings carry `userBanned`, `userAdmin` and `userDeleted`, so the page offers only the ban actions the server will take.
Every tombstone the ban writes is stamped after its reads, just before the batch that commits it.
The admin page is `src/web/admin-moderation.html` (unlinked, noindex, client `src/web/api/moderation.ts`).

**Moderation counts** (`src/moderation-counts.ts`, issue #365, no migration).
`GET /v1/admin/moderation/counts` answers `{ comments: { waiting, hidden }, waypoints: { waiting, hidden }, total }` (`ModerationCountsResponse` in `@lib/comments-api-types`) for the daily *Moderation queue* workflow (`scripts/moderation-queue.ts`, `docs/deploys.md`).
"Waiting" is `needsAttention` (`@lib/moderation-attention`, the rule the moderation page highlights with) in SQL: `deleted_by = 'reports'`, or live, with no `restored_at`, and a review verdict of `remove` or `needs_human`;
"hidden" is the `deleted_by = 'reports'` arm alone.
Like the `?reported=1` listing it reads only rows with a report or a review, and its test checks that its counts equal `needsAttention` over the admin listings.
Its credential is the worker secret `MODERATION_COUNTS_TOKEN` (`wrangler secret put MODERATION_COUNTS_TOKEN`), a bearer accepted on this route and nowhere else: it is not a device token, so it is no admin on any other route, and an admin's device token gets 401 here.
The presented token and the secret are both SHA-256 hashed and the digests compared character by character with no early exit;
while the secret is unset or under 32 characters (`MIN_COUNTS_TOKEN_LENGTH`) the route refuses everyone with 401, so the probe (`scripts/probe-comments-api.sh`, 401 without a token) holds either way.
It returns counts only, never post text, names or reports, with `Cache-Control: private, no-store`.

## Comments API Worker: comment and waypoint review (`workers/comments-api/`)

`src/content-review.ts` (migration `0010_content_review`: `review_status`, `review_json`, `review_requested_at` on `comments` and `shared_waypoints`, plain added columns so neither table is rebuilt).
`0010_content_review` shares its number with `0010_observed_at_day`: wrangler records migrations by file name, so both apply and neither may be renamed (the one after them is `0011_requeue_community_route_pois`).
`scripts/check-worker-migrations.ts` fails on any other shared number, a gap or a misnamed file, and two places run it.
The root suite (`scripts/worker-migrations.test.ts`) catches two branches that each add "the next migration" only when the second one's CI runs on top of the first after it merges (rebased onto `main`), while its file can still be renumbered.
A pull request whose CI last ran before the other merged still shows green, and `main` does not require branches to be up to date before merging (#369), so both can merge;
*Deploy comments API* therefore runs the check before it applies any migration, and a collision on `main` stops the deploy (and the push's Tests run goes red) rather than reaching production.
To recover, renumber the migration that is not yet applied in production (`npx wrangler d1 migrations list DB --remote` names the unapplied ones) and re-run the deploy.
Its job is to take clearly bad or malicious posts down after **one** report rather than three.
Two triggers claim a review (`claimContentReview`, one `UPDATE … RETURNING`, so concurrent reports claim it once; the claim leaves `updated_at` alone, so phones do not re-sync):

- **A report** (`reviewOnReport`, from `ctx.waitUntil` in `reportComment` / `reportSharedWaypoint`): needs at least one qualifying report (account a day old when it reported, not the author, since `restored_at`).
  It claims a post never reviewed, one whose review `failed`, or one reviewed only because of the screen (so the report's words are weighed);
  a `done` report review is never asked again, and later reports only count towards the three-report backstop.
- **The screen** (`screenOnPost`, from `waitUntil` after a comment is created with text, and after a shared waypoint is created, revived or edited): Llama Guard 3 (`@cf/meta/llama-guard-3-8b` on the `AI` binding) reads the comment text, or the waypoint's name and description.
  A flag in `SCREEN_CATEGORIES` (S1-S12 minus S6 specialised advice, which is all hiking advice, and S13 elections) claims a review;
  the screen never hides anything itself.
  An owner's waypoint edit resets the review columns (the old verdict was about the old text) and screens the new text.

`reviewContent` sends the post (comment: text, water status, observed time, photo **count**, place id; waypoint: name, type, description, position) and the newest five reports' reason and note to `REVIEW_MODEL` (`claude-sonnet-5-5`, structured output, effort low, the same SDK settings as the route review), fenced in `<post>` with `<`/`>` escaped.
Never photos, display names or account data.
Verdicts `remove` / `needs_human` / `keep` with a confidence and categories;
`remove` at `CONTENT_REVIEW_HIDE_CONFIDENCE` (0.85) or above tombstones the post as `deleted_by = 'reports'` with `review.hid = true` (the same provisional hide an admin restores or makes final, so `DeletedBy` and the phones are unchanged).
The write and the hide are one batch guarded by the `updated_at` read before the call: an owner edit, a three-report hide or an admin action meanwhile wins, and the review stays `pending` for the cron.
It **fails open**: no key, an API error, a refusal or an unusable answer is `failed` and hides nothing.
A post an admin restored (`restored_at` set) is never claimed again, so only reporters can hide it after that.
The same restore endpoint on a **live** post is the admin's **Keep**: it sets `restored_at` without moving `updated_at` (nothing a phone sees changes), so the reports so far stop counting, the review never claims it again, and it leaves the top of the queue.
Because Keep and an account deletion of an already-hidden post change the row without moving `updated_at`, the verdict write is also guarded on `restored_at` and `deleted_by`;
a review that loses that guard stays `pending` and the cron's re-run records it from the current row, without hiding it.
Account deletion drops the review's `summary` (it paraphrases the erased text) and keeps the rest of `review_json`.
Water-only comments (no text) are never reviewed.
The `*/15` cron runs `rerunStaleContentReviews`: up to `STALE_CONTENT_REVIEW_BATCH` (5) per table still `pending` `STALE_CONTENT_REVIEW_AFTER_MS` (2 min) after their claim (a `waitUntil` cut short; the review's timeout plus one retry can outlast its ~30 s).

Admin: `GET /v1/admin/comments?reported=1` lists reported **or reviewed** comments (a screen-flagged one may have no report; the partial index `idx_comments_review` serves that arm), hidden first, then those the review would `remove` or wants a human for and no admin has restored or kept (`reviewFlaggedSql`), then by report count;
`GET /v1/admin/waypoints` orders the same way.
Both listings gather each row's reports (`reports_json`) only for the page, in an outer query over the LIMITed rows, which repeats the order;
the waypoint listing takes its report counts from one grouped pass over `shared_waypoint_reports` rather than a probe per row (its order still reads every waypoint).
The unfiltered `GET /v1/admin/comments` (newest first) walks `idx_comments_created` on `(created_at, id)` (migration `0013_admin_comments_index`) and stops at the LIMIT.
Across every trail the comment listing is one read: `limit` (default 100, at most 500) and `reported=1` are all it takes, it has no cursor, and its answer is `{ comments }`, so a read that comes back full may have left rows behind.
`?trail=<id>` reads one trail to its end instead (a curated trail or a community route, checked by `resolveTrail`; anything else is 400 `invalid_trail`).
A trail's rows come newest first by `(created_at, id)` whatever `reported` says: both columns are immutable, so a keyset over them neither skips nor repeats a row while rows are hidden, restored or reported between pages, which the reported-first order (a report count that moves with every report) cannot promise.
The answer is `{ comments, trailId, nextCursor }`: `trailId` echoes the filter, and `nextCursor` is the `cursor` for the next page, null on the last (the delta feeds' opaque `base64("created_at|id")`, `src/cursor.ts`; a malformed one is 400 `invalid_cursor`).
A worker from before the filter ignores `trail` and answers for every trail without either field, which is how a client tells that its filter was not applied (`adminListModeratedComments` in `src/web/api/comments.ts` then falls back to the two unpaged reads).
With `trail`, `reported=1` narrows to the reported or reviewed comments, and `moderated=1` to what moderation has touched and the author has not withdrawn: hidden by reports or the review, deleted by an admin (reported or not), or still published with a report or a review result;
never a published comment nobody reported, and never one its author deleted, even a reported one.
That is the set the waypoint editor lays over a trail's public comments, so its read grows with moderation, not with the trail's comments.
`cursor` and `moderated=1` without `trail` are 400 (`invalid_cursor`, `invalid_moderated`): only a trail's listing has a keyset order, and unfiltered the moderated filter would walk the table.
A trail's read finds its rows through `idx_comments_sync` (`trail_id` leads it) and sorts them, so it reads that trail's comments and never scans the table (`test/admin-comments.test.ts` holds the plan);
it has no index of its own on `(trail_id, created_at, id)`, which would only spare the sort when the unnarrowed `?trail=` listing of a very large trail is paged, and nothing pages that today.
Both admin listings carry `review` (`ContentReview` in `@lib/comments-api-types`), which `src/web/admin-moderation.ts` shows ("Hidden by the automated review", the verdict, confidence, categories, summary and trigger).

Without `ANTHROPIC_API_KEY` nothing is screened or reviewed and comments and waypoints are hidden by three reporters only.
Tests run with `remoteBindings: false` (`vitest.config.mts`) and no key, so the binding is never called;
the review tests inject a fake client and a fake `AI`.

**Setup outside the code** (dashboard; none of it is needed for the review to work):

1. **AI Gateway** (logs, spend and rate limits for every model call, Anthropic and Workers AI).
   Create a gateway (Cloudflare dashboard → AI → AI Gateway) and set `AI_GATEWAY_ID` in `wrangler.toml` to its name;
   empty means calls go straight to the provider.
   If it is an Authenticated Gateway (the auto-created `default` gateway is), create a token and `wrangler secret put AI_GATEWAY_TOKEN`, or every Anthropic call fails (the review then records `failed` and hides nothing).
   The gateway logs request bodies by default, which hold the reported text: set a short log retention, or turn off body logging, to keep it no longer than D1 does.
   A gateway URL that cannot be resolved falls back to the direct API.
2. **CSAM Scanning Tool** (photos are not reviewed by any model).
   Cloudflare dashboard → Caching → Configuration → CSAM Scanning Tool, for the zone serving `PHOTOS_PUBLIC_BASE` (`data.tracknotes.info`), and for `contour-map-tiles.net` while `data.contour-map-tiles.net` still serves older photo URLs;
   it needs a verified notification email.
   It scans images served through Cloudflare's cache, so check in the dashboard that it covers the R2 custom domain.
3. **Workers AI** needs no setup on Workers Paid;
   Llama Guard is billed per request (one per new comment with text, and per waypoint create or edit).

## Comments API Worker: accounts and linked browsers (`workers/comments-api/`)

`GET /v1/me/devices` (`listDevices` in `src/link.ts`) lists the account's tokens that still sign in: neither revoked nor past `expires_at` (a linked browser's token lapses 180 days after its last use).
Activity is tracked per token (`device_tokens.last_seen_at`, rolled by `getUser`);
`users.last_seen_at` is written once, at registration, and never updated.
`users.token_hash` is still written, and read only by `healMissingPrimaryToken` (`src/auth.ts`), which adopts an account the `0004` backfill could not have seen.

## Comments API Worker: plan documents (`workers/comments-api/`)

`src/plans.ts` (migration `0004`): D1 `plans` holds each `PlanDocument` whole in `document_json`, so a new document field needs no migration — but `validatePlanDocument` (`src/validation.ts`) rebuilds the stored document **field by field**, so a field it does not name is silently dropped on `PUT /v1/plans/:id` and lost on the next sync.
A new field therefore ships as a worker change first (validated, then copied onto `document`), deployed before any client sends it.
Each field is refused with a 400 (`planError`) rather than trimmed.
`resupplyZeroDays` (zero days per resupply stop, by option id) is checked against `PLAN_LIMITS.resupplyZeroDaysMax` (500 entries), keys against the waypoint-id pattern (4-64 of `[a-z0-9_-]`) and values with `@lib/plan-types` `isStoredZeroDays` (half-day steps, 0.5 to `zeroDaysMax` 14) — `invalid_resupply_zero_days`;
an empty map is stored as none.
`startZeroDays` (zero days before day 1) is one `isStoredZeroDays` figure — `invalid_start_zero_days` for anything else, 0 included;
absent or null is none.
**Older clients.**
A client saves the whole document it holds, so one built before a field existed would leave it out and erase what a newer client stored (#283).
The body therefore carries `planSchema`, the plan-field revision its client knows (`@lib/plan-types` `PLAN_SCHEMA`; absent = 0, the builds and web tabs from before it; anything but a non-negative integer is 400 `invalid_plan_schema`; it is never stored).
`keepFieldsNewerThanClient` copies over from the stored document every field whose `PLAN_FIELD_SCHEMA` revision is above the request's and which the request leaves out — only from the live plan on the same id and trail, so an undelete or a trail change inherits nothing.
A kept `resupplyZeroDays` is then cut to the request's `resupplyStops`, and dropped when the request has no selection but the stored plan had one (a reset, or All, on the old client — read as a reset, so no day the hiker removed is counted unseen);
both without a selection keeps it.
A kept `startZeroDays` is not re-judged when an old client moves `startDate`: the zero days stay before day 1 of the new date.
A client that knows a field clears it by leaving it out or sending null;
a revision-0 client that knows one cannot clear the last of it until it is updated, which is the price of not knowing which revision-0 build sent the request.

## Contour Tile Worker (`contours/worker/`)

Part of the public contour dataset (`contours/README.md`): the app is one client of it, and its contract with the app is what `scripts/e2e-tile-check.mjs` checks.
Cloudflare Worker serving contour vector tiles from PMTiles on R2.
URL pattern: `/{source}/{z}/{x}/{y}.pbf`.
Uses R2 bucket `aus-map-data`: source `world` serves `contours/world.pmtiles` (Copernicus GLO-30), and `contours` is an alias of it, kept because shipped Tracknotes builds request `/contours/…` for Australian trails and read `/health`'s top-level `ok` (which follows `DEFAULT_SOURCE`, `world`).
PMTiles instances are cached per R2 key, so the two names share one.
Until #228 `contours` served `contours/australia.pmtiles` (Geoscience Australia DEM-S);
that archive stays in R2 as a frozen public download (last built 2026-10-23) but is no longer served or rebuilt.
Repointing a source needs a purge of its edge-cached URLs (`tiles.contour-map-tiles.net/contours/*` after this one).
Built with `wrangler`;
details in `contours/worker/README.md`.

**App tile Worker.**
The same code is deployed a second time as `tracknotes-tiles` (`[env.app]` in `contours/worker/wrangler.toml`, `wrangler deploy --env app`): `tiles.tracknotes.info`, bucket `tracknotes-data`, and one source, `base`, which serves `basemap/planet.pmtiles`.
That is the Protomaps planet basemap the bundled packs are extracted from, which the phone fetches along an imported or community route to build its offline pack (#227; the 2026-11-06 build, copied in server-side, see the worker README).
It is the app's, not the dataset's, so the public contour endpoint serves no basemap (#269): its Worker requests and R2 reads are the app's to pay for, and they sit behind the `tracknotes.info` zone's rules, not `contour-map-tiles.net`'s. A deployment's sources come from `resolveSourceConfig` in `src/sources.ts`: the dataset's defaults when it sets no vars, else its `SOURCES` and `DEFAULT_SOURCE` vars, which must come as a pair (a bad pair throws on every request rather than falling back).
`/health`'s top-level `ok` and status follow that deployment's default source alone, `base` here, so nothing depends on a `world` it does not serve.
The raw archive is not downloadable from the bucket's public domain (#304): a WAF custom rule on the `tracknotes.info` zone blocks `/basemap/*` on `data.tracknotes.info` (rule and checks in the worker README).
Nothing in the app or scripts reads that path — the Worker reads the archive through its R2 binding, which zone rules do not touch.
`scripts/e2e-tile-check.mjs --base` checks `sources.base`, and fails if it is not ok (`BASEMAP_UPLOADED`, set since the planet upload).

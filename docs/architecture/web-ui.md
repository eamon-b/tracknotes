# Web UI (`src/web/`)

Moved out of `CLAUDE.md` (issue #160) so the per-module detail is read on demand rather than loaded into every session.
`CLAUDE.md` keeps the commands, the rules and a pointer here;
keep this file in step with the code it describes.

**Name and address.**
The site and the app are both **Tracknotes**, and the site is served at `https://tracknotes.info` (the Vercel project; `trail-maps.vercel.app` is retired and nothing keeps it working).
Every page title ends ` - Tracknotes`, except the landing page's (`Tracknotes - Long-Distance Hiking Trail Guides`) and the two standalone policy pages in `public/` (`Tracknotes Privacy Policy`, `Tracknotes Terms of Service`).
The origin is written down in two places that must move together: `SITE_ORIGIN` in `src/lib/contribution-licence.ts` (the privacy and terms links the app and store listings use) and `SITE_BASE` in `workers/comments-api/wrangler.toml` (shared-plan links).
Browser storage keys are `tracknotes-*` (theme, list filter, POI filter).
The theme key is also read by a pre-paint script in the `<head>` of every page built from `src/web/` (not the standalone `public/privacy.html` and `terms.html`, which follow the system setting only).
The hand-written top-level pages carry a `<!-- @theme-head -->` marker that the `theme-head` Vite plugin replaces with that script and the `theme.ts` module, from the one copy in `theme-head.ts`;
the four trail templates carry the same script inline, because `build-trails.ts` writes their pages before Vite sees them, and `theme-head.test.ts` holds them to it and every top-level page to the marker.
"Trail Maps", the old name, survives only in history (migration notes, dated log entries);
the GitHub repo is `eamon-b/tracknotes`.
The app's own hosts are on the same domain: the comments API at `api.tracknotes.info` trail data, offline packs and photos at `data.tracknotes.info` (R2 bucket `tracknotes-data`), and the basemap tiles imported and community routes' corridor packs are built from at `tiles.tracknotes.info` (the `--env app` deployment of `contours/worker/`, issue #269).
`contour-map-tiles.net` (`tiles.` included) belongs to the public world-contours dataset (`contours/site/`), which the app uses but does not own.

**Supported browsers.**
`vite.config.ts` pins `build.target` to Vite 6's old `modules` default (es2020, Chrome 87, Firefox 78, Edge 88, Safari 14) rather than Vite 8's Baseline Widely Available default (Safari 16.4, Chrome 111), so older phone browsers still get a working page.
Raising the floor is a deliberate change to that list, not a side effect of a Vite upgrade.

- `index.html` / `index.ts` - Landing page: filter bar (search, length chips, sort; `localStorage` `tracknotes-list-filter`), Featured (hidden when empty), curated trails grouped Country → State in collapsible sections, Community routes (only when `VITE_API_BASE_URL` is set, Verified/Unverified badges; the list has a 10 s deadline, after which the tier shows its error note), My trails (IndexedDB) with a "Shared by me" block when the API is set and the browser is linked: the reader's own routes from `listMyCommunityRoutes` (same 10 s deadline, fetched in parallel; failures stay inside the block; a 401 clears the session and offers the link form), hidden ones with why (`hiddenReasonText`) and the review summary.
  Its footer links `public/terms.html` and `public/privacy.html`, the same pages as `TERMS_URL` and `PRIVACY_POLICY_URL` in `@lib/contribution-licence`.
  "On the map" (`landing-map.ts`, issue #163) follows the Community section's rule (shown only when the API is set; a failed list still shows the curated markers): one circle marker per curated trail (index `start`) and community route (summary `start`, else its bbox centre) the filter keeps, popups linking to each page;
  no track is downloaded.
  Leaflet (the trail pages' unpkg build and SRI hashes) is injected only when the map nears the viewport (IntersectionObserver), longitudes are unwrapped so the fit is Pacific-centred when that is tighter, and marker colours are theme tokens restyled on `onThemeChange`.
  Rendering is pure and tested in `index.test.ts` and `landing-map.test.ts`;
  styles in `trail-list.css`
- `styles.css` - Global styles and the light/dark theme tokens
- `theme.ts` - Light/dark/system theme: applies `data-theme` to `<html>`, renders the toggle, and exposes `onThemeChange()`/`themeColor()` so canvas and Chart.js code can follow the theme
- `theme-head.ts` - The pre-paint theme script and the `@theme-head` marker inliner (see **Name and address** above)
- `trails/trail-template.html` - Template for individual trail pages
- `trails/trail-viewer.ts` - Interactive trail viewer (map, elevation profile, waypoints).
  The main route is one Leaflet polyline per stretch on the default SVG renderer: Polyline's `smoothFactor` already runs Douglas-Peucker in screen pixels per reprojection, so a 20,000-point line costs the browser no more vertices than the zoom can resolve.
  Map hover goes through `@lib/point-index` — set `displayPoints` only via `setDisplayPoints`, which rebuilds that index.
  Waypoint marker popups (main-route and off-trail) name the type with `waypointTypeLabel`, as the datasheet and the planner do, never the raw slug.
  The waypoints table ("datasheet") filters to the water or food/resupply family via `@lib/waypoint-taxonomy`;
  when filtered, the leg columns are recomputed between *visible* rows so resupply-leg distances read directly off the table.
  Row interaction is delegated from `#waypoints-container`, not the tbody, because every re-render replaces the tbody.
  The map's expand button (under the zoom control) makes `#trail-map` a fixed full-window overlay (`.is-expanded`; Esc exits), a CSS overlay rather than the Fullscreen API, which iOS Safari only grants to video.
  OSM POIs start switched off on the web (`defaultWebPoiFilterState` in `trail-pois-ui.ts`) until the hiker ticks the master switch, which is remembered;
  the phone keeps the shared `defaultPoiFilterState` (on).
  A POI flagged `duplicateOf` a waypoint is never drawn or listed, but its tags show in that waypoint's marker popup (main-route, off-trail and terminus-end markers, and the planner's popups too; the trail page draws no markers for other alternate or side-trip waypoints, so POIs flagged against those show only on the phone) as a collapsed "From OpenStreetMap" `<details>` (`trail-pois-ui.ts` `waypointOsmDetailsHtml`, as on the phone's waypoint screen);
  the trail page binds its waypoint popups as functions, so they are built on open and pick up POIs the imported-trail page's enrichment adds later.
  A POI flagged `duplicateOfPoi` (OSM mapping the place twice) is likewise never drawn or listed;
  the POI it points at carries its tags (`mergedPoiTags`: gaps only) and an "Also in OpenStreetMap as" link in its popup (`poiPopupHtml(poi, selfDuplicatesOf(pois, poi))`)
- `trails/waypoint-icons.ts` - The glyph each waypoint type and POI category is drawn with (inline SVG from `@lib/map-glyphs`, the phone's shapes) and its `wp-fam-<family>` colour class, for both viewers and the POI UI
- `trails/access-path.ts` - An off-route place's walk in from the route (`offTrailPath`) as a dotted Leaflet line, shared by both viewers; drawing only
- `linkify-text.ts` - Waypoint descriptions as escaped HTML with their URLs, email addresses and phone numbers made links (`@lib/text-links`, hrefs through `safeHttpUrl`/`safeTelUrl`); kept out of `web-utils.ts` so the landing page does not load `@lib/poi-display`
- `trails/trail-export.ts` - The text of the trail page's two downloads (datasheet CSV and GPX), kept out of the viewer so the formats are testable without a map;
  guards CSV cells against spreadsheet formula injection
- `trails/climate-template.html` - Template for climate data pages
- `trails/plan-template.html` - Template for plan visualization pages
- `trails/plan-shell.html` - The one copy of the plan page's `#plan-shell` markup (header + three panels).
  `build-trails.ts` inlines it into `plan-template.html` and the `plan-shell` Vite plugin inlines it into `my-plan.html` at the `<!-- @plan-shell -->` marker, with per-page header fills from `scripts/lib/plan-shell.ts`
- `trails/plan-viewer.ts` - Interactive plan viewer.
  Beside the start date, a 0.5-step "Zero days before day 1" box (`#plan-start-zero-days`) writes `startZeroDays` (`setStartZeroDays`; blank is none, an entry is rounded to the half day and held in 0..`zeroDaysMax`, an unreadable one keeps the stored figure, and the box then shows what is in force);
  every day card's date moves on by its whole days (`computePlanDays`), a line above Day 1 says how many, and a shared (read-only) plan shows it in the header text instead of the box.
  A dated day card states its hours of daylight in the stats row, in the estimate's form ("~8.8h", "10.7h daylight"), and adds a muted line when the estimated walking time is longer (`@lib/daylight` `dayDaylight`; nothing is shown without a start date).
  The day-detail subtitle carries the same figure; the print table and the "not planned yet" card do not.
  The resupply page counts it in the summary's total days.
  The header's pace preset and hours/day inputs are persisted per browser in `PlanUiPrefs` (`trail-plan-ui-<id>`, see `plan-state.ts` below; never in the plan document) and feed both `computeDays` and the Resupply tab's legs — the page fixes neither figure.
  Planned resupply stops are marked on every surface of the page, not only in the Resupply tab: `toggleResupply` keeps ids the route does not offer, as `chooseResupplyOption` does, and All and None act on the route shown and leave the other routes' ticks alone (they may be towns on an alternate, with zero days of their own).
  The Stops and Resupply tabs' filter boxes go through `@lib/name-filter` (case- and accent-insensitive; a matching turn-off keeps all its places) and never change a tick;
  while the Resupply filter is in use, All and None read “All shown” / “None shown” and act only on the rows it leaves (`setAllResupply` over `filteredResupplyGroups`).
  `refreshPlannedResupply()` resolves `@lib/resupply-plan`'s `plannedResupplyIds` once per render, and the day cards, Stops rows, datasheet rows (day boundaries matched on km), map markers and profile ticks all read that one set.
  `null` — no explicit selection — marks nothing, which is why the every-option default of a fresh plan is not painted as a plan.
  Alternates: the page holds `storedPlan` (what is saved and synced) and `plan`, its route-km view over `routeTrail` (`@lib/plan-alternates`);
  `activeTrail()` reverses `routeTrail`, `applyEdit` converts an edit back, and `setAlternate` changes the route.
  Stops a data update left without a place (`@lib/plan-stop-issues`, judged against `trail` on every render with the same `dataUpdatedAt` `refreshStopKms` was given — null when the data has no publish time) get a notice at the top of the Days and Stops lists — each stop, its reason, the day it ends or that its nights are out of the dates, a Remove button (`removeStoredStop` on `storedPlan`) and the shared hint (ticking an unplaced stop's own place moves it there, via `planFromRoute`) — and a badge on the day card a placed one ends.
  The Stops tab draws the branch/rejoin cards, the map draws the planned route as the base line with every alternate dashed beside it.
  The map offers the same take / stay choice as the Stops cards, as the phone's waypoint screen does: clicking an alternate's line opens its popup (`variantPopupContent`, over a 10 px invisible hit line that is off the map while the alternate is taken, so the day lines along it keep their clicks; `renderAll` closes the popup, which would otherwise show the plan as it was), and a waypoint popup lists any alternate that leaves or rejoins within 0.25 km of the place, or the taken one it is on (`alternatesAt`).
  While the Resupply tab is showing, the map draws its legs (`computeResupplyLegs`' carries, the datasheet's rows) in place of the day lines: one line per leg in the day palette, cut by `@lib/route-ranges` `rangeLines` on `activeTrail()` (alternates spliced in, direction applied, split at route breaks), with a `Leg n: from → to` tooltip.
  Each datasheet row carries a swatch of its line's colour and `data-leg`;
  hovering a line or its row emphasises both (`highlightLeg`, a style change with no re-render, listeners delegated from `#datasheet-body`), clicking a line scrolls to its row and clicking a row fits the map to its leg.
  Opened with `?focus=<optionId>` (the resupply page's "show on map"), it starts on the Resupply tab with the map centred on that option (its turn-off on the route when the map has no marker for it) and the row outlined, then drops `focus` from the address (`history.replaceState`) so a reload keeps the hiker's tab.
  The waypoint markers are made once per route, direction and tab (what a click on one does depends on the tab) and restyled in place on every other render (`drawWaypointMarkers`: stop, planned-resupply and faded-option styling);
  on the Resupply tab a click on an option ticks it, except on a read-only (shared) plan, where it opens the place's popup like any other marker.
  It follows the resupply page's saves (`storage` event: a document is rebased onto this page's unsaved edits, and changed preferences refill the pace, hours/day and threshold inputs and the Stops tab's "show all" switch, `refreshPrefInputs`) and writes through `plan-edit-queue.ts`
- `trails/plan-export-ui.ts` - The plan page's Export menu (`#plan-export` in `plan-shell.html`, so the bundled plan pages, `my-plan.html` and `shared-plan.html` all have it): GPX and Calendar (.ics) downloads written by `@lib/plan-export` from `plan-viewer`'s `planExportInput()` (the route-km plan, `activeTrail()`, the day cards and unplanned tail, and only an explicit resupply selection — the every-option default plans nothing — with the plan's `resupplyZeroDays`);
  the calendar button is disabled with a note until the plan has a start date (`refresh` from `renderAll`).
  "Print / Save as PDF" fills `#plan-print` (`planPrintHtml`: heading with the hiker's pace and hours, days with rest-day rows and stop notes, resupply legs; all escaped) and calls `window.print()`;
  `beforeprint` fills it for a browser-menu print too.
  The `@media print` block at the end of `plan-page.css` hides everything but `#plan-print`, and overrides the under-900px rule that hides the shell
- `trails/resupply-template.html` / `trails/resupply-page.ts` / `trails/resupply-view.ts` (+ `resupply-page.css`) - The resupply page, `trails/<id>/resupply.html` (generated by `build-trails.ts` like `plan.html`) and `my-resupply.html?id=…` (+ `my-resupply.ts`, an imported trail from IndexedDB).
  The numbers and the options, no map: modelled on the owner's spreadsheet planner, one table row per candidate stop in active-direction order — km, stop (type, "show on map" link to the planner at `?focus=<optionId>`), store (`storeLabel`, blank when unknown), off-trail km one way, access (on trail / walk / hitch / shuttle / boat, from `optionAccess`), boxes, the choice, zero days, the leg *arriving* there from the previous chosen stop (walked km with `legSideTripText`/`legRidesText` under it, ascent, descent, days with a long-carry flag, food kg) and services (the POI strip, for places within 1 km of the route) and notes (`firstSentence`, full text in a `<details>`).
  A group with one option is Yes/No;
  a decision group (several towns from one turn-off) is a tinted block of radios plus "None – carry through", written with `chooseResupplyOption`, its options named by `resupplyOptionShortName` (as is every row: "Chama", not "Chama (access: Cumbres Pass (CO 17))", the full name as the tooltip; a one-place turn-off's secondary line says where it leaves the route, `resupplyTurnOffText`), and a stored `undecided` state (more than one ticked, the every-option default included) says "Not decided yet", with the leg the calculator then counts on the group's header row;
  leg ends go by `legEndpointNames` ("from Monarch Pass (US 50) (not decided)", and no place named in that leg's side-trip line).
  Zero days are a 0.5-step input on each chosen stop a leg arrives at (where none does, the start of the walk in this direction, `legArrivesAtStop`, a note says why instead and the stored figure stays for the other direction), stored in the document as `resupplyZeroDays` via `setResupplyZeroDays` and passed to `computeResupplyLegs` as `zeroDays`;
  the page passes no `days` and shows no arrival dates, so zero days are counted once, by `summariseResupplyPlan`, whose figures fill the summary strip above the table;
  beside its open-decisions warning, Clear choices (shown once there is a selection or a zero day, as on the phone) goes back to "no plan made" with `resetResupplyPlan`, dropping both.
  Pace, hours/day, food g/day and the long-carry threshold are inputs on the page, read from and written to the planner's per-browser `PlanUiPrefs`.
  It edits the same document as the planner (`plan-state.ts`, `plan-sync.ts` with the dialogs mounted from `plan-sync-markup.ts`), follows a planner tab's saves through the `storage` event (`planStorageKind`) as the planner follows its (see `plan-edit-queue.ts` below), keeps the focused control and the opened descriptions across a redraw (it redraws after the browser's focus move, so Tab out of a zero-days box or an arrow key between a group's radios stays put), shows a zero-days entry it could not take (`validity.badInput`, or past the limit) as invalid with the stored value back, and reads the planned route (alternates) and direction as the planner does;
  it only edits fields keyed by option id plus the direction, never a stop km.
  `resupply-view.ts` is pure (view model + markup, every data string through `escapeHtml`) and tested in `resupply-view.test.ts`;
  the wiring in `resupply-page.test.ts`.
  Below 760 px the table rows stack into labelled cards (`data-label`).
  Linked from the planner's Resupply tab (`PlanViewerOptions.resupplyPageHref`) and from the trail pages beside "Plan this trail"
- `trails/plan-sync-markup.ts` / `trails/plan-sync.css` - The one copy of the sync arm's link dialog and share panel (filled into `plan-shell.html` at `{{PLAN_SYNC_DIALOGS}}` by `inlinePlanShell`, mounted at runtime by the resupply page) and their styles (imported by `plan-page.css` and `resupply-page.css`)
- `trails/plan-edit-queue.ts` - Keeps the planner and the resupply page, open side by side, from overwriting each other: each page records its edits as functions of the document (`PlanEditQueue.record`), replays its unsaved ones on a copy the other tab saved (`rebase`, on the `storage` event) and, at save time, on whatever storage holds if it moved since (`resolveForSave`), so it never writes a stale whole document.
  The edits stay pending until a write succeeds (`saved`), so a failed save (storage full, an over-size plan) still replays them on the other tab's next save.
  A replayed edit meets a copy that may already hold the same change, so the planner's resupply tick records whether the box went on or off (`toggleResupply`), not a flip, and a tick replayed on a copy where the resupply page said No to the same town stays a No.
  The planner's stop toggle (`toggleStop`) and nights −/+ (`changeNights`) still record a flip and a step, which only a second planner tab editing the same stop inside the debounce can replay twice.
  Saves are debounced 800 ms, so both pages run a pending one on `pagehide` (`commitSave`, synchronous; a link, Back or closing the tab would otherwise lose the edit).
  The sync arm's request may not outlive the page, but the local copy is then newer than the server's, so the next boot read pushes it (`reconcile`), and a page back from the back/forward cache still counts it as unsynced.
  Prefs are saved as a patch onto the stored ones (`updatePlanUiPrefs`).
  A page whose markup was replaced stops writing (`pageIsLive`)
- `trails/stop-services.ts` - The six-glyph services strip (`servicesStripHtml` over `servicesAtStop`), shared by the planner and the resupply page
- `trails/plan-next-days.ts` - The plan page's "Plan the next few days" section, at the top of the Days tab: the web half of the Next days feature (issue 81), over `@lib/plan-suggest` + `@lib/day-suggest`.
  - It starts from the last stop, the trail start, or the browser's location.
    "Use my location" snaps the fix to the track and shows a "You are here" divider in the Stops tab.
  - It ranks the alternatives.
    The best is previewed on the map as dashed day lines with numbered flags, and "Use this plan" applies one.
  - It talks to the viewer through `NextDaysHost`, and is removed on a read-only (shared) page.
  - The page also shows the tail after the last stop as a dashed "Not planned yet" card, not a day, via `splitUnplannedTail`.
- `trails/plan-state.ts` - Plan state management: the `PlanDocument` under `trail-plan-doc-<id>`, the one-off migration of the legacy `PlanState` (`trail-plan-<id>`, left in place), and `PlanUiPrefs` under `trail-plan-ui-<id>` — the Stops tab's "show all" switch, the header's pace and hours/day, the planning thresholds (dry stretch beside the water carries, food per day and long carry in the Resupply tab), and the next-days inputs (`suggest`).
  Pace and hours are per browser, not part of the document (the phone keeps its own in `plan-inputs-store`), and the migration carries a legacy save's values into the prefs.
  `loadPlanState` rejects a record whose *shape* is wrong, but drops only an unusable `pace`/`dailyHours`.
  The inputs' initial values and parsing (`INITIAL_PACE`, `INITIAL_DAILY_HOURS`, `DAILY_HOURS_RANGE`, `prefPace`/`prefDailyHours`/`prefThreshold`, `parseDailyHours`/`parseThreshold`) live here so the planner and the resupply page read the same figures
- `upload.html` / `upload.ts` - User GPX import: drag-drop → `importGpx` → report (+ optional elevation backfill) → IndexedDB.
  A file picked while an earlier one is still being read makes the earlier one stale (`handleFile`'s token, checked after each await), so its report or error never lands over the newer file's, as the elevation fetch already did
- `how-import-works.html` - "How your file is processed" page;
  the article body is `docs/gpx-import.md`, rendered at build time by the `gpx-import-doc` Vite plugin (GitHub-style heading ids, so `#anchors` against the doc keep working)
- `my-trail.html` / `my-plan.html` (+ `.ts`) - Trail/plan pages for imported trails, booted from `?id=` via `imported-trails-db.ts` and the viewers' `preloadedTrail` argument;
  "Export for Tracknotes" handoff (`tracknotes-export.ts`, shared with `community-route`: an "Include my plan" checkbox, ticked, appears only when `plan-state` has a document for the trail — re-checked on a `storage` event — and while ticked the file carries that `PlanDocument`, never `PlanUiPrefs`)
- `trails/plan-sync.ts`, `api/` (`client.ts`, `session.ts`, `plans.ts`; `comments.ts` is the waypoint editor's read-only comments client) - The plan page's sync arm, on only when `VITE_API_BASE_URL` is set (the comments/plans API origin; public, ships in the bundle; unset = local-only planner with the Sync/Share controls removed).
  A browser links to the phone's identity by entering the code the phone mints (Settings → Linked browsers);
  the linked token lives in `localStorage` `tracknotes.webSession`, only ever rides in the `Authorization` header, and can be unlinked from the page.
  Imported (`u_`) trails never sync
- `shared-plan.html` / `shared-plan.ts` - Read-only view of a shared plan (`?s=<shareId>`, public `GET /v1/shared/plans/:id`), with "Open in Tracknotes" (`tracknotes://plan/<shareId>`) and "Copy to my plans".
  A plan on a community route (a phone syncs those) loads the route from the API's detail and public `trailUrl`, as `community-route.html` does, and offers no copy, since this site has no plan page for a route.
  The worker's `SITE_BASE` var builds the share URL and must point at the deployed site
- `api/community.ts` - Typed client for the community-routes API;
  `listCommunityRoutes` returns null without `VITE_API_BASE_URL`, takes an abort `signal` and drops list entries of the wrong shape (`isCommunityRouteSummary`);
  `checksFromError` reads a 422's server checks and `duplicateRouteId` a 409's `existingId`.
  `community-ui.ts` holds the check list, region picker and `localCopyId`;
  `community-labels.ts` holds the status explanations, the status badge (`statusBadgeHtml`), `hiddenReasonText`, `multilineHtml` and `placeLabel`/`regionLabel` (all re-exported by `community-ui`), kept apart so the landing page does not load `@lib/gpx-import`;
  `link-browser.ts` is the inline link-code form (over `api/session.ts`) for pages other than the planner.
  `linkDevice` throws `SessionStorageError` (after revoking the new token) when storage refuses the session, and every page uses the session handed to `onLinked` rather than reading storage back
- `community-share.ts` - The upload page's opt-in "Share with the community" step, loaded lazily after a save when the API is set: live `@lib/community-checks` (given the GPX text as `meta.gpxText` whenever it will be sent), CC0 confirmation with the shared licence and privacy lines under it (`renderContributionLicence` in `community-ui.ts`, over `@lib/contribution-licence`; the route page's owner Edit form shows them too), an "Include the original GPX file" box (on by default; the raw GPX goes as base64 only when ticked and ≤ 5 MB), the worker's own message for 409/413/429 (a 409 that names the caller's own route links to it), 401/422 handling.
  The checks rerun 250 ms after typing stops;
  a submit runs them at once and cancels that pending run, which could otherwise land after a quick 422 and replace the server's list.
  `open()` resets every field for each import.
  Sharing needs a linked browser (the phone's identity)
- `community-route.html` / `.ts` - Public `?id=c_…` page: detail from the API, trail from `trailUrl`, drawn by the trail viewer as `preloadedTrail`.
  Report (linked browser; not offered to the owner; kept when only the track download failed), "Save to my trails" (IndexedDB under a `u_` id, so plan sync stays off), "Export for Tracknotes" (offering the plan stored under the saved copy's `localCopyId`), owner Edit/Delete with checks and the AI review (kept in the no-track view of a hidden route, whose header also says why it was hidden);
  an owner's edit updates one shared detail that Save, the export and the viewer (`setTrailName`) read
- `admin-community.html` / `.ts` - Unlinked, noindex review queue for admins (AI-rejected/hidden first): Verify / Unverify / Hide / Restore / Re-run review / Delete.
  Each row's Map section draws the route from the worker's admin-only `GET /v1/admin/community/routes/:id/trail` (`adminFetchCommunityTrail`), so a hidden route, which has no `trailUrl`, can be judged with its line;
  Leaflet (`loadLeaflet` from `landing-map.ts`) and the trail load only when the section is opened, and the maps are removed on every reload of the list.
  `admin-route-map.ts` draws it: the main line cut at `track.breaks` with each break as a dashed link, variants dashed, waypoints as dots (an alternate's or side trip's own in the variant colour, its name in the tooltip), and every name in a tooltip escaped
- `admin-moderation.html` / `.ts` - Unlinked, noindex moderation page for admins: reported or screen-flagged comments and shared hiker waypoints (hidden first, then those the automated review would remove or wants a human for, then by reports), each with its reports' reasons and details and the automated review's verdict, confidence, categories and summary ("Hidden by the automated review" when the review hid it; `docs/architecture/workers.md`, "comment and waypoint review"): Restore (or Keep, on a live row with reports or a flagging review: the same endpoint, which settles its reports and review) / Delete / Ban author / Ban and remove all their posts / Unban
  Which rows are highlighted as needing an admin is `needsAttention` in `@lib/moderation-attention`, whose rule the comments API's counts route (`GET /v1/admin/moderation/counts`) repeats in SQL for the daily *Moderation queue* workflow (`docs/deploys.md`); the worker's tests check the two agree
- `admin-descriptions.html` / `.ts` (+ `admin-descriptions-view.ts`) - Unlinked, noindex live description editor (runbook: `docs/waypoint-editor.md`, "Live edits on the deployed site"): pick a bundled trail (`data/generated/index.json`), and each waypoint's bundled description (the trail JSON the site serves) sits beside its synced one (the public `GET /v1/trails/:id/descriptions`, `api/descriptions.ts`), marked where they differ.
  An admin's linked browser (`GET /v1/me` `isAdmin`; anyone else reads only) PUTs a new synced text through `PUT /v1/admin/trails/:id/descriptions/:waypointId`, or clears it (`''`, after which phones show the bundled text again), with the character count against `MAX_DESCRIPTION_LENGTH` and the voice hints of `description-voice.ts`, a module of its own that both description editors import, so that this deployed page's bundle takes in nothing of the dev-only local editor (`description-voice.test.ts` walks the page's imports to hold that).
  A `/v1/me` that fails for any reason but a 401 leaves the answer unknown: the identity line says the check failed and offers a retry, held apart from the trail-load error so that a load cannot clear it.
  It writes only to a worker that guards writes: `fetchSyncedDescriptions` answers the rows and `guardsWrites` (the read's `writeFeatures`, `@lib/description-write-features`), and without it the page draws no Edit or Clear, shows `#desc-unguarded` ("Read-only: the comments API has not been deployed with description provenance yet") and refuses in `write()` and in the list's click handler, so a forged click or an edit box left open sends nothing;
  the site can be ahead of the worker, and a worker that predates `source` and `ifUpdatedAt` would take a save with neither.
  A PUT answered with no `source` (the worker was replaced by an older one between the read and the save) makes the page read-only too, with a notice to commit that text by hand.
  Every PUT says `source: 'live'` and carries `ifUpdatedAt`, the `updatedAt` of the row as the admin was shown it (taken when the edit box opened; `null` for no row);
  on the worker's 409 `description_conflict` (`conflictCurrent` in `api/descriptions.ts`) the row is redrawn with the server's text above the draft, which is kept, and the next save is checked against that version.
  Each trail's `descriptions.json` as the site was built is bundled into the page (a lazy `import.meta.glob`, one chunk per trail, found by the `id` in each `trail.json`), and each synced row says which tool last changed it (`source`), so every row is classed against both (`stateOf`):
  in sync;
  drift (a `live` row the file does not match, a live clear of an id the file lists included: what the next *Upload descriptions* run of that trail undoes);
  awaiting upload (an `upload` row the file has moved past, the ordinary state between a merge and its approved upload, never counted as drift and never exported);
  origin unknown (a differing row from a worker that reports no `source`, claimed as neither);
  cleared, not uploaded, bundled only.
  Only live edits are exported, as the updated `descriptions.json` (download) or as the changed entries (copy), written as the committed files are so the `git diff` shows only the carried text.
  The export leaves out a live clear, an id the trail has lost, and a later pass of a revisited place (`firstPassIdOf`: `@lib/waypoint-passes`' id rule, with `<id>` a waypoint of the trail), which the build cannot apply.
  A later pass's row shows what phones show there (`shownSynced`, from `@lib/waypoint-passes` `resolveSyncedDescription`: the first pass's synced text unless the pass holds its own), reads *follows first pass*, and is edited on the first pass's row (`edit-first`); nothing is saved under a later pass's id, and text one holds from before can only be cleared.
  The save confirmation on a first pass carries `OLDER_APP_PASS_NOTE`: app builds from before that rule look each pass up by its own id.
  The wording follows the trail (`fileContext`): with a `descriptions.json` the next upload overwrites a live edit, without one no upload ever touches it, and for Te Araroa, which is built upstream (`UPSTREAM_TRAILS`), there is no file to commit to and no export.
  The list is redrawn row by row (`redrawRow`, `patchRows`): a save redraws its own row, and the refresh that follows never touches a row whose edit box is open.
  An answer to a PUT is drawn only into the list it was sent from (`loadSeq`), so a save that lands after a switch of trail adds no row to the other trail's list.
  `admin-descriptions-view.ts` is pure (waypoint order, the row states, filters, the export, the wording, escaped markup) and tested in `admin-descriptions-view.test.ts`
- `admin-waypoints.html` / `.ts` / `.css` (+ `admin-waypoints-view.ts`) - The local waypoint editor (runbook: `docs/waypoint-editor.md`): review and correct a bundled trail's waypoint descriptions, names, types and positions against a map (topo, satellite, OSM, the trail's OSM POIs), and add or delete waypoints, writing the trail's source files through the dev server's `/__waypoint-editor` API (`scripts/lib/waypoint-editor/`).
  Served only by `npm run dev`: the page is not a build input and the API plugin is `apply: 'serve'`.
  Unsaved edits are kept per waypoint while browsing, as drafts that hold only the fields that were changed (`WaypointDraft` is partial; `pruneDraft` cuts one down on every edit and rebases it when the trail is read again), so a field nobody touched always follows the server;
  the form stays live while a save is in flight, so `save` fixes what it needs before it awaits and applies the answer to the waypoint it was for (`draftAfterSave` keeps what was typed meanwhile, `saveNotes` names the waypoint when another is selected);
  "next" is worked out before a change is applied, from the waypoint's place in the whole list (`stepTarget`), since the change may drop the row from the filter;
  `loadTrail` drops an answer that is no longer the latest asked for, and a re-read of the open trail ("Reload trail", a rebuild, an add or delete, a save that `saveAffectsOtherRows`) keeps the selection, the map view, the list scroll and the drafts;
  an edit updates its one row in place (`rowContentHtml`), never the whole list, so a field that commits on blur cannot swallow the click that blurred it;
  Lat and Lon commit on `change` and before any shortcut acts (`commitPendingFields`), through `readTypedPosition` and `parseCoordinate`, which never read an empty field as 0;
  the Lat, Lon and paste-box fields of the selected waypoint's form and of the add form are one implementation (`positionFields`, wired twice in `wire`), so the two cannot drift apart in how they commit, flag and round;
  the readout and "Snap to route" measure to the nearest of the main route (cut at `track.breaks`) and the variants' lines (`routeLines`, `nearestLineSnap`);
  review marks are per browser (`tracknotes-waypoint-review-<trailId>`) and lapse when the waypoint's name, position, description or type changes (`reviewFingerprint`, prefixed `t:`; `isReviewed` still reads a bare hash from before the type was covered as a mark on the first three);
  a row that takes no mark (`isReviewable`: a pending one, and a `notBuilt` one) is left out of the progress count.
  A waypoint added since the last build is `pending` and keyed `new:<hash>` until a rebuild mints its id: anything keyed by waypoint id (comments, descriptions, review marks) must skip it.
  It is edited like any other, but its description box is its GPX `<desc>` (`descriptionField` labels it, and `hasCuratedText` keeps it out of the curated-text counts and filters).
  The key is a hash of its name and position, so a save that renames or moves it answers with a new one: `save` re-keys the row, the map dot, the selection, the `?id=` address, the draft and what "Show more" had revealed of its comments, and leaves nothing under the old key.
  A pending row the next build hands an existing id carries `takesId`: its badge names the id, and the form links to the row that has it (`takesIdMetaHtml`).
  A `<wpt>` with a registry id that the last build here does not list is `notBuilt`: a locked row badged `not built`, matched by "Changed since build" and by neither "No curated text" nor "Off the route".
  A later pass of a revisited place (`laterPassOf`, the server's `registryId` rule, both `@lib/waypoint-passes`) shows the place's description read-only, with no count or voice hints, and both passes say that a move, a rename or a type change is the place's (`sharedSourceText`).
  Waypoints on one exact position (`colocatedWith`; the passes of one place are not counted) are one dot under another on the map, where a click reaches the top one alone: the form of each links to the others (`colocatedMetaHtml`), a dot's tooltip says how many more lie under it, and a click on the selected marker steps to the next of them (`nextColocatedId`).
  A trail the server refuses (422 for a GPX the build cannot read) leaves the list and the map empty with the reason in the banner, and "Reload trail" asks for it again.
  The add form checks the name for a type prefix before sending (`typePrefixProblem`, the classifier the server uses).
  Its position is one value with three faces, the fields, the marker and `state.adding`, all set through `placeNew`: a typed or pasted position moves the marker and pans to it, a click or a drag fills the fields, and the readout under them is the selected waypoint's (`positionReadout`).
  "Add waypoint" is off until `newWaypointNeeds` has nothing left to ask for (a name, a chosen type, a position read from the fields as they stand, so one typed and not yet committed counts and the click commits it);
  before the form has a position an empty field is one still to fill, not an error (`readTypedPosition`'s `unplaced`);
  `newWaypointCompany` says what already stands on exactly the position, and whether the add will be refused for a namesake or puts a deleted waypoint back;
  Enter in its position fields commits and never submits, and Esc leaves the form with what was typed kept, the position put back on the map when it is opened again.
  A rebuild found running when the page loads is followed as if the page had started it, and the last one's report is put back in the drawer (`resumeRebuild`, `followRebuild`): a reload mid-rebuild must not lose the report of minted and retired ids.
  A `<wpt>` the build merged into a near-duplicate (`dedupeWaypoints`) is a row of its own under its id, flagged `mergedInto` (the survivor carries `mergedIds`): a badge, a status filter, a hollow dotted ring on the map, and a line in the form that links to the waypoint it merged into.
  The app never reads `mergedIds`, so comments under a merged-away id show nowhere in it: the row here shows them over a note saying so, `knownCommentIds` keeps the id out of the "lost id" list, and the delete confirmation says the comments were already out of sight where it would otherwise say orphaned.
  `admin-waypoints-view.ts` is pure (drafts, filters and stepping, typed and pasted positions, what the add form still needs, the route's lines and snapping, review fingerprints, escaped list markup, the type select's options, the description box's labels, the merge line and map dot styles, the waypoints that share a position, the delete confirmation, the save notes) and tested in `admin-waypoints-view.test.ts`;
  `admin-waypoints-comments.ts` shows each waypoint's hikers' comments read-only (one public `GET /v1/trails/:trailId/comments` per trail through `api/comments.ts`, plus the admin listing for hidden ones when the browser is linked to an admin), grouped by waypoint id with every string escaped and photo URLs through `safeHttpUrl`, tested in `admin-waypoints-comments.test.ts`;
  the admin listing is read for the one trail (`adminListModeratedComments`: `GET /v1/admin/comments?trail=…&moderated=1`, following `nextCursor` to the end, at most ten pages of 500) and the section's note says whether that was complete (`AdminCoverage`: `complete`, `capped` past 5000 rows, `interrupted` when a later page failed);
  an answer without the `trailId` echo is a worker from before the trail filter, and the read falls back to that worker's two unpaged reads of every trail (newest first, and `?reported=1`), whose reach the note states (`complete`, `recent`, or `partial` when a read came back full);
  a waypoint's comments are paged (`COMMENTS_PAGE_SIZE` newest, "Show more" / "Show all" through `data-comments-show`, the orphaned-id note likewise through `data-orphans-show`): the module renders the first `shown` and leaves the rest out of the markup, and `admin-waypoints.ts` keeps what is revealed per selected waypoint (`revealFor`) and moves focus to the first item revealed;
  the section's body is re-rendered whole and is not a live region: `renderComments` hands focus from one render's reload control (`data-comments-reload`, `aria-disabled` while loading) to the next's, and announces one line (`commentsStatusText`) in a `role="status"` element
- `poi-enrich.ts` - In-browser OpenStreetMap POI enrichment for an imported trail (loaded lazily by `my-trail.ts`): the browser half of `fetch-pois.ts`, the same `@lib/osm-poi` corridor query and `@lib/trail-pois` km mapping, sent straight to a public Overpass instance (the next endpoint is tried only when every query fails)
- `imported-trails-db.ts` - IndexedDB store (`tracknotes-imports`) for imported `ProcessedTrail`s;
  `index.html` lists them under "My trails"
- `web-utils.ts` - `escapeHtml` (the one every web module uses, the plan page's print summary included), `getQueryParam`, `formatKm`, `SITE_ROOT`/`generatedDataUrl` and the dev-only `overpassEndpointOverride` — every user-supplied string (trail names) must go through `escapeHtml`
- `trails/viewer-utils.ts` - What the trail, plan and resupply pages share: `niceAxisTicks` (the elevation profiles' axes), `debounce`, and `loadGeneratedTrail` (a bundled trail's `data/generated/<id>.json`, relative to the page)

## Testing

The page modules are tested in jsdom by the Vitest `pages` project (`src/web/**/*.test.ts`): they boot the real HTML and own the detail.
A small Playwright smoke suite (`e2e/`, `npm run test:e2e`, Chromium only) covers what jsdom cannot: the production bundle, real Leaflet and canvas, IndexedDB and the links between pages.
It has one test per page family: the landing page lists every trail in `index.json`, a trail page draws its route polyline and elevation profile, the plan page turns a suggested plan into day cards, and a fixture GPX imported on `upload.html` opens on `my-trail.html`.
Keep it that size, with role/text selectors and no fixed waits; anything finer belongs in the jsdom suites.
By default it tests the `npm run build:app` output (`dist-app/`, a production build without the `public/` tile packs; it needs `npm run sync:te-araroa && npm run build:trails` first), served by `vite preview` on port 4319.
`BASE_URL=<url>` tests a deployed site instead, and `VERCEL_AUTOMATION_BYPASS_SECRET` adds Vercel's protection-bypass headers to requests to that site (Previews are behind Vercel Authentication).
`e2e/fixtures.ts` makes the network deterministic: Leaflet's unpkg files come from `node_modules/leaflet` (pinned to the 1.9.4 the pages' SRI hashes name), map tiles get a blank PNG, and every other host is refused, except read-only (GET) calls to a deployed build's comments API origin (`https://api.tracknotes.info`, or `COMMENTS_API_ORIGIN` for a Preview built against another).
A test fails on any uncaught page error or console error.
CI runs it in `.github/workflows/e2e.yml`: against a local build on every PR and push to `main`, and against each successful Vercel Preview (`deployment_status`) when the `VERCEL_AUTOMATION_BYPASS_SECRET` repo secret is set (traces are off then, since they would record the header).
The workflow's token is read-only (`contents: read`), and a push to `main` never cancels an earlier `main` run (only superseded PR runs are cancelled).
The Preview job runs the deployed commit's code with the bypass secret in its environment, so it only runs a commit that is the head of a branch in this repo (`branches-where-head`), never a fork's.
It also relies on Vercel's Git fork protection staying on (Project Settings, Git), so a fork's PR is never deployed, and so never reported as a deployment, without a maintainer's approval.

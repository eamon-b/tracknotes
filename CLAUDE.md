# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install            # Install dependencies
npm run dev            # Start Vite dev server (port 5173)
npm run build          # Full production build (Te Araroa sync + climate + trails + TS compile + Vite)
npm run build:trails   # Build trail pages from data/trails/
npm run build:mobile-trails # Build the app's bundled trail JSON (mobile/assets/trails/)
npm run publish:trail-data  # Publish mobile trail JSON + catalog to R2 (--dry-run, --check, --all, --force, --remove <id>)
npm run sync:te-araroa # Copy the Te Araroa route out of the te-araroa-data package
npm run fetch:climate  # Fetch climate data for trail locations
npm run fetch:access <trail-id> # Find where off-route waypoints are walked to from (OSM + DEM → access.json)
npm run fetch:elevation # Fetch elevation data
npm run fetch:pois [trail-id] # Fetch OSM POIs into data/trails/<dir>/pois.json (Overpass mirrors: docs/architecture/build-scripts.md)
npm run build:tiles    # Build map tiles
npm run fetch:fonts    # Fetch font glyphs for map labels
npm run upload:tiles [id...] # Publish built tile packs to R2 and purge their manifests
npm run check:tile-packs # Check every bundled trail has an offline pack deployed
npm run build:contours-australia # Build the Australia contour PMTiles
npm run experiment:contours # Contour quality experiment harness
npm run upload:descriptions # PUT curated waypoint descriptions to the comments API ($TRACKNOTES_ADMIN_TOKEN; --dry-run)
npm run sync:style     # Copy scripts/topo-style*.json into mobile/assets/
npm run trace:mark-contours # Re-trace the app icon's contours from the DEM
npm test               # Run all tests with Vitest
npm test -- --watch    # Watch mode
npm run lint           # Run ESLint (src/ and scripts/)
npm run check          # Web tests + lint, then mobile tests + typecheck + lint
npm run phone          # Start Metro for the mobile app (phone:android:usb over adb reverse)
npm run preview        # Preview production build locally
```

## Git Workflow

**Rebase and merge is the only merge method allowed in this repo.** A PR lands on `main` as a linear run of its own commits, so a branch must never contain a merge commit. To pick up `main` or resolve conflicts, rebase the branch onto `origin/main` (`git rebase origin/main`, resolve each commit, then push with `--force-with-lease`) — never `git merge main` into the branch. A merge commit on a branch cannot be rebase-merged and has to be unpicked afterwards, which is far more work than rebasing in the first place.

## Reviewing PRs

When asked to review PRs, post the findings on GitHub as a review on each PR (a `COMMENT` review: a summary, findings ranked most serious first with `file:line` and the failure scenario, and a verdict), as well as summarising them in chat. Do not ask first. Note conflicts between open PRs that touch the same files on each of them, and say when a PR has a merge conflict and so has no CI run. On a re-review, say which points from the previous review are now addressed.

## Architecture Overview

**Trail Maps** is a TypeScript web application for displaying Australian long-distance hiking trails with interactive maps, elevation profiles, and waypoint data. The repo also contains **Tracknotes**, the companion Expo/React Native mobile app (`mobile/` — see Mobile App section). Trail data also covers New Zealand (Te Araroa), the US (CDT) and Japan (Shikoku).

### Where the detail lives

Per-module notes live in `docs/architecture/`. Read the file for the area you are changing before you change it, and when behaviour changes, update that file rather than this one:

- [`docs/architecture/core-library.md`](docs/architecture/core-library.md) - `src/lib/`, shared by web, build and mobile: GPX parsing and XML adapters, `trail-ingest` (`buildTrail`), track classification and route breaks, the waypoint classifier/taxonomy/glyphs, `gpx-import`, community checks, hiker waypoints, POI display, access routing, position-on-trail, the plan editor/alternates/suggestions, and the day, resupply and water-carry calculators
- [`docs/architecture/build-scripts.md`](docs/architecture/build-scripts.md) - `scripts/`: `build-trails`, `build-mobile-trails`, contour builds and zoom tiers, `fetch-pois`/`fetch-access` (and which Overpass mirrors answer), tile packs and their upload, Shikoku processing, `publish-trail-data`, `upload-descriptions`
- [`docs/architecture/web-ui.md`](docs/architecture/web-ui.md) - `src/web/`: landing page, trail viewer, plan page and next-days, plan state and sync, upload/import, community pages, admin queue
- [`docs/architecture/trail-data.md`](docs/architecture/trail-data.md) - `data/trails/<dir>/` files (`*.gpx`, `trail.json`, `climate.json`, `pois.json`, `access.json`, `descriptions.json`), termini, Te Araroa's turn-off types, the waypoint-id registry, open-data trails, `public/data/generated/`
- [`docs/architecture/workers.md`](docs/architecture/workers.md) - `workers/comments-api/` (community routes, comment targets and limits, shared hiker waypoints, comment moderation) and `workers/contour-tiles/`
- [`docs/architecture/mobile.md`](docs/architecture/mobile.md) - Tracknotes: app architecture (map, theme, storage, over-the-air trail data, hiker waypoints, community routes, POIs), the `mobile/app/` route structure and the `mobile/src/` source structure

Runbooks and specs: `docs/` (`gpx-import.md`, `trail-data-updates.md`, `mobile-test-build.md`, `world-contours-remote-build.md`) and `plans/`. Read `docs/privacy-policy.md`, `docs/data-residency.md` and `docs/content-legal-posture.md` before changing what the comments API or community routes store.

### Hard rules

Each is explained where it lives; they are listed here because breaking one is silent.

- **One ingestion pipeline.** `scripts/build-trails.ts` and `importGpx` both call `@lib/trail-ingest` `buildTrail`. Any change to `trail-ingest.ts` must leave `public/data/generated/*.json` byte-identical unless the change is intentional. Keep `docs/gpx-import.md` in step with import behaviour.
- **`src/lib` is platform-neutral and RN-safe.** jsdom never reaches `src/lib` (its adapter is `scripts/lib/xml-adapter-jsdom.ts`); no `DOMParser` or `crypto` assumptions. The shared calculators are the single implementations for web and mobile: never fork one into a platform.
- **Waypoint ids are stable.** Changing a bundled waypoint's `type` re-keys it in `data/waypoint-ids.json` and orphans server-side comments: migrate the registry entries in the same commit. Check the build's id-minting warnings before committing the registry. See `docs/architecture/trail-data.md`.
- **A `water-access` turn-off is never water.** `RESUPPLY_TYPES` lists the `-access` types one by one; use `baseWaypointType()` for type-keyed maps (see `docs/architecture/trail-data.md`).
- **Te Araroa is not curated here.** Its GPX comes from the `te-araroa-data` package (`npm run sync:te-araroa`); never hand-edit it, fix it upstream.
- **Open-data trails' waypoints were reviewed by hand.** Diff against the committed GPX before regenerating one.
- **POIs are never waypoints.** They stay out of `waypoints`, `data/waypoint-ids.json` and the plan calculators.
- **Every user-supplied string on the web goes through `escapeHtml`**, and every POI link through `safeHttpUrl`/`safeTelUrl`.
- **Route breaks:** anything that draws or climbs the route must respect `track.breaks` (`@lib/route-breaks`, `routeBreakStarts`).
- **Stored plan km are NOBO-absolute** (main-route km, or an alternate's own km); always pass the stored plan to `planFromRoute`.
- **Deploying the comments API:** a merged change to `workers/comments-api/` is not live until someone runs `npm run migrate:remote && npm run deploy` there, from `main`. Shipped app builds call it, so deploy after the merge rather than at the next release, and run the route probes in `docs/mobile-test-build.md` ("Full release", step 1); `/health` answers while a new route 404s (#141).
- **Mobile:** `npx expo install` for Expo packages; screens use the `navigation/` scroll containers (lint-enforced); raw palette tokens are import-restricted.

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

## Key Patterns

- **Build-time processing**: Trail data is processed at build time into optimized JSON
- **Static site**: All trail pages are pre-generated and the site is served statically. The runtime servers are optional Cloudflare Workers: the comments API (comments, plan sync, shared plans, community routes, shared hiker waypoints; off when `VITE_API_BASE_URL` is unset) and the contour tile worker (see `docs/architecture/workers.md`)
- **Client-side rendering**: Trail viewer loads JSON data and renders interactively
- **Web maps**: Leaflet with OpenTopoMap tiles for topographic display
- **The app informs the hiker's decisions; it never makes them.** Pace, hours per day, and any other figure that says how far or how long is "reasonable" is the hiker's input, not ours. A UI module must never fix such a figure in a constant (the web plan page's former `RESUPPLY_BASE_KMH = 4` / `DEFAULT_RESUPPLY_DAILY_HOURS = 8` are the named example, removed per `plans/resupply-mobile.md` Phase 0): give the page the input the phone already has, persist it with the plan, and feed the calculator from it. A *default* is fine only as the initial value of an input the hiker can see and change; a shared calculator should require the figure rather than silently substitute one. The same applies to thresholds that colour a judgement — "long carry", "dry stretch", grams of food per day — which are inputs too (`PlanThresholds` in `plan-types.ts`, issue #153): the calculators require them, and like pace and hours they are kept per device (web `PlanUiPrefs`, mobile `plan-inputs-store`), not in the synced `PlanDocument`, because they describe the hiker and a shared plan is read against the reader's own

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`). The `tile-pipeline` mbtiles suites need the `sqlite3` CLI: without it they are skipped locally and fail in CI (`CI` set). The comments-api worker has its own suite (`cd workers/comments-api && npm ci && npm test`, vitest-pool-workers). CI (`.github/workflows/test.yml`) also runs `npx tsc --noEmit` and rebuilds the trail data (`sync:te-araroa`, `build:trails`, `build:mobile-trails`), failing when the committed output differs — commit the rebuilt files with any change to the build or the source data. Mobile tests (Jest) live in `__tests__/` subdirectories colocated with source across `mobile/src/` (`api/`, `db/`, `features/*/`, `hooks/`, `services/`, `state/`, `sync/`, `tokens/`).

```bash
# Mobile tests (from mobile/)
npm test                           # Run all mobile tests (Jest)
npm run test:watch                 # Watch mode
npm run typecheck                  # tsc --noEmit
```

## Mobile App (Expo / React Native)

The mobile app lives in `mobile/`. It uses **Expo SDK 58** with React Native 0.88 (check `mobile/package.json` for the exact pins), the New Architecture, and development builds (not Expo Go) since MapLibre requires custom native code.

### Mobile Commands

```bash
# From the mobile app directory (mobile/)

# Dependencies — ALWAYS use expo install, not npm install, for Expo packages
npx expo install <package>       # Install SDK-compatible package
npx expo install --check         # Check for version mismatches
npx expo install --fix           # Fix version mismatches

# Project health
npx expo-doctor                  # Diagnose project issues
npx expo config --json           # Print resolved app config (verify it parses)
npx tsc --noEmit                 # TypeScript check
npx expo lint                    # ESLint

# Native project generation (Continuous Native Generation)
npx expo prebuild                # Generate ios/ and android/ from config
npx expo prebuild --clean        # Regenerate from scratch (use after plugin changes)

# Building
npx expo export                              # Bundle JS/assets for production
eas build --non-interactive --platform ios    # Cloud build (non-interactive)
eas build --non-interactive --platform android

# Installable test APK (preview profile; runbook: docs/mobile-test-build.md)
eas build --non-interactive --profile preview --platform android

# OTA updates are NOT available: expo-updates is not installed (see the runbook)

# Dev server (INTERACTIVE — requires human at terminal)
npx expo start --dev-client      # Start Metro + connect to dev client
```

### What Claude Code Can Run vs. What Needs a Human

**Claude Code can run** (non-interactive):
- `npx expo install`, `npx expo prebuild`, `npx expo export`
- `npx expo lint`, `npx expo-doctor`, `npx expo config --json`
- `npx tsc --noEmit`, `npx jest`
- `eas build --non-interactive`, `eas update`
- Android emulator interaction via ADB (see below)
- Maestro UI test flows (see below)

**Needs a human** (interactive or requires device):
- `npx expo start` — interactive terminal UI with hotkeys (user runs this in a separate terminal)
- `eas login` — credential prompts
- First-time iOS cloud build — Apple credential/2FA setup

### Key Expo Concepts

- **Continuous Native Generation (CNG)**: `ios/` and `android/` are generated from `app.json` + config plugins via `npx expo prebuild`. They are build artifacts, not source files. Regenerate with `--clean` after config changes.
- **Config plugins**: Declared in `app.json` `"plugins"` array. They modify native project files during prebuild (e.g. MapLibre adds location permissions automatically).
- **Development builds**: Custom debug apps built via EAS that include your native dependencies. Rebuild only when native deps change; JS changes hot-reload.
- **EAS Build profiles** (`eas.json`): `base` (shared env), `development` (dev client), `development-device` (dev client on a physical device), `preview` (internal testers — a standalone `.apk` you can sideload; how to build and install one is `docs/mobile-test-build.md`), `production` (app store — an `.aab`).
- **EAS Update**: OTA JavaScript updates. Not available in this app yet — `expo-updates` is not installed and `app.json` has no `updates`/`runtimeVersion` — so every change, JS included, ships as a new build.
- **Expo Router**: File-based routing where files in `app/` become navigation routes. `_layout.tsx` defines navigators, `(groups)/` organize without adding URL segments, `[param].tsx` for dynamic routes.

### Verification After Dependency Changes

When changes affect native dependencies (adding/removing/updating packages, modifying `app.json` plugins), verify with:
1. `npx expo prebuild` — ensures config plugins resolve and native projects generate correctly
2. `eas build --profile development --platform android` — ensures the development build compiles with the updated dependencies

### Common Gotchas

- Always `npx expo install` for Expo packages — ensures SDK-compatible versions
- Run `npx expo prebuild --clean` after changing `app.json` plugins — stale native config is the #1 debugging time-sink
- Clear Metro cache when things are weird: `npx expo start --clear`
- Only env vars prefixed with `EXPO_PUBLIC_` are available in client code
- Expo Router: `_layout.tsx` naming must be exact (not `Layout.tsx` or `layout.tsx`)
- Don't have both `app/foo.tsx` and `app/foo/index.tsx` — they conflict

### Mobile Environment Variables

`EXPO_PUBLIC_*` vars are inlined by Metro at bundle time from `mobile/.env.local` — **restart Metro after changing them** (hot reload won't pick them up). The env block in `eas.json` applies only to EAS cloud builds, NOT to local Metro bundles, so each var must also be in `.env.local` for local dev. All three are non-secret public URLs (they ship in the client bundle):

```
# Comments API (local wrangler dev server, or the deployed worker URL)
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787   # deployed: https://api.contour-map-tiles.net

# Contour vector tiles — without this, online maps silently render without contours
EXPO_PUBLIC_CONTOUR_TILE_URL=https://tiles.contour-map-tiles.net

# Offline map tile downloads — without this, the Offline Maps screen disables downloads
EXPO_PUBLIC_TILE_BASE_URL=https://data.contour-map-tiles.net
```

Architecture, route structure and source structure: [`docs/architecture/mobile.md`](docs/architecture/mobile.md).

### Android Emulator (ADB)

An Android emulator (Pixel 7) is available for testing. The user runs Metro dev server (`npx expo start --dev-client`) in a separate terminal. Claude can interact with the emulator via ADB commands.

**Prerequisites**: User must have the emulator running and Metro dev server started before Claude uses these commands.

```bash
adb exec-out screencap -p > /tmp/screenshot.png   # Screenshot (view with Read tool)
# Launch the dev build INTO the JS app (a plain `am start` lands on the Expo Dev Launcher)
adb shell am start -a android.intent.action.VIEW -d "tracknotes://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" com.tracknotes.app
adb shell am force-stop com.tracknotes.app         # Force stop
adb shell pm clear com.tracknotes.app              # Clear app data (fresh state)
adb shell input tap 540 1200                       # Tap at (x, y)
adb shell input swipe 540 1500 540 500 300         # Swipe (x1 y1 x2 y2 ms)
adb shell input keyevent KEYCODE_BACK              # Back button
adb shell input text "hello"                       # Type text
adb logcat -d -t 50 ReactNativeJS:* *:E | grep -v chatty  # Recent RN logs
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk  # Install APK
```

**Visual verification workflow**: Make changes (Metro hot-reloads) → screenshot → Read the PNG → check `adb logcat` for errors.

### Maestro UI Tests

Maestro test flows live in `mobile/maestro/`. They run locally against the emulator + Metro (no CI job — the Maestro CI workflow was removed 2026-08).

```bash
# Run a single test flow
~/.maestro/bin/maestro test mobile/maestro/app-launch.yaml

# Record a test (writes a flow YAML from manual interaction)
~/.maestro/bin/maestro record mobile/maestro/new-flow.yaml
```

**Flows** (13): `app-launch.yaml` (launch → "My Guides"), `plan-screen.yaml` (guide → Plan → plan settings sheet/day splits/water carries), `plan-stops.yaml` (tick stops → day cards → day view), `guide-list.yaml`, `view-map.yaml`, `toggle-views.yaml`, `waypoint-detail.yaml`, `waypoint-stop-here.yaml` ("Stop here" round-trip, "Show on map"), `add-comment-offline.yaml`, `today.yaml` (stop + start date today → header "Today's plan" → Today), `poi-detail.yaml` (List → OSM POI screen → "Show on map"), `waypoint-alternate.yaml` (junction place → alternate card take/stay round-trip), `hiker-waypoint-edit.yaml` (map ＋ → add, edit, delete a hiker waypoint). They all start via `shared/launch-dev.yaml`, which deep-links the dev client into Metro, and those that open a guide do it through `shared/open-cape-to-cape.yaml` — don't run `maestro test mobile/maestro/` on the directory, since that would execute the shared fragments as standalone flows.

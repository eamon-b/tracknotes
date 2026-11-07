# Tracknotes — Test Build Runbook

How to get an installable Android build of the Tracknotes app (`mobile/`) onto a phone or
emulator for testing, without a store release. Everything here was run end to end on
2026-09-22 from a fresh clone. The release story (worker, site, store build) is under "Full
release" at the end.

## What you need

| Thing | Where it comes from |
| --- | --- |
| `EXPO_TOKEN` in the environment | An Expo access token for the `eamonb123` account (expo.dev → Account settings → Access tokens). Set as an env var; `eas` reads it and never prompts. Without it, `npx eas-cli login` interactively once instead. |
| Node 22 + the mobile deps | `cd mobile && npm ci` — `eas` resolves `app.json` through the project's own `expo` package, so the install has to exist even though the compile happens in the cloud. |
| Android signing | Already on EAS ("Build Credentials 5VV8EkbWj9"); nothing to supply. Every profile signs with it, so any build upgrades over any other install of `com.tracknotes.app`. |

No Android SDK, Java or Xcode is needed locally: EAS compiles in the cloud and hands back an
artifact URL.

## Make the APK

```bash
cd mobile
npm ci
npx eas-cli@latest build --non-interactive --profile preview --platform android
```

- `preview` is the test profile: a standalone release-mode app (no Metro, no dev menu) built
  as an **`.apk`**, which is what a phone can install directly. `production` builds an
  **`.aab`** that only Play Console can consume; `development` builds the dev client, which is
  useless without a running Metro.
- The command blocks for ~20-25 minutes (queue + build). Add `--no-wait` to return
  immediately and poll instead:

  ```bash
  npx eas-cli@latest build:list --platform android --limit 3 --non-interactive
  npx eas-cli@latest build:view <build-id> --json | grep -E '"status"|applicationArchiveUrl'
  ```

- The build bakes in the `env` block of `eas.json`'s `base` profile: the deployed comments/plans
  API (`https://api.tracknotes.info`), the contour tile server and the offline tile
  bucket. A test build therefore talks to **production** data and syncs to the real account of
  whichever device installs it. To point a test build somewhere else, edit those values in
  `eas.json` before building — `.env.local` is only read by Metro, never by EAS.
- **Check the worker is current first.** A build that calls a route the deployed worker lacks
  gets 404s: shared-waypoint shares stay queued, but shared-waypoint deletes and reports are
  discarded as if they had succeeded (`mobile/src/sync/comment-sync.ts`), and deploying later
  does not bring them back. Shared waypoints shipped this way (#141). The *Deploy comments API*
  workflow deploys `main` after every merge that changes the worker (`docs/deploys.md`), so
  before any build check that its latest run on `main` is green and run
  `scripts/probe-comments-api.sh`. If either fails, deploy `main` per step 1 of "Full release". Never deploy the worker from an unmerged branch for a test build: test builds use the
  production API, so that would ship unreviewed worker code to every installed app.
- The version is `expo.version` in `app.json` (`0.1.0`). The Android `versionCode` is kept by
  EAS, not `app.json` (`cli.appVersionSource: "remote"` in `eas.json`; the first build after the
  switch seeds it from the local value, `1`). Test builds reuse the current `versionCode`; each `production` build bumps
  it (`autoIncrement`), since Play rejects a reused one — see "Full release".
  `npx eas-cli@latest build:version:get -p android` shows the current value.
- Each cloud profile compiles two ABIs, not React Native's default four, set by
  `ORG_GRADLE_PROJECT_reactNativeArchitectures` in `eas.json`: `preview` is `arm64-v8a,x86_64`
  (64-bit phones and the emulator), `development-device` and `production` are
  `arm64-v8a,armeabi-v7a` (every phone, no emulator). `development` keeps all four. So a
  `preview` APK will not install on a 32-bit-only phone; add `armeabi-v7a` to its list for one,
  and see "Things that go wrong" before going back to more than two. The same profiles cap
  Gradle at two workers (`--max-workers=2` in `gradleCommand`).

### From CI

`.github/workflows/mobile-build.yml` runs the mobile tests and typecheck, then the same command,
waiting for the build to finish (about 25 minutes, mostly EAS's queue). It is manual
only, so nothing builds on push: Actions → *Mobile build* → *Run workflow*, with a choice of
branch and profile (`preview` by default). This works from the GitHub mobile app too.

It needs an `EXPO_TOKEN` repository secret (Settings → Secrets and variables → Actions). The
run fails if the tests fail (no build is started) or the EAS build errors or is canceled, and
its summary links the build page and, once finished, the install file.

## Install it

When the build finishes, `build:view` (or the build page at
`https://expo.dev/accounts/eamonb123/projects/tracknotes/builds/<build-id>`) gives an
`applicationArchiveUrl`. Artifacts expire 30 days after the build.

**On a phone:** open the build page on the phone and tap *Install*, or send the artifact URL
to the phone and open it. Android asks to allow installs from the browser the first time.

**On the emulator / a USB-connected phone:**

```bash
curl -L -o /tmp/tracknotes.apk '<applicationArchiveUrl>'
adb install -r /tmp/tracknotes.apk
adb shell am start -n com.tracknotes.app/.MainActivity
```

`-r` replaces whatever `com.tracknotes.app` is already there — including the dev client, so
reinstall the dev build (`eas build --profile development --platform android`) when you go back
to Metro work. App data (SQLite plans, comments outbox, downloaded tiles) survives the swap
because the package name and signing key are the same.

## Things that go wrong

- **`Gradle build daemon disappeared unexpectedly`, EAS error
  `EAS_BUILD_UNKNOWN_GRADLE_ERROR`** — the worker (4 vCPU, 15.6 GB) ran out of memory, or
  something else killed the daemon: the daemon log stops with no `OutOfMemoryError` and no JVM
  crash report. Since Expo SDK 58, compiling all four ABIs overlaps the JVMs, Metro, `hermesc`
  and clang by more than the worker has (build `8ad43463`, killed in worklets `x86_64`), which
  is why `eas.json` builds two. If it comes back, take an ABI off the failing profile, or set
  `android.resourceClass` to `large` in `eas.json` if the Expo plan allows it (the account is on
  the Free plan). The GitHub log only says `Build failed`; the Gradle output is on the EAS build
  page.
- **The build is `CANCELED` at exactly 45 minutes and the Gradle output stops long before** — EAS
  ended it at its time limit; the Actions run fails with it. Build `796c9c6e`, on two ABIs and
  four Gradle workers, printed nothing after 620 s, with `:app:configureCMakeRelWithDebInfo` as
  the last `:app` task, although that task finishes locally. The cause was not found; `eas.json`
  caps the workers because of it.
- **`This account has used its Android builds from the Free plan this month`** — not a build
  failure. EAS refuses the build straight after the upload, so no build page exists and the
  Actions run fails in the *EAS build* step after about two minutes. The message gives the reset
  date.
- **`Distribution Certificate is not validated for non-interactive builds`** — iOS only. The
  first iOS build has to be run interactively (`eas build --profile preview --platform ios`
  without `--non-interactive`) with an Apple sign-in so EAS can validate the certificate;
  after that, non-interactive works. Android never needs this.
- **`app.json is missing ios.infoPlist.ITSAppUsesNonExemptEncryption`** — a warning from the
  iOS path; harmless for Android.
- **The build picks up uncommitted changes.** `eas` uploads the working tree (minus
  `.gitignore`/`.easignore`), not `HEAD`, and records `HEAD`'s hash as `gitCommitHash`. Commit
  first if the recorded commit is meant to match what was built.
- **No EAS Update / OTA.** `expo-updates` is not installed and `app.json` has no
  `updates`/`runtimeVersion`, so every change — JS included — reaches a phone only through a
  new build. (Installing `expo-updates` is itself a native change and would need a new build.)

## Full release

The three pieces ship independently; the app is last because it is the only one that cannot
be rolled forward without a reinstall. The detailed rationale is under "Deploy" in
`plans/day-planner.md`.

1. **Comments/plans worker** (`workers/comments-api/`). The *Deploy comments API* workflow
   does this after every merge that changes the worker (`docs/deploys.md`): check its latest
   run on `main` is green. By hand (or *Run workflow* on it), migration first, from `main`,
   with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment:

   ```bash
   cd workers/comments-api && npm ci
   npx wrangler d1 migrations list DB --remote   # what would apply
   npm run migrate:remote && npm run deploy
   cd ../.. && scripts/probe-comments-api.sh
   ```

   `/health` answers even while a new route 404s, so the probe script also checks a route from
   each migration that added routes (200 once deployed, 404 before) and one that needs a token
   (401 once deployed). Add a line to its `PROBES` whenever a new migration adds routes.

2. **Site.** Vercel builds `main` on push. `VITE_API_BASE_URL=https://api.tracknotes.info`
   is set on the Vercel project (Production and Preview, added 2026-09-22, moved from
   `api.contour-map-tiles.net` 2026-10-31); without it the
   planner is local-only. To confirm a deploy carries it, grep every script `my-plan.html`
   loads (its entry and `modulepreload` chunks) for `api.tracknotes.info`. The URL sits in
   whichever chunk Rollup puts the shared API client in — `assets/client-*.js` in the
   6 Nov 2026 build, not `plan-viewer-*.js` — and that moves between builds, so don't
   look in one named file:

   ```bash
   site=https://tracknotes.info
   curl -s "$site/my-plan.html" | grep -oE 'assets/[^"'"'"']+\.js' | sort -u |
     while read -r asset; do
       curl -s "$site/$asset" | grep -q api.tracknotes.info && echo "carries the API base: $asset"
     done
   ```

   No line printed means the deploy was built without `VITE_API_BASE_URL`.

3. **App, store build.** Release checklist gate (the rest of the store checklist is issue
   #31): before building, the comments API's remote migrations are all applied
   (`npx wrangler d1 migrations list DB --remote` lists nothing to apply) and
   the worker is deployed from `main` (the *Deploy comments API* run is green), with
   `scripts/probe-comments-api.sh` passing. A build
   that ships ahead of its worker loses writes to routes that 404 (#141).

   Bump `expo.version` in `mobile/app.json`; the `versionCode` is bumped
   by EAS on every `production` build (the first upload used `1`). Then run (or use the
   *Mobile build* workflow with the `production` profile):

   ```bash
   cd mobile && npx eas-cli@latest build --non-interactive --profile production --platform android
   ```

   The `.aab` it produces is uploaded through Play Console (or `eas submit`, not yet set up).
   iOS is not set up yet — see "Things that go wrong".

   **Release notes for the first build after #228.** Since the Australia contour archive was
   retired, the worker's `contours` source serves Copernicus GLO-30, so installed builds from
   before #228 now draw GLO-30 contours on Australian trails while their credits screen
   (`CONTOURS_LINE`) still says "SRTM (NASA) in Australia". No code can change a shipped build
   (no OTA), and the line still carries the full Copernicus notice, so the licence is met; the
   wording is only out of date until hikers update. Say so in the store release notes, e.g.
   "Contour lines in Australia now come from the Copernicus GLO-30 elevation model, as
   everywhere else; the map credits say so." The current `credits.ts` names only GLO-30.

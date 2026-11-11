# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-09-06] The user's global PostToolUse hook (`~/.claude/hooks/format-on-edit.sh`) runs prettier with its OWN options (double quotes, 80 cols, `arrowParens: always`) on every file touched by the Edit/Write tools — this repo has no prettier config and uses single quotes / ~100 cols, so one Edit rewrites a whole TS file and buries the real change in a quote-churn diff**
   Do instead: edit `.ts`/`.js`/`.json` here via Bash (sed/python/heredoc), which the hook does not fire on; if a file has already been churned, `npx prettier --single-quote --print-width 100 --arrow-parens avoid --trailing-comma es5 --write <file>` gets it back close to repo style — then check `git diff | grep -c '^-'` is small. Tell subagents this in their brief.
2. **[2026-11-11] A boot red box `[runtime not ready]: ReferenceError: Property 'MessageQueue' doesn't exist` means the installed dev client is on a different Expo SDK than the tree Metro is serving — not an app bug**
   Do instead: `npm run device:check-sdk` (from mobile/) says which; `device:build` + `device:wait` + `device:install` rebuilds from the served tree, caching the old APK under `~/.cache/tracknotes-apks/` (Eamon keeps SDK 54 checkouts and reinstalls whichever he is testing), and `device:restore` puts it back. See mobile/CLAUDE.md.
3. **[2026-11-11] Background Bash tasks are killed at the 10-minute timeout cap — a Gradle build or Metro started with `run_in_background` dies mid-way**
   Do instead: for the app, `npm run device:build` / `device:metro` already detach (`setsid nohup`, outside the sandbox); poll with `device:wait`. Anything else that must outlive 10 minutes: `setsid nohup <cmd> > log 2>&1 < /dev/null &` in a `dangerouslyDisableSandbox` call (plain `nohup &` gets reaped).
4. **[2026-08-18] Lockfile "in sync" is npm-major-version-dependent — local npm 11 accepts locks that CI's npm 10 rejects**
   Do instead: validate with CI's exact npm: `npx -y npm@10.8.2 ci --dry-run` in both root and mobile/; if stale, regenerate with `npx -y npm@10.8.2 install --package-lock-only`.
5. **[2026-08-24] Dev/preview servers started in the sandboxed Bash shell are NOT reachable from the user's Chrome (they bind [::1] in an isolated netns), and the host's port 4173 is occupied by an unrelated "Resupply" app — Chrome silently shows that app instead**
   Do instead: for browser verification, start `vite **dev**` with `dangerouslyDisableSandbox: true` + `run_in_background` on a non-default port (e.g. `--port 4599 --host 127.0.0.1`). Never `npm run build` just to get a page to look at: `publicDir` is `public/`, which holds ~26 GB of map tiles that `vite build` copies into `dist/` — and `emptyOutDir` wipes the user's existing `dist/` first. Expect the first CDP screenshot after each navigation to time out or capture blank mid-render — retry once or twice before diagnosing; `requestAnimationFrame` also never fires while the MCP tab is inactive, so a page that animates in sits unfinished until you screenshot it once.
6. **[2026-07-29] Jest 29 only for jest-expo; dynamic `import()` fails in tests**
   Do instead: never install Jest 30; use static imports in test files (no `await import(...)` — needs --experimental-vm-modules).
7. **[2026-11-11] A debug build only honours the `tracknotes://expo-development-client/?url=…` deep link if it was built with `expo-dev-client` — otherwise the link is a SILENT NO-OP and the app loads from 10.0.2.2:8081**
   Do instead: `npm run device:check-sdk` also flags a build with no dev launcher, and `device:metro` opens the right link; rebuild (`device:build`) rather than hand-writing the `debug_http_host` shared-pref.
8. **[2026-07-30] Local comments-API E2E without cloud auth**
   Do instead: `wrangler dev` in workers/comments-api (migrate local first), `adb reverse tcp:8787 tcp:8787`, `EXPO_PUBLIC_API_BASE_URL=http://localhost:8787` in mobile/.env.local, restart Metro (EXPO_PUBLIC_* is inlined at bundle time). Airplane mode does NOT cut adb-reverse loopback — simulate offline by killing wrangler dev.
9. **[2026-08-19] Fresh worktrees have no mobile/node_modules, and symlinking the main checkout's copy breaks when the branch adds deps (e.g. expo-secure-store) — every Jest suite then fails at jest.setup.js module resolution**
   Do instead: run a real `npm ci --legacy-peer-deps` in the worktree's mobile/ (and `npm ci` in workers/comments-api if testing the worker); never symlink or install into the shared checkout's node_modules. (Emulator: `npm run device:emulator`, run outside the sandbox, boots the AVD detached and waits until adb sees it; a sandboxed shell's adb server can't see the emulator.)
10. **[2026-11-11] Emulator restarts roll back to the last quick-boot snapshot — app data (downloaded packs, `/data/local/tmp` pushes, granted permissions) and every `adb reverse` vanish; qemu also dies intermittently mid-`am force-stop`**
   Do instead: `npm run device:emulator` (boots and waits, retries a qemu crash once), then re-run `device:metro` (re-reverses, re-warms, re-opens; `--api` for 8787), and re-push / re-download before continuing. Prefer leave-and-re-enter-guide over force-stop to re-run style resolution; Fast Refresh can't re-seat zustand stores — relaunch to verify them.

## Domain Behavior Guardrails
0. **[2026-11-11] The te-araroa build no longer fails silently (`sync:te-araroa` refuses a missing/wrong-commit package, `build:trails` a missing/stale synced GPX, `build:mobile-trails` incomplete input — all exit 1 naming `npm ci` or `npm run sync:te-araroa`); what remains is that the sibling generator checkouts under `/mnt/data/projects/GPX/` can be behind their GitHub `main`**
   Do instead: `git fetch origin` in GPX/CDT and GPX/nz before reading their state, and compare `git show HEAD:data/trails/cdt/cdt.gpx` against the generator's committed `out/` before regenerating — a newer generator commit brings a data refresh (new ids) that is not your feature. Never pipe a build through `| tail` when you need its exit code.
1. **[2026-07-29] Waypoint IDs are registry-pinned — never regenerate them ad hoc**
   Do instead: `data/waypoint-ids.json` is append-only and committed with every trail-data change; IDs flow from `scripts/build-trails.ts` → generated JSON → `build-mobile-trails` automatically. A rebuild must produce zero registry diff; ambiguity throws on purpose.
2. **[2026-07-29] Tracknotes has no `trails` SQLite table**
   Do instead: trail content comes from `src/services/trail-loader.ts` (`listTrails`/`getTrailJson`); the `guides` table holds only per-guide state (direction, tiles_downloaded, comment sync).
3. **[2026-07-29] comments-api trail allowlist must match bundled trails**
   Do instead: when adding a trail, update `ALLOWED_TRAILS` in `workers/comments-api/src/validation.ts`.
4. **[2026-07-29] Resolve MapLibre style objects before mounting the map**
   Do instead: await `getOnlineMapStyle()` / `tileManager.getOfflineStyle()` and pass the object; don't hand MapLibre a URL then swap.
5. **[2026-07-29] Design tokens are lint-enforced**
   Do instead: no raw hex colors or numeric font sizes in `src/**`/`app/**` styles; go through `useTheme().colors` and `typography`; raw palette is import-restricted to `src/tokens`.

6. **[2026-08-19] The contour tileset is public — treat the archive as an API**
   Do instead: it is published on contour-map-tiles.net (apex = docs via Pages `aus-contour-tiles`, `data.` = the R2 bucket, `tiles.` = the Worker). Bucket CORS (GET/HEAD, `etag`/`content-range` exposed) must stay on, and layer/attribute changes (`contour`, `elevation`, `is_index`) break external consumers. Worker edge caching is a no-op on `*.workers.dev` (now off, `workers_dev = false`), so measure it on `tiles.`.
7. **[2026-08-19] Filter `is_index` through `to-number`, always**
   Do instead: it is the string `"0"`/`"1"` in the tiles, and MapLibre `==` is type-strict — comparing to `1` matches nothing and fails silently (every contour at one weight, no labels). Copy filters from `scripts/topo-style.json`, and verify with `queryRenderedFeatures({layers:['contour-index']}).length > 0`, never a screenshot alone.
8. **[2026-09-02] The offline basemap has one structure and two palettes — editing `scripts/topo-style.json` alone leaves dark mode wrong, and editing either without syncing leaves the app on the old style**
   Do instead: `topo-style.json` owns sources/filters/zooms/layer order; `topo-style-dark.json` is paint-only, keyed by layer id, and must cover *every* layer (a tile-service test fails otherwise, and an unpatched layer renders light on a dark map). Run `npm run sync:style` after touching either — the app reads `mobile/assets/`, never `scripts/`. Online dark is OpenFreeMap's `dark` style, whose place labels we deliberately re-ink (Dark Matter paints them at ~3:1).
9. **[2026-08-22] `src/lib/trail-ingest.ts` is the single GPX→trail pipeline for the build, web imports and mobile imports — any edit can silently change `public/data/generated/*.json` (gitignored, so git won't show it)**
   Do instead: `npm run check:data-unchanged -- --baseline` before touching `trail-ingest`/`gpx-parser`/`track-simplify`, then `npm run check:data-unchanged` after — it rebuilds, diffs generated + app data + the waypoint registry, and exits 1 on any change. Imported ids are `u_<base36>`/`uw_<base36>` and are path-validated — never loosen `IMPORTED_ID_PATTERN` (ids become file names under `Paths.document/trails/`).

10. **[2026-09-14] A curated trail's map line is `track.displayPoints`, built to a fixed 3,000-point target whatever the length — on the CDT that is a ~265 m Douglas-Peucker tolerance (1.5 km/point, web AND phone), while alternates are drawn from their full points, so a long trail's main line looks like straight chords next to accurate alternates. The generator's GPX is not the cause (max 3.9 m deviation); the 100,000-point cap that forces it to decimate is `GPX_MAX_POINT_COUNT`, meant for user uploads but inherited by `build-trails.ts` because it passes no `limits`**
   Do instead: judge the line from `displayPoints` spacing, not the GPX; fix is a tolerance ceiling in `calculateAdaptiveTolerance` (25 m leaves the three short trails byte-identical, CDT → ~21k display points, +2.2 MB JSON) plus, if mobile size matters, a mobile-side displayPoints clamp; for more GPX headroom pass `{ maxPointCount: 0 }` from the build script.

## User Directives
1. **[2026-07-29] Use Opus subagents regularly**
   Do instead: delegate well-scoped implementation chunks to parallel `model: "opus"` Agent calls; keep orchestration/integration in the main session.
2. **[2026-07-29] Tracknotes rebuild plan is the source of truth**
   Do instead: follow `/home/eamon/.claude/plans/i-want-to-start-melodic-reddy.md` (guide-app UX rebuild, phased).

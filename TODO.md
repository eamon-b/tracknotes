# TODO

Reconciled 2026-10-18 (issue #160). Each open item below is proposed as a GitHub issue in the
PR that closed #160; delete this file once those issues exist.

## Shipped

- [x] Credit where the GPX data is from — `trail.json` `dataSource` (text + link), rendered on
      the trail page by `build-trails.ts`, and in the app's map credits. Every trail has one.
- [x] Add your own GPX files with waypoints, make the datasheet and see the trail in the app
      pages — user GPX import on web (`upload.html` → My trails) and mobile, `.tracknotes.json`
      handoff, community routes.
- [x] Crowd sourcing: comments, shared hiker waypoints (add new points), reports to hide
      bad ones; curated descriptions through `descriptions.json` and the comments API.
- [x] Measure distance between two points — mobile custom route builder (`features/routes/`).
- [x] Select campsites for the next few days and get stats per day, editing one stop at a
      time — the day planner on both platforms (Stops list, Next days suggestions).
- [x] The offline mobile app (Tracknotes) and the web planner.

## Open

- [ ] Waypoint and GPX quality control: spelling, and whether a place still exists.
- [ ] Hikers removing or correcting old points and descriptions (today only reports hide
      shared hiker waypoints; curated descriptions are admin-only).
- [ ] Ask The Adventure Gene about using their GPX files (Cape to Cape credits their guide).
- [ ] Manual test pass of recently added features — needs a written checklist first.
- [ ] Ask hikers what they want from a trail nav app (own GPX, crowd sourcing, free and
      accessible) and decide the end goal: a catalogue of Australian trails curated by users?
- [ ] Efficiency (no detail recorded; needs scoping before it can be an issue).

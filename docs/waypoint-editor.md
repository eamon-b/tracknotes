# Editing waypoints: the local waypoint editor

`src/web/admin-waypoints.html` is an admin page for reviewing and correcting a bundled trail's waypoints: their description, name and position.
It runs only under `npm run dev` and writes straight into the trail's source files, so every correction goes through git review, the normal rebuild and the normal deploy.
The deployed site has neither the page (it is not a Vite build input) nor its API (the `waypoint-editor` Vite plugin is `apply: 'serve'`).

## Using it

1. `npm ci && npm run sync:te-araroa && npm run build:trails` once, so each trail's generated JSON exists (the editor reads the last build for ids, km and route geometry).
2. `npm run dev` and open <http://localhost:5173/admin-waypoints.html>.
3. Pick a trail, then work down the list (km order) or click waypoints on the map.
4. Rebuild (the header button runs `build:trails` then `build:mobile-trails`), check its report, review `git diff`, and commit the sources with the rebuilt `mobile/assets/trails/` files and `data/waypoint-ids.json`.

The page remembers the trail, and `?trail=<dir>&id=<waypoint id>` links straight to one waypoint.

### The screen

- **List** (left): every waypoint with an id, in km order (off-route ones by the km of the nearest route point), with its type glyph and badges: `unsaved` (edits held in the page), `saved` (written since the last build), `no text` (no curated description) and ✓ (reviewed).
  Search matches names accent-insensitively, or an exact id;
  the filters narrow by type and by status (no curated text, not reviewed, changed since build, off the route, has comments).
  A row with hikers' comments carries a count badge.
- **Map** (centre): the route as built (cut at route breaks, variants dashed), every waypoint coloured by family, and the selected one as a draggable marker.
  The layer control switches between OpenTopoMap, Esri satellite imagery and OpenStreetMap, and shows OSM POIs.
  A grey dashed line joins a saved move to where the last build drew the waypoint;
  a blue one joins an unsaved move to the saved position.
  The bar under the map gives the nearest route km, the distance from the route and the distance moved, live while dragging.
- **Form** (right): name, type, id and the lists the waypoint is in;
  latitude and longitude, plus a box that takes a pasted position or a Google Maps / OpenStreetMap link;
  links to the same spot on OpenStreetMap and Google (map and satellite);
  the description with a character count and voice hints;
  the GPX / CalTopo source text the app shows when there is no curated text, with "Start from this";
  the hikers' comments on the waypoint (below);
  and the OSM POIs within 400 m, each with "Move here".

### Moving a waypoint

Drag the marker, click "Click map to place" (`Alt+P`) and click the map or a POI, type or paste coordinates, use "Move here" on a nearby POI, or "Snap to route".
Snapping uses the drawn (simplified) line, so it can sit a few metres off the full-resolution track.
A save refuses a move over 50 km and asks before one over 2 km.

### Descriptions

The text is saved to the trail's `descriptions.json` keyed by waypoint id (a new entry goes in km order, main route first), and the build applies it over the GPX / CalTopo text.
Emptying the box removes the entry, and the source text shows again.
The voice hints flag what the house voice avoids (`scripts/lib/waypoint-descriptions.ts`): addressing the walker as "you", telling them what to do ("should", "make sure", a sentence that opens "Treat", "Carry", …), a doubled space and a missing full stop.
They are hints only.
Every fact still needs its source in `plans/waypoint-description-sources.md`.

### Hikers' comments

The form lists what hikers have posted on the selected waypoint through the app ("the tank is gone", "the camp is 200 m further on"), newest first, with the author's display name, the date (and the day it was seen, when different), any water report and photos as thumbnails linking to the full image.
They are read from the comments API at `VITE_API_BASE_URL` (start `npm run dev` with it set, e.g. `VITE_API_BASE_URL=https://api.tracknotes.info npm run dev`; unset, the section says comments are unavailable).
The page makes one public read per trail, `GET /v1/trails/:trailId/comments` without `since` (live comments only, every page of up to 1000), with no token, and keeps it until Reload or a page reload;
switching waypoint does not refetch.
Comments are keyed by stable waypoint id, so a comment filed under an id no waypoint on the trail has any more is listed by id under the section, as a sign an id was lost.
In a browser linked to an admin account (the link from `admin-moderation.html`), the page also reads `GET /v1/admin/comments?reported=1`, adding comments hidden by reports or deleted by an admin, and report counts;
without one, or with a non-admin account, it says hidden comments are not shown and lists the public ones.
The worker's CORS is `*`, so a localhost page may read it.
The editor never writes to the comments API: moderation stays on `admin-moderation.html`, and a comment is a lead, not a source, so a fact it gives still needs its source in `plans/waypoint-description-sources.md`.

### Reviewing

"Reviewed" (`Alt+R`) is a per-browser mark held in `localStorage`, shown as ✓ and counted in the header's progress bar.
A mark lapses when the waypoint's name, position or description changes, so a correction pulled from git puts the waypoint back in the unreviewed pile.
`Ctrl+Enter` saves, marks the waypoint reviewed and moves to the next one in the filtered list (on an unchanged waypoint it just marks and moves on), which is the fast way through a trail.

Edits are kept per waypoint while browsing, so you can compare neighbours before saving;
the page warns before closing or switching trail with unsaved edits.

### Keys

`Ctrl`/`⌘`+`S` save;
`Ctrl`/`⌘`+`Enter` save, mark reviewed and go to the next;
`Alt`+`↓`/`↑` next / previous;
`Alt`+`R` toggle reviewed;
`Alt`+`P` place mode;
`Esc` leave place mode, or discard this waypoint's unsaved edits;
`/` search.

## What a save writes

Only the bytes it means to change: the GPX is edited in place and a JSON file is rewritten only when its layout can be reproduced exactly (the CalTopo export is spliced value by value, since some mix escaped and raw non-ASCII).
All the writes of one save are computed before any is made, so a refusal leaves nothing half-written.

- **Description:** the entry in `descriptions.json` (created if the trail has none).
- **Position:** the `<wpt>`'s `lat`/`lon` (six decimals);
  the CalTopo marker the build takes the waypoint's type from (the nearest one with the same cleaned name), so the type cannot change;
  and the waypoint's entry in `data/waypoint-ids.json`, so the next build matches it however far it moved and it keeps its id, comments and description.
  A `<wpt>`'s `<ele>` is left as it was.
- **Name:** the `<wpt>`'s `<name>` and the CalTopo marker's title, each keeping its type prefix (`C `, `WT: `);
  the registry entry's name;
  and the `name` aid in `descriptions.json`.

A save is refused, writing nothing, if the waypoint changed on disk since the page read it (reload the trail).

### What a save leaves for you

- **`access.json`:** an `osm` or `none` entry was routed from the old position: re-run `npm run fetch:access <trail-id>`.
  A `manual` entry's junction and off-trail km need checking by hand.
  The save's notes say which.
- **Lists and km:** whether a moved waypoint is on the main route, off it or on a variant, and its km, come from the rebuild.
- **Type:** the editor does not change types.
  A type change re-keys the waypoint in the registry and must migrate its entry in the same commit (`docs/architecture/trail-data.md`).
- **Revisited places:** `<id>_2`, `<id>_3` are built from the same `<wpt>` as `<id>`, so moving one moves all of them;
  the form says so.

### The rebuild report

After a rebuild the Changed files drawer lists the ids the build **minted** or **retired**.
A move or rename made here should produce neither;
if one appears, a waypoint lost its id (and the comments keyed to it), for example because a rename changed its type through a name prefix: fix the source and rebuild before committing.
The drawer also shows the build's warning lines and output.

## What it will not edit

- **Te Araroa** is read-only: its waypoints come from `te-araroa-data` (`npm run sync:te-araroa`) and are fixed upstream.
- A waypoint whose `<wpt>` cannot be found (the GPX was edited by hand since the build) is locked until a rebuild.

## Descriptions on the phone

The phone shows bundled descriptions from the app's trail data and synced ones from the comments API (`synced ?? bundled`).
Merging a change to `descriptions.json` runs the *Upload descriptions* workflow (`docs/deploys.md`), which uploads the file once approved.

## Safety

The API writes the repository, so it answers only loopback requests (set `WAYPOINT_EDITOR_ALLOW_REMOTE=1` to edit from another machine on a trusted network), and a write must carry the `X-Waypoint-Editor` header from no other origin, which a page on another site cannot send without a CORS preflight the dev server never grants.
Trail directories are taken only from the list under `data/trails/`.

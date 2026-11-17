# Editing waypoints: the local waypoint editor

`src/web/admin-waypoints.html` is an admin page for reviewing and correcting a bundled trail's waypoints: their description, name, type and position.
It also adds and deletes waypoints.
It runs only under `npm run dev` and writes straight into the trail's source files, so every correction goes through git review, the normal rebuild and the normal deploy.
The deployed site has neither the page (it is not a Vite build input) nor its API (the `waypoint-editor` Vite plugin is `apply: 'serve'`).
An urgent description fix on the deployed site goes through the live editor instead, and is then committed here ("Live edits on the deployed site" below).

## Using it

1. `npm ci && npm run sync:te-araroa && npm run build:trails` once, so each trail's generated JSON exists (the editor reads the last build for ids, km and route geometry).
2. `npm run dev` and open <http://localhost:5173/admin-waypoints.html>.
3. Pick a trail, then work down the list (km order) or click waypoints on the map.
4. Rebuild (the header button runs `build:trails` then `build:mobile-trails`), check its report, review `git diff`, and commit the sources with the rebuilt `mobile/assets/trails/` files and `data/waypoint-ids.json`.

The page remembers the trail, and `?trail=<dir>&id=<waypoint id>` links straight to one waypoint.
A waypoint added since the last build has only a temporary key there (`id=new:…`), which changes when it is renamed or moved and goes when a rebuild gives it its id.

### The screen

- **List** (left): every `<wpt>` the trail has, in km order (off-route ones by the km of the nearest route point), with its type glyph and badges: `unsaved` (edits held in the page), `saved` (written since the last build), `pending rebuild` (added since the last build: no id yet, so it is edited in the GPX alone), `deleted` (its `<wpt>` is gone since the last build), `merged` (a near-duplicate the build merged into another waypoint: it has an id but no row in the app), `+N merged` (the waypoint those were merged into), `no text` (no curated description) and ✓ (reviewed).
  A merged duplicate is listed straight after the waypoint it merged into.
  Search matches names accent-insensitively, or an exact id;
  the filters narrow by type and by status (no curated text, not reviewed, changed since build, added and pending a rebuild, merged duplicates with what they merged into, off the route, has comments).
  A row with hikers' comments carries a count badge.
- **Map** (centre): the route as built (cut at route breaks, variants dashed), every waypoint coloured by family, and the selected one as a draggable marker.
  A waypoint pending a rebuild has a dashed dark edge;
  a merged duplicate is a smaller hollow ring with a dotted edge, since the app does not show it.
  The layer control switches between OpenTopoMap, Esri satellite imagery and OpenStreetMap, and shows OSM POIs.
  A grey dashed line joins a saved move to where the last build drew the waypoint;
  a blue one joins an unsaved move to the saved position;
  a dotted one joins a selected merged duplicate to the waypoint it merged into (and that waypoint to its duplicates).
  The bar under the map gives the nearest route km, the distance from the route and the distance moved, live while dragging.
- **Form** (right): name;
  type, with what decides it in the build (a CalTopo folder, a GPX `<type>`, a name prefix, a known town, or nothing);
  id and the lists the waypoint is in;
  for a merged duplicate, the waypoint the build merged it into (a link to it) and how far apart they are, and on that waypoint the ids merged into it;
  latitude and longitude, plus a box that takes a pasted position or a Google Maps / OpenStreetMap link;
  the `<ele>` its `<wpt>` has in the GPX, when it has one (a merged duplicate's and a pending waypoint's included);
  links to the same spot on OpenStreetMap and Google (map and satellite);
  the description with a character count and voice hints;
  the GPX / CalTopo source text the app shows when there is no curated text, with "Start from this";
  the hikers' comments on the waypoint (below);
  and the OSM POIs within 400 m, each with "Move here".

### Moving a waypoint

Drag the marker, click "Click map to place" (`Alt+P`) and click the map or a POI, type or paste coordinates, use "Move here" on a nearby POI, or "Snap to route".
Snapping uses the drawn (simplified) line, so it can sit a few metres off the full-resolution track.
A save refuses a move over 50 km and asks before one over 2 km.
A `<wpt>` that has an `<ele>` has it looked up again for the new position ("Elevation" below);
one with no `<ele>` is not given one.

### Descriptions

The text is saved to the trail's `descriptions.json` keyed by waypoint id (a new entry goes in km order, main route first), and the build applies it over the GPX / CalTopo text.
Emptying the box removes the entry, and the source text shows again.
The voice hints flag what the house voice avoids (`scripts/lib/waypoint-descriptions.ts`): addressing the walker as "you", telling them what to do ("should", "make sure", a sentence that opens "Treat", "Carry", …), a doubled space and a missing full stop.
They are hints only.
Every fact still needs its source in `plans/waypoint-description-sources.md`.

A waypoint added since the last build has no id to key an entry by, so its box edits the `<desc>` of its `<wpt>` instead ("Editing a waypoint before its rebuild" below);
the form labels the box `Description: GPX <desc>` and says so under the label.

### Changing a type

Pick the type from the select (every type in `WAYPOINT_TYPES`) and save.
The save changes whatever the build types the waypoint from, and its registry entry's `type` in the same write, because the registry matches on type and a type change would otherwise re-key the waypoint and orphan its comments (`docs/architecture/trail-data.md`):

- **CalTopo folder or marker title** (the nearest CalTopo marker with the waypoint's name decides): the marker's `folderId` moves to a folder whose title means the new type (`FOLDER_TYPE_MAP` in `src/lib/waypoint-classifier.ts`), and the folder is added to the export when it has none (`Water tanks`, `Huts`, …).
  The marker's title, prefix included, is left alone: the folder outranks it.
- **GPX `<type>`**: the `<type>` is rewritten in place.
- **Name** (a prefix such as `C `, a known town, or nothing): a `<type>` is added to the `<wpt>`, which outranks the name in the build, and the prefix is dropped from `<name>` (only when that leaves the name the build shows unchanged), since it would contradict the type.

Before writing, the save works out the type the build will give the edited sources and runs the build's id matching (`assignWaypointIds`, on a copy of the registry) over the sources before and after;
it refuses, writing nothing, if the type would not stick or if any waypoint's id would change.
It also refuses:

- a type no CalTopo folder title means (every `-access` turn-off, `gap`, `junction`, `milestone`, `waypoint`) on a waypoint a CalTopo marker types: add a folder title to `FOLDER_TYPE_MAP` first, as a classifier change of its own;
- a marker that also types another waypoint (two `<wpt>`s with one name, nearest to the same marker): retyping it would retype both;
- a type the editor does not offer, such as `water-access` (a turn-off to water is never water: see `RESUPPLY_TYPES` in `waypoint-taxonomy.ts`).

The save's notes say when the waypoint starts or stops counting as water or as a resupply point, and when it becomes or stops being a turn-off.

### Adding a waypoint

"New waypoint" (under the map) opens a form: click the map or an OSM POI to place it (drag the marker to adjust), then give it a name, a type and, optionally, a description.
"Add waypoint" inserts a `<wpt>` after the last one in the GPX, written like its neighbours (the same indentation, one line or one child per line, `<ele>`, `<name>`, `<desc>` and `<type>` in the order the file uses).
It gets an `<ele>` when the file's `<wpt>`s carry one ("Elevation" below).
Nothing goes in `data/waypoint-ids.json` or `descriptions.json`: the waypoint has no id until the next build mints one, so the description goes in its `<desc>`, where the build reads it as source text.
Until a rebuild it is listed as `pending rebuild` under a temporary key (`new:` and a hash of its `<wpt>`'s name and position; a colon is never in an id, so it cannot be mistaken for one);
the save's notes name the id the next build will mint.

On a CalTopo-typed trail no marker is added: the build types a `<wpt>` from a marker only when one has its name, and otherwise from its `<type>`, so the `<type>` is enough.
A marker that does have its name would win however far away it is, so the add is refused when one would type it differently.
It is also refused for a name that starts with a type prefix (the build strips it), a position more than 50 km from the route, a position another `<wpt>` already has (the editor tells waypoints apart by their coordinates), and anything that would stop the build or change another waypoint's id.
When the new waypoint stands where a retired waypoint of the same type and name stood, the next build hands it that id back (with its comments and description), and the notes say so.
They also say so when it stands within 100 m of a waypoint of its type that was deleted since the last build: that entry is not retired yet, so the build reads the new `<wpt>` as the old one moved or renamed and gives it the old id.
Rebuild between the delete and the add when the two are different places.

### Editing a waypoint before its rebuild

A pending waypoint (one added here, or a `<wpt>` added to the GPX by hand) is edited like any other: name, position, type and description, with the same form and the same marker on the map.
It has no id, so a save writes its `<wpt>` and nothing that keys by id: no registry entry, no `descriptions.json` entry.

- **Name, position, type:** the `<name>` (keeping a type prefix a hand-written one has), `lat`/`lon` and `<type>` of its `<wpt>`.
  A move looks its `<ele>` up again for the new position, as for any waypoint ("Elevation" below).
- **Description:** its `<desc>`, added after the `<name>`, replaced, or removed when the box is emptied, with the same length limit as curated text.
  It is GPX source text, which the app shows as it stands;
  once a rebuild has given the waypoint an id, text saved in the box is curated text in `descriptions.json`, which outranks the `<desc>` ("Start from this" copies it over).
- **Its key:** the temporary key is a hash of the name and position, so a rename or a move changes it.
  The save answers with the waypoint under its new key and the page follows it: the list row, the map marker, the selection, the address (`?id=`) and any unsaved edits.
  Nothing is kept under the old key, and a pending waypoint takes no review mark.

A save is held to what an add is held to, and refused (writing nothing) for a name that starts with a type prefix, a position more than 50 km from the route or one another `<wpt>` already has, a name a CalTopo marker would type differently, and anything that would stop the build or change another waypoint's id.
The same stale-content check applies: the save is refused if the `<wpt>` changed on disk since the page read it.
After a move, rename or retype the notes name the id the next build will mint for it (or hand back to it) as it now stands: the id is minted from the type and position, so it changes with either.

A hand-added `<wpt>` whose name a CalTopo marker has is typed by that marker.
When the marker types only that `<wpt>`, a save treats it as for any waypoint: it moves with the `<wpt>`, is retitled with it, and changes folder for a new type.
When the marker also types another `<wpt>` (the build takes the nearest marker with the name, however far), a move, rename or retype is refused: delete the waypoint and add it again under a name of its own.
When the marker has a description, the build shows that in place of the `<desc>`, so the description box is locked until a rebuild.
In every case a move, rename or retype checks the type the build will give the edited `<wpt>` and is refused unless that is the type the editor shows.

### Elevation

The build never reads a `<wpt>`'s `<ele>`: an on-route waypoint's elevation in the built data is its matched track point's, and an off-trail waypoint has none.
The editor keeps the `<ele>` anyway, so that the source GPX stays complete and consistent in the files whose `<wpt>`s carry one (Great North Walk, Grampians Peaks, Overland, Three Passes, the CDT and others; Heysen's and Shikoku's carry none).

- **A new waypoint** gets an `<ele>` when at least half of the file's `<wpt>`s have one, and none otherwise.
  It goes where the last `<wpt>` has its own (first, where GPX 1.1 puts it, when that one has none), with the number of decimals most of the file's `<ele>`s use (`745.0`).
- **A moved waypoint** (one still pending a rebuild included) whose `<wpt>` has an `<ele>` has it rewritten in place, with the decimals it had.
  One with no `<ele>` is not given one.

The elevation is looked up for the position as it is written (six decimals):

1. **From the route**, when the position is on it: within the distance at which the build matches a waypoint to the main route (`waypointMaxDistance` in `trail.json`, 500 m by default), measured to the line of the last build's full-resolution track and never across a route break.
   The height is interpolated between the track points either side, so it is the one the elevation profile shows there.
   A track with no real elevations (`elevationSource: 'none'`, or every point at 0) gives none.
2. **From the Copernicus GLO-30 DEM** otherwise, read over the network (`scripts/lib/dem-sampler.ts`), waiting at most 8 seconds.
   That covers a place off the route, and one on an alternate or side trip further than that from the main route.
   Behind a proxy, start the dev server with `NODE_USE_ENV_PROXY=1 npm run dev`, as for `npm run fetch:access`.
   No trail whose `<wpt>`s carry no `<ele>` ever asks the DEM.
3. **Not at all** when neither answers (offline, a timeout, open sea): the save goes ahead regardless.
   A new `<wpt>` is then written without an `<ele>`, and a moved one keeps the `<ele>` it had, which may be stale.

The save's notes say what was written and where it came from ("812.3 m, from the route", "from the Copernicus DEM"), or that nothing was found and why, or that the file's `<wpt>`s carry none.

### Deleting a waypoint

"Delete…" asks first, saying that comments keyed to the id are orphaned: they stay on the server, but no waypoint shows them.
It removes the `<wpt>`, the CalTopo marker that typed it (unless that marker also types another waypoint) and its `descriptions.json` entries.
Its registry entry stays: the next build marks it `retired`, and a retired id is never handed to a different place.
Until the rebuild the waypoint stays in the list as `deleted`, locked.
A revisited place's later pass (`<id>_2`) cannot be deleted on its own, since it is built from the first pass's `<wpt>`: deleting the first pass deletes every pass and their descriptions.
An `access.json` entry for the place is left for `npm run fetch:access` (the notes say so).
Deleting a pending waypoint just takes its `<wpt>` out again (a CalTopo marker with its name stays).
Deleting a waypoint that near-duplicates were merged into leaves those `<wpt>`s where they are, so the next build lists them again as rows of their own, under their own ids (the confirm and the notes name them): comments keyed to the deleted id do not move to them.

### Merged near-duplicates

On a trail with `dedupeWaypoints` in `trail.json`, the build mints an id for every `<wpt>` and then merges waypoints with the same name and type that are within the radius of one another (150 m unless `radiusMeters` says otherwise, and in a chain: a third within reach of the second is merged with the first).
One survives, with the others' ids in its `mergedIds`;
the others keep their `<wpt>`, their id and a live registry entry, but have no row in the built data.
The editor lists each of them as a row of its own, joined to its `<wpt>` through its registry entry (the entry's exact coordinates, like every other join), so a redundant duplicate can be removed here.

- **Deleting one** goes through the usual delete: its `<wpt>`, the CalTopo marker that typed it (unless shared) and any `descriptions.json` entry under its id, with the same id check.
  The next build retires exactly its id and drops it from the survivor's `mergedIds`;
  the survivor is untouched.
- **Its comments.**
  Nothing in the app reads `mergedIds`: the phone looks comments up by the id of the row it shows, and a merged duplicate has had no row since the build began merging it.
  So comments keyed to its id were already shown nowhere, and deleting it changes nothing a hiker sees: the confirm and the notes say that, not that the comments are orphaned.
  Its row here does show them (the only place that does), paged like any waypoint's, and the confirm counts them, in case a report belongs on the waypoint it merged into.
  A note that the app does not show them sits above the first comment, so "Show more" never hides it.
  That waypoint's own comments section says, in the same place, when comments are filed under an id merged into it.
- **Its description.**
  The build appends a merged duplicate's description (its `<desc>`, a CalTopo marker's text, or a curated entry under its id) to the survivor's, as a paragraph of its own, unless the survivor's text already has it.
  Deleting it takes that paragraph out of the survivor's bundled text at the next build, and the notes say so.
- **A chain.**
  When the deleted duplicate was the only link between the survivor and a further one, that further one is no longer within the radius of anything left in the merge and the next build lists it again: the notes name it.
- **Editing the survivor.**
  The merge is on name, type and distance, so renaming, retyping or moving the survivor can end it: the save's notes name the duplicates the next build will then list again.
- **Renaming one** is the way out when it is a different place and not a duplicate: under a name of its own the build no longer merges it, and the next build lists it as a waypoint under the id it already has, with the comments filed under that id.
  The save renames its `<wpt>` (and its CalTopo marker) and its registry entry together, and is refused unless the build's id matching keeps every id, its own included.
  Until the rebuild the row says the next build will list it on its own.
- **Its position, type and description are locked** while it is merged: the app shows the survivor's, so those are corrected on the survivor, and a description saved under a merged id would only be appended to the survivor's bundled text.
  The form says so, with the two ways forward (delete it, or rename it).

### Hikers' comments

The form lists what hikers have posted on the selected waypoint through the app ("the tank is gone", "the camp is 200 m further on"), newest first, with the author's display name, the date (and the day it was seen, when different), any water report and photos as thumbnails linking to the full image.
A waypoint with many comments shows its newest 10, with a line saying how many are shown of how many, "Show 10 more" for the next page and "Show all" when more than one further page remains;
the count in the heading is always the waypoint's total.
What is revealed belongs to the selected waypoint: selecting another starts again at the newest 10, while typing in the form, Reload and a save keep it.
Comments that are not shown are not in the page, so their thumbnails are not fetched (those shown load lazily).
They are read from the comments API at `VITE_API_BASE_URL` (start `npm run dev` with it set, e.g. `VITE_API_BASE_URL=https://api.tracknotes.info npm run dev`; unset, the section says comments are unavailable).
The page makes one public read per trail, `GET /v1/trails/:trailId/comments` without `since` (live comments only, every page of up to 1000), with no token, and keeps it until Reload or a page reload;
switching waypoint does not refetch.
Comments are keyed by stable waypoint id, so a comment filed under an id no waypoint on the trail has any more is listed by id under the section, as a sign an id was lost.
That list shows 20 ids at a time, with the same "Show more" and "Show all", and what is revealed of it lasts until another trail is opened.
An id the build merged into another waypoint is not lost: it has a row of its own, which shows its comments ("Merged near-duplicates" above).
In a browser linked to an admin account (the link from `admin-moderation.html`), the page also reads `GET /v1/admin/comments?reported=1`, adding comments hidden by reports or deleted by an admin, and report counts;
without one, or with a non-admin account, it says hidden comments are not shown and lists the public ones.
Hidden and reported comments sit in the same newest-first list and page with it, so the "showing" line says how many of the comments not yet shown are hidden, and how many more are published but reported ("The 227 not shown include 3 hidden and 2 more reported.").
The worker's CORS is `*`, so a localhost page may read it.
The editor never writes to the comments API: moderation stays on `admin-moderation.html`, and a comment is a lead, not a source, so a fact it gives still needs its source in `plans/waypoint-description-sources.md`.

### Reviewing

"Reviewed" (`Alt+R`) is a per-browser mark held in `localStorage`, shown as ✓ and counted in the header's progress bar.
A mark lapses when the waypoint's name, position or description changes, so a correction pulled from git puts the waypoint back in the unreviewed pile.
A pending waypoint cannot be marked: a mark is kept under the waypoint's id, and it has none yet.
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
  A `<wpt>`'s `<ele>`, when it has one, is rewritten for the new position ("Elevation" above), and left as it was when no elevation is found.
- **Name:** the `<wpt>`'s `<name>` and the CalTopo marker's title, each keeping its type prefix (`C `, `WT: `);
  the registry entry's name;
  and the `name` aid in `descriptions.json`.
- **Type:** the CalTopo marker's `folderId` (and a new folder feature, first in `features`), or the `<wpt>`'s `<type>` (added when it has none, with any name prefix dropped);
  and the registry entry's `type`.
- **New waypoint:** one `<wpt>` in the GPX (with an `<ele>` when the file's `<wpt>`s carry one), and nothing else.
- **Pending waypoint** (added since the last build): its `<wpt>` alone, whatever is edited: `lat`/`lon` (and its `<ele>`, as for any move), `<name>`, `<type>` and `<desc>`;
  and the CalTopo marker with its name, when that marker types no other waypoint.
  Never the registry or `descriptions.json`: it has no id.
- **Delete:** the `<wpt>` (with the spacing before it), the CalTopo marker feature (with the comma that joined it) and the `descriptions.json` entries of every pass.
- **Merged duplicate:** a delete as above, or a rename (its `<wpt>`'s `<name>`, its CalTopo marker's title and its registry entry's name);
  nothing else.

A save is refused, writing nothing, if the waypoint changed on disk since the page read it (reload the trail).

### What a save leaves for you

- **`access.json`:** an `osm` or `none` entry was routed from the old position: re-run `npm run fetch:access <trail-id>`.
  A `manual` entry's junction and off-trail km need checking by hand.
  The save's notes say which.
- **Lists and km:** whether a moved or new waypoint is on the main route, off it or on a variant, and its km, come from the rebuild.
- **Revisited places:** `<id>_2`, `<id>_3` are built from the same `<wpt>` as `<id>`, so moving or retyping one moves or retypes all of them;
  the form says so.

### The rebuild report

After a rebuild the Changed files drawer lists the ids the build **minted** or **retired**.
A move, rename or type change made here should produce neither;
a waypoint added here should mint exactly the id its last save named (a move, rename or retype of a pending waypoint names it afresh), and one deleted here should retire exactly its own.
That holds for a merged duplicate too: deleting one retires its id alone, and a duplicate that comes back as a row (renamed apart, freed from a chain, or left behind by a deleted survivor) keeps the id it had, so nothing is minted.
Anything else means a waypoint lost its id (and the comments keyed to it), for example because a rename changed its type through a name prefix: fix the source and rebuild before committing.
The drawer also shows the build's warning lines, open, and its output.
The warning lines are every line the build printed on stderr, which is where it puts all of its warnings and failures (`console.warn` and `console.error`; a clean build prints nothing there), plus any stdout line that opens with `Warning:`, `⚠`, `!` or `✗`.
They are collected from the whole output as it arrives, not from the part of the log the drawer keeps.
So they include the build's id-minting warnings (`! <trail>: new <type> "…" is within 100 m of …`, once where it happened and again under the summary "N new waypoint id(s) were minted beside another waypoint of the same type"), which that build is the only one to print.
A waypoint added here next to another of its type produces one: check the two are not the same place under two names.
A failed build's last warning line names the step that stopped and its exit code.

### While a rebuild runs

Saves, adds and deletes are refused (409) from the moment a rebuild starts until it ends, and a second Rebuild does not start a second build.
That holds across a restart of the dev server by Vite, which happens when `vite.config.ts` or a file it imports changes: the rebuild carries on, and its state and report are kept.
The editor's own modules and `src/lib` are not among those files (the plugin loads them per request), so editing them restarts nothing, and the next request runs the edited code.
It also holds across dev server processes: a running rebuild leaves a lock file in the system's temporary directory, naming the dev server and the build step, and another dev server on the same checkout refuses saves and rebuilds while either is alive.
The refusal names the file, to delete if no build is in fact running; a lock over 30 minutes old is ignored.

Nothing stops a build step when the dev server stops.
`Ctrl+C` in the terminal reaches the build as well, as it would a build run by hand: rebuild again.
If only the dev server is killed, the step that is running finishes (a half-written `data/waypoint-ids.json` would be worse), `build:mobile-trails` is not started if it had not been, and the report is lost: start the dev server and rebuild again.

## What it will not edit

- **Te Araroa** is read-only: its waypoints come from `te-araroa-data` (`npm run sync:te-araroa`) and are fixed upstream.
- A waypoint whose `<wpt>` cannot be found (deleted here, or the GPX was edited by hand since the build) is locked until a rebuild.
- A pending waypoint (added since the build) through a CalTopo marker that also types another waypoint: it can be described and deleted, not moved, renamed or retyped.
- The description of a pending waypoint whose CalTopo marker has one, until a rebuild gives it an id.
- The position, type and description of a `<wpt>` the build merged into a near-duplicate (`dedupeWaypoints`): it can be deleted, or renamed apart ("Merged near-duplicates").
- A merged duplicate whose id has no registry entry: nothing says which `<wpt>` it is, so it is not listed (its `<wpt>` shows as pending).
- A type no CalTopo folder title means, on a waypoint a CalTopo marker types (see "Changing a type").

## Descriptions on the phone

The phone shows bundled descriptions from the app's trail data and synced ones from the comments API (`synced ?? bundled`).
Merging a change to `descriptions.json` runs the *Upload descriptions* workflow (`docs/deploys.md`), which uploads the file once approved.

## Live edits on the deployed site

For a correction that cannot wait for a merge (a closed water tank, a wrong fact), `https://tracknotes.info/admin-descriptions.html` edits the synced description directly, from any browser.
It is unlinked and noindex, and it is the only description tool on the deployed site; this local editor stays the way descriptions are authored.

- **Access:** reading needs nothing; editing needs the browser linked (with a link code from the app) to an admin account, the same as the moderation pages.
- **The list:** pick a trail, and each waypoint shows its bundled description beside its synced one, a yellow box where they differ, and a state: *in sync*, *drift*, *cleared*, *not uploaded* (in the file, not yet on the API) or *bundled only*.
  The filters narrow to drift, to synced rows, to synced text that differs from the bundle, to the file's entries, or to waypoints with no description at all.
- **Edit synced text** sends the new text to every phone on its next sync, with the same character limit and voice hints as here.
- **Clear synced text** sends an empty description (a tombstone): phones fall back to the bundled text, so a clear can undo a live edit but cannot hide a curated text; to correct one, edit it.

### The drift rule: edit live for urgency, then commit to descriptions.json

`descriptions.json` is the source of truth.
The *Upload descriptions* workflow runs on any merged change to any trail's `descriptions.json`, and it makes the API match the files: a synced text the file does not have is replaced with the file's text, or withdrawn if the file has no entry.
So a live edit that never reaches the file is lost at the next upload, whichever trail's file that merge changed.

The page knows the file as the site was last deployed, and marks every synced text that is not in it as **drift**, with a banner over the list.
To commit the drift:

1. On the page, **Download updated descriptions.json** (the trail's file with the drifted synced text written in: an existing entry in place, a new one in route order) or **Copy the changed entries**.
2. Put it at the path the banner names (`data/trails/<dir>/descriptions.json`), check the `git diff` shows only those entries, and check every fact has its source in `plans/waypoint-description-sources.md`.
3. Rebuild (`npm run build:trails && npm run build:mobile-trails`), and commit the file with the rebuilt data as for any description change.

Once that merges, the upload finds the API already holds the text (nothing to send for it), and the page shows the row as *in sync* after the site redeploys.
The upload's dry run also prints every synced text it would replace (`! replaces synced text`) and ends with a warning, so the approver sees drift that was missed before approving (`docs/deploys.md`).

## Safety

The API writes the repository, so it checks every request itself, reads included, before doing anything else (`requestRefusal` in `scripts/lib/waypoint-editor/vite-plugin.ts`), and answers 403 unless:

- **It comes from this machine:** the connection is from a loopback address.
- **Its `Host` is a loopback name:** `localhost`, a `*.localhost` name, a `127.0.0.0/8` address or `[::1]`, with or without a port.
  This is what stops DNS rebinding: a page on another site whose name is re-pointed at 127.0.0.1 reaches the dev server from loopback and same-origin, so with any header it likes and no CORS preflight, but the `Host` it sends is still its own name.
  A plugin's middleware runs before Vite's own host check, so the API does not rely on that one.
- **Its `Origin`, when it sends one, is the dev server's own** (it equals the `Host`).
  A browser sends `Origin` with every cross-origin `fetch` and with every write, so a page on another site, or on another port of this machine, is refused here.
  A refused CORS preflight is not the guard: Vite's own CORS middleware allows any localhost origin.
- **A write carries the `X-Waypoint-Editor` header**, which a form post cannot set.

Reads are closed to other pages the same way: one with a foreign `Origin` is refused, and every response carries `Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff`, so a page cannot load one without an `Origin` either.
Most of what they return is the trail data the site publishes anyway, but the rebuild log and the changed-files list name paths on this machine.

`WAYPOINT_EDITOR_ALLOW_REMOTE=1` is for editing from another machine on a trusted network (`WAYPOINT_EDITOR_ALLOW_REMOTE=1 npx vite --host`, then `http://<this machine's address>:5173/admin-waypoints.html`).
It lifts the loopback-address check, and the `Host` may then also be any IP address literal, or a name listed in `server.allowedHosts` in `vite.config.ts` (a leading dot covers subdomains, as Vite reads it).
An address cannot be re-pointed the way a name can, and a listed name is one you vouch for.
No other DNS name is accepted, not even under `server.allowedHosts: true`, and the `Origin` and header checks stay.
Anyone who can reach the port can then write the repository's files, so use it only where that is acceptable.

Trail directories are taken only from the list under `data/trails/`.
A request body is at most 64 KB of JSON (413 beyond that), and a malformed URL or body is answered 400.

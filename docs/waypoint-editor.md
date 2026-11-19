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

- **Header**: the trail select, and "Reload trail", which reads the trail's source files again (after a `git pull`, an edit by hand, or a save refused because the waypoint changed on disk).
  A reload keeps the selection, the map view, the list's place and every unsaved edit;
  only opening another trail starts afresh.
  Then the review progress, "Changed files", "Rebuild trail data" and "Keys".
  The Changed files drawer names the source files a save on the open trail may write (the GPX, the CalTopo export, `descriptions.json`, the registry, and `trail.json` for a rename or a delete of a revisited place) above the files git reports as changed;
  on a read-only trail it names none.
  A trail that cannot be read (a GPX the build cannot read, a trail not built yet) leaves the list and the map empty with the reason in the banner: pick another trail, or put it right and press "Reload trail", which asks for it again.
- **List** (left): every `<wpt>` the trail has, in km order (off-route ones by the km of the nearest route point), with its type glyph and badges: `unsaved` (edits held in the page), `saved` (written since the last build), `pending rebuild` (added since the last build: no id yet, so it is edited in the GPX alone; `pending rebuild → <id>` when the next build hands it an id the registry already holds), `deleted` (its `<wpt>` is gone since the last build), `not built` (it has an id in the registry but the last build on this machine does not list it: locked until a rebuild), `merged` (a near-duplicate the build merged into another waypoint: it has an id but no row in the app), `+N merged` (the waypoint those were merged into), `no text` (no curated description) and ✓ (reviewed).
  A merged duplicate is listed straight after the waypoint it merged into.
  Search matches names accent-insensitively, or an exact id;
  the filters narrow by type and by status (no curated text, not reviewed, changed since build, added and pending a rebuild, merged duplicates with what they merged into, off the route, has comments).
  "Changed since build" lists a `not built` row too, and "No curated text" and "Off the route" leave it out: it cannot be described here yet, and its place on the route comes from the rebuild.
  A row with hikers' comments carries a count badge.
  A waypoint pending a rebuild has no place on the route yet (main route, a variant, or off it): that comes from the build, so its row is never labelled `off route` and the "off the route" filter leaves it out.
- **Map** (centre): the route as built (cut at route breaks, variants dashed), every waypoint coloured by family, and the selected one as a draggable marker.
  A waypoint pending a rebuild has a dashed dark edge;
  a merged duplicate is a smaller hollow ring with a dotted edge, since the app does not show it.
  The layer control switches between OpenTopoMap, Esri satellite imagery and OpenStreetMap, and shows OSM POIs.
  A grey dashed line joins a saved move to where the last build drew the waypoint;
  a blue one joins an unsaved move to the saved position;
  a dotted one joins a selected merged duplicate to the waypoint it merged into (and that waypoint to its duplicates).
  The bar under the map says which line the position is measured to, live while dragging: the nearest main-route km and the distance from the main route;
  or, when an alternate's or side trip's line is nearer, the distance from that line (named) and then from the main route;
  then the distance moved.
  The map zooms to the whole trail only when another trail is opened: a save, an add, a delete, a rebuild and "Reload trail" leave the view where it is.
- **Form** (right): name;
  type, with what decides it in the build (a CalTopo folder, a GPX `<type>`, a name prefix, a known town, or nothing);
  id and the lists the waypoint is in, and for an off-route place how far it was from the main route in the last build (metres under a kilometre, kilometres above);
  for a pending waypoint the next build hands an existing id, that id (a link to the row that has it, when one does);
  for a pass of a revisited place, the other passes built from the same `<wpt>`, and that a move, a rename or a type change here changes the place, so every pass;
  for a merged duplicate, the waypoint the build merged it into (a link to it) and how far apart they are, and on that waypoint the ids merged into it;
  latitude and longitude, plus a box that takes a pasted position or a Google Maps / OpenStreetMap link;
  the `<ele>` its `<wpt>` has in the GPX, when it has one (a merged duplicate's and a pending waypoint's included);
  links to the same spot on OpenStreetMap and Google (map and satellite);
  the description with a character count (red once over the limit) and voice hints;
  the GPX / CalTopo source text the app shows when there is no curated text, with "Start from this";
  the hikers' comments on the waypoint (below);
  and the OSM POIs within 400 m, each with "Move here".

### Moving a waypoint

Drag the marker, click "Click map to place" (`Alt+P`) and click the map or a POI, type or paste coordinates, use "Move here" on a nearby POI, or "Snap to route".

- **Lat and Lon** take effect when the field is left, and before any shortcut or button acts: `Ctrl+S`, `Ctrl+Enter` or `Alt`+`↓` pressed with the cursor still in the field act on what it shows.
  An empty or unparsable field is flagged and moves nothing (it is never read as 0);
  a save or a step to another row then waits until it is corrected, and `Esc` in the field, or "Undo move", puts the position back.
  The fields show a position at six decimals, and some files hold more (CalTopo writes `138.19241669999997`): a field left holding what it showed is no move, so nothing is rewritten for it.
- **The paste box** applies a pasted position at once, and one typed by hand on `Enter` or when the box is left (never keystroke by keystroke: `27.6901, 8` is already a position).
  A Google Maps place link is read from its pin (`!3d…!4d…`);
  the centre of the view (`@…`) is used only when the link has no pin.
- **"Snap to route"** moves onto the nearest line: the main route, or an alternate or side trip when its line is nearer, so a side-trip waypoint snaps to its side trip and not across country to the main route.
  It never snaps onto the straight line of a route break.
  The main route is snapped to as drawn (simplified), so the result can sit a few metres off the full-resolution track.

A save refuses a move over 50 km and asks before one over 2 km.
The position is rounded to six decimals (about 0.1 m) once, as the save takes it, and that is the number written to the GPX, the CalTopo marker and the registry;
one that rounds to where the waypoint already is moves nothing.
A `<wpt>` that has an `<ele>` has it looked up again for the new position ("Elevation" below);
one with no `<ele>` is not given one.
The CalTopo marker that types the waypoint moves with it, unless that marker also types another `<wpt>`: it is then left where it is, and the notes say so (the build takes the nearest marker with the name, so the type holds either way).
Every move is checked before it is written ("What every move, rename and type change is checked for" below).

### Renaming a waypoint

The name typed is the name the build shows, so one that starts with a type prefix (`C `, `WT: `, …), which the build would strip, is refused.
The `<wpt>`'s `<name>` and its CalTopo marker's title keep the prefix and the spacing they have, and only the name part changes.
A marker that also types another `<wpt>` is left titled as it is, and the notes say so.
When the new name alone would change the type (a known town such as `Thredbo`, or a name no marker has any more on a waypoint with no `<type>`), a `<type>` with the waypoint's present type is added to its `<wpt>`, which outranks the name in the build, and the notes say so.
Where that cannot hold the type (a CalTopo marker types the waypoint from its title), the rename is refused: change the type in the same save if the new type is right.
A place listed in trail.json's `revisitedWaypoints` (the build keeps its later passes by name) is renamed there in the same save;
the name is replaced in place, and trail.json's layout is left as it is.

### Descriptions

The text is saved to the trail's `descriptions.json` keyed by waypoint id, and the build applies it over the GPX / CalTopo text.
A new entry goes before the first entry that follows it, counting main-route waypoints first and by km and the rest after, by their position along the route;
in a file that is in that order it lands in order, and in one with entries out of place (the AAWT's has 11) nothing else is moved.
An entry's `name`, an aid to reading the file, is written on a new entry and changed only by a save that renames the waypoint.
Emptying the box removes the entry, and the source text shows again.
A revisited place's later pass (`<id>_2`) has no text of its own: the build applies the description to the place before it makes the passes, so the row shows the first pass's text, and its lock note names the first pass as the place to edit it.
Its box is read-only, labelled as the place's description, with a line under the label naming the id to edit it on;
it shows no character count and no voice hints, and "Start from this" is not offered.
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

It is checked before it is written, like a move and a rename (next section), and it also refuses:

- a type no CalTopo folder title means (every `-access` turn-off, `gap`, `junction`, `milestone`, `waypoint`) on a waypoint a CalTopo marker types: add a folder title to `FOLDER_TYPE_MAP` first, as a classifier change of its own;
- a marker that also types another waypoint (two `<wpt>`s with one name, nearest to the same marker): retyping it would retype both, so rename this waypoint first;
- a type the editor does not offer, such as `water-access` (a turn-off to water is never water: see `RESUPPLY_TYPES` in `waypoint-taxonomy.ts`).

The save's notes say when the waypoint starts or stops counting as water or as a resupply point, and when it becomes or stops being a turn-off.

### What every move, rename and type change is checked for

Before writing, a save that moves, renames or retypes a waypoint, one with an id or one still pending, works out what the build will make of the edited sources, and refuses, writing nothing, unless:

- **the type holds:** the type the build gives the edited `<wpt>` (`resolveSourceType`: the nearest CalTopo marker with its name, else its `<type>`, else its name) is the one asked for, or, without a type change, the one it has;
- **the name holds:** the build shows the name that was typed;
- **no marker comes to be shared:** a CalTopo marker that types another `<wpt>` too is never moved, retitled or refoldered for this one, and an edit after which the waypoint would be typed by a marker that types another `<wpt>` (a rename to that marker's name, say) is refused;
- **every id holds:** the build's id matching (`assignWaypointIds`, on a copy of the registry) is run over every `<wpt>` before and after, and each must come out with the id it had, this waypoint's included.
  A pending waypoint has no id to keep, and the notes name the one the next build gives it.
  The check covers the other pending waypoints too, and runs on an add and a delete as well: an edit after which the build would hand a pending waypoint a built one's id is refused, in those words, until a rebuild has given the pending one its own.

A waypoint whose registry entry no longer matches its `<wpt>` (an entry edited by hand, or left behind by a hand edit to the sources) fails the last check whatever the edit, and the refusal says so: put the entry or the `<wpt>` right by hand, or rebuild.

These checks use the editor's own reading of the sources, not the build's code.
`scripts/lib/waypoint-editor/build-parity.test.ts` holds the two together: over every committed trail, the editor's list of `<wpt>`s (name, type, position, in order) must be the build's, and the build's id matching over it must leave the registry unchanged.
When that test fails after a change to the build, the editor's prediction is wrong for real trails: fix `resolveSourceType` or `listGpxWaypoints` before trusting an edit made here.

### Adding a waypoint

"New waypoint" (under the map) opens a form: click the map or an OSM POI to place it (drag the marker to adjust), then give it a name, a type and, optionally, a description.
A name that starts with a type prefix is flagged under the field as it is typed, and "Add waypoint" stays off until it is corrected (the server refuses it too).
Any other refusal is shown under the form, which keeps what was typed and where the marker is.
"Add waypoint" inserts a `<wpt>` after the last one in the GPX, written like its neighbours: the same indentation and line ending, one line or one child per line as the last `<wpt>` is laid out (a `<desc>` that runs over several lines does not make it one child per line), coordinates padded to six decimals where every `<wpt>`'s are (`lon="151.213190"`), and `<ele>`, `<name>`, `<desc>` and `<type>` in the order the file uses.
It gets an `<ele>` when the file's `<wpt>`s carry one ("Elevation" below).
Nothing goes in `data/waypoint-ids.json` or `descriptions.json`: the waypoint has no id until the next build mints one, so the description goes in its `<desc>`, where the build reads it as source text.
Until a rebuild it is listed as `pending rebuild` under a temporary key (`new:` and a hash of its `<wpt>`'s name and position; a colon is never in an id, so it cannot be mistaken for one);
the save's notes name the id the next build will mint.

On a CalTopo-typed trail no marker is added: the build types a `<wpt>` from a marker only when one has its name, and otherwise from its `<type>`, so the `<type>` is enough.
A marker that does have its name would win however far away it is, and the build would show that marker's description in place of the `<desc>`.
So the add is refused when a marker with the name already types another `<wpt>` (the two would share it, whatever type is asked for): give the new waypoint a name of its own.
A marker with the name that types no `<wpt>` yet becomes the new waypoint's own, provided it gives the type asked for;
when it has a description, the notes say that the build shows that and not the `<desc>`.
The add is also refused for a name that starts with a type prefix (the build strips it), a position more than 50 km from the route, a position another `<wpt>` already has (the editor tells waypoints apart by their coordinates), and anything that would stop the build or change another waypoint's id.
When the new waypoint stands where a retired waypoint of the same type and name stood, the next build hands it that id back (with its comments and description), and the notes say so.

A waypoint deleted since the last build is not retired yet: its registry entry is live until a build runs, and the build reads any `<wpt>` of its type within 100 m of such an entry as that waypoint moved or renamed, handing it the id and the comments keyed to it.
So an add of that type within 100 m is refused until a rebuild has retired the id.
The one exception is the deleted waypoint itself, added back under its name: the next build gives it its id back, and the notes say so.
Put back on its exact position, it is joined to its id at once and listed as the waypoint it was, not as pending.

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

A save is held to what an add is held to, and refused (writing nothing) for a name that starts with a type prefix, a position more than 50 km from the route or one another `<wpt>` already has, a name a CalTopo marker would type differently or already types another `<wpt>` by, a move, rename or retype after which the build would hand it the id of a waypoint deleted since the last build (rebuild first), and anything that would stop the build or change another waypoint's id.
The same stale-content check applies: the save is refused if the `<wpt>` changed on disk since the page read it.
After a move, rename or retype the notes name the id the next build will mint for it (or hand back to it) as it now stands: the id is minted from the type and position, so it changes with either.

A hand-added `<wpt>` whose name a CalTopo marker has is typed by that marker.
When the marker types only that `<wpt>`, a save treats it as for any waypoint: it moves with the `<wpt>`, is retitled with it, and changes folder for a new type.
When the marker also types another `<wpt>` (the build takes the nearest marker with the name, however far), the marker is never edited for this one: a move leaves it where it is, a rename leaves its title (under a name of its own the waypoint is typed by its `<type>`, which is added when it has none), and a retype is refused until the waypoint is renamed.
When the marker has a description, the build shows that in place of the `<desc>`, so the description box is locked until a rebuild.
In every case a move, rename or retype goes through the checks every waypoint's does ("What every move, rename and type change is checked for").

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
Until that build the entry is not retired, and the build would hand the id to a waypoint of the same type added within 100 m: the editor refuses such an add until a rebuild ("Adding a waypoint" above), and the notes say so.
Until the rebuild the waypoint stays in the list as `deleted`, locked.
That holds when another waypoint's `<wpt>` stands on the same coordinates (the CDT's towns hitched from one pass): a `<wpt>` is joined to an id only by its coordinates, name and type together, so the deleted waypoint is never shown as its neighbour.
A revisited place's later pass (`<id>_2`) cannot be deleted on its own, since it is built from the first pass's `<wpt>`: deleting the first pass deletes every pass and the place's description.
It also takes the place's name out of trail.json's `revisitedWaypoints` in the same save (the notes say so), since the build warns on every run about a name listed there that the route no longer passes twice;
the name stays listed, with a note, while another `<wpt>` still goes by it.
A delete is refused while a waypoint of the same type that is not built yet stands within 100 m: with this waypoint gone, the build would read the pending one as this one moved or renamed, and give it this id with its comments and description.
The pending waypoint has nothing of its own to lose, and the refusal says what clears it: rebuild, so that it has its own id, then delete.
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
In a browser linked to an admin account (the link from `admin-moderation.html`), the page also reads the admin listing, `GET /v1/admin/comments`, to add hidden comments and report counts.
That listing covers every trail, with no trail filter and no cursor, and one read stops at 500 rows, so it cannot be read to the end for one trail.
The page reads it both ways it can be ordered and keeps this trail's rows: `?limit=500` (every comment, newest first) and `?reported=1&limit=500` (only comments with a report or an automated-review result, those hidden by reports first).
What that reaches, the line under the comments says:

- **The newest-first read came back short of 500 rows:** it is every comment on every trail, so each comment on this trail hidden by reports or deleted by an admin is included.
- **It came back full:** every comment with a report or a review result is still included, hidden or not, but a comment an admin deleted that was never reported or reviewed is included only when it is among the newest 500 comments on all trails.
- **Both came back full:** the listing was truncated, and some reported or hidden comments on this trail may be missing, with their report counts.

A comment deleted by its author is never listed.
Without a linked browser, or with a non-admin account, the line says hidden comments are not shown and the public ones are listed.
Hidden and reported comments sit in the same newest-first list and page with it, so the "showing" line says how many of the comments not yet shown are hidden, and how many more are published but reported ("The 227 not shown include 3 hidden and 2 more reported.").
Reload (and "Try again" after a failed read) keeps keyboard focus on the control while the section is redrawn.
The section is not a live region, so a screen reader does not read every comment again: one short status line ("Showing the newest 20 of 237 comments.") is announced after a load, a Reload or "Show more".
The worker's CORS is `*`, so a localhost page may read it.
The editor never writes to the comments API: moderation stays on `admin-moderation.html`, and a comment is a lead, not a source, so a fact it gives still needs its source in `plans/waypoint-description-sources.md`.

### Reviewing

"Reviewed" (`Alt+R`) is a per-browser mark held in `localStorage`, shown as ✓ and counted in the header's progress bar.
A mark covers four things, as the sources have them: the waypoint's name, its position (to six decimals), its description and its type.
It lapses when any of them changes, so a correction pulled from git puts the waypoint back in the unreviewed pile, and so does a retype, which changes whether the waypoint counts as water or resupply.
Nothing else is covered: not its elevation, its km or the lists the build puts it in, hikers' comments, or its `access.json` entry.
A mark made before the type was covered is kept as it was made: it still lapses on a change of name, position or description, and not on a retype, until the waypoint is marked again.
A pending waypoint cannot be marked: a mark is kept under the waypoint's id, and it has none yet.
Nor can a `not built` one, which is locked until a rebuild.
Neither counts in the progress bar's total.
`Ctrl+Enter` saves, marks the waypoint reviewed and moves to the next one in the filtered list (on an unchanged waypoint it just marks and moves on), which is the fast way through a trail.
"Next" is worked out before the save or the mark is applied, from the waypoint's place in the whole list.
So it is the following row even when the action takes the waypoint out of the filter ("Not reviewed", "No curated text" once a description is saved, a type filter after a retype) or gives a pending one a new key;
`Alt`+`↓`/`↑` step the same way from a waypoint the filter no longer shows.

Edits are kept per waypoint while browsing, so you can compare neighbours before saving;
the page warns before closing or switching trail with unsaved edits.
An unsaved edit holds only the fields that were changed.
When the trail is read again ("Reload trail", a rebuild, an add or a delete, a save that touched other rows) every other field follows the files, so a later save never puts back a name, type or position that changed meanwhile.
"Discard" (or `Esc`) drops a waypoint's unsaved edits and offers "Undo" under the form, until another waypoint is selected.

The form stays usable while a save is in flight.
Text typed meanwhile is kept as a new unsaved edit on top of what was saved.
If another waypoint is selected by the time the save returns, the result still goes to the waypoint that was saved (its row, its review mark), the selection stays where it is, and the notes name the waypoint they are about.
After a save that changes other rows (another pass of a revisited place, a merged duplicate or the waypoint it merged into) the page reads the trail again, so those rows show what is on disk and the next save on them is not refused as stale.

### Keys

`Ctrl`/`⌘`+`S` save;
`Ctrl`/`⌘`+`Enter` save, mark reviewed and go to the next;
`Alt`+`↓`/`↑` next / previous;
`Alt`+`R` toggle reviewed;
`Alt`+`P` place mode;
`Esc` leave place mode, put the position back as it was when pressed in Lat, Lon or the paste box, or otherwise discard this waypoint's unsaved edits (with "Undo");
`/` search.
`Esc` is ignored while an input method is composing (a Japanese name on Shikoku), where it cancels the composition.

## What a save writes

Only the bytes it means to change: the GPX is edited in place and a JSON file is rewritten only when its layout can be reproduced exactly (the CalTopo export and trail.json are spliced value by value: some exports mix escaped and raw non-ASCII, and trail.json is laid out by Prettier).
All the writes of one save, and the answer the page gets, are computed before any write is made, so a refusal leaves nothing half-written and no error follows a write.
The files are then replaced together or not at all: each new text is written to a temporary file beside its file and renamed over it, and if one cannot be replaced, those already replaced are put back as they were.
(The temporary files are named `.<file>.<pid>-<n>.wpe-tmp` and `.wpe-bak`; one left behind by a killed dev server can be deleted.
They are in `.gitignore`, so one is never committed or listed among the changed files.)

- **Description:** the entry in `descriptions.json` (created if the trail has none);
  its `name` aid is left as it is.
- **Position:** the `<wpt>`'s `lat`/`lon` (six decimals, padded with zeros where the file's `<wpt>`s all are);
  the CalTopo marker the build takes the waypoint's type from (the nearest one with the same cleaned name), unless it also types another `<wpt>`;
  and the waypoint's entry in `data/waypoint-ids.json`, so the next build matches it however far it moved and it keeps its id, comments and description.
  A `<wpt>`'s `<ele>`, when it has one, is rewritten for the new position ("Elevation" above), and left as it was when no elevation is found.
- **Name:** the `<wpt>`'s `<name>` and the CalTopo marker's title (unless the marker also types another `<wpt>`), each keeping its type prefix (`C `, `WT: `) and the whitespace around it;
  a `<type>` in the `<wpt>` when the new name alone would change the type;
  the registry entry's name;
  the `name` aid in `descriptions.json`;
  and the name in trail.json's `revisitedWaypoints`, when the place is listed there.
- **Type:** the CalTopo marker's `folderId` (and a new folder feature, first in `features`), or the `<wpt>`'s `<type>` (added when it has none, with any name prefix dropped);
  and the registry entry's `type`.
- **New waypoint:** one `<wpt>` in the GPX (with an `<ele>` when the file's `<wpt>`s carry one), and nothing else.
- **Pending waypoint** (added since the last build): its `<wpt>` alone, whatever is edited: `lat`/`lon` (and its `<ele>`, as for any move), `<name>`, `<type>` and `<desc>`;
  and the CalTopo marker with its name, when that marker types no other waypoint.
  Never the registry or `descriptions.json`: it has no id.
- **Delete:** the `<wpt>` (with the spacing before it), the CalTopo marker feature (with the comma that joined it), the `descriptions.json` entries of every pass, and the place's name in trail.json's `revisitedWaypoints` (with the separator that joined it; `[]` when it was the only one), when it is listed there and no other `<wpt>` has the name.
- **Merged duplicate:** a delete as above, or a rename (its `<wpt>`'s `<name>`, its CalTopo marker's title and its registry entry's name);
  nothing else.

A save is refused, writing nothing, if the waypoint changed on disk since the page read it: "Reload trail" reads it again and keeps the unsaved edit, which can then be saved.

### What a save leaves for you

- **`access.json`:** an `osm` or `none` entry was routed from the old position: re-run `npm run fetch:access <trail-id>`.
  A `manual` entry's junction and off-trail km need checking by hand.
  The save's notes say which.
- **Lists and km:** whether a moved or new waypoint is on the main route, off it or on a variant, and its km, come from the rebuild.
- **Revisited places:** `<id>_2`, `<id>_3` are built from the same `<wpt>` as `<id>`, so moving, renaming or retyping one moves, renames or retypes the place, and so every pass;
  the notes say so, and the page reads the trail again after such a save, so the other passes show it at once.
  The description is the place's too, edited on the first pass.

### The rebuild report

After a rebuild the Changed files drawer lists the ids the build **minted** or **retired**.
A move, rename or type change made here should produce neither;
a waypoint added here should mint exactly the id its last save named (a move, rename or retype of a pending waypoint names it afresh), and one deleted here should retire exactly its own.
That holds for a merged duplicate too: deleting one retires its id alone, and a duplicate that comes back as a row (renamed apart, freed from a chain, or left behind by a deleted survivor) keeps the id it had, so nothing is minted.
Anything else means a waypoint lost its id (and the comments keyed to it).
The editor refuses an edit that would do that, so look for a change made by hand (a type or a name prefix edited in the GPX, a registry entry that was not migrated): fix the source and rebuild before committing.
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
A page opened or reloaded while a rebuild runs (by hand, or by Vite when one of the page's own source files is edited) picks the rebuild up: the drawer opens, saves stay off, and the report is shown when it ends.
A page opened after it has ended shows the last rebuild's report in the Changed files drawer, until the dev server process ends.
It also holds across dev server processes: a running rebuild leaves a lock file in the system's temporary directory, naming the dev server and the build step, and another dev server on the same checkout refuses saves and rebuilds while either is alive.
The refusal names the file, to delete if no build is in fact running; a lock over 30 minutes old is ignored.

Nothing stops a build step when the dev server stops.
`Ctrl+C` in the terminal reaches the build as well, as it would a build run by hand: rebuild again.
If only the dev server is killed, the step that is running finishes (a half-written `data/waypoint-ids.json` would be worse), `build:mobile-trails` is not started if it had not been, and the report is lost: start the dev server and rebuild again.

## What it will not edit

- **Te Araroa** is read-only: its waypoints come from `te-araroa-data` (`npm run sync:te-araroa`) and are fixed upstream.
- A waypoint whose `<wpt>` cannot be found (deleted here, or the GPX was edited by hand since the build) is locked until a rebuild.
  A `<wpt>` is a waypoint's when it stands on the exact coordinates the build or the registry has for it, under the name the build shows and with the type it gives: the same three things the build keeps an id on.
  So a `<wpt>` renamed or retyped by hand shows as a deleted waypoint and a pending one;
  when the next build will read the pending one as the deleted one moved or renamed (the same type, within 100 m), the deleted row's lock note says so in place of "the next build retires its id", the pending row carries the id it takes, and the pending one cannot be moved, renamed or retyped until a rebuild.
- Two `<wpt>`s on one position with one name and type (twins): the editor cannot tell which is whose, lists each id locked and neither `<wpt>` as pending, and says to give them names of their own.
- A `<wpt>` that has an id in `data/waypoint-ids.json` but no row in the last build on this machine, and is in no row's merged ids.
  The build lists every `<wpt>` (main route, off-trail, a variant's waypoints, which include a terminus's endpoint, or the ids merged into another), so this is the registry ahead of the generated data: the registry is committed, the generated data is built on each machine, and a pull that brings a new waypoint needs a rebuild.
  It is listed under its id, badged `not built` and locked, until then.
- A GPX the build cannot read (a `<wpt>` with no usable `lat` or `lon`): the editor reads `<wpt>`s as the build's parser does and refuses the trail, naming the file and the `<wpt>`.
  The page shows that in the banner in place of the trail;
  fix the GPX by hand and press "Reload trail".
  A `<wpt>` inside an XML comment is not a waypoint, here as in the build.
- A CalTopo marker that also types another waypoint: a move or a rename leaves it as it is, and a retype is refused until the waypoint is renamed.
- The description of a revisited place's later pass (`<id>_2`): it is the place's, edited on the first pass.
  A `descriptions.json` entry under a later pass's id, which the build never applies, is pointed out on that row.
- The description of a pending waypoint whose CalTopo marker has one, until a rebuild gives it an id.
- The position, type and description of a `<wpt>` the build merged into a near-duplicate (`dedupeWaypoints`): it can be deleted, or renamed apart ("Merged near-duplicates").
- A merged duplicate whose id has no registry entry: nothing says which `<wpt>` it is, so it is not listed (its `<wpt>` shows as pending).
- A type no CalTopo folder title means, on a waypoint a CalTopo marker types (see "Changing a type").

## Descriptions on the phone

The phone shows bundled descriptions from the app's trail data and synced ones from the comments API (`synced ?? bundled`).
Merging a change to `descriptions.json` runs the *Upload descriptions* workflow (`docs/deploys.md`), which uploads the file once approved.
The upload visits only the trails that have a `descriptions.json`.
On a trail without one (the CDT, Great Ocean Walk, Great South West Walk, Shikoku, Te Araroa and Three Passes) no upload changes or withdraws a synced row.
The phone looks a waypoint's synced text up by the waypoint's own id, and the upload sends each entry to the id the file names.
A description belongs to the place, so a revisited place has one synced row, under its first pass's id, and a later pass (`<id>_2`) has none of its own.
The phone shows a later pass the first pass's synced text, so an upload or a live edit reaches every pass (`resolveSyncedDescription` in `src/lib/waypoint-passes.ts`, applied by `getDescription` in `mobile/src/db/waypoint-meta-repo.ts`, the app's one reader of synced text).
The order is the pass's own row, then the first pass's row, then the bundled text.
A cleared row holds no text wherever it sits, so it never hides the next one: a later pass whose own row is cleared or withdrawn follows the first pass, and a cleared first pass leaves the bundled text.
Nothing writes a later pass's row any more (below), so the first case is a row left from before.
An app build from before this rule looks each pass up by its own id only: until a phone updates the app, its later passes show their bundled text, which is the first pass's entry as the build applied it.

## Live edits on the deployed site

For a correction that cannot wait for a merge (a closed water tank, a wrong fact), `https://tracknotes.info/admin-descriptions.html` edits the synced description directly, from any browser.
It is unlinked and noindex, and it is the only description tool on the deployed site; this local editor stays the way descriptions are authored.

- **Access:** reading needs nothing; editing needs the browser linked (with a link code from the app) to an admin account, the same as the moderation pages.
  When the account check itself fails (the API is unreachable or answers an error), the page says it could not check and offers **Retry the account check**: it stays read-only until the check succeeds, and never reports that as "not an admin".
- **Read-only until the comments API is deployed:** the site deploys when a change merges, and the comments API by its own workflow (*Deploy comments API*, `docs/deploys.md`), so the page can be ahead of the API.
  An API from before this page ignores what makes a live edit safe: it does not record that a text was a live edit (the row would later count as an upload, be left out of the export, and be replaced by the next upload with no `!`), and it does not refuse a save over a text that changed since it was read.
  So the API says in every descriptions read whether it does both, and until it says so the page offers no **Edit** or **Clear**, sends nothing, and shows why above the list: "Read-only: the comments API has not been deployed with description provenance yet".
  That holds for an admin too, and on a trail with no synced text, where there is no row to tell the API's version by.
  The page never tests the API by writing to it; once *Deploy comments API* has succeeded, **Reload** offers the buttons.
- **The list:** pick a trail, and each waypoint shows its bundled description beside its synced one (with its date and whether a live edit or an upload wrote it), a yellow box where they differ, and a state: *in sync*, *drift*, *awaiting upload*, *cleared*, *not uploaded* (in the file, not yet on the API) or *bundled only*.
  The filters narrow to drift, to rows awaiting an upload, to synced rows, to synced text that differs from the bundle, to the file's entries, or to waypoints with no description at all.
- **Edit synced text** sends the new text to every phone on its next sync, with the same character limit and voice hints as here.
- **Clear synced text** sends an empty description (a tombstone): phones fall back to the bundled text, so a clear can undo a live edit but cannot hide a curated text; to correct one, edit it.
- **A revisited place** (badged *later pass* on its later passes; eight rows, all on Three Passes): the description is the place's, so it is edited on the first pass's row, and that text reaches every pass.
  A later pass's row shows the first pass's synced text, as phones show it there, under a heading that names the first pass, and its state reads *follows first pass*.
  It has no **Edit synced text**: **Edit on the first pass** opens the first pass's edit box, listing the first pass if a filter had hidden it.
  The page saves nothing under a later pass's id: that text could not be committed, the next upload of a trail with a `descriptions.json` would withdraw it, and on phones it would hide the place's text on that pass.
  A later pass that holds text under its own id from before shows it as *drift*, with **Clear this pass's own text**, after which the pass follows the first pass again.
  The confirmation before a save on a first pass says, once, that a phone on an app build from before passes followed the first pass shows the new text on the first pass only, until it updates the app.
- **Two admins at once:** a save or a clear carries the version of the row the page was showing, and the API refuses it when someone else has changed the row since.
  Nothing is written; the page shows the text now on the server above the draft, which is kept, and saving again replaces their text knowingly.
- **While typing:** saving one row redraws that row only, and the refresh that follows leaves every open edit box as it is.
  A save still in flight when another trail is picked is not drawn into that trail's list; a line above the list says how it ended.

### The drift rule: edit live for urgency, then commit to descriptions.json

`descriptions.json` is the source of truth.
The *Upload descriptions* workflow runs on any merged change to any trail's `descriptions.json`, and for every trail that has that file it makes the API match it: a synced text the file does not have is replaced with the file's text, or withdrawn if the file has no entry.
So on a trail with a `descriptions.json`, a live edit that never reaches the file is lost at the next upload, whichever trail's file that merge changed.
On a trail with no `descriptions.json` no upload touches a live edit: it stays on phones until someone changes or clears it on the page, and it exists only on the API until it is committed.

Every synced row records which tool last changed its text: `live` (this page) or `upload` (the workflow).
It records the tool, never the person.
A row from before that marker existed counts as uploaded, since this page did not exist then.
The page knows the file as the site was last deployed, and classes a synced row that differs from it by that marker:

- **drift**: a live edit the file does not match, or a live clear of a waypoint the file lists (*drift: cleared live*).
  The next upload of that trail replaces the live edit with the file's text (or withdraws it), and re-sends the file's text over the clear, once its plan has shown it (below).
  Drift is counted in the banner over the list.
- **awaiting upload**: a row an upload wrote that the file has since moved past, because a change to `descriptions.json` (or a deleted entry) has merged and its *Upload descriptions* run has not been approved or run yet.
  The site redeploys within minutes of a merge while the upload waits for approval, so this is the ordinary state between the two.
  It is not drift: there is nothing to commit, and the export never writes the API's older text back over the file or puts a deleted entry back.
- **origin unknown**: shown only while the page talks to a comments API that does not report the marker (the worker deploy that adds it has not run).
  The page then cannot tell the two cases apart, so it counts the row as neither and leaves it out of the export.
  It is read-only in that window ("Access" above), so no live edit can be made that would later be taken for an upload.

To commit the drift:

1. On the page, **Download updated descriptions.json** (the trail's file with each live edit written in: an existing entry in place, a new one in route order, every other entry exactly as the file has it) or **Copy the changed entries**.
   On a trail with no file the button reads **Download a new descriptions.json** and starts one.
2. Put it at the path the banner names (`data/trails/<dir>/descriptions.json`), check the `git diff` shows only those entries, and check every fact has its source in `plans/waypoint-description-sources.md`.
3. Rebuild (`npm run build:trails && npm run build:mobile-trails`), and commit the file with the rebuilt data as for any description change.

Once that merges, the upload re-sends the committed text to mark the row as uploaded, and the page shows the row as *in sync* after the site redeploys.
The text and its timestamp do not change, so no phone downloads it again, and the next change to that entry is an ordinary edit.
A live edit committed in other words stays *drift*, and stays marked in the upload's plan, until that upload has run and the file's wording has replaced it.
The upload's dry run lists every synced text it would replace.
Text an earlier upload sent is listed plainly (`replaces uploaded text`): that is every routine edit, and raises no warning.
A live edit the file does not match is marked `!` (`! replaces a live edit`, `! undoes a live clear`) and the run ends with a warning, so the approver sees drift that was missed before approving (`docs/deploys.md`).
The upload then undoes exactly the live edits that plan marked, and no other.
A live edit made or changed after the plan was read (while the run waited for approval, or in the seconds before a write) is not replaced: its row is left as it is, the rest of the upload goes ahead, and the run fails with an error naming the waypoint.
Nothing is lost by that: commit the edit and merge, or re-run the workflow (*Re-run all jobs*) so that its new plan shows the edit, and approve it to send the file's text.
So an urgent live edit is safe from an upload that is already waiting, but not from the next one that is planned after it: it still has to reach the file.
Against a comments API that does not say it records where a text came from, the upload cannot tell a live edit from uploaded text or protect a row that changes under it: its plan says so in a warning, and the upload itself then sends nothing and fails, until *Deploy comments API* has succeeded and the workflow is run again.

What the export leaves out:

- **A live clear.**
  A clear never hides a curated text, and the next upload re-sends the file's entry.
  To remove a description for good, delete its entry from the file.
- **A later pass of a revisited place** (`<id>_2`, badged *later pass*; eight rows, all on Three Passes).
  The build applies `descriptions.json` before it mints the suffix, so the file is keyed by the first pass's id, every pass is bundled with that entry's text, and an entry for `<id>_2` matches no waypoint.
  The page saves nothing under a later pass's id, and text one holds from before is left out: clear it there, and make the lasting fix on the first pass's id.
  The page does not copy a first-pass edit to the later passes' rows either: phones read the first pass's row for every pass, and on a trail with a `descriptions.json` the next upload would withdraw rows the file cannot list.
- **Te Araroa.**
  Its waypoints and their descriptions are built upstream in the `te-araroa-data` package (`npm run sync:te-araroa`) and are not curated in this repository, so it has no `descriptions.json` and the page offers none to download.
  A live edit there works, and no upload touches it: make the lasting fix upstream, and clear the synced text once a build carries it.
- **A row on an id the trail no longer has**, which no waypoint shows.

## Safety

The API writes the repository, so it checks every request itself, reads included, before doing anything else (`requestRefusal` in `scripts/lib/waypoint-editor/vite-plugin.ts`), and answers 403 unless:

- **It comes from this machine:** the connection is from a loopback address.
- **Its `Host` is a loopback name:** `localhost`, a `*.localhost` name, a `127.0.0.0/8` address or `[::1]`, with or without a port.
  This is what stops DNS rebinding: a page on another site whose name is re-pointed at 127.0.0.1 reaches the dev server from loopback and same-origin, so with any header it likes and no CORS preflight, but the `Host` it sends is still its own name.
  The API does not rely on Vite's own host check.
  Under Vite 6 a plugin's middleware runs before it;
  Vite 8 runs it first, and then refuses such a request itself (403, in Vite's words), but `server.allowedHosts: true` turns it off, and the API still refuses.
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

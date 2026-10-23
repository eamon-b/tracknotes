# Waypoint description sources

This note records where the facts in each trail's `data/trails/<dir>/descriptions.json` came from (issue #30). Every statement in those files should trace to a source listed here. Where sources disagreed, the note says which one was followed. Retrieved 2026-10-19 and re-checked the same day against the review on #192. When another trail gets a file, add a section for it, and when a trail's text changes, update its section.

The trails authored before this note (Cape to Cape, AAWT, Bibbulmun, Hume & Hovell, Larapinta) have no source list.

## Rules applied

- **Permanent place only.** A bundled description describes the place as it normally is, with its facilities as normally provided. It says nothing about temporary closures, removals or works. Temporary status belongs in server-synced notes, posted through the comments API's description sync. Where a facility's normal state is unclear, the description leaves it out.
- **Facts, not advice.** Agency advice is turned into the fact behind it. For example, "boiling … is recommended" becomes "the tank water is untreated", and "should not be relied on" becomes "there is no reliable natural water". The agency's own wording stays here in the sources file.
- **Primary or authoritative sources only.** A primary source here is the land manager's page, or a government tourism body's full page. The track's own long-standing notes site counts as authoritative. A claim that could not be checked against one of these was removed. Blogs, tour operators and search-result snippets do not count.
- **Own wording.** The descriptions paraphrase their sources. The phrases flagged in review, and every other close echo found in a pass over all 29 descriptions, were rewritten.

## Current temporary closures (for server-side updates, not bundled text)

The owner should post these as synced notes, and remove them when they lift:

- **Jenolan Caves** (Six Foot Track `w_9853df4e`): NSW National Parks [local alerts](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/six-foot-track/local-alerts), reviewed 19 Oct 2026, say the Jenolan Karst Conservation Reserve, "including the Visitor Precinct and walking tracks", is closed until 31 December 2026, with "no access to the Reserve or Jenolan Caves via the Six Foot Track". The track is closed at the reserve boundary. NSW National Parks currently gives Binda Bush cabins as the track's end. Visit NSW says the closure followed flood damage and landslips.
- **George Point** (Thorsborne `w_fc1b14f4`): a Queensland Parks park alert, seen only as a search-result snippet, says the George Point toilet was removed because of erosion, until 30 June 2027. It is unverified because the page could not be read (see below). Check it before posting.
- **Three Capes annual maintenance closure:** PWS Tasmania's [Cape Pillar](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/tasman-cape-pillar) page lists the next closure as 5–18 April 2027. It covers the Three Capes Track, Bare Knoll campground and the Old Cape Pillar Track; the Cape Hauy Track is not closed in 2026.

## Three Capes Track (`three_capes`)

All six PWS Tasmania pages below were read in full with curl on 2026-10-19.

- Parks and Wildlife Service Tasmania (PWS), [Three Capes Track walk notes](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/three-capes-track/walk-notes). Gives:
  - the boat from Port Arthur, taking up to 75 minutes
  - Denmans Cove: the creek, the shifting sandbanks, and water knee-high at times from September to December
  - day 1: 4 km through eucalypt woodland and coastal heath to Surveyors, whose deck looks to Cape Raoul
  - day 2: Arthur's Peak over Crescent Bay to Cape Raoul, then down the forested slopes of Crescent Mountain and across the broad, windswept Ellarwey Valley to Munro, which looks over Munro Bight and Cape Hauy
  - day 3: The Blade at Cape Pillar looking to Tasman Island, as an out-and-back from Munro with packs left at the cabin, then through forest and heathland to Retakunna, which looks to Mount Fortescue
  - day 4: Mount Fortescue, then Cape Hauy's dolerite columns and the Totem Pole with rock climbers, then mostly downhill to Fortescue Bay
  - the 30-minute bus back to Port Arthur
- PWS, [Three Capes Track FAQ](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/three-capes-track/frequently-asked-questions). Gives:
  - cabins that sleep 48, with gas cooktops, a heated social hub and toilets
  - two outdoor showers, at Munro only
  - "Rainwater is available from tanks at each cabin … treat the water before using it", hence "untreated"
  - reception at Surveyors and Retakunna, and limited reception at Munro
  - the nights: Surveyors Cove first, Munro second, Retakunna Creek third
- PWS, [Fortescue Bay camping](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/fortescue-bay-camping). Gives:
  - the Banksia and Mill Creek campgrounds
  - "Tank water is provided at both campgrounds, however boiling for 3 minutes or sterilising is recommended", hence "untreated"
  - token-operated showers at Banksia, and Banksia's "towering stringybarks"
  - Mill Creek's larger sites, with generators off by 9 pm
  - ice and basic camping equipment at the site office, and Nubeena 45 minutes' drive away
  - bookings required from 1 October to 30 April
- PWS, [Cape Pillar](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/tasman-cape-pillar). Gives:
  - Bare Knoll: about 1 km from the Old Cape Pillar / Three Capes crossroads, 12 tent platforms and a toilet, and "natural water sources should not be relied on"
  - registration at the Fortescue Bay site office
  - "Cabin accommodation facilities are only available to these walkers"
  - Mount Fortescue's wet forests
- PWS, [Cape Hauy](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/cape-hauy): dolerite columns that plunge into the sea.
- OSM and Copernicus, through the committed GPX: the summit heights (Arthurs Peak about 300 m, Mount Fortescue about 490 m) and the Munro "Drinking water" node.

**Removed in review:**
- **Pillars of the south**, **Monument Lookout** and **Seal spa** have no entry. No PWS page names them. The earlier text came from a walking-club page, a walker's blog, a tour operator, and an inference from the waypoint's position.
- The **Candlestick** came from a tour operator page and was dropped.
- **The Blade**'s "formed steps" and its view to Cape Hauy and Cape Raoul came from a blog and were dropped.

## Thorsborne Trail (`thorsborne`)

**What could not be read.** Every Queensland Parks page and PDF answered 403 (a Cloudflare challenge) to both curl, with a browser User-Agent, and WebFetch on 2026-10-19:
- parks.qld.gov.au: the `walking`, `camping/thorsborne-trail`, `visiting-safely` and `journeys/thorsborne-trail` pages
- parks.des.qld.gov.au: the Thorsborne map PDF and the Hinchinbrook discovery guide PDF

The Wayback Machine has a snapshot of the walking page (2025-11-22), but web.archive.org could not be reached from this environment: the proxy reset the connection. archive.ph rate-limited the request.

**What was read.** The only full government text available was Tourism and Events Queensland, [Thorsborne Trail: how to hike Hinchinbrook Island](https://www.queensland.com/au/en/things-to-do/adventure/walking-hiking-adventure-queensland/how-to-hike-the-thorsborne-trail-on-hinchinbrook-island). TEQ is a Queensland Government statutory body. The page was read in full through its `.model.json` content feed. It gives:
- 32 km, Ramsay Bay to George Point
- seven camping areas, "all remote bush camping with no or limited facilities"
- water 100–200 m upstream of the creeks at either end of Nina Bay, "or the lagoon at Blacksand Beach"
- Nina Bay's white sand, then a rock-hop around the headland to Little Ramsay Bay, camped on the southern side of the lagoon
- day 2: water at Zoe Creek, 600 m upstream from the campsites, and Banksia Creek, 100 m upstream from the beach; Banksia Bay as the quieter option
- Zoe Falls half a kilometre from camp, with a rock pool at the top overlooking the coastline
- South Zoe Creek and a spur up to a granite rock-pavement saddle at 260 m, the highest point, with the Palm Islands and Magnetic Island visible
- Mulligan Falls: one night maximum, the area beyond the falls restricted, and "the last reliable source on the trail … nothing dependable between here and the finish"
- 5 km of beach along Mulligan Bay to George Point
- ferries from Lucinda (Dungeness) at the southern end

Every Thorsborne statement now rests on that page.

**Removed in review.** Each of these came only from search-result snippets of the Queensland Parks pages:
- composting toilets, platforms and pack poles at Nina Bay, Little Ramsay Bay, Zoe Bay and Mulligan Falls
- "about 4 km in" at Nina Bay
- Banksia Bay's "no facilities, no toilet"
- Zoe Bay's separate boat-based and day-use areas
- Fan Palm and Cypress Pine creeks as the most reliable water
- Zoe Falls "15 minutes from the day-use area"
- deaths and injuries at Mulligan Falls
- Moth Creek as the only water south of Mulligan Falls: TEQ lists Sunken Reef Bay as a water source on the leg before Mulligan Falls, and says nothing about Moth Creek
- George Point's "no facilities"

**Little Ramsay Bay** quotes TEQ's water sources for that leg, the Nina Bay creeks and the Blacksand Beach lagoon. It no longer claims a creek upstream of the Little Ramsay lagoon.

**Still to do:** once a Queensland Parks page can be read, re-add the facilities and confirm George Point's normal facilities.

## Six Foot Track (`six_foot_track`)

All pages below were read in full with curl or WebFetch on 2026-10-19.

- NSW National Parks, [Six Foot track](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/six-foot-track) and [visitor info](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/six-foot-track/visitor-info). Give:
  - the 1884 heritage horse track
  - the start near the Explorers Tree, from Pulpit Hill Road, about 2.2 km west of the Katoomba turn-off
  - parking at the Explorers Tree
  - toilets at Old Ford Reserve, Cox's River and Black Range, and none at Alum Creek
- Visit NSW, [Six Foot Track](https://www.visitnsw.com/destinations/blue-mountains/katoomba-area/six-foot-track). Gives the track "built as wide as a horse-drawn vehicle – in other words, six foot", and a cave system "dating back at least 340 million years".
- sixfoottrack.com, [Track notes](https://www.sixfoottrack.com/track-notes/), the site NSW National Parks links as the track's website. Gives:
  - the Explorers Tree "on the side of Pulpit Hill … caged in 1884 in an attempt to preserve the engravings", engravings no longer visible, and authenticity debated
  - the information shelter 260 m from the Explorers Tree
  - Norths Lookout and the Nellies Glen steps
  - Old Ford Reserve: north of the Megalong Rd bridge, about 500 m from the track crossing, wheelchair-accessible toilet, and loud campers at times
  - the Coxs River campsite: tank or river water ("treat before drinking either"), toilet, sheltered picnic table, fuel stoves only
  - the ford over "slippery rounded stones", which "becomes impassable when in flood", with the swing bridge upstream
  - Alum Creek: no facilities, a well-protected valley, Little River down the road
  - the Black Range campsite and its tank
  - the narrow ridge above Blue Lake
  - Caves House (1898), its restaurants, accommodation and shop
- sixfoottrack.com, [Alum Creek to Black Range](https://www.sixfoottrack.com/article/8189/). Gives:
  - Alum Creek as the "least used campsite"
  - Little River forded 750 m on
  - water normally at Alum Creek and Little River "except during prolonged dry periods", and "no other water sources until the tank at Black Range Campsite"
  - Black Range's covered picnic table

  Note: this page says Alum Creek has a pit toilet. NSW National Parks and the track notes say it has none, and the description follows NSW National Parks.
- Crown Lands (NSW), [New Bowtells swing bridge completed](https://crownland.nsw.gov.au/news/new-bowtells-swing-bridge-completed), 13 September 2024. Gives:
  - the original 1992 suspension bridge, built by the Royal Australian Army Engineers, closed in March 2023 and rebuilt
  - the 100 m span
  - the rebuilt bridge now takes up to five walkers at once
- Blue Mountains Gazette, [Explorers tree removed at Katoomba following safety fears](https://www.bluemountainsgazette.com.au/story/7133208/explorers-tree-removed-at-katoomba-following-safety-fears/), 22 February 2021. Gives the removal by Transport for NSW over fears it would come down in forecast rain, with the remnants taken to a depot in Lawson.
- Wildwalks, [Farnell Road to Nellies Glen Lookout](https://wildwalks.com.au/bushwalking-and-hiking-in-nsw/blue-mountains-katoomba/farnell-road-to-nellies-glen-lookout-return.html), and bushwalkingnsw.com: Therabulat Lookout's view of the Megalong Valley, and its other spelling.
- Katoomba's services are kept from the waypoint's earlier hand-reviewed text.

**Changed in review:**
- **Pulpit Hill** said the Explorers Tree still "stands". It was removed in 2021, and the description now says so.
- **Katoomba** and the **information shelter** refer to the Explorers Tree *site*.
- **Coxs River** gave the 1992 bridge as current and called the ford "normally shin-deep". It now names the bridge as the crossing, rebuilt in 2024, and the ford as slippery and impassable in flood. The track notes' "normally only shin deep" was dropped, because it made fording sound routine. No primary source was found for how fast the river rises, so the description does not say.
- **Alum Creek's** dry stretch now starts from Little River.

No entry: **Mount George**, which no source describes beyond a signpost.

## The Coast Track, Royal National Park (`royal_coast_track`)

All NSW National Parks pages below were read in full with curl on 2026-10-23.

- NSW National Parks, [The Coast Track](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/the-coast-track). Gives:
  - 27 km between Bundeena and Otford, over two days
  - overnight stays only at Garie Beach campground, booked in advance; a raised timber platform per site, with shared amenities (untreated water, cold beach showers, flush toilets) at the Garie Beach picnic area
  - the toilet and water refill at the track head on Beachcomber Avenue, Bundeena
  - the pastel-coloured heritage shacks at North Era
  - the Ridge Trail to Otford station, with trains to Sydney or Wollongong
- NSW National Parks, [The Coast Track visitor info](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/the-coast-track/visitor-info). Gives:
  - the start at Beachcomber Avenue, with parking there and at Otford lookout on Lady Wakehurst Drive
  - the train to Cronulla and the ferry to Bundeena, 1.5 km from the start of the track
  - Otford station on Georges Road
  - "Drinking water is not available along this walking track", and unpotable water at Wattamolla and Garie Beach
- NSW National Parks, [North Era Beach](https://www.nationalparks.nsw.gov.au/camping-and-accommodation/campgrounds/north-era-campground). Gives: "North Era campground closed in 2023", decommissioned for its remote location, emergency access and servicing, and its damp south-east-facing site; overnight walks now stay at Garie Beach.
- NSW National Parks, [Werrong Beach track](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/werrong-beach-track): the track starts at Otford lookout, with coastal views up and down the coast.
- Bundeena's supermarket, post office and cafes, and Otford's trains, are kept from the waypoints' earlier hand-reviewed text.

**North Era is a permanent closure, not a temporary one**, so it is in the bundled text. The waypoint is still typed `campsite` in the GPX and Garie Beach campground has no waypoint: both are data fixes for the GPX, outside this change.

No entry: **Werrong Lookout** (no NSW National Parks page describes it).

## Kep Track (`kep_track`)

Read 2026-10-23.

- Trails WA, [Kep Track, Mundaring to Northam](https://trailswa.com.au/trails/trail/kep-track). Gives:
  - 75 km on the historic rail formation between Mundaring in the Perth Hills and Northam
  - the track's alignment with C. Y. O'Connor's pipeline
  - the trailheads: Mundaring Weir, opposite the hotel, and the northern side of the Poole St Bridge on the west side of Northam
  - the Mundaring Visitor Centre on the Great Eastern Highway
- Wikipedia, [Kep Track](https://en.wikipedia.org/wiki/Kep_Track): the former Eastern Railway route from Mundaring to Clackline, then the Goldfields Water Supply Scheme pipeline route to Northam. (Secondary, but consistent with Trails WA.)
- Mundaring's, Clackline's and Northam's services are kept from the waypoints' earlier hand-reviewed text.

No entry: the three **Drinking water** points (Overpass did not answer, so the taps could not be checked against OSM), **Mount Helena** (nothing sourced beyond the town being on the route), **Bakers Hill** (its hand-reviewed text stands), **Summer Creek Farm Camping** (a private farm campground known only from booking-site listings) and **Northam RV 48hr Stay** (its hand-reviewed text stands).

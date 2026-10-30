# Waypoint description sources

This note records where the facts in each trail's `data/trails/<dir>/descriptions.json` came from (issue #30). Every statement in those files should trace to a source listed here. Where sources disagreed, the note says which one was followed. Retrieved 2026-10-19 and re-checked the same day against the review on #192. When another trail gets a file, add a section for it, and when a trail's text changes, update its section.

The trails authored before this note (Cape to Cape, AAWT, Bibbulmun, Hume & Hovell, Larapinta) have no source list.

## Rules applied

- **Permanent place only.** A bundled description describes the place as it normally is, with its facilities as normally provided. Where a facility's normal state is unclear, the description leaves it out. A temporary closure goes in the bundled text only as a dated sentence ("As of October 2026, …") so it can be found and removed later: there is no separate synced-only channel, because `upload:descriptions` pushes the same file (owner's decision on #217). The dated sentences are listed under [Temporary closures in the descriptions](#temporary-closures-in-the-descriptions) below, except the Heysen ones, which are listed under that trail.
- **Facts, not advice.** Agency advice is turned into the fact behind it. For example, "boiling … is recommended" becomes "the tank water is untreated", and "should not be relied on" becomes "there is no reliable natural water". The agency's own wording stays here in the sources file.
- **Primary or authoritative sources only.** A primary source here is the land manager's page, or a government tourism body's full page. The track's own long-standing notes site counts as authoritative. A claim that could not be checked against one of these was removed. Blogs, tour operators and search-result snippets do not count.
- **Own wording.** The descriptions paraphrase their sources. The phrases flagged in review, and every other close echo found in a pass over all 29 descriptions, were rewritten.

## Temporary closures in the descriptions

Every dated sentence in the bundled text, across all trails, is tracked on #219 for review each quarter and before each fire season; find them with `grep -rn "As of " data/trails/*/descriptions.json`. Each was re-checked against its source on 2026-10-30. The Heysen ones are listed under that trail. The other three, added on #219:

- **Jenolan Caves** (Six Foot Track `w_9853df4e`): NSW National Parks' Six Foot Track [local alerts](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/six-foot-track/local-alerts), read through the alerts feed the page loads (`api-prd.nswparks.cloud/api/v1/AlertsClosures/alerts/…`). The "Closure due to construction works" alert (published 9 Oct 2026, to be reviewed 18 Jan 2027) says the Jenolan Karst Conservation Reserve, "including the visitor precinct and walking tracks", is closed until 31 December 2026 for "major infrastructure repairs and upgrades", with "no access to the Reserve or Jenolan Caves via the Six Foot Track". The Blue Mountains "Closure due to damaged areas" alert adds that the Six Foot Track is closed at the reserve boundary. NSW National Parks still gives Binda Bush cabins as the track's end; the descriptions do not mention it. (On 2026-10-19 Visit NSW gave flood damage and landslips as the cause; the description follows NSW National Parks.)
- **George Point** (Thorsborne `w_fc1b14f4`): Queensland Parks [park alert 22907](https://parks.qld.gov.au/park-alerts/22907), "George Point toilet and sign removed due to erosion", read in full with curl on 2026-10-30. It runs from 17 September 2024 to 30 June 2027 (updated 30 June 2026) and gives: severe erosion from high tides over several years; the camping-area signs and infrastructure, toilet included, removed; no sign marking the pickup point; bush camping under a stand of trees about 2.6 km south of the Mulligan Creek crossing, with no toilet or pack rack; the pickup point 250 m south-west of it along the beach; QPWS reviewing the site's future under the Thorsborne Trail Enhancement project. The description says Queensland Parks removed the toilet and signs because of erosion, gives the alert's 30 June 2027 end date, and places the bush camping 250 m short of the unmarked pickup point. The alert page answered, but the Queensland Parks trail pages listed under the Thorsborne section still answered 403 on 2026-10-30, so the trail's normal facilities remain unconfirmed.
- **Three Capes annual maintenance closure:** PWS Tasmania's [Cape Pillar](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/tasman-cape-pillar) page says the track closes every year for maintenance and fuel-reduction burns, for 14 days, and lists 5–18 April 2027 next (then 24 April – 7 May 2028 and 9–22 April 2029). The closure covers the Three Capes Track, Bare Knoll campground and the Old Cape Pillar Track; the Cape Hauy Track was not affected in 2026. The sentence is on **Denmans Cove** (`w_b4f525ef`) and **Bare Knoll Campground** (`w_e2522cc4`); move it to the next year's dates once the April 2027 closure is over.

## Three Capes Track (`three_capes`)

All six PWS Tasmania pages below were read in full with curl on 2026-10-19.

- Parks and Wildlife Service Tasmania (PWS), [Three Capes Track walk notes](https://parks.tas.gov.au/explore-our-parks/tasman-national-park/three-capes-track/walk-notes). Gives:
  - the boat from Port Arthur, taking up to 75 minutes
  - Denmans Cove: the creek, the shifting sandbanks, and water knee-high at times from September to December (its dated annual-closure sentence comes from the Cape Pillar page below)
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
  - the annual maintenance closure, next 5–18 April 2027, which shuts Bare Knoll too: the dated sentence on Denmans Cove and Bare Knoll (see [Temporary closures in the descriptions](#temporary-closures-in-the-descriptions))
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

**What could not be read.** Every Queensland Parks page and PDF below answered 403 (a Cloudflare challenge) to both curl, with a browser User-Agent, and WebFetch on 2026-10-19, and the parks.qld.gov.au trail pages still did on 2026-10-30. The one exception is park alert 22907, read in full on 2026-10-30, which confirmed the George Point closure (see [Temporary closures in the descriptions](#temporary-closures-in-the-descriptions)):
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

**Still to do:** once the Queensland Parks trail pages can be read, re-add the facilities and confirm George Point's normal facilities (the alert covers only the temporary removal).

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

**North Era and Garie Beach (2026-10-23, on #217).** The North Era Beach Campground waypoint (`w_fcacbef4`, now retired) was removed from the GPX, since NSW National Parks decommissioned the campground in 2023. A `Garie Beach campground` waypoint (`w_abef035e`, type `campsite`) was added. NSW National Parks publishes no position for the platforms, and OSM has no campground there, so the waypoint sits at the NPWS schema.org position of the [Garie Beach picnic area](https://www.nationalparks.nsw.gov.au/things-to-do/picnic-areas/garie-beach-picnic-area) (-34.170209, 151.066642), where the campers' amenities are; its elevation is the nearest track point's (8.0 m, 18 m away). Its description rests on the Coast Track page: the 17 km first day from Bundeena, advance booking with limited capacity, a raised timber platform per site for two small one-person tents or one two-person tent, and untreated water, cold beach showers and flush toilets at the picnic area. The exact platform position is still to confirm.

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

## Heysen Trail (`heysen`)

The main source is the Friends of the Heysen Trail (FOHT) page for each place, the "More info" link already in the GPX text, which every description keeps. Visitor comments on those pages were not used. Private accommodation businesses (B&Bs, cottages, hotels, motels) have no entry and keep their GPX text.

### Cape Jervis to Burra and off-trail places south of Burra

Every description ends with the waypoint's existing `More info:` link to its Friends of the Heysen Trail (FOHT) page, so the curated text keeps the link it overrides. Private accommodation businesses (B&Bs, cottages, hotels, motels: type `accommodation`) have no entry, and keep their GPX text. All pages below were read with curl on 2026-10-23.

- **FOHT provider pages**, one per waypoint, at the `More info` URL (each redirects to `heysentrail.asn.au/walking-the-heysen-trail/prepare-to-walk-the-trail/accommodation/<slug>/`). The Facilities, Location, Notes, History, Bookings and Fees fields were used. Visitor comments were ignored, and so were phone numbers, prices and opening hours. These pages give:
  - **Cape Jervis trailhead and town:** a ferry town for Kangaroo Island, with the trailhead near the SeaLink terminal. The terminal is on bore water, has no outside taps the public can reach, and sells water, drinks and a limited range of snacks from vending machines. The Cape Jervis Tavern and general store have closed, and the Big 4 caravan park has a small shop. A daily public bus (Link SA) runs to Adelaide.
  - **Deep Creek NP campgrounds:** Cobbler Hill (shelter, water, fireplaces, toilet), Trig (shelter at the picnic area, water, fireplaces, toilet) and Tapanappa (water, fireplaces, toilet). Fees apply, with online booking.
  - **Wild South Coast Way hike-in sites:** Eagle Waterhole, Cliffs, Creek and Sand Dunes. Each has "10 x timber or compacted earth tent pads; shelter with seating, bench and sink with untreated rainwater; waterless toilets; rainwater tanks (non-potable)", and the supply is "monitored and topped up as necessary by the park rangers". They opened in April 2022, and must be booked and paid for in advance. Creek is in Ballaparudda Creek Recreation Park and replaced the Balquhidder campsite. Sand Dunes is in Newland Head CP.
  - **Waitpinga:** a campsite, a hut and a picnic shelter, water and a toilet. Wood and solid-fuel fires are prohibited in Newland Head CP.
  - **Kings Beach Road:** the Wild South Coast Way goes east to Victor Harbor, 5 km away, and the Heysen turns north along Kings Beach Road.
  - **Victor Harbor:** a regional centre. The trail passes within several hundred metres of Encounter Bay. The town is about 7 km from the corner of Jagger and Kings Beach roads, by the Bluff and the foreshore, and 83 km from Adelaide.
  - **Newland Hill:** a walker's bench, where camping is not permitted.
  - **Robinson Hill:** 300 m west of the junction of Keens, Handcock and Prouse roads. A shelter (seating only), a tank, a toilet and a small platform. Fuel stoves only. Closed during the CFS Fire Danger Season. Built 2011–2014. No booking or fee.
  - **Inman Valley town and campsite:** a general store. The campsite is beside the Memorial Hall, across from the store, with a tent pad near the toilet block and a tank. It is run by the hall association, with no fee.
  - **Mt Cone:** a shelter (seating only) and a tank, in a reserve above a Y junction. Built 2011–2012. Camping is not permitted.
  - **Chookarloo:** in Kuitpo Forest, with a shelter, water, fireplaces, tables, seating and a toilet. Camping from 1 April to 30 November. Fees apply, and two sites are reserved for hikers.
  - **Mylor:** the Mylor Hampton campsite (separate FOHT page) is at the corner of Hampton and Strathalbyn roads, with a water tank and no booking or fee.
  - **Woodhouse Activity Centre:** a Scout campsite at 37 Spring Gully Road, Piccadilly, with toilets, showers and water, plus a bunkhouse and chalet. Booking required, fees apply.
  - **Mt Lofty Summit:** in Cleland NP, with a cafe, toilets, town water and a visitor information centre.
  - **Norton Summit:** the Scenic Hotel as its accommodation option.
  - **Cudlee Creek North (Grandpa's):** a bush campsite with a fire pit, stone table, walker's platform, small shelter with logbook, rainwater tank and a large flat area. The area was damaged in the December 2019 Cudlee Creek bushfire and reopened in May 2021. Booked through ForestrySA, 1 April to 30 November, no fee.
  - **Scotts Shelter:** a walk-in site reserved for hikers, with a shelter and a tank. Booked through ForestrySA, 1 April to 30 November, no fee.
  - **Chalks:** a campsite with a shelter, town water, fireplaces, picnic tables and a toilet. Fees apply, with online booking.
  - **Centennial Drive:** a walk-in site for hikers with no vehicle access. Picnic tables, a pit toilet, untreated rainwater and a three-sided shelter with a fireplace. Reopened after years closed for logging. 1 April to 30 November, fees apply.
  - **Old School House:** a hut with bunks, a fireplace, water, seating, lighting and a toilet. The school operated 1909–1936. The hut is for group bookings of at least two nights and sleeps 10. Individual walkers may not camp nearby, and are referred to Centennial Drive.
  - **Greenock:** camping at Greenock Centenary Park, Martin Street, for Heysen and Mawson trail users. Basic facilities including a toilet, and town water from several taps. No open fires except in the stone barbecue. A donation box.
  - **Kapunda:** a 2019 reroute brought the trail to the Kapunda Town Square (corner of Main and Crase streets), close to bakeries, coffee shops, the camping ground and the caravan park.
  - **Kapunda Tourist Park:** on Montefiore Street, a caravan park with self-contained units. Booking required.
  - **Lights Hummocks Reserve:** Crown land about 1 km west of the corner of Black Joes and Bridge roads, Allendale North. A tank and a platform, built in November 2019. No booking or fee.
  - **Marschalls Hut:** maintained by FOHT volunteers for Heysen walkers and Mawson cyclists, on private land with no vehicle access. A hut, walker's platform, bunks, water, fireplace, table, seating and toilet. Rebuilt in 1995 in the style of the 1850s homestead, using its stones. Christian Marschall's grave is in the adjacent cemetery.
  - **Marrabel walk-in:** at the Rodeo Grounds, corner of Main Road 45 and Tarnma Road, set up in July 2021. A tank, toilet (about 50 m east), walkers' platform and picnic table. Reached by a stile by the locked gate near the Curio statue, then 100 m north across a paddock. No booking or fee.
  - **Smith Hill:** a shelter with a tank and bench, and a platform. Room for 2–3 tents. Private bushland to the north and south.
  - **Webb Gap:** a shelter with a tank and bench, and a square platform, finished in September 2012. About 100 m north of Webb Gap Road at its high point, by a marker post with a tent symbol. Not correctly located on Mapsheet 3C.
  - **Huppatz Hut:** maintained by FOHT volunteers for Heysen walkers and Mawson cyclists, on private land. Bunks, water, heating/cooking facilities, a table, seating and a toilet. The southern half was the Riverton golf course clubrooms, relocated by the landowner James Huppatz. The fireplace stones came from the paddocks.
  - **Burra Creek Gorge Reserve:** a campsite with a toilet, no booking or fee, and no water listed.
  - **Worlds End walk-in:** midway between the Burra Gorge campground and Ernedale Road. A shelter with a tank and bench, finished in September 2012.
  - **Mt Compass Caravan Park:** at 83 Heysen Boulevard, beside the trail. Cabins, powered and unpowered sites, amenities, a laundry, a camp kitchen and a kiosk with limited essentials.
  - **Rocky Creek Hut and walk-in:** up to 16 hikers, no vehicle access, and a toilet 200 m away shared with the hut. The hut sleeps 5 on two wooden platforms, with a sink, wood heater and solar lighting. "Rainwater (not suitable for drinking)". Camping from 1 April to 30 November, and a hut minimum of two nights.
  - **Cudlee Creek Tavern:** at 2121 Gorge Road, with a caravan park kiosk, caravan park, tavern and restaurant.
  - **Rocky Paddock:** in Mount Crawford Forest, with a campsite, shelter, water, fireplaces, picnic tables and a toilet. Its current closure for safety works was left out under the permanent-place rule.
  - **Rossiters Hut:** a walk-in for hikers, with bunks, water, a fireplace, table, seating and toilet. Built as a shepherd's hut in the late 19th century, rebuilt in 1998, and renovated by May 2022. Booked through ForestrySA, 1 April to 30 November, no fee.
  - **Hamilton:** "No retail facilities."
  - **Riverton:** the Riverton Hotel as its accommodation option.
- **FOHT, [Accessing water](https://heysentrail.asn.au/walking-the-heysen-trail/prepare-to-walk-the-trail/accessing-water/).** "You'll also need to treat tank water before drinking it", turned into "the tank water is untreated" on every FOHT tank. The Friends also record reported tank levels online.
- **ForestrySA, [Tinjella Hut](https://www.forestrysa.com.au/accommodation/tinjella-hut/)** (the FOHT page is gone). An exclusive-use campground on Brookman Road in Kuitpo Forest, 2.5 km south of the information centre. A two-room hut for up to 10, with an open fireplace and a toilet shared with Jack's Paddock. "Rainwater (not suitable for drinking)". Minimum two nights, 1 April to 30 November.
- **National Parks and Wildlife Service SA, [Deep Creek National Park](https://www.parks.sa.gov.au/parks/deep-creek-national-park).** The largest remaining area of natural vegetation on the Fleurieu Peninsula.
- **Visit Burra, [visitburra.com.au](https://visitburra.com.au/).** Burra's copper-mining heritage: the Australian Cornish Copper Mining Sites World Heritage bid.
- **riverton.sa.au.** Riverton as "the heart of the Gilbert Valley", with coffee shops, the Scholz Park Museum and the Rattler Trail.
- **OpenStreetMap, via the committed `data/trails/heysen/pois.json`.** Shops and services within about 1.5 km of each town point: Mylor, Bridgewater, Norton Summit (postal agency), Tanunda, Kapunda, Burra, Myponga, Mount Compass, Aldgate, Cudlee Creek (cafe), and Kersbrook. The FOHT town pages now only link a service directory that redirects to the interactive map, so OSM is the only itemised source for town services.

**No entry:**
- **FOHT page now 404 and no other source found:** The Scrub Campsite, Mylor Oval tank, Fromms Farm, Bethany Reserve, Alma's Hem Amphitheatre, Mt Compass township camp site at oval, Mt Crawford Forest Information Centre, Tanunda Caravan & Tourist Park, and Riverton Caravan Park. Their FOHT pages are gone from the site and from its `foht_campsite` REST listing, which may mean they are no longer offered.
- **Too little to say:** Hahndorf (outside the POI radius; its FOHT page only links the dead directory) and Summertown (OSM has a restaurant and a CFS station only).
- **Private accommodation businesses** (type `accommodation`): 56 in this slice.

**Uncertain:**
- **Town services come from OSM**, which can be stale. OSM still lists the Cape Jervis Tavern, which FOHT says has closed. For Cape Jervis the FOHT text was followed.
- **Cape Jervis trailhead's vending machines and lack of taps** are FOHT's "we have been advised" note, and could change.
- **Burra Creek Gorge** "no water": FOHT simply lists none, so the text says the Friends list none, not that there is none.
- **Greenock, Marrabel and Inman Valley** town descriptions are thin, because no source gives their services beyond the walkers' campsite and Inman Valley's store.
- **Mylor Oval tank:** the FOHT link is dead. The live Mylor Hampton campsite page (with a tank) is about 700 m south of the waypoint, so it may be the same place, renamed and relocated. It was left without an entry.

### North of Burra and the northern off-trail places

Covers main-route waypoints after Burra (km > 489.3, Burra Caravan Park to Parachilna Gorge) and off-trail waypoints north of Burra (latitude above -33.70). Every entry keeps the Friends of the Heysen Trail (FOHT) link from the GPX text as a closing `More info:` line. Private accommodation businesses (`accommodation` type: B&Bs, cottages, hotels, motels, station stays) have no entry and keep their GPX text. All pages read with curl or WebFetch on 2026-10-23.

**Friends of the Heysen Trail provider pages** (`heysentrail.asn.au/walking-the-heysen-trail/prepare-to-walk-the-trail/accommodation/<slug>/`, which the GPX `More info` links redirect to). Each entry's facilities, history and notes come from its own page's Facilities, Notes, History, Location and Bookings fields. Visitor comments on those pages were ignored. Combination-lock codes, phone numbers and fees were left out. Particular points:
- Wandallah Creek: shelter replaced in 2024 with the landholder's support; closed in the CFS Fire Danger Season (dates vary between October and May); the spelling Wandillah is the homestead owners'.
- Black Jack Hut: six bunks, the tank and toilet at the campsite 200 m west where the old shelter stands, the hut donated and moved here in June 2019.
- Tourilie Gorge: "no facilities and does not provide for overnight accommodation"; the rusted tank replaced (2021 update).
- Old Mt Bryan East School: built 1884, closed 1947; locked with a combination.
- Hallett Railway Station: refurbished 2018–19; no electricity; locked with a combination.
- Whistling Trig Tank: windy, exposed, near wind farms; 22.5 km from Hallett and 26 km from Spalding.
- Baderloo: 18.8 km from Spalding; called the Bundaleer Weir walk-in site before November 2024.
- Hiskeys Hut: private property, no vehicle access, the butchers and the slaughterhouse on the rise to the east.
- Beetaloo (Southern Boundary Track): tank installed October 2021 after the Beetaloo Creek site closed.
- Go-Cart Track Shelter: in Telowie Gorge Conservation Park (part of Wapma Thura – Southern Flinders Ranges NP); open to Heysen walkers although the park otherwise has no camping.
- White Park Tank: installed 6 June 2022 on private forest land whose owner suggested the reroute.
- Grays Hut / The Racecourse: facilities; Mark Gray's hut and cow yards in the early 1900s, burnt 1988, rebuilt around the ruins; fires not permitted; permits required for backpacking sites.
- Stony Creek walk-in: "Table NO water tank NO shelter … The shelter and tank are no longer there so there is no water", after the fires of 8 May 2025.
- Hawks Nest Tank: tank and bench, camping possible but windy and exposed, fenced against cattle (August 2024), Catninga 13 km north; closed in the Fire Danger Season. FOHT also names Stony Creek, 14 km south, as the closest water, but its own Stony Creek page says that tank is gone, so the description names only Catninga.
- Mount Brown Bush Camp: campsites spread over the property, site 6 closest to the trail, no tank near the trail, bookings; Flinders named Mount Brown (964 m) on 9 March 1802 after Robert Brown.
- Catninga Shed: four camp beds, wood stove, gas BBQ, camp shower, flush toilet; tank open to all hikers; joint initiative of farmer, FOHT, DEW and CFS; bookings to stay.
- Pichi Richi Park: family owned, 10 km drive from Quorn, cabins, group accommodation, unpowered sites, water, showers and toilets for Heysen hikers.
- The Dutchman Hut: facilities, the Adelaide Central Mission restoration, flush toilets in the shearing shed, no vehicle access.
- Eyre Depot: two tanks, range shadow on the western side, toilet tank monitored remotely, shelter tank by walker reports.
- Mt Arden South: the Hunken Tank and its history; the second campsite 250 m north on Arden Vale station with no water.
- Mayo Hut: restored from a ruin in 1988 as a Bicentennial project; private property.
- Red Range: no access other than the trail; the trail passes through the campsite.
- Wilpena Caravan Park: facilities list; privately run, booked through Wilpena Pound Resort (also stated by NPWS).
- Yanyanna Hut: the 1850s pug-and-pine hut ruin and the 1937 iron shelter.
- Aroona Hut: no page of its own (404); the FOHT Aroona campground page says "A tank is located nearby at Aroona Hut".
- Pigeon Bore: water pumped from a bore, slight metallic taste, no camping.
- Parachilna Gorge walk-in site, trailhead and camping: 500 m apart; the walk-in tank set up July 2013 because the vehicle-accessible trailhead tank is over-used; the gateway, seating, planting and Adnyamathanha signage opened September 2024; the trailhead is a rest area with no camping.
- Old Shed (Caroona Creek main camp), Murray Town campsite, Beautiful Valley Caravan Park (1.5 km south of town), Quorn Caravan Park, Hawker Caravan Park, Crystal Brook Caravan Park, Spalding Oval, Argadells (tank only, no camping), Warren Gorge (fees paid at the Quorn visitor centre on Railway Terrace or self-registration at the gorge).
- Town pages for Spalding, Crystal Brook, Hallett, Murray Town, Wilmington, Quorn and Parachilna give the accommodation each lists; Parachilna's says it is 14 km from the northern end with very limited services for hikers.

**FOHT [Trail distances](https://heysentrail.asn.au/walking-the-heysen-trail/prepare-to-walk-the-trail/trail-distances/)**: off-trail distances for Murray Town (2 km), Wilmington (3 km), Quorn (2 km) and Hawker (6.6 km); Georgetown to Hiskeys Hut 3.19 km.

**National Parks and Wildlife Service SA** (parks.sa.gov.au):
- [Mount Remarkable National Park](https://www.parks.sa.gov.au/parks/mount-remarkable-national-park): overnight hikes not permitted and hike-in campsites closed during the Fire Danger Season, "usually 1 November to 30 April".
- Ikara-Flinders Ranges NP campground pages: [Acraman](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park/booking/72075) (native pines, between two ranges, short walk from Bunyeroo Gorge, 4 sites, long-drop toilet, tank at the toilet block), [Youngoona](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park/booking/72082) (eastern end of Brachina Gorge Road, Oraparinna and Enorama creeks, 4 sites, "Facilities: nil"), [Aroona](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park/booking/67710) (northern-most point of the park, on Aroona Creek between two ranges, start of loop walks, 13 sites, long-drop toilet, tank at the toilet block), [Trezona](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park/booking/72081) (Brachina Gorge Road, short walk from the Ediacaran Golden Spike, 15 sites, long-drop toilet, picnic area, tank at the toilet block), [Wilcolo](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park/booking/131547) (native pine, eastern wall of the Pound, St Mary's Peak behind, for Heysen/Mawson walkers and cyclists, no vehicle access, long-drop toilet, rainwater tank, campfires never permitted). Each says "NPWS cannot guarantee consistent water quality and supply", which the descriptions carry.
  - Sources disagree on Aroona's water: FOHT says "water (spring-fed)"; NPWS says a tank at the toilet block. The description follows NPWS.
- [Ikara-Flinders Ranges NP](https://www.parks.sa.gov.au/parks/ikara-flinders-ranges-national-park): the Wilpena Pound campground's powered sites and permanent tents are privately run and booked through Wilpena Pound Resort.

**Department for Environment and Water**, [Your guide to camping at Ippinitchie Campground](https://environment.sa.gov.au/goodliving/posts/2023/06/your-guide-to-camping-at-ippinitchie-campground) (2023): edge of the former Wirrabara Forest, ten campsites along Ippinitchie Creek, water tank and drop toilet, a fire pit at each site. (FOHT's own Ippinitchie page is gone.)

**South Australian Tourism Commission**, [Burra Caravan and Camping Park](https://southaustralia.com/products/clare-valley/accommodation/burra-caravan-and-camping-park): on Burra Creek, a two-minute walk from shops, cafes and hotels, 30 powered sites, unpowered areas, camp kitchen, barbecues, coin laundry, 32 miners' cottages. (FOHT's page is gone.)

**Flinders Ranges and Outback SA** (the regional tourism body), town pages read through WebFetch:
- [Melrose](https://flindersandoutback.com.au/towns/melrose/): established in the 1840s, the oldest town in the Flinders Ranges, at the base of Mount Remarkable (960 m), the bike shop, the North Star and Mount Remarkable hotels, cafes, a caravan park and B&Bs.
- [Wilmington](https://flindersandoutback.com.au/towns/wilmington/): "Beautiful Valley" to the 1850s settlers, views of the southern Flinders Ranges and the Willochra Plain.
- [Quorn](https://flindersandoutback.com.au/towns/quorn/): the Pichi Richi Railway's trains out of Quorn. The visitor centre's Railway Terrace address is from FOHT's Warren Gorge page.
- [Hawker](https://flindersandoutback.com.au/towns/hawker/): 1880s railway town, shops, airstrip, vehicle repairs, hospital, the century-old Hawker Hotel, the visitor centre at Hawker Motors with food and fuel.
- [Parachilna](https://flindersandoutback.com.au/towns/parachilna/): Ediacaran fossil site about 600 million years old; the Prairie Hotel's food and rooms by booking.
- [Blinman](https://flindersandoutback.com.au/towns/blinman/): copper found by the shepherd Robert Blinman in 1859, the highest town in South Australia, fewer than 50 residents, the North Blinman Hotel, mine tours.

#### Temporary status (dated "As of October 2026" sentences in the bundled text)

All five re-checked against the FOHT pages on 2026-10-30 (#219) and unchanged; the Whistling Trig page still gives the 28 Sep 2026 reading.

- **Whistling Trig Tank** (`w_37b9b2d5`): FOHT says the tank is leaking and stood at 4% on 28 Sep 2026; volunteers are replacing it.
- **The Dutchman Hut** (`w_7c9a0d0c`): FOHT says the hut is closed for repairs, with the shearing shed beside it open for overnight use.
- **Curnows Hut** (`w_3d8a9223`): FOHT lists it "Closed (no longer available)" while the trail is rerouted around the Georgetown wind farm construction.
- FOHT site banner (Oct 2026): "Fire Danger Season 2026 announcements close the Heysen Trail north of Tanunda." The sentence is on **Tanunda** (`w_0b873c07`).
- **Rocky Paddock Campground** (`w_45a922a3`): the FOHT page title reads "Rocky Paddock Campground closed for the remainder of 2026".
- Curnows Hut, previously without an entry, now has one carrying only its closure, on the FOHT page's "Location: Bundaleer" and notes.

#### No entry

- **Curnows Hut**: closed, and its FOHT page gives no facilities.
- **Doughboy Reserve**: FOHT page removed (404), and no authoritative source links it to the trail; only campsite directories describe it.
- **Wirrabara**, off-trail: FOHT's town page has only a map link, and no other source was read.
- **Hallett Camping at the Recreation Ground, Bundaleer Sport & Recreation Grounds, Cartapo Creek Hobby Farm, Sugargum Dam, Goat Rock and Longhill walk-in sites, Stony Creek Bush Camp Caravan Park**: off-trail; their FOHT pages are gone (404, not in FOHT's campsite list), and no land-manager page describing them was found.
- All 55 `accommodation` waypoints in the slice (B&Bs, cottages, hotels, motels, station stays such as Wonoka Station and Wilpena Resort): out of scope by rule.

#### Uncertain

- **Stony Creek walk-in** (`w_17e91abb`): the description says there is no shelter or tank, from the FOHT page after the May 2025 fires. If they are rebuilt, the text must change.
- **Hawks Nest Tank**: FOHT's "closest water" note is out of date about Stony Creek; the description names only Catninga.
- **Georgetown, Crystal Brook, Spalding, Hallett**: these say only what FOHT lists (on or beside the trail, the accommodation FOHT names), because FOHT's town service directory is no longer online and no council or tourism page was read for them. They say nothing about shops.
- **Ippinitchie**: FOHT's search snippet says it is closed in the Fire Danger Season, but the page itself is gone, so the description doesn't say so.
- **Catninga Shed** and **Pichi Richi Park** are private businesses typed `hut` and `caravan-park`; they got entries because the walker-facing water is the point.
- **Aroona Hut**: the description rests on a single sentence on FOHT's Aroona campground page.

## Grampians Peaks Trail (`grampians_peaks`)

All Parks Victoria pages below were read in full with curl on 2026-10-23.

- Parks Victoria (PV), [Grampians Peaks Trail](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail). Gives the start at Mt Zero and finish at Dunkeld, and Brambuk, the National Park and Cultural Centre in Halls Gap, as the place for the trail's topographic maps.
- PV, [Water information and availability](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/water-information-and-availability). Gives:
  - all water on the trail is untreated
  - the serviced water tanks and their UTM (54H) coordinates; each was converted to latitude/longitude and matched to the nearest waypoint (all within 110 m except Mt William Summit, 177 m): Mt Zero Trailhead (`w_4f412c1f`), Coppermine Track Crossing (`w_4fd4561f`), Gar Trailhead on Roses Gap Road (`w_5ea798e1`), Mt Difficult Road Crossing North (`w_7dd85aad`), Sundial Carpark (`w_1dc9a795`), Bugiga Hike-in Campground (`w_f3ff599e`), Redman Road Trailhead/Crossing (`w_11a49b65`), Mt William Road 2 (`w_2787fb48`), Mt William Summit (`w_5e1f70d7`), Jimmy Creek Campground and Jimmy Creek Road Crossing (`w_57cb3bb0`), Yarram Gap Road Crossing (`w_99b076df`), Wannon Hike-in Campground (`w_cc75cbf9`), Djardi-djawara Hike-in Campground (`w_280676fb`), Dunkeld Reservoir Road Crossing (`w_9edb5f0f`), Sturgeon Road Crossing (`w_17d228ed`)
  - campground water "generally supplied for cooking and hand washing", and "when rainfall is minimal, water supply at hike-in campgrounds cannot be guaranteed", hence "untreated, meant mainly for cooking and washing, and dependent on rain"
- PV, [Full Grampians Peaks Trail](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/the-full-grampians-peaks-trail), the 13-day itinerary. Gives, day by day:
  - day 1: Mt Zero Picnic Area start; Mt Stapylton (Gunigalg) 518 m; ridgeline walking around and under boulders and over rock slabs; Stapylton Amphitheatre and Taipan Wall; a steep descent past a seasonal waterfall to Barigar (230 m, "mountain stream")
  - day 2: the climb up rock steps beside cliff edges and under rock walls to Gar (700 m)
  - day 3: Werdug (750 m, "his shoulder", of a mythical ancestor) on a high knoll looking to Lake Wartook and the western Mt Difficult Range; serviced tank at Mt Difficult Rd shortly before it
  - day 4: Lake Wartook Lookout (829 m), "one of the highest points in the Mt Difficult Range"; tall wet forest, Chautauqua Peak, Clematis Falls; no serviced water tanks until Halls Gap; night 4 in Halls Gap, booked separately
  - day 5: start at the Halls Gap Trailhead (caravan park); Stony Creek, Venus Baths with views of Elephants Hide and Chautauqua Peak, the Grand Canyon, Silent Street, The Pinnacle (715 m), Devils Gap, Sundial Carpark; Bugiga (625 m) looking up to Mt Rosea's cliffs, its name referring to Mount Rosea
  - day 6: the bridge at the Gate of the East Wind; tall forest and a steep rocky climb to Mt Rosea (1009 m); long descent to the Fyans Creek footbridge at Borough Huts, where workers maintained Stawell's water supply in the late 1800s; Barri Yalug (375 m, "running river") past the Grampians Tourist Road
  - day 7: biggest elevation change, Barney Creek (320 m) to Redman Bluff (1017 m) with its historic rock cairn; the raised water flume on dry stone pillars; Seven Dials; Duwul ("the mountain") between the Mt William Road and the cliff edge
  - day 8: Mt William (1167 m), the park's highest; Boundary Gap (878 m) between Mt William and the Major Mitchell Plateau, a "big dipper"; the plateau's rock and steel mesh walkway; Durd Durd, the plateau's highest point, marked by a rock cairn; Banksia Hill (1103 m), its banksia ridgeline and boulder rock-hopping, then open grassy woodland; Durd Durd campground (855 m, "stars")
  - days 9–11: Yarram ("big"); Wannon in a reclaimed farmland gully with ridges for sunset views and the Serra Range to the west; Djardji-djawara ("Djadki = sister") on a small rocky knoll on the Serra Range with views to the Victoria Range
  - day 12: Signal Peak, then Mt Abrupt (Mud-Dadjug, 822 m), "an exposed rocky summit marked by a steel trigonometric (trig) station"; very steep rock steps down to Mud-Dadjug ("blunt, useless arm")
  - day 13: Bainggug (The Piccaninny), Victoria Valley Road, Mt Sturgeon (Wurgarri, 582 m) with views over volcanic plains and the southern Grampians, sandstone to the north and basalt to the south; steep descent to farmland and red gum woodland into Dunkeld
- PV, [Grampians Peaks Trail Plan and Prepare Guide](https://www.parks.vic.gov.au/-/media/project/pv/main/parks/documents/visitor-guides-and-publications/grampians/grampians-peaks-trail-plan-and-prepare-guide.pdf) (PDF, read with pdftotext). Gives the eleven hike-in campgrounds, all with "basic toilet facilities and untreated water tanks" and "either a unpowered enclosed roof shelter or open communal area"; non-flushing toilets; a solar-powered USB charging station at every campground; timber platforms or granite sand pads, 3.5 m square, with steel chains; no campfires; booking required and camping fees; Halls Gap and Dunkeld with camping and roofed accommodation; snow possible on Mt William and the Major Mitchell Plateau in late May and at higher elevations in early spring.
- PV, the 3-day hike pages ([Gar and Werdug](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/gar-and-werdug-3-day-hike), [Bugiga and Barri Yalug](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/bugiga-and-barri-yalug-3-day-hike), [Yarram and Wannon](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/yarram-wannon-3-day-hike), [Djardji-djawara and Mud-Dadjug](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/djardji-djawara-and-mud-dadjug-3-day-hike)). Give Gar and Werdug's timber platforms of 3.5 m or 5.0 m; Bugiga and Barri Yalug's 3.5 m timber platforms; Yarram and Wannon's mix of timber platforms and granite sand pads; patchy/poor mobile service between Yarram and Yarram Gap Road.
- PV, [Northern Peaks Experience (Huts)](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/northern-peaks-experience) and [FAQs](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/things-to-do/grampians-peaks-trail/faqs). Give the huts at Gar and Werdug, each sleeping up to four in bunks, bookable only through Licensed Tour Operators.
- PV, [Troopers Creek Campground](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/where-to-stay/troopers-creek-campground): tall eucalypts and heathy shrubland, Mt Difficult escarpment views, tent and vehicle sites, two group areas for up to 16, pit toilets, fireplaces with BBQ hotplates, picnic tables, online booking, next to the trailhead for section two.
- PV, [Borough Huts Campground](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/where-to-stay/borough-huts-campground): Fyans Creek, about 10 km south of Halls Gap, 30 tent sites and 5 drive-in sites, bookings year-round, "only seasonal rain water is available on site, which is not recommend for drinking".
- PV, [Jimmy Creek Campground](https://www.parks.vic.gov.au/places-to-see/parks/grampians-national-park/where-to-stay/jimmy-creek-campground): beside the Wannon River, next to a GPT trailhead, unpowered tent and drive-in sites, pit toilets, a cold water shower, fireplaces with BBQ hotplates, picnic tables.
- Visit Grampians, [Venus Baths Loop Walk](https://www.visitgrampians.com.au/products/venus-baths-loop-walk): the rock pools on the creek above Halls Gap.
- OpenStreetMap, through the committed `data/trails/grampians_peaks/pois.json`: Halls Gap's general store, bakery, post office, outdoor shop, fuel station, cafes, pub and caravan park; Dunkeld's general store, bakery, post office, pharmacy, fuel station, cafes, Royal Mail Hotel and caravan park.

**Changed from the GPX text:** the OSM "Rainwater tank fed by shelter roof. Treat before use." notes on the campground taps became "untreated, meant mainly for cooking and washing, and dependent on rain". Bugiga's OSM "12 elevated camping platforms, 4m diameter" was dropped: PV gives 3.5 m square timber platforms.

**No entry:** Rock shelter, Overhanging rock shelter, Mud Creek bush campsite, Troopers Creek's tap, the two Halls Gap taps, the "Dispenses rainwater" tap at km 51, Gate of the West Wind, Bellfield Peak, Eagle Rock, the 3rd–6th Dials, First Wannon Camp (PV names First Wannon Creek but no camp), Durd Durd Viewpoint, the second Djardji-djawara tank (`w_a8143a3b`), Cassidy Gap Road Trailhead, Mount Sturgeon Lookout.

**Uncertain:**
- Mt William Summit tank (`w_5e1f70d7`) is 177 m from PV's coordinate; the description says "near the summit".
- PV gives Durd Durd's height as 1167 m, the same as Mt William's; OSM has 1164 m. The description gives no height.
- Whether a campground has an enclosed shelter or an open gathering area is not given per site, so every campground entry says "a communal shelter or open gathering area".
- The hut count at Gar and Werdug ("3 huts at the Gar and Werdug hike-in sites") is ambiguous, so no number is given.
- Venus Baths rests on Visit Grampians, the regional tourism board, not a government page.

## Great North Walk (`great_north_walk`)

Official coverage of this walk is thin: it crosses many land managers and none publishes a campsite list. Pages below were read with curl or WebFetch on 2026-10-23.

- NSW National Parks (NPWS), [Great North walk – Berowra Valley National Park](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/great-north-walk-berowra-valley-national-park) and its visitor info. Gives the Benowie walking track, 27 km along Berowra Creek from Pennant Hills to Berowra Waters; no public access through Hornsby Rifle Range between Quarry trail and Tunks Ridge, with the route via Manor Road and Simon trail.
- NPWS, [Great North walk – Lane Cove National Park](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/great-north-walk-lane-cove-national-park): created in 1988 for the bicentenary, 250 km, linking Sydney with the Hunter Valley and Newcastle; camping at Crosslands Reserve.
- NPWS, [Great North walk – Ku-ring-gai Chase National Park](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/great-north-walk-in-kuringgai-chase-national-park) and visitor info: Jerusalem Bay track from Cowan station to Brooklyn, 11 km, very steep, many steps, boggy when it rains; toilets at Cowan station and Brooklyn village.
- NPWS, [Wondabyne to Patonga walking track](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/wondabyne-to-patonga-walking-track) and visitor info: 23 km; the remote Mount Wondabyne bush campground; "Drinking/cooking water is limited or not available in this area"; camp fires and solid fuel burners prohibited.
- NPWS, [Great North walk – Watagans National Park](https://www.nationalparks.nsw.gov.au/things-to-do/walking-tracks/great-north-walk-watagans-national-park) and visitor info: the section along Georges Road; Narrow Place lookout over Quorrobolong to Ellalong, Cessnock and Kurri Kurri; "A nearby campsite on private property, known as Barraba Trig, is available to walkers"; "You'll need to bring your own drinking and cooking water".
- Hornsby Shire Council, [Crosslands Reserve](https://www.hornsby.nsw.gov.au/lifestyle/sports-and-recreation/parks-and-playgrounds/crosslands-reserve) (via WebFetch): basic camping, no showers or power, BBQs, toilets, picnic tables, playground, booking through the council, foot access along the Benowie Walking Track, gate closing 7.30 pm in daylight saving and 5 pm otherwise.
- Forestry Corporation of NSW, [Heaton State Forest](https://www.forestrycorporation.com.au/visit/forests/heaton-state-forest): Watagan Headquarters' 1940s road-workers' camp and later maintenance-crew barracks, its open grassed camping area among native forest and blue-leaved stringybark plantations, on the Great North Walk; Hunter Lookout's and McLeans Lookout's views; Heaton Lookout's coastal and mountain views, picnic area and Richard Heaton.
- OpenStreetMap, through the committed `data/trails/great_north_walk/pois.json`: the cafe and convenience store at Cowan; Newcastle's cafes, restaurants, pubs, pharmacy and bus stops.

**No entry:** the ~60 generic "Drinking water" bubblers and taps (including the four tagged not drinkable), the rotundas, most lookouts, Sugarloaf Hill, Blue Hole, The Jungo, Berowra Creek camp, Ridge Top Campground, Brooklyn Dam Campsite (only blogs describe it), Patonga Rest Area, Mount Wondabyne summit, Scopas Peak, the three unnamed "Campsite" points, Mooney Mooney (Upper), Palm Grove camping area (NSW Government's Palm Grove Nature Reserve page does not mention camping), Stringy Bark Point, Walkers Rest, Mt Warrawolong, Crawford Hut, the Glenrock and Newcastle lookouts, King Edward Park Fountain. Sydney, Thornleigh, Brooklyn, Somersby, Warners Bay, Crosslands Youth Camp and Glenrock Scout Training Camp keep their hand-reviewed GPX text.

**Uncertain:**
- Tunks Ridge Campground is named as an NPWS campground only on an NPWS local-alert page seen as a search result; its facilities are not described, so none are given.
- Crosslands' gate times are from Hornsby Council's page; NPWS's Berowra Valley visitor info gives Crosslands' opening as 8am–7.30pm in daylight saving and 9am–5pm otherwise. The description gives only the closing times, on which both agree.
- Barraba Trig's facilities and any conditions of use are unknown.
- Mooney Mooney (Upper), The Jungo and the unnamed campsite at km 133.7 carried OSM text that read as a walker's note ("Water seems OK to drink from (filtered)", tent counts, phone reception). It could not be verified and was removed from the GPX `<desc>` on #217.
- Search budget ran out before a Forestry Corporation page for Palm Grove/Ourimbah or a Brooklyn Dam source could be found.

## South Coast Track (`south_coast_track`)

All Parks and Wildlife Service Tasmania (PWS) pages below were read in full with curl on 2026-10-23.

- PWS, [South Coast Track](https://parks.tas.gov.au/explore-our-parks/southwest-national-park/south-coast-track). Gives:
  - 85 km, 6–8 days, Melaleuca to Cockle Creek
  - "There are no huts once you leave Melaleuca"; two bushwalkers huts at Melaleuca and no others on the South Coast or Port Davey tracks
  - the dinghy row across a lagoon outlet
  - fuel stove only; no campfires on the track
  - untreated rainwater from tanks in the Cockle Creek campgrounds, limited at times of high demand ("PWS does advise visitors to boil water"), hence "untreated"
- PWS, [South Coast Track – walk notes](https://parks.tas.gov.au/explore-our-parks/southwest-national-park/south-coast-track/south-coast-track-walk-notes). Gives:
  - "most [major campsites] have pit toilets" (not used per site, since it does not say which)
  - day 1: buttongrass plains and sandy beaches, very muddy sections, boardwalk that goes under in the wet; campsite at Cox Bight, or 1.4 km further at Point Eric
  - day 2: starts on the beach at Cox Bight, inland over buttongrass and forested hills to the Louisa River; many creek crossings, "take care, especially after heavy rains"
  - day 3: 900 m ascent onto the Ironbound Range, exposed top with views in fine weather and rain, wind and snow at other times, long descent through rainforest to Little Deadmans Bay
  - day 4: buttongrass, bush and Prion Beach; row across the marked crossing at New River Lagoon to reach the Prion Beach campsite; three crossings to leave a boat on each side
  - Osmiridium Beach side trip: 1.2 km, 30 minutes return; "many walkers choose to camp" there, 2–2.5 hours past the boat crossing
  - day 5: Granite Beach's mix of sand and large stones; the campsite at the far end of the beach
  - day 6: "reputedly the hardest day", long ascent through forest over the South Cape Range, often boggy, many tree roots, to South Cape Rivulet
  - day 7: beaches and mud, Lion Rock, stairs off the last beach, the buttongrass plains of Blowhole Valley to Cockle Creek
- PWS, [Melaleuca](https://parks.tas.gov.au/explore-our-parks/southwest-national-park/melaleuca). Gives the light-plane/boat/walk-only access, and the facilities: gravel airstrip, toilets, two walkers huts sleeping 20, a small campsite, the Deny King Heritage Museum, the Needwonnee Walk and a bird hide.
- PWS, [Cockle Creek](https://parks.tas.gov.au/explore-our-parks/southwest-national-park/cockle-creek). Gives the South Cape Bay walk (18 km return), Boltons Green past the Ranger Quarters, and the untreated tank at Boltons Green ("should be boiled for several minutes before drinking").
- PWS, [Cockle Creek camping](https://parks.tas.gov.au/explore-our-parks/southwest-national-park/cockle-creek-camping). Gives:
  - Boltons Green: the shady national-park campground, about 10 tent and caravan sites, pit toilets and an untreated water tank, the public payphone at the visitor information shelter
  - fuel stove only, no dogs across the bridge
  - Southport as the nearest town for groceries, petrol and meals
- PWS, [Recherche Bay camping](https://parks.tas.gov.au/Pages/Recherche-Bay-camping.aspx). Gives the Cockle Creek campground: 20 sites between the cemetery and the bridge; cleared sites and pit toilets; dogs on lead; campfires only in firepots, and none under seasonal restrictions.
- OSM (Overpass, private.coffee mirror, data to 2026-07-24): the Cockle Creek Road bridge (way 23443019) at 146.8928° E, between the "Cockle Creek campsite" waypoint (146.8903° E) and Boltons Green (146.8952° E). This is what identifies the waypoint as the Recherche Bay NRA campground, north of the bridge.
- The committed GPX (Copernicus): the Ironbound high camp's height, about 820 m.

**No entry:** Buoy Creek, Louisa Creek, Turua Beach West, Surprise Bay and Trackcutters Camp. No PWS page names them.

**Uncertain:**
- **Freney Lagoon Campsite** is described as the Cox Bight campsite. PWS names only "the campsite at Cox Bight", 1.4 km before Point Eric; the waypoint sits 1.6 km before Point Eric on Cox Bight beside Freney Lagoon.
- **Louisa River:** the walk notes' "take care, especially after heavy rains" was turned into "creek crossings that rise after heavy rain". No PWS page describes the Louisa River ford itself, so the description does not.
- **Pit toilets** are not claimed at any one track campsite: PWS says only that "most" have them.

## Overland Track (`overland`)

All PWS pages below were read in full with curl on 2026-10-23.

- PWS, [Overland Track – walk notes](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track/overland-track-walk-notes). Gives:
  - 65 km Ronny Creek to Narcissus, plus 17.5 km along Lake St Clair
  - "Rainwater tanks and composting toilets are provided at each of the main huts … water from rainwater tanks needs to be boiled or treated", hence "untreated rainwater tank"
  - day 1: 10.7 km; gradual ascent to Crater Lake, then very steep and short to Marions Lookout; mostly exposed alpine plateau. Waterfall Valley Hut sleeps 34; 4 tent platforms and overflow on grass
  - Cradle Mountain (1545 m): 2 km, 2–3 hours return, boulder scrambling, currawongs that undo zips
  - Barn Bluff (1559 m): 7 km, 3–4 hours return, very steep sections and boulder scrambling
  - day 2: 7.8 km over alpine heath, lakes and tarns, above 1000 m; no camping around Lake Windermere, sites 500 m from its shore; hut sleeps 34; 8 tent platforms
  - day 3: 16.8 km; the ring of mountains; buttongrass, myrtle-beech rainforest, eucalypt forest; Pelion Hut sleeps 36; 1 tent platform for 3 tents; overflow on grass; Old Pelion Hut (1917, miners, day use, swimming hole), 1 km return
  - day 4: Douglas Creek, Pelion Gap between Mount Ossa and Pelion East, exposed, "take your breaks in the shelter of the forest before Pelion Gap"; descent over buttongrass and eucalypt forest; Kia Ora sleeps 34; 9 tent platforms
  - Mount Ossa (1617 m, Tasmania's highest): 5.2 km, 4–5 hours return, steep, exposed, boulder fields dangerous under snow
  - Mount Pelion East: 2.4 km, 2 hours return, views over Ossa and most of the park's highest peaks, steep and exposed
  - day 5: Du Cane Hut, built 1910, lunch spot, "should only be used as an overnight location in an emergency"; the D'Alton and Fergusson Falls junction, then about 20 minutes on the Hartnett Falls junction; Bert Nichols Hut at the top of the Narcissus Valley below the Du Cane Range, sleeps 24, large enclosed dining area, 9 tent platforms
  - D'Alton and Fergusson Falls: 1 km, 1 hour return, down through rainforest to the Mersey, slippery, sheer drop-offs at the top. Hartnett Falls: 1.5 km, 1 hour return (the page spells it both Harnett and Hartnett)
  - day 6: Narcissus Hut on the Narcissus River at the head of Lake St Clair, the suspension bridge, the ferry jetty, the radio for reconfirming ferry bookings; sleeps 18; 4 tent platforms
  - Pine Valley Hut: 4.7 km, 1.5–2 hours one way, recommended as an overnight trip; sleeps 16; 4 tent platforms; overflow on the forest floor; the base for the Acropolis and the Labyrinth
  - day 7: Echo Point Hut, small and rustic, 5 km (2 hours) from Narcissus
- PWS, [Overland Track – FAQ](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track/frequently-asked-questions). Gives huts that cannot be booked, first come first served, with bunks without mattresses, composting toilets, freshwater tanks and communal cooking areas, and no showers, hot water or cooking equipment.
- PWS, [Overland Track](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track). Gives almost half the track above 1000 m, the usual finish at Narcissus, and the privately run ferry, booked in advance.
- PWS, [Overland Track – plan your trip](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track/overland-track-plan-your-trip). Gives the log books at the start and end of the track and at each hut, and the shuttle from the visitor centre to Ronny Creek, "some 7 km away".
- PWS, [Overland Track – walk options](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/overland-track/overland-track-walk-options). Gives "Educational, school and community groups … must use the group tent platforms, and not sleep in the huts", guided companies camping on the public group platforms, and the "independent walker tent platforms".
- PWS, [Crater Lake](https://parks.tas.gov.au/explore-our-parks/cradle-mountain/crater-lake). Gives picnic tables and limited parking at Ronny Creek, the shuttle stop at Ronny Creek, and check-in at the Cradle Mountain Visitor Centre.
- PWS, [Cradle Summit](https://parks.tas.gov.au/Pages/Cradle-Summit.aspx). Gives the views over "dozens of mountains and lakes" on a clear day.
- PWS, [Lake St Clair](https://parks.tas.gov.au/explore-our-parks/lake-st-clair). Gives:
  - Australia's deepest freshwater lake, 167 m, carved out by glaciers
  - the Cynthia Bay visitor centre, its cafe and toilets
  - the ferry to Narcissus
  - 5.5 km from Derwent Bridge on Lake St Clair Rd
- PWS, [Echo Point](https://parks.tas.gov.au/Pages/Echo-Point.aspx). Gives the hut three-quarters of the way up the lake in dense, mossy forest, the jetty with ferry bookings essential, the bush toilet, and Mount Ida across the lake.
- PWS, [Lake St Clair walks](https://parks.tas.gov.au/Pages/Lake-St-Clair-walks.aspx) (park alert). Names Fergys Campsite and its access by the Watersmeet Track and Lakeshore Beach. The same alert says the new toilets there are closed for construction; that is temporary and left out.
- OSM via the committed GPX: Marions Lookout's height, about 1,220 m.

**No entry (GPX text kept where it has any):** Crater Lake Hut, Wombat Peak, Kitchen Hut, Emergency Shelter, Old Waterfall Valley Hut, Windermere Lake Viewpoint, Forth River Viewpoint, the three Cradle Mountain Huts private huts, Smithies Peak, Mount Doris, Echo Point Campsite, and the "Drinking water" point at Cynthia Bay. No PWS page read describes them, or the existing hand-reviewed text already says what PWS would.

**Uncertain:**
- **Mount Pelion East's height:** PWS's walk notes give 1433 m, while OSM, and the GPX's former text, give 1461 m. The description gives no height.
- **Hartnett Falls:** the walk notes spell it both "Harnett" and "Hartnett"; the description uses Hartnett.
- **Group platforms:** PWS says educational and community groups must use them, and guided walks may. It does not say outright that independent walkers may not, so the descriptions do not say so either.

## Heysen data changes on #217 (2026-10-23)

Removed from `Heysen.gpx` and `Heysen.json` (ids kept in the registry as `retired`), because each place's Friends of the Heysen Trail page now returns 404 and the place is no longer in the Friends' campsite listing (`foht_campsite` REST list), and no land-manager page describes it:

- The Scrub Campsite (`w_d7d02f6a`), Mylor Oval tank (`w_557f2087`), Fromms Farm (`w_aecdaa67`), Bethany Reserve (`w_ba586ff7`), Alma's Hem Amphitheatre (`w_680e9539`), Mt Compass township camp site at oval (`w_27ca0270`), Mt Crawford Forest Information Centre (`w_232a40bb`), Tanunda Caravan & Tourist Park (`w_ef4d5138`), Riverton Caravan Park (`w_28963eec`), Doughboy Reserve (`w_721d0707`), Hallett Camping at the Recreation Ground (`w_f862bab0`), Bundaleer Sport & Recreation Grounds (`w_d6cbd9b9`), Cartapo Creek Hobby Farm (`w_f8611294`), Sugargum Dam 'walk-in' site (`w_1ce32055`), Goat Rock 'walk-in' site (`w_800568d1`), Longhill 'walk-in' site (`w_24d49c80`), Stony Creek Bush Camp Caravan Park (`w_d7843d94`).
- Cape Jervis Tavern (`w_c04ed919`): the Friends' Cape Jervis town page says the tavern has closed.

Retyped: **Cape Jervis** (`w_56bc59b8`) from `town` to `poi` (GeoJSON folder Towns → Other, `<desc>` first line Town → Other), with its registry entry migrated so the id is kept. The Friends' page says the tavern and general store have closed and only the Big4 caravan park's small shop remains, so it no longer counts as a resupply. The trail's terminus, Cape Jervis Trailhead (`w_83a8f54b`), is unchanged.

**Stony Creek 'walk-in' site** (`w_17e91abb`) needed no data change: it is typed `campsite` (not water or hut) and its Friends category is "'Walk-in' site" with no water tank; the description says the shelter and tank were lost after the May 2025 fire.

**Dead links.** Seven descriptions no longer end with a "More info" link because the Friends page returns 404: Burra Caravan and Camping Park, Aroona Hut, Tinjella Hut, Aldgate, Ippinitchie Campground, Acraman Campground and Youngoona Campsite. Every remaining link was checked to return 200 on 2026-10-23.

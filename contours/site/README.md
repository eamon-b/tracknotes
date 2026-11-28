# Contour Map Tiles — public docs & demo page

Static one-page site documenting the public contour tileset in the R2 bucket
`aus-map-data`: the world archive (`contours/world.pmtiles`, Copernicus GLO-30,
~613 GB). Live MapLibre demo on it, usage snippets, schema, extract
instructions, and the attribution its licence requires.

The deprecated Australia archive (`contours/australia.pmtiles`) is still in the
bucket but is no longer mentioned on the page.

Deployed on Cloudflare Pages (project `aus-contour-tiles`), served at
`contour-map-tiles.net` with `aus-contour-tiles.pages.dev` as the fallback:

```bash
npx wrangler pages deploy contours/site --project-name aus-contour-tiles
```

The *Deploy contours site* workflow runs that (with `--branch main`, the
project's production branch) after every merge that changes `contours/site/`
(`docs/deploys.md`).

The three public hostnames on the `contour-map-tiles.net` zone:

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | this page (Pages) |
| `data.contour-map-tiles.net` | the R2 bucket — the archives (the app's offline packs are at `data.tracknotes.info`, bucket `tracknotes-data`) |
| `tiles.contour-map-tiles.net` | the contour-tiles Worker (z/x/y endpoint) |

| File | What |
| --- | --- |
| `index.html` | the page: styles, docs and the demo script, all inline |
| `404.html` | Pages' not-found page |
| `favicon.svg` | the icon (follows the light/dark theme) |
| `og.jpg` | the link-preview image (1200×630, the Matterhorn demo view) |
| `vendor/` | MapLibre GL JS and pmtiles, served from here rather than a CDN |

Notes:

- The archive URL is written out in the docs (so link previews, search engines
  and readers without JavaScript see it) and once more as `ARCHIVE_URL` in the
  inline script, which the demo reads. Change every copy to move the tileset.
- The world archive's size and tile count on the page (~613 GB, ~232 million
  tiles) come from the 2026-10-24 re-tier build; refresh them after a rebuild
  from the object's `content-length` and the PMTiles header's addressed-tile
  count.
- Browser access to the archive requires the CORS rules on the `aus-map-data`
  bucket (GET/HEAD, wildcard origin, `etag`/`content-range` exposed). They were
  set 2026-08-19 via `wrangler r2 bucket cors set`.
- The demo reads the archive with `cache: "no-store"`
  (`chromeWindowsNoCache` on its `FetchSource`). Without it, a returning Chrome
  visitor's first range request was answered from the HTTP cache with a
  response pmtiles rejects, and pmtiles keeps that error for the page's
  lifetime: no contours until a hard reload.
- The page follows the system light/dark setting (`prefers-color-scheme`),
  switching the basemap and contour colours with it (`THEMES` in the script).
- The demo basemap and fonts are hotlinked from OpenFreeMap (free to use, no
  key): its `positron` style in light mode and `dark` in dark mode, with the
  contour layers spliced in.
- The hillshade is AWS's Terrain Tiles (Mapzen's Terrarium encoding, public,
  CORS-enabled, no key), attributed in the map and the footer.
- `og.jpg` is a screenshot of the demo map. Regenerate it by hand (e.g. a
  Playwright element screenshot of `#map` at 1200×630) if the map's look
  changes.

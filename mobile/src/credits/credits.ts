/**
 * Who the map and the guides' data come from: the label on the map, the lines
 * behind its ⓘ, and the app-wide list in Settings → About.
 *
 * OpenStreetMap's ODbL and the CC BY sources (trail data, contours) require a
 * visible credit. MapLibre's own attribution control is off (it reads the
 * style's `attribution` strings, which the offline style does not carry), so
 * the credit is ours to draw: one list for the base map that actually mounted,
 * the contours, and the trail's own `config.dataSource`.
 *
 * Outside the feature slices because the map and Settings both use it.
 */

import { safeHttpUrl } from '@lib/poi-display';

/** The base map that mounted (`map-style`'s `MapStyleSource`), or null for the bare fallback. */
export type CreditBasemap = 'online' | 'offline' | null;

export interface CreditLine {
  /** What the line credits ("Base map", "Trail data"). */
  label: string;
  text: string;
  /** http(s) only; anything else is dropped and the line stays plain text. */
  url?: string;
  linkText?: string;
}

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

const OSM_LINE: CreditLine = {
  label: 'Map data',
  text: '© OpenStreetMap contributors, under the Open Database Licence.',
  url: OSM_COPYRIGHT_URL,
  linkText: 'openstreetmap.org/copyright',
};

/**
 * The credit on the "Find places along this route" screen: the POIs it saves
 * are OpenStreetMap data (ODbL), asked for through a public Overpass instance.
 */
export const POI_SEARCH_CREDIT: CreditLine = {
  label: 'Points of interest',
  text:
    '© OpenStreetMap contributors, under the Open Database Licence. Searched through a public ' +
    'Overpass API server.',
  url: OSM_COPYRIGHT_URL,
  linkText: 'openstreetmap.org/copyright',
};

const ONLINE_BASEMAP_LINE: CreditLine = {
  label: 'Base map',
  text: 'OpenFreeMap, © OpenMapTiles.',
  url: 'https://openfreemap.org/',
  linkText: 'openfreemap.org',
};

const OFFLINE_BASEMAP_LINE: CreditLine = {
  label: 'Base map',
  text: 'Offline maps cut from the Protomaps basemap.',
  url: 'https://protomaps.com/',
  linkText: 'protomaps.com',
};

export const CONTOURS_LINE: CreditLine = {
  label: 'Contours',
  text:
    'Copernicus GLO-30 DEM (© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, ' +
    'provided under COPERNICUS by the European Union and ESA).',
};

export const CLIMATE_LINE: CreditLine = {
  label: 'Climate',
  text: 'Open-Meteo historical weather API (CC BY 4.0).',
  url: 'https://open-meteo.com/',
  linkText: 'open-meteo.com',
};

/**
 * A trail's `config.dataSource` as a credit line, or null when it has none.
 * The config is read through an index signature, so the shape is checked here
 * rather than trusted.
 */
export function trailDataCredit(dataSource: unknown): CreditLine | null {
  if (!dataSource || typeof dataSource !== 'object') return null;
  const { text, url, linkText } = dataSource as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '') return null;
  const line: CreditLine = { label: 'Trail data', text: text.trim() };
  // Same rule as the web page's note: only a link that says http(s) is drawn.
  const safe =
    typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? safeHttpUrl(url) : undefined;
  if (safe) {
    line.url = safe;
    line.linkText = typeof linkText === 'string' && linkText.trim() ? linkText.trim() : safe;
  }
  return line;
}

/**
 * Every credit for the map as it is drawn: the base map that mounted (none for
 * the bare fallback style), OpenStreetMap, contours, then the trail's data.
 */
export function mapCredits(basemap: CreditBasemap, dataSource: unknown): CreditLine[] {
  const lines: CreditLine[] = [];
  if (basemap === 'online') lines.push(ONLINE_BASEMAP_LINE);
  if (basemap === 'offline') lines.push(OFFLINE_BASEMAP_LINE);
  lines.push(OSM_LINE, CONTOURS_LINE);
  const trail = trailDataCredit(dataSource);
  if (trail) lines.push(trail);
  return lines;
}

/**
 * The short credit drawn on the map itself, which the OSMF and OpenMapTiles
 * licences ask to be visible there rather than only behind a button.
 */
export function mapCreditLabel(basemap: CreditBasemap): string {
  if (basemap === 'online') return '© OpenMapTiles © OpenStreetMap';
  if (basemap === 'offline') return 'Protomaps © OpenStreetMap';
  return '© OpenStreetMap';
}

/** The app-wide credits Settings → About lists (no trail, no particular base map). */
export function appCredits(): CreditLine[] {
  return [OSM_LINE, ONLINE_BASEMAP_LINE, OFFLINE_BASEMAP_LINE, CONTOURS_LINE, CLIMATE_LINE];
}

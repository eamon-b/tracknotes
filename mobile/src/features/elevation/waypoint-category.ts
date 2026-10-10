/**
 * Map a waypoint `type` (or OSM POI category) to one of the theme's waypoint
 * colour tokens, so marker colours adapt to dark mode.
 *
 * The family comes from `@lib/waypoint-glyphs`, which derives it from the
 * marker's glyph: a type drawn with the water drop is always water-coloured,
 * and a new alias added to the glyph table is coloured with no second edit.
 * The same family drives the list's filter chips (`waypoint-filters.ts`) and
 * the composer's water-status chips (`waypoint-detail.ts`).
 *
 * Pure + React-free so the grouping is unit-testable; the component resolves
 * `colors[categoryToken(type)]` at render time.
 */

import type { ThemeColors } from '../../tokens';
import { poiFamily, waypointFamily, type GlyphFamily } from '@lib/waypoint-glyphs';

/** Theme token keys that carry a waypoint category color. */
export type WaypointColorToken =
  | 'waypointWater'
  | 'waypointCamp'
  | 'waypointTown'
  | 'waypointShelter'
  | 'waypointJunction'
  | 'waypointHazard';

const FAMILY_TO_TOKEN: Record<GlyphFamily, WaypointColorToken> = {
  water: 'waypointWater',
  camp: 'waypointCamp',
  town: 'waypointTown',
  shelter: 'waypointShelter',
  hazard: 'waypointHazard',
  // Junctions, crossings, trail ends, lookouts, POIs… read as neutral.
  neutral: 'waypointJunction',
};

/**
 * The theme color token for a waypoint type (neutral fallback for unknowns).
 * A turn-off is coloured as the place it serves. This is a *colour* rule, not
 * a semantic one — see `overnightWaypoints`, which has to exclude turn-offs
 * explicitly because you cannot sleep at a roadside.
 */
export function categoryToken(type: string): WaypointColorToken {
  return FAMILY_TO_TOKEN[waypointFamily(type)];
}

/** Resolve a waypoint type to its themed marker color. */
export function waypointColor(type: string, colors: ThemeColors): string {
  return colors[categoryToken(type)];
}

/**
 * OSM POI categories share the waypoint palette rather than adding tokens of
 * their own: what marks a POI as uncurated is its treatment (smaller, tinted
 * fill, thin ring, "OSM" badge), not a colour nobody could learn. Resupply and
 * food both read as "town business"; transport falls in with the neutral
 * junction colour.
 */
export function poiColorToken(category: string): WaypointColorToken {
  return FAMILY_TO_TOKEN[poiFamily(category)];
}

/** Resolve a POI category to its themed marker color. */
export function poiColor(category: string, colors: ThemeColors): string {
  return colors[poiColorToken(category)];
}

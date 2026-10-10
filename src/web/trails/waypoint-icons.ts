/**
 * The glyph each waypoint type is drawn with, on the trail page and the plan
 * page alike: inline SVG from the shared `@lib/map-glyphs` set, the same
 * shapes the phone's map draws, so a type looks the same on both and does not
 * depend on the reader's emoji font.
 *
 * The SVG carries a `wp-fam-<family>` class (`@lib/waypoint-glyphs`): in a
 * table or list the glyph is drawn in its family colour, and on a map marker
 * (`.waypoint-marker`) the family colours the ring while the glyph stays ink.
 */

import { glyphSvg, poiFamily, poiGlyph, waypointFamily, waypointGlyph } from '@lib/waypoint-glyphs';

/** The family class for a waypoint type; put it on a marker to colour its ring. */
export function waypointFamilyClass(type?: string): string {
  return `wp-fam-${waypointFamily(type)}`;
}

/** The glyph for a type as inline SVG; a turn-off shows its served type's (`hut-access` → the hut). */
export function waypointIcon(type?: string): string {
  return glyphSvg(waypointGlyph(type), `map-glyph ${waypointFamilyClass(type)}`);
}

/** The family class for an OpenStreetMap POI category. */
export function poiFamilyClass(category: string): string {
  return `wp-fam-${poiFamily(category)}`;
}

/** The glyph for an OpenStreetMap POI category as inline SVG. */
export function poiIcon(category: string): string {
  return glyphSvg(poiGlyph(category), `map-glyph ${poiFamilyClass(category)}`);
}

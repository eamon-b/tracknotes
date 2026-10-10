import { describe, it, expect } from 'vitest';
import { MAP_GLYPHS } from '@lib/map-glyphs';
import { poiIcon, waypointFamilyClass, waypointIcon } from './waypoint-icons';

describe('waypointIcon', () => {
  it('draws a type with its own glyph as inline SVG', () => {
    expect(waypointIcon('hut')).toContain(MAP_GLYPHS.hut);
    expect(waypointIcon('gap')).toContain(MAP_GLYPHS.gap);
    expect(waypointIcon('hut')).toMatch(/^<svg class="map-glyph wp-fam-shelter"/);
  });

  it('never draws an emoji', () => {
    for (const type of ['town', 'hut', 'campsite', 'water', 'trailhead', 'milestone', 'hazard']) {
      expect(waypointIcon(type)).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('draws a turn-off with the glyph and colour of the place it serves', () => {
    expect(waypointIcon('hut-access')).toBe(waypointIcon('hut'));
    expect(waypointIcon('town-access')).toBe(waypointIcon('town'));
    expect(waypointFamilyClass('water-access')).toBe('wp-fam-water');
  });

  it('falls back to the generic point glyph for an unknown or missing type', () => {
    expect(waypointIcon('something-new')).toContain(MAP_GLYPHS.poi);
    expect(waypointIcon(undefined)).toContain(MAP_GLYPHS.poi);
    expect(waypointIcon('')).toContain(MAP_GLYPHS.poi);
    expect(waypointFamilyClass(undefined)).toBe('wp-fam-neutral');
  });

  it('gives hazards and emergencies their own glyph rather than the fallback', () => {
    expect(waypointIcon('hazard')).toContain(MAP_GLYPHS.hazard);
    expect(waypointIcon('emergency')).toContain(MAP_GLYPHS.emergency);
    expect(waypointFamilyClass('emergency')).toBe('wp-fam-hazard');
  });
});

describe('poiIcon', () => {
  it('shares glyphs with the equivalent waypoint types', () => {
    expect(poiIcon('water')).toBe(waypointIcon('water'));
    expect(poiIcon('camping')).toBe(waypointIcon('campsite'));
    expect(poiIcon('emergency')).toContain(MAP_GLYPHS.emergency);
  });

  it('falls back for a category this build does not know', () => {
    expect(poiIcon('helipad')).toContain(MAP_GLYPHS.poi);
  });
});

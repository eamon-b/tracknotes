import { describe, it, expect } from 'vitest';
import { MAP_GLYPHS, MAP_GLYPH_NAMES } from './map-glyphs';
import { FALLBACK_GLYPH, glyphSvg, poiFamily, poiGlyph, waypointFamily, waypointGlyph } from './waypoint-glyphs';
import { RESUPPLY_TYPES, RESUPPLY_TYPE_ALIASES, WATER_TYPES, WATER_TYPE_ALIASES } from './waypoint-taxonomy';

describe('map glyph shapes', () => {
  it('has a shape for every name, each a well-formed SVG inked with currentColor', () => {
    expect(Object.keys(MAP_GLYPHS).sort()).toEqual([...MAP_GLYPH_NAMES].sort());
    for (const name of MAP_GLYPH_NAMES) {
      const doc = new DOMParser().parseFromString(glyphSvg(name), 'image/svg+xml');
      expect(doc.querySelector('parsererror')).toBeNull();
      expect(MAP_GLYPHS[name]).toContain('currentColor');
      expect(MAP_GLYPHS[name]).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    }
  });
});

describe('waypointGlyph / waypointFamily', () => {
  it('derives the colour family from the glyph, so aliases cannot drift', () => {
    for (const type of ['water', 'spring', 'tank', 'rainwater', 'tap', 'river']) {
      expect(waypointFamily(type)).toBe('water');
    }
    expect(waypointFamily('hostel')).toBe(waypointFamily('hut'));
    expect(waypointFamily('post-office')).toBe('town');
    expect(waypointFamily('emergency')).toBe('hazard');
    for (const type of ['trailhead', 'junction', 'road-crossing', 'lookout', 'beach']) {
      expect(waypointFamily(type)).toBe('neutral');
    }
  });

  it('draws and colours a turn-off as the place it serves', () => {
    expect(waypointGlyph('hut-access')).toBe('hut');
    expect(waypointFamily('water-access')).toBe('water');
    expect(waypointFamily('town-access')).toBe('town');
  });

  it('draws a teahouse with its own glyph in the shelter family, turn-off included', () => {
    expect(MAP_GLYPH_NAMES).toContain('teahouse');
    expect(waypointGlyph('teahouse')).toBe('teahouse');
    // Drawn only for the type the planner counts: an unknown spelling stays
    // the generic point rather than a cup that promises water and meals.
    expect(waypointGlyph('tea-house')).toBe(FALLBACK_GLYPH);
    expect(waypointGlyph('teahouse-access')).toBe('teahouse');
    expect(waypointFamily('teahouse')).toBe('shelter');
  });

  it('never draws a type the taxonomy counts as water or resupply as the neutral dot', () => {
    for (const type of [...WATER_TYPES, ...WATER_TYPE_ALIASES]) {
      // A teahouse is water too, but drawn as the lodge it is.
      expect(waypointFamily(type)).toBe(type === 'teahouse' ? 'shelter' : 'water');
    }
    for (const type of [...RESUPPLY_TYPES, ...RESUPPLY_TYPE_ALIASES]) {
      expect(['town', 'shelter']).toContain(waypointFamily(type));
    }
    expect(waypointGlyph('well')).toBe('water');
    expect(waypointGlyph('Waterhole')).toBe('water');
    expect(waypointGlyph('kiosk')).toBe('resupply');
    expect(waypointGlyph('roadhouse')).toBe('resupply');
    // The table's own entry still wins over the family: a cafe is a meal out.
    expect(waypointGlyph('cafe')).toBe('restaurant');
  });

  it('draws a turn-off to an alias as the place it serves', () => {
    expect(waypointGlyph('well-access')).toBe('water');
    expect(waypointGlyph('kiosk-access')).toBe('resupply');
  });

  it('falls back to the generic point for unknown or missing types', () => {
    expect(waypointGlyph('something-new')).toBe(FALLBACK_GLYPH);
    expect(waypointGlyph(undefined)).toBe(FALLBACK_GLYPH);
    expect(waypointFamily('')).toBe('neutral');
  });
});

describe('poiGlyph / poiFamily', () => {
  it('shares glyphs and families with the matching waypoint types', () => {
    expect(poiGlyph('camping')).toBe(waypointGlyph('campsite'));
    expect(poiFamily('restaurant')).toBe('town');
    expect(poiFamily('transport')).toBe('neutral');
    expect(poiFamily('emergency')).toBe('hazard');
    expect(poiGlyph('helipad')).toBe(FALLBACK_GLYPH);
    expect(poiFamily('helipad')).toBe('neutral');
  });
});

describe('lookups from user-supplied strings', () => {
  it('gives an Object.prototype key the fallback glyph, not the prototype member', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(waypointGlyph(key)).toBe(FALLBACK_GLYPH);
      expect(waypointFamily(key)).toBe('neutral');
      expect(poiGlyph(key)).toBe(FALLBACK_GLYPH);
      expect(poiFamily(key)).toBe('neutral');
    }
  });
});

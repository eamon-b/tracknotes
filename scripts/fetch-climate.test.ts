import { describe, expect, it } from 'vitest';
import { isUnchanged, staleClimateLocations, storedElevation, type ClimateLocation } from './fetch-climate';

describe('storedElevation', () => {
  it('keeps an explicitly configured elevation, whatever the waypoint says', () => {
    // The regression: a configured correction was overwritten by the
    // waypoint's height when it differed from the API's by over 200 m.
    expect(storedElevation(820, 820, 1105)).toBe(820);
    expect(storedElevation(820, 780, undefined)).toBe(820);
  });

  it('prefers the waypoint height when the API is more than 200 m off and nothing is configured', () => {
    expect(storedElevation(undefined, 400, 1105)).toBe(1105);
    expect(storedElevation(undefined, 400, 550)).toBe(400);
    expect(storedElevation(undefined, 400, undefined)).toBe(400);
    expect(storedElevation(undefined, 400, 0)).toBe(400);
  });

  it('stores what --changed compares against, so a corrected location is reused next run', () => {
    const loc: ClimateLocation = { name: 'River camp', lat: -41.1, lon: 146.2, elevation: 820 };
    const stored = {
      name: loc.name,
      lat: loc.lat,
      lon: loc.lon,
      elevation: storedElevation(loc.elevation, 795, 1105),
      monthly: [],
    };
    expect(isUnchanged(loc, stored)).toBe(true);
  });
});

describe('staleClimateLocations', () => {
  const camp: ClimateLocation = { name: 'Camp', lat: -35, lon: 138 };
  const hut: ClimateLocation = { name: 'Hut', lat: -34, lon: 139, elevation: 500 };
  const data = (loc: ClimateLocation, elevation = loc.elevation ?? 120) => ({ ...loc, elevation, monthly: [] });

  it('is empty when every configured location has its data', () => {
    expect(staleClimateLocations([camp, hut], [data(hut), data(camp)])).toEqual({ missing: [], unused: [] });
  });

  it('lists a new or moved location as missing, and data nothing uses any more as unused', () => {
    const moved = { ...camp, lat: -35.1 };
    expect(staleClimateLocations([moved, hut], [data(camp), data(hut)])).toEqual({
      missing: ['Camp'],
      unused: ['Camp'],
    });
  });

  it('treats a changed configured elevation as stale, and an unconfigured one as the API height', () => {
    expect(staleClimateLocations([{ ...hut, elevation: 600 }], [data(hut)]).missing).toEqual(['Hut']);
    expect(staleClimateLocations([camp], [data(camp, 845)]).missing).toEqual([]);
  });
});

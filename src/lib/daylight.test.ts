import { describe, it, expect } from 'vitest';
import { daylightHours, dayDaylight, formatDaylightDuration } from './daylight';

describe('daylightHours', () => {
  // Reference lengths, in hours, are suncalc 1.9's sunset minus sunrise for
  // the same place and date (computed once, when this module was written).
  it.each([
    ['Melbourne, winter solstice', -37.81, '2026-06-21', 9.541],
    ['Melbourne, summer solstice', -37.81, '2026-12-22', 14.785],
    ['Alice Springs (Larapinta), July', -23.7, '2026-07-15', 10.797],
    ['Wellington (Te Araroa), December', -41.29, '2026-12-22', 15.159],
    ['Denver (CDT), June', 39.74, '2026-06-21', 14.987],
    ['Namche Bazaar, October', 27.8, '2026-10-20', 11.403],
    ['Quito, March equinox', -0.18, '2026-03-20', 12.111],
  ])('%s', (_name, latitude, date, expected) => {
    // Within two minutes.
    expect(Math.abs(daylightHours(latitude, date)! - expected)).toBeLessThan(2 / 60);
  });

  it("is longer than 12 h at the equinox everywhere, by refraction and the sun's disc", () => {
    for (const latitude of [-60, -30, 0, 30, 60]) {
      const hours = daylightHours(latitude, '2026-03-20')!;
      expect(hours).toBeGreaterThan(12);
      expect(hours).toBeLessThan(12.4);
    }
  });

  it('mirrors between hemispheres six months apart', () => {
    expect(daylightHours(45, '2026-06-21')!).toBeCloseTo(daylightHours(-45, '2026-12-21')!, 0);
  });

  it('reports polar night and the midnight sun rather than NaN', () => {
    expect(daylightHours(78, '2026-12-21')).toBe(0);
    expect(daylightHours(78, '2026-06-21')).toBe(24);
    expect(daylightHours(-90, '2026-12-21')).toBe(24);
    expect(daylightHours(90, '2026-12-21')).toBe(0);
  });

  it('handles a leap day and both ends of the year', () => {
    expect(daylightHours(-35, '2028-02-29')).toBeGreaterThan(12);
    expect(daylightHours(-35, '2026-01-01')!).toBeCloseTo(daylightHours(-35, '2026-12-31')!, 1);
  });

  it('is undefined for a latitude or a date that is not one', () => {
    expect(daylightHours(NaN, '2026-06-21')).toBeUndefined();
    expect(daylightHours(91, '2026-06-21')).toBeUndefined();
    expect(daylightHours(-37, '21/06/2026')).toBeUndefined();
    expect(daylightHours(-37, '2026-02-31')).toBeUndefined();
    expect(daylightHours(-37, '')).toBeUndefined();
  });
});

describe('dayDaylight', () => {
  it('sets the estimate beside the daylight', () => {
    // Melbourne latitude, midwinter: ~9.5 h of light.
    const fits = dayDaylight({ date: '2026-06-21', latitude: -37.81, estimatedHours: 7 })!;
    expect(fits.daylightHours).toBeCloseTo(9.5, 0);
    expect(fits.shortfallHours).toBe(0);

    const long = dayDaylight({ date: '2026-06-21', latitude: -37.81, estimatedHours: 11 })!;
    expect(long.shortfallHours).toBe(1.5);

    // A difference below the estimate's own 0.1 h precision is not a shortfall.
    expect(dayDaylight({ date: '2026-06-21', latitude: -37.81, estimatedHours: 9.57 })!.shortfallHours).toBe(0);
  });

  it('says nothing without a date or a latitude', () => {
    expect(dayDaylight({ latitude: -37.81, estimatedHours: 7 })).toBeNull();
    expect(dayDaylight({ date: '2026-06-21', estimatedHours: 7 })).toBeNull();
    expect(dayDaylight({ date: 'soon', latitude: -37.81, estimatedHours: 7 })).toBeNull();
  });
});

describe('formatDaylightDuration', () => {
  it('formats to the whole minute without printing 60 min', () => {
    expect(formatDaylightDuration(9.1666)).toBe('9 h 10 min');
    expect(formatDaylightDuration(12)).toBe('12 h');
    expect(formatDaylightDuration(5.9999)).toBe('6 h');
    expect(formatDaylightDuration(0.75)).toBe('45 min');
    expect(formatDaylightDuration(0)).toBe('0 min');
    expect(formatDaylightDuration(24)).toBe('24 h');
  });
});

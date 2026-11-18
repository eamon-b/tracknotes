import { describe, it, expect } from 'vitest';
import { daylightHours, dayDaylight } from './daylight';

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
    // The equinoxes are where the series is weakest (about two minutes out).
    ['Bluff (Te Araroa south), September equinox', -46.6, '2026-09-23', 12.163],
    ['Glacier NP (CDT north), September equinox', 48.7, '2026-09-23', 12.167],
    ['Melbourne, March equinox', -37.81, '2026-03-20', 12.163],
    // Day 366 and the leap day itself.
    ['45N, 31 December of a leap year', 45, '2028-12-31', 8.826],
    ['45S, 29 February', -45, '2028-02-29', 13.215],
  ])('%s', (_name, latitude, date, expected) => {
    // Within two and a half minutes.
    expect(Math.abs(daylightHours(latitude, date)! - expected)).toBeLessThan(2.5 / 60);
  });

  it("is longer than 12 h at the equinox everywhere, by refraction and the sun's disc", () => {
    for (const latitude of [-60, -30, 0, 30, 60]) {
      const hours = daylightHours(latitude, '2026-03-20')!;
      expect(hours).toBeGreaterThan(12);
      expect(hours).toBeLessThan(12.4);
    }
  });

  it('mirrors between hemispheres six months apart', () => {
    // suncalc gives 15.617 h for both; the two must agree to a minute.
    const north = daylightHours(45, '2026-06-21')!;
    const south = daylightHours(-45, '2026-12-21')!;
    expect(Math.abs(north - south)).toBeLessThan(1 / 60);
  });

  it('reports polar night and the midnight sun rather than NaN', () => {
    expect(daylightHours(78, '2026-12-21')).toBe(0);
    expect(daylightHours(78, '2026-06-21')).toBe(24);
    expect(daylightHours(-90, '2026-12-21')).toBe(24);
    expect(daylightHours(90, '2026-12-21')).toBe(0);
  });

  it('runs smoothly across the turn of the year', () => {
    // A minute or so a day at this latitude in midsummer; a jump would show a broken day-of-year.
    const dec31 = daylightHours(-35, '2026-12-31')!;
    const jan1 = daylightHours(-35, '2027-01-01')!;
    expect(Math.abs(dec31 - jan1)).toBeLessThan(2 / 60);
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
  // Melbourne's latitude at midwinter: 9.54 h of daylight, shown as 9.5.
  const midwinter = { date: '2026-06-21', latitude: -37.81 };

  it('gives the daylight to the 0.1 h the estimate is given to', () => {
    expect(dayDaylight({ ...midwinter, estimatedHours: 7 })).toEqual({ daylightHours: 9.5, shortfallHours: 0 });
  });

  it('reports the shortfall as the difference of the two figures shown', () => {
    expect(dayDaylight({ ...midwinter, estimatedHours: 11 })!.shortfallHours).toBe(1.5);
    // Never a line that disagrees with the card above it: 9.6 against 9.5 is 0.1 ...
    expect(dayDaylight({ ...midwinter, estimatedHours: 9.6 })!.shortfallHours).toBe(0.1);
    // ... and an estimate equal to the daylight shown is no shortfall, with no float residue.
    expect(dayDaylight({ ...midwinter, estimatedHours: 9.5 })!.shortfallHours).toBe(0);
    for (let tenths = 0; tenths <= 240; tenths++) {
      const estimatedHours = tenths / 10;
      const { daylightHours: light, shortfallHours } = dayDaylight({ ...midwinter, estimatedHours })!;
      expect(shortfallHours).toBe(Math.max(0, Math.round((estimatedHours - light) * 10) / 10));
    }
  });

  it('covers polar night and the midnight sun', () => {
    expect(dayDaylight({ date: '2026-12-21', latitude: 78, estimatedHours: 6 })).toEqual({
      daylightHours: 0,
      shortfallHours: 6,
    });
    expect(dayDaylight({ date: '2026-06-21', latitude: 78, estimatedHours: 30 })!.daylightHours).toBe(24);
  });

  it('says nothing without a date or a latitude', () => {
    expect(dayDaylight({ latitude: -37.81, estimatedHours: 7 })).toBeNull();
    expect(dayDaylight({ date: '2026-06-21', estimatedHours: 7 })).toBeNull();
    expect(dayDaylight({ date: 'soon', latitude: -37.81, estimatedHours: 7 })).toBeNull();
  });
});

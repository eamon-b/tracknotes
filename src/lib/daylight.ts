/**
 * Daylight on a planned day: how long the sun is up where the day is walked,
 * set beside how long the walk is estimated to take.
 *
 * Only the *length* of the day is worked out, never a sunrise or sunset
 * clock time. The length depends on the latitude and the date alone, so it
 * needs no time zone - and a clock time would: the trails here cross
 * half-hour zones (Heysen, Larapinta) and daylight saving, and a phone
 * carried abroad is in neither. Hours of light is also the figure a hiker
 * plans a day against.
 *
 * The maths is the standard sunrise equation with NOAA's Fourier series for
 * the sun's declination: no dependency, nothing platform-specific. Checked
 * against suncalc over a whole year it stays within about two minutes at the
 * latitudes the trails are at (worst around the equinoxes), and within about
 * five at 65 degrees.
 */

import type { ComputedDay } from './plan-types';

/**
 * Zenith angle of the sun's centre at sunrise and sunset, in degrees: 90 plus
 * 50 arc-minutes for atmospheric refraction and the sun's own radius - the
 * convention almanacs and weather services publish to.
 */
const SUNRISE_ZENITH_DEG = 90.833;

const RAD = Math.PI / 180;

/** Day of the year (1 = 1 January) of a `YYYY-MM-DD` date, or null when it is not one. */
function dayOfYear(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  // Date.UTC rolls 2026-02-31 over into March; that is not a date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.round((time - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

/**
 * Hours between sunrise and sunset at a latitude on a `YYYY-MM-DD` date:
 * 0 in polar night, 24 under the midnight sun. Undefined when the latitude or
 * the date is not usable.
 */
export function daylightHours(latitude: number, isoDate: string): number | undefined {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined;
  const n = dayOfYear(isoDate);
  if (n === null) return undefined;

  // Fractional year at local noon, then the sun's declination (NOAA).
  const gamma = ((2 * Math.PI) / 365) * (n - 1);
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // At the poles cos(latitude) is 0; just short of them the answer is the same.
  const phi = Math.max(-89.99, Math.min(89.99, latitude)) * RAD;
  const cosHourAngle =
    Math.cos(SUNRISE_ZENITH_DEG * RAD) / (Math.cos(phi) * Math.cos(declination)) -
    Math.tan(phi) * Math.tan(declination);

  if (cosHourAngle >= 1) return 0; // the sun never rises
  if (cosHourAngle <= -1) return 24; // the sun never sets
  // The hour angle is half the day's arc; the sun covers 15 degrees an hour.
  return (2 * Math.acos(cosHourAngle)) / RAD / 15;
}

/** A planned day's daylight, set beside its estimated walking time. */
export interface DayDaylight {
  /**
   * Hours from sunrise to sunset where the day is walked, on its date, to
   * 0.1 h: the precision `estimatedHours` is given to, and all the figure is
   * good for (see the accuracy note above). Show it in the same form as the
   * estimate, so the two can be read against each other.
   */
  daylightHours: number;
  /**
   * `estimatedHours` minus `daylightHours`, to 0.1 h; 0 when the walk fits.
   * Taken from the two figures as shown, so a card never disagrees with its
   * own arithmetic. Walking time only - the estimate has no breaks in it.
   */
  shortfallHours: number;
}

const toTenth = (hours: number): number => Math.round(hours * 10) / 10;

/**
 * Daylight for a computed day, or null when it cannot be said: the plan has
 * no start date (so the day has no `date`) or the day has no `latitude`.
 *
 * This reports two figures and their difference. It sets no threshold and
 * makes no call on whether a day is too long: starting before dawn or
 * walking on by torch is the hiker's decision.
 */
export function dayDaylight(day: Pick<ComputedDay, 'date' | 'latitude' | 'estimatedHours'>): DayDaylight | null {
  if (day.date === undefined || day.latitude === undefined) return null;
  const exact = daylightHours(day.latitude, day.date);
  if (exact === undefined) return null;
  const hours = toTenth(exact);
  return {
    daylightHours: hours,
    shortfallHours: toTenth(Math.max(0, day.estimatedHours - hours)),
  };
}

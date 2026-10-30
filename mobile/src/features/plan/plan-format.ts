/**
 * Plan-screen display formatting. Distance/elevation go through the shared
 * `@lib/format-distance`; this only owns the plan-specific bits (hours, food
 * weight) so the calculators' raw outputs render consistently.
 */

import { formatDistance } from '@lib/format-distance';
import type { Pace } from '@lib/plan-types';
import type { Units } from '../../state/settings-store';

/** A pace preset in words: "Slow", "Average", "Fast". */
export const PACE_LABELS: Record<Pace, string> = {
  slow: 'Slow',
  average: 'Average',
  fast: 'Fast',
};

/** Pounds per kilogram. */
const LB_PER_KG = 2.20462;

/** Grams per ounce. */
export const G_PER_OZ = 28.3495;

/** "8.0 h" — one decimal, always a unit. */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

/** "≈ 3 days" / "≈ 1 day". */
export function formatDays(days: number): string {
  return `≈ ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Food-carry weight from the calculator's estimate. Metric ('km') shows
 * kilograms; imperial ('mi') shows pounds. Always one decimal.
 *
 * @example formatFoodWeight(2, 'km') // "2.0 kg"
 * @example formatFoodWeight(2, 'mi') // "4.4 lb"
 */
export function formatFoodWeight(weightKg: number, units: Units): string {
  if (units === 'mi') {
    return `${(weightKg * LB_PER_KG).toFixed(1)} lb`;
  }
  return `${weightKg.toFixed(1)} kg`;
}

/**
 * Food per day, the input's value: grams for metric, ounces (one decimal) for
 * imperial, as `formatFoodWeight` uses pounds.
 *
 * @example formatFoodPerDay(680, 'km') // "680 g"
 * @example formatFoodPerDay(680, 'mi') // "24.0 oz"
 */
export function formatFoodPerDay(grams: number, units: Units): string {
  if (units === 'mi') {
    return `${(grams / G_PER_OZ).toFixed(1)} oz`;
  }
  return `${Math.round(grams)} g`;
}

/**
 * A dry-stretch threshold in the hiker's unit, never rounded past the figure
 * the flags use. Miles keep a decimal: 15 km is 9.3 mi, and "9 mi" would
 * understate it. Kilometres keep one when the threshold has one — 10 mi set on
 * the miles grid is 16.1 km, and "16 km" would be a figure the flag was not
 * computed from.
 *
 * @example formatDryStretch(15, 'km') // "15 km"
 * @example formatDryStretch(15, 'mi') // "9.3 mi"
 * @example formatDryStretch(16.1, 'km') // "16.1 km"
 */
export function formatDryStretch(km: number, units: Units): string {
  const decimals = units === 'mi' || Math.round(km * 10) % 10 !== 0 ? 1 : 0;
  return formatDistance(km, units, { decimals });
}

/**
 * The dry-stretch badge, in the hiker's unit. The caller passes the threshold
 * the carries were flagged against (the hiker's, from `plan-inputs-store`), so
 * the badge never names a figure the flag was not computed from.
 *
 * @example dryStretchBadge(15, 'km') // "Dry ≥ 15 km"
 * @example dryStretchBadge(15, 'mi') // "Dry ≥ 9.3 mi"
 */
export function dryStretchBadge(dryStretchKm: number, units: Units): string {
  return `Dry ≥ ${formatDryStretch(dryStretchKm, units)}`;
}

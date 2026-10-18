/**
 * Water carry distance calculator.
 *
 * Analyzes water source spacing along a trail to identify dry stretches
 * and help hikers plan water carries. Safety-critical for Australian trails.
 *
 * Shared between the web planner and the mobile app.
 */

import type { PlanWaypoint, WaterGap } from './plan-types';
import { placeWalk } from './day-calculator';
import { isWaterWaypoint } from './waypoint-taxonomy';

export type { WaterGap };

export interface WaterSource {
  name: string;
  km: number;
  type: string;
  seasonalNote?: string;
  /**
   * The walk from the route to the source, one way, when it is off the route
   * (`placeWalk`): it is carried twice, in to the source on the carry before
   * it and back out on the carry after.
   */
  offTrailKm?: number;
}

export interface WaterCarryAnalysis {
  sources: WaterSource[];
  gaps: WaterGap[];
  longestGapKm: number;
  dryStretchCount: number;
  hasWaterData: boolean;
}

// The dry-stretch threshold is the hiker's (`PlanThresholds.dryStretchKm` in
// plan-types), so the functions below require it rather than defaulting.

const SEASONAL_KEYWORDS = ['seasonal', 'dry in summer', 'dries up', 'unreliable', 'not reliable', 'intermittent', 'may be dry', 'often dry'];

/**
 * Extract water sources from trail waypoints, sorted by km.
 */
export function extractWaterSources(waypoints: PlanWaypoint[]): WaterSource[] {
  return waypoints
    .filter(wp => isWaterWaypoint(wp.type))
    .map(wp => {
      let seasonalNote: string | undefined;
      if (wp.description) {
        const lower = wp.description.toLowerCase();
        if (SEASONAL_KEYWORDS.some(kw => lower.includes(kw))) {
          seasonalNote = wp.description;
        }
      }
      const walk = placeWalk(wp);
      return {
        name: wp.name ?? 'Water',
        km: wp.totalDistance ?? 0,
        type: wp.type ?? 'water',
        seasonalNote,
        ...(walk ? { offTrailKm: walk.km } : {}),
      };
    })
    // At one km, the source nearest the route first: it is the one to use.
    .sort((a, b) => a.km - b.km || (a.offTrailKm ?? 0) - (b.offTrailKm ?? 0));
}

/**
 * Compute gaps between consecutive water sources, including trail start/end.
 *
 * A carry is measured as walked: the route km between the two sources, plus
 * the walk back to the route from the one it starts at and the walk in to the
 * one it ends at when they are off the route. A source 2 km down a side
 * valley adds 2 km to the carry on each side of it, which is how far the
 * water has to last.
 *
 * With no sources the whole range is one gap, start to end. Whether that
 * means "dry" or "unmapped" is the caller's to say (`hasWaterData`); what this
 * must never do is report a waterless range as having no carry at all.
 */
export function computeWaterGaps(
  sources: WaterSource[],
  trailStartKm: number,
  trailEndKm: number,
  dryStretchThreshold: number,
): WaterGap[] {
  // NaN would flag nothing, which is the dangerous way to be wrong.
  if (!Number.isFinite(dryStretchThreshold)) {
    throw new RangeError(`computeWaterGaps: dryStretchThreshold must be a number, got ${String(dryStretchThreshold)}`);
  }
  const effectiveThreshold = Math.max(0, dryStretchThreshold);
  const gaps: WaterGap[] = [];

  if (sources.length === 0) {
    const dist = trailEndKm - trailStartKm;
    if (dist > 0) {
      gaps.push({
        fromName: 'Trail Start',
        toName: 'Trail End',
        fromKm: trailStartKm,
        toKm: trailEndKm,
        distanceKm: Math.round(dist * 10) / 10,
        isDryStretch: dist >= effectiveThreshold,
      });
    }
    return gaps;
  }

  // A source is no use when another is reached for no more walking: one at the
  // same km nearer the route, or one on the route a short way along from a
  // tap 2.4 km down a side valley. Keeping it would list a carry from the far
  // tap to the near one that nobody walks. Ties keep the first.
  const reach = (s: WaterSource) => s.offTrailKm ?? 0;
  const deduped = sources.filter((s, i) =>
    !sources.some((t, j) => {
      if (j === i) return false;
      const cost = Math.abs(t.km - s.km) + reach(t);
      return cost < reach(s) || (cost === reach(s) && j < i && t.km === s.km);
    }),
  );

  const carry = (
    fromName: string,
    toName: string,
    fromKm: number,
    toKm: number,
    walkOut: number,
    walkIn: number,
  ) => {
    const dist = toKm - fromKm;
    if (dist <= 0) return;
    const total = dist + walkOut + walkIn;
    gaps.push({
      fromName,
      toName,
      fromKm,
      toKm,
      distanceKm: Math.round(total * 10) / 10,
      isDryStretch: total >= effectiveThreshold,
      ...(walkOut > 0 ? { fromOffTrailKm: walkOut } : {}),
      ...(walkIn > 0 ? { toOffTrailKm: walkIn } : {}),
    });
  };

  const first = deduped[0];
  carry('Trail Start', first.name, trailStartKm, first.km, 0, first.offTrailKm ?? 0);
  for (let i = 0; i < deduped.length - 1; i++) {
    const from = deduped[i];
    const to = deduped[i + 1];
    carry(from.name, to.name, from.km, to.km, from.offTrailKm ?? 0, to.offTrailKm ?? 0);
  }
  const last = deduped[deduped.length - 1];
  carry(last.name, 'Trail End', last.km, trailEndKm, last.offTrailKm ?? 0, 0);

  return gaps;
}

/**
 * Full water carry analysis for a trail.
 *
 * Returns sources, gaps between them, dry stretch warnings, and whether
 * the trail has any water data at all.
 */
export function analyzeWaterCarry(
  waypoints: PlanWaypoint[],
  totalDistanceKm: number,
  dryStretchThreshold: number,
): WaterCarryAnalysis {
  const sources = extractWaterSources(waypoints);
  const hasWaterData = sources.length > 0;

  if (!hasWaterData) {
    return { sources: [], gaps: [], longestGapKm: 0, dryStretchCount: 0, hasWaterData: false };
  }

  const gaps = computeWaterGaps(sources, 0, totalDistanceKm, dryStretchThreshold);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const dryStretchCount = gaps.filter(g => g.isDryStretch).length;

  return { sources, gaps, longestGapKm, dryStretchCount, hasWaterData };
}

/**
 * Get water sources and gaps scoped to a section of trail.
 *
 * A section with no source in it, on a trail that maps water elsewhere, is one
 * carry from the section start to its end — a dry stretch when it is long
 * enough — and `hasWaterData` stays true: the trail's data says there is no
 * water here, which is the most important carry to report, not a reason to
 * report none. Only a trail with no water sources at all is `hasWaterData:
 * false` ("no mapped water sources"), because then the absence says nothing.
 */
export function analyzeWaterCarryForSection(
  waypoints: PlanWaypoint[],
  startKm: number,
  endKm: number,
  dryStretchThreshold: number,
): WaterCarryAnalysis {
  const allSources = extractWaterSources(waypoints);
  const sectionSources = allSources.filter(s => s.km >= startKm && s.km <= endKm);

  if (allSources.length === 0) {
    return { sources: [], gaps: [], longestGapKm: 0, dryStretchCount: 0, hasWaterData: false };
  }

  const gaps = computeWaterGaps(sectionSources, startKm, endKm, dryStretchThreshold);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const dryStretchCount = gaps.filter(g => g.isDryStretch).length;

  return {
    sources: sectionSources,
    gaps,
    longestGapKm,
    dryStretchCount,
    hasWaterData: true,
  };
}

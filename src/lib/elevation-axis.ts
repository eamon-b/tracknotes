/**
 * The default elevation axis of a profile, shared by the phone's elevation
 * pane and the web trail page so the same climb looks the same on both: from
 * 0 m (sea level) to just above the trail's high point, rather than fitted to
 * its low and high points — fitting stretches a 40 m rise on a coastal walk
 * into a cliff. The axis only drops below 0 m for a track that does.
 */

/** The limits an elevation window is kept inside (see `eleBounds`). */
export interface EleBounds {
  /** Lowest the window may start: 0 m, or the trail's low point if below sea level. */
  floorM: number;
  /** Highest the window may reach while zoomed in: just above the trail's high point. */
  ceilingM: number;
}

/** Smallest elevation span (m) the y-axis can zoom into. */
export const MIN_ELE_SPAN_M = 50;

/** Round `v` up to a "nice" step (1, 2, 5 × 10^n) of roughly a tenth of it. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(v / 10)));
  for (const step of [1, 2, 5, 10]) {
    const s = step * magnitude;
    if (v / s <= 20) return Math.ceil(v / s) * s;
  }
  return Math.ceil(v / (10 * magnitude)) * 10 * magnitude;
}

/**
 * The elevation bounds of a track: a floor at 0 m (or the track's low point,
 * should it dip below sea level) and a ceiling rounded up just above its high
 * point. The default y-axis is exactly this range.
 */
export function eleBounds(points: readonly { ele: number }[]): EleBounds {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.ele)) continue;
    if (p.ele < lo) lo = p.ele;
    if (p.ele > hi) hi = p.ele;
  }
  const floorM = lo < 0 ? -niceCeil(-lo) : 0;
  const ceilingM = Math.max(hi > 0 ? niceCeil(hi) : 0, floorM + MIN_ELE_SPAN_M);
  return { floorM, ceilingM };
}

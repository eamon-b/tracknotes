/**
 * Pure geometry helpers for the elevation profile: window (zoom range)
 * clamping, deriving a committed window from a live gesture transform, and
 * pixel-space hit-testing for waypoint markers and the crosshair snap.
 *
 * All functions are React-/Skia-free so they can be unit-tested directly and
 * (for the small arithmetic ones) safely inlined into gesture worklets.
 */

import { findNearestByDistance } from '@lib/track-geometry';

/** A visible distance range [startKm, endKm] along the trail. */
export interface KmWindow {
  startKm: number;
  endKm: number;
}

/**
 * Smallest window the user can zoom into, in km. At 1 km the distance axis
 * still labels cleanly (0.2 km steps) and a single switchback is legible.
 */
export const MIN_WINDOW_KM = 1;

/**
 * Clamp a candidate window to [0, totalKm] while keeping a sane span:
 *  - span is floored at `minWindowKm` (or the whole trail if it is shorter),
 *  - the window is shifted (not squashed) back inside the trail if it runs off
 *    either end, so the requested span is preserved where possible.
 */
export function clampWindow(
  startKm: number,
  endKm: number,
  totalKm: number,
  minWindowKm = MIN_WINDOW_KM,
): KmWindow {
  if (!(totalKm > 0)) return { startKm: 0, endKm: 0 };

  let start = Math.min(startKm, endKm);
  let end = Math.max(startKm, endKm);

  const maxSpan = totalKm;
  const minSpan = Math.min(minWindowKm, totalKm);
  let span = Math.min(Math.max(end - start, minSpan), maxSpan);

  // Re-center the (possibly resized) span on the original midpoint.
  const mid = (start + end) / 2;
  start = mid - span / 2;
  end = start + span;

  // Shift inside [0, totalKm] without changing the span.
  if (start < 0) {
    start = 0;
    end = span;
  }
  if (end > totalKm) {
    end = totalKm;
    start = totalKm - span;
  }
  if (start < 0) start = 0;

  return { startKm: start, endKm: end };
}

/**
 * The same stretch of ground with the km renumbered from the other end — what
 * a direction flip does to every km on the profile. Clamped, so a window
 * already at the trail's edge cannot slip past the new zero.
 */
export function mirrorWindow(window: KmWindow, totalKm: number): KmWindow {
  return clampWindow(totalKm - window.endKm, totalKm - window.startKm, totalKm);
}

/** Horizontal plot geometry needed to map km <-> x. */
export interface PlotLayout {
  /** Left inset (px) where the plot area starts. */
  left: number;
  /** Plot area width (px). */
  chartWidth: number;
}

/**
 * Park a window of `span` km inside [0, totalKm] by *shifting* it — the span is
 * never squashed (only capped at the trail length), so dragging past either end
 * simply rests against it.
 */
function shiftIntoRange(startKm: number, span: number, totalKm: number): KmWindow {
  const fitted = Math.min(span, totalKm);
  const maxStart = totalKm - fitted;
  let start = startKm;
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return { startKm: start, endKm: start + fitted };
}

/**
 * Shift a window horizontally by a finger drag, preserving its span.
 *
 * The content follows the finger: dragging **right** (positive `translationX`)
 * moves the window *earlier* along the trail. Degenerate inputs (no width, no
 * span, no trail) return the base window unchanged.
 */
export function panWindowByPixels(
  base: KmWindow,
  translationXPx: number,
  chartWidth: number,
  totalKm: number,
): KmWindow {
  const span = base.endKm - base.startKm;
  if (!(span > 0) || !(chartWidth > 0) || !(totalKm > 0)) {
    return { startKm: base.startKm, endKm: base.endKm };
  }
  const dxKm = (translationXPx / chartWidth) * span;
  return shiftIntoRange(base.startKm - dxKm, span, totalKm);
}

/**
 * Pinch-zoom a window about a focal pixel: the km sitting under `focalX` stays
 * under `focalX`, so the trail expands/contracts around the user's fingers.
 *
 * `scale` > 1 zooms in (smaller span). The span is clamped to
 * [`minWindowKm`, `totalKm`] and the result shifted back inside the trail — at
 * the ends that means the focal point drifts rather than the window escaping.
 */
export function zoomWindowAtFocal(
  base: KmWindow,
  scale: number,
  focalX: number,
  layout: PlotLayout,
  totalKm: number,
  minWindowKm = MIN_WINDOW_KM,
): KmWindow {
  const baseSpan = base.endKm - base.startKm;
  if (!(baseSpan > 0) || !(layout.chartWidth > 0) || !(totalKm > 0)) {
    return { startKm: base.startKm, endKm: base.endKm };
  }
  const factor = scale > 0 ? scale : 1;
  const minSpan = Math.min(Math.max(minWindowKm, 1e-6), totalKm);
  const span = Math.min(Math.max(baseSpan / factor, minSpan), totalKm);
  // Where the focal point sits across the plot (clamped so a focal point in the
  // y-axis gutter anchors on the left edge instead of extrapolating).
  const frac = Math.min(Math.max((focalX - layout.left) / layout.chartWidth, 0), 1);
  const focalKm = base.startKm + frac * baseSpan;
  return shiftIntoRange(focalKm - frac * span, span, totalKm);
}

// --- Elevation (y) axis ------------------------------------------------------
//
// The y-axis does not auto-fit the visible km window: stretching whatever relief
// is on screen to the full plot height turns a 40 m rise into a cliff and makes
// every section look equally brutal. Instead it shows a fixed elevation range
// the hiker controls — by default the whole trail from 0 m (sea level) to just
// above its highest point, so the horizontal axis sits at 0 m and one stretch
// can be compared with another by eye. A vertical pinch zooms it.

/** A visible elevation range [minM, maxM], in metres. */
export interface EleWindow {
  minM: number;
  maxM: number;
}

/** The limits an elevation window is kept inside (see `eleBounds`). */
export interface EleBounds {
  /** Lowest the window may start: 0 m, or the trail's low point if below sea level. */
  floorM: number;
  /** Highest the window may reach while zoomed in: just above the trail's high point. */
  ceilingM: number;
}

/** Smallest elevation span (m) the y-axis can zoom into. */
export const MIN_ELE_SPAN_M = 50;
/** How far past the whole trail the y-axis can zoom *out* (flattening it). */
export const MAX_ELE_ZOOM_OUT = 4;

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

/** The whole-trail elevation window: floor to ceiling. */
export function defaultEleWindow(bounds: EleBounds): EleWindow {
  return { minM: bounds.floorM, maxM: bounds.ceilingM };
}

/**
 * Clamp a candidate elevation window:
 *  - the span is kept within [`MIN_ELE_SPAN_M`, whole trail × `MAX_ELE_ZOOM_OUT`],
 *    re-centred on the requested midpoint,
 *  - a window no taller than the trail is shifted (not squashed) inside
 *    [floor, ceiling], so panning rests against either end,
 *  - a window taller than the trail (zoomed out) sits on the floor: the axis
 *    keeps starting at 0 m and the extra room goes above the high point.
 */
export function clampEleWindow(minM: number, maxM: number, bounds: EleBounds): EleWindow {
  const full = bounds.ceilingM - bounds.floorM;
  if (!(full > 0)) return defaultEleWindow(bounds);
  const lo = Math.min(minM, maxM);
  const hi = Math.max(minM, maxM);
  const span = Math.min(Math.max(hi - lo, Math.min(MIN_ELE_SPAN_M, full)), full * MAX_ELE_ZOOM_OUT);
  if (span >= full) return { minM: bounds.floorM, maxM: bounds.floorM + span };
  let start = (lo + hi) / 2 - span / 2;
  if (start < bounds.floorM) start = bounds.floorM;
  if (start + span > bounds.ceilingM) start = bounds.ceilingM - span;
  return { minM: start, maxM: start + span };
}

/** Vertical plot geometry needed to map metres <-> y. */
export interface PlotLayoutY {
  /** Top inset (px) where the plot area starts. */
  top: number;
  /** Plot area height (px). */
  chartHeight: number;
}

/**
 * Pinch-zoom an elevation window about a focal pixel: the elevation under
 * `focalY` stays under it. `scale` > 1 zooms in (a smaller span, exaggerating
 * the relief); < 1 flattens it.
 */
export function zoomEleWindowAtFocal(
  base: EleWindow,
  scale: number,
  focalY: number,
  layout: PlotLayoutY,
  bounds: EleBounds,
): EleWindow {
  const baseSpan = base.maxM - base.minM;
  if (!(baseSpan > 0) || !(layout.chartHeight > 0)) return { ...base };
  const factor = scale > 0 ? scale : 1;
  const span = baseSpan / factor;
  // Fraction up from the plot floor (clamped, so a focal point in the x-axis
  // gutter anchors on the floor rather than extrapolating).
  const frac = Math.min(Math.max((layout.top + layout.chartHeight - focalY) / layout.chartHeight, 0), 1);
  const focalM = base.minM + frac * baseSpan;
  const minM = focalM - frac * span;
  return clampEleWindow(minM, minM + span, bounds);
}

/**
 * Shift an elevation window by a vertical finger drag, preserving its span.
 * The content follows the finger: dragging **down** shows higher ground.
 */
export function panEleWindowByPixels(
  base: EleWindow,
  translationYPx: number,
  chartHeight: number,
  bounds: EleBounds,
): EleWindow {
  const span = base.maxM - base.minM;
  if (!(span > 0) || !(chartHeight > 0)) return { ...base };
  const dyM = (translationYPx / chartHeight) * span;
  return clampEleWindow(base.minM + dyM, base.maxM + dyM, bounds);
}

/**
 * Step the elevation zoom from a button: the window's floor stays put and only
 * its top moves, so from the default view the axis keeps starting at 0 m.
 * `factor` > 1 zooms in.
 */
export function scaleEleWindow(base: EleWindow, factor: number, bounds: EleBounds): EleWindow {
  const span = base.maxM - base.minM;
  const full = bounds.ceilingM - bounds.floorM;
  if (!(span > 0) || !(factor > 0) || !(full > 0)) return { ...base };
  // Clamp the span here, so the clamp below never has to re-centre (and so
  // move the floor) to fit it.
  const next = Math.min(Math.max(span / factor, Math.min(MIN_ELE_SPAN_M, full)), full * MAX_ELE_ZOOM_OUT);
  return clampEleWindow(base.minM, base.minM + next, bounds);
}

/** Which axes a two-finger pinch zooms. */
export interface PinchAxes {
  x: boolean;
  y: boolean;
}

/**
 * Pick the axes a pinch zooms from how the two fingers were placed: side by
 * side zooms distance, one above the other zooms elevation, and a diagonal
 * (30°–60°) zooms both.
 */
export function pinchAxes(dx: number, dy: number): PinchAxes {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === 0 && ay === 0) return { x: true, y: false };
  const angle = (Math.atan2(ay, ax) * 180) / Math.PI;
  if (angle < 30) return { x: true, y: false };
  if (angle > 60) return { x: false, y: true };
  return { x: true, y: true };
}

/** Convert an elevation (m) to a screen y (px) within the elevation window. */
export function eleToY(ele: number, window: EleWindow, layout: PlotLayoutY): number {
  const span = window.maxM - window.minM;
  if (!(span > 0)) return layout.top + layout.chartHeight;
  return layout.top + layout.chartHeight - ((ele - window.minM) / span) * layout.chartHeight;
}

/** A rendered waypoint marker in pixel space. */
export interface MarkerHit {
  id: string;
  x: number;
  y: number;
}

/**
 * Nearest marker to a tap within `radius` px, or null. When several markers
 * fall inside the radius the closest (Euclidean) one wins.
 */
export function hitTestMarkers(
  markers: MarkerHit[],
  tapX: number,
  tapY: number,
  radius: number,
): string | null {
  let bestId: string | null = null;
  let bestDistSq = radius * radius;
  for (const m of markers) {
    const dx = m.x - tapX;
    const dy = m.y - tapY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      bestId = m.id;
    }
  }
  return bestId;
}

/**
 * What a marker stands for. Waypoints are the curated ones; POIs are the
 * uncurated OpenStreetMap leads, drawn as hollow rings and routed to their own
 * detail screen — so the kind travels with the marker rather than the tap
 * handler having to guess from the id.
 */
export type ProfileMarkerKind = 'waypoint' | 'poi';

/** A waypoint (or POI) the profile can mark on the trace. */
export interface ProfileMarkerInput {
  id: string;
  type: string;
  /** Defaults to 'waypoint'. */
  kind?: ProfileMarkerKind;
  totalDistance?: number;
  elevation?: number;
}

/** A resolved marker in pixel space, with its paint (color + radius + fill). */
export interface ProfileMarker {
  id: string;
  kind: ProfileMarkerKind;
  x: number;
  y: number;
  color: string;
  radius: number;
  /** false → a stroke-only ring (POI ticks); true → a filled dot. */
  fill: boolean;
}

/** The plot geometry a marker is placed into (all px, plus the km window). */
export interface MarkerPlot {
  startKm: number;
  endKm: number;
  /** Left inset (px) where the plot area starts. */
  left: number;
  /** Plot area width (px). */
  chartWidth: number;
  /** Top inset (px) of the plot area. */
  top: number;
  /** Plot area height (px). */
  chartHeight: number;
  /** Elevation-domain minimum (metres) mapped to the plot floor. */
  eleMin: number;
  /** Elevation-domain span (metres); must be non-zero. */
  eleRange: number;
}

/**
 * Place waypoint markers on the elevation trace. Pure so favorite emphasis and
 * windowing are unit-testable without Skia: markers outside the km or elevation
 * window (or with no distance) are dropped, and `resolve` supplies each marker's color, radius
 * and fill so the caller routes favorite/category colors through the theme and
 * decides which markers are hollow (omitted `fill` means a filled dot).
 */
export function buildProfileMarkers(
  waypoints: ProfileMarkerInput[],
  plot: MarkerPlot,
  resolve: (wp: ProfileMarkerInput) => { color: string; radius: number; fill?: boolean },
): ProfileMarker[] {
  const span = Math.max(plot.endKm - plot.startKm, 1e-6);
  const out: ProfileMarker[] = [];
  for (const wp of waypoints) {
    if (wp.totalDistance == null) continue;
    if (wp.totalDistance < plot.startKm || wp.totalDistance > plot.endKm) continue;
    const x = plot.left + ((wp.totalDistance - plot.startKm) / span) * plot.chartWidth;
    const ele = wp.elevation ?? plot.eleMin;
    const y = plot.top + plot.chartHeight - ((ele - plot.eleMin) / plot.eleRange) * plot.chartHeight;
    // Above or below the elevation window (the y-axis is zoomed): the trace is
    // clipped there, and a marker left floating over the frame would still
    // catch taps.
    if (y < plot.top - 0.5 || y > plot.top + plot.chartHeight + 0.5) continue;
    const { color, radius, fill } = resolve(wp);
    out.push({ id: wp.id, kind: wp.kind ?? 'waypoint', x, y, color, radius, fill: fill ?? true });
  }
  return out;
}

/** A track point carrying at least distance + elevation. */
export interface DistEle {
  dist: number;
  ele: number;
}

/**
 * Snap a km position to the nearest track point (for the crosshair readout).
 * `points` must be sorted ascending by `dist` (binary search).
 */
export function nearestPointByKm<T extends DistEle>(points: T[], km: number): T | null {
  if (points.length === 0) return null;
  return points[findNearestByDistance(points, km)] ?? null;
}

/** Convert a screen x (px) to a km position within the given window/layout. */
export function xToKm(x: number, window: KmWindow, layout: PlotLayout): number {
  const span = window.endKm - window.startKm;
  if (!(layout.chartWidth > 0)) return window.startKm;
  return window.startKm + ((x - layout.left) / layout.chartWidth) * span;
}

/**
 * Convert a km position to a screen x (px) within the window/layout — the
 * inverse of `xToKm`. Used for every windowed overlay (ticks, GPS marker,
 * crosshair) so they all track the same zoom transform.
 */
export function kmToX(km: number, window: KmWindow, layout: PlotLayout): number {
  const span = window.endKm - window.startKm;
  if (!(span > 0)) return layout.left;
  return layout.left + ((km - window.startKm) / span) * layout.chartWidth;
}

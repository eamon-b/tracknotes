/**
 * Direction reversal for route variants (alternates and side trips).
 *
 * Shared by the web trail viewer and the mobile app (via Metro `@lib`).
 *
 * Variant waypoint `totalDistance` semantics (set by build-trails
 * enrichVariantWaypoints): when the variant has a junction with the main
 * track (`startDistance` set), it is ABSOLUTE trail km — junction km plus the
 * distance walked along the variant. When the variant never attaches to the
 * main track (`startDistance` undefined), it falls back to variant-relative
 * km. The reversal functions below only transform attached variants; an
 * unattached variant's relative km have no junction to mirror, so it is
 * returned untouched rather than corrupted.
 *
 * A variant attached to a parent alternate rather than to the main route
 * (`parent` set by the ingest pass, `attachVariantsToParents`) has, at that end,
 * a km measured *along the parent*: the parent's `startDistance` plus the walk
 * along it from its `points[0]`. Mirroring that about the main route puts the
 * junction where the main route is at that km, which can be nowhere near the
 * parent (the CDT's Storm Lake Creek Road, 63 km along the Anaconda Cutoff,
 * came out about 150 km off). So such an end moves with its parent instead:
 * with the parent turned round, a km `k` along it becomes
 * `parentNew.startDistance + parent.distance - (k - parentOld.startDistance)`;
 * along a one-junction parent, which keeps reading out from its junction,
 * `parentNew.startDistance + (k - parentOld.startDistance)`.
 * Which end is on the parent is read from the ingest's own record: an end
 * attached to the main route carries its `startTrackIndex`/`endTrackIndex`, an
 * end attached to an alternate never does. Such an end is taken to be on the
 * parent when its km falls within the parent's length (and, where both lines
 * have points, its end point is beside the parent's line), else on whichever
 * other alternate fits; one that fits none mirrors about the main route as
 * before. The variant's waypoints count from its `startDistance`, so they
 * follow the corrected junction.
 *
 * A variant with a single junction - a terminus, a dead-end side trip, an
 * alternate that never rejoins (the Bibbulmun's hitch into Denmark) - leaves
 * the trail and does not come back, so which way the trail is walked does not
 * change which end of it is the junction. It keeps the one shape every reader
 * expects of it, `startDistance` only with `points[0]` at the junction, and
 * only the junction km mirrors. One attached at its last point only (written by
 * an ingest from before such variants were turned round) comes out in that
 * same shape: its junction mirrored, its points and waypoints turned round.
 */

/** The km/statistics fields the reversal math needs on a variant waypoint. */
export interface VariantWaypointKmFields {
  /** Segment distance from previous variant waypoint (variant-relative) in km */
  distance: number;
  /** Absolute trail km (attached variants) or variant-relative km (unattached) */
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
}

/** Structural shape both web and mobile RouteVariant types satisfy. */
export interface ReversibleVariant {
  /** Distance along main trail where variant starts (km) */
  startDistance?: number;
  /** Distance along main trail where variant ends (km, alternates only) */
  endDistance?: number;
  /** Total length of the variant in km */
  distance?: number;
  /** How far the branch end sits from what it attached to (m), when recorded */
  startOffsetMeters?: number;
  /** The same residual for the rejoin end */
  endOffsetMeters?: number;
  points?: unknown[];
  waypoints?: VariantWaypointKmFields[];
}

function roundKm(km: number): number {
  return Math.round(km * 100) / 100;
}

/** What the junction mapper reads off a variant: its junction km, length, ends' offsets and line. */
export interface JunctionVariant {
  startDistance?: number;
  endDistance?: number;
  distance?: number;
  startOffsetMeters?: number;
  endOffsetMeters?: number;
  /** Unknown so any point shape fits; entries without a numeric lat/lon are skipped. */
  points?: readonly unknown[];
}

/** The junction mapper's view of a variant, with the ingest's attachment record. */
interface ParentAwareVariant extends JunctionVariant {
  name?: string;
  /** Main-route point index of the branch junction; absent when that end is on an alternate. */
  startTrackIndex?: number;
  /** Main-route point index of the rejoin junction; absent when that end is on an alternate. */
  endTrackIndex?: number;
  /** The alternate this variant hangs off (index into the trail's `alternates`). */
  parent?: { name?: string; index?: number };
}

/** Slack (km) on a parent's span for the ingest's 0.01 km rounding of both km. */
const PARENT_SPAN_SLACK_KM = 0.05;

/**
 * How far (km) a variant's end point may sit from a parent's line and still be
 * taken as attached to it, on top of any recorded junction offset. The ingest
 * attaches within 500 m by default; the phone's lines are thinned.
 */
const PARENT_LINE_SLACK_KM = 1;

function latLon(point: unknown): { lat: number; lon: number } | null {
  const p = point as { lat?: unknown; lon?: unknown } | null;
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
  return { lat: p.lat, lon: p.lon };
}

/**
 * Distance (km) from a position to the nearest point of the line through
 * `points`, equirectangular (junction-scale distances only), or null when the
 * line has no positions.
 */
function distanceToLineKm(at: { lat: number; lon: number }, points: readonly unknown[]): number | null {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = kmPerDegLat * Math.cos((at.lat * Math.PI) / 180);
  let best = Infinity;
  let prev: { x: number; y: number } | null = null;
  for (const point of points) {
    const p = latLon(point);
    if (!p) continue;
    const cur = { x: (p.lon - at.lon) * kmPerDegLon, y: (p.lat - at.lat) * kmPerDegLat };
    let d = cur.x * cur.x + cur.y * cur.y;
    if (prev) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const len2 = dx * dx + dy * dy;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2));
        d = Math.min(d, (prev.x + t * dx) ** 2 + (prev.y + t * dy) ** 2);
      }
    }
    if (d < best) best = d;
    prev = cur;
  }
  return best === Infinity ? null : Math.sqrt(best);
}

/**
 * Where each junction of a trail's variants goes when the trail is walked the
 * other way (see the module note). Built once per reversal over the trail's
 * *stored* alternates, which are the only possible parents.
 */
export interface JunctionMapper {
  /**
   * The reversed-direction km of a variant's stored `startDistance` (`'start'`)
   * or `endDistance` (`'end'`): mirrored about the main route for an end on
   * the main route, carried along the parent for an end on an alternate.
   * Rounded to 0.01 km as the reversed variants are, unless `exact` (the POI
   * mirror, which has always mirrored about the main route unrounded).
   */
  junctionKm(variant: JunctionVariant, end: 'start' | 'end', exact?: boolean): number;
  /**
   * The reversed `startDistance` of an attached variant read as an alternate
   * (its old rejoin when it has two junctions, else its one junction), or
   * undefined when it has no junction.
   */
  newStart(variant: JunctionVariant): number | undefined;
}

export function createJunctionMapper(
  alternates: readonly JunctionVariant[] | undefined,
  totalDistance: number
): JunctionMapper {
  const parents = (alternates ?? []) as readonly ParentAwareVariant[];
  const memo = new Map<JunctionVariant, number | undefined>();
  const inProgress = new Set<JunctionVariant>();

  const spans = (line: ParentAwareVariant, km: number): boolean => {
    if (line.startDistance == null) return false;
    const along = km - line.startDistance;
    return along >= -PARENT_SPAN_SLACK_KM && along <= (line.distance ?? 0) + PARENT_SPAN_SLACK_KM;
  };

  /** Whether the variant's end point is beside `line` (true when either has no positions to say). */
  const touches = (variant: ParentAwareVariant, end: 'start' | 'end', line: ParentAwareVariant): boolean => {
    const points = variant.points ?? [];
    const at = latLon(end === 'start' ? points[0] : points[points.length - 1]);
    if (!at) return true;
    const gap = distanceToLineKm(at, line.points ?? []);
    if (gap === null) return true;
    const offsetM = (end === 'start' ? variant.startOffsetMeters : variant.endOffsetMeters) ?? 0;
    return gap <= PARENT_LINE_SLACK_KM + offsetM / 1000;
  };

  /** The alternate a variant's end is attached to, or undefined for the main route. */
  const lineOf = (variant: ParentAwareVariant, end: 'start' | 'end', km: number): ParentAwareVariant | undefined => {
    if (!variant.parent) return undefined;
    if ((end === 'start' ? variant.startTrackIndex : variant.endTrackIndex) !== undefined) return undefined;
    const fits = (line: ParentAwareVariant | undefined): line is ParentAwareVariant =>
      line !== undefined && line !== variant && spans(line, km) && touches(variant, end, line);
    const index = variant.parent.index;
    const named = typeof index === 'number' ? parents[index] : undefined;
    if (fits(named) && (variant.parent.name === undefined || named.name === variant.parent.name)) return named;
    return parents.find(fits);
  };

  const mirrored = (km: number): number => roundKm(totalDistance - km);

  const newStartOf = (line: ParentAwareVariant): number | undefined => {
    if (memo.has(line)) return memo.get(line);
    if (line.startDistance == null && line.endDistance == null) return undefined;
    const end = line.endDistance != null ? 'end' : 'start';
    const km = (end === 'end' ? line.endDistance : line.startDistance) as number;
    // A chain that leads back to itself has nothing to hang from: mirror it.
    if (inProgress.has(line)) return mirrored(km);
    inProgress.add(line);
    const result = mapKm(line, end, km);
    inProgress.delete(line);
    memo.set(line, result);
    return result;
  };

  const mapKm = (variant: ParentAwareVariant, end: 'start' | 'end', km: number, exact = false): number => {
    const mirror = (): number => (exact ? totalDistance - km : mirrored(km));
    const line = lineOf(variant, end, km);
    if (!line) return mirror();
    const lineStart = newStartOf(line);
    if (lineStart === undefined) return mirror();
    const along = Math.max(0, km - (line.startDistance as number));
    // A two-junction parent is turned round (`turnRound`); a one-junction one
    // keeps reading out from its junction (`mirrorStartJunction`).
    return line.endDistance != null
      ? roundKm(lineStart + Math.max(0, (line.distance ?? 0) - along))
      : roundKm(lineStart + along);
  };

  return {
    junctionKm(variant, end, exact) {
      const km = end === 'start' ? variant.startDistance : variant.endDistance;
      if (km == null) throw new RangeError(`junctionKm: the variant has no ${end} junction`);
      return mapKm(variant as ParentAwareVariant, end, km, exact);
    },
    newStart(variant) {
      if (variant.startDistance == null && variant.endDistance == null) return undefined;
      return variant.endDistance != null
        ? mapKm(variant as ParentAwareVariant, 'end', variant.endDistance)
        : mapKm(variant as ParentAwareVariant, 'start', variant.startDistance as number);
    },
  };
}

/**
 * Turn a variant round about its far end: the waypoints' along-variant km run
 * from the other end, their order and per-segment climb flip, and `points`
 * reverses. `oldStart` is the km the waypoints are currently counted from,
 * `newStart` the km they will be counted from.
 */
function turnRound<V extends ReversibleVariant>(variant: V, oldStart: number, newStart: number): V {
  const variantLen = variant.distance ?? 0;
  const pointCount = variant.points?.length ?? 0;

  let waypoints = variant.waypoints;
  if (waypoints && waypoints.length > 0) {
    const reordered = [...waypoints].reverse().map(wp => {
      const alongVariant = Math.max(0, wp.totalDistance - oldStart);
      const newAlongVariant = Math.max(0, variantLen - alongVariant);
      return {
        ...wp,
        totalDistance: roundKm(newStart + newAlongVariant),
        ascent: wp.descent,
        descent: wp.ascent,
        variantTrackIndex: pointCount > 0 ? pointCount - 1 - wp.variantTrackIndex : 0,
      };
    });

    let runningAscent = 0;
    let runningDescent = 0;
    let prevAbs = newStart;
    waypoints = reordered.map(wp => {
      const distance = roundKm(Math.max(0, wp.totalDistance - prevAbs));
      prevAbs = wp.totalDistance;
      runningAscent += wp.ascent;
      runningDescent += wp.descent;
      return { ...wp, distance, totalAscent: runningAscent, totalDescent: runningDescent };
    });
  }

  // The two ends trade places along with the points, so a residual recorded
  // against one end has to travel with it — and one recorded against neither
  // must not appear as an `undefined` key on the other.
  const { startOffsetMeters, endOffsetMeters, ...rest } = variant;
  const offsets: Pick<ReversibleVariant, 'startOffsetMeters' | 'endOffsetMeters'> = {};
  if (endOffsetMeters !== undefined) offsets.startOffsetMeters = endOffsetMeters;
  if (startOffsetMeters !== undefined) offsets.endOffsetMeters = startOffsetMeters;

  return {
    ...rest,
    ...offsets,
    points: variant.points ? [...variant.points].reverse() : [],
    waypoints,
  } as V;
}

/**
 * Mirror the junction a variant is read from, leaving the walk along it as it
 * is: the waypoints move with the junction and keep their along-variant km.
 */
function mirrorStartJunction<V extends ReversibleVariant>(variant: V, mapper: JunctionMapper): V {
  const oldStart = variant.startDistance ?? 0;
  const newStart = mapper.junctionKm(variant, 'start');
  const waypoints = variant.waypoints?.map(wp => ({
    ...wp,
    totalDistance: roundKm(newStart + Math.max(0, wp.totalDistance - oldStart)),
  }));
  return { ...variant, startDistance: newStart, waypoints };
}

/**
 * Reverse a variant with exactly one junction (see the module note). Returns
 * null when it has two junctions or none.
 */
function reverseSingleJunction<V extends ReversibleVariant>(variant: V, mapper: JunctionMapper): V | null {
  if (variant.startDistance != null && variant.endDistance == null) {
    return mirrorStartJunction(variant, mapper);
  }

  if (variant.startDistance == null && variant.endDistance != null) {
    // Its waypoints were counted from `points[0]` (there was no startDistance),
    // i.e. from 0.
    const newStart = mapper.junctionKm(variant, 'end');
    const turned = turnRound(variant, 0, newStart);
    delete turned.endDistance;
    return { ...turned, startDistance: newStart };
  }

  return null;
}

/**
 * Reverse alternate route variants, flipping start/end distances and
 * recomputing waypoint positions.
 *
 * Waypoint totalDistance is absolute trail km (junction + along-variant), so
 * reversal maps each waypoint's along-variant offset onto the reversed walk:
 * newAbs = newStart + (variantLength - oldAlongVariant). Per-waypoint
 * ascent/descent swap, matching the convention used for main-route waypoints.
 *
 * A junction on a parent alternate moves along the parent rather than about
 * the main route (see the module note).
 *
 * An alternate with one junction is mirrored about it and keeps reading from
 * it (see the module note). Alternates with no junction are returned
 * untouched — their waypoint km are variant-relative and there is nothing to
 * mirror.
 */
export function reverseAlternates<V extends ReversibleVariant>(alternates: V[], totalDistance: number): V[] {
  const mapper = createJunctionMapper(alternates, totalDistance);
  return alternates.map(alt => {
    if (alt.startDistance == null || alt.endDistance == null) {
      return reverseSingleJunction(alt, mapper) ?? alt;
    }

    const oldStart = alt.startDistance;
    const newStart = mapper.junctionKm(alt, 'end');
    return {
      ...turnRound(alt, oldStart, newStart),
      startDistance: newStart,
      endDistance: mapper.junctionKm(alt, 'start'),
    };
  });
}

/**
 * Transform side trips for direction change (flip attachment point).
 * A side trip is walked out-and-back the same way in either direction, so
 * only the junction km and the waypoints' absolute km move; along-variant
 * offsets and stats are unchanged.
 *
 * The same holds for a terminus, which travels in this list: it stays
 * attached at `startDistance` only, mirrored.
 *
 * Side trips without a junction are returned untouched — their waypoint km
 * are variant-relative and mirroring would corrupt them.
 *
 * Pass the trail's (stored, unreversed) `alternates` so a side trip hanging off
 * one moves along it (see the module note); without them every junction
 * mirrors about the main route.
 */
export function transformSideTrips<V extends ReversibleVariant>(
  sideTrips: V[],
  totalDistance: number,
  alternates?: readonly JunctionVariant[]
): V[] {
  const mapper = createJunctionMapper(alternates, totalDistance);
  return sideTrips.map(trip => {
    if (trip.startDistance != null && trip.endDistance != null) {
      return mirrorStartJunction(trip, mapper);
    }
    return reverseSingleJunction(trip, mapper) ?? trip;
  });
}

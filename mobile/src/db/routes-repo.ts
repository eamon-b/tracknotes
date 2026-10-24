/**
 * Routes repository — FarOut-style custom routes, scoped by trail.
 *
 * A route is a name + denormalized stats (total km / ascent / descent computed
 * at save time) plus an ordered list of `route_points`. Points are stored as
 * either 'snap' (on the trail, carrying its cumulative `km`) or 'sketch' (an
 * off-trail tap, `km` NULL). Legs are DERIVED from consecutive points by the
 * caller (see route-geometry) — the repo only persists the raw sequence.
 *
 * Cascade: `route_points.route_id` declares ON DELETE CASCADE, but the app DB
 * does not enable `PRAGMA foreign_keys` in production, so `deleteRoute` also
 * clears the points itself inside the same transaction. The declared cascade
 * still backs the schema test (the better-sqlite3 test adapter enables FKs).
 */

import type { SqlDatabase } from './sql-database';
import { withTransaction } from './transaction';

/** One persisted route vertex. */
export interface RoutePoint {
  seq: number;
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  /** Trail km for snap points; null for off-trail sketch points. */
  km: number | null;
}

/** A saved route row (stats denormalized, no points). */
export interface Route {
  id: string;
  trailId: string;
  name: string;
  totalKm: number;
  ascentM: number;
  descentM: number;
  /** `routeTrackKey` of the track the snap km were taken from; null = unknown. */
  trackKey: string | null;
  /** Snap points a data update left off the trail (now sketch points). */
  offTrailPoints: number;
  createdAt: string;
  updatedAt: string;
}

/** Everything needed to persist a new route in one call. */
export interface NewRoute {
  trailId: string;
  name: string;
  totalKm: number;
  ascentM: number;
  descentM: number;
  /** The track the points were snapped to, when known (see `Route.trackKey`). */
  trackKey?: string | null;
  points: Omit<RoutePoint, 'seq'>[];
}

/** A route's geometry snapped to a changed track (`replaceRouteGeometry`). */
export interface RouteGeometry {
  totalKm: number;
  ascentM: number;
  descentM: number;
  trackKey: string;
  offTrailPoints: number;
  points: Omit<RoutePoint, 'seq'>[];
}

interface RouteRow {
  id: string;
  trail_id: string;
  name: string;
  total_km: number;
  ascent_m: number;
  descent_m: number;
  track_key: string | null;
  off_trail_points: number;
  created_at: string;
  updated_at: string;
}

interface RoutePointRow {
  seq: number;
  kind: 'snap' | 'sketch';
  lat: number;
  lon: number;
  km: number | null;
}

function rowToRoute(row: RouteRow): Route {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    totalKm: row.total_km,
    ascentM: row.ascent_m,
    descentM: row.descent_m,
    trackKey: row.track_key,
    offTrailPoints: row.off_trail_points,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Time-ordered, collision-resistant id (no crypto dependency). */
export function generateRouteId(): string {
  return `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function insertPoints(
  db: SqlDatabase,
  routeId: string,
  points: Omit<RoutePoint, 'seq'>[],
): Promise<void> {
  for (let seq = 0; seq < points.length; seq++) {
    const p = points[seq];
    await db.runAsync(
      'INSERT INTO route_points (route_id, seq, kind, lat, lon, km) VALUES (?, ?, ?, ?, ?, ?)',
      [routeId, seq, p.kind, p.lat, p.lon, p.km ?? null],
    );
  }
}

/** Persist a route and its ordered points (transactional). */
export async function createRoute(db: SqlDatabase, input: NewRoute): Promise<Route> {
  const id = generateRouteId();
  const now = new Date().toISOString();
  const trackKey = input.trackKey ?? null;

  await withTransaction(db, async () => {
    await db.runAsync(
      `INSERT INTO routes (id, trail_id, name, total_km, ascent_m, descent_m, track_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.trailId,
        input.name,
        input.totalKm,
        input.ascentM,
        input.descentM,
        trackKey,
        now,
        now,
      ],
    );
    await insertPoints(db, id, input.points);
  });

  return {
    id,
    trailId: input.trailId,
    name: input.name,
    totalKm: input.totalKm,
    ascentM: input.ascentM,
    descentM: input.descentM,
    trackKey,
    offTrailPoints: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** All routes for a trail, newest first. */
export async function listRoutes(db: SqlDatabase, trailId: string): Promise<Route[]> {
  // `rowid DESC` is the tiebreaker: two routes saved in the same millisecond
  // share a `created_at`, and rowid preserves insertion order (newest last).
  const rows = await db.getAllAsync<RouteRow>(
    'SELECT * FROM routes WHERE trail_id = ? ORDER BY created_at DESC, rowid DESC',
    [trailId],
  );
  return rows.map(rowToRoute);
}

/** One route by id, or null. */
export async function getRoute(db: SqlDatabase, id: string): Promise<Route | null> {
  const row = await db.getFirstAsync<RouteRow>('SELECT * FROM routes WHERE id = ?', [id]);
  return row ? rowToRoute(row) : null;
}

/** Ordered points of a route. */
export async function getRoutePoints(db: SqlDatabase, routeId: string): Promise<RoutePoint[]> {
  const rows = await db.getAllAsync<RoutePointRow>(
    'SELECT seq, kind, lat, lon, km FROM route_points WHERE route_id = ? ORDER BY seq',
    [routeId],
  );
  return rows.map((r) => ({ seq: r.seq, kind: r.kind, lat: r.lat, lon: r.lon, km: r.km }));
}

/**
 * Replace a route's points and stats after snapping it to a changed track
 * (transactional). Not an edit by the hiker, so `updated_at` is left alone.
 */
export async function replaceRouteGeometry(
  db: SqlDatabase,
  id: string,
  geometry: RouteGeometry,
): Promise<void> {
  await withTransaction(db, async () => {
    const { changes } = await db.runAsync(
      `UPDATE routes SET total_km = ?, ascent_m = ?, descent_m = ?, track_key = ?, off_trail_points = ?
       WHERE id = ?`,
      [
        geometry.totalKm,
        geometry.ascentM,
        geometry.descentM,
        geometry.trackKey,
        geometry.offTrailPoints,
        id,
      ],
    );
    // Deleted meanwhile: writing its points would leave rows with no route.
    if (changes === 0) return;
    await db.runAsync('DELETE FROM route_points WHERE route_id = ?', [id]);
    await insertPoints(db, id, geometry.points);
  });
}

/** Delete a route and its points (transactional; independent of FK pragma). */
export async function deleteRoute(db: SqlDatabase, id: string): Promise<void> {
  await withTransaction(db, async () => {
    await db.runAsync('DELETE FROM route_points WHERE route_id = ?', [id]);
    await db.runAsync('DELETE FROM routes WHERE id = ?', [id]);
  });
}

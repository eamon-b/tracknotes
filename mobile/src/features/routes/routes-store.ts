/**
 * Custom-routes store — the saved routes for a trail plus the currently
 * activated route (the one overlaid on the map + highlighted on the profile).
 *
 * Mirrors `favorites-store`: a small zustand store the guide hydrates on open
 * and the routes screen / builder mutate. The route LIST is cached per trail
 * (with denormalized stats, so rendering never touches geometry); the ACTIVE
 * route additionally caches its ordered points so the map pane and elevation
 * pane can derive overlay + highlight geometry against their own track.
 *
 * A route's snap km are only true of the track they were taken from, so the
 * guide calls `resnap` with the track it shows: every route saved against a
 * different track (or before tracks were recorded) is snapped to it again
 * from its stored lat/lon, its stats recomputed, and the result written back,
 * once per change of geometry.
 */

import { create } from 'zustand';
import { getDatabase } from '../../db/database';
import * as routesRepo from '../../db/routes-repo';
import type { NewRoute, Route, RoutePoint } from '../../db/routes-repo';
import {
  computeRouteStats,
  resnapRoutePoints,
  routeTrackKey,
  type RouteTrackPoint,
} from './route-geometry';

export interface RoutesState {
  /** trailId → saved routes (newest first). */
  byTrail: Record<string, Route[]>;
  /** trailId → activated route id (null/absent = none active). */
  activeIdByTrail: Record<string, string | null>;
  /** trailId → ordered points of the active route (for overlay/highlight). */
  activePointsByTrail: Record<string, RoutePoint[] | undefined>;
  /** trailId → `routeTrackKey` of the track the guide last showed. */
  trackKeyByTrail: Record<string, string | undefined>;

  hydrate: (trailId: string) => Promise<void>;
  /**
   * Snap the trail's saved routes to `track` (the NOBO display track the
   * routes' km are stored on, with its route breaks) where it differs from
   * the one they were saved against.
   */
  resnap: (
    trailId: string,
    track: RouteTrackPoint[],
    breakStarts: ReadonlySet<number>,
  ) => Promise<void>;
  save: (input: NewRoute) => Promise<Route>;
  remove: (trailId: string, id: string) => Promise<void>;
  /** Activate a route (loads its points) or clear the active route (null). */
  activate: (trailId: string, id: string | null) => Promise<void>;
  /** Drop a trail's cached routes (its rows were deleted with the guide). */
  forgetTrail: (trailId: string) => void;
}

export const useRoutesStore = create<RoutesState>((set, get) => ({
  byTrail: {},
  activeIdByTrail: {},
  activePointsByTrail: {},
  trackKeyByTrail: {},

  hydrate: async (trailId) => {
    const db = await getDatabase();
    const routes = await routesRepo.listRoutes(db, trailId);
    set((s) => ({ byTrail: { ...s.byTrail, [trailId]: routes } }));
  },

  resnap: async (trailId, track, breakStarts) => {
    if (track.length === 0) return;
    const trackKey = routeTrackKey(track);
    if (get().trackKeyByTrail[trailId] === trackKey) return;
    // Recorded up front, so a guide that re-renders mid-run does not start a
    // second pass; cleared again if this one fails, so the next open retries.
    set((s) => ({ trackKeyByTrail: { ...s.trackKeyByTrail, [trailId]: trackKey } }));
    try {
      const db = await getDatabase();
      const routes = await routesRepo.listRoutes(db, trailId);
      const stale = routes.filter((r) => r.trackKey !== trackKey);
      if (stale.length === 0) return;

      const moved = new Map<string, RoutePoint[]>();
      for (const route of stale) {
        const saved = await routesRepo.getRoutePoints(db, route.id);
        const { points, offTrail } = resnapRoutePoints(saved, track);
        const stats = computeRouteStats(points, track, breakStarts);
        await routesRepo.replaceRouteGeometry(db, route.id, {
          ...stats,
          trackKey,
          offTrailPoints: route.offTrailPoints + offTrail,
          points: points.map(({ kind, lat, lon, km }) => ({ kind, lat, lon, km })),
        });
        moved.set(route.id, points);
      }

      const refreshed = new Map(
        (await routesRepo.listRoutes(db, trailId)).map((r) => [r.id, r]),
      );
      set((s) => {
        const activeId = s.activeIdByTrail[trailId];
        const activePoints = activeId ? moved.get(activeId) : undefined;
        // Refresh the rows in place rather than replacing the list, so a route
        // saved or removed while this ran is neither dropped nor brought back.
        const current = s.byTrail[trailId];
        const routes = current
          ? current.map((r) => refreshed.get(r.id) ?? r)
          : [...refreshed.values()];
        return {
          byTrail: { ...s.byTrail, [trailId]: routes },
          activePointsByTrail: activePoints
            ? { ...s.activePointsByTrail, [trailId]: activePoints }
            : s.activePointsByTrail,
        };
      });
    } catch (error) {
      set((s) => ({ trackKeyByTrail: { ...s.trackKeyByTrail, [trailId]: undefined } }));
      throw error;
    }
  },

  save: async (input) => {
    const db = await getDatabase();
    // Drawn on the track the guide shows, so it is already snapped to it.
    const route = await routesRepo.createRoute(db, {
      ...input,
      trackKey: input.trackKey ?? get().trackKeyByTrail[input.trailId] ?? null,
    });
    set((s) => ({
      byTrail: {
        ...s.byTrail,
        [input.trailId]: [route, ...(s.byTrail[input.trailId] ?? [])],
      },
    }));
    return route;
  },

  remove: async (trailId, id) => {
    const db = await getDatabase();
    await routesRepo.deleteRoute(db, id);
    set((s) => {
      const wasActive = s.activeIdByTrail[trailId] === id;
      return {
        byTrail: {
          ...s.byTrail,
          [trailId]: (s.byTrail[trailId] ?? []).filter((r) => r.id !== id),
        },
        activeIdByTrail: wasActive
          ? { ...s.activeIdByTrail, [trailId]: null }
          : s.activeIdByTrail,
        activePointsByTrail: wasActive
          ? { ...s.activePointsByTrail, [trailId]: undefined }
          : s.activePointsByTrail,
      };
    });
  },

  activate: async (trailId, id) => {
    if (id == null) {
      set((s) => ({
        activeIdByTrail: { ...s.activeIdByTrail, [trailId]: null },
        activePointsByTrail: { ...s.activePointsByTrail, [trailId]: undefined },
      }));
      return;
    }
    const db = await getDatabase();
    const points = await routesRepo.getRoutePoints(db, id);
    set((s) => ({
      activeIdByTrail: { ...s.activeIdByTrail, [trailId]: id },
      activePointsByTrail: { ...s.activePointsByTrail, [trailId]: points },
    }));
  },

  forgetTrail: (trailId) =>
    set((s) => {
      const byTrail = { ...s.byTrail };
      const activeIdByTrail = { ...s.activeIdByTrail };
      const activePointsByTrail = { ...s.activePointsByTrail };
      const trackKeyByTrail = { ...s.trackKeyByTrail };
      delete byTrail[trailId];
      delete activeIdByTrail[trailId];
      delete activePointsByTrail[trailId];
      delete trackKeyByTrail[trailId];
      return { byTrail, activeIdByTrail, activePointsByTrail, trackKeyByTrail };
    }),
}));

/** Reactive selector for a trail's active route id. */
export function selectActiveRouteId(trailId: string) {
  return (s: RoutesState): string | null => s.activeIdByTrail[trailId] ?? null;
}

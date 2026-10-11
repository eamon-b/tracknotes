import { describe, it, expect } from 'vitest';
import { buildWalkNetwork, findAccess, type AccessRoutePoint, type WalkWay } from './access-routing';
import { haversineDistance } from './distance';

/**
 * A route running south from a valley (lat -34.000) up to a summit
 * (lat -34.020), and a camp off to the east at valley height. One road climbs
 * from the camp to the summit (shorter); another runs flat to the valley
 * (longer). The Maekawa Campground case in miniature.
 */
const ROUTE: AccessRoutePoint[] = Array.from({ length: 21 }, (_, i) => ({
  lat: -34 - i * 0.001,
  lon: 138,
  dist: i * 0.1112,
}));
const CAMP = { lat: -34.015, lon: 138.02 };
const TO_SUMMIT: WalkWay = { coords: [[CAMP.lat, CAMP.lon], [-34.02, 138.0]] };
const TO_VALLEY: WalkWay = { coords: [[CAMP.lat, CAMP.lon], [-34.0, 138.02], [-34.0, 138.0]] };

/** The ridge the route climbs: 50 m in the valley, 500 m at the summit, flat to the east. */
function hill(lat: number, lon: number): number {
  if (lon > 138.002) return 50;
  return 50 + Math.max(0, Math.min(1, (-34 - lat) / 0.02)) * 450;
}

const lengthOf = (path: Array<[number, number]>) =>
  path.slice(1).reduce((sum, [lat, lon], i) => sum + haversineDistance(path[i][0], path[i][1], lat, lon), 0);

describe('findAccess', () => {
  const network = buildWalkNetwork([TO_SUMMIT, TO_VALLEY]);

  it('takes the longer flat walk over the shorter one that climbs', () => {
    const access = findAccess(network, CAMP, ROUTE, { elevationAt: hill });
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.junctionKm).toBeLessThan(0.1);
    expect(access.lengthM).toBeGreaterThan(3400);
    expect(access.ascentM).toBe(0);
  });

  it('takes the shorter walk when there is no height data', () => {
    const access = findAccess(network, CAMP, ROUTE);
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.junctionKm).toBeGreaterThan(2);
    expect(access.lengthM).toBeLessThan(2000);
  });

  it('describes the walk from the junction to the place', () => {
    const access = findAccess(network, CAMP, ROUTE, { elevationAt: hill });
    if (!access.ok) throw new Error(access.reason);
    expect(access.path[0]).toEqual([access.junction.lat, access.junction.lon]);
    expect(access.path[access.path.length - 1]).toEqual([CAMP.lat, CAMP.lon]);
    expect(access.lengthM).toBeCloseTo(lengthOf(access.path), 0);
    expect(access.offNetworkM).toBe(0);
  });

  it('counts the climb of a walk that goes up to the place', () => {
    const summitHut = { lat: -34.02, lon: 138.0 };
    const spur = buildWalkNetwork([{ coords: [[-34.01, 138.0], [-34.02, 138.0]] }]);
    // Off to the side: the route here is a separate line further west.
    const route = ROUTE.map(p => ({ ...p, lon: 137.99 }));
    const link = buildWalkNetwork([
      { coords: [[-34.01, 137.99], [-34.01, 138.0], [-34.02, 138.0]] },
    ]);
    expect(findAccess(spur, summitHut, route, { elevationAt: hill }).ok).toBe(false);
    const access = findAccess(link, summitHut, route, { elevationAt: hill });
    if (!access.ok) throw new Error(access.reason);
    expect(access.ascentM).toBeGreaterThan(200);
    expect(access.descentM).toBe(0);
  });

  it('starts from any way near the place, not only the nearest', () => {
    // A stub of driveway right beside the camp that joins nothing.
    const stub: WalkWay = { coords: [[-34.015, 138.0201], [-34.0151, 138.0202]] };
    const access = findAccess(buildWalkNetwork([stub, TO_VALLEY]), CAMP, ROUTE, { elevationAt: hill });
    expect(access.ok).toBe(true);
  });

  it('walks cross-country to a way that does not quite reach the place', () => {
    const access = findAccess(buildWalkNetwork([{ coords: [[-34.0, 138.018], [-34.0, 138.0]] }]),
      { lat: -34.001, lon: 138.018 }, ROUTE);
    if (!access.ok) throw new Error(access.reason);
    expect(access.offNetworkM).toBeGreaterThan(100);
    expect(access.lengthM).toBeGreaterThan(access.offNetworkM);
  });

  it('reports a place with no way near it', () => {
    const access = findAccess(network, { lat: -34.05, lon: 138.05 }, ROUTE);
    expect(access).toEqual({ ok: false, reason: 'no mapped way within 300 m of the place' });
  });

  it('gives up past the walking limit', () => {
    const access = findAccess(network, CAMP, ROUTE, { maxWalkM: 500 });
    expect(access.ok).toBe(false);
  });

  it('never joins the route across a route break', () => {
    // The only way meets the route between points 9 and 10, a ferry crossing.
    const ferryLanding: WalkWay = { coords: [[-34.0095, 138.02], [-34.0095, 138.0]] };
    const net = buildWalkNetwork([ferryLanding]);
    const place = { lat: -34.0095, lon: 138.02 };
    expect(findAccess(net, place, ROUTE).ok).toBe(true);
    expect(findAccess(net, place, ROUTE, { breakStarts: new Set([10]) }).ok).toBe(false);
  });
});

describe('buildWalkNetwork', () => {
  it('joins ways at shared nodes and splits long edges', () => {
    const network = buildWalkNetwork([
      { coords: [[0, 0], [0, 0.001]], nodeIds: [1, 2] },
      { coords: [[0, 0.001], [0.001, 0.001]], nodeIds: [2, 3] },
    ]);
    // Two ~111 m edges in 25 m pieces: five pieces each, three shared ends.
    expect(network.lat.length).toBe(3 + 4 + 4);
    const joint = network.lat.findIndex((lat, i) => lat === 0 && network.lon[i] === 0.001);
    expect(network.adj[joint]).toHaveLength(2);
  });
});

/**
 * Every committed `access.json` must still describe the trail it sits beside:
 * its ids are live entries in `data/waypoint-ids.json` (a retired or unknown id
 * is a place the build no longer has, so its walk silently stops applying), and
 * the bundled trail puts each routed place at its junction's km with its walk
 * in — the build only warns when it ignores an entry. Read from the committed
 * mobile assets, so a stale `npm run build:mobile-trails` fails here too.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseTrailAccessFile, type TrailAccessEntry } from './lib/trail-access-file';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data/trails');
const ASSETS_DIR = path.join(ROOT, 'mobile/assets/trails');

/** The bundled trail rounds km to one decimal, so 0.05 of rounding plus a little. */
const KM_TOLERANCE = 0.06;

interface RegistryEntry {
  id: string;
  retired?: boolean;
}
interface BundledWaypoint {
  id?: string;
  totalDistance: number;
  offTrailKm?: number;
}

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/waypoint-ids.json'), 'utf-8')) as Record<
  string,
  RegistryEntry[]
>;

const trails = fs
  .readdirSync(DATA_DIR)
  .filter(dir => fs.existsSync(path.join(DATA_DIR, dir, 'access.json')))
  .map(dir => {
    const filePath = path.join(DATA_DIR, dir, 'access.json');
    const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, dir, 'trail.json'), 'utf-8')) as { id: string };
    return { dir, id: config.id, access: parseTrailAccessFile(fs.readFileSync(filePath, 'utf-8'), filePath) };
  });

describe('access.json', () => {
  it('finds the files', () => {
    expect(trails.length).toBeGreaterThan(0);
  });

  it.each(trails.map(t => [t.dir, t] as const))('%s names live waypoint ids', (_dir, trail) => {
    const live = new Set((registry[trail.id] ?? []).filter(e => !e.retired).map(e => e.id));
    const dead = Object.keys(trail.access.places).filter(id => !live.has(id));
    expect(dead).toEqual([]);
  });

  it.each(trails.map(t => [t.dir, t] as const))('%s places each routed waypoint at its junction', (_dir, trail) => {
    const bundled = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, `${trail.id}.json`), 'utf-8')) as {
      waypoints: BundledWaypoint[];
    };
    const rows = new Map(bundled.waypoints.filter(w => w.id).map(w => [w.id!, w]));
    const places = Object.entries(trail.access.places);
    // A near-duplicate the build merged away (`dedupeWaypoints`) has no row of
    // its own; fetch-access gave it its survivor's entry, so a twin with the
    // same junction and walk stands for it.
    const sameWalk = (a: TrailAccessEntry, b: TrailAccessEntry) =>
      a.junction !== undefined &&
      a.method === b.method &&
      a.offTrailKm === b.offTrailKm &&
      String(a.junction) === String(b.junction);
    const rowFor = (id: string, entry: TrailAccessEntry) =>
      rows.get(id) ?? places.filter(([other, e]) => other !== id && sameWalk(e, entry)).map(([other]) => rows.get(other)).find(Boolean);

    const problems: string[] = [];
    for (const [id, entry] of places) {
      const row = rowFor(id, entry);
      if (entry.method === 'none') {
        // On the route, it is walked as the straight line; off it, not listed here.
        if (row && !(row.offTrailKm! > 0)) problems.push(`${id} ${entry.name}: no walk`);
        continue;
      }
      if (!row) {
        problems.push(`${id} ${entry.name}: not on the main route`);
        continue;
      }
      if (row.offTrailKm !== entry.offTrailKm) problems.push(`${id} ${entry.name}: walk ${row.offTrailKm} ≠ ${entry.offTrailKm}`);
      if (entry.junctionKm !== undefined && Math.abs(row.totalDistance - entry.junctionKm) > KM_TOLERANCE) {
        problems.push(`${id} ${entry.name}: built at km ${row.totalDistance}, junction at km ${entry.junctionKm}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// @vitest-environment node
/**
 * The local waypoint editor predicts what the next build will make of a
 * trail's sources with code of its own: `listGpxWaypoints` reads the `<wpt>`s
 * and `resolveSourceType` names and types each (`sourceIdInputs`). Every
 * "that keeps its id" check rests on that prediction. Its other tests use a
 * synthetic trail, so a change to how the build reads a GPX, cleans a name or
 * types a waypoint from a CalTopo export could leave them all passing while
 * the build re-keys a waypoint the editor said was safe.
 *
 * This suite ties the two together over the committed trails: for every trail
 * directory, the editor's list must be, entry for entry, what the build's own
 * functions produce (`readTrailGpx` and `resolveTrailWaypoints`, which
 * `build-trails.ts` passes to `buildTrail` and whose result is what
 * `assignWaypointIds` is handed), and the id matching run over that list must
 * leave the committed registry exactly as it is.
 *
 * It reads the committed sources only: no built data, no network. Te Araroa's
 * GPX is materialised by `npm run sync:te-araroa` and gitignored, so that
 * trail is skipped, visibly, where the file is absent (CI's web-tests job).
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TrailConfig } from '../../../src/lib/trail-types';
import { findGeojsonFile, findGpxFile, readTrailGpx, resolveTrailWaypoints } from '../trail-waypoint-sources';
import { assignWaypointIds, stringifyRegistry, type WaypointForId, type WaypointRegistry } from '../waypoint-ids';
import { editorPaths, sourceIdInputs } from './trail-state';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TRAILS_DIR = path.join(PROJECT_ROOT, 'data', 'trails');
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'data', 'waypoint-ids.json');
const paths = editorPaths(PROJECT_ROOT);

/**
 * The build's parser reads the whole GPX, track included, through jsdom: about
 * 5 s for the largest (the CDT, 9 MB) and 18 s for all of them on a laptop, in
 * a file of its own that runs beside the rest of the suite. Room for a busy
 * CI runner.
 */
const PER_TRAIL_TIMEOUT_MS = 60_000;

interface CommittedTrail {
  dir: string;
  config: TrailConfig;
  /** The GPX the build would read, or null when the directory has none. */
  gpxFile: string | null;
  /** False when trail.json names a GPX that is not on disk (Te Araroa before `sync:te-araroa`). */
  gpxPresent: boolean;
}

const trails: CommittedTrail[] = fs
  .readdirSync(TRAILS_DIR)
  .filter(dir => fs.existsSync(path.join(TRAILS_DIR, dir, 'trail.json')))
  .sort((a, b) => a.localeCompare(b))
  .map(dir => {
    const trailDir = path.join(TRAILS_DIR, dir);
    const config = JSON.parse(fs.readFileSync(path.join(trailDir, 'trail.json'), 'utf-8')) as TrailConfig;
    // As `processTrail` chooses it.
    const gpxFile = config.gpxFile || findGpxFile(trailDir);
    return { dir, config, gpxFile, gpxPresent: !!gpxFile && fs.existsSync(path.join(trailDir, gpxFile)) };
  });

const asInput = (wp: { name: string; type: string; lat: number; lon: number }): WaypointForId => ({
  name: wp.name,
  type: wp.type,
  lat: wp.lat,
  lon: wp.lon,
});

/** What the build hands `assignWaypointIds` for a trail directory, by the build's own functions. */
function buildIdInputs({ dir, config, gpxFile }: CommittedTrail): WaypointForId[] {
  const trailDir = path.join(TRAILS_DIR, dir);
  const gpx = readTrailGpx(path.join(trailDir, gpxFile!));
  return resolveTrailWaypoints(trailDir, config, gpx.waypoints).map(asInput);
}

describe('the editor’s reading of the committed trails, against the build’s', () => {
  const committed = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  /** One copy for the whole run, as one build shares one registry across the trails. */
  const registry = JSON.parse(committed) as WaypointRegistry;
  const checked: string[] = [];

  beforeAll(() => {
    // `resolveTrailWaypoints` reports the CalTopo export it uses, as it does in a build.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('covers every trail directory', () => {
    expect(trails.length).toBeGreaterThanOrEqual(20);
    // Only a GPX that a sync materialises may be absent.
    expect(trails.filter(t => !t.gpxPresent).map(t => t.dir)).toEqual(
      trails.filter(t => !t.gpxPresent && t.dir === 'te_araroa').map(t => t.dir)
    );
  });

  for (const trail of trails) {
    const title = `${trail.dir}: the same <wpt>s, named and typed alike, and every id kept`;
    // A visible skip, never a silent pass: the reporter lists it as skipped.
    it.skipIf(!trail.gpxPresent)(title, { timeout: PER_TRAIL_TIMEOUT_MS }, () => {
      const fromBuild = buildIdInputs(trail);
      const editor = sourceIdInputs(paths, trail.dir);

      // The same files...
      expect(editor.trailId).toBe(trail.config.id);
      expect(editor.gpxFile).toBe(trail.gpxFile);
      expect(editor.geojsonFile ?? null).toBe(
        findGeojsonFile(path.join(TRAILS_DIR, trail.dir), trail.config.geojsonFile)
      );
      // ...and the same waypoints, in the same order: name, type, lat, lon.
      expect(editor.inputs).toEqual(fromBuild);
      expect(editor.inputs.length).toBeGreaterThan(0);

      // The build's id matching over the editor's list changes nothing: no id
      // minted, none retired, no entry moved or renamed.
      const before = structuredClone(registry[editor.trailId] ?? []);
      const warnings: string[] = [];
      const ids = assignWaypointIds(editor.trailId, editor.inputs, registry, message => warnings.push(message));
      expect(registry[editor.trailId]).toEqual(before);
      const known = new Set(before.map(entry => entry.id));
      expect(ids.filter(id => !known.has(id))).toEqual([]);
      expect(new Set(ids).size).toBe(ids.length);
      checked.push(trail.dir);
    });
  }

  it('leaves data/waypoint-ids.json byte for byte as committed', () => {
    expect(checked.length).toBeGreaterThanOrEqual(trails.filter(t => t.gpxPresent).length);
    expect(stringifyRegistry(registry)).toBe(committed);
  });

  it('is the list the build mints ids for: nothing retypes a waypoint between the two', () => {
    // `buildTrail` hands `mintWaypointIds` what `resolveWaypoints` returned,
    // unless it is asked to guess types from names, which only imports ask for.
    const build = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'build-trails.ts'), 'utf-8');
    expect(build).toContain(
      'resolveWaypoints: (gpxWaypoints, resolvedConfig) => resolveTrailWaypoints(trailDir, resolvedConfig, gpxWaypoints)'
    );
    expect(build).toContain('const gpxData = readTrailGpx(gpxPath);');
    expect(build).not.toContain('inferWaypointTypesFromKeywords');
  });
});

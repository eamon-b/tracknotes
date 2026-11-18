import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { haversineDistance as haversineDistanceMeters } from '../../src/lib/distance.js';
import { parseGpx } from '../../src/lib/gpx-parser.js';
import { classifyWaypoint } from '../../src/lib/waypoint-classifier.js';
import { flattenGpx, type ParsedGpxResult } from '../../src/lib/trail-ingest.js';
import type { TrailConfig, TrailWaypoint as Waypoint } from '../../src/lib/trail-types.js';
import { jsdomXmlAdapter } from './xml-adapter-jsdom.js';

/**
 * Where a trail build's waypoints come from, before their ids are assigned:
 * the `<wpt>`s of the trail's GPX, typed and described from its CalTopo export
 * where it has one, with a CSV fallback for a GPX that carries none.
 *
 * `scripts/build-trails.ts` hands `resolveTrailWaypoints` to `buildTrail` as
 * its `resolveWaypoints` hook, and what that returns is, in order, what
 * `assignWaypointIds` is given. The local waypoint editor predicts the same
 * list with code of its own (`resolveSourceType` in
 * `waypoint-editor/trail-state.ts`), to check that an edit keeps every id. The
 * functions live here, apart from the build script (which runs a build when it
 * is imported), so that `waypoint-editor/build-parity.test.ts` can hold the
 * two together over the committed trails.
 */

/** A trail's GPX as the build reads it: the shared parser on jsdom, strict about coordinates, flattened. */
export function readTrailGpx(gpxPath: string): ParsedGpxResult {
  return flattenGpx(parseGpx(fs.readFileSync(gpxPath, 'utf-8'), jsdomXmlAdapter));
}

/** One CalTopo marker, keyed in `CaltopoData.markers` by its cleaned name. */
interface CaltopoMarker {
  lat: number;
  lon: number;
  type: string;
  description?: string;
}

interface CaltopoData {
  /**
   * Markers by cleaned name. A name can hold several markers: the guides pin a
   * campsite and its water (`C Viking Saddle`, `W Viking Saddle`) or a hut and
   * the camp beside it under one name, and a GPX waypoint takes its type from
   * the nearest marker of its own name, never from whichever came last.
   */
  markers: Map<string, CaltopoMarker[]>;
}

/**
 * Parse CalTopo GeoJSON for waypoint categorization, descriptions, and route variants
 */
export function parseCaltopoGeojson(jsonPath: string): CaltopoData {
  const result: CaltopoData = { markers: new Map<string, CaltopoMarker[]>() };

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const geojson = JSON.parse(content);

    // Build folder ID -> name map
    const folderNames = new Map<string, string>();
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Folder') {
        folderNames.set(feature.id, feature.properties.title?.toLowerCase() || '');
      }
    }

    // Process markers (waypoints)
    for (const feature of geojson.features || []) {
      if (feature.properties?.class === 'Marker') {
        const rawName = feature.properties.title || '';
        const folderId = feature.properties.folderId;
        const folderName = folderId ? folderNames.get(folderId) || '' : '';

        // Use classifyWaypoint with folder info to get type and cleaned name
        const classification = classifyWaypoint(rawName, { folderName });

        // Key by cleaned name for easier matching with GPX waypoints
        const [lon, lat] = feature.geometry?.coordinates ?? [];
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const marker: CaltopoMarker = { lat, lon, type: classification.type };
        if (feature.properties.description) marker.description = feature.properties.description;
        const sameName = result.markers.get(classification.cleanedName);
        if (sameName) sameName.push(marker);
        else result.markers.set(classification.cleanedName, [marker]);
      }
    }
  } catch (e) {
    // GeoJSON parsing failed, fall back to GPX-only
    console.log(`  Warning: Could not parse GeoJSON: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  return result;
}

/**
 * Find the first GPX file in a directory
 */
export function findGpxFile(trailDir: string): string | null {
  const files = fs.readdirSync(trailDir);
  const gpxFile = files.find(f => f.toLowerCase().endsWith('.gpx'));
  return gpxFile || null;
}

/**
 * Find a CalTopo GeoJSON file in a directory.
 * If explicitFile is provided, use that. Otherwise, auto-detect by finding
 * JSON files with a features array (excluding trail.json and climate.json).
 */
export function findGeojsonFile(trailDir: string, explicitFile?: string): string | null {
  // If explicitly specified, use that
  if (explicitFile) {
    const filePath = path.join(trailDir, explicitFile);
    if (fs.existsSync(filePath)) {
      return explicitFile;
    }
    console.log(`  Warning: Specified geojsonFile not found: ${explicitFile}`);
  }

  // Auto-detect: find JSON files that look like GeoJSON (have features array)
  const files = fs.readdirSync(trailDir);
  // The trail's own data files are never the CalTopo export, and pois.json runs to megabytes.
  const OWN_FILES = new Set(['trail.json', 'climate.json', 'pois.json', 'access.json', 'descriptions.json']);
  const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json') && !OWN_FILES.has(f));

  for (const file of jsonFiles) {
    try {
      const content = fs.readFileSync(path.join(trailDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.features)) {
        return file; // This is a GeoJSON file
      }
    } catch {
      // Not valid JSON or can't read, skip
    }
  }

  return null;
}

/**
 * Layer the build-only waypoint sources on top of the GPX waypoints:
 * CalTopo GeoJSON categories/descriptions first, then a CSV fallback for trails
 * whose GPX carries no `<wpt>` at all.
 */
export function resolveTrailWaypoints(trailDir: string, config: TrailConfig, gpxWaypoints: Waypoint[]): Waypoint[] {
  let waypoints = gpxWaypoints;

  // If GeoJSON exists, use it to enhance data
  const geojsonFile = findGeojsonFile(trailDir, config.geojsonFile);
  if (geojsonFile) {
    const geojsonPath = path.join(trailDir, geojsonFile);
    const caltopoData = parseCaltopoGeojson(geojsonPath);

    if (caltopoData.markers.size > 0) {
      console.log(`  ✓ Using ${geojsonFile} for waypoint categorization`);
      // Update waypoint types and descriptions from GeoJSON. Both sides are
      // keyed by cleaned name; among same-named markers the nearest one wins.
      waypoints = waypoints.map(wp => {
        const sameName = caltopoData.markers.get(wp.name);
        if (!sameName) return wp;
        let marker = sameName[0];
        let best = Infinity;
        for (const candidate of sameName) {
          const d = haversineDistanceMeters(wp.lat, wp.lon, candidate.lat, candidate.lon);
          if (d < best) {
            best = d;
            marker = candidate;
          }
        }
        return {
          ...wp,
          type: marker.type,
          description: marker.description || wp.description,
        };
      });
    }
  }

  // Fall back to CSV waypoints if no GPX waypoints and CSV exists
  if (waypoints.length === 0 && config.waypointsFile) {
    const waypointsPath = path.join(trailDir, config.waypointsFile);
    if (fs.existsSync(waypointsPath)) {
      const waypointsContent = fs.readFileSync(waypointsPath, 'utf-8');
      const waypointsResult = Papa.parse(waypointsContent, { header: true });
      waypoints = (waypointsResult.data as Record<string, unknown>[])
        .filter(row => row.name && row.lat && row.lon)
        .map(row => ({
          name: String(row.name),
          lat: parseFloat(String(row.lat)),
          lon: parseFloat(String(row.lon)),
          type: String(row.type || 'waypoint'),
          description: row.description ? String(row.description) : undefined,
        }));
    }
  }

  return waypoints;
}

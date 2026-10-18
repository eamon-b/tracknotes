/** Types for mvt-contours.mjs (plain JavaScript so e2e-tile-check.mjs runs without a build). */

export function contourElevations(
  tile: Uint8Array | ArrayBuffer,
  layerName?: string
): { layers: number; elevations: Array<number | string | boolean | null> };

export function checkZ9Tiered(
  tile: Uint8Array | ArrayBuffer,
  options?: { interval?: number }
): { ok: boolean; features: number; offInterval: number; reason?: string };

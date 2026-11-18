/**
 * Small helpers the trail, plan and resupply pages share: the axis ticks of an
 * elevation profile, a trailing-edge debounce, and the fetch of a bundled
 * trail's generated JSON. One copy each, so the pages cannot drift apart.
 */

import { SITE_ROOT, generatedDataUrl } from '../web-utils';

/**
 * Round tick values for an axis from `min` to `max`, at most about `maxTicks`
 * of them, on a 1/2/5 × 10ⁿ step. `[min]` when the range is empty.
 */
export function niceAxisTicks(min: number, max: number, maxTicks: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const roughStep = range / maxTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized <= 1) niceStep = 1 * magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6); // avoid floating point drift
  }
  return ticks;
}

/** `fn`, run `ms` after the last of a burst of calls, with that call's arguments. */
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

/**
 * A bundled trail's generated JSON (`data/generated/<id>.json`), or null when
 * it cannot be fetched or read. Relative to the page (`trails/<id>/…html`), as
 * `index.html`'s fetch is, so a site served from a sub-path still finds it.
 */
export async function loadGeneratedTrail<T>(trailId: string): Promise<T | null> {
  try {
    const response = await fetch(generatedDataUrl(`${trailId}.json`, SITE_ROOT.trailPage, document.baseURI));
    if (!response.ok) throw new Error(`Trail data not found (HTTP ${response.status})`);
    return (await response.json()) as T;
  } catch (error) {
    console.error('Failed to load trail data:', error);
    return null;
  }
}

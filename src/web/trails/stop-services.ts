/**
 * The services strip: six glyphs saying what is within a kilometre of a place,
 * from the trail's OSM POIs (`servicesAtStop` in `@lib/plan-editor`). Shared by
 * the planner's Stops tab and the resupply page, so both say it the same way.
 */

import type { StopServices } from '@lib/plan-editor';
import { escapeHtml } from '../web-utils';

/** The flags of `StopServices`, in the order the strip shows them. */
type ServiceFlag = Exclude<keyof StopServices, 'pois'>;

const SERVICE_GLYPHS: ReadonlyArray<{ flag: ServiceFlag; glyph: string; label: string }> = [
  { flag: 'camping', glyph: '⛺', label: 'Camping' },
  { flag: 'lodging', glyph: '\u{1F6CF}\u{FE0F}', label: 'Lodging' },
  { flag: 'shop', glyph: '\u{1F6D2}', label: 'Shop' },
  { flag: 'food', glyph: '\u{1F37D}\u{FE0F}', label: 'Food' },
  { flag: 'water', glyph: '\u{1F4A7}', label: 'Water' },
  { flag: 'transport', glyph: '\u{1F68C}', label: 'Transport' },
];

/**
 * Six glyphs, greyed where the service is absent. Empty when the trail has no
 * POI data at all: a strip of six grey glyphs would read as "nothing here",
 * which is a different and more dangerous claim than "we do not know".
 */
export function servicesStripHtml(services: StopServices | undefined): string {
  if (!services) return '';
  const glyphs = SERVICE_GLYPHS.map(({ flag, glyph, label }) => {
    const present = services[flag];
    const title = present ? label : `No ${label.toLowerCase()} nearby`;
    return `<span class="stop-svc${present ? '' : ' is-off'}" title="${escapeHtml(title)}">${glyph}</span>`;
  }).join('');
  return `<div class="stop-services">${glyphs}</div>`;
}

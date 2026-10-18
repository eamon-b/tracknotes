/**
 * Waypoint descriptions as HTML with their links made clickable.
 *
 * Its own module rather than a `web-utils` helper because `@lib/text-links`
 * brings `@lib/poi-display` with it, and `web-utils` is loaded by every page,
 * the landing page included — the reason `community-labels` is kept apart too.
 */

import { splitTextLinks } from '@lib/text-links';
import { escapeHtml } from './web-utils';

/**
 * Free text as HTML with its links made clickable: URLs, email addresses and
 * phone numbers, found by the same `splitTextLinks` the app uses, so the two
 * agree on what is a link and which hrefs are allowed (http(s) through
 * `safeHttpUrl`, `mailto:`, `tel:` through `safeTelUrl`). Every piece, href
 * included, is escaped; a web page opens in a new tab.
 */
export function linkifyText(text: string): string {
  return splitTextLinks(text)
    .map(({ text: part, href, kind }) => {
      if (!href) return escapeHtml(part);
      const newTab = kind === 'url' ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href)}"${newTab}>${escapeHtml(part)}</a>`;
    })
    .join('');
}

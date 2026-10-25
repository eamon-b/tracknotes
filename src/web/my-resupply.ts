/**
 * Boot script for `my-resupply.html` — the resupply page for a user-imported
 * GPX. Mirrors `my-plan.ts`: the page module is the bundled one, handed the
 * trail read from IndexedDB, and the plan is the same `localStorage` document
 * `my-plan.html` edits (imported trails never sync).
 */

import { initResupplyPage, type ResupplyPageTrail } from './trails/resupply-page';
import { getTrail, isIndexedDbAvailable } from './imported-trails-db';
import { getQueryParam } from './web-utils';

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showMissing(): void {
  const missing = byId('plan-missing');
  if (missing) missing.hidden = false;
  for (const id of ['rs-header', 'resupply-app']) {
    const el = byId(id);
    if (el) el.hidden = true;
  }
}

async function init(): Promise<void> {
  const trailId = getQueryParam(window.location.search, 'id');
  if (!trailId || !isIndexedDbAvailable()) {
    showMissing();
    return;
  }

  let record;
  try {
    record = await getTrail(trailId);
  } catch {
    record = null;
  }
  if (!record) {
    showMissing();
    return;
  }

  const name = record.trail.config.name || record.name;
  document.title = `Resupply — ${name} - Trail Maps`;
  // textContent, not innerHTML: `name` is whatever the user typed on upload.
  const title = byId('trail-title');
  if (title) title.textContent = name;
  const query = `?id=${encodeURIComponent(record.id)}`;
  const back = byId<HTMLAnchorElement>('back-link');
  if (back) back.href = `./my-trail.html${query}`;

  await initResupplyPage(record.id, record.trail as unknown as ResupplyPageTrail, {
    plannerHref: focus => `./my-plan.html${query}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`,
  });
}

void init().catch((err: unknown) => {
  console.error('Could not open this resupply plan', err);
  showMissing();
});

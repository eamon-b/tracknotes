/**
 * Boot script for `admin-descriptions.html` — the live description editor on
 * the deployed site. For a bundled trail it lists every waypoint's bundled
 * description (the trail JSON the site serves) beside its synced one (the
 * comments API's public `GET /v1/trails/:id/descriptions`, which every phone
 * pulls and shows over the bundled text), marks where they differ, and lets an
 * admin's linked browser PUT a new synced text or clear it.
 *
 * The drift rule (`docs/waypoint-editor.md`): a synced text that is not in the
 * trail's `descriptions.json` is overwritten by the next *Upload descriptions*
 * run. The file as this site was built is bundled into this page (a lazy glob
 * of `data/trails/*\/descriptions.json`), so the page can show the drift and
 * export the updated file to commit.
 *
 * Reading needs nothing; editing needs a linked browser whose account the
 * worker treats as an admin (`GET /v1/me` says so up front, and the worker
 * re-checks every PUT). Modelled on `admin-moderation.ts`.
 */

import type { WaypointDescription } from '@lib/comments-api-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { ApiError, NetworkError, getApiBase } from './api/client';
import { adminPutDescription, fetchMe, fetchSyncedDescriptions } from './api/descriptions';
import { clearSession, loadSession, type WebSession } from './api/session';
import {
  MAX_DESCRIPTION_LENGTH,
  ROW_FILTER_LABELS,
  buildRows,
  checkDraft,
  draftStatusHtml,
  exportFileText,
  filePath,
  matchesRow,
  parseCuratedFile,
  patchSnippet,
  rowHtml,
  summaryHtml,
  trailDirFor,
  trailDirOf,
  trailWaypoints,
  type DescriptionRow,
  type RowFilter,
  type TrailWaypoint,
} from './admin-descriptions-view';
import { renderLinkForm } from './link-browser';
import { SITE_ROOT, escapeHtml, generatedDataUrl, getQueryParam } from './web-utils';

/** Each trail's `descriptions.json` as committed when this site was built, loaded on demand. */
const DESCRIPTION_FILES = import.meta.glob<string>('../../data/trails/*/descriptions.json', {
  query: '?raw',
  import: 'default',
});

/** Each trail directory's build id (`AAWT` builds `aawt`), to find a trail's file. */
const TRAIL_IDS = import.meta.glob<string | undefined>('../../data/trails/*/trail.json', {
  eager: true,
  import: 'id',
});

const TRAIL_KEY = 'tracknotes-admin-descriptions-trail';

/** At most this many rows are drawn at once; the filters narrow the rest. */
const MAX_ROWS = 300;

interface IndexEntry {
  id: string;
  name: string;
}

async function loadFileText(dir: string | null): Promise<string | null> {
  if (!dir) return null;
  const key = Object.keys(DESCRIPTION_FILES).find(k => trailDirOf(k) === dir);
  return key ? DESCRIPTION_FILES[key]() : null;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`admin-descriptions.html is missing #${id}`);
  return node as T;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(TRAIL_KEY);
  } catch {
    return null;
  }
}

function store(trailId: string): void {
  try {
    window.localStorage.setItem(TRAIL_KEY, trailId);
  } catch {
    /* a per-browser convenience only */
  }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof NetworkError) return 'Could not reach the server. Check your connection and try again.';
  return err instanceof Error ? err.message : String(err);
}

function init(): void {
  const status = $('desc-status');
  const linkBox = $('desc-link');
  const errorEl = $('desc-error');
  const toolbar = $('desc-toolbar');
  const identity = $('desc-identity');
  const linkButton = $<HTMLButtonElement>('desc-link-button');
  const controls = $('desc-controls');
  const trailSelect = $<HTMLSelectElement>('desc-trail');
  const filterSelect = $<HTMLSelectElement>('desc-filter');
  const search = $<HTMLInputElement>('desc-search');
  const section = $('desc-section');
  const summary = $('desc-summary');
  const list = $('desc-list');
  const shown = $('desc-shown');
  const copyFallback = $('desc-copy-fallback');
  const snippetBox = $<HTMLTextAreaElement>('desc-snippet');

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  if (!getApiBase()) {
    status.textContent = 'This build has no API configured (VITE_API_BASE_URL).';
    return;
  }

  let session: WebSession | null = loadSession();
  let canEdit = false;
  let trailId = '';
  let trailDir: string | null = null;
  let fileText: string | null = null;
  let waypoints: TrailWaypoint[] = [];
  let synced: WaypointDescription[] = [];
  let rows: DescriptionRow[] = [];
  /** Open edit boxes and what they hold, by waypoint id. */
  const drafts = new Map<string, string>();
  /** Bumped per trail load, so a slow answer for the previous trail is dropped. */
  let loadSeq = 0;

  for (const [value, label] of Object.entries(ROW_FILTER_LABELS)) {
    filterSelect.insertAdjacentHTML('beforeend', `<option value="${value}">${escapeHtml(label)}</option>`);
  }

  const renderList = (): void => {
    const filter = filterSelect.value as RowFilter;
    const matching = rows.filter(r => matchesRow(r, filter, search.value));
    const drawn = matching.slice(0, MAX_ROWS);
    shown.textContent =
      matching.length > drawn.length
        ? `Showing the first ${drawn.length} of ${matching.length}: narrow with the filters or search.`
        : `${matching.length} shown.`;
    list.innerHTML =
      drawn.length > 0
        ? drawn.map(r => rowHtml(r, { canEdit, editing: drafts.has(r.id), draft: drafts.get(r.id) })).join('')
        : '<p class="import-note">No waypoints match.</p>';
  };

  const render = (): void => {
    rows = buildRows(waypoints, parseCuratedFile(fileText), synced);
    summary.innerHTML = summaryHtml(rows, filePath(trailDir, trailId));
    copyFallback.hidden = true;
    renderList();
  };

  const showIdentity = (): void => {
    toolbar.hidden = false;
    linkButton.hidden = session !== null;
    if (!session) identity.textContent = 'Read-only: link this browser to an admin account to edit.';
    else if (canEdit) identity.textContent = `Linked as ${session.displayName || 'this account'} (admin).`;
    else identity.textContent = `Linked as ${session.displayName || 'this account'}, which is not an admin: read-only.`;
  };

  /** Ask the API whether the linked account is an admin. */
  const checkAdmin = async (): Promise<void> => {
    canEdit = false;
    if (!session) return;
    try {
      canEdit = (await fetchMe(session)).isAdmin;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
      } else {
        setError(`Could not check this browser's account: ${errorText(err)}`);
      }
    }
  };

  const loadTrail = async (id: string): Promise<void> => {
    const seq = ++loadSeq;
    trailId = id;
    store(id);
    drafts.clear();
    setError('');
    section.hidden = true;
    status.hidden = false;
    status.textContent = 'Loading…';
    try {
      trailDir = trailDirFor(id, TRAIL_IDS);
      const [trail, text, live] = await Promise.all([
        fetch(generatedDataUrl(`${id}.json`, SITE_ROOT.topLevel, document.baseURI)).then(async response => {
          if (!response.ok) throw new Error(`the trail data answered ${response.status}`);
          return (await response.json()) as ProcessedTrail;
        }),
        loadFileText(trailDir),
        fetchSyncedDescriptions(id),
      ]);
      if (seq !== loadSeq) return;
      waypoints = trailWaypoints(trail);
      fileText = text;
      synced = live;
    } catch (err) {
      if (seq !== loadSeq) return;
      status.hidden = true;
      setError(`Could not load ${id}: ${errorText(err)}`);
      return;
    }
    status.hidden = true;
    section.hidden = false;
    render();
  };

  /** Re-read the synced set after a write, keeping the page where it is. */
  const refreshSynced = async (): Promise<void> => {
    const seq = loadSeq;
    const live = await fetchSyncedDescriptions(trailId);
    if (seq !== loadSeq) return;
    synced = live;
    render();
  };

  const askToLink = (): void => {
    linkBox.hidden = false;
    renderLinkForm(
      linkBox,
      'Editing needs an admin account. Link this browser to the Tracknotes app on that phone.',
      linked => {
        linkBox.hidden = true;
        linkBox.innerHTML = '';
        session = linked;
        void checkAdmin().then(() => {
          showIdentity();
          if (trailId) render();
        });
      }
    );
  };

  const write = async (id: string, description: string, rowError: HTMLElement | null): Promise<void> => {
    if (!session) return;
    const buttons = list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`);
    for (const b of buttons) b.disabled = true;
    try {
      const stored = await adminPutDescription(session, trailId, id, description);
      drafts.delete(id);
      synced = [...synced.filter(s => s.waypointId !== id), stored];
      render();
      void refreshSynced().catch(() => {
        /* the PUT's answer is already drawn */
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
        canEdit = false;
        showIdentity();
        renderList();
        askToLink();
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        canEdit = false;
        showIdentity();
      }
      if (rowError) {
        rowError.textContent = `Failed: ${errorText(err)}`;
        rowError.hidden = false;
      }
      for (const b of buttons) b.disabled = false;
    }
  };

  list.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!target) return;
    const id = target.dataset.id!;
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const rowError = list.querySelector<HTMLElement>(`[data-error="${CSS.escape(id)}"]`);
    switch (target.dataset.action) {
      case 'edit':
        drafts.set(id, row.synced || row.bundled);
        renderList();
        list.querySelector<HTMLTextAreaElement>(`[data-draft="${CSS.escape(id)}"]`)?.focus();
        return;
      case 'cancel':
        drafts.delete(id);
        renderList();
        return;
      case 'save': {
        const check = checkDraft(drafts.get(id) ?? '');
        if (check.tooLong) {
          if (rowError) {
            rowError.textContent = `Too long: ${check.length} characters, the most is ${MAX_DESCRIPTION_LENGTH}.`;
            rowError.hidden = false;
          }
          return;
        }
        if (check.text === '') {
          if (rowError) {
            rowError.textContent = 'Empty: use Clear synced text to fall back to the bundled text.';
            rowError.hidden = false;
          }
          return;
        }
        if (check.text === row.synced) {
          drafts.delete(id);
          renderList();
          return;
        }
        if (
          !window.confirm(
            `Send this text to every phone for “${row.name}”?\n\nIt is a live edit: commit it to descriptions.json too (the export above), or the next Upload descriptions run overwrites it.`
          )
        ) {
          return;
        }
        void write(id, check.text, rowError);
        return;
      }
      case 'clear':
        if (
          !window.confirm(
            `Clear the synced text for “${row.name}”? Phones fall back to the bundled text${
              row.bundled ? '' : ' (this waypoint has none)'
            }.`
          )
        ) {
          return;
        }
        void write(id, '', rowError);
        return;
      default:
    }
  });

  list.addEventListener('input', event => {
    const box = event.target as HTMLTextAreaElement;
    const id = box.dataset.draft;
    if (!id) return;
    drafts.set(id, box.value);
    const statusEl = list.querySelector<HTMLElement>(`[data-status="${CSS.escape(id)}"]`);
    if (statusEl) statusEl.innerHTML = draftStatusHtml(checkDraft(box.value));
  });

  summary.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target) return;
    if (target.id === 'desc-download') {
      const text = exportFileText(trailId, fileText, rows);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'descriptions.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (target.id === 'desc-copy') {
      const text = patchSnippet(rows);
      const fallback = (): void => {
        snippetBox.value = text;
        copyFallback.hidden = false;
        snippetBox.select();
      };
      if (!navigator.clipboard?.writeText) {
        fallback();
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        target.textContent = 'Copied';
        setTimeout(() => (target.textContent = 'Copy the changed entries'), 1500);
      }, fallback);
    }
  });

  trailSelect.addEventListener('change', () => void loadTrail(trailSelect.value));
  filterSelect.addEventListener('change', renderList);
  search.addEventListener('input', renderList);
  linkButton.addEventListener('click', askToLink);
  $('desc-reload').addEventListener('click', () => {
    if (trailId) void loadTrail(trailId);
  });

  const start = async (): Promise<void> => {
    let trails: IndexEntry[];
    try {
      const response = await fetch(generatedDataUrl('index.json', SITE_ROOT.topLevel, document.baseURI));
      if (!response.ok) throw new Error(`the trail index answered ${response.status}`);
      trails = (await response.json()) as IndexEntry[];
    } catch (err) {
      status.hidden = true;
      setError(`Could not load the trail list: ${errorText(err)}`);
      return;
    }
    await checkAdmin();
    showIdentity();
    trailSelect.innerHTML = trails
      .map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`)
      .join('');
    controls.hidden = false;
    const wanted = [getQueryParam(window.location.search, 'trail'), readStored()].find(
      id => id && trails.some(t => t.id === id)
    );
    trailSelect.value = wanted ?? trails[0]?.id ?? '';
    if (trailSelect.value) await loadTrail(trailSelect.value);
    else status.hidden = true;
  };

  void start();
}

init();

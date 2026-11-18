/**
 * Boot script for `admin-descriptions.html` — the live description editor on
 * the deployed site. For a bundled trail it lists every waypoint's bundled
 * description (the trail JSON the site serves) beside its synced one (the
 * comments API's public `GET /v1/trails/:id/descriptions`, which every phone
 * pulls and shows over the bundled text), marks where they differ, and lets an
 * admin's linked browser PUT a new synced text or clear it.
 *
 * The drift rule (`docs/waypoint-editor.md`): a live edit that is not in the
 * trail's `descriptions.json` is overwritten by the next *Upload descriptions*
 * run of that trail. The file as this site was built is bundled into this page
 * (a lazy glob of `data/trails/*\/descriptions.json`), and each synced row
 * says which tool last changed it, so the page can tell a live edit to commit
 * from a row that merely waits for an upload, and export the former.
 *
 * Reading needs nothing; editing needs a linked browser whose account the
 * worker treats as an admin (`GET /v1/me` says so up front, and the worker
 * re-checks every PUT). Modelled on `admin-moderation.ts`.
 *
 * Editing also needs a worker that guards writes. The site deploys on merge
 * and the worker by its own workflow, so this page can reach a worker that
 * predates the `source` marker and the `ifUpdatedAt` check: it would take a
 * save without either, last write winning, and store it with no origin, to be
 * read as an upload later and replaced by the next one without a warning. The
 * worker says in every descriptions read whether it honours both
 * (`writeFeatures`), and without that the page is read-only and says why. It
 * never finds out by writing.
 */

import type { WaypointDescription } from '@lib/comments-api-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { ApiError, NetworkError, getApiBase } from './api/client';
import { adminPutDescription, conflictCurrent, fetchMe, fetchSyncedDescriptions } from './api/descriptions';
import { clearSession, loadSession, type WebSession } from './api/session';
import {
  MAX_DESCRIPTION_LENGTH,
  ROW_FILTER_LABELS,
  buildRows,
  checkDraft,
  draftStatusHtml,
  exportFileText,
  fileContext,
  liveEditAdvice,
  matchesRow,
  parseCuratedFile,
  patchSnippet,
  rowHtml,
  summaryHtml,
  trailDirFor,
  trailDirOf,
  trailWaypoints,
  type DescriptionRow,
  type FileContext,
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

const COPY_LABEL = 'Copy the changed entries';

/** Why a save or a clear was not sent, in the row it was asked on. */
const NOT_SENT =
  'Not sent: the comments API has not been deployed with description provenance yet (or this browser may not edit), so nothing can be saved or cleared from this page. See the note above the list.';

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
  const notice = $('desc-notice');
  const unguarded = $('desc-unguarded');
  const noticeText = $('desc-notice-text');
  const toolbar = $('desc-toolbar');
  const identity = $('desc-identity');
  const linkButton = $<HTMLButtonElement>('desc-link-button');
  const retryButton = $<HTMLButtonElement>('desc-check-retry');
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

  /** What went wrong loading a trail (or the trail list). Each load starts by clearing it. */
  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  /** Something about a write that has no row to sit in. Stays until dismissed or replaced. */
  const showNotice = (message: string): void => {
    noticeText.textContent = message;
    notice.hidden = message === '';
  };

  if (!getApiBase()) {
    status.textContent = 'This build has no API configured (VITE_API_BASE_URL).';
    return;
  }

  let session: WebSession | null = loadSession();
  /** The linked account is an admin. Editing also needs `guardsWrites`: see `mayWrite`. */
  let canEdit = false;
  /**
   * Whether the last descriptions read said the worker records a write's
   * source and honours its precondition. Until a read says so, nothing is
   * offered and nothing is sent.
   */
  let guardsWrites = false;
  /** Why `GET /v1/me` could not say whether the linked account is an admin ('' when it answered). */
  let adminError = '';
  let trailId = '';
  let trailDir: string | null = null;
  let fileText: string | null = null;
  let ctx: FileContext = fileContext('', null, null);
  let waypoints: TrailWaypoint[] = [];
  let synced: WaypointDescription[] = [];
  let rows: DescriptionRow[] = [];
  /** Open edit boxes and what they hold, by waypoint id. */
  const drafts = new Map<string, string>();
  /**
   * For each open edit box, the synced row's `updatedAt` when it was opened
   * (null: no row): what the admin was looking at, sent as the save's
   * precondition so it cannot replace a text saved by someone else since.
   */
  const bases = new Map<string, string | null>();
  /** Edit boxes whose save was refused as a conflict, with the server's row (null: none). */
  const conflicts = new Map<string, WaypointDescription | null>();
  /** The markup last drawn for each row in the list, so a refresh replaces only rows that changed. */
  const drawn = new Map<string, string>();
  let summaryDrawn = '';
  /** Bumped per trail load, so an answer that belongs to an earlier list is not drawn into this one. */
  let loadSeq = 0;
  /** Bumped when a PUT is answered, so a refresh that read the rows before it does not put the older row back. */
  let writeSeq = 0;

  for (const [value, label] of Object.entries(ROW_FILTER_LABELS)) {
    filterSelect.insertAdjacentHTML('beforeend', `<option value="${value}">${escapeHtml(label)}</option>`);
  }

  const rowElement = (id: string): HTMLElement | null =>
    list.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);

  /** An admin's browser, talking to a worker that guards writes: the only state a save or a clear is sent in. */
  const mayWrite = (): boolean => session !== null && canEdit && guardsWrites;

  /** Take in what a descriptions read said about the worker; the read-only banner shows while it does not guard writes. */
  const setGuardsWrites = (guards: boolean): void => {
    guardsWrites = guards;
    unguarded.hidden = guards;
  };

  const htmlFor = (row: DescriptionRow): string =>
    rowHtml(row, {
      canEdit: mayWrite(),
      editing: drafts.has(row.id),
      draft: drafts.get(row.id),
      conflict: conflicts.has(row.id) ? conflicts.get(row.id) : undefined,
      ctx,
    });

  const matchingRows = (): DescriptionRow[] => {
    const filter = filterSelect.value as RowFilter;
    return rows.filter(r => matchesRow(r, filter, search.value));
  };

  /** Draw the whole list. Open edit boxes are redrawn from `drafts`, so they keep their text but not the caret. */
  const renderList = (): void => {
    const matching = matchingRows();
    const drawnRows = matching.slice(0, MAX_ROWS);
    shown.textContent =
      matching.length > drawnRows.length
        ? `Showing the first ${drawnRows.length} of ${matching.length}: narrow with the filters or search.`
        : `${matching.length} shown.`;
    drawn.clear();
    for (const r of drawnRows) drawn.set(r.id, htmlFor(r));
    list.innerHTML =
      drawnRows.length > 0 ? [...drawn.values()].join('') : '<p class="import-note">No waypoints match.</p>';
  };

  /** Redraw one row in place, leaving every other row (and any edit box in it) alone. */
  const redrawRow = (id: string): void => {
    const element = rowElement(id);
    const row = rows.find(r => r.id === id);
    if (!element || !row) return;
    const html = htmlFor(row);
    if (drawn.get(id) === html) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && element.contains(active) ? active.dataset.action : undefined;
    element.insertAdjacentHTML('afterend', html);
    element.remove();
    drawn.set(id, html);
    if (focused) rowElement(id)?.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus();
  };

  /**
   * Bring the list up to date after the data changed underneath it, without
   * touching a row whose edit box is open: someone may be typing in it, and
   * its save is checked against what they were shown (`bases`). With no edit
   * box open, a change to which rows match redraws the list.
   */
  const patchRows = (): void => {
    const want = matchingRows().slice(0, MAX_ROWS);
    const have = [...list.querySelectorAll<HTMLElement>('[data-row]')].map(el => el.dataset.row);
    const sameRows = want.length === have.length && want.every((r, i) => r.id === have[i]);
    if (!sameRows && drafts.size === 0) {
      renderList();
      return;
    }
    for (const id of have) {
      if (id && !drafts.has(id)) redrawRow(id);
    }
  };

  const renderSummary = (): void => {
    const html = summaryHtml(rows, ctx);
    if (html === summaryDrawn) return;
    summaryDrawn = html;
    summary.innerHTML = html;
    copyFallback.hidden = true;
  };

  /** Rebuild the rows from the trail, the file and the synced set. */
  const recompute = (): void => {
    ctx = fileContext(trailId, trailDir, fileText);
    rows = buildRows(waypoints, parseCuratedFile(fileText), synced);
  };

  const render = (): void => {
    recompute();
    renderSummary();
    renderList();
  };

  const focusDraft = (id: string): void => {
    list.querySelector<HTMLTextAreaElement>(`[data-draft="${CSS.escape(id)}"]`)?.focus();
  };

  const showRowError = (id: string, message: string): void => {
    const rowError = list.querySelector<HTMLElement>(`[data-error="${CSS.escape(id)}"]`);
    if (!rowError) return;
    rowError.textContent = message;
    rowError.hidden = message === '';
  };

  const setRowBusy = (id: string, busy: boolean): void => {
    for (const b of list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`)) b.disabled = busy;
  };

  const closeEditor = (id: string): void => {
    drafts.delete(id);
    bases.delete(id);
    conflicts.delete(id);
  };

  const showIdentity = (): void => {
    toolbar.hidden = false;
    linkButton.hidden = session !== null;
    retryButton.hidden = !(session && adminError);
    const who = session?.displayName || 'this account';
    if (!session) identity.textContent = 'Read-only: link this browser to an admin account to edit.';
    else if (adminError) {
      identity.textContent = `Linked as ${who}. Could not check whether this account is an admin (${adminError}), so the page is read-only until the check succeeds.`;
    } else if (canEdit) identity.textContent = `Linked as ${who} (admin).`;
    else identity.textContent = `Linked as ${who}, which is not an admin: read-only.`;
  };

  /**
   * Ask the API whether the linked account is an admin. A failure that is not
   * "this browser is no longer linked" leaves the answer unknown (`adminError`),
   * which is shown as such with a retry, never as "not an admin".
   */
  const checkAdmin = async (): Promise<void> => {
    canEdit = false;
    adminError = '';
    if (!session) return;
    try {
      canEdit = (await fetchMe(session)).isAdmin;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
      } else {
        adminError = errorText(err);
      }
    }
  };

  const loadTrail = async (id: string): Promise<void> => {
    const seq = ++loadSeq;
    trailId = id;
    store(id);
    drafts.clear();
    bases.clear();
    conflicts.clear();
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
      synced = live.descriptions;
      setGuardsWrites(live.guardsWrites);
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

  /** Re-read the synced set after a write, keeping the page, and any open edit box, where it is. */
  const refreshSynced = async (): Promise<void> => {
    const seq = loadSeq;
    const writes = writeSeq;
    const live = await fetchSyncedDescriptions(trailId);
    if (seq !== loadSeq || writes !== writeSeq) return;
    synced = live.descriptions;
    setGuardsWrites(live.guardsWrites);
    recompute();
    renderSummary();
    patchRows();
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
          if (trailId && !section.hidden) renderList();
        });
      }
    );
  };

  /**
   * PUT a waypoint's synced text ('' clears it) as a live edit, on the trail
   * and the list that are on screen now. The answer is drawn only if that list
   * is still the one on screen (`loadSeq`): after a switch of trail it belongs
   * to no row here.
   */
  const write = async (id: string, description: string): Promise<void> => {
    // The last check before a request: whatever led here, nothing is sent to a
    // worker that has not said it guards writes.
    if (!session || !mayWrite()) {
      showRowError(id, NOT_SENT);
      return;
    }
    const seq = loadSeq;
    const trail = trailId;
    const before = rows.find(r => r.id === id);
    const name = before?.name ?? id;
    // What the admin was shown: the row as it was when its edit box opened, else as drawn.
    const readUpdatedAt = bases.has(id) ? (bases.get(id) ?? null) : (before?.syncedAt ?? null);
    showRowError(id, '');
    setRowBusy(id, true);

    let stored: WaypointDescription;
    try {
      stored = await adminPutDescription(session, trail, id, description, readUpdatedAt);
    } catch (err) {
      if (seq !== loadSeq) {
        showNotice(`Saving “${name}” on ${trail} failed after the list changed: ${errorText(err)}`);
        return;
      }
      const current = conflictCurrent(err);
      if (current !== undefined) {
        // Someone else changed the row. Show theirs, keep this admin's draft,
        // and make theirs the version the next save is checked against.
        writeSeq++;
        synced = [...synced.filter(s => s.waypointId !== id), ...(current ? [current] : [])];
        recompute();
        renderSummary();
        if (drafts.has(id)) {
          bases.set(id, current?.updatedAt ?? null);
          conflicts.set(id, current);
          redrawRow(id);
          setRowBusy(id, false);
          focusDraft(id);
        } else {
          redrawRow(id);
          setRowBusy(id, false);
          showRowError(
            id,
            'Not cleared: this synced text changed after this page read it. The row now shows what the server has; clear it again if it should still go.'
          );
        }
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
        canEdit = false;
        adminError = '';
        showIdentity();
        renderList();
        askToLink();
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        canEdit = false;
        showIdentity();
      }
      setRowBusy(id, false);
      showRowError(id, `Failed: ${errorText(err)}`);
      return;
    }

    // Defence in depth: the read said this worker records the source, and its
    // answer to the PUT names none (it was replaced by an older one between the
    // two). The text is saved but not as a live edit; stop writing, and say so.
    const unrecorded = stored.source === undefined;
    if (unrecorded) {
      setGuardsWrites(false);
      showNotice(
        `Saved “${name}” on ${trail}, but the API did not record it as a live edit (it answered as a worker that predates description provenance does). The export will not include it and the next upload replaces it without a warning: commit it to descriptions.json by hand now.`
      );
    }
    if (seq !== loadSeq) {
      // Written, but the list on screen is no longer the one it was written
      // from. Another trail's list has no row for it; a reload of this trail
      // may have read the synced set before the write landed, so read again.
      if (trailId !== trail) {
        if (!unrecorded) showNotice(`Saved “${name}” on ${trail}.`);
      } else if (section.hidden) void loadTrail(trail);
      else {
        void refreshSynced().catch(() => {
          /* Reload reads it again */
        });
      }
      return;
    }
    writeSeq++;
    if (description !== '') closeEditor(id);
    else if (drafts.has(id)) {
      // A clear beside an open edit box: the draft stays, now based on the cleared row.
      bases.set(id, stored.updatedAt);
      conflicts.delete(id);
    }
    synced = [...synced.filter(s => s.waypointId !== id), stored];
    recompute();
    renderSummary();
    if (unrecorded) renderList();
    else redrawRow(id);
    setRowBusy(id, false);
    void refreshSynced().catch(() => {
      /* the PUT's answer is already drawn */
    });
  };

  list.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!target) return;
    const id = target.dataset.id!;
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const action = target.dataset.action;
    // The buttons are not drawn unless the page may write; a click that gets
    // here anyway (an edit box left open when the worker stopped guarding
    // writes) opens nothing and sends nothing. Cancel always works.
    if ((action === 'edit' || action === 'save' || action === 'clear') && !mayWrite()) {
      showRowError(id, NOT_SENT);
      return;
    }
    switch (action) {
      case 'edit':
        drafts.set(id, row.synced || row.bundled);
        bases.set(id, row.syncedAt ?? null);
        redrawRow(id);
        focusDraft(id);
        return;
      case 'cancel':
        closeEditor(id);
        redrawRow(id);
        return;
      case 'save': {
        const check = checkDraft(drafts.get(id) ?? '');
        if (check.tooLong) {
          showRowError(id, `Too long: ${check.length} characters, the most is ${MAX_DESCRIPTION_LENGTH}.`);
          return;
        }
        if (check.text === '') {
          showRowError(id, 'Empty: use Clear synced text to fall back to the bundled text.');
          return;
        }
        if (check.text === row.synced) {
          closeEditor(id);
          redrawRow(id);
          return;
        }
        if (!window.confirm(`Send this text to every phone for “${row.name}”?\n\n${liveEditAdvice(row, ctx)}`)) return;
        void write(id, check.text);
        return;
      }
      case 'clear':
        if (
          !window.confirm(
            `Clear the synced text for “${row.name}”? Phones fall back to the bundled text${
              row.bundled ? '' : ' (this waypoint has none)'
            }.${
              row.file !== undefined
                ? '\n\ndescriptions.json has an entry for this waypoint, so the next upload re-sends the file’s text.'
                : ''
            }`
          )
        ) {
          return;
        }
        void write(id, '');
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
        setTimeout(() => (target.textContent = COPY_LABEL), 1500);
      }, fallback);
    }
  });

  trailSelect.addEventListener('change', () => void loadTrail(trailSelect.value));
  filterSelect.addEventListener('change', renderList);
  search.addEventListener('input', renderList);
  linkButton.addEventListener('click', askToLink);
  retryButton.addEventListener('click', () => {
    retryButton.disabled = true;
    identity.textContent = 'Checking this browser’s account…';
    void checkAdmin().then(() => {
      retryButton.disabled = false;
      showIdentity();
      if (trailId && !section.hidden) renderList();
    });
  });
  $('desc-notice-dismiss').addEventListener('click', () => showNotice(''));
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

/**
 * The resupply page — the numbers and the options, not a map.
 *
 * One row per candidate stop, in trail order: km, store, the way off the route,
 * whether it holds boxes, a Yes/No (or, where one turn-off leads to several
 * towns, pick one or "none – carry through"), the hiker's zero days there, and
 * the leg that arrives there from the previous chosen stop. A summary strip of
 * `summariseResupplyPlan` sits above. Modelled on the owner's spreadsheet.
 *
 * It edits the same `PlanDocument` as the planner (`plan-state.ts` for
 * `localStorage`, `plan-sync.ts` for the server), through `@lib/plan-editor`
 * only, and reads the same per-browser `PlanUiPrefs` for pace, hours, food per
 * day and the long-carry threshold — so a change here is a change there. Every
 * figure is `computeResupplyLegs`'; this file never works one out itself.
 *
 * Two deliberate omissions: no arrival dates, and no camp plan handed to
 * `computeResupplyLegs` (`days`) — the legs are walking days, and the zero days
 * entered here are added once, by `summariseResupplyPlan`.
 *
 * Stored stop km are NOBO-absolute, but this page never writes a stop: what it
 * edits — the resupply selection, the zero days (both by option id) and the
 * direction — is the same in either direction and on any route, so it edits the
 * stored document directly. It reads the planned route (alternates taken) and
 * the active direction exactly as the planner does.
 */

import type { Pace, PlanDocument, PlanThresholds, PlanTrackPoint, PlanWaypoint } from '@lib/plan-types';
import { PACE_KMH, PLAN_THRESHOLD_BOUNDS, PLAN_THRESHOLD_STEPS, isPace } from '@lib/plan-types';
import {
  chooseResupplyOption,
  refreshStopKms,
  servicesAtStop,
  setDirection as editDirection,
  setResupplyZeroDays,
  stampPlanData,
} from '@lib/plan-editor';
import { plannedRouteFor, plannedRouteTrail, type PlannedRoute } from '@lib/plan-alternates';
import {
  computeResupplyLegs,
  listResupplyOptions,
  resolveResupplyStops,
  resupplyCandidates,
  summariseResupplyPlan,
  type ResupplyLeg,
  type ResupplyOptionGroup,
} from '@lib/resupply-plan';
import { createReversedTrail } from '@lib/trail-reverse';
import { getDirectionLabel, type PlanDirection } from '@lib/plan-direction';
import type { RouteBreak, RouteVariant, TrailPOI } from '@lib/trail-types';
import {
  DAILY_HOURS_RANGE,
  loadOrMigratePlan,
  loadPlanDocument,
  loadPlanUiPrefs,
  parseDailyHours,
  parseThreshold,
  planStorageKind,
  prefDailyHours,
  prefPace,
  prefThreshold,
  savePlanDocument,
  savePlanUiPrefs,
  type PlanUiPrefs,
} from './plan-state';
import { initPlanSync, type PlanSyncController, type PlanSyncHost } from './plan-sync';
import { mountPlanSyncDialogs } from './plan-sync-markup';
import { buildResupplyView, renderResupplySummary, renderResupplyTable } from './resupply-view';
import { SITE_ROOT, escapeHtml, generatedDataUrl } from '../web-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The trail as the generated JSON (or an imported record) has it — the fields this page reads. */
export interface ResupplyPageTrail {
  config: {
    id: string;
    name: string;
    shortName?: string;
    direction?: { default: string; reversed: string };
  };
  track: {
    points: PlanTrackPoint[];
    displayPoints?: PlanTrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
    breaks?: RouteBreak[];
  };
  waypoints?: PlanWaypoint[];
  alternates?: RouteVariant[];
  sideTrips?: RouteVariant[];
  pois?: TrailPOI[];
  dataUpdatedAt?: string;
}

export interface ResupplyPageOptions {
  /** The planner focused on one option: `plan.html?focus=<id>` or `my-plan.html?id=…&focus=<id>`. */
  plannerHref: (focusOptionId?: string) => string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trailId = '';
let trail: ResupplyPageTrail;
let storedPlan: PlanDocument;
let uiPrefs: PlanUiPrefs = { showAllWaypoints: false };
let plannedRoute: PlannedRoute;
let routeTrail: ResupplyPageTrail;
let reversedTrail: ResupplyPageTrail | null = null;
let pageOptions: ResupplyPageOptions;
let syncController: PlanSyncController | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let booted = false;

let cachedGroups: ResupplyOptionGroup[] = [];
let cachedGroupsKey: string | null = null;
let cachedLegs: ResupplyLeg[] = [];
let cachedLegsKey: string | null = null;

const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function direction(): PlanDirection {
  return storedPlan.direction;
}

function directionLabel(dir: PlanDirection): string {
  return getDirectionLabel(trail.config.direction, dir, { default: 'NOBO', reversed: 'SOBO' });
}

/** The planned route in the active direction — what the planner computes its legs over. */
function activeTrail(): ResupplyPageTrail {
  return direction() === 'SOBO' ? (reversedTrail ??= createReversedTrail(routeTrail)) : routeTrail;
}

function threshold(key: keyof PlanThresholds): number {
  return prefThreshold(uiPrefs, key);
}

/** Take a document as the page's plan, rebuilding the route when its alternates changed. */
function adoptPlan(doc: PlanDocument): void {
  storedPlan = doc;
  const route = plannedRouteFor(trail, doc);
  if (route !== plannedRoute) {
    plannedRoute = route;
    routeTrail = plannedRouteTrail(trail, route);
    reversedTrail = null;
    cachedGroupsKey = null;
    cachedLegsKey = null;
  }
}

function groups(): ResupplyOptionGroup[] {
  const key = `${direction()}|${JSON.stringify(storedPlan.alternates ?? [])}`;
  if (key !== cachedGroupsKey) {
    cachedGroups = listResupplyOptions(resupplyCandidates(activeTrail()));
    cachedGroupsKey = key;
    cachedLegsKey = null;
  }
  return cachedGroups;
}

/**
 * The legs between the chosen stops. No `days`: arrival dates are not this
 * page's question, and the zero days are counted once, in the summary.
 */
function legs(): ResupplyLeg[] {
  const options = groups();
  const key = [
    cachedGroupsKey,
    JSON.stringify(storedPlan.resupplyStops ?? null),
    JSON.stringify(storedPlan.resupplyZeroDays ?? null),
    prefPace(uiPrefs),
    prefDailyHours(uiPrefs),
    threshold('longCarryDays'),
    threshold('foodGramsPerDay'),
  ].join('|');
  if (key !== cachedLegsKey) {
    cachedLegs = computeResupplyLegs(activeTrail(), resolveResupplyStops(options, storedPlan.resupplyStops), {
      dailyHours: prefDailyHours(uiPrefs),
      baseKmh: PACE_KMH[prefPace(uiPrefs)],
      longThresholdDays: threshold('longCarryDays'),
      gramsPerDay: threshold('foodGramsPerDay'),
      zeroDays: storedPlan.resupplyZeroDays,
    });
    cachedLegsKey = key;
  }
  return cachedLegs;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  const options = groups();
  const view = buildResupplyView({
    groups: options,
    selectedIds: storedPlan.resupplyStops,
    legs: legs(),
    zeroDays: storedPlan.resupplyZeroDays,
    totalKm: activeTrail().track.totalDistance,
  });

  const summary = byId('rs-summary');
  if (summary) summary.innerHTML = renderResupplySummary(summariseResupplyPlan(legs()), view.undecidedCount);

  const table = byId('rs-table');
  if (table) {
    table.innerHTML =
      options.length === 0
        ? '<p class="rs-empty-note">This trail has no resupply points — the one leg below is the full carry.</p>' +
          renderResupplyTable(view, { mapHref: () => null })
        : renderResupplyTable(view, {
            mapHref: id => pageOptions.plannerHref(id),
            services: km => servicesAtStop({ km }, activeTrail().pois),
          });
  }

  const planName = byId('rs-plan-name');
  if (planName) planName.textContent = storedPlan.name;
  updateDirectionButton();
}

function updateDirectionButton(): void {
  const label = byId('rs-direction-label');
  const btn = byId<HTMLButtonElement>('rs-direction');
  if (label) label.textContent = directionLabel(direction());
  if (btn) btn.title = `Switch to ${directionLabel(direction() === 'NOBO' ? 'SOBO' : 'NOBO')}`;
}

/** The controls above the table: plan, direction, the hiker's inputs, sync. */
function controlsHtml(): string {
  const paceOptions = Object.entries(PACE_KMH)
    .map(
      ([value, kmh]) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(`${value[0].toUpperCase()}${value.slice(1)} (${kmh} km/h)`)}</option>`
    )
    .join('');
  const thresholdInput = (id: string, key: keyof PlanThresholds) =>
    `<input type="number" id="${id}" class="rs-input" inputmode="numeric" min="${PLAN_THRESHOLD_BOUNDS[key].min}"` +
    ` max="${PLAN_THRESHOLD_BOUNDS[key].max}" step="${PLAN_THRESHOLD_STEPS[key]}" />`;
  return `<div class="rs-bar">
      <div class="rs-bar-plan">
        <span class="rs-bar-label">Plan</span>
        <span id="rs-plan-name" class="rs-plan-name"></span>
        <button type="button" id="rs-direction" class="plan-header-btn rs-direction">
          <span aria-hidden="true">⇄</span> <span id="rs-direction-label">NOBO</span>
        </button>
        <a id="rs-planner-link" class="plan-header-btn" href="#">Open the planner</a>
      </div>
      <div class="rs-bar-sync">
        <span id="save-status">Saved</span>
        <span id="sync-status" hidden></span>
        <button type="button" id="sync-btn" class="plan-header-btn" hidden>Sync</button>
        <button type="button" id="share-btn" class="plan-header-btn" hidden>Share</button>
      </div>
    </div>
    <fieldset class="rs-inputs">
      <legend>Your figures</legend>
      <label class="rs-field">Pace <select id="rs-pace" class="rs-input">${paceOptions}</select></label>
      <label class="rs-field">Hours/day
        <input type="number" id="rs-hours" class="rs-input" inputmode="numeric" min="${DAILY_HOURS_RANGE.min}" max="${DAILY_HOURS_RANGE.max}" step="1" />
      </label>
      <label class="rs-field">Food per day ${thresholdInput('rs-food-grams', 'foodGramsPerDay')} g</label>
      <label class="rs-field">Long carry over ${thresholdInput('rs-long-carry', 'longCarryDays')} days</label>
      <p class="rs-inputs-note">Shared with the planner on this browser. Leg days come from your pace and hours over each leg's distance and climb.</p>
    </fieldset>`;
}

function fillInputs(): void {
  const pace = byId<HTMLSelectElement>('rs-pace');
  if (pace) pace.value = prefPace(uiPrefs);
  const hours = byId<HTMLInputElement>('rs-hours');
  if (hours) hours.value = String(prefDailyHours(uiPrefs));
  const food = byId<HTMLInputElement>('rs-food-grams');
  if (food) food.value = String(threshold('foodGramsPerDay'));
  const carry = byId<HTMLInputElement>('rs-long-carry');
  if (carry) carry.value = String(threshold('longCarryDays'));
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** Take an edited document, unless the editor returned the same one (a no-op). */
function applyEdit(next: PlanDocument): void {
  if (next === storedPlan) return;
  adoptPlan(next);
  scheduleSave();
  render();
}

function tryEdit(edit: () => PlanDocument): void {
  let next: PlanDocument;
  try {
    next = edit();
  } catch (err) {
    setEditError(err);
    render();
    return;
  }
  applyEdit(next);
}

/** A radio in a group: an option id, or '' for "No" / "None – carry through". */
function chooseOption(groupKey: string, value: string): void {
  tryEdit(() => chooseResupplyOption(storedPlan, groups(), groupKey, value === '' ? null : value));
}

/** A zero-days entry: whole or half days, 0 clears it. A blank or bad entry is put back. */
function setZeroDays(optionId: string, raw: string): void {
  const parsed = raw.trim() === '' ? 0 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    render();
    return;
  }
  const days = Math.round(parsed * 2) / 2;
  tryEdit(() => setResupplyZeroDays(storedPlan, optionId, days));
}

function setUiPrefs(patch: Partial<PlanUiPrefs>): void {
  uiPrefs = { ...uiPrefs, ...patch };
  savePlanUiPrefs(trailId, uiPrefs);
  render();
}

function bindControls(): void {
  const pace = byId<HTMLSelectElement>('rs-pace');
  pace?.addEventListener('change', () => {
    if (isPace(pace.value) && pace.value !== prefPace(uiPrefs)) setUiPrefs({ pace: pace.value as Pace });
  });

  const hours = byId<HTMLInputElement>('rs-hours');
  hours?.addEventListener('change', () => {
    const value = parseDailyHours(hours.value);
    if (value !== null && value !== prefDailyHours(uiPrefs)) setUiPrefs({ dailyHours: value });
    // A rejected entry shows what is in force.
    hours.value = String(prefDailyHours(uiPrefs));
  });

  const bindThreshold = (id: string, key: keyof PlanThresholds) => {
    const input = byId<HTMLInputElement>(id);
    input?.addEventListener('change', () => {
      const value = parseThreshold(key, input.value);
      if (value !== null && value !== threshold(key)) setUiPrefs({ [key]: value });
      input.value = String(threshold(key));
    });
  };
  bindThreshold('rs-food-grams', 'foodGramsPerDay');
  bindThreshold('rs-long-carry', 'longCarryDays');

  byId('rs-direction')?.addEventListener('click', () => {
    applyEdit(editDirection(storedPlan, direction() === 'NOBO' ? 'SOBO' : 'NOBO'));
  });

  const plannerLink = byId<HTMLAnchorElement>('rs-planner-link');
  if (plannerLink) plannerLink.href = pageOptions.plannerHref();

  // Delegated: every render replaces the table's contents.
  const table = byId('rs-table');
  table?.addEventListener('change', event => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target.type === 'radio' && target.name.startsWith('rs-group-')) {
      const groupKey = target.closest<HTMLElement>('.rs-group')?.dataset.groupKey;
      if (groupKey) chooseOption(groupKey, target.value);
      return;
    }
    if (target.classList.contains('rs-zero') && target.dataset.optionId) {
      setZeroDays(target.dataset.optionId, target.value);
    }
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scheduleSave(): void {
  setSaveStatus('unsaved');
  cancelPendingSave();
  saveDebounceTimer = setTimeout(commitSave, 800);
}

function cancelPendingSave(): void {
  if (saveDebounceTimer === null) return;
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = null;
}

/** Local first, then the sync arm — the planner's order. */
function commitSave(): void {
  saveDebounceTimer = null;
  const stamped = stampPlanData(storedPlan, trail.dataUpdatedAt);
  if (stamped !== storedPlan) adoptPlan(stamped);
  const ok = savePlanDocument(trailId, storedPlan);
  setSaveStatus(ok ? 'saved' : 'error');
  syncController?.onLocalSave();
}

function setSaveStatus(status: 'saved' | 'unsaved' | 'error'): void {
  const el = byId('save-status');
  if (!el) return;
  el.textContent = status === 'error' ? 'Save failed' : status === 'saved' ? 'Saved' : 'Unsaved…';
  el.className = status === 'saved' ? '' : 'unsaved';
}

function setEditError(err: unknown): void {
  const el = byId('save-status');
  if (!el) return;
  const message = err instanceof Error ? err.message : String(err);
  el.textContent = message.replace(/^[\w-]+:\s*/, '') || 'That change was refused';
  el.className = 'unsaved';
}

function planSyncHost(): PlanSyncHost {
  return {
    trailId,
    getPlan: () => storedPlan,
    adoptServerPlan(next: PlanDocument): void {
      // The planner's rule: the server's copy wins and is stored as it came,
      // unless a data update moved one of its places — then the corrected copy
      // is ours to save and send back.
      cancelPendingSave();
      const refreshed = refreshStopKms(next, trail, { dataUpdatedAt: trail.dataUpdatedAt ?? null });
      adoptPlan(refreshed);
      savePlanDocument(trailId, storedPlan);
      setSaveStatus('saved');
      if (refreshed !== next) scheduleSave();
      render();
    },
    stampPlan(patch: Partial<PlanDocument>): void {
      adoptPlan({ ...storedPlan, ...patch });
      savePlanDocument(trailId, storedPlan);
    },
    flushPendingSave(): boolean {
      if (saveDebounceTimer === null) return false;
      cancelPendingSave();
      const ok = savePlanDocument(trailId, storedPlan);
      setSaveStatus(ok ? 'saved' : 'error');
      return true;
    },
  };
}

/**
 * Follow the planner open in another tab: its saves land in `localStorage`,
 * and the `storage` event says so. An edit of ours still waiting on the save
 * debounce wins — it is newer, and its save will overwrite the other tab's.
 */
function onStorage(event: StorageEvent): void {
  const kind = planStorageKind(event.key, trailId);
  if (kind === 'document') {
    if (saveDebounceTimer !== null) return;
    const doc = loadPlanDocument(trailId);
    if (doc && doc !== storedPlan) {
      adoptPlan(doc);
      render();
    }
  } else if (kind === 'prefs') {
    uiPrefs = loadPlanUiPrefs(trailId);
    fillInputs();
    render();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadTrailData(id: string): Promise<ResupplyPageTrail | null> {
  try {
    const response = await fetch(generatedDataUrl(`${id}.json`, SITE_ROOT.trailPage, document.baseURI));
    if (!response.ok) return null;
    return (await response.json()) as ResupplyPageTrail;
  } catch {
    return null;
  }
}

/**
 * Boot the resupply page into `#resupply-app`.
 *
 * @param id  The key the plan is stored under (the trail id, or an import's `u_` id).
 * @param preloadedTrail  An imported trail read from IndexedDB; omitted, the
 *   bundled trail's generated JSON is fetched.
 */
export async function initResupplyPage(
  id: string,
  preloadedTrail: ResupplyPageTrail | undefined,
  options: ResupplyPageOptions
): Promise<void> {
  if (booted) throw new Error('initResupplyPage: the page is already booted');
  booted = true;
  const root = byId('resupply-app');
  if (!root) throw new Error('initResupplyPage: no #resupply-app');

  const data = preloadedTrail ?? (await loadTrailData(id));
  if (!data) {
    root.innerHTML = '<p class="rs-empty-note">Trail data not found.</p>';
    return;
  }
  // Save to the slot it was loaded from, whatever the record's own config says.
  if (data.config.id !== id) data.config.id = id;

  trailId = id;
  trail = data;
  routeTrail = data;
  pageOptions = options;
  reversedTrail = null;
  cachedGroupsKey = null;
  cachedLegsKey = null;
  plannedRoute = plannedRouteFor(trail, undefined);

  const loaded = loadOrMigratePlan(id, trail).plan;
  // As the planner does on load: a stop a data update moved goes with its place.
  const stored = refreshStopKms(loaded, trail, { dataUpdatedAt: trail.dataUpdatedAt ?? null });
  uiPrefs = loadPlanUiPrefs(id);
  adoptPlan(stored);

  root.innerHTML = `${controlsHtml()}
    <section id="rs-summary" class="rs-summary" aria-label="Totals"></section>
    <section id="rs-table" class="rs-table-wrap" aria-label="Resupply stops"></section>
    <p class="rs-footnote">Leg km is walked distance: trail km plus any side trip to the stop and back.
      Hitches, shuttles and boats are listed under the leg and never counted as walking. Days and food
      cover walking days only; zero days are added once, in the total.</p>`;
  mountPlanSyncDialogs(document.body);

  fillInputs();
  bindControls();
  render();

  syncController = initPlanSync(planSyncHost());
  if (stored !== loaded) scheduleSave();
  window.addEventListener('storage', onStorage);
}

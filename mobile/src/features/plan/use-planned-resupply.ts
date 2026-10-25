/**
 * The one read of "which waypoints are planned resupply stops".
 *
 * Every surface that highlights a plan — map markers, elevation ticks, the list
 * pane's pill and chip, the waypoint detail banner, the hike distance strip —
 * calls this hook and nothing else, so "planned" cannot come to mean different
 * things on different screens. `null` means no plan has been made, which every
 * caller must read as "nothing is planned", never "everything is".
 *
 * The turn-off resolution (a ticked place also plans the point on the route you
 * leave at to reach it, because that is the km the food has to reach — and only
 * that point, never another town on the same hitch) lives in
 * `@lib/resupply-plan`, so no surface here learns what an option group is.
 *
 * `useWaypointResupplyPlan` at the foot of the file is the detail screen's
 * version of the same read: it answers what to show AND what a tap should do,
 * so those two can never disagree.
 *
 * **The selection lives in the plan document**, next to the stops, because it
 * is the same choice the web page writes into the same synced `PlanDocument` —
 * a device-local copy would mean a hiker's browser and phone quietly disagreed
 * about which towns they were posting food to. The old device-local field
 * (`plan-inputs-store`'s `resupplyStops`) is still READ, as a fallback for a
 * selection made before this build, and cleared by Reset; nothing writes it.
 * Pace and daily hours stay there, deliberately: they are how fast this hiker
 * walks, not part of the plan the two platforms share.
 */

import { useCallback, useMemo } from 'react';
import {
  allResupplyOptionIds,
  listResupplyOptions,
  plannedResupplyIds,
  resolveResupplyStops,
  resupplyCandidates,
  type ResupplyOptionGroup,
  type ResupplyStop,
  type ResupplyTrail,
} from '@lib/resupply-plan';
import { setResupplyStops } from '@lib/plan-editor';
import { selectResupplyStops, usePlansStore, type PlanDefaults } from '../../state/plans-store';
import { selectPrefs, usePlanInputsStore } from './plan-inputs-store';
import { waypointResupplyEditor } from './resupply-planner';

/**
 * What this module needs from a trail: its waypoints, and the side trips (and
 * off-route records) that lead to a town off the route.
 */
export type PlannedResupplyTrail = ResupplyTrail;

/** The trail's resupply options, side-trip towns included, grouped by turn-off. */
export function resupplyGroupsFor(trail: PlannedResupplyTrail): ResupplyOptionGroup[] {
  return listResupplyOptions(resupplyCandidates(trail));
}

/**
 * Pure half of the hook: resolve a stored selection against a trail's options.
 * Direction does not matter — a flip mirrors km, not ids.
 */
export function plannedIdsFor(
  trail: PlannedResupplyTrail,
  selected: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  return plannedResupplyIds(resupplyGroupsFor(trail), selected);
}

/**
 * The trail's stored selection: the plan document's, or — only while the
 * document has none — the device-local one a pre-sync build left behind.
 *
 * Returns the stored array itself as well as the Set, because a write has to
 * start from the list the hiker is looking at. Both keep a stable identity
 * while the selection does, so a caller's memo does not churn.
 *
 * The plans store is hydrated by whatever screen the hiker opened (the guide
 * does it on mount, `GuideView`), so an unhydrated cache reads as "no document
 * yet" for one frame — the same thing it reads as for a trail with no plan.
 */
function useStoredResupplyStops(trailId: string): {
  stored: string[] | undefined;
  selected: ReadonlySet<string> | null;
} {
  const planned = usePlansStore(selectResupplyStops(trailId));
  const legacy = usePlanInputsStore(selectPrefs(trailId)).resupplyStops;
  const stored = planned ?? legacy;
  const selected = useMemo(() => (stored ? new Set(stored) : null), [stored]);
  return { stored, selected };
}

/**
 * Store an explicit selection in the trail's plan, minting the plan if this is
 * the hiker's first edit to it. The write is floating on purpose: `apply` never
 * rejects, and every caller is an `onPress`.
 */
export function saveResupplyStops(
  trailId: string,
  ids: readonly string[],
  defaults: PlanDefaults,
): void {
  void usePlansStore.getState().apply(trailId, (p) => setResupplyStops(p, ids), defaults);
}

/**
 * Back to "no plan made" — which is what turns every planned highlight off.
 * Both copies go: the document's field, and the legacy device-local one, or a
 * selection made before this build would come straight back as the fallback.
 */
export function resetResupplyStops(trailId: string, defaults: PlanDefaults): void {
  void usePlansStore.getState().apply(trailId, (p) => setResupplyStops(p, undefined), defaults);
  usePlanInputsStore.getState().clearResupplyStops(trailId);
}

/**
 * The trail's planned resupply waypoint ids, reactive to the stored selection.
 * `trailId` and `trail` are separate because the guide's trail is the
 * direction-applied one while the selection is keyed by the plain trail id.
 */
export function usePlannedResupplyIds(
  trailId: string,
  trail: PlannedResupplyTrail,
): ReadonlySet<string> | null {
  const { selected } = useStoredResupplyStops(trailId);
  // Grouping the whole CDT's 80 options is not free; key it on the trail alone
  // so ticking a box does not regroup.
  const groups = useMemo(() => resupplyGroupsFor(trail), [trail]);
  return useMemo(() => plannedResupplyIds(groups, selected), [groups, selected]);
}

/**
 * The hiker's planned resupply stops, each with how it is reached off the
 * route — `null` until a plan is made, like `usePlannedResupplyIds`. The
 * distance strip reads this, not the waypoint ids, so its "Next resupply" can
 * measure into a town a side trip leads to, which no main-route waypoint is.
 */
export function usePlannedResupplyStops(
  trailId: string,
  trail: PlannedResupplyTrail,
): ResupplyStop[] | null {
  const { selected } = useStoredResupplyStops(trailId);
  const groups = useMemo(() => resupplyGroupsFor(trail), [trail]);
  return useMemo(
    () => (selected ? resolveResupplyStops(groups, [...selected]) : null),
    [groups, selected],
  );
}

/**
 * What the waypoint detail screen shows and does about the resupply plan.
 *
 * The screen must not read one thing and write another: it shows the *derived*
 * planned state (`plannedResupplyIds`, which also plans a ticked place's
 * turn-off) while the store holds the hiker's ticks. So this hook answers both
 * halves together —
 *
 *  - `isPlanned` drives the banner, and `plannedVia` names the ticked place
 *    when this waypoint is planned only because it serves one. A turn-off
 *    cannot be unticked on its own (it was never ticked), so it is offered no
 *    toggle: the banner says where the plan came from and the place it serves
 *    is where to change it.
 *  - `toggle` is null unless the trail actually offers this waypoint as an
 *    option. A resupply-family waypoint the options list does not hold (no id,
 *    or no km to place it at) would otherwise store the whole option list on
 *    its first tap and invent a plan nobody made.
 *  - `isSelected` is the hiker's own tick, so the button's label and its action
 *    are the same fact.
 *  - The toggle is the resupply screen's decision (`waypointResupplyEditor`):
 *    "Plan resupply here" picks this place in its turn-off's group, so the
 *    group ends up decided rather than holding one more tick; "Remove" of the
 *    group's chosen place carries the group through. A lone place is Yes/No.
 */
export interface WaypointResupplyPlan {
  /** Highlighted as a planned stop anywhere in the app. */
  isPlanned: boolean;
  /** The ticked option(s) this waypoint is planned through, when it is not one itself. */
  plannedVia: string | null;
  /** In the hiker's selection — what the toggle's label describes. */
  isSelected: boolean;
  /** Tick or untick this waypoint, or null when no toggle should be offered. */
  toggle: (() => void) | null;
}

export function useWaypointResupplyPlan(
  trailId: string,
  trail: PlannedResupplyTrail,
  waypointId: string | null | undefined,
  /** What to mint the plan with, should this tap be the first edit to it. */
  defaults: PlanDefaults,
): WaypointResupplyPlan {
  const { selected } = useStoredResupplyStops(trailId);
  // Keyed on the trail alone, as `usePlannedResupplyIds` is: ticking a box must
  // not regroup the CDT's 70 options.
  const groups = useMemo(() => resupplyGroupsFor(trail), [trail]);
  const allIds = useMemo(() => allResupplyOptionIds(groups), [groups]);
  const planned = useMemo(() => plannedResupplyIds(groups, selected), [groups, selected]);

  const optionId = waypointId != null && allIds.includes(waypointId) ? waypointId : null;
  const isSelected = optionId != null && (selected?.has(optionId) ?? false);
  const isPlanned = optionId != null && (planned?.has(optionId) ?? false);
  const plannedVia =
    optionId != null && isPlanned && !isSelected
      ? tickedNamesAround(groups, selected, optionId)
      : null;

  // A decision, as on the resupply screen: planning picks this place in its
  // group, removing the chosen place carries the group through. The label's
  // direction (`isSelected`) is fixed at the tap; the list is read off the
  // document when the edit runs.
  const toggle = useCallback(() => {
    if (!optionId) return;
    const legacy = () => selectPrefs(trailId)(usePlanInputsStore.getState()).resupplyStops;
    void usePlansStore
      .getState()
      .apply(trailId, waypointResupplyEditor(groups, optionId, !isSelected, legacy), defaults);
  }, [defaults, groups, isSelected, optionId, trailId]);

  return {
    isPlanned,
    plannedVia,
    isSelected,
    toggle: optionId != null && plannedVia == null ? toggle : null,
  };
}

/** The ticked options sharing a group with `optionId`, named the way a stop is. */
function tickedNamesAround(
  groups: readonly ResupplyOptionGroup[],
  selected: ReadonlySet<string> | null,
  optionId: string,
): string | null {
  if (!selected) return null;
  const group = groups.find((g) => g.options.some((o) => o.id === optionId));
  const names = (group?.options ?? [])
    .filter((o) => o.id !== optionId && selected.has(o.id))
    .map((o) => o.name);
  return names.length > 0 ? names.join(' / ') : null;
}

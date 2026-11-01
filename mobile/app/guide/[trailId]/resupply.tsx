/**
 * Resupply — the planner, a full screen in the guide stack.
 *
 * Reached from the Plan screen's Resupply row (near its top), from a resupply
 * waypoint's detail screen, and by deep link (`tracknotes://guide/<id>/resupply`).
 * It shows every decision group the trail offers with the legs between the
 * chosen stops (`ResupplyPlanner`, over `resupply-planner.ts`), and owns the
 * edits: one place or none per group (`chooseResupplyOption`), zero days per
 * chosen stop (`setResupplyZeroDays`), and Clear choices (back to "no plan
 * made", which is what turns every planned highlight off). All of them go
 * through the plans store's one write path, `apply`, into the synced plan
 * document, so a linked browser shows the same towns and the same zero days.
 *
 * The hiker's inputs the legs are measured with — hours a day, pace, food per
 * day, long-carry days — are the per-device ones the Plan screen edits
 * (`plan-inputs-store`), shown in one line and editable from here in the same
 * sheet and cards.
 *
 * The section is the Plan screen's own local state (direction-dependent, never
 * persisted), so it arrives as `startKm` / `endKm` (and its two names) route
 * params, in route km. Without them, or with a range the route no longer
 * holds, the legs cover the whole trail. No camp plan is passed to the legs:
 * this screen shows no arrival days, and the zero days here would otherwise
 * be counted beside the plan's own rest days.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import type { SectionConfig } from '@lib/plan-types';
import { everyRouteResupplyOptionIds } from '@lib/plan-alternates';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { ResupplyPlanner } from '../../../src/features/plan/ResupplyPlanner';
import { WalkingInputsCard } from '../../../src/features/plan/PlanInputsCard';
import { PlanThresholdsCard } from '../../../src/features/plan/PlanThresholdsCard';
import { PlanSettingsSheet } from '../../../src/features/plan/PlanSettingsSheet';
import { computeResupplyPlan, PACE_KMH } from '../../../src/features/plan/plan-adapters';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { kmRangeFromParams } from '../../../src/features/plan/plan-section';
import { planDirectionOf } from '../../../src/features/plan/plan-stops';
import {
  chooseResupplyEditor,
  plannerRows,
  resupplyInputsLine,
  undecidedCount,
  zeroDaysStepEditor,
  type PlannerRange,
} from '../../../src/features/plan/resupply-planner';
import {
  resetResupplyStops,
  resupplyGroupsFor,
} from '../../../src/features/plan/use-planned-resupply';
import { selectPlan, usePlansStore } from '../../../src/state/plans-store';
import { plannableTrail, usePlanRoute } from '../../../src/features/plan/use-plan-route';
import { useSettingsStore } from '../../../src/state/settings-store';

/** How far past the route's end a passed section may reach and still be taken. */
const RANGE_SLACK_KM = 0.05;

function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() !== '' ? raw : undefined;
}

export default function ResupplyScreen() {
  const { trailId, direction } = useGuide();
  const plan = usePlansStore(selectPlan(trailId));
  // The route the plan walks, so a town on an alternate the plan takes is
  // offered, and the section's km (route km, from the Plan screen) line up.
  const { trail, baseTrail } = usePlanRoute(plan);
  const everyOptionId = useMemo(
    () => everyRouteResupplyOptionIds(plannableTrail(baseTrail)),
    [baseTrail],
  );
  const units = useSettingsStore((s) => s.units);
  const params = useLocalSearchParams<{
    startKm?: string;
    endKm?: string;
    startName?: string;
    endName?: string;
  }>();

  // The plan holds the selection, so it has to be in memory before the
  // choices are drawn — this screen is reachable by deep link, and an
  // unhydrated cache would show every group undecided for a frame.
  const hydratePlan = usePlansStore((s) => s.hydrate);
  const applyEdit = usePlansStore((s) => s.apply);
  useEffect(() => {
    void hydratePlan(trailId);
  }, [hydratePlan, trailId]);

  const prefs = usePlanInputsStore(selectPrefs(trailId));
  const setDailyHours = usePlanInputsStore((s) => s.setDailyHours);
  const setPace = usePlanInputsStore((s) => s.setPace);
  const setThreshold = usePlanInputsStore((s) => s.setThreshold);
  const [inputsOpen, setInputsOpen] = useState(false);

  // The document's selection; the device-local one only while it has none.
  const stored = plan?.resupplyStops ?? prefs.resupplyStops;
  const zeroDays = plan?.resupplyZeroDays;

  const totalKm = trail.track.totalDistance;
  const range = useMemo<PlannerRange>(() => {
    const passed = kmRangeFromParams(params.startKm, params.endKm);
    if (passed && passed.startKm >= 0 && passed.endKm <= totalKm + RANGE_SLACK_KM) {
      return {
        ...passed,
        startName: firstParam(params.startName) ?? 'Section start',
        endName: firstParam(params.endName) ?? 'Section end',
      };
    }
    return { startKm: 0, endKm: totalKm, startName: 'Trail start', endName: 'Trail end' };
  }, [params.startKm, params.endKm, params.startName, params.endName, totalKm]);
  const isWholeTrail = range.startKm === 0 && range.endKm === totalKm;

  // Keyed on the trail alone: grouping the CDT's options is not free, and a
  // choice must not regroup.
  const groups = useMemo(() => resupplyGroupsFor(trail), [trail]);
  const resupply = useMemo(() => {
    const section: SectionConfig | null = isWholeTrail ? null : range;
    return computeResupplyPlan(
      trail,
      section,
      {
        dailyHours: prefs.dailyHours,
        baseKmh: PACE_KMH[prefs.pace],
        longCarryDays: prefs.longCarryDays,
        foodGramsPerDay: prefs.foodGramsPerDay,
        resupplyStops: stored,
        zeroDays,
      },
      groups,
    );
  }, [
    trail,
    groups,
    range,
    isWholeTrail,
    prefs.dailyHours,
    prefs.pace,
    prefs.longCarryDays,
    prefs.foodGramsPerDay,
    stored,
    zeroDays,
  ]);
  const rows = useMemo(
    () => plannerRows(groups, stored, resupply.legs, range, zeroDays),
    [groups, stored, resupply.legs, range, zeroDays],
  );
  const undecided = useMemo(() => undecidedCount(groups, stored, range), [groups, stored, range]);

  const defaults = useMemo(
    () => ({ name: trail.config.name, direction: planDirectionOf(direction) }),
    [trail.config.name, direction],
  );

  // Each edit is worked out when it runs, from the document it is handed —
  // not from what this render saw — so quick taps build on each other.
  const onChoose = useCallback(
    (groupKey: string, optionId: string | null) => {
      const legacy = () => selectPrefs(trailId)(usePlanInputsStore.getState()).resupplyStops;
      void applyEdit(
        trailId,
        chooseResupplyEditor(groups, groupKey, optionId, everyOptionId, legacy),
        defaults,
      );
    },
    [applyEdit, defaults, everyOptionId, groups, trailId],
  );
  const onZeroDays = useCallback(
    (optionId: string, step: 1 | -1) => {
      void applyEdit(trailId, zeroDaysStepEditor(optionId, step), defaults);
    },
    [applyEdit, defaults, trailId],
  );

  const sectionLabel = isWholeTrail ? 'Whole trail' : `${range.startName} → ${range.endName}`;

  return (
    <>
      <ResupplyPlanner
        rows={rows}
        summary={resupply.summary}
        undecided={undecided}
        hasOptions={groups.length > 0}
        units={units}
        sectionLabel={sectionLabel}
        inputsLine={resupplyInputsLine(prefs, units)}
        onEditInputs={() => setInputsOpen(true)}
        planMade={stored !== undefined}
        onReset={() => resetResupplyStops(trailId, defaults)}
        onChoose={onChoose}
        onZeroDays={onZeroDays}
      />
      <PlanSettingsSheet
        visible={inputsOpen}
        onClose={() => setInputsOpen(false)}
        title="Resupply inputs"
      >
        <WalkingInputsCard
          dailyHours={prefs.dailyHours}
          pace={prefs.pace}
          onDailyHours={(h) => setDailyHours(trailId, h)}
          onPace={(p) => setPace(trailId, p)}
        />
        <PlanThresholdsCard
          dryStretchKm={prefs.dryStretchKm}
          foodGramsPerDay={prefs.foodGramsPerDay}
          longCarryDays={prefs.longCarryDays}
          units={units}
          only={['foodGramsPerDay', 'longCarryDays']}
          onChange={(key, value) => setThreshold(trailId, key, value)}
        />
      </PlanSettingsSheet>
    </>
  );
}

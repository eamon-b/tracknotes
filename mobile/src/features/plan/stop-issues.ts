/**
 * The Plan screen's view of the stops that need checking (`@lib/plan-stop-issues`).
 *
 * The classifying is shared with the web; this only turns issues into what the
 * screen shows: one row per stop — which day a placed one ends, or that an
 * unplaced one's nights are not in the dates — and the warning a day card
 * carries when its end stop is one of them. Pure, so it is tested without a
 * device.
 */

import { KM_EPSILON, toActiveKm, type PlanDirection } from '@lib/plan-direction';
import { stopIssueText, type StopIssue } from '@lib/plan-stop-issues';

/** One row of the Plan screen's "needs checking" card. */
export interface StopIssueRow {
  key: string;
  name: string;
  /** Why, in the shared wording. */
  reason: string;
  /** "Ends day 3", or "2 nights, not in the dates". */
  where: string;
  issue: StopIssue;
}

function activeKmOf(issue: StopIssue, direction: PlanDirection, routeTotalKm: number): number | null {
  return issue.routeKm === null ? null : toActiveKm(issue.routeKm, direction, routeTotalKm);
}

export function stopIssueRows(
  issues: readonly StopIssue[],
  days: readonly { dayNumber: number; endKm: number }[],
  direction: PlanDirection,
  routeTotalKm: number,
): StopIssueRow[] {
  return issues.map((issue, i) => {
    const activeKm = activeKmOf(issue, direction, routeTotalKm);
    let where: string;
    if (activeKm === null) {
      const nights = Math.max(1, Number(issue.stop.nights) || 1);
      where = `${nights} night${nights === 1 ? '' : 's'}, not in the dates`;
    } else {
      const day = days.find((d) => Math.abs(d.endKm - activeKm) < KM_EPSILON);
      // A placed stop outside the section shown ends no day card here.
      where = day ? `Ends day ${day.dayNumber}` : 'Outside the section shown';
    }
    return {
      key: `${i}:${issue.stop.waypointId ?? ''}:${issue.stop.alternate ?? ''}:${issue.stop.km}`,
      name: issue.stop.name,
      reason: stopIssueText(issue.reason),
      where,
      issue,
    };
  });
}

/**
 * The warning for a day card whose end (active route km) is a stop that needs
 * checking, or null. Placed issues only: an unplaced stop ends no day.
 */
export function dayEndWarning(
  issues: readonly StopIssue[],
  direction: PlanDirection,
  routeTotalKm: number,
): (endKm: number) => string | null {
  const placed = issues
    .map((issue) => ({ issue, km: activeKmOf(issue, direction, routeTotalKm) }))
    .filter((entry): entry is { issue: StopIssue; km: number } => entry.km !== null);
  return (endKm) => {
    const hit = placed.find((entry) => Math.abs(entry.km - endKm) < KM_EPSILON);
    return hit ? stopIssueText(hit.issue.reason) : null;
  };
}

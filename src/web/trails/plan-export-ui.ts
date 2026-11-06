/**
 * The plan page's Export menu: the plan as GPX, as a calendar (.ics), and a
 * printable summary (the browser's print dialog, which also saves a PDF).
 *
 * The files are written by `@lib/plan-export` from what the page has already
 * worked out — the same days, stops and resupply the page shows — so this
 * module only gathers that (through the host) and hands the text over. The
 * printed summary is a separate block (`#plan-print`) filled just before the
 * dialog opens, so the print stylesheet can show it alone rather than trying
 * to print a map and three scrolling panels.
 */

import { escapeHtml } from '@lib/escape';
import {
  canExportIcs,
  planExportFileName,
  planToGpx,
  planToIcs,
  startZeroDayDates,
  startZeroDaysText,
  type PlanExportInput,
} from '@lib/plan-export';
import { KM_EPSILON, stopsToActive } from '@lib/plan-direction';
import { legsArrivingAtStops } from '@lib/resupply-plan';

export interface PlanExportHost {
  /** What the page shows now: the plan in route km, its active trail, days and resupply. */
  input(): PlanExportInput;
  /** Context for the printed page's heading — the hiker's own inputs, as they are set. */
  printContext(): PlanPrintContext;
}

export interface PlanPrintContext {
  trailName: string;
  /** "Average (4 km/h)". */
  paceLabel: string;
  dailyHours: number;
}

export interface PlanExportController {
  /** Put the menu in step with the plan (the calendar needs a start date). */
  refresh(state: Pick<PlanExportInput, 'plan' | 'days'>): void;
}

export const ICS_NEEDS_START_DATE = 'Set a start date to export a calendar.';

const fmtKm = (km: number): string => `${km.toFixed(1)} km`;

function formatDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Hand `text` to the browser as a file download. */
export function downloadText(fileName: string, mimeType: string, text: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function planTitle(input: PlanExportInput): string {
  return input.plan.name.trim() || input.trail.config.name;
}

/**
 * The printed plan: a heading, the days (rest days as rows of their own), the
 * stops with their notes, and the resupply legs. Everything user-supplied is
 * escaped.
 */
export function planPrintHtml(input: PlanExportInput, ctx: PlanPrintContext): string {
  const { plan, days } = input;
  const stops = stopsToActive([...plan.stops], plan.direction, input.trail.track.totalDistance);
  const title = planTitle(input);

  const meta = [
    ctx.trailName,
    plan.direction,
    plan.startDate ? `starting ${formatDate(plan.startDate)}` : 'no start date',
    ...(startZeroDaysText(plan) ? [startZeroDaysText(plan) as string] : []),
    `timed at ${ctx.paceLabel}, ${ctx.dailyHours} h a day`,
  ];

  const dayRows: string[] = [];
  const firstStart = days[0]?.startName;
  for (const date of startZeroDayDates(plan)) {
    dayRows.push(`<tr class="is-rest">
      <td></td>
      <td>${escapeHtml(formatDate(date))}</td>
      <td colspan="5">Zero day before day 1${firstStart ? ` at ${escapeHtml(firstStart)}` : ''}</td>
    </tr>`);
  }
  for (const day of days) {
    const stop = stops.find(s => Math.abs(s.km - day.endKm) <= KM_EPSILON);
    const notes: string[] = [];
    if (stop?.booked) notes.push('Booked');
    if (stop?.note) notes.push(escapeHtml(stop.note));
    dayRows.push(`<tr>
      <td>${day.dayNumber}</td>
      <td>${day.date ? escapeHtml(formatDate(day.date)) : ''}</td>
      <td>${escapeHtml(day.startName)} → ${escapeHtml(day.endName)}</td>
      <td class="num">${day.distanceKm.toFixed(1)}</td>
      <td class="num">+${Math.round(day.ascentM)} / −${Math.round(day.descentM)}</td>
      <td class="num">${day.estimatedHours.toFixed(1)}</td>
      <td>${notes.join('<br>')}</td>
    </tr>`);
    const rest = Number(day.restDays ?? 0);
    for (let k = 1; k <= rest; k++) {
      dayRows.push(`<tr class="is-rest">
        <td></td>
        <td>${day.date ? escapeHtml(formatDate(addDays(day.date, k))) : ''}</td>
        <td colspan="5">Rest day at ${escapeHtml(day.endName)}</td>
      </tr>`);
    }
  }
  if (input.unplanned) {
    const u = input.unplanned;
    dayRows.push(`<tr class="is-unplanned">
      <td></td><td></td>
      <td>Not planned yet: ${escapeHtml(u.startName)} → ${escapeHtml(u.endName)}</td>
      <td class="num">${u.distanceKm.toFixed(1)}</td>
      <td class="num">+${Math.round(u.ascentM)} / −${Math.round(u.descentM)}</td>
      <td class="num">${u.estimatedHours.toFixed(1)}</td>
      <td></td>
    </tr>`);
  }

  const totalKm = days.reduce((sum, day) => sum + day.distanceKm, 0);
  const restTotal = days.reduce((sum, day) => sum + Number(day.restDays ?? 0), 0);

  const legs = legsArrivingAtStops(input.resupplyLegs ?? []);
  const resupply =
    legs.length === 0
      ? ''
      : `<h2>Resupply</h2>
    <table>
      <thead><tr><th>Stop</th><th class="num">Route km</th><th class="num">Walked from last stop</th><th class="num">Days</th><th class="num">Food</th><th class="num">Zero days</th></tr></thead>
      <tbody>${legs
        .map(
          leg => `<tr>
        <td>${escapeHtml(leg.toName)}</td>
        <td class="num">${leg.toKm.toFixed(1)}</td>
        <td class="num">${fmtKm(leg.walkedKm)}</td>
        <td class="num">${leg.estimatedDays}</td>
        <td class="num">${leg.food.weightKg.toFixed(1)} kg</td>
        <td class="num">${leg.zeroDays > 0 ? leg.zeroDays : ''}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>`;

  return `<h1>${escapeHtml(title)}</h1>
    <p class="plan-print-meta">${meta.map(escapeHtml).join(' · ')}</p>
    <p class="plan-print-meta">${days.length} walking day${days.length === 1 ? '' : 's'}, ${fmtKm(totalKm)}${
      restTotal > 0 ? `, ${restTotal} rest day${restTotal === 1 ? '' : 's'}` : ''
    }</p>
    <h2>Days</h2>
    <table>
      <thead><tr><th>Day</th><th>Date</th><th>Route</th><th class="num">km</th><th class="num">Climb (m)</th><th class="num">Hours</th><th>Notes</th></tr></thead>
      <tbody>${dayRows.join('')}</tbody>
    </table>
    ${resupply}
    <p class="plan-print-footer">Printed from Tracknotes (tracknotes.info). Estimates are Naismith's rule at the pace and hours above.</p>`;
}

/**
 * Bind the Export menu (`#plan-export`) on the plan page. Without the markup
 * (an older generated page) it does nothing.
 */
export function initPlanExport(host: PlanExportHost): PlanExportController {
  const gpxBtn = document.getElementById('export-gpx') as HTMLButtonElement | null;
  const icsBtn = document.getElementById('export-ics') as HTMLButtonElement | null;
  const icsNote = document.getElementById('export-ics-note');
  const printBtn = document.getElementById('export-print') as HTMLButtonElement | null;
  const printBlock = document.getElementById('plan-print');
  const menu = document.getElementById('plan-export') as HTMLDetailsElement | null;

  const close = () => {
    if (menu) menu.open = false;
  };

  gpxBtn?.addEventListener('click', () => {
    const input = host.input();
    downloadText(planExportFileName(planTitle(input), 'gpx'), 'application/gpx+xml;charset=utf-8', planToGpx(input));
    close();
  });

  icsBtn?.addEventListener('click', () => {
    const input = host.input();
    const ics = planToIcs({ ...input, dtstamp: new Date() });
    if (ics === null) return;
    downloadText(planExportFileName(planTitle(input), 'ics'), 'text/calendar;charset=utf-8', ics);
    close();
  });

  const fillPrint = () => {
    if (printBlock) printBlock.innerHTML = planPrintHtml(host.input(), host.printContext());
  };
  printBtn?.addEventListener('click', () => {
    close();
    fillPrint();
    window.print();
  });
  // Ctrl+P / the browser menu print the same summary, not an empty page.
  window.addEventListener('beforeprint', fillPrint);

  const refresh = (state: Pick<PlanExportInput, 'plan' | 'days'>) => {
    if (!icsBtn) return;
    const ok = canExportIcs(state);
    icsBtn.disabled = !ok;
    icsBtn.title = ok ? 'Download the days as calendar events' : ICS_NEEDS_START_DATE;
    if (icsNote) icsNote.hidden = ok;
  };

  return { refresh };
}

/**
 * The Plan screen's exports: the plan as GPX or as a calendar (.ics), written
 * by `@lib/plan-export` from what the screen shows, saved to a file in the
 * app's cache and handed to the OS share sheet — the same route Settings'
 * comment export takes (`comment-export-file.ts`), and for the same reason: a
 * long trail's GPX is far over what an Android share intent can carry as text.
 *
 * There is no PDF here: `expo-print` is not a dependency, and the web planner's
 * print view covers that.
 */

import * as Sharing from 'expo-sharing';
import {
  canExportIcs,
  planExportFileName,
  planToGpx,
  planToIcs,
  type PlanExportInput,
} from '@lib/plan-export';
import { writePlanExportFile } from './plan-export-file';

export type PlanExportKind = 'gpx' | 'ics';

const SHARE_TYPES: Record<PlanExportKind, { mimeType: string; UTI: string; title: string }> = {
  gpx: { mimeType: 'application/gpx+xml', UTI: 'com.topografix.gpx', title: 'Share plan as GPX' },
  ics: { mimeType: 'text/calendar', UTI: 'public.calendar-event', title: 'Share plan as calendar' },
};

/** The file name and text of one export; null when it cannot be written (a calendar without a start date). */
export function buildPlanExport(
  kind: PlanExportKind,
  input: PlanExportInput,
  now: Date,
): { fileName: string; contents: string } | null {
  const name = input.plan.name.trim() || input.trail.config.name;
  if (kind === 'gpx')
    return { fileName: planExportFileName(name, 'gpx'), contents: planToGpx(input) };
  if (!canExportIcs(input)) return null;
  const contents = planToIcs({ ...input, dtstamp: now });
  return contents === null ? null : { fileName: planExportFileName(name, 'ics'), contents };
}

/** Build, write and share one export. Throws when sharing is unavailable. */
export async function sharePlanExport(kind: PlanExportKind, input: PlanExportInput): Promise<void> {
  const built = buildPlanExport(kind, input, new Date());
  if (!built) throw new Error('Set a start date to export a calendar.');
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  const uri = writePlanExportFile(built.fileName, built.contents);
  const type = SHARE_TYPES[kind];
  await Sharing.shareAsync(uri, {
    mimeType: type.mimeType,
    UTI: type.UTI,
    dialogTitle: type.title,
  });
}

/**
 * The file half of the Plan screen's export: the GPX or calendar is written to
 * its own cache folder, emptied before each export, and that file's URI goes to
 * the share sheet (`plan-export-share.ts`).
 *
 * Kept apart from the share code so account deletion can clear the folder
 * without pulling in `expo-sharing` or the export writers: the file is a copy of
 * a plan, and synced plans go with the account (`account-deletion.ts`).
 */

import { Directory, File, Paths } from 'expo-file-system';

/** Cache folder holding the latest plan export (and nothing else). */
function exportDir(): Directory {
  return new Directory(Paths.cache, 'plan-export');
}

/** Write `contents` as the export file, replacing any earlier one; returns its URI. */
export function writePlanExportFile(fileName: string, contents: string): string {
  const dir = exportDir();
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, fileName);
  // writeSync: the share sheet must not open on a file still being written.
  file.writeSync(contents);
  return file.uri;
}

/** Remove the last plan export, if one is still in the cache. */
export function deletePlanExportFile(): void {
  const dir = exportDir();
  if (dir.exists) dir.delete();
}

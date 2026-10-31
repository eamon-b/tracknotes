/**
 * The file half of Settings' comment export: the JSON is written to a file in
 * the app's cache and the share sheet is handed that file, not the text.
 *
 * Android carries a shared string inside the share intent, and an intent over
 * about 1 MB fails (`TransactionTooLargeException`), so an account with a few
 * thousand comments could not export them as a message. A file's size does not
 * matter to the intent: only its URI travels.
 *
 * The file lives in its own cache folder, emptied before each export, so old
 * copies do not pile up; the OS may clear it at any time, which is fine once
 * the sheet has handed it on.
 */

import { Directory, File, Paths } from 'expo-file-system';

/** Cache folder holding the latest export (and nothing else). */
function exportDir(): Directory {
  return new Directory(Paths.cache, 'comment-export');
}

/** `tracknotes-comments-YYYY-MM-DD.json` for an ISO `exportedAt`. */
export function commentExportFileName(exportedAt: string): string {
  return `tracknotes-comments-${exportedAt.slice(0, 10)}.json`;
}

/** Write `contents` as the export file, replacing any earlier one; returns its URI. */
export function writeCommentExportFile(contents: string, exportedAt: string): string {
  const dir = exportDir();
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, commentExportFileName(exportedAt));
  file.create();
  file.write(contents);
  return file.uri;
}

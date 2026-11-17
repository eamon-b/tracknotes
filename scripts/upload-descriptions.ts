/**
 * Push curated waypoint descriptions to the comments API.
 *
 * The authored source of truth is `data/trails/<trail>/descriptions.json` — the
 * same file the trail build bundles into the app. This script pushes it to the
 * `waypoint_descriptions` table in D1 so installed apps pick the text up over
 * the sync channel (`GET /v1/trails/:trailId/descriptions?since=`) without
 * waiting for a new build. Bundled and synced text share the waypoint-id key
 * space, and the app renders `synced ?? bundled`.
 *
 * Usage:
 *   # See exactly what would be sent (no token needed; reads the live set when
 *   # an API base is given, otherwise makes no network request at all):
 *   npm run upload:descriptions -- --dry-run --api https://<comments-api-host>
 *
 *   # Push one trail:
 *   TRACKNOTES_ADMIN_TOKEN=... npm run upload:descriptions -- \
 *     --trail cape_to_cape --api https://<comments-api-host>
 *
 * Options:
 *   --trail <id>    Only this trail (default: every trail with a descriptions.json)
 *   --api <url>     API base URL (default: $TRACKNOTES_API_BASE_URL)
 *   --dry-run       Print the requests instead of sending them
 *   --no-withdraw   Do not withdraw live descriptions the file no longer lists
 *
 * Auth: an admin bearer token, read from $TRACKNOTES_ADMIN_TOKEN. Pass it on
 * the command line for a single run; this script never reads dotfiles or any
 * other credential store.
 *
 * Each run first reads the live set (`GET /v1/trails/:id/descriptions`, public)
 * and sends only the difference (`planDescriptionSync`):
 *   - a PUT for each entry the API lacks or holds different text for — text
 *     the API already has is not re-sent, and the API leaves `updated_at`
 *     alone for an unchanged PUT anyway, so phones are not made to re-download
 *     every description on every run;
 *   - a withdrawal (PUT of an empty string, which the API stores as a
 *     tombstone the phones sync) for each id the API serves text for that
 *     descriptions.json no longer lists. Deleting an entry from the file is how
 *     a description is withdrawn; `--no-withdraw` skips this step.
 * A dry run with an API base reads the live set too (no token needed) and
 * prints exactly that difference; without one it prints a PUT per entry and
 * cannot know about withdrawals.
 *
 * Live edits: the live description editor (`src/web/admin-descriptions.html`)
 * writes the same table, and each row says which tool last changed its text
 * (`source`: `live` for that page, `upload` for this script, which sends
 * `source: 'upload'` with every PUT). A PUT or withdrawal that replaces text
 * an earlier upload sent is the ordinary case and is listed plainly, with the
 * text it replaces. One that replaces a live edit, or undoes a live clear, the
 * file does not match is marked `!` and the run ends with a warning (a
 * `::warning::` annotation under GitHub Actions, so the *Upload descriptions*
 * plan shows it before anyone approves). It only warns: the file stays the
 * source of truth, and a live edit is meant to be committed to it
 * (`docs/waypoint-editor.md`).
 *   - A live edit the file already matches (it was committed) is re-sent,
 *     text unchanged, to mark it uploaded: the API changes only the marker,
 *     not `updated_at`, so no phone re-downloads it, and the next change to
 *     that entry is an ordinary edit.
 *   - Against a worker that predates the marker the rows carry no `source`:
 *     nothing can be called a live edit, and the run says so instead.
 * Only trails that still have a descriptions.json are visited, so withdrawing
 * a trail's last description means leaving its file with an empty
 * "descriptions" array, and a live edit on a trail with no file is never
 * touched by an upload.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DESCRIPTIONS_FILENAME,
  liveEditsOverwritten,
  loadCuratedDescriptions,
  planDescriptionSync,
  type CuratedDescription,
  type DescriptionOverwrite,
  type DescriptionSyncPlan,
  type LiveDescription,
} from './lib/waypoint-descriptions.js';
import type { TrailDescriptionsResponse, UpsertDescriptionRequest } from '../src/lib/comments-api-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRAILS_DIR = path.join(__dirname, '..', 'data', 'trails');

const ADMIN_TOKEN_ENV = 'TRACKNOTES_ADMIN_TOKEN';
const API_BASE_ENV = 'TRACKNOTES_API_BASE_URL';

interface Options {
  trailId?: string;
  apiBase?: string;
  dryRun: boolean;
  withdraw: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, withdraw: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-withdraw') {
      options.withdraw = false;
    } else if (arg === '--trail') {
      options.trailId = argv[++i];
    } else if (arg === '--api') {
      options.apiBase = argv[++i];
    } else {
      throw new Error(`Unknown argument "${arg}". See the header of ${path.basename(__filename)}.`);
    }
  }
  if (options.trailId === undefined && argv.includes('--trail')) {
    throw new Error('--trail needs a trail id');
  }
  if (options.apiBase === undefined && argv.includes('--api')) {
    throw new Error('--api needs a base URL');
  }
  return options;
}

/**
 * A trail's directory name is not its id: `AAWT` builds `aawt` and
 * `Hume_and_Hovell` builds `hume-and-hovell`. The API path, the registry and
 * the `trailId` inside descriptions.json all use the id, so carry both.
 */
interface AuthoredTrail {
  /** Directory under data/trails/ holding the descriptions file. */
  dir: string;
  /** The trail's build id, from its trail.json. */
  trailId: string;
}

/** Every trail directory that has authored descriptions, in stable order. */
function findTrailsWithDescriptions(only?: string): AuthoredTrail[] {
  const entries = fs
    .readdirSync(TRAILS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(TRAILS_DIR, name, DESCRIPTIONS_FILENAME)))
    .map(dir => {
      const configPath = path.join(TRAILS_DIR, dir, 'trail.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { id?: string };
      if (typeof config.id !== 'string' || config.id.length === 0) {
        throw new Error(`${configPath}: missing "id"`);
      }
      return { dir, trailId: config.id };
    })
    .sort((a, b) => a.trailId.localeCompare(b.trailId));

  if (!only) return entries;
  // Accept either the id (what the API wants) or the directory name (what a
  // shell tab-completes), since the two differ for some trails.
  const match = entries.find(entry => entry.trailId === only || entry.dir === only);
  if (!match) {
    throw new Error(
      `Trail "${only}" has no ${DESCRIPTIONS_FILENAME}. Trails with curated descriptions: ${entries.map(entry => entry.trailId).join(', ') || '(none)'}`
    );
  }
  return [match];
}

/** The descriptions the API serves for a trail now, withdrawn ones included. */
async function fetchLiveDescriptions(apiBase: string, trailId: string): Promise<LiveDescription[]> {
  const url = `${apiBase.replace(/\/+$/, '')}/v1/trails/${encodeURIComponent(trailId)}/descriptions`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as TrailDescriptionsResponse;
  if (!Array.isArray(body.descriptions)) {
    throw new Error(`GET ${url}: response has no "descriptions" array`);
  }
  return body.descriptions;
}

async function putDescription(
  apiBase: string,
  token: string,
  trailId: string,
  entry: CuratedDescription
): Promise<void> {
  const url = `${apiBase.replace(/\/+$/, '')}/v1/admin/trails/${encodeURIComponent(trailId)}/descriptions/${encodeURIComponent(entry.waypointId)}`;
  const body = uploadBody(entry.description);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `PUT ${entry.waypointId} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const trails = findTrailsWithDescriptions(options.trailId);

  if (trails.length === 0) {
    console.log(`No trail has a ${DESCRIPTIONS_FILENAME} yet — nothing to upload.`);
    return;
  }

  const apiBase = options.apiBase ?? process.env[API_BASE_ENV];
  const token = process.env[ADMIN_TOKEN_ENV];

  if (!options.dryRun) {
    if (!apiBase) throw new Error(`No API base URL. Pass --api <url> or set $${API_BASE_ENV}.`);
    if (!token) {
      throw new Error(
        `No admin token. Set $${ADMIN_TOKEN_ENV} for this command (e.g. ${ADMIN_TOKEN_ENV}=... npm run upload:descriptions -- ...), or re-run with --dry-run.`
      );
    }
  }

  /** Per trail: live edits and clears the upload undoes (the warning). */
  const liveEditWarnings: string[] = [];
  /** Per trail: replaced text whose origin the API did not report. */
  const unknownOrigin: string[] = [];
  let puts = 0;
  let withdrawn = 0;
  let adopted = 0;
  let unchanged = 0;
  for (const { dir, trailId } of trails) {
    const entries = loadCuratedDescriptions(path.join(TRAILS_DIR, dir), trailId);
    // Without a live read (a dry run with no API base) every entry is a PUT
    // and nothing is known to withdraw.
    const live = apiBase ? await fetchLiveDescriptions(apiBase, trailId) : null;
    const plan: DescriptionSyncPlan = live
      ? planDescriptionSync(entries, live)
      : { puts: entries, withdrawals: [], unchanged: 0, overwrites: [], adoptions: [] };
    const withdrawals = options.withdraw ? plan.withdrawals : [];
    const sent = new Set([...plan.puts.map(entry => entry.waypointId), ...withdrawals]);
    // What this run really replaces: a withdrawal `--no-withdraw` skips replaces nothing.
    const replaced = new Map(plan.overwrites.filter(row => sent.has(row.waypointId)).map(row => [row.waypointId, row]));
    console.log(
      `\n${trailId}: ${entries.length} description(s) — ${plan.puts.length} to send, ` +
        `${plan.unchanged} unchanged, ${withdrawals.length} to withdraw` +
        (!options.withdraw && plan.withdrawals.length > 0
          ? ` (${plan.withdrawals.length} skipped: --no-withdraw)`
          : '') +
        (plan.adoptions.length > 0 ? `, ${plan.adoptions.length} committed live edit(s) to mark as uploaded` : '') +
        (live ? '' : ' (no API base: live set not read)')
    );

    const requests: Array<{ entry: CuratedDescription; label: string }> = [
      ...plan.puts.map(entry => ({
        entry,
        label: `  ${entry.waypointId}${entry.name ? ` (${entry.name})` : ''}${replacedNote(replaced.get(entry.waypointId))}`,
      })),
      ...withdrawals.map(waypointId => ({
        entry: { waypointId, description: '' },
        label: `  ${waypointId} (withdraw)${replacedNote(replaced.get(waypointId))}`,
      })),
      ...plan.adoptions.map(entry => ({
        entry,
        label:
          `  ${entry.waypointId}${entry.name ? ` (${entry.name})` : ''} (mark as uploaded: ` +
          `${entry.description === '' ? 'a live clear the file agrees with' : 'a live edit that is now in the file'}; text unchanged)`,
      })),
    ];
    const liveEdits = liveEditsOverwritten({ overwrites: [...replaced.values()] }).length;
    if (liveEdits > 0) liveEditWarnings.push(`${trailId}: ${liveEdits}`);
    const unknown = [...replaced.values()].filter(row => row.origin === 'unknown').length;
    if (unknown > 0) unknownOrigin.push(`${trailId}: ${unknown}`);
    for (const { entry, label } of requests) {
      if (options.dryRun) {
        const target = apiBase ?? `<${API_BASE_ENV}>`;
        console.log(`${label}\n    PUT ${target}/v1/admin/trails/${trailId}/descriptions/${entry.waypointId}`);
        console.log(`    ${JSON.stringify(uploadBody(entry.description))}`);
      } else {
        await putDescription(apiBase!, token!, trailId, entry);
        console.log(`${label} ✓`);
      }
    }
    puts += plan.puts.length;
    withdrawn += withdrawals.length;
    adopted += plan.adoptions.length;
    unchanged += plan.unchanged;
  }

  // The *Upload descriptions* workflow greps this line for "nothing to do"
  // (`would have 0 description(s) sent, 0 withdrawn, 0 committed live edit(s)
  // marked`): keep the two in step.
  const summary =
    `${puts} description(s) sent, ${withdrawn} withdrawn, ${adopted} committed live edit(s) marked as uploaded, ` +
    `${unchanged} already up to date, across ${trails.length} trail(s).`;
  console.log(options.dryRun ? `\nDry run: would have ${summary}` : `\nDone: ${summary}`);
  if (liveEditWarnings.length > 0) {
    const warning =
      `${options.dryRun ? 'Would undo' : 'Undid'} live edits or clears that descriptions.json does not match ` +
      `(${liveEditWarnings.join(', ')}; the lines marked "!"). Each was made on admin-descriptions.html and ` +
      `is not in the file as written: commit a live edit to descriptions.json (the page's export) or it is lost, ` +
      `and delete an entry from the file to keep its clear.`;
    console.log(`\nWarning: ${warning}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Live description edits undone::${warning}`);
  }
  if (unknownOrigin.length > 0) {
    const warning =
      `This API does not say where its synced text came from (its worker predates the marker), so the replaced ` +
      `text (${unknownOrigin.join(', ')}) could not be checked for live edits made on admin-descriptions.html.`;
    console.log(`\nWarning: ${warning}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Live edits not checked::${warning}`);
  }
}

/** The body of every PUT this script sends: the text, written by the upload. */
function uploadBody(description: string): UpsertDescriptionRequest {
  return { description, source: 'upload' };
}

/**
 * What a request replaces, for its line. Text an upload sent is listed
 * plainly; a live edit or a live clear is marked `!`.
 */
function replacedNote(row: DescriptionOverwrite | undefined): string {
  if (!row) return '';
  if (row.live === '')
    return '\n    ! undoes a live clear (cleared on admin-descriptions.html; the file still lists it)';
  const oneLine = row.live.replace(/\s+/g, ' ');
  const shown = JSON.stringify(oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine);
  switch (row.origin) {
    case 'live':
      return `\n    ! replaces a live edit: ${shown}`;
    case 'upload':
      return `\n    replaces uploaded text: ${shown}`;
    default:
      return `\n    replaces synced text of unknown origin: ${shown}`;
  }
}

main().catch(error => {
  console.error(`\nupload-descriptions failed: ${(error as Error).message}`);
  process.exitCode = 1;
});

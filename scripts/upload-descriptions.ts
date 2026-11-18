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
 *   # an API base is given, otherwise makes no network request at all), and
 *   # write down the live edits the plan showed:
 *   npm run upload:descriptions -- --dry-run --api https://<comments-api-host> \
 *     --record-live /tmp/live-shown.json
 *
 *   # Push one trail, undoing only the live edits that plan showed:
 *   TRACKNOTES_ADMIN_TOKEN=... npm run upload:descriptions -- \
 *     --trail cape_to_cape --api https://<comments-api-host> \
 *     --acknowledged-live /tmp/live-shown.json
 *
 * Options:
 *   --trail <id>                Only this trail (default: every trail with a descriptions.json)
 *   --api <url>                 API base URL (default: $TRACKNOTES_API_BASE_URL)
 *   --dry-run                   Print the requests instead of sending them
 *   --no-withdraw               Do not withdraw live descriptions the file no longer lists
 *   --record-live <file>        With --dry-run: write the live edits and clears the plan
 *                               showed (the lines marked `!`) to <file>
 *   --acknowledged-live <file>  The file a dry run wrote: the live edits and clears this
 *                               run may undo. Without it a real run undoes none.
 *
 * Exit codes: 0 when everything planned was sent (a warning never changes
 * that); 1 when the run failed and stopped (bad arguments, a malformed file,
 * the API unreachable or answering an error); 2 when it finished but was
 * refused some rows, which were not written (see "Refusals").
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
 * plan shows it before anyone approves). The file stays the source of truth,
 * and a live edit is meant to be committed to it (`docs/waypoint-editor.md`).
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
 *
 * Refusals: a real run never replaces what the reader of its plan was not
 * shown (`scripts/lib/description-upload.ts`).
 *   - It undoes a live edit or clear only when the file given with
 *     `--acknowledged-live` names it, by waypoint id and the row's
 *     `updatedAt`: that is the file a dry run writes with `--record-live`, so
 *     it lists exactly the `!` lines of the plan someone read. A live edit
 *     made or changed after that plan, or any at all in a run given no file,
 *     is not sent: its line is marked `✗` and the row is left as it is.
 *   - Every PUT carries the `updatedAt` this run read for the row
 *     (`ifUpdatedAt`, `null` for "no row"), so the API refuses (409
 *     `description_conflict`) a write over a row that changed between the
 *     read and the PUT. It is not retried: the line is marked `✗` with what
 *     the row now holds.
 * The other rows are still sent, and the run exits 2 with an `::error::`
 * annotation under GitHub Actions. To go on: commit the live edit to the file,
 * or plan again (re-run the whole workflow, or `--dry-run --record-live`) and
 * pass the new plan's file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  EXIT_REFUSED,
  parseAcknowledgedLive,
  runDescriptionUpload,
  serializeAcknowledgedLive,
  type AcknowledgedLive,
} from './lib/description-upload.js';
import { DESCRIPTIONS_FILENAME, loadCuratedDescriptions } from './lib/waypoint-descriptions.js';

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
  /** `--record-live`: where a dry run writes the live edits its plan showed. */
  recordLive?: string;
  /** `--acknowledged-live`: the file a dry run wrote, read back by a real run. */
  acknowledgedLive?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, withdraw: true };
  const value = (flag: string, what: string, index: number): string => {
    const next = argv[index];
    if (next === undefined) throw new Error(`${flag} needs ${what}`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-withdraw') {
      options.withdraw = false;
    } else if (arg === '--trail') {
      options.trailId = value(arg, 'a trail id', ++i);
    } else if (arg === '--api') {
      options.apiBase = value(arg, 'a base URL', ++i);
    } else if (arg === '--record-live') {
      options.recordLive = value(arg, 'a file to write', ++i);
    } else if (arg === '--acknowledged-live') {
      options.acknowledgedLive = value(arg, 'the file a dry run wrote with --record-live', ++i);
    } else {
      throw new Error(`Unknown argument "${arg}". See the header of ${path.basename(__filename)}.`);
    }
  }
  if (options.recordLive !== undefined && !options.dryRun) {
    throw new Error('--record-live goes with --dry-run: it writes what the plan showed, for a real run to be given.');
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const trails = findTrailsWithDescriptions(options.trailId);

  if (trails.length === 0) {
    console.log(`No trail has a ${DESCRIPTIONS_FILENAME} yet — nothing to upload.`);
    if (options.recordLive !== undefined) {
      fs.writeFileSync(options.recordLive, `${serializeAcknowledgedLive(new Map())}\n`);
    }
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

  // Everything is read and checked before the first request, so a malformed
  // file or acknowledged set stops the run with nothing sent.
  const acknowledged: AcknowledgedLive | null =
    options.acknowledgedLive === undefined
      ? null
      : parseAcknowledgedLive(fs.readFileSync(options.acknowledgedLive, 'utf-8'), options.acknowledgedLive);
  const authored = trails.map(({ dir, trailId }) => ({
    trailId,
    entries: loadCuratedDescriptions(path.join(TRAILS_DIR, dir), trailId),
  }));

  const result = await runDescriptionUpload({
    trails: authored,
    apiBase,
    token,
    dryRun: options.dryRun,
    withdraw: options.withdraw,
    acknowledged,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    fetch,
    log: text => console.log(text),
  });

  if (options.recordLive !== undefined) {
    fs.writeFileSync(options.recordLive, `${serializeAcknowledgedLive(result.liveShown)}\n`);
  }
  if (result.exitCode === EXIT_REFUSED) {
    console.error(
      `\nupload-descriptions: some descriptions were not sent (the "Error:" lines above). Exit ${EXIT_REFUSED}.`
    );
  }
  process.exitCode = result.exitCode;
}

main().catch(error => {
  console.error(`\nupload-descriptions failed: ${(error as Error).message}`);
  process.exitCode = 1;
});

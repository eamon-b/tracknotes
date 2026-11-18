import type { UpsertDescriptionRequest } from '../../src/lib/comments-api-types.js';
import { guardsDescriptionWrites } from '../../src/lib/description-write-features.js';
import {
  planDescriptionSync,
  WAYPOINT_ID_PATTERN,
  type CuratedDescription,
  type DescriptionOverwrite,
  type DescriptionSyncPlan,
  type LiveDescription,
} from './waypoint-descriptions.js';

/**
 * The run behind `scripts/upload-descriptions.ts`: read the live set, plan the
 * difference (`planDescriptionSync`, one function for the dry run and the real
 * one), print it, and in a real run send it. The network and the output are
 * passed in, so the whole run is tested against an in-memory API.
 *
 * Two rules keep a real run from replacing something nobody looked at. The
 * file is the source of truth, but only over what the plan's reader saw:
 *
 *  - **Every PUT is conditional.** It carries the `updatedAt` the run read for
 *    the row (`ifUpdatedAt`; `null` for "no row"), so the API refuses (409
 *    `description_conflict`) a write over a row that changed after the read.
 *    A refused row is reported with what it now holds, never retried.
 *  - **A live edit is undone only when it was shown.** A PUT or withdrawal
 *    that replaces a live edit, or undoes a live clear, is sent only when the
 *    run was given that edit in its acknowledged set (`--acknowledged-live`):
 *    the waypoint id and the `updatedAt` of the live row, exactly what a dry
 *    run showed with `!` and wrote out (`--record-live`). A live edit made or
 *    changed after that plan is not in the set, so it is left alone.
 *
 * Either refusal leaves the other rows to go ahead and ends the run with
 * `EXIT_REFUSED`, so it is red and gets looked at. A warning (a live edit that
 * was shown and has now been undone) still never fails a run.
 *
 * Both rules lean on the worker: it must say which rows are live edits
 * (`source`) and refuse a stale write (`ifUpdatedAt`). A worker that predates
 * them ignores both without an error, so the run asks first: the descriptions
 * read says whether the worker honours them (`writeFeatures`,
 * `src/lib/description-write-features.ts`). Against one that does not, a dry
 * run still prints its plan, with a warning, and a real run sends nothing at
 * all unless it is told to (`allowUnguarded`, `--allow-unchecked-live`): it
 * could not tell a live edit from uploaded text, nor keep from replacing a row
 * edited after it was read.
 */

/** Exit code of a real run that sent what it could and was refused the rest. */
export const EXIT_REFUSED = 2;

/** A live row as a run reads it: its version is always known. */
export type LiveRow = LiveDescription & { updatedAt: string };

/**
 * The live edits and clears a plan showed: trail id → waypoint id → the
 * `updatedAt` of the live row. The dry run writes it (`--record-live`) and a
 * real run reads it back (`--acknowledged-live`).
 */
export type AcknowledgedLive = Map<string, Map<string, string>>;

const TRAIL_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
/** An ISO timestamp as the API stamps a row, loosely: what matters is that it is compared verbatim. */
const STAMP_PATTERN = /^[0-9T:.Z-]{10,40}$/;

function isStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The acknowledged set as one line of JSON:
 * `{"version":1,"live":{"<trailId>":{"<waypointId>":"<updatedAt>"}}}`.
 *
 * One line, and nothing in it but ids and timestamps that passed their
 * patterns, because the *Upload descriptions* workflow carries it from its
 * `plan` job to its `upload` job as a job output: no text from the API can
 * reach `$GITHUB_OUTPUT` or a shell through it.
 */
export function serializeAcknowledgedLive(shown: AcknowledgedLive): string {
  const trails = [...shown.entries()]
    .filter(([, rows]) => rows.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trailId, rows]) => {
      if (!TRAIL_ID_PATTERN.test(trailId))
        throw new Error(`Cannot record live edits for trail id ${JSON.stringify(trailId)}`);
      const entries = [...rows.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([waypointId, updatedAt]) => {
          if (!WAYPOINT_ID_PATTERN.test(waypointId) || !isStamp(updatedAt)) {
            throw new Error(`Cannot record the live edit on ${JSON.stringify(waypointId)} (${trailId})`);
          }
          return `${JSON.stringify(waypointId)}:${JSON.stringify(updatedAt)}`;
        });
      return `${JSON.stringify(trailId)}:{${entries.join(',')}}`;
    });
  return `{"version":1,"live":{${trails.join(',')}}}`;
}

/** Read an acknowledged set back, strictly: anything unexpected throws, and the run sends nothing. */
export function parseAcknowledgedLive(text: string, source: string): AcknowledgedLive {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}. It must be the file a dry run wrote with --record-live.`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.live)) {
    return fail('expected {"version":1,"live":{…}}');
  }
  const acknowledged: AcknowledgedLive = new Map();
  for (const [trailId, rows] of Object.entries(raw.live)) {
    if (!TRAIL_ID_PATTERN.test(trailId) || !isObject(rows)) return fail('"live" has an invalid trail entry');
    const byWaypoint = new Map<string, string>();
    for (const [waypointId, updatedAt] of Object.entries(rows)) {
      if (!WAYPOINT_ID_PATTERN.test(waypointId) || !isStamp(updatedAt)) {
        return fail(`"live" has an invalid entry for trail "${trailId}"`);
      }
      byWaypoint.set(waypointId, updatedAt);
    }
    acknowledged.set(trailId, byWaypoint);
  }
  return acknowledged;
}

/** One PUT of a run. */
export interface UploadRequest {
  /** `put`: an entry the API lacks or differs on; `withdraw`: PUT ''; `adopt`: mark a committed live edit uploaded. */
  kind: 'put' | 'withdraw' | 'adopt';
  waypointId: string;
  name?: string;
  /** The text to send (`''` for a withdrawal, or an adopted live clear). */
  description: string;
  /**
   * The precondition: the `updatedAt` the run read for the row, or `null` when
   * it read no row. `undefined` only when the live set was not read at all (a
   * dry run with no API base), which a real run never is.
   */
  ifUpdatedAt: string | null | undefined;
  /** The synced row this request changes, when it replaces text or undoes a live clear. */
  replaces?: DescriptionOverwrite;
  /**
   * It undoes a live edit or clear that is not in the acknowledged set: a real
   * run does not send it.
   */
  unacknowledged: boolean;
}

/** A trail's plan, and the requests it comes to. */
export interface TrailUpload {
  plan: DescriptionSyncPlan;
  /** In sending order: PUTs in authored order, withdrawals and adoptions by id. */
  requests: UploadRequest[];
  /** Withdrawals `--no-withdraw` left out. */
  skippedWithdrawals: number;
}

/**
 * A trail's requests, each with its precondition and whether it undoes a live
 * edit nobody acknowledged. `live` is `null` when the live set was not read:
 * every entry is then a PUT and nothing is known to withdraw.
 */
export function planTrailUpload(
  authored: readonly CuratedDescription[],
  live: readonly LiveRow[] | null,
  options: { withdraw: boolean; acknowledged?: ReadonlyMap<string, string> }
): TrailUpload {
  const plan: DescriptionSyncPlan = live
    ? planDescriptionSync(authored, live)
    : { puts: [...authored], withdrawals: [], unchanged: 0, overwrites: [], adoptions: [] };
  const stamps = live && new Map(live.map(row => [row.waypointId, row.updatedAt]));
  const replaced = new Map(plan.overwrites.map(row => [row.waypointId, row]));
  const request = (
    kind: UploadRequest['kind'],
    entry: { waypointId: string; name?: string; description: string }
  ): UploadRequest => {
    // An adoption changes no text, so it replaces nothing.
    const replaces = kind === 'adopt' ? undefined : replaced.get(entry.waypointId);
    return {
      kind,
      waypointId: entry.waypointId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      description: entry.description,
      ifUpdatedAt: stamps ? (stamps.get(entry.waypointId) ?? null) : undefined,
      ...(replaces ? { replaces } : {}),
      unacknowledged:
        replaces?.origin === 'live' &&
        (replaces.updatedAt === undefined || options.acknowledged?.get(entry.waypointId) !== replaces.updatedAt),
    };
  };
  return {
    plan,
    requests: [
      ...plan.puts.map(entry => request('put', entry)),
      ...(options.withdraw ? plan.withdrawals : []).map(waypointId =>
        request('withdraw', { waypointId, description: '' })
      ),
      ...plan.adoptions.map(entry => request('adopt', entry)),
    ],
    skippedWithdrawals: options.withdraw ? 0 : plan.withdrawals.length,
  };
}

/** The body of a PUT: the text, written by the upload, over the row as it was read. */
export function uploadBody(request: Pick<UploadRequest, 'description' | 'ifUpdatedAt'>): UpsertDescriptionRequest {
  return {
    description: request.description,
    source: 'upload',
    ...(request.ifUpdatedAt === undefined ? {} : { ifUpdatedAt: request.ifUpdatedAt }),
  };
}

/** Text from the API on one line, in quotes, cut to 100 characters: it never starts a line of its own. */
function quoted(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return JSON.stringify(oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine);
}

/**
 * What a request replaces, for its line. Text an upload sent is listed
 * plainly; a live edit or a live clear is marked `!`.
 */
function replacedNote(row: DescriptionOverwrite | undefined): string {
  if (!row) return '';
  if (row.live === '')
    return '\n    ! undoes a live clear (cleared on admin-descriptions.html; the file still lists it)';
  switch (row.origin) {
    case 'live':
      return `\n    ! replaces a live edit: ${quoted(row.live)}`;
    case 'upload':
      return `\n    replaces uploaded text: ${quoted(row.live)}`;
    default:
      return `\n    replaces synced text of unknown origin: ${quoted(row.live)}`;
  }
}

/** A request's own line, before its outcome. */
function requestHead(request: UploadRequest): string {
  const named = `  ${request.waypointId}${request.name ? ` (${request.name})` : ''}`;
  switch (request.kind) {
    case 'withdraw':
      return `${named} (withdraw)`;
    case 'adopt':
      return (
        `${named} (mark as uploaded: ` +
        `${request.description === '' ? 'a live clear the file agrees with' : 'a live edit that is now in the file'}; text unchanged)`
      );
    default:
      return named;
  }
}

/** The row a 409 answered, in words. It is the API's, so nothing in it is trusted to be well-formed. */
function conflictNote(current: unknown): string {
  if (typeof current !== 'object' || current === null) return '    the API now has no row for it';
  const { description, source, updatedAt } = current as Record<string, unknown>;
  const when = isStamp(updatedAt) ? ` (changed ${updatedAt})` : '';
  if (typeof description !== 'string') return `    the API holds a different row for it${when}`;
  const live = source === 'live';
  if (description === '') return `    it is now ${live ? 'cleared live' : 'withdrawn'}${when}`;
  return `    it now holds ${live ? 'a live edit' : 'uploaded text'}${when}: ${quoted(description)}`;
}

function checkedLiveRow(raw: unknown, where: string): LiveRow {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { waypointId, description, updatedAt, source } = row;
  if (typeof waypointId !== 'string' || !WAYPOINT_ID_PATTERN.test(waypointId)) {
    throw new Error(`${where} has an invalid "waypointId"`);
  }
  if (typeof description !== 'string') throw new Error(`${where} (${waypointId}) has no "description"`);
  if (!isStamp(updatedAt)) throw new Error(`${where} (${waypointId}) has no usable "updatedAt"`);
  return {
    waypointId,
    description,
    updatedAt,
    ...(source === 'live' || source === 'upload' ? { source } : {}),
  };
}

/** What a run reads of a trail before it plans. */
export interface LiveSet {
  /** The descriptions the API serves for the trail now, withdrawn ones included. */
  rows: LiveRow[];
  /** Whether the worker says it records a write's source and honours its precondition. */
  guardsWrites: boolean;
}

/** The live set of a trail, and whether the worker that served it guards writes. */
export async function fetchLiveDescriptions(fetchFn: typeof fetch, apiBase: string, trailId: string): Promise<LiveSet> {
  const url = `${apiBase}/v1/trails/${encodeURIComponent(trailId)}/descriptions`;
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { descriptions?: unknown; writeFeatures?: unknown };
  if (!Array.isArray(body.descriptions)) {
    throw new Error(`GET ${url}: response has no "descriptions" array`);
  }
  return {
    rows: body.descriptions.map((raw, index) => checkedLiveRow(raw, `GET ${url}: descriptions[${index}]`)),
    guardsWrites: guardsDescriptionWrites(body),
  };
}

/** The row a 409 `description_conflict` body carries, or `null` when the body is not that answer. */
function conflictAnswer(body: string): { current: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const answer = parsed as { error?: { code?: unknown }; current?: unknown } | null;
  return answer?.error?.code === 'description_conflict' ? { current: answer.current ?? null } : null;
}

/**
 * Send one request. Resolves `null` when the API took it, and the row the API
 * holds instead (`current`, `null` for "no row") when it refused the
 * precondition. Any other failure throws and stops the run: it is not about
 * this row.
 */
async function putDescription(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  trailId: string,
  request: UploadRequest
): Promise<null | { current: unknown }> {
  if (request.ifUpdatedAt === undefined) {
    // Unreachable in a real run, which always reads the live set first.
    throw new Error(`PUT ${request.waypointId}: no precondition (the live set was not read)`);
  }
  const url = `${apiBase}/v1/admin/trails/${encodeURIComponent(trailId)}/descriptions/${encodeURIComponent(request.waypointId)}`;
  const response = await fetchFn(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(uploadBody(request)),
  });
  if (response.ok) return null;

  const detail = await response.text().catch(() => '');
  if (response.status === 409) {
    const conflict = conflictAnswer(detail);
    if (conflict) return conflict;
  }
  const oneLine = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  throw new Error(
    `PUT ${request.waypointId} failed: ${response.status} ${response.statusText}${oneLine ? ` — ${oneLine}` : ''}`
  );
}

export interface UploadRun {
  /** The trails to visit, each with its authored entries, in order. */
  trails: readonly { trailId: string; entries: readonly CuratedDescription[] }[];
  /** Required for a real run; a dry run without one reads no live set. */
  apiBase?: string;
  /** The admin bearer token. Required for a real run, unused by a dry one. */
  token?: string;
  dryRun: boolean;
  /** `false` under `--no-withdraw`. */
  withdraw: boolean;
  /** The live edits a plan showed (`--acknowledged-live`), or `null` when the run was given none. */
  acknowledged: AcknowledgedLive | null;
  /**
   * `--allow-unchecked-live`: let a real run write to a worker that does not
   * say it records the source of a description or honours a precondition.
   * Without it such a run sends nothing.
   */
  allowUnguarded: boolean;
  /** Under GitHub Actions: warnings and refusals are also annotations. */
  githubActions: boolean;
  fetch: typeof fetch;
  log: (text: string) => void;
}

export interface UploadRunResult {
  /** 0, or `EXIT_REFUSED` when a real run was refused a row or held one back. */
  exitCode: number;
  /** Every live edit or clear the run's requests would undo, as shown: what `--record-live` writes. */
  liveShown: AcknowledgedLive;
}

/** `heysen: w_a, w_b` per trail, for a message made of ids only. */
function idsByTrail(rows: readonly { trailId: string; waypointId: string }[]): string {
  const byTrail = new Map<string, string[]>();
  for (const { trailId, waypointId } of rows) byTrail.set(trailId, [...(byTrail.get(trailId) ?? []), waypointId]);
  return [...byTrail.entries()]
    .map(([trailId, ids]) => {
      const listed = ids.slice(0, 10).join(', ');
      return `${trailId}: ${listed}${ids.length > 10 ? ` and ${ids.length - 10} more` : ''}`;
    })
    .join('; ');
}

/** What is wrong with a worker whose read does not say it guards writes. Fixed text: nothing from the API. */
const UNGUARDED =
  `This comments API does not say that it records where a synced text came from, or that it refuses a write over a ` +
  `row that changed after it was read (its worker predates description provenance: the Deploy comments API ` +
  `workflow has not succeeded with it). So a live edit made on admin-descriptions.html cannot be told from ` +
  `uploaded text, and a row edited after this run read it would be replaced.`;
const UNGUARDED_FLAG =
  `Let that workflow succeed and run again; or, to send regardless, pass --allow-unchecked-live (the upload then ` +
  `overwrites any live edit unseen).`;

/** Plan each trail, print the plan, and in a real run send it. */
export async function runDescriptionUpload(run: UploadRun): Promise<UploadRunResult> {
  const { dryRun, log } = run;
  const apiBase = run.apiBase?.replace(/\/+$/, '');
  const token = run.token;
  if (!dryRun && (!apiBase || !token)) throw new Error('A real run needs an API base URL and an admin token.');
  // A dry run only previews what a real run would hold back when it is given the set a real run would be.
  const holding = !dryRun || run.acknowledged !== null;

  const liveShown: AcknowledgedLive = new Map();
  /** Per trail: live edits and clears the upload undoes (the warning). */
  const liveEditWarnings: string[] = [];
  /** Per trail: replaced text whose origin the API did not report. */
  const unknownOrigin: string[] = [];
  /** A read came from a worker that does not say it guards writes. */
  let unguarded = false;
  /** Live edits or clears held back: not in the acknowledged set. */
  const heldBack: { trailId: string; waypointId: string }[] = [];
  /** Rows the API refused: changed after the run read them. */
  const conflicts: { trailId: string; waypointId: string }[] = [];
  const count = { put: 0, withdraw: 0, adopt: 0 };
  let unchanged = 0;

  for (const { trailId, entries } of run.trails) {
    const liveSet = apiBase ? await fetchLiveDescriptions(run.fetch, apiBase, trailId) : null;
    if (liveSet && !liveSet.guardsWrites) {
      unguarded = true;
      // Before anything is sent to it: nothing above this line wrote to this trail.
      if (!dryRun && !run.allowUnguarded)
        throw new Error(`Nothing was sent for ${trailId}. ${UNGUARDED} ${UNGUARDED_FLAG}`);
    }
    const live = liveSet ? liveSet.rows : null;
    const { plan, requests, skippedWithdrawals } = planTrailUpload(entries, live, {
      withdraw: run.withdraw,
      acknowledged: run.acknowledged?.get(trailId),
    });
    const withdrawals = requests.filter(request => request.kind === 'withdraw').length;
    const held = holding ? requests.filter(request => request.unacknowledged).length : 0;
    log(
      `\n${trailId}: ${entries.length} description(s) — ${plan.puts.length} to send, ` +
        `${plan.unchanged} unchanged, ${withdrawals} to withdraw` +
        (skippedWithdrawals > 0 ? ` (${skippedWithdrawals} skipped: --no-withdraw)` : '') +
        (plan.adoptions.length > 0 ? `, ${plan.adoptions.length} committed live edit(s) to mark as uploaded` : '') +
        (held > 0 ? `; ${held} of these held back (a live edit or clear the plan did not show)` : '') +
        (live ? '' : ' (no API base: live set not read)')
    );

    let liveEdits = 0;
    let unknown = 0;
    for (const request of requests) {
      const head = requestHead(request);
      const note = replacedNote(request.replaces);
      const undoesLive = request.replaces?.origin === 'live';
      if (undoesLive && request.replaces?.updatedAt !== undefined) {
        const shown = liveShown.get(trailId) ?? new Map<string, string>();
        shown.set(request.waypointId, request.replaces.updatedAt);
        liveShown.set(trailId, shown);
      }
      if (holding && request.unacknowledged) {
        const what = request.replaces?.live === '' ? 'a live clear' : 'a live edit';
        log(`${head} ✗ ${dryRun ? 'would not be sent' : 'not sent'}: ${what} the plan did not show${note}`);
        heldBack.push({ trailId, waypointId: request.waypointId });
        continue;
      }
      if (dryRun) {
        const target = apiBase ?? '<TRACKNOTES_API_BASE_URL>';
        log(`${head}${note}\n    PUT ${target}/v1/admin/trails/${trailId}/descriptions/${request.waypointId}`);
        log(`    ${JSON.stringify(uploadBody(request))}`);
      } else {
        const refused = await putDescription(run.fetch, apiBase!, token!, trailId, request);
        if (refused) {
          log(`${head} ✗ not sent: the row changed after this run read it${note}\n${conflictNote(refused.current)}`);
          conflicts.push({ trailId, waypointId: request.waypointId });
          continue;
        }
        log(`${head} ✓${note}`);
      }
      count[request.kind]++;
      if (undoesLive) liveEdits++;
      if (request.replaces?.origin === 'unknown') unknown++;
    }
    if (liveEdits > 0) liveEditWarnings.push(`${trailId}: ${liveEdits}`);
    if (unknown > 0) unknownOrigin.push(`${trailId}: ${unknown}`);
    unchanged += plan.unchanged;
  }

  // The *Upload descriptions* workflow greps this line for "nothing to do"
  // (`would have 0 description(s) sent, 0 withdrawn, 0 committed live edit(s)
  // marked`): keep the two in step.
  const summary =
    `${count.put} description(s) sent, ${count.withdraw} withdrawn, ` +
    `${count.adopt} committed live edit(s) marked as uploaded, ` +
    `${unchanged} already up to date, across ${run.trails.length} trail(s).`;
  log(dryRun ? `\nDry run: would have ${summary}` : `\nDone: ${summary}`);

  const annotate = (level: 'warning' | 'error', title: string, message: string): void => {
    log(`\n${level === 'error' ? 'Error' : 'Warning'}: ${message}`);
    if (run.githubActions) log(`::${level} title=${title}::${message}`);
  };
  if (liveEditWarnings.length > 0) {
    annotate(
      'warning',
      'Live description edits undone',
      `${dryRun ? 'Would undo' : 'Undid'} live edits or clears that descriptions.json does not match ` +
        `(${liveEditWarnings.join(', ')}; the lines marked "!"). Each was made on admin-descriptions.html and ` +
        `is not in the file as written: commit a live edit to descriptions.json (the page's export) or it is lost, ` +
        `and delete an entry from the file to keep its clear.` +
        (dryRun
          ? ` A real run undoes only the ones it is told this plan showed (--acknowledged-live; approving the plan ` +
            `in Actions passes them), and refuses one made or changed since.`
          : ` Each was shown in the plan this run was given (--acknowledged-live).`)
    );
  }
  if (unguarded) {
    annotate(
      'warning',
      'Live edits not checked',
      UNGUARDED +
        (unknownOrigin.length > 0
          ? ` The replaced text (${unknownOrigin.join(', ')}) ${dryRun ? 'is' : 'was'} not checked for live edits.`
          : '') +
        (dryRun
          ? ` A real run sends nothing to this API: let the Deploy comments API workflow succeed and plan again, ` +
            `or pass --allow-unchecked-live to a run made by hand.`
          : ` Sent all the same: --allow-unchecked-live.`)
    );
  }
  if (heldBack.length > 0) {
    const cause =
      run.acknowledged === null
        ? `This run was given no plan to go by (--acknowledged-live)`
        : `Each was made or changed on admin-descriptions.html after the plan this run was given (--acknowledged-live) was read`;
    annotate(
      dryRun ? 'warning' : 'error',
      'Live description edits not overwritten',
      `${dryRun ? 'Would not send' : 'Not sent'}: the file's text over live edits or clears that the plan did not show ` +
        `(${idsByTrail(heldBack)}; the lines marked "✗"). ${cause}, so ${dryRun ? 'nothing would be' : 'nothing was'} ` +
        `written over them. To keep one, commit it to descriptions.json. To send the file's text over one, make a ` +
        `new plan and pass what it shows: in Actions, re-run the whole workflow and approve its plan; by hand, ` +
        `--dry-run --record-live <file>, read the lines marked "!", then --acknowledged-live <file>.`
    );
  }
  if (conflicts.length > 0) {
    annotate(
      'error',
      'Descriptions changed during the upload',
      `Not sent: rows that changed after this run read them (${idsByTrail(conflicts)}; the lines marked "✗"). ` +
        `The API refused each write (409 description_conflict) and holds what was written meanwhile. Run again to ` +
        `plan against the rows as they are now: in Actions, re-run the whole workflow.`
    );
  }

  return { exitCode: !dryRun && heldBack.length + conflicts.length > 0 ? EXIT_REFUSED : 0, liveShown };
}

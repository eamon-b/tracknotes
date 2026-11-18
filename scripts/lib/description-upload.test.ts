import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  EXIT_REFUSED,
  fetchLiveDescriptions,
  parseAcknowledgedLive,
  planTrailUpload,
  runDescriptionUpload,
  serializeAcknowledgedLive,
  type AcknowledgedLive,
  type UploadRun,
} from './description-upload';
import type { CuratedDescription } from './waypoint-descriptions';

const API = 'https://api.test';
const T0 = '2026-11-01T00:00:00.000Z';

interface Row {
  waypointId: string;
  description: string;
  updatedAt: string;
  source?: 'live' | 'upload';
}

/**
 * The comments API's description routes in memory, with the worker's PUT
 * semantics (`workers/comments-api/src/descriptions.ts`): the `ifUpdatedAt`
 * precondition and its 409, the no-op re-send, and an upload taking a live
 * row over when it re-sends the same text.
 *
 * `guards: false` is the worker from before any of that: it stores the text
 * and nothing else, ignores `source` and `ifUpdatedAt`, and its read carries
 * no `writeFeatures`.
 */
function fakeApi(initial: Row[], { guards = true }: { guards?: boolean } = {}) {
  const stored = ({ waypointId, description, updatedAt, source }: Row): Row =>
    guards ? { waypointId, description, updatedAt, source } : { waypointId, description, updatedAt };
  const rows = new Map(initial.map(row => [row.waypointId, stored(row)]));
  const puts: { waypointId: string; body: Record<string, unknown>; status: number }[] = [];
  let clock = Date.parse(T0);
  const tick = () => new Date((clock += 60_000)).toISOString();
  const hooks: { afterRead?: () => void } = {};

  /** An admin's edit on admin-descriptions.html. */
  const liveEdit = (waypointId: string, description: string): Row => {
    const row: Row = { waypointId, description, updatedAt: tick(), ...(guards ? { source: 'live' as const } : {}) };
    rows.set(waypointId, row);
    return row;
  };

  const put = (waypointId: string, body: Record<string, unknown>): [number, unknown] => {
    const description = body.description as string;
    const current = rows.get(waypointId);
    if (!guards) {
      if (current?.description === description) return [200, current];
      const row: Row = { waypointId, description, updatedAt: tick() };
      rows.set(waypointId, row);
      return [200, row];
    }
    const source = (body.source as Row['source']) ?? 'upload';
    const pre = body.ifUpdatedAt as string | null | undefined;
    const writes =
      pre === undefined
        ? !current || current.description !== description
        : pre === null
          ? !current
          : current !== undefined && current.updatedAt === pre && current.description !== description;
    if (writes) {
      const row: Row = { waypointId, description, updatedAt: tick(), source };
      rows.set(waypointId, row);
      return [200, row];
    }
    if (current && current.description === description) {
      if (source === 'upload' && current.source === 'live') current.source = 'upload';
      return [200, current];
    }
    return [
      409,
      { error: { code: 'description_conflict', message: 'This description has changed since it was read' }, current },
    ];
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!init?.method || init.method === 'GET') {
      const response = answer(200, {
        descriptions: [...rows.values()].map(row => ({ ...row })),
        syncedAt: T0,
        ...(guards ? { writeFeatures: ['source', 'ifUpdatedAt'] } : {}),
      });
      const hook = hooks.afterRead;
      hooks.afterRead = undefined;
      hook?.();
      return response;
    }
    const waypointId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const [status, result] = put(waypointId, body);
    puts.push({ waypointId, body, status });
    return answer(status, result);
  }) as typeof fetch;

  return { rows, puts, hooks, liveEdit, fetch: fetchFn };
}

const AUTHORED: CuratedDescription[] = [
  { waypointId: 'w_aaaa0001', name: 'Hut', description: 'A hut with a tank.' },
  { waypointId: 'w_aaaa0002', name: 'Creek', description: 'A creek, dry in summer.' },
  { waypointId: 'w_aaaa0003', description: 'A campsite.' },
];

/** The API as the last upload left it, before `AUTHORED`'s first two entries were reworded. */
function uploadedRows(): Row[] {
  return [
    { waypointId: 'w_aaaa0001', description: 'A hut.', updatedAt: T0, source: 'upload' },
    { waypointId: 'w_aaaa0002', description: 'A creek.', updatedAt: T0, source: 'upload' },
    { waypointId: 'w_aaaa0003', description: 'A campsite.', updatedAt: T0, source: 'upload' },
  ];
}

async function run(api: ReturnType<typeof fakeApi>, overrides: Partial<UploadRun> = {}) {
  const lines: string[] = [];
  const result = await runDescriptionUpload({
    trails: [{ trailId: 'demo', entries: AUTHORED }],
    apiBase: API,
    token: 'admin-token',
    dryRun: false,
    withdraw: true,
    acknowledged: null,
    allowUnguarded: false,
    githubActions: true,
    fetch: api.fetch,
    log: text => lines.push(...text.split('\n')),
    ...overrides,
  });
  return { ...result, lines, text: lines.join('\n') };
}

/** What the workflow does between its two jobs: the dry run's file, read back. */
function handOver(shown: AcknowledgedLive): AcknowledgedLive {
  return parseAcknowledgedLive(serializeAcknowledgedLive(shown), 'live-shown.json');
}

describe('planTrailUpload', () => {
  it('gives every request the version of the row it was planned against', () => {
    const { requests } = planTrailUpload(
      [
        { waypointId: 'w_aaaa0001', description: 'New wording.' },
        { waypointId: 'w_aaaa0002', description: 'Not on the API yet.' },
        { waypointId: 'w_aaaa0003', description: 'Committed live edit.' },
      ],
      [
        {
          waypointId: 'w_aaaa0001',
          description: 'Old wording.',
          updatedAt: '2026-11-02T00:00:00.000Z',
          source: 'upload',
        },
        {
          waypointId: 'w_aaaa0003',
          description: 'Committed live edit.',
          updatedAt: '2026-11-03T00:00:00.000Z',
          source: 'live',
        },
        {
          waypointId: 'w_zzzz0009',
          description: 'Dropped from the file.',
          updatedAt: '2026-11-04T00:00:00.000Z',
          source: 'upload',
        },
      ],
      { withdraw: true }
    );
    expect(requests.map(({ kind, waypointId, ifUpdatedAt }) => ({ kind, waypointId, ifUpdatedAt }))).toEqual([
      { kind: 'put', waypointId: 'w_aaaa0001', ifUpdatedAt: '2026-11-02T00:00:00.000Z' },
      // No row was read: only an insert may go through.
      { kind: 'put', waypointId: 'w_aaaa0002', ifUpdatedAt: null },
      { kind: 'withdraw', waypointId: 'w_zzzz0009', ifUpdatedAt: '2026-11-04T00:00:00.000Z' },
      { kind: 'adopt', waypointId: 'w_aaaa0003', ifUpdatedAt: '2026-11-03T00:00:00.000Z' },
    ]);
    expect(requests.some(request => request.unacknowledged)).toBe(false);
  });

  it('has no precondition to give when the live set was not read', () => {
    const { requests } = planTrailUpload(AUTHORED, null, { withdraw: true });
    expect(requests.map(request => request.ifUpdatedAt)).toEqual([undefined, undefined, undefined]);
  });

  it('calls a live edit acknowledged only at the version that was shown', () => {
    const live = [
      {
        waypointId: 'w_aaaa0001',
        description: 'Edited live.',
        updatedAt: '2026-11-05T00:00:00.000Z',
        source: 'live' as const,
      },
      { waypointId: 'w_aaaa0002', description: '', updatedAt: '2026-11-06T00:00:00.000Z', source: 'live' as const },
      { waypointId: 'w_aaaa0003', description: 'A campsite.', updatedAt: T0, source: 'upload' as const },
      {
        waypointId: 'w_zzzz0009',
        description: 'Live, never in the file.',
        updatedAt: '2026-11-07T00:00:00.000Z',
        source: 'live' as const,
      },
    ];
    const unacknowledged = (acknowledged?: Map<string, string>) =>
      planTrailUpload(AUTHORED, live, { withdraw: true, acknowledged })
        .requests.filter(request => request.unacknowledged)
        .map(request => request.waypointId);

    expect(unacknowledged()).toEqual(['w_aaaa0001', 'w_aaaa0002', 'w_zzzz0009']);
    expect(
      unacknowledged(
        new Map([
          ['w_aaaa0001', '2026-11-05T00:00:00.000Z'],
          // An older version of the clear than the one live now.
          ['w_aaaa0002', '2026-11-05T12:00:00.000Z'],
          ['w_zzzz0009', '2026-11-07T00:00:00.000Z'],
        ])
      )
    ).toEqual(['w_aaaa0002']);
  });
});

describe('runDescriptionUpload', () => {
  it('sends an ordinary edit over the row it read, and exits 0', async () => {
    const api = fakeApi(uploadedRows());
    const { exitCode, text } = await run(api);

    expect(exitCode).toBe(0);
    expect(api.puts).toEqual([
      {
        waypointId: 'w_aaaa0001',
        body: { description: 'A hut with a tank.', source: 'upload', ifUpdatedAt: T0 },
        status: 200,
      },
      {
        waypointId: 'w_aaaa0002',
        body: { description: 'A creek, dry in summer.', source: 'upload', ifUpdatedAt: T0 },
        status: 200,
      },
    ]);
    expect(text).toContain('Done: 2 description(s) sent, 0 withdrawn, 0 committed live edit(s) marked as uploaded');
    expect(text).not.toMatch(/Warning|Error/);
  });

  it('prints the same plan in a dry run, with the precondition, and sends nothing', async () => {
    const api = fakeApi(uploadedRows());
    const { exitCode, text, liveShown } = await run(api, { dryRun: true, token: undefined });

    expect(exitCode).toBe(0);
    expect(api.puts).toEqual([]);
    expect(text).toContain(`PUT ${API}/v1/admin/trails/demo/descriptions/w_aaaa0001`);
    expect(text).toContain(JSON.stringify({ description: 'A hut with a tank.', source: 'upload', ifUpdatedAt: T0 }));
    expect(text).toContain('replaces uploaded text: "A hut."');
    // The line the workflow greps for "nothing to do" keeps its wording.
    expect(text).toContain('Dry run: would have 2 description(s) sent, 0 withdrawn, 0 committed live edit(s) marked');
    expect(serializeAcknowledgedLive(liveShown)).toBe('{"version":1,"live":{}}');
  });

  it('undoes a live edit the plan showed, once the plan is handed back', async () => {
    const api = fakeApi(uploadedRows());
    const edit = api.liveEdit('w_aaaa0001', 'Tank closed until March.');

    const plan = await run(api, { dryRun: true });
    expect(plan.text).toContain('! replaces a live edit: "Tank closed until March."');
    expect(plan.lines).toContainEqual(
      expect.stringMatching(/^::warning title=Live description edits undone::Would undo/)
    );
    expect(serializeAcknowledgedLive(plan.liveShown)).toBe(
      `{"version":1,"live":{"demo":{"w_aaaa0001":"${edit.updatedAt}"}}}`
    );

    const upload = await run(api, { acknowledged: handOver(plan.liveShown) });
    expect(upload.exitCode).toBe(0);
    expect(api.rows.get('w_aaaa0001')).toMatchObject({ description: 'A hut with a tank.', source: 'upload' });
    expect(api.puts.map(put => put.status)).toEqual([200, 200]);
    // A warning, as before: it never fails the run.
    expect(upload.lines).toContainEqual(expect.stringMatching(/^::warning title=Live description edits undone::Undid/));
    expect(upload.text).not.toContain('::error');
  });

  it('leaves alone a live edit made after a clean plan, sends the rest, and exits 2', async () => {
    const api = fakeApi(uploadedRows());
    // The plan the approver reads: two ordinary edits, no "!" line.
    const plan = await run(api, { dryRun: true });
    expect(plan.text).not.toContain('!');
    expect(plan.text).not.toContain('Warning');

    // An urgent live edit lands while the run waits for approval.
    api.liveEdit('w_aaaa0001', 'Tank closed until March.');

    const upload = await run(api, { acknowledged: handOver(plan.liveShown) });
    expect(upload.exitCode).toBe(EXIT_REFUSED);
    // Nothing was sent for the live edit; the other row went.
    expect(api.puts.map(put => put.waypointId)).toEqual(['w_aaaa0002']);
    expect(api.rows.get('w_aaaa0001')).toMatchObject({ description: 'Tank closed until March.', source: 'live' });
    expect(api.rows.get('w_aaaa0002')).toMatchObject({ description: 'A creek, dry in summer.' });
    expect(upload.text).toContain('w_aaaa0001 (Hut) ✗ not sent: a live edit the plan did not show');
    expect(upload.text).toContain('! replaces a live edit: "Tank closed until March."');
    expect(upload.text).toContain('Done: 1 description(s) sent');
    expect(upload.lines).toContainEqual(
      expect.stringMatching(/^::error title=Live description edits not overwritten::Not sent: .*\(demo: w_aaaa0001;/)
    );
    expect(upload.text).not.toContain('Undid');
  });

  it('leaves alone a live edit that was shown and then changed again', async () => {
    const api = fakeApi(uploadedRows());
    api.liveEdit('w_aaaa0001', 'Tank closed until March.');
    const plan = await run(api, { dryRun: true });
    api.liveEdit('w_aaaa0001', 'Tank closed until June: the roof is off.');

    const upload = await run(api, { acknowledged: handOver(plan.liveShown) });
    expect(upload.exitCode).toBe(EXIT_REFUSED);
    expect(api.rows.get('w_aaaa0001')?.description).toBe('Tank closed until June: the roof is off.');
  });

  it('undoes no live edit, clear or live-only text in a real run given no plan, and says how to give one', async () => {
    const api = fakeApi(uploadedRows());
    api.liveEdit('w_aaaa0001', 'Edited live.');
    api.liveEdit('w_aaaa0003', '');
    api.liveEdit('w_zzzz0009', 'Live, never in the file.');

    const upload = await run(api);
    expect(upload.exitCode).toBe(EXIT_REFUSED);
    expect(api.puts.map(put => put.waypointId)).toEqual(['w_aaaa0002']);
    expect(upload.text).toContain('w_aaaa0003 ✗ not sent: a live clear the plan did not show');
    expect(upload.text).toContain('w_zzzz0009 (withdraw) ✗ not sent: a live edit the plan did not show');
    expect(upload.text).toMatch(/given no plan to go by \(--acknowledged-live\)/);
    expect(upload.text).toMatch(/--dry-run --record-live <file>.*--acknowledged-live <file>/);
    expect(upload.text).toContain('demo: w_aaaa0001, w_aaaa0003, w_zzzz0009');
  });

  it('previews what a real run would hold back when a dry run is given the set', async () => {
    const api = fakeApi(uploadedRows());
    api.liveEdit('w_aaaa0001', 'Edited live.');

    const preview = await run(api, { dryRun: true, acknowledged: new Map() });
    expect(preview.exitCode).toBe(0);
    expect(preview.text).toContain('w_aaaa0001 (Hut) ✗ would not be sent: a live edit the plan did not show');
    expect(preview.text).toContain('Dry run: would have 1 description(s) sent');
    expect(preview.text).not.toContain('::error');
    // It still says what it showed, for a run that is to undo it.
    expect(preview.liveShown.get('demo')?.has('w_aaaa0001')).toBe(true);
  });

  it('does not replace a row edited between its read and its PUT: the 409 is reported, not retried', async () => {
    const api = fakeApi(uploadedRows());
    // The live edit lands just after the run has read the list.
    api.hooks.afterRead = () => api.liveEdit('w_aaaa0001', 'Bridge out: use the ford.\n::error::forged');

    const upload = await run(api);
    expect(upload.exitCode).toBe(EXIT_REFUSED);
    expect(api.puts).toEqual([
      expect.objectContaining({ waypointId: 'w_aaaa0001', status: 409 }),
      expect.objectContaining({ waypointId: 'w_aaaa0002', status: 200 }),
    ]);
    expect(api.rows.get('w_aaaa0001')).toMatchObject({ source: 'live' });
    expect(api.rows.get('w_aaaa0001')?.description).toContain('Bridge out');
    expect(upload.text).toContain('w_aaaa0001 (Hut) ✗ not sent: the row changed after this run read it');
    expect(upload.text).toMatch(
      /it now holds a live edit \(changed [0-9T:.Z-]+\): "Bridge out: use the ford\. ::error::forged"/
    );
    expect(upload.text).toContain('Done: 1 description(s) sent');
    expect(upload.lines).toContainEqual(
      expect.stringMatching(/^::error title=Descriptions changed during the upload::Not sent: .*\(demo: w_aaaa0001;/)
    );
    // Text from the API never starts a line, so it cannot forge an annotation.
    expect(upload.lines.filter(line => /^\s*::/.test(line))).toEqual([
      expect.stringMatching(/^::error title=Descriptions changed during the upload::/),
    ]);
  });

  it('refuses a first PUT when a row appeared after the read', async () => {
    const api = fakeApi(uploadedRows().slice(1));
    api.hooks.afterRead = () => api.liveEdit('w_aaaa0001', 'Written live meanwhile.');

    const upload = await run(api);
    expect(api.puts[0]).toMatchObject({ waypointId: 'w_aaaa0001', body: { ifUpdatedAt: null }, status: 409 });
    expect(api.rows.get('w_aaaa0001')?.description).toBe('Written live meanwhile.');
    expect(upload.exitCode).toBe(EXIT_REFUSED);
  });

  it('marks a committed live edit uploaded, with the precondition and no change of stamp', async () => {
    const api = fakeApi([
      ...uploadedRows().slice(2),
      {
        waypointId: 'w_aaaa0001',
        description: 'A hut with a tank.',
        updatedAt: '2026-11-09T00:00:00.000Z',
        source: 'live',
      },
      { waypointId: 'w_aaaa0002', description: 'A creek, dry in summer.', updatedAt: T0, source: 'upload' },
    ]);
    const upload = await run(api);

    expect(upload.exitCode).toBe(0);
    expect(api.puts).toEqual([
      {
        waypointId: 'w_aaaa0001',
        body: { description: 'A hut with a tank.', source: 'upload', ifUpdatedAt: '2026-11-09T00:00:00.000Z' },
        status: 200,
      },
    ]);
    expect(api.rows.get('w_aaaa0001')).toEqual({
      waypointId: 'w_aaaa0001',
      description: 'A hut with a tank.',
      updatedAt: '2026-11-09T00:00:00.000Z',
      source: 'upload',
    });
    expect(upload.text).toContain('(mark as uploaded: a live edit that is now in the file; text unchanged) ✓');
    expect(upload.text).toContain('0 description(s) sent, 0 withdrawn, 1 committed live edit(s) marked as uploaded');
    expect(upload.text).not.toMatch(/Warning|Error/);
  });

  it('does not mark a row uploaded that was edited live again after the read', async () => {
    const api = fakeApi([
      ...uploadedRows().slice(1),
      {
        waypointId: 'w_aaaa0001',
        description: 'A hut with a tank.',
        updatedAt: '2026-11-09T00:00:00.000Z',
        source: 'live',
      },
    ]);
    api.hooks.afterRead = () => api.liveEdit('w_aaaa0001', 'A hut with a tank. Tank empty as of today.');

    const upload = await run(api);
    expect(upload.exitCode).toBe(EXIT_REFUSED);
    expect(api.rows.get('w_aaaa0001')).toMatchObject({
      description: 'A hut with a tank. Tank empty as of today.',
      source: 'live',
    });
  });

  it('still stops at once on an answer that is not about one row', async () => {
    const api = fakeApi(uploadedRows());
    const unauthorised = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? new Response('{"error":{"code":"unauthorized"}}\n::error::forged', {
            status: 401,
            statusText: 'Unauthorized',
          })
        : api.fetch(input, init)) as typeof fetch;

    const failure = await run(api, { fetch: unauthorised }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'PUT w_aaaa0001 failed: 401 Unauthorized — {"error":{"code":"unauthorized"}} ::error::forged'
    );
  });
});

describe('against a worker that does not say it guards writes', () => {
  /** A live edit on the old worker: stored like any text, with nothing to say what wrote it. */
  function oldWorker() {
    const api = fakeApi(uploadedRows(), { guards: false });
    api.liveEdit('w_aaaa0001', 'Tank closed until March.');
    return api;
  }

  it('still prints the plan in a dry run, and warns that nothing in it could be checked', async () => {
    const api = oldWorker();
    const plan = await run(api, { dryRun: true });

    expect(plan.exitCode).toBe(0);
    expect(api.puts).toEqual([]);
    // The live edit cannot be told from uploaded text: no "!" line, and nothing to acknowledge.
    expect(plan.text).toContain('replaces synced text of unknown origin: "Tank closed until March."');
    expect(plan.text).not.toContain('! replaces');
    expect(serializeAcknowledgedLive(plan.liveShown)).toBe('{"version":1,"live":{}}');
    expect(plan.lines).toContainEqual(
      expect.stringMatching(
        /^::warning title=Live edits not checked::This comments API does not say .*\(demo: 2\) is not checked for live edits\. A real run sends nothing to this API/
      )
    );
  });

  it('warns even when the plan replaces nothing, since a trail with no rows shows no sign of the worker', async () => {
    const plan = await run(fakeApi([], { guards: false }), { dryRun: true });
    expect(plan.text).toContain('Dry run: would have 3 description(s) sent');
    expect(plan.lines).toContainEqual(expect.stringMatching(/^::warning title=Live edits not checked::/));
  });

  it('sends nothing in a real run, and says what to do', async () => {
    const api = oldWorker();
    const failure = await run(api, { acknowledged: new Map() }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^Nothing was sent for demo\. This comments API does not say that it records where a synced text came from/
    );
    expect((failure as Error).message).toMatch(/Deploy comments API.*--allow-unchecked-live/);
    expect(api.puts).toEqual([]);
    expect(api.rows.get('w_aaaa0001')?.description).toBe('Tank closed until March.');
  });

  it('sends when told to, and says that it could not check', async () => {
    const api = oldWorker();
    const upload = await run(api, { allowUnguarded: true });

    expect(upload.exitCode).toBe(0);
    expect(api.puts.map(put => put.waypointId)).toEqual(['w_aaaa0001', 'w_aaaa0002']);
    expect(api.rows.get('w_aaaa0001')?.description).toBe('A hut with a tank.');
    expect(upload.lines).toContainEqual(
      expect.stringMatching(/^::warning title=Live edits not checked::.*Sent all the same: --allow-unchecked-live\.$/)
    );
  });

  it('has nothing to say about a worker that does guard writes', async () => {
    const plan = await run(fakeApi(uploadedRows()), { dryRun: true });
    expect(plan.text).not.toContain('Live edits not checked');
  });
});

describe('the acknowledged set', () => {
  it('round-trips as one line of ids and timestamps', () => {
    const shown: AcknowledgedLive = new Map([
      ['hume-and-hovell', new Map([['w_bbbb0002', '2026-11-02T03:04:05.678Z']])],
      ['demo', new Map([['w_aaaa0001', T0]])],
      ['empty', new Map()],
    ]);
    const text = serializeAcknowledgedLive(shown);
    expect(text).toBe(
      `{"version":1,"live":{"demo":{"w_aaaa0001":"${T0}"},"hume-and-hovell":{"w_bbbb0002":"2026-11-02T03:04:05.678Z"}}}`
    );
    // What the workflow checks before it puts the line in a job output.
    expect(text).toMatch(/^[{}":,.0-9A-Za-z_-]+$/);
    const parsed = parseAcknowledgedLive(text, 'f.json');
    expect([...parsed.keys()]).toEqual(['demo', 'hume-and-hovell']);
    expect(parsed.get('demo')?.get('w_aaaa0001')).toBe(T0);
  });

  it('refuses to write anything that is not an id or a timestamp', () => {
    expect(() => serializeAcknowledgedLive(new Map([['demo', new Map([['w_aaaa0001', 'now\n::error::x']])]]))).toThrow(
      /Cannot record/
    );
    expect(() => serializeAcknowledgedLive(new Map([['demo', new Map([['bad id\n', T0]])]]))).toThrow(/Cannot record/);
    expect(() => serializeAcknowledgedLive(new Map([['Bad Trail', new Map([['w_aaaa0001', T0]])]]))).toThrow(
      /Cannot record/
    );
  });

  it('refuses a file that is not what a dry run wrote', () => {
    for (const text of [
      '',
      'not json',
      '[]',
      '{"version":2,"live":{}}',
      '{"version":1}',
      '{"version":1,"live":{"demo":["w_aaaa0001"]}}',
      '{"version":1,"live":{"demo":{"w_aaaa0001":"yesterday"}}}',
      '{"version":1,"live":{"demo":{"Bad Id":"2026-11-01T00:00:00.000Z"}}}',
    ]) {
      expect(() => parseAcknowledgedLive(text, 'f.json'), text).toThrow(/f\.json: .*--record-live/);
    }
  });
});

describe('fetchLiveDescriptions', () => {
  const answering = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('refuses a row with no version, since nothing could then be sent conditionally', async () => {
    await expect(
      fetchLiveDescriptions(answering({ descriptions: [{ waypointId: 'w_aaaa0001', description: 'x' }] }), API, 'demo')
    ).rejects.toThrow(/descriptions\[0\] \(w_aaaa0001\) has no usable "updatedAt"/);
    await expect(
      fetchLiveDescriptions(
        answering({ descriptions: [{ waypointId: '::error::x', description: 'x', updatedAt: T0 }] }),
        API,
        'demo'
      )
    ).rejects.toThrow(/descriptions\[0\] has an invalid "waypointId"$/);
  });

  it('reads rows of an older worker, which name no source, and knows it for one', async () => {
    const live = await fetchLiveDescriptions(
      answering({ descriptions: [{ waypointId: 'w_aaaa0001', description: 'x', updatedAt: T0 }] }),
      API,
      'demo'
    );
    expect(live).toEqual({
      rows: [{ waypointId: 'w_aaaa0001', description: 'x', updatedAt: T0 }],
      guardsWrites: false,
    });
  });

  it('takes the worker’s word that it guards writes, with rows or with none', async () => {
    const writeFeatures = ['source', 'ifUpdatedAt'];
    expect(
      (await fetchLiveDescriptions(answering({ descriptions: [], writeFeatures }), API, 'demo')).guardsWrites
    ).toBe(true);
    expect(
      (await fetchLiveDescriptions(answering({ descriptions: [], writeFeatures: ['source'] }), API, 'demo'))
        .guardsWrites
    ).toBe(false);
  });
});

describe('the Upload descriptions workflow', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'upload-descriptions.yml'),
    'utf-8'
  );

  it('hands the live edits its plan showed to the upload, through the environment', () => {
    expect(workflow).toContain('upload:descriptions -- --dry-run --record-live "$shown"');
    expect(workflow).toContain('acknowledged: ${{ steps.plan.outputs.acknowledged }}');
    expect(workflow).toContain('ACKNOWLEDGED_LIVE: ${{ needs.plan.outputs.acknowledged }}');
    expect(workflow).toContain('upload:descriptions -- --acknowledged-live "$shown"');
    // The output is never pasted into a script: its only use is that variable.
    expect(workflow.match(/needs\.plan\.outputs\.acknowledged/g)).toHaveLength(1);
  });

  it('only lets through a line of the alphabet the script writes', () => {
    const pattern = /grep -Eqx '([^']+)' "\$shown"/.exec(workflow)?.[1];
    expect(pattern).toBe('[{}":,.0-9A-Za-z_-]+');
    const line = serializeAcknowledgedLive(new Map([['hume-and-hovell', new Map([['w_aaaa0001', T0]])]]));
    expect(line).toMatch(new RegExp(`^${pattern}$`));
  });

  it('reads "nothing to do" off the line a dry run with nothing to send prints', async () => {
    const api = fakeApi(AUTHORED.map(entry => ({ ...entry, updatedAt: T0, source: 'upload' as const })));
    const { text } = await run(api, { dryRun: true });
    const needle = /grep -q '([^']+)' "\$out"/.exec(workflow)?.[1];
    expect(needle).toBeDefined();
    expect(text).toContain(needle);
  });
});

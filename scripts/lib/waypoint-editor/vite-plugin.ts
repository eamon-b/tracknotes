/**
 * The waypoint editor's API, mounted on the Vite dev server only
 * (`configureServer` never runs in `vite build`, and `admin-waypoints.html` is
 * not a build input), so nothing here reaches the deployed site.
 *
 * It writes the repository's own files, so every request, reads included, must
 * pass `requestRefusal`, which stands on its own (a plugin's middleware runs
 * before Vite's host check and CORS middleware, so neither is relied on):
 *  - it comes from this machine (loopback), unless `WAYPOINT_EDITOR_ALLOW_REMOTE=1`;
 *  - its `Host` is a loopback name, so a DNS-rebinding page, whose requests
 *    arrive from loopback with its own name as `Host`, is refused;
 *  - its `Origin`, when it has one, is this server's own;
 *  - a write carries the `X-Waypoint-Editor` header.
 *
 * The saves are synchronous; the one thing a save may wait for, the elevation
 * of a new or moved waypoint off the route (the Copernicus DEM, read over the
 * network), is looked up here first and handed to the save.
 *
 * `vite.config.ts` imports this file, and everything a config file imports
 * restarts the dev server when it changes. So this file imports only types and
 * Node built-ins, and loads the editor's own modules (`trail-state.ts`,
 * `elevation.ts`, and through them `src/lib`) per request with
 * `ssrLoadModule`: an edit to one of those is picked up by the next request
 * with no restart. The rebuild's state is held outside the module for the
 * restarts that remain (`rebuildStateFor`).
 *
 * Routes, under `/__waypoint-editor`:
 *   GET  /trails                       trail list
 *   GET  /trails/:dir                  one trail's editor model
 *   POST /trails/:dir/waypoints        add a waypoint (NewWaypointRequest)
 *   POST /trails/:dir/waypoints/:id    save one waypoint (WaypointEditRequest)
 *   DELETE /trails/:dir/waypoints/:id  delete one waypoint (WaypointDeleteRequest)
 *   GET  /changes                      git status of the trail data
 *   GET  /rebuild, POST /rebuild       rebuild status / start build:trails + build:mobile-trails
 */

import { spawn, execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { isIP } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import type {
  ChangedFile,
  NewWaypointRequest,
  RebuildStatus,
  RegistryChange,
  WaypointDeleteRequest,
  WaypointEditRequest,
} from './api-types';
import { EDITOR_API_BASE, EDITOR_HEADER } from './api-types';
import type { DemSource } from './elevation';
import type { WaypointRegistry } from '../waypoint-ids';

/** The editor's modules, loaded per request (see the file comment); type-only here. */
type TrailStateModule = typeof import('./trail-state');
type ElevationModule = typeof import('./elevation');

const MAX_BODY_BYTES = 64 * 1024;
/** How much of an oversized body is read and dropped, so the 413 is delivered, before the connection is cut. */
const MAX_DISCARDED_BYTES = 8 * 1024 * 1024;
/** A normal build prints about 30,000 characters: the log keeps all of it, and the tail of a runaway one. */
const LOG_TAIL_CHARS = 200_000;
/** A rebuild lock older than this is stale whatever its pids say (a build takes a minute or two). */
const MAX_REBUILD_MS = 30 * 60_000;

/** A refusal the API answers with `status`. `trail-state.ts`'s `EditorError` has the same shape. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The status an error answers with: its own `status` when it carries one (`HttpError`, `EditorError`), else 500. */
function errorStatus(error: unknown): number {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // No page but the editor's own may load a response, even opaquely.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(JSON.stringify(body));
}

/**
 * The request's JSON body. One over `MAX_BODY_BYTES` is refused with 413
 * without cutting the connection first (the client would see a reset, not the
 * answer): a declared length is refused before anything is read, and a body
 * that outgrows the limit is read on and dropped, up to `MAX_DISCARDED_BYTES`.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(`Request body is over ${MAX_BODY_BYTES} bytes`, 413);
    // Not read at all: Node drains an unread body itself once the response is out.
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return reject(tooLarge());
    let size = 0;
    let refused = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (refused) {
        if (size > MAX_DISCARDED_BYTES) req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new HttpError('Request body is not JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

/** A request's JSON body as the object every write route expects, with `expected` an object where the route needs it. */
export function requestObject(body: unknown, needsExpected = false): Record<string, unknown> {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(body)) throw new HttpError('Request body must be a JSON object', 400);
  if (needsExpected && !isObject(body.expected)) {
    throw new HttpError('Request body needs "expected": what the page last read of the waypoint', 400);
  }
  return body;
}

/** A route's path segments, decoded. */
export function routeSegments(route: string): string[] {
  try {
    return route.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError('Malformed URL', 400);
  }
}

// ---------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------

export interface RequestGuardOptions {
  /** `WAYPOINT_EDITOR_ALLOW_REMOTE=1`: editing from another machine on a trusted network. */
  allowRemote: boolean;
  /** Vite's resolved `server.allowedHosts`; read only with `allowRemote`, and `true` ("any host") adds nothing. */
  allowedHosts: readonly string[] | true;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return !!address && (address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1');
}

const HOST_LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const HOST_NAME_RE = new RegExp(`^(${HOST_LABEL}(?:\\.${HOST_LABEL})*)(?::\\d{1,5})?$`);
const HOST_IPV6_RE = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/;

/**
 * The hostname of a `Host` header (lower-cased, no port) and what kind it is,
 * or null for anything that is not exactly `name`, `name:port`, `[ipv6]` or
 * `[ipv6]:port`.
 */
export function parseHostHeader(host: string | undefined): { hostname: string; kind: 'name' | 'ipv4' | 'ipv6' } | null {
  // A DNS name is at most 253 characters; the cap also bounds the matching below.
  if (typeof host !== 'string' || host.length > 300) return null;
  const lower = host.toLowerCase();
  const ipv6 = HOST_IPV6_RE.exec(lower);
  if (ipv6) return isIP(ipv6[1]) === 6 ? { hostname: ipv6[1], kind: 'ipv6' } : null;
  const name = HOST_NAME_RE.exec(lower);
  if (!name) return null;
  return { hostname: name[1], kind: isIP(name[1]) === 4 ? 'ipv4' : 'name' };
}

/**
 * Whether a `Host` header names this dev server.
 *
 * The check that stops DNS rebinding: a page on `attacker.example` whose name
 * is re-pointed at 127.0.0.1 reaches the API from loopback, same-origin (so no
 * preflight, and its `Origin` equals its `Host`), but the `Host` it sends is
 * still `attacker.example`. Only names that cannot be re-pointed are accepted:
 *  - `localhost` and `*.localhost` (always loopback: RFC 6761), `127.0.0.0/8`
 *    literals and `[::1]`;
 *  - with `allowRemote`, also any IP literal (an address is not a name anyone
 *    can re-point) and the names listed in Vite's `server.allowedHosts` (a
 *    leading dot covers subdomains, as Vite reads it). Never an unlisted DNS
 *    name, even under `allowedHosts: true`.
 */
export function hostAllowed(host: string | undefined, options: RequestGuardOptions): boolean {
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  const { hostname, kind } = parsed;
  if (kind === 'ipv4') return options.allowRemote || hostname.startsWith('127.');
  if (kind === 'ipv6') return options.allowRemote || new URL(`http://[${hostname}]`).hostname === '[::1]';
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (!options.allowRemote || options.allowedHosts === true) return false;
  return options.allowedHosts.some(entry => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith('.') ? hostname === allowed.slice(1) || hostname.endsWith(allowed) : hostname === allowed;
  });
}

/**
 * Whether a request's `Origin`, when it sends one, is this server's own.
 * A browser sends `Origin` on every cross-origin `fetch` and on every write,
 * so a page on another site, or on another port of this machine, is told
 * apart here whatever CORS headers Vite's own middleware would grant it.
 */
export function originAllowed(headers: IncomingMessage['headers']): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof headers.host !== 'string') return false;
  try {
    return new URL(origin).host === headers.host.toLowerCase();
  } catch {
    return false;
  }
}

/** Whether a write comes from the editor page itself. */
export function writeAllowed(headers: IncomingMessage['headers']): boolean {
  return headers[EDITOR_HEADER.toLowerCase()] === '1' && originAllowed(headers);
}

/** Why a request is refused (answered 403), or null when it may go on. Every route asks, reads included. */
export function requestRefusal(
  request: { method: string; headers: IncomingMessage['headers']; remoteAddress: string | undefined },
  options: RequestGuardOptions
): string | null {
  if (!options.allowRemote && !isLoopbackAddress(request.remoteAddress)) {
    return 'The waypoint editor answers only this machine';
  }
  if (!hostAllowed(request.headers.host, options)) {
    return options.allowRemote
      ? 'The waypoint editor answers only to localhost, an IP address or a host in server.allowedHosts'
      : 'The waypoint editor answers only to localhost';
  }
  if (!originAllowed(request.headers)) return 'The waypoint editor answers only its own page';
  if (request.method !== 'GET' && !writeAllowed(request.headers)) {
    return 'Writes are accepted only from the editor page';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/** Ids a build minted (new to the registry) or retired (no longer matched): each is a waypoint that lost its id. */
export function registryChanges(
  before: WaypointRegistry,
  after: WaypointRegistry
): { minted: RegistryChange[]; retired: RegistryChange[] } {
  const minted: RegistryChange[] = [];
  const retired: RegistryChange[] = [];
  for (const trailId of Object.keys(after)) {
    const previous = new Map((before[trailId] ?? []).map(e => [e.id, e]));
    for (const entry of after[trailId]) {
      const change = { trailId, id: entry.id, name: entry.name, type: entry.type };
      const old = previous.get(entry.id);
      if (!old) minted.push(change);
      else if (entry.retired && !old.retired) retired.push(change);
    }
  }
  return { minted, retired };
}

export type BuildStream = 'stdout' | 'stderr';

/** One line the build printed, and the stream it printed it on. */
export interface BuildLine {
  stream: BuildStream;
  text: string;
}

/**
 * Whether a line of build output is a warning or an error.
 *
 * The build's convention is the stream, not a marker: every warning and
 * failure goes through `console.warn` / `console.error` (stderr), under
 * several markers and none (`  ⚠ …`, `  ! <trail>: new <type> "…" is within
 * 100 m of …`, `  Warning: …`, `alternate "…": …`, the id-minting summary,
 * a stack trace), and progress goes through `console.log` (stdout). A clean
 * build prints nothing on stderr. So every non-blank stderr line counts, and
 * a stdout line only when it opens with one of the build's markers:
 * `build-trails.ts` prints two `  Warning: …` lines with `console.log`.
 */
export function isWarningLine(stream: BuildStream, text: string): boolean {
  if (text.trim() === '') return false;
  return stream === 'stderr' || /^\s*(?:Warning:|[⚠!✗])\s/.test(text);
}

/** The warning and error lines of a build's output, in the order printed. */
export function warningLines(lines: readonly BuildLine[]): string[] {
  return lines.filter(line => isWarningLine(line.stream, line.text)).map(line => line.text.trimEnd());
}

/** Calls `onLine` with each whole line of a stream delivered in arbitrary chunks; `flush` gives up the last, unterminated one. */
function lineSplitter(onLine: (text: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) onLine(part.replace(/\r$/, ''));
    },
    flush() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

const REBUILD_STEPS = ['build:trails', 'build:mobile-trails'] as const;

/**
 * How to start `npm run <script>`. On Windows npm is `npm.cmd`, which Node
 * starts only through a shell; the command line is then one fixed string (the
 * script names are constants), so nothing variable is ever interpolated.
 */
export function npmRunCommand(
  script: (typeof REBUILD_STEPS)[number],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  return platform === 'win32'
    ? { command: `npm run ${script}`, args: [], shell: true }
    : { command: 'npm', args: ['run', script], shell: false };
}

/** The mark a running rebuild leaves on disk, so that another dev server process sees it. */
export interface RebuildLock {
  /** The dev server that started the rebuild. */
  owner: number;
  /** The `npm run` step that is running. */
  child?: number;
  startedAt: string;
}

/** Outside the repository (nothing to ignore or commit), one per checkout. */
export function rebuildLockPath(root: string): string {
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `tracknotes-waypoint-editor-${key}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The lock, when it marks a rebuild that is still running in another process:
 * another dev server on this checkout, or a build step that outlived the dev
 * server that started it. Null for no lock, one this process wrote, one whose
 * processes are gone, and one too old to be a build.
 */
export function otherRebuild(
  lock: RebuildLock | null,
  self: number,
  alive: (pid: number) => boolean = pidAlive,
  now: number = Date.now()
): RebuildLock | null {
  if (!lock) return null;
  const age = now - Date.parse(lock.startedAt);
  if (!(age < MAX_REBUILD_MS)) return null;
  const ownerRuns = lock.owner !== self && alive(lock.owner);
  const stepRuns = lock.child !== undefined && alive(lock.child);
  return ownerRuns || stepRuns ? lock : null;
}

function readLock(lockPath: string): RebuildLock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as RebuildLock;
    return typeof lock?.owner === 'number' && typeof lock.startedAt === 'string' ? lock : null;
  } catch {
    return null;
  }
}

/** Takes the lock, or returns the other running rebuild that holds it. */
function takeLock(lockPath: string, lock: RebuildLock): RebuildLock | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx' });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const other = otherRebuild(readLock(lockPath), process.pid);
    if (other) return other;
    fs.rmSync(lockPath, { force: true });
  }
  throw new HttpError(`Could not take the rebuild lock ${lockPath}`, 500);
}

function otherRebuildMessage(other: RebuildLock, lockPath: string): string {
  return (
    `Another rebuild of this checkout is running (started ${other.startedAt} by dev server pid ${other.owner}): ` +
    `wait for it to finish. If none is, delete ${lockPath}`
  );
}

/** A rebuild's state: plain data, so that it can outlive the module instance that started it. */
interface RebuildState {
  status: RebuildStatus;
}

const REBUILD_STATES = Symbol.for('tracknotes.waypoint-editor.rebuilds');

/**
 * The checkout's rebuild state, held on `globalThis` rather than in this
 * module or the plugin instance: Vite restarts the dev server in the same
 * process when a config dependency changes, which re-evaluates this module and
 * builds a new plugin. The child processes of a running rebuild are not
 * touched by that (their handlers keep writing to this record), and the new
 * plugin must still see `running`: saves stay refused and no second build
 * starts on top of the first.
 */
function rebuildStateFor(root: string): RebuildState {
  const holder = globalThis as { [REBUILD_STATES]?: Map<string, RebuildState> };
  const states = (holder[REBUILD_STATES] ??= new Map<string, RebuildState>());
  const key = path.resolve(root);
  let state = states.get(key);
  if (!state) {
    state = { status: { state: 'idle', log: '', warnings: [], minted: [], retired: [] } };
    states.set(key, state);
  }
  return state;
}

/**
 * Starts `build:trails` then `build:mobile-trails`, unless a rebuild is
 * already running: this process's (its status is returned) or another
 * process's (409).
 *
 * Nothing stops a running step when the dev server closes. Across a restart
 * the rebuild carries on and reports as usual. When the process exits, a step
 * that is still running is left to finish (a half-written registry is worse
 * than a late one), the next step is not started, and the lock keeps a new dev
 * server from saving or rebuilding until that step is gone.
 */
function startRebuild(state: RebuildState, root: string, registryPath: string): RebuildStatus {
  if (state.status.state === 'running') return state.status;
  const lockPath = rebuildLockPath(root);
  const startedAt = new Date().toISOString();
  const other = takeLock(lockPath, { owner: process.pid, startedAt });
  if (other) throw new HttpError(otherRebuildMessage(other, lockPath), 409);

  const readRegistry = () => JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as WaypointRegistry;
  let before: WaypointRegistry;
  try {
    before = readRegistry();
  } catch (error) {
    fs.rmSync(lockPath, { force: true });
    throw error;
  }
  const status: RebuildStatus = { state: 'running', startedAt, log: '', warnings: [], minted: [], retired: [] };
  state.status = status;

  const append = (text: string) => {
    const log = status.log + text;
    status.log = log.length > LOG_TAIL_CHARS ? log.slice(-LOG_TAIL_CHARS) : log;
  };
  const finish = (finalState: 'succeeded' | 'failed', problem?: string) => {
    if (status.state !== 'running') return;
    if (problem) {
      append(`\n${problem}\n`);
      status.warnings.push(problem);
    }
    try {
      Object.assign(status, registryChanges(before, readRegistry()));
    } catch (error) {
      finalState = 'failed';
      status.warnings.push(`Could not read ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    status.state = finalState;
    status.finishedAt = new Date().toISOString();
    fs.rmSync(lockPath, { force: true });
  };

  const run = (index: number) => {
    if (index === REBUILD_STEPS.length) return finish('succeeded');
    const script = REBUILD_STEPS[index];
    append(`\n$ npm run ${script}\n`);
    const { command, args, shell } = npmRunCommand(script);
    const child = spawn(command, args, { cwd: root, env: process.env, shell });
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ owner: process.pid, child: child.pid, startedAt }));
    } catch {
      // the lock still names this process, which is enough while it lives
    }
    // Warnings are picked out line by line as they arrive, from the whole
    // output: the log below keeps only its tail.
    const splitters = (['stdout', 'stderr'] as const).map(stream => {
      const splitter = lineSplitter(text => {
        if (isWarningLine(stream, text)) status.warnings.push(text.trimEnd());
      });
      child[stream].setEncoding('utf-8');
      child[stream].on('data', (chunk: string) => {
        append(chunk);
        splitter.push(chunk);
      });
      return splitter;
    });
    child.on('error', error => finish('failed', `npm run ${script} could not start: ${error.message}`));
    child.on('close', code => {
      for (const splitter of splitters) splitter.flush();
      if (code === 0) run(index + 1);
      else finish('failed', `npm run ${script} exited with ${code ?? 'a signal'}`);
    });
  };
  run(0);
  return status;
}

function gitChanges(root: string): Promise<ChangedFile[]> {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain', '--', 'data', 'mobile/assets/trails'], { cwd: root }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split('\n')
          .filter(Boolean)
          .map(line => ({ status: line.slice(0, 2), path: line.slice(3) }))
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function waypointEditorPlugin(root: string): Plugin {
  const rebuild = rebuildStateFor(root);
  const lockPath = rebuildLockPath(root);

  /** A rebuild in another process (another dev server, or a step that outlived one). */
  const rebuildElsewhere = () =>
    rebuild.status.state === 'running' ? null : otherRebuild(readLock(lockPath), process.pid);
  /** Called with no `await` between it and the write it guards: no write starts once a rebuild has begun. */
  const refuseDuringRebuild = () => {
    if (rebuild.status.state === 'running') {
      throw new HttpError('A rebuild is running: save when it has finished', 409);
    }
    const other = rebuildElsewhere();
    if (other) throw new HttpError(otherRebuildMessage(other, lockPath), 409);
  };

  // The editor's modules, through Vite's SSR loader (see the file comment).
  // One DEM source per loaded `elevation.ts`: it caches the tiles it has read.
  const moduleUrl = (file: string) =>
    `/@fs/${path.join(root, 'scripts', 'lib', 'waypoint-editor', file).replace(/\\/g, '/').replace(/^\//, '')}`;
  let demFor: { module: ElevationModule; dem: DemSource } | undefined;
  const loadEditor = async (server: ViteDevServer) => {
    const [api, elevation] = (await Promise.all([
      server.ssrLoadModule(moduleUrl('trail-state.ts')),
      server.ssrLoadModule(moduleUrl('elevation.ts')),
    ])) as [TrailStateModule, ElevationModule];
    if (demFor?.module !== elevation) demFor = { module: elevation, dem: elevation.copernicusDemSource() };
    return { api, paths: api.editorPaths(root), dem: demFor.dem };
  };

  const handle = async (
    server: ViteDevServer,
    req: IncomingMessage,
    res: ServerResponse,
    route: string
  ): Promise<void> => {
    const method = req.method ?? 'GET';
    const segments = routeSegments(route);

    if (route === '/rebuild' && method === 'GET') {
      const other = rebuildElsewhere();
      if (!other) return send(res, 200, rebuild.status);
      const elsewhere: RebuildStatus = {
        state: 'running',
        startedAt: other.startedAt,
        log: `${otherRebuildMessage(other, lockPath)}\n`,
        warnings: [],
        minted: [],
        retired: [],
      };
      return send(res, 200, elsewhere);
    }
    if (method === 'GET' && route === '/changes') return send(res, 200, await gitChanges(root));

    const { api, paths, dem } = await loadEditor(server);
    if (route === '/rebuild' && method === 'POST') {
      return send(res, 202, startRebuild(rebuild, root, paths.registryPath));
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'trails') {
      return send(res, 200, api.listTrails(paths));
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'trails') {
      return send(res, 200, api.loadEditorTrail(paths, segments[1]));
    }
    const waypointRoute = segments[0] === 'trails' && segments[2] === 'waypoints';
    if (waypointRoute && (method === 'POST' || method === 'DELETE')) refuseDuringRebuild();
    // Each write below checks again after its last `await` (the body, and for a
    // save the elevation lookup, which can take seconds): a rebuild may have
    // started meanwhile.
    if (method === 'POST' && segments.length === 3 && waypointRoute) {
      const body = requestObject(await readBody(req)) as unknown as NewWaypointRequest;
      const elevation = await api.lookupWaypointElevation(paths, segments[1], body, dem);
      refuseDuringRebuild();
      return send(res, 201, api.addWaypoint(paths, segments[1], body, elevation));
    }
    if (method === 'POST' && segments.length === 4 && waypointRoute) {
      const body = requestObject(await readBody(req), true) as unknown as WaypointEditRequest;
      const elevation = await api.lookupWaypointElevation(paths, segments[1], body, dem);
      refuseDuringRebuild();
      return send(res, 200, api.saveWaypointEdit(paths, segments[1], segments[3], body, elevation));
    }
    if (method === 'DELETE' && segments.length === 4 && waypointRoute) {
      const body = requestObject(await readBody(req), true) as unknown as WaypointDeleteRequest;
      refuseDuringRebuild();
      return send(res, 200, api.deleteWaypoint(paths, segments[1], segments[3], body));
    }
    throw new HttpError(`No route ${method} ${route}`, 404);
  };

  return {
    name: 'waypoint-editor',
    apply: 'serve',
    configureServer(server) {
      const guard: RequestGuardOptions = {
        allowRemote: process.env.WAYPOINT_EDITOR_ALLOW_REMOTE === '1',
        allowedHosts: server.config.server.allowedHosts ?? [],
      };
      server.middlewares.use(EDITOR_API_BASE, (req, res) => {
        const refusal = requestRefusal(
          { method: req.method ?? 'GET', headers: req.headers, remoteAddress: req.socket.remoteAddress },
          guard
        );
        if (refusal) return send(res, 403, { error: refusal });
        const route = (req.url ?? '/').split('?')[0];
        handle(server, req, res, route).catch((error: unknown) => {
          const status = errorStatus(error);
          const message = error instanceof Error ? error.message : String(error);
          if (status >= 500) server.config.logger.error(`[waypoint-editor] ${message}`);
          if (!res.headersSent) send(res, status, { error: message });
        });
      });
    },
  };
}

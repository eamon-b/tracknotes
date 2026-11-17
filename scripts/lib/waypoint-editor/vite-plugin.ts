/**
 * The waypoint editor's API, mounted on the Vite dev server only
 * (`configureServer` never runs in `vite build`, and `admin-waypoints.html` is
 * not a build input), so nothing here reaches the deployed site.
 *
 * It writes the repository's own files, so it answers only:
 *  - requests from this machine (loopback), unless `WAYPOINT_EDITOR_ALLOW_REMOTE=1`;
 *  - writes that carry the `X-Waypoint-Editor` header, from no other origin
 *    (a custom header forces a CORS preflight the dev server does not grant).
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
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';
import type {
  ChangedFile,
  NewWaypointRequest,
  RebuildStatus,
  RegistryChange,
  WaypointDeleteRequest,
  WaypointEditRequest,
} from './api-types';
import { EDITOR_API_BASE, EDITOR_HEADER } from './api-types';
import {
  addWaypoint,
  deleteWaypoint,
  EditorError,
  editorPaths,
  listTrails,
  loadEditorTrail,
  saveWaypointEdit,
  type EditorPaths,
} from './trail-state';
import type { WaypointRegistry } from '../waypoint-ids';

const MAX_BODY_BYTES = 64 * 1024;
const LOG_TAIL_CHARS = 20_000;

function isLoopback(address: string | undefined): boolean {
  return !!address && (address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new EditorError('Request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new EditorError('Request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Whether a write comes from the editor page itself. */
export function writeAllowed(headers: IncomingMessage['headers']): boolean {
  if (headers[EDITOR_HEADER.toLowerCase()] !== '1') return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
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

function warningLines(log: string): string[] {
  return log
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => /⚠|warn|error|failed/i.test(line));
}

class RebuildJob {
  status: RebuildStatus = { state: 'idle', log: '', warnings: [], minted: [], retired: [] };

  constructor(private readonly paths: EditorPaths) {}

  start(): RebuildStatus {
    if (this.status.state === 'running') return this.status;
    const before = JSON.parse(fs.readFileSync(this.paths.registryPath, 'utf-8')) as WaypointRegistry;
    this.status = {
      state: 'running',
      startedAt: new Date().toISOString(),
      log: '',
      warnings: [],
      minted: [],
      retired: [],
    };
    const append = (text: string) => {
      const log = this.status.log + text;
      this.status.log = log.length > LOG_TAIL_CHARS ? log.slice(-LOG_TAIL_CHARS) : log;
    };
    let fullLog = '';
    const steps = ['build:trails', 'build:mobile-trails'];
    const run = (index: number) => {
      if (index === steps.length) {
        const after = JSON.parse(fs.readFileSync(this.paths.registryPath, 'utf-8')) as WaypointRegistry;
        this.finish('succeeded', fullLog, registryChanges(before, after));
        return;
      }
      append(`\n$ npm run ${steps[index]}\n`);
      const child = spawn('npm', ['run', steps[index]], { cwd: this.paths.root, env: process.env });
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        fullLog += text;
        append(text);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', error => this.finish('failed', `${fullLog}\n${error.message}`));
      child.on('close', code => {
        if (code === 0) run(index + 1);
        else {
          const after = JSON.parse(fs.readFileSync(this.paths.registryPath, 'utf-8')) as WaypointRegistry;
          this.finish(
            'failed',
            `${fullLog}\nnpm run ${steps[index]} exited with ${code}`,
            registryChanges(before, after)
          );
        }
      });
    };
    run(0);
    return this.status;
  }

  private finish(
    state: 'succeeded' | 'failed',
    fullLog: string,
    changes: { minted: RegistryChange[]; retired: RegistryChange[] } = { minted: [], retired: [] }
  ): void {
    this.status = {
      ...this.status,
      state,
      finishedAt: new Date().toISOString(),
      warnings: warningLines(fullLog),
      ...changes,
    };
  }
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
  const paths = editorPaths(root);
  const rebuild = new RebuildJob(paths);

  const handle = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && !writeAllowed(req.headers)) {
      throw new EditorError('Writes are accepted only from the editor page', 403);
    }
    const segments = route.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'GET' && segments.length === 1 && segments[0] === 'trails') {
      return send(res, 200, listTrails(paths));
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'trails') {
      return send(res, 200, loadEditorTrail(paths, segments[1]));
    }
    const waypointRoute = segments[0] === 'trails' && segments[2] === 'waypoints';
    if (waypointRoute && (method === 'POST' || method === 'DELETE') && rebuild.status.state === 'running') {
      throw new EditorError('A rebuild is running: save when it has finished', 409);
    }
    if (method === 'POST' && segments.length === 3 && waypointRoute) {
      const body = (await readBody(req)) as NewWaypointRequest;
      return send(res, 201, addWaypoint(paths, segments[1], body));
    }
    if (method === 'POST' && segments.length === 4 && waypointRoute) {
      const body = (await readBody(req)) as WaypointEditRequest;
      return send(res, 200, saveWaypointEdit(paths, segments[1], segments[3], body));
    }
    if (method === 'DELETE' && segments.length === 4 && waypointRoute) {
      const body = (await readBody(req)) as WaypointDeleteRequest;
      return send(res, 200, deleteWaypoint(paths, segments[1], segments[3], body));
    }
    if (method === 'GET' && route === '/changes') return send(res, 200, await gitChanges(root));
    if (route === '/rebuild') {
      if (method === 'POST') return send(res, 202, rebuild.start());
      if (method === 'GET') return send(res, 200, rebuild.status);
    }
    throw new EditorError(`No route ${method} ${route}`, 404);
  };

  return {
    name: 'waypoint-editor',
    apply: 'serve',
    configureServer(server) {
      const allowRemote = process.env.WAYPOINT_EDITOR_ALLOW_REMOTE === '1';
      server.middlewares.use(EDITOR_API_BASE, (req, res) => {
        if (!allowRemote && !isLoopback(req.socket.remoteAddress)) {
          return send(res, 403, { error: 'The waypoint editor answers only this machine' });
        }
        const route = (req.url ?? '/').split('?')[0];
        handle(req, res, route).catch((error: unknown) => {
          const status = error instanceof EditorError ? error.status : 500;
          const message = error instanceof Error ? error.message : String(error);
          if (status >= 500) server.config.logger.error(`[waypoint-editor] ${message}`);
          send(res, status, { error: message });
        });
      });
    },
  };
}

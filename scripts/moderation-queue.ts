/**
 * How many reported or flagged posts are waiting for an admin, for the daily
 * Moderation queue workflow, which fails while the count is above zero (the
 * failed-run email is the alert). It reads the comments API's counts-only route
 * (`GET /v1/admin/moderation/counts`), which counts the rows the moderation page
 * highlights (`needsAttention`, `@lib/moderation-attention`), with its own
 * read-only credential, `MODERATION_COUNTS_TOKEN`: that token opens that one
 * route and nothing else, and no post text, name or report reaches the runner.
 * The decisions stay on the page: this prints counts only, since the run's
 * summary is public, and an error names only the route and status.
 *
 * Usage: TRACKNOTES_MODERATION_COUNTS_TOKEN=... node scripts/moderation-queue.ts
 * Runs on Node's own type stripping (Node 22.18+), with no `npm ci`: it imports
 * only Node built-ins and `src/lib` types, so no installed package runs while
 * the token is in the environment.
 * Env: TRACKNOTES_API_BASE_URL (default https://api.tracknotes.info);
 * GITHUB_OUTPUT, when set, gets `count=<n>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ModerationCountsResponse, ModerationQueueCounts } from '../src/lib/comments-api-types.ts';

const DEFAULT_API_BASE = 'https://api.tracknotes.info';
const MODERATION_PAGE = 'https://tracknotes.info/admin-moderation.html';
const COUNTS_ROUTE = '/v1/admin/moderation/counts';

export type QueueSummary = ModerationCountsResponse;

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** The counts route's answer, checked, or an error that names nothing from the body. */
export function parseCounts(body: unknown): QueueSummary {
  const table = (v: unknown): ModerationQueueCounts | null => {
    if (v === null || typeof v !== 'object') return null;
    const { waiting, hidden } = v as Record<string, unknown>;
    return isCount(waiting) && isCount(hidden) && hidden <= waiting ? { waiting, hidden } : null;
  };
  const o = (body ?? {}) as Record<string, unknown>;
  const comments = table(o.comments);
  const waypoints = table(o.waypoints);
  if (!comments || !waypoints || o.total !== comments.waiting + waypoints.waiting) {
    throw new Error(`GET ${COUNTS_ROUTE} answered an unexpected body`);
  }
  return { comments, waypoints, total: o.total };
}

/** The run summary for a queue. */
export function queueMarkdown(summary: QueueSummary): string {
  const line = (label: string, n: { waiting: number; hidden: number }) =>
    `- ${label}: ${n.waiting} waiting${n.hidden > 0 ? ` (${n.hidden} hidden by reports until someone decides)` : ''}`;
  return [
    summary.total === 0
      ? 'Nothing is waiting for moderation.'
      : `${summary.total} reported or flagged post(s) are waiting for an admin.`,
    '',
    line('Comments', summary.comments),
    line('Shared waypoints', summary.waypoints),
    '',
    `Decide them on ${MODERATION_PAGE} (Restore or Keep, Delete, Ban).`,
  ].join('\n');
}

async function main(): Promise<void> {
  const token = process.env.TRACKNOTES_MODERATION_COUNTS_TOKEN;
  if (!token) throw new Error('TRACKNOTES_MODERATION_COUNTS_TOKEN is not set');
  const base = (process.env.TRACKNOTES_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '');
  const response = await fetch(`${base}${COUNTS_ROUTE}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GET ${COUNTS_ROUTE} answered ${response.status}`);
  const summary = parseCounts(await response.json().catch(() => null));
  console.log(queueMarkdown(summary));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${summary.total}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`moderation-queue failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

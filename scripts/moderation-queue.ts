/**
 * How many reported or flagged posts are waiting for an admin, for the daily
 * Moderation queue workflow, which fails while the count is above zero (the
 * failed-run email is the alert). It reads the moderation page's own listings
 * (`GET /v1/admin/comments?reported=1`, `GET /v1/admin/waypoints`) and counts
 * the rows that page highlights (`needsAttention`, `@lib/moderation-attention`).
 * The decisions stay on the page: this prints counts only, never post text or
 * user names, since the run's summary is public.
 *
 * Usage: TRACKNOTES_ADMIN_TOKEN=... npx tsx scripts/moderation-queue.ts
 * Env: TRACKNOTES_API_BASE_URL (default https://api.tracknotes.info);
 * GITHUB_OUTPUT, when set, gets `count=<n>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AdminCommentsResponse, AdminSharedWaypointsResponse } from '../src/lib/comments-api-types.js';
import { needsAttention, type ModeratedRow } from '../src/lib/moderation-attention.js';

const DEFAULT_API_BASE = 'https://api.tracknotes.info';
const MODERATION_PAGE = 'https://tracknotes.info/admin-moderation.html';
const LIMIT = 500;

export interface QueueSummary {
  comments: { waiting: number; hidden: number };
  waypoints: { waiting: number; hidden: number };
  total: number;
}

/** The rows waiting for an admin, and how many of them reports have hidden. */
export function summarizeQueue(comments: readonly ModeratedRow[], waypoints: readonly ModeratedRow[]): QueueSummary {
  const count = (rows: readonly ModeratedRow[]) => {
    const waiting = rows.filter(needsAttention);
    return { waiting: waiting.length, hidden: waiting.filter(r => r.deletedBy === 'reports').length };
  };
  const c = count(comments);
  const w = count(waypoints);
  return { comments: c, waypoints: w, total: c.waiting + w.waiting };
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

async function get<T>(base: string, token: string, route: string): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GET ${route} answered ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const token = process.env.TRACKNOTES_ADMIN_TOKEN;
  if (!token) throw new Error('TRACKNOTES_ADMIN_TOKEN is not set');
  const base = (process.env.TRACKNOTES_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '');
  const [comments, waypoints] = await Promise.all([
    get<AdminCommentsResponse>(base, token, `/v1/admin/comments?reported=1&limit=${LIMIT}`),
    get<AdminSharedWaypointsResponse>(base, token, `/v1/admin/waypoints?limit=${LIMIT}`),
  ]);
  const summary = summarizeQueue(comments.comments, waypoints.waypoints);
  console.log(queueMarkdown(summary));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${summary.total}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`moderation-queue failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

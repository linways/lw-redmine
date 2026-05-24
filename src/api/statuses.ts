/**
 * Issue statuses (`/issue_statuses.json`).
 *
 * Used by command verbs that accept a status name and need to resolve it
 * to an id, and by `lwr issue close` to find the first terminal status.
 *
 * The Redmine response shape:
 *   { issue_statuses: [{ id, name, is_closed }, ...] }
 */

import { ERROR_CODES, EXIT, REDMINE_PATHS } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import {
  readStatusesCache,
  statusesCacheFresh,
  writeStatusesCache,
} from '../foundation/cache';
import { LwrError } from '../foundation/errors';
import type { IssueAllowedStatus, RedmineIssue } from './types';

export interface RedmineIssueStatus {
  id: number;
  name: string;
  is_closed?: boolean;
}

export interface ListStatusesOptions {
  /** Bypass the cache and fetch live. Default: false. */
  noCache?: boolean;
}

/**
 * Cache-first: returns cached statuses if fresh, otherwise fetches and
 * writes back. The instance status dictionary changes rarely — TTL is
 * one day.
 */
export async function listStatuses(
  client: RedmineClient,
  opts: ListStatusesOptions = {},
): Promise<RedmineIssueStatus[]> {
  if (!opts.noCache && statusesCacheFresh()) {
    const cached = readStatusesCache();
    if (cached) return cached.data.statuses;
  }
  const fresh = await http(async () => {
    const res = await client.get<{ issue_statuses: RedmineIssueStatus[] }>(REDMINE_PATHS.STATUSES);
    return res.data.issue_statuses;
  });
  try {
    writeStatusesCache(fresh);
  } catch {
    // Cache write is best-effort — never block a successful API call on disk.
  }
  return fresh;
}

/**
 * Resolve a name OR numeric-id-as-string to a status id. Names match
 * case-insensitively. Throws if no status matches.
 */
export function resolveStatusId(statuses: RedmineIssueStatus[], input: string | number): number {
  const s = String(input).trim();
  // Numeric id passthrough.
  if (/^\d+$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  const match = statuses.find(st => st.name.toLowerCase() === lower);
  if (!match) {
    const names = statuses.map(st => st.name).join(', ');
    throw new Error(`Unknown status "${input}". Available: ${names}.`);
  }
  return match.id;
}

/**
 * Preflight check: enforce the current user's allowed_statuses for an
 * issue before sending a transition. Returns silently if the target is in
 * the allowed list, throws WORKFLOW_NOT_ALLOWED otherwise. The thrown
 * error carries `details.allowed` so agents can pick a valid status.
 *
 * If the issue has no `allowed_statuses` field (older Redmine, missing
 * include), this is a no-op — we'd rather let the request through than
 * block on absent data.
 */
export function assertTransitionAllowed(
  issue: Pick<RedmineIssue, 'id' | 'status' | 'allowed_statuses'>,
  targetStatusId: number,
): void {
  const allowed = issue.allowed_statuses;
  if (!Array.isArray(allowed)) return; // not present → can't enforce, defer to server
  if (allowed.some(s => s.id === targetStatusId)) return;

  // Same id? (caller might pass the current status by mistake — Redmine
  // would 422 "is invalid" or silently accept.) Treat as no-op.
  if (issue.status.id === targetStatusId) return;

  const allowedRows = allowed.map((s: IssueAllowedStatus) => ({
    id: s.id,
    name: s.name,
    is_closed: Boolean(s.is_closed),
  }));
  const names = allowedRows.map(a => `"${a.name}" (${a.id})`).join(', ');
  throw new LwrError({
    message: `Status ${targetStatusId} is not an allowed transition from "${issue.status.name}".`,
    code: ERROR_CODES.WORKFLOW_NOT_ALLOWED,
    exit: EXIT.VALIDATION,
    hint: allowedRows.length > 0
      ? `Allowed transitions: ${names}. Run \`lwr issue transitions ${issue.id}\` for the structured list.`
      : `No transitions are allowed for the current user on this issue (workflow / role permissions). Run \`lwr issue transitions ${issue.id}\` to confirm.`,
    details: {
      issueId: issue.id,
      currentStatus: { id: issue.status.id, name: issue.status.name },
      requestedStatusId: targetStatusId,
      allowed: allowedRows,
    },
  });
}

/** First status with is_closed=true; falls back to a name heuristic. */
export function firstClosedStatus(statuses: RedmineIssueStatus[]): RedmineIssueStatus | undefined {
  return (
    statuses.find(s => s.is_closed === true) ??
    statuses.find(s => /closed/i.test(s.name))
  );
}

/**
 * Time entries (`/time_entries.json`).
 *
 * The Redmine resource that powers issue `spent_hours`. The aggregate is
 * computed server-side on every read of an issue, so any time we POST a
 * new entry against an issue, the next `lwr issue view <id>` reflects it.
 *
 * Note on "issue vs project": Redmine accepts either `issue_id` OR
 * `project_id` on POST; if you pass `issue_id` the project is inferred.
 * We default to issue-mode because that's what every CLI entry point
 * needs (every `lwr time log` is anchored to an issue).
 */

import { REDMINE_PATHS, MAX_PAGE_SIZE } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import { roundHours } from '../foundation/numbers';
import type { RedmineTimeEntry, TimeEntriesPage } from './types';

/**
 * Round float-precision noise on `hours`. Same rationale as
 * `normaliseIssue` in api/issues.ts.
 */
function normaliseTimeEntry(entry: RedmineTimeEntry): RedmineTimeEntry {
  if (entry.hours !== undefined) entry.hours = roundHours(entry.hours) ?? entry.hours;
  return entry;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListTimeEntriesOptions {
  /** Restrict to one issue. */
  issueId?: number | string;
  /** Restrict to one project (id or identifier). Ignored when `issueId` is set. */
  projectId?: number | string;
  /** Restrict to one user; `me` for the current user. */
  userId?: number | 'me';
  /** Restrict to one activity. */
  activityId?: number;
  /** Spent-on lower bound (YYYY-MM-DD inclusive). */
  spentOnFrom?: string;
  /** Spent-on upper bound (YYYY-MM-DD inclusive). */
  spentOnTo?: string;
  /** Sort spec, e.g. `spent_on:desc`. */
  sort?: string;
  /** 0-based offset. */
  offset?: number;
  /** Page size. Capped at MAX_PAGE_SIZE. */
  limit?: number;
  /** Fetch every page. */
  all?: boolean;
}

export async function listTimeEntries(
  client: RedmineClient,
  opts: ListTimeEntriesOptions = {},
): Promise<{ entries: RedmineTimeEntry[]; total: number }> {
  const params = buildListParams(opts);

  if (opts.all) {
    const all: RedmineTimeEntry[] = [];
    let offset = 0;
    const limit = MAX_PAGE_SIZE;
    let total = 0;
    while (true) {
      const page = await fetchPage(client, { ...params, offset, limit });
      all.push(...page.time_entries);
      total = page.total_count;
      offset += page.time_entries.length;
      if (offset >= total || page.time_entries.length === 0) break;
    }
    return { entries: all, total };
  }

  const page = await fetchPage(client, params);
  return { entries: page.time_entries, total: page.total_count };
}

function buildListParams(opts: ListTimeEntriesOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (opts.issueId !== undefined) p['issue_id'] = opts.issueId;
  else if (opts.projectId !== undefined) p['project_id'] = opts.projectId;
  if (opts.userId !== undefined) p['user_id'] = opts.userId;
  if (opts.activityId !== undefined) p['activity_id'] = opts.activityId;
  // Redmine accepts a `from`/`to` filter on the date dimension.
  if (opts.spentOnFrom !== undefined) p['from'] = opts.spentOnFrom;
  if (opts.spentOnTo !== undefined) p['to'] = opts.spentOnTo;
  if (opts.sort) p['sort'] = opts.sort;
  if (opts.offset !== undefined) p['offset'] = opts.offset;
  if (opts.limit !== undefined) p['limit'] = opts.limit;
  return p;
}

async function fetchPage(
  client: RedmineClient,
  params: Record<string, unknown>,
): Promise<TimeEntriesPage> {
  return http(async () => {
    const res = await client.get<TimeEntriesPage>(REDMINE_PATHS.TIME_ENTRIES, { params });
    res.data.time_entries.forEach(normaliseTimeEntry);
    return res.data;
  });
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getTimeEntry(
  client: RedmineClient,
  id: number | string,
): Promise<RedmineTimeEntry> {
  return http(async () => {
    const res = await client.get<{ time_entry: RedmineTimeEntry }>(REDMINE_PATHS.TIME_ENTRY_BY_ID(id));
    return normaliseTimeEntry(res.data.time_entry);
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateTimeEntryInput {
  /** Either issue or project must be provided. */
  issueId?: number;
  /** Required if `issueId` is omitted. */
  projectId?: number | string;
  hours: number;
  activityId: number;
  /** YYYY-MM-DD; defaults server-side to today when omitted. */
  spentOn?: string;
  comments?: string;
  /** Override the user the entry is logged against (admin only). */
  userId?: number;
  customFields?: { id: number; value: string | number | boolean | string[] }[];
}

export async function createTimeEntry(
  client: RedmineClient,
  input: CreateTimeEntryInput,
): Promise<RedmineTimeEntry> {
  if (input.issueId === undefined && input.projectId === undefined) {
    throw new Error('createTimeEntry: pass either issueId or projectId.');
  }
  const body = { time_entry: toTimeEntryCreateBody(input) };
  return http(async () => {
    const res = await client.post<{ time_entry: RedmineTimeEntry }>(REDMINE_PATHS.TIME_ENTRIES, body);
    return normaliseTimeEntry(res.data.time_entry);
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateTimeEntryInput {
  hours?: number;
  activityId?: number;
  spentOn?: string;
  comments?: string;
  issueId?: number;
  projectId?: number | string;
  customFields?: { id: number; value: string | number | boolean | string[] }[];
}

export async function updateTimeEntry(
  client: RedmineClient,
  id: number | string,
  input: UpdateTimeEntryInput,
): Promise<RedmineTimeEntry> {
  const body = { time_entry: toTimeEntryUpdateBody(input) };
  await http(async () => {
    await client.put(REDMINE_PATHS.TIME_ENTRY_BY_ID(id), body);
  });
  // Redmine returns 204; re-fetch for a consistent return shape.
  return getTimeEntry(client, id);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteTimeEntry(
  client: RedmineClient,
  id: number | string,
): Promise<void> {
  await http(async () => {
    await client.delete(REDMINE_PATHS.TIME_ENTRY_BY_ID(id));
  });
}

// ---------------------------------------------------------------------------
// Payload mapping (exported for dry-run preview parity)
// ---------------------------------------------------------------------------
//
// Same drift-proof pattern as `api/issues.ts`: typed maps mean adding a
// field to the input interfaces without an entry here is a compile error.
// The dry-run preview path in `commands/time/edit.ts` calls these helpers,
// so the previewed body is byte-identical to what the real PUT will send.

const CREATE_TIME_ENTRY_FIELDS: Record<Exclude<keyof CreateTimeEntryInput, 'customFields'>, string> = {
  issueId: 'issue_id',
  projectId: 'project_id',
  hours: 'hours',
  activityId: 'activity_id',
  spentOn: 'spent_on',
  comments: 'comments',
  userId: 'user_id',
};

const UPDATE_TIME_ENTRY_FIELDS: Record<Exclude<keyof UpdateTimeEntryInput, 'customFields'>, string> = {
  hours: 'hours',
  activityId: 'activity_id',
  spentOn: 'spent_on',
  comments: 'comments',
  issueId: 'issue_id',
  projectId: 'project_id',
};

export function toTimeEntryCreateBody(input: CreateTimeEntryInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(CREATE_TIME_ENTRY_FIELDS) as (keyof typeof CREATE_TIME_ENTRY_FIELDS)[]) {
    const v = input[k];
    if (v !== undefined) out[CREATE_TIME_ENTRY_FIELDS[k]] = v;
  }
  if (input.customFields && input.customFields.length > 0) {
    out.custom_fields = input.customFields.map(cf => ({ id: cf.id, value: cf.value }));
  }
  return out;
}

export function toTimeEntryUpdateBody(input: UpdateTimeEntryInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(UPDATE_TIME_ENTRY_FIELDS) as (keyof typeof UPDATE_TIME_ENTRY_FIELDS)[]) {
    const v = input[k];
    if (v !== undefined) out[UPDATE_TIME_ENTRY_FIELDS[k]] = v;
  }
  if (input.customFields && input.customFields.length > 0) {
    out.custom_fields = input.customFields.map(cf => ({ id: cf.id, value: cf.value }));
  }
  return out;
}

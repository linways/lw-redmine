/**
 * Issues resource.
 *
 * Read paths return parsed JSON straight from Redmine. Write paths accept
 * a typed payload and return the freshly fetched issue (Redmine returns
 * the resource for create + 204 for update; we re-fetch on update for
 * consistent return shape).
 */

import { REDMINE_PATHS, REDMINE_PARAMS, MAX_PAGE_SIZE, REDMINE_UPLOAD_CONTENT_TYPE } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import { recordCustomFields } from '../foundation/cache';
import { roundHours } from '../foundation/numbers';
import type { IssuesPage, RedmineIssue } from './types';

/**
 * Normalise float-precision noise on hour fields. Redmine's float64
 * storage means a stored 2.5 sometimes round-trips as 2.500000023841858;
 * we round at the api boundary so the JSON contract stays clean.
 *
 * Mutates in-place — issues live briefly inside this module's callers,
 * so the cost of an in-place edit is preferable to allocating a new
 * object per row.
 */
function normaliseIssue(issue: RedmineIssue): RedmineIssue {
  if (issue.estimated_hours !== undefined) issue.estimated_hours = roundHours(issue.estimated_hours) ?? undefined;
  if (issue.spent_hours !== undefined) issue.spent_hours = roundHours(issue.spent_hours) ?? undefined;
  // Redmine also returns `total_estimated_hours` / `total_spent_hours` for
  // parent issues; not in our type, but worth rounding if present.
  const extras = issue as unknown as { total_estimated_hours?: number; total_spent_hours?: number };
  if (extras.total_estimated_hours !== undefined) extras.total_estimated_hours = roundHours(extras.total_estimated_hours) ?? undefined;
  if (extras.total_spent_hours !== undefined) extras.total_spent_hours = roundHours(extras.total_spent_hours) ?? undefined;
  // Piggyback: every issue payload Redmine returns can carry the cf
  // catalog inline. Update the opportunistic name↔id map so the agent
  // can call `--cf "Tester=…"` without ever needing /custom_fields.json
  // (admin-only on most installs).
  if (issue.custom_fields && issue.custom_fields.length > 0) {
    recordCustomFields(issue.custom_fields);
  }
  return issue;
}

export interface ListIssuesOptions {
  /** Project id or identifier (slug). */
  projectId?: number | string;
  /** Status id. Use the special value `*` for any (Redmine convention). */
  statusId?: number | string;
  /** Tracker id. */
  trackerId?: number;
  /** Priority id. */
  priorityId?: number;
  /**
   * Filter to a specific Redmine version (sprint/release). The CLI's
   * `--version <id-or-name>` flag resolves names to ids via the project's
   * versions list before passing it here.
   */
  fixedVersionId?: number;
  /** Assignee. Use 'me' to mean the current user (Redmine convention). */
  assignedTo?: number | 'me';
  /** Author. Use 'me' to mean the current user. */
  author?: number | 'me';
  /** Free-text "subject" filter. */
  subject?: string;
  /** Sort spec, e.g. `priority:desc,id:desc`. */
  sort?: string;
  /** 0-based offset. */
  offset?: number;
  /** Page size. Capped at MAX_PAGE_SIZE. */
  limit?: number;
  /** Fetch every page. */
  all?: boolean;
  /**
   * Optional `include` keys passed to Redmine. The list endpoint omits
   * `custom_fields`, `attachments`, etc. unless explicitly requested,
   * and join responses are slower — only ask for what the caller needs.
   * Examples: `['custom_fields']`, `['attachments','relations']`.
   */
  include?: string[];
  /**
   * Custom-field filters. Keys are Redmine custom_field ids, values are
   * the filter value. Each entry becomes `cf_<id>=<value>` in the URL.
   * Used by the `--as <role>` lens (which resolves the cf id from
   * `profile.me.fieldMap`) and by the generic `--cf <id>=<value>` flag.
   *
   * Example: `{ 79: 57 }` sends `cf_79=57` (issues where Developer cf = 57).
   */
  customFieldFilters?: Record<number, number | string>;
}

export async function listIssues(
  client: RedmineClient,
  opts: ListIssuesOptions = {},
): Promise<{ issues: RedmineIssue[]; total: number }> {
  const params = buildListParams(opts);

  if (opts.all) {
    const all: RedmineIssue[] = [];
    let offset = 0;
    const limit = MAX_PAGE_SIZE;
    let total = 0;
    while (true) {
      const page = await fetchPage(client, { ...params, offset, limit });
      all.push(...page.issues);
      total = page.total_count;
      offset += page.issues.length;
      if (offset >= total || page.issues.length === 0) break;
    }
    return { issues: all, total };
  }

  const page = await fetchPage(client, params);
  return { issues: page.issues, total: page.total_count };
}

function buildListParams(opts: ListIssuesOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (opts.projectId !== undefined) p['project_id'] = opts.projectId;
  if (opts.statusId !== undefined) p['status_id'] = opts.statusId;
  if (opts.trackerId !== undefined) p['tracker_id'] = opts.trackerId;
  if (opts.priorityId !== undefined) p['priority_id'] = opts.priorityId;
  if (opts.fixedVersionId !== undefined) p['fixed_version_id'] = opts.fixedVersionId;
  if (opts.assignedTo !== undefined) p['assigned_to_id'] = opts.assignedTo;
  if (opts.author !== undefined) p['author_id'] = opts.author;
  if (opts.subject !== undefined) p['subject'] = `~${opts.subject}`;
  if (opts.sort) p['sort'] = opts.sort;
  if (opts.offset !== undefined) p['offset'] = opts.offset;
  if (opts.limit !== undefined) p['limit'] = opts.limit;
  if (opts.include && opts.include.length > 0) p['include'] = opts.include.join(',');
  if (opts.customFieldFilters) {
    for (const [cfId, value] of Object.entries(opts.customFieldFilters)) {
      p[`cf_${cfId}`] = value;
    }
  }
  return p;
}

async function fetchPage(
  client: RedmineClient,
  params: Record<string, unknown>,
): Promise<IssuesPage> {
  return http(async () => {
    const res = await client.get<IssuesPage>(REDMINE_PATHS.ISSUES, { params });
    res.data.issues.forEach(normaliseIssue);
    return res.data;
  });
}

export async function getIssue(
  client: RedmineClient,
  id: number | string,
  opts: { detail?: boolean; allowedStatuses?: boolean } = {},
): Promise<RedmineIssue> {
  return http(async () => {
    const includes: string[] = [];
    if (opts.detail) includes.push(REDMINE_PARAMS.INCLUDE_ISSUE_DETAIL);
    if (opts.allowedStatuses) includes.push('allowed_statuses');
    const params = includes.length ? { include: includes.join(',') } : {};
    const res = await client.get<{ issue: RedmineIssue }>(REDMINE_PATHS.ISSUE_BY_ID(id), { params });
    return normaliseIssue(res.data.issue);
  });
}

export interface CreateIssueInput {
  projectId: number | string;
  subject: string;
  description?: string;
  trackerId?: number;
  statusId?: number;
  priorityId?: number;
  assignedToId?: number;
  parentIssueId?: number;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  doneRatio?: number;
  customFields?: { id: number; value: string | number | boolean | string[] }[];
}

export async function createIssue(
  client: RedmineClient,
  input: CreateIssueInput,
): Promise<RedmineIssue> {
  const body = { issue: toIssueCreateBody(input) };
  return http(async () => {
    const res = await client.post<{ issue: RedmineIssue }>(REDMINE_PATHS.ISSUES, body);
    return normaliseIssue(res.data.issue);
  });
}

export interface UpdateIssueInput {
  subject?: string;
  description?: string;
  trackerId?: number;
  statusId?: number;
  priorityId?: number;
  assignedToId?: number | null;
  parentIssueId?: number | null;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  doneRatio?: number;
  notes?: string;
  privateNotes?: boolean;
  customFields?: { id: number; value: string | number | boolean | string[] }[];
}

export async function updateIssue(
  client: RedmineClient,
  id: number | string,
  input: UpdateIssueInput,
): Promise<RedmineIssue> {
  const body = { issue: toIssueUpdateBody(input) };
  await http(async () => {
    await client.put(REDMINE_PATHS.ISSUE_BY_ID(id), body);
  });
  // Redmine returns 204 No Content; re-fetch for a consistent return shape.
  return getIssue(client, id, { detail: true });
}

export async function addNote(
  client: RedmineClient,
  id: number | string,
  notes: string,
  opts: { privateNotes?: boolean } = {},
): Promise<RedmineIssue> {
  return updateIssue(client, id, { notes, privateNotes: opts.privateNotes });
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

export async function addWatcher(
  client: RedmineClient,
  id: number | string,
  userId: number,
): Promise<void> {
  await http(async () => {
    await client.post(REDMINE_PATHS.ISSUE_WATCHERS(id), { user_id: userId });
  });
}

export async function removeWatcher(
  client: RedmineClient,
  id: number | string,
  userId: number,
): Promise<void> {
  await http(async () => {
    await client.delete(REDMINE_PATHS.ISSUE_WATCHER_BY_ID(id, userId));
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface UploadDescriptor {
  /** Display filename Redmine should record (defaults to basename of localPath). */
  filename: string;
  /** Optional human description for the attachment. */
  description?: string;
  /** Optional content-type override; Redmine guesses from filename otherwise. */
  contentType?: string;
}

/**
 * Upload raw bytes and return Redmine's upload token.
 *
 * Redmine attachments are a two-step flow:
 *   1) POST /uploads.json (octet-stream) → token
 *   2) PUT /issues/<id>.json with `issue.uploads = [{ token, ... }]`
 *
 * Step 1 wants `Content-Type: application/octet-stream`, which our shared
 * axios client doesn't default to. We override per-call.
 */
export async function uploadFile(
  client: RedmineClient,
  bytes: Buffer,
  filename: string,
): Promise<string> {
  return http(async () => {
    const res = await client.post<{ upload: { token: string } }>(
      REDMINE_PATHS.UPLOADS,
      bytes,
      {
        params: { filename },
        headers: { 'Content-Type': REDMINE_UPLOAD_CONTENT_TYPE },
        // Don't let axios try to JSON-encode a Buffer
        transformRequest: [data => data],
      },
    );
    return res.data.upload.token;
  });
}

/**
 * Attach already-uploaded tokens to an issue, optionally with a note.
 *
 * Use this after one or more `uploadFile()` calls; combining them in a
 * single PUT keeps Redmine from creating multiple journal entries.
 */
export async function attachToIssue(
  client: RedmineClient,
  id: number | string,
  uploads: { token: string; filename: string; description?: string; contentType?: string }[],
  note?: { text: string; privateNotes?: boolean },
): Promise<RedmineIssue> {
  const body = {
    issue: {
      uploads: uploads.map(u => ({
        token: u.token,
        filename: u.filename,
        ...(u.description !== undefined ? { description: u.description } : {}),
        ...(u.contentType !== undefined ? { content_type: u.contentType } : {}),
      })),
      ...(note ? { notes: note.text, private_notes: Boolean(note.privateNotes) } : {}),
    },
  };
  await http(async () => {
    await client.put(REDMINE_PATHS.ISSUE_BY_ID(id), body);
  });
  return getIssue(client, id, { detail: true });
}

/**
 * Camel→snake field map for issue *update*. Typed against `keyof
 * UpdateIssueInput` minus `customFields` (which needs an array
 * transformation, not a rename) so adding a field to the type without
 * an entry here is a compile error — there is exactly one source of
 * truth for the wire body, and the dry-run preview goes through it too.
 */
const UPDATE_ISSUE_FIELDS: Record<Exclude<keyof UpdateIssueInput, 'customFields'>, string> = {
  subject: 'subject',
  description: 'description',
  trackerId: 'tracker_id',
  statusId: 'status_id',
  priorityId: 'priority_id',
  assignedToId: 'assigned_to_id',
  parentIssueId: 'parent_issue_id',
  startDate: 'start_date',
  dueDate: 'due_date',
  estimatedHours: 'estimated_hours',
  doneRatio: 'done_ratio',
  notes: 'notes',
  privateNotes: 'private_notes',
};

const CREATE_ISSUE_FIELDS: Record<Exclude<keyof CreateIssueInput, 'customFields'>, string> = {
  projectId: 'project_id',
  subject: 'subject',
  description: 'description',
  trackerId: 'tracker_id',
  statusId: 'status_id',
  priorityId: 'priority_id',
  assignedToId: 'assigned_to_id',
  parentIssueId: 'parent_issue_id',
  startDate: 'start_date',
  dueDate: 'due_date',
  estimatedHours: 'estimated_hours',
  doneRatio: 'done_ratio',
};

/**
 * Build the `{ issue: ... }` PUT body from an UpdateIssueInput. Exported
 * so the dry-run preview path uses byte-for-byte the same shape that
 * `updateIssue` will actually send.
 */
export function toIssueUpdateBody(input: UpdateIssueInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(UPDATE_ISSUE_FIELDS) as (keyof typeof UPDATE_ISSUE_FIELDS)[]) {
    const v = input[k];
    if (v !== undefined) out[UPDATE_ISSUE_FIELDS[k]] = v;
  }
  if (input.customFields && input.customFields.length > 0) {
    out.custom_fields = input.customFields.map(cf => ({ id: cf.id, value: cf.value }));
  }
  return out;
}

/** Symmetric helper for `createIssue`. Same drift-proof typing. */
export function toIssueCreateBody(input: CreateIssueInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(CREATE_ISSUE_FIELDS) as (keyof typeof CREATE_ISSUE_FIELDS)[]) {
    const v = input[k];
    if (v !== undefined) out[CREATE_ISSUE_FIELDS[k]] = v;
  }
  if (input.customFields && input.customFields.length > 0) {
    out.custom_fields = input.customFields.map(cf => ({ id: cf.id, value: cf.value }));
  }
  return out;
}

/**
 * `lwr issue view <id>`
 *
 * Fetch an issue with full detail (journals, attachments, watchers,
 * relations) and render it. Supports `#123` as well as `123`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue } from '../../api/issues';
import { writeLine } from '../../foundation/output';
import { header, dim, statusBadge, priorityBadge, hyperlink } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { readCustomFieldsCatalog, readProjectCache, readStatusesCache } from '../../foundation/cache';
import { DB_SCAN_MAX_CHARS, ERROR_CODES, LWDB_BIN, LWDB_LOOKUP_TIMEOUT_MS } from '../../constants';
import type { IdName, RedmineIssue } from '../../api/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** College DB named in the description, plus its lwdb server when resolvable. */
export interface DetectedDb {
  name: string;
  server: string | null;
}

export type IssueViewJson = RedmineIssue & { detected_db: DetectedDb | null };

export interface IssueViewFlags extends GlobalFlags {
  id?: string | number;
  /** When true, include journals/attachments. Default true. */
  detail?: boolean;
}

const cmd: CommandFn<IssueViewJson> = async (flags): Promise<CommandResult<IssueViewJson>> => {
  const flgs = flags as IssueViewFlags;
  if (flgs.id === undefined || flgs.id === null || flgs.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue view <id>`.',
    );
  }
  const id = normaliseId(flgs.id);

  const session = await openSession(flags);
  const issue = await getIssue(session.client, id, { detail: flgs.detail !== false });
  const dbName = detectDbName(issue.description);
  const detected_db = dbName ? { name: dbName, server: (await findDbServer(dbName)) ?? null } : null;

  return {
    json: { ...issue, detected_db },
    pretty: ctx => renderIssue(ctx, issue, session.baseUrl, detected_db),
  };
};

// Linways descriptions carry the college DB as e.g. `*Database and CHT Instance* -> test_ccm1013`
// or `db : cht_iagi63`. DB names are `<word>_…<digit>…`, which keeps prose like `student_id` out.
// ponytail: regex heuristic over free text; a dedicated cf would make this exact.
const DB_LABEL = /\b(?:database|db)\b[^\n]*?(?:->|:|-)\s*([^\n]*)/gi;
const DB_TOKEN = /\b[a-z][a-z0-9]*_\w*\d\w*\b/i;

export function detectDbName(description: string | undefined): string | undefined {
  if (!description) return undefined;
  // DB_LABEL is O(matches × line length) — quadratic on a long `db db db…` line, and any
  // Redmine user controls the description. The DB line sits at the top of the template.
  const text = description.slice(0, DB_SCAN_MAX_CHARS);
  for (const m of text.matchAll(DB_LABEL)) {
    const t = m[1].match(DB_TOKEN);
    if (t) return t[0];
  }
  return text.match(/\btest_\w+\b/i)?.[0];
}

/** Ask the optional lwdb CLI which server holds `db`. Any failure → undefined. */
async function findDbServer(db: string): Promise<string | undefined> {
  const lwdb = async <T>(args: string[]): Promise<T> =>
    JSON.parse((await execFileAsync(LWDB_BIN, [...args, '--json'], { timeout: LWDB_LOOKUP_TIMEOUT_MS })).stdout) as T;
  try {
    const servers = await lwdb<{ id: string; kind?: string }[]>(['servers']);
    // First server that has it wins; all-miss / all-fail → AggregateError → undefined.
    return await Promise.any(
      servers
        .filter(s => s.kind !== 'local')
        .map(async s => {
          const dbs = await lwdb<{ name: string }[]>(['dbs', s.id, db]);
          if (!dbs.some(d => d.name === db)) throw new Error('miss');
          return s.id;
        }),
    );
  } catch {
    return undefined;
  }
}

/** cf id → name, from the issue itself first, then the observed-cf cache. */
function cfNames(i: RedmineIssue): Map<string, string> {
  const names = new Map<string, string>();
  for (const f of Object.values(readCustomFieldsCatalog()?.fields ?? {})) names.set(String(f.id), f.name);
  for (const f of i.custom_fields ?? []) names.set(String(f.id), f.name);
  return names;
}

/**
 * Journal value id → name, keyed by attr name (`status_id`, …) or `cf`.
 * Built from the issue payload + local caches only — no extra requests.
 * Unknown ids stay raw; known ones render as `278 (Deepak PS)` so a
 * numeric non-user cf that collides with a user id still shows its value.
 */
function valueNames(i: RedmineIssue): Record<string, Map<string, string>> {
  const m = (xs: (IdName | undefined)[]) =>
    new Map(xs.filter((x): x is IdName => !!x).map(x => [String(x.id), x.name]));
  const users = m([
    ...(readProjectCache(i.project.id)?.data.members ?? []),
    ...(i.watchers ?? []),
    ...(i.journals ?? []).map(j => j.user),
    i.author,
    i.assigned_to,
  ]);
  return {
    status_id: m([...(readStatusesCache()?.data.statuses ?? []), i.status]),
    assigned_to_id: users,
    cf: users,
    tracker_id: m([i.tracker]),
    priority_id: m([i.priority]),
    fixed_version_id: m([i.fixed_version]),
    category_id: m([i.category]),
  };
}

function normaliseId(input: string | number): number {
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid issue id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Issue ids are positive integers, optionally prefixed with `#`.',
    );
  }
  return n;
}

function renderIssue(
  ctx: Parameters<typeof header>[0],
  i: RedmineIssue,
  baseUrl: string,
  db: DetectedDb | null,
): void {
  // The `#<id>` token in the header is hyperlinked to its Redmine URL so
  // a ⌘/Ctrl-click jumps straight to the issue. The rest of the header
  // (subject, status, etc.) stays plain text — only the id is the link.
  const idToken = hyperlink(ctx, `${baseUrl}/issues/${i.id}`, `#${i.id}`);
  writeLine(header(ctx, `${idToken}  ${i.subject}`));
  writeLine(
    `  ${dim(ctx, 'project :')} ${i.project.name}    ${dim(ctx, 'tracker :')} ${i.tracker.name}`,
  );
  writeLine(
    `  ${dim(ctx, 'status  :')} ${statusBadge(ctx, i.status.name)}    ${dim(ctx, 'priority:')} ${priorityBadge(ctx, i.priority.name)}`,
  );
  writeLine(
    `  ${dim(ctx, 'assignee:')} ${i.assigned_to?.name ?? '-'}    ${dim(ctx, 'author  :')} ${i.author.name}`,
  );
  if (i.due_date) writeLine(`  ${dim(ctx, 'due     :')} ${i.due_date}`);
  if (i.estimated_hours !== undefined)
    writeLine(`  ${dim(ctx, 'est hrs :')} ${i.estimated_hours}    ${dim(ctx, 'spent :')} ${i.spent_hours ?? 0}`);
  writeLine(`  ${dim(ctx, 'created :')} ${i.created_on}    ${dim(ctx, 'updated :')} ${i.updated_on}`);
  if (db) writeLine(`  ${dim(ctx, 'db      :')} ${db.server ? `${db.name} @ ${db.server}` : db.name}`);

  if (i.description && i.description.trim().length > 0) {
    writeLine('');
    writeLine(header(ctx, 'Description'));
    writeLine(i.description.trim());
  }

  if (i.journals && i.journals.length > 0) {
    writeLine('');
    writeLine(header(ctx, `Journal (${i.journals.length})`));
    const cf = cfNames(i);
    const names = valueNames(i);
    for (const j of i.journals) {
      const meta = `${j.user.name} · ${j.created_on}`;
      writeLine(`  ${dim(ctx, '·')} ${meta}`);
      if (j.notes && j.notes.trim().length > 0) {
        for (const line of j.notes.trim().split('\n')) writeLine(`    ${line}`);
      }
      if (j.details && j.details.length > 0) {
        for (const d of j.details) {
          const label = d.property === 'cf' ? (cf.get(d.name) ?? `cf.${d.name}`) : `${d.property}.${d.name}`;
          const lookup = names[d.property === 'cf' ? 'cf' : d.name];
          const val = (v: string | null) => (v == null ? '-' : lookup?.has(v) ? `${v} (${lookup.get(v)})` : v);
          writeLine(`    ${dim(ctx, `${label}:`)} ${val(d.old_value)} → ${val(d.new_value)}`);
        }
      }
    }
  }

  if (i.attachments && i.attachments.length > 0) {
    writeLine('');
    writeLine(header(ctx, `Attachments (${i.attachments.length})`));
    for (const a of i.attachments) {
      writeLine(`  ${a.id}  ${a.filename}  ${dim(ctx, `(${a.filesize} bytes)`)}`);
    }
  }
}

export function view(flags: IssueViewFlags): Promise<never> {
  return runCommand('issue.view', flags, cmd);
}

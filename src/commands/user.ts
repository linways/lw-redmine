/**
 * `lwr user list / import / resolve`
 *
 * The agent-facing surface for resolving humans to ids. Members are the
 * primary path (issue → project → members); `/users.json` is the fallback
 * for admins; the manual list is the final fallback for permission-locked
 * instances.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { openSession } from '../foundation/session';
import {
  fetchProjectMembers,
  resolveUserId,
  searchUsers,
  type ResolvedUser,
} from '../api/users';
import { resolveProjectRef } from '../api/projects';
import {
  readManualUsers,
  writeManualUsers,
  type ManualUserEntry,
  type ProjectMember,
} from '../foundation/cache';
import { cacheUsersManualPath } from '../foundation/paths';
import { writeLine } from '../foundation/output';
import { renderTable, dim, header, success } from '../foundation/format';
import { LwrError, ValidationError } from '../foundation/errors';
import { ERROR_CODES, EXIT, USER_IMPORT_MAX_BYTES } from '../constants';

// ---------------------------------------------------------------------------
// user list
// ---------------------------------------------------------------------------

export interface UserListFlags extends GlobalFlags {
  /** Project id or identifier — uses memberships (cache-first). */
  project?: string;
  /** Free-text search against /users.json (admin-only) or member names. */
  search?: string;
  noCache?: boolean;
}

interface ListRow {
  id: number;
  login?: string;
  name: string;
  mail?: string;
  roles?: string[];
}
interface ListPayload {
  source: 'project-members' | 'users-search' | 'manual';
  total: number;
  users: ListRow[];
}

const listCmd: CommandFn<ListPayload> = async (flags): Promise<CommandResult<ListPayload>> => {
  const f = flags as UserListFlags;

  if (!f.project && !f.search) {
    // Try the manual list as a zero-arg default — handy on permission-locked
    // instances where neither memberships nor /users.json work.
    const manual = readManualUsers();
    if (manual && manual.users.length > 0) {
      const rows = manual.users.map(toListRowFromManual);
      return {
        json: { source: 'manual', total: rows.length, users: rows },
        pretty: ctx => renderListTable(ctx, rows, 'manual'),
      };
    }
    throw new ValidationError(
      'Pass --project <id> (preferred) or --search <q> (admin-only).',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Or run `lwr user import users.json` once to seed a fallback list.',
    );
  }

  const session = await openSession(flags);

  if (f.project) {
    const projectRef = await resolveProjectRef(session.client, f.project);
    const result = await fetchProjectMembers(session.client, projectRef.id, { noCache: f.noCache });
    const filtered = f.search ? filterMembers(result.members, f.search) : result.members;
    const rows = filtered.map(toListRowFromMember);
    return {
      json: { source: 'project-members', total: rows.length, users: rows },
      pretty: ctx => renderListTable(ctx, rows, 'project-members', `${projectRef.name} (${projectRef.id})`),
    };
  }

  // --search without --project: hit /users.json (admin-only, may 403)
  try {
    const { users } = await searchUsers(session.client, { name: f.search!, status: 1, all: true });
    const rows: ListRow[] = users.map(u => ({
      id: u.id,
      login: u.login,
      name: `${u.firstname ?? ''} ${u.lastname ?? ''}`.trim() || (u.login ?? `user ${u.id}`),
      mail: u.mail,
    }));
    return {
      json: { source: 'users-search', total: rows.length, users: rows },
      pretty: ctx => renderListTable(ctx, rows, 'users-search'),
    };
  } catch (err) {
    if (err instanceof LwrError && err.code === ERROR_CODES.AUTH_FORBIDDEN) {
      throw new LwrError({
        message: 'Cannot search /users.json — endpoint is admin-only on this Redmine.',
        code: ERROR_CODES.AUTH_FORBIDDEN,
        exit: EXIT.AUTH,
        hint: 'Use `--project <id>` to scope to a project, or `lwr user import users.json` to provide a fallback list.',
        cause: err,
      });
    }
    throw err;
  }
};

function filterMembers(members: ProjectMember[], q: string): ProjectMember[] {
  const lower = q.toLowerCase();
  return members.filter(m =>
    m.name.toLowerCase().includes(lower) ||
    (m.login ?? '').toLowerCase().includes(lower),
  );
}

function toListRowFromMember(m: ProjectMember): ListRow {
  return { id: m.id, login: m.login, name: m.name, mail: m.mail, roles: m.roles };
}

function toListRowFromManual(m: ManualUserEntry): ListRow {
  return { id: m.id, login: m.login, name: m.name, mail: m.mail };
}

function renderListTable(
  ctx: import('../foundation/output').OutputContext,
  rows: ListRow[],
  source: ListPayload['source'],
  scope?: string,
): void {
  if (rows.length === 0) {
    writeLine(dim(ctx, '(no users)'));
    return;
  }
  writeLine(
    renderTable(ctx, {
      head: ['ID', 'Login', 'Name', 'Roles'],
      rows: rows.map(r => [r.id, r.login ?? '', r.name, (r.roles ?? []).join(', ')]),
      colWidths: [8, 18, 30, 32],
    }),
  );
  const tag = scope ? `${source} (${scope})` : source;
  writeLine(dim(ctx, `${rows.length} user(s) — source: ${tag}`));
}

export function userList(flags: UserListFlags): Promise<never> {
  return runCommand('user.list', flags, listCmd);
}

// ---------------------------------------------------------------------------
// user import
// ---------------------------------------------------------------------------

export interface UserImportFlags extends GlobalFlags {
  file?: string;
}

interface ImportPayload {
  imported: number;
  path: string;
}

const importCmd: CommandFn<ImportPayload> = async (flags): Promise<CommandResult<ImportPayload>> => {
  const f = flags as UserImportFlags;
  if (!f.file) {
    throw new ValidationError(
      'File path is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr user import <file.json>`. Use `-` for stdin.',
    );
  }

  // Stat-check on-disk inputs *before* reading so we never buffer a
  // multi-GB blob into memory. Stdin can't be stat'd, so we fall back
  // to a post-read length check.
  let raw: string;
  if (f.file === '-') {
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch (cause) {
      throw new ValidationError(
        'Could not read stdin.',
        ERROR_CODES.VALIDATION_BAD_VALUE,
        undefined,
        cause,
      );
    }
    assertWithinUserImportLimit(Buffer.byteLength(raw, 'utf8'));
  } else {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(f.file);
    } catch (cause) {
      throw new ValidationError(
        `Could not read file: ${f.file}`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        undefined,
        cause,
      );
    }
    assertWithinUserImportLimit(stat.size);
    try {
      raw = fs.readFileSync(f.file, 'utf8');
    } catch (cause) {
      throw new ValidationError(
        `Could not read file: ${f.file}`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        undefined,
        cause,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ValidationError(
      'Manual user list must be valid JSON.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Expected an array of {id, name, login?, mail?} or {users:[...]}.',
      cause,
    );
  }

  const users = normaliseUsers(parsed);
  if (users.length === 0) {
    throw new ValidationError(
      'Manual user list is empty after parsing.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Expected an array of {id, name, login?, mail?} or an object with a `users` array.',
    );
  }

  writeManualUsers(users, f.file === '-' ? 'stdin' : f.file);
  const path = cacheUsersManualPath();

  return {
    json: { imported: users.length, path },
    pretty: ctx => writeLine(success(ctx, `Imported ${users.length} user(s) → ${path}`)),
  };
};

/**
 * Throw VALIDATION_BAD_VALUE when an import payload exceeds the hard
 * size cap. Exported so the test suite can verify the boundary
 * without round-tripping a multi-MB fixture.
 */
export function assertWithinUserImportLimit(bytes: number): void {
  if (bytes > USER_IMPORT_MAX_BYTES) {
    throw new ValidationError(
      `Manual user list too large (${bytes} bytes; max ${USER_IMPORT_MAX_BYTES}).`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Trim the input or split it into smaller batches.',
    );
  }
}

function normaliseUsers(parsed: unknown): ManualUserEntry[] {
  // Accept either a top-level array or { users: [...] }.
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { users?: unknown })?.users)
      ? (parsed as { users: unknown[] }).users
      : null;
  if (!arr) return [];

  const out: ManualUserEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'number' ? r.id : Number(r.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const name = typeof r.name === 'string' && r.name.length > 0
      ? r.name
      : (typeof r.firstname === 'string' || typeof r.lastname === 'string')
        ? `${r.firstname ?? ''} ${r.lastname ?? ''}`.trim()
        : '';
    if (!name) continue;
    const login = typeof r.login === 'string' ? r.login : undefined;
    const mail = typeof r.mail === 'string' ? r.mail : undefined;
    out.push({ id, name, login, mail });
  }
  return out;
}

export function userImport(flags: UserImportFlags): Promise<never> {
  return runCommand('user.import', flags, importCmd);
}

// ---------------------------------------------------------------------------
// user resolve
// ---------------------------------------------------------------------------

export interface UserResolveFlags extends GlobalFlags {
  query?: string;
  issue?: string;
  project?: string;
  noCache?: boolean;
}

const resolveCmd: CommandFn<ResolvedUser> = async (flags): Promise<CommandResult<ResolvedUser>> => {
  const f = flags as UserResolveFlags;
  if (!f.query) {
    throw new ValidationError(
      'Query is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr user resolve <name-or-login>`.',
    );
  }
  const session = await openSession(flags);
  const projectAnchor = f.project
    ? (await resolveProjectRef(session.client, f.project)).id
    : undefined;
  const resolved = await resolveUserId(session.client, f.query, {
    issueId: f.issue,
    projectId: projectAnchor,
    noCache: f.noCache,
  });
  return {
    json: resolved,
    pretty: ctx => {
      writeLine(header(ctx, `${resolved.name}${resolved.login ? ` <${resolved.login}>` : ''}`));
      writeLine(`id:     ${resolved.id}`);
      writeLine(dim(ctx, `source: ${resolved.source}`));
    },
  };
};

export function userResolve(flags: UserResolveFlags): Promise<never> {
  return runCommand('user.resolve', flags, resolveCmd);
}

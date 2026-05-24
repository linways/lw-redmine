/**
 * Users resource + name → id resolver.
 *
 * Redmine has two ways to get users:
 *   1. `/users.json[?name=…]` — full directory; usually admin-only.
 *   2. `/projects/<pid>/memberships.json` — per-project; visible to anyone
 *      who can see the project. This is the path agents actually need:
 *      assigning by name → fetch the issue's project members,
 *      match by name/login, get the id.
 *
 * The resolver tries members first (cache-first), falls back to /users.json
 * if accessible, and finally consults a user-supplied manual list. The
 * manual list lets non-admin users on permission-locked instances still
 * resolve names without ever hitting an API that 403s.
 *
 * Example: "assign issue X to <teammate>" → fetch the issue's project
 * members, match by name/login, get the id.
 */

import { ERROR_CODES, EXIT, REDMINE_PATHS, MAX_PAGE_SIZE, CACHE_TTL_MS } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import {
  projectCacheFresh,
  readManualUsers,
  readProjectCache,
  writeProjectCache,
  type ProjectMember,
} from '../foundation/cache';
import { LwrError } from '../foundation/errors';
import { getIssue } from './issues';
import { getProject, listMemberships } from './projects';
import type { RedmineUser, RedmineMembership, UsersPage } from './types';

// --- Bare endpoints --------------------------------------------------------

export async function getCurrentUser(
  client: RedmineClient,
  opts: { include?: ('memberships' | 'groups')[] } = {},
): Promise<RedmineUserWithIncludes> {
  return http(async () => {
    const params: Record<string, unknown> = {};
    if (opts.include && opts.include.length > 0) params.include = opts.include.join(',');
    const res = await client.get<{ user: RedmineUserWithIncludes }>(REDMINE_PATHS.CURRENT_USER, { params });
    return res.data.user;
  });
}

/**
 * `RedmineUser` with the optional `memberships` payload Redmine returns
 * when the request asks for `?include=memberships`. Each membership has
 * a project + the user's role names within it.
 */
export interface RedmineUserWithIncludes extends RedmineUser {
  memberships?: {
    id: number;
    project: { id: number; name: string };
    roles: { id: number; name: string }[];
  }[];
}

export interface SearchUsersOptions {
  /** Free-text name search — Redmine matches login, firstname, lastname, mail. */
  name?: string;
  status?: 1 | 2 | 3; // 1=active 2=registered 3=locked (Redmine convention)
  offset?: number;
  limit?: number;
  all?: boolean;
}

/**
 * Hit `/users.json`. Note: this endpoint is admin-only on most Redmine
 * installs. If your account isn't admin, expect 403 (AUTH_FORBIDDEN).
 * Use the project-membership path for non-admin name resolution.
 */
export async function searchUsers(
  client: RedmineClient,
  opts: SearchUsersOptions = {},
): Promise<{ users: RedmineUser[]; total: number }> {
  const baseParams: Record<string, string | number> = {};
  if (opts.name) baseParams.name = opts.name;
  if (opts.status) baseParams.status = opts.status;

  if (opts.all) {
    const all: RedmineUser[] = [];
    let offset = 0;
    let total = 0;
    while (true) {
      const page = await http(async () => {
        const res = await client.get<UsersPage>(REDMINE_PATHS.USERS, {
          params: { ...baseParams, offset, limit: MAX_PAGE_SIZE },
        });
        return res.data;
      });
      all.push(...page.users);
      total = page.total_count;
      offset += page.users.length;
      if (offset >= total || page.users.length === 0) break;
    }
    return { users: all, total };
  }

  return http(async () => {
    const res = await client.get<UsersPage>(REDMINE_PATHS.USERS, {
      params: { ...baseParams, offset: opts.offset ?? 0, ...(opts.limit ? { limit: opts.limit } : {}) },
    });
    return { users: res.data.users, total: res.data.total_count };
  });
}

// --- Project members (cache-first) ----------------------------------------

export interface FetchProjectMembersOptions {
  noCache?: boolean;
}

/**
 * Result of a cache-first member fetch. `source` and `fetchedAt` let the
 * caller surface staleness to the agent — when a name resolution against
 * a stale cache misses, the error envelope can include this so the agent
 * decides whether to retry with `--no-cache` or trust the miss.
 */
export interface ProjectMembersResult {
  members: ProjectMember[];
  /** Where the data came from this call. */
  source: 'cache' | 'live';
  /** When the data was originally fetched from Redmine. */
  fetchedAt: number;
}

/**
 * Cache-first project members. Pulls all pages on a miss so the cache is
 * complete (membership lists are typically small — tens to low hundreds).
 */
export async function fetchProjectMembers(
  client: RedmineClient,
  projectIdOrIdentifier: number | string,
  opts: FetchProjectMembersOptions = {},
): Promise<ProjectMembersResult> {
  if (!opts.noCache && projectCacheFresh(projectIdOrIdentifier)) {
    const cached = readProjectCache(projectIdOrIdentifier);
    if (cached) return { members: cached.data.members, source: 'cache', fetchedAt: cached.fetchedAt };
  }

  // Resolve the identifier to a numeric id and pull project metadata so
  // the cache key (project id) and the cache contents both end up canonical.
  const project = await getProject(client, projectIdOrIdentifier);
  const { memberships } = await listMemberships(client, project.id, { all: true });
  const members = memberships.map(toProjectMember).filter((m): m is ProjectMember => m !== null);

  try {
    writeProjectCache(project.id, {
      project: { id: project.id, identifier: project.identifier, name: project.name },
      members,
    });
    // Also write under the identifier so lookups by slug hit cache.
    if (typeof projectIdOrIdentifier === 'string' && /^[a-z0-9-]+$/.test(projectIdOrIdentifier)) {
      writeProjectCache(projectIdOrIdentifier, {
        project: { id: project.id, identifier: project.identifier, name: project.name },
        members,
      });
    }
  } catch {
    // Best-effort.
  }
  return { members, source: 'live', fetchedAt: Date.now() };
}

function toProjectMember(m: RedmineMembership): ProjectMember | null {
  if (!m.user) return null; // skip group memberships
  return {
    id: m.user.id,
    name: m.user.name,
    roles: m.roles.map(r => r.name),
  };
}

// --- Resolver --------------------------------------------------------------

export interface ResolveUserOptions {
  /** Anchor scope to this issue's project (preferred path). */
  issueId?: number | string;
  /** Anchor scope to this project explicitly. */
  projectId?: number | string;
  /** Skip cache reads when true. */
  noCache?: boolean;
}

export interface ResolvedUser {
  id: number;
  name: string;
  login?: string;
  source: 'numeric' | 'me' | 'none' | 'project-members' | 'users-search' | 'manual';
}

/**
 * Resolve a free-form user reference (numeric id, `me`, `none`, login,
 * full name, or partial name) to a Redmine user id. Resolution order:
 *
 *   1. `me` / `none` / numeric         — short-circuit, no network
 *   2. project members (cache-first)   — needs issueId or projectId
 *   3. `/users.json?name=…`            — admin-only on most installs
 *   4. user-supplied manual list       — `lwr user import`
 *
 * Throws VALIDATION_USER_NOT_FOUND if nothing matches, or
 * VALIDATION_AMBIGUOUS_USER if multiple candidates match.
 */
export async function resolveUserId(
  client: RedmineClient,
  raw: string | number,
  opts: ResolveUserOptions = {},
): Promise<ResolvedUser> {
  const input = String(raw).trim();
  if (input.length === 0) {
    throw new LwrError({
      message: 'User reference is empty.',
      code: ERROR_CODES.VALIDATION_USER_NOT_FOUND,
      exit: EXIT.VALIDATION,
      hint: 'Pass a numeric user id, `me`, `none`, a login, or a name.',
    });
  }
  // 1. Short-circuits.
  if (/^\d+$/.test(input)) {
    return { id: Number(input), name: input, source: 'numeric' };
  }
  if (input.toLowerCase() === 'me') {
    const me = await getCurrentUser(client);
    return { id: me.id, name: displayName(me), login: me.login, source: 'me' };
  }
  if (input.toLowerCase() === 'none') {
    return { id: -1, name: '(none)', source: 'none' };
  }

  // Track every cache surface we consulted so we can surface staleness
  // in the not-found error envelope. The agent reads this to decide
  // whether to retry with `--no-cache`.
  const cacheTrace: Record<string, { source: 'cache' | 'live'; fetchedAt: number; ageMs: number }> = {};

  // 2. Project members (cache-first).
  let projectAnchor: number | string | undefined = opts.projectId;
  if (!projectAnchor && opts.issueId !== undefined) {
    const issue = await getIssue(client, opts.issueId);
    projectAnchor = issue.project.id;
  }

  if (projectAnchor !== undefined) {
    const result = await fetchProjectMembers(client, projectAnchor, { noCache: opts.noCache });
    cacheTrace[`members:${projectAnchor}`] = {
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMs: Date.now() - result.fetchedAt,
    };
    const m = matchUsers(result.members.map(toCandidate), input);
    if (m.kind === 'one') return { ...m.user, source: 'project-members' };
    if (m.kind === 'many') {
      throwAmbiguous(input, m.candidates, 'project-members');
    }
    // 'none' — fall through to next source
  }

  // 3. /users.json
  try {
    const { users } = await searchUsers(client, { name: input, status: 1, all: true });
    const m = matchUsers(users.map(u => ({ id: u.id, name: displayName(u), login: u.login })), input);
    if (m.kind === 'one') return { ...m.user, source: 'users-search' };
    if (m.kind === 'many') throwAmbiguous(input, m.candidates, 'users-search');
  } catch (err) {
    if (!(err instanceof LwrError && err.code === ERROR_CODES.AUTH_FORBIDDEN)) {
      throw err;
    }
    // Admin-only endpoint: silently fall through to manual list.
  }

  // 4. Manual fallback.
  const manual = readManualUsers();
  if (manual && manual.users.length > 0) {
    cacheTrace['users-manual'] = {
      source: 'cache',
      fetchedAt: manual.importedAt,
      ageMs: Date.now() - manual.importedAt,
    };
    const m = matchUsers(manual.users.map(u => ({ id: u.id, name: u.name, login: u.login })), input);
    if (m.kind === 'one') return { ...m.user, source: 'manual' };
    if (m.kind === 'many') throwAmbiguous(input, m.candidates, 'manual');
  }

  throw new LwrError({
    message: `No user matched "${input}".`,
    code: ERROR_CODES.VALIDATION_USER_NOT_FOUND,
    exit: EXIT.VALIDATION,
    hint: buildNotFoundHint(opts, manual !== undefined, cacheTrace),
    details: {
      query: input,
      scopesSearched: scopesSearched(opts, manual !== undefined),
      cache: cacheTrace,
      ttlMs: { members: CACHE_TTL_MS.MEMBERS, statuses: CACHE_TTL_MS.STATUSES },
    },
  });
}

interface MatchCandidate {
  id: number;
  name: string;
  login?: string;
}

type MatchResult =
  | { kind: 'none' }
  | { kind: 'one'; user: MatchCandidate }
  | { kind: 'many'; candidates: MatchCandidate[] };

function matchUsers(pool: MatchCandidate[], q: string): MatchResult {
  const lower = q.toLowerCase();

  // Exact login match wins outright.
  const exactLogin = pool.filter(u => u.login && u.login.toLowerCase() === lower);
  if (exactLogin.length === 1) return { kind: 'one', user: exactLogin[0] };
  if (exactLogin.length > 1) return { kind: 'many', candidates: exactLogin };

  // Exact name match (case-insensitive).
  const exactName = pool.filter(u => u.name.toLowerCase() === lower);
  if (exactName.length === 1) return { kind: 'one', user: exactName[0] };
  if (exactName.length > 1) return { kind: 'many', candidates: exactName };

  // Substring match on name or login.
  const substr = pool.filter(u => {
    const n = u.name.toLowerCase();
    const l = (u.login ?? '').toLowerCase();
    return n.includes(lower) || (l.length > 0 && l.includes(lower));
  });
  if (substr.length === 1) return { kind: 'one', user: substr[0] };
  if (substr.length > 1) return { kind: 'many', candidates: substr };

  return { kind: 'none' };
}

function toCandidate(m: ProjectMember): MatchCandidate {
  return { id: m.id, name: m.name, login: m.login };
}

function displayName(u: RedmineUser): string {
  const f = u.firstname ?? '';
  const l = u.lastname ?? '';
  const full = `${f} ${l}`.trim();
  return full.length > 0 ? full : (u.login ?? `user ${u.id}`);
}

function throwAmbiguous(query: string, candidates: MatchCandidate[], source: string): never {
  const list = candidates
    .slice(0, 8)
    .map(c => `"${c.name}"${c.login ? ` <${c.login}>` : ''} (${c.id})`)
    .join(', ');
  throw new LwrError({
    message: `"${query}" matched ${candidates.length} users in ${source}: ${list}.`,
    code: ERROR_CODES.VALIDATION_AMBIGUOUS_USER,
    exit: EXIT.VALIDATION,
    hint: 'Pass the numeric id of the intended user, or a more specific login/name.',
    details: { query, source, candidates },
  });
}

function buildNotFoundHint(
  opts: ResolveUserOptions,
  manualSeen: boolean,
  cacheTrace?: Record<string, { source: 'cache' | 'live'; fetchedAt: number; ageMs: number }>,
): string {
  // If ANY consulted source served from disk cache (not a live fetch),
  // the most actionable next step is to retry with --no-cache — a new
  // user added to Redmine since the cache was written would otherwise
  // never resolve. The agent's policy is: on failure where source was
  // 'cache', retry once. We surface the suggestion ahead of the generic
  // resolver hints so the agent sees it first.
  if (cacheTrace) {
    const cachedHits = Object.entries(cacheTrace).filter(([, v]) => v.source === 'cache');
    if (cachedHits.length > 0) {
      const list = cachedHits
        .map(([k, v]) => `${k} (${humanAge(v.ageMs)})`)
        .join(', ');
      return `Resolution used cached data: ${list}. Retry with --no-cache to fetch fresh from Redmine — the user may have been added after the cache was written.`;
    }
  }
  const tried: string[] = [];
  if (opts.issueId !== undefined || opts.projectId !== undefined) tried.push('project members');
  tried.push('/users.json (admin-only — may be silently skipped on 403)');
  if (manualSeen) tried.push('manual list');
  return `Searched: ${tried.join(', ')}. Try \`lwr user list --project <id>\` to see who's on the project, or \`lwr user import users.json\` to provide a fallback list.`;
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s old`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m old`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h old`;
  return `${Math.round(ms / 86_400_000)}d old`;
}

function scopesSearched(opts: ResolveUserOptions, manualSeen: boolean): string[] {
  const out: string[] = [];
  if (opts.issueId !== undefined) out.push(`issue:${opts.issueId}->project-members`);
  else if (opts.projectId !== undefined) out.push(`project:${opts.projectId}->members`);
  out.push('users-search');
  if (manualSeen) out.push('manual');
  return out;
}

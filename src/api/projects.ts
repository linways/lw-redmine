/**
 * Projects resource.
 *
 * Includes the cache-first project index (id ↔ identifier ↔ name) and a
 * `resolveProjectRef` that lets agents pass any of those three forms.
 * Most users work on 1–2 projects; the index is queried on every
 * `--project <ref>` and refreshed at most once per day.
 */

import { ERROR_CODES, EXIT, REDMINE_PATHS, MAX_PAGE_SIZE } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import {
  projectsIndexFresh,
  readProjectsIndex,
  writeProjectsIndex,
  type ProjectIndexEntry,
} from '../foundation/cache';
import { LwrError } from '../foundation/errors';
import type {
  ProjectsPage,
  RedmineProject,
  MembershipsPage,
  RedmineMembership,
  VersionsList,
  RedmineVersion,
} from './types';

export interface ListProjectsOptions {
  /** 1-based offset (Redmine uses offset, not page). Optional. */
  offset?: number;
  /** Page size. Capped at MAX_PAGE_SIZE by Redmine itself. */
  limit?: number;
  /** When true, fetch every page and concatenate. */
  all?: boolean;
}

export async function listProjects(
  client: RedmineClient,
  opts: ListProjectsOptions = {},
): Promise<{ projects: RedmineProject[]; total: number }> {
  if (opts.all) {
    const all: RedmineProject[] = [];
    let offset = 0;
    const limit = MAX_PAGE_SIZE;
    let total = 0;
    while (true) {
      const page = await fetchPage(client, offset, limit);
      all.push(...page.projects);
      total = page.total_count;
      offset += page.projects.length;
      if (offset >= total || page.projects.length === 0) break;
    }
    return { projects: all, total };
  }

  const page = await fetchPage(client, opts.offset ?? 0, opts.limit);
  return { projects: page.projects, total: page.total_count };
}

async function fetchPage(
  client: RedmineClient,
  offset: number,
  limit?: number,
): Promise<ProjectsPage> {
  return http(async () => {
    const res = await client.get<ProjectsPage>(REDMINE_PATHS.PROJECTS, {
      params: { offset, ...(limit !== undefined ? { limit } : {}) },
    });
    return res.data;
  });
}

export async function getProject(
  client: RedmineClient,
  idOrIdentifier: number | string,
): Promise<RedmineProject> {
  return http(async () => {
    const res = await client.get<{ project: RedmineProject }>(
      REDMINE_PATHS.PROJECT_BY_ID(idOrIdentifier),
    );
    return res.data.project;
  });
}

export async function listMemberships(
  client: RedmineClient,
  idOrIdentifier: number | string,
  opts: { offset?: number; limit?: number; all?: boolean } = {},
): Promise<{ memberships: RedmineMembership[]; total: number }> {
  if (opts.all) {
    const all: RedmineMembership[] = [];
    let offset = 0;
    let total = 0;
    while (true) {
      const page = await fetchMembershipsPage(client, idOrIdentifier, offset, MAX_PAGE_SIZE);
      all.push(...page.memberships);
      total = page.total_count;
      offset += page.memberships.length;
      if (offset >= total || page.memberships.length === 0) break;
    }
    return { memberships: all, total };
  }
  const page = await fetchMembershipsPage(client, idOrIdentifier, opts.offset ?? 0, opts.limit);
  return { memberships: page.memberships, total: page.total_count };
}

async function fetchMembershipsPage(
  client: RedmineClient,
  idOrIdentifier: number | string,
  offset: number,
  limit?: number,
): Promise<MembershipsPage> {
  return http(async () => {
    const res = await client.get<MembershipsPage>(
      REDMINE_PATHS.PROJECT_MEMBERSHIPS(idOrIdentifier),
      { params: { offset, ...(limit !== undefined ? { limit } : {}) } },
    );
    return res.data;
  });
}

export async function listVersions(
  client: RedmineClient,
  idOrIdentifier: number | string,
): Promise<{ versions: RedmineVersion[]; total: number }> {
  return http(async () => {
    const res = await client.get<VersionsList>(
      REDMINE_PATHS.PROJECT_VERSIONS(idOrIdentifier),
    );
    return { versions: res.data.versions, total: res.data.total_count ?? res.data.versions.length };
  });
}

/**
 * Resolve a free-form version reference to its Redmine id.
 *
 *   - Numeric (e.g. `"1053"` or `1053`) → used directly without a network call.
 *   - String → fetched versions list for the project, exact-match (case-
 *     insensitive) on `name`, then substring match. Throws
 *     VALIDATION_AMBIGUOUS_VERSION (with `details.candidates`) if multiple
 *     versions match the same query.
 *
 * Used by `lwr issue list --version <id-or-name>` so an agent can pass a
 * sprint name like "Sprint93 - May4 - May9" without first looking up its id.
 */
export async function resolveVersionId(
  client: RedmineClient,
  projectIdOrIdentifier: number | string,
  query: string,
): Promise<{ id: number; name: string; source: 'numeric' | 'exact' | 'substring' }> {
  const trimmed = String(query).trim();
  if (trimmed.length === 0) {
    throw new LwrError({
      message: 'Version reference is empty.',
      code: ERROR_CODES.VALIDATION_BAD_VALUE,
      exit: EXIT.VALIDATION,
      hint: 'Pass a numeric version id or the version name.',
    });
  }
  if (/^\d+$/.test(trimmed)) {
    return { id: Number(trimmed), name: trimmed, source: 'numeric' };
  }

  const { versions } = await listVersions(client, projectIdOrIdentifier);
  const lower = trimmed.toLowerCase();

  const exact = versions.filter(v => v.name.toLowerCase() === lower);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, source: 'exact' };
  if (exact.length > 1) throwAmbiguousVersion(trimmed, exact, 'exact');

  const substring = versions.filter(v => v.name.toLowerCase().includes(lower));
  if (substring.length === 1) return { id: substring[0].id, name: substring[0].name, source: 'substring' };
  if (substring.length > 1) throwAmbiguousVersion(trimmed, substring, 'substring');

  throw new LwrError({
    message: `No version matched "${trimmed}" in project ${projectIdOrIdentifier}.`,
    code: ERROR_CODES.VALIDATION_BAD_VALUE,
    exit: EXIT.VALIDATION,
    hint: `Run \`lwr project versions ${projectIdOrIdentifier} --json\` to see available versions, then pass an id or exact name.`,
  });
}

function throwAmbiguousVersion(query: string, candidates: RedmineVersion[], kind: 'exact' | 'substring'): never {
  const list = candidates
    .slice(0, 8)
    .map(v => `"${v.name}" (${v.id})`)
    .join(', ');
  throw new LwrError({
    message: `"${query}" matched ${candidates.length} versions (${kind}): ${list}.`,
    code: ERROR_CODES.VALIDATION_BAD_VALUE,
    exit: EXIT.VALIDATION,
    hint: 'Pass the numeric id of the intended version, or a more specific name.',
    details: {
      query,
      candidates: candidates.map(v => ({ id: v.id, name: v.name, status: v.status, dueDate: v.due_date })),
    },
  });
}

// ---------------------------------------------------------------------------
// Project index (id ↔ identifier ↔ name) — cache-first
// ---------------------------------------------------------------------------

export interface GetProjectsIndexOptions {
  noCache?: boolean;
}

/**
 * Cache-first project index. On a miss (or `--no-cache`) pulls every
 * project page from Redmine, writes the index, and returns it. The index
 * is what `resolveProjectRef` matches against, so an agent saying
 * `--project "Linways AMS V4"` lands on id 51 with no live request.
 */
export async function getProjectsIndex(
  client: RedmineClient,
  opts: GetProjectsIndexOptions = {},
): Promise<ProjectIndexEntry[]> {
  if (!opts.noCache && projectsIndexFresh()) {
    const cached = readProjectsIndex();
    if (cached) return cached.data.projects;
  }
  const { projects } = await listProjects(client, { all: true });
  const entries: ProjectIndexEntry[] = projects.map(p => ({
    id: p.id,
    identifier: p.identifier,
    name: p.name,
    status: p.status,
    isPublic: p.is_public,
    parentId: p.parent?.id,
  }));
  try {
    writeProjectsIndex(entries);
  } catch {
    // Best-effort.
  }
  return entries;
}

export interface ResolvedProject {
  id: number;
  identifier: string;
  name: string;
  source: 'numeric' | 'identifier' | 'name-exact' | 'name-substring';
}

/**
 * Resolve any of {numeric id, identifier slug, human name} to a project.
 *
 *  - Numeric                         → trusts Redmine; tries to enrich from
 *                                      cache so callers always get full meta.
 *  - Slug (lowercase, dashes only)   → cache lookup by identifier, then by id.
 *  - Anything else (spaces / caps)   → cache lookup by name (case-insensitive
 *                                      exact, then substring).
 *
 * Throws VALIDATION_PROJECT_NOT_FOUND or VALIDATION_AMBIGUOUS_PROJECT
 * with `details.candidates` so agents can disambiguate.
 */
export async function resolveProjectRef(
  client: RedmineClient,
  raw: string | number,
  opts: GetProjectsIndexOptions = {},
): Promise<ResolvedProject> {
  const input = String(raw).trim();
  if (input.length === 0) {
    throw new LwrError({
      message: 'Project reference is empty.',
      code: ERROR_CODES.VALIDATION_PROJECT_NOT_FOUND,
      exit: EXIT.VALIDATION,
      hint: 'Pass a numeric id, identifier slug, or project name.',
    });
  }

  const index = await getProjectsIndex(client, opts);

  // 1. Numeric id — trust + enrich.
  if (/^\d+$/.test(input)) {
    const id = Number(input);
    const found = index.find(p => p.id === id);
    if (found) return { id: found.id, identifier: found.identifier, name: found.name, source: 'numeric' };
    // Numeric id not in cached index — could be a brand-new project or
    // wrong id. Trust the agent and let the next API call surface a 404.
    return { id, identifier: String(id), name: `(unresolved id ${id})`, source: 'numeric' };
  }

  const lower = input.toLowerCase();

  // 2. Identifier slug — exact match (Redmine identifiers are
  // [a-z0-9-_]). We only treat as an identifier candidate if there are
  // no spaces and no uppercase letters; otherwise it's a name.
  const looksLikeSlug = /^[a-z0-9_-]+$/.test(input);
  if (looksLikeSlug) {
    const byIdent = index.find(p => p.identifier.toLowerCase() === lower);
    if (byIdent) return { id: byIdent.id, identifier: byIdent.identifier, name: byIdent.name, source: 'identifier' };
    // Fall through to name match — some project names are also slug-like.
  }

  // 3. Name match (exact, then substring).
  const exactName = index.filter(p => p.name.toLowerCase() === lower);
  if (exactName.length === 1) {
    const p = exactName[0];
    return { id: p.id, identifier: p.identifier, name: p.name, source: 'name-exact' };
  }
  if (exactName.length > 1) {
    throwAmbiguousProject(input, exactName);
  }

  const substrName = index.filter(p => p.name.toLowerCase().includes(lower));
  if (substrName.length === 1) {
    const p = substrName[0];
    return { id: p.id, identifier: p.identifier, name: p.name, source: 'name-substring' };
  }
  if (substrName.length > 1) {
    throwAmbiguousProject(input, substrName);
  }

  // 4. Last-ditch: identifier substring (handles slugs the user typed
  // partially, e.g. "ams" matching "linways-ams-v4").
  if (looksLikeSlug) {
    const substrIdent = index.filter(p => p.identifier.toLowerCase().includes(lower));
    if (substrIdent.length === 1) {
      const p = substrIdent[0];
      return { id: p.id, identifier: p.identifier, name: p.name, source: 'identifier' };
    }
    if (substrIdent.length > 1) throwAmbiguousProject(input, substrIdent);
  }

  throw new LwrError({
    message: `No project matched "${input}".`,
    code: ERROR_CODES.VALIDATION_PROJECT_NOT_FOUND,
    exit: EXIT.VALIDATION,
    hint: `Run \`lwr project list\` to see available projects, or \`lwr cache refresh --type projects\` if you suspect the index is stale.`,
    details: { query: input, indexSize: index.length },
  });
}

function throwAmbiguousProject(query: string, candidates: ProjectIndexEntry[]): never {
  const list = candidates.slice(0, 8).map(c => `"${c.name}" (${c.id}, ${c.identifier})`).join(', ');
  throw new LwrError({
    message: `"${query}" matched ${candidates.length} projects: ${list}.`,
    code: ERROR_CODES.VALIDATION_AMBIGUOUS_PROJECT,
    exit: EXIT.VALIDATION,
    hint: 'Pass the numeric id or the exact identifier slug to disambiguate.',
    details: {
      query,
      candidates: candidates.map(c => ({ id: c.id, identifier: c.identifier, name: c.name })),
    },
  });
}

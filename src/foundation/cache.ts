/**
 * Plain-JSON metadata cache.
 *
 * Lives at `~/.lwr/cache/`. Each entry is a JSON file with a tiny
 * envelope `{ fetchedAt, schema, data }` so we can age it out and
 * evolve schemas without breaking older caches in place.
 *
 * What goes in here:
 *   - `statuses.json`             — global issue status dictionary
 *   - `projects/<pid>.json`       — per-project { project, members[] }
 *   - `users-manual.json`         — user-supplied fallback (sacred — never
 *                                   auto-overwritten; manual `cache clear`
 *                                   is required to drop it)
 *
 * What does NOT go in here:
 *   - issue allowed_statuses (depends on issue state — must be live)
 *   - issue contents (already cached per-issue under `~/.lwr/issues/<id>/`)
 *
 * Rationale (vs SQLite): flat JSON is trivially inspectable, requires no
 * native deps, and matches the existing per-issue cache pattern. We never
 * need a join across these resources.
 *
 * Trust boundary: cache contents are TRUSTED-OF-SERVER. They originate
 * from Redmine responses; if the server is compromised, the cache can
 * carry attacker-controlled values (e.g. project name → wrong id). TTLs
 * (`CACHE_TTL_MS`) bound the staleness window, and `cache refresh`
 * recovers. Files are written with explicit mode 0644 so they aren't
 * world-writable — readable by other processes the user runs (which is
 * expected for a metadata cache), but never modifiable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CACHE_TTL_MS } from '../constants';
import {
  cacheActivitiesPath,
  cacheCustomFieldsPath,
  cacheDir,
  cacheMetaPath,
  cacheProjectPath,
  cacheProjectsDir,
  cacheProjectsIndexPath,
  cacheStatusesPath,
  cacheUsersManualPath,
} from './paths';
import type { RedmineIssueStatus } from '../api/statuses';
import type { IdName, RedmineActivity, RedmineProject } from '../api/types';

// --- Envelope --------------------------------------------------------------

const CACHE_SCHEMA = 'lwr-cache/v1' as const;

interface CacheEnvelope<T> {
  fetchedAt: number;
  schema: typeof CACHE_SCHEMA;
  data: T;
}

function readEnvelope<T>(file: string): CacheEnvelope<T> | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.schema !== CACHE_SCHEMA) return undefined;
    if (typeof parsed.fetchedAt !== 'number') return undefined;
    return parsed;
  } catch {
    // Corrupt cache — just behave as if it was missing.
    return undefined;
  }
}

function writeEnvelope<T>(file: string, data: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env: CacheEnvelope<T> = { fetchedAt: Date.now(), schema: CACHE_SCHEMA, data };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function isFresh(envelope: { fetchedAt: number } | undefined, ttlMs: number): boolean {
  if (!envelope) return false;
  return Date.now() - envelope.fetchedAt < ttlMs;
}

// --- Statuses --------------------------------------------------------------

export interface StatusesCache {
  statuses: RedmineIssueStatus[];
}

export function readStatusesCache(): { fetchedAt: number; data: StatusesCache } | undefined {
  const env = readEnvelope<StatusesCache>(cacheStatusesPath());
  return env ? { fetchedAt: env.fetchedAt, data: env.data } : undefined;
}

export function writeStatusesCache(statuses: RedmineIssueStatus[]): void {
  writeEnvelope<StatusesCache>(cacheStatusesPath(), { statuses });
}

export function statusesCacheFresh(): boolean {
  return isFresh(readEnvelope<StatusesCache>(cacheStatusesPath()), CACHE_TTL_MS.STATUSES);
}

// --- Activities ------------------------------------------------------------
//
// Same shape and lifecycle as statuses: instance-wide enumeration, daily
// TTL. Used by `lwr time log` to map `--activity Development` → id.

export interface ActivitiesCache {
  activities: RedmineActivity[];
}

export function readActivitiesCache(): { fetchedAt: number; data: ActivitiesCache } | undefined {
  const env = readEnvelope<ActivitiesCache>(cacheActivitiesPath());
  return env ? { fetchedAt: env.fetchedAt, data: env.data } : undefined;
}

export function writeActivitiesCache(activities: RedmineActivity[]): void {
  writeEnvelope<ActivitiesCache>(cacheActivitiesPath(), { activities });
}

export function activitiesCacheFresh(): boolean {
  return isFresh(readEnvelope<ActivitiesCache>(cacheActivitiesPath()), CACHE_TTL_MS.ACTIVITIES);
}

// --- Projects index (id ↔ name dictionary) --------------------------------

export interface ProjectIndexEntry {
  id: number;
  identifier: string;
  name: string;
  status?: number;
  isPublic?: boolean;
  parentId?: number;
}

export interface ProjectsIndex {
  projects: ProjectIndexEntry[];
}

export function readProjectsIndex(): { fetchedAt: number; data: ProjectsIndex } | undefined {
  const env = readEnvelope<ProjectsIndex>(cacheProjectsIndexPath());
  return env ? { fetchedAt: env.fetchedAt, data: env.data } : undefined;
}

export function writeProjectsIndex(projects: ProjectIndexEntry[]): void {
  writeEnvelope<ProjectsIndex>(cacheProjectsIndexPath(), { projects });
}

export function projectsIndexFresh(): boolean {
  return isFresh(readEnvelope<ProjectsIndex>(cacheProjectsIndexPath()), CACHE_TTL_MS.PROJECTS_INDEX);
}

// --- Projects (project + members) -----------------------------------------

export interface ProjectMember {
  /** Redmine user id. */
  id: number;
  /** Display name as Redmine returned it. */
  name: string;
  /** Login (when available — memberships endpoint omits it; user/current includes it). */
  login?: string;
  mail?: string;
  roles?: string[];
}

export interface ProjectCache {
  project: { id: number; identifier: string; name: string };
  members: ProjectMember[];
}

export function readProjectCache(projectId: number | string): { fetchedAt: number; data: ProjectCache } | undefined {
  const env = readEnvelope<ProjectCache>(cacheProjectPath(projectId));
  return env ? { fetchedAt: env.fetchedAt, data: env.data } : undefined;
}

export function writeProjectCache(projectId: number | string, data: ProjectCache): void {
  writeEnvelope<ProjectCache>(cacheProjectPath(projectId), data);
}

export function projectCacheFresh(projectId: number | string): boolean {
  return isFresh(readEnvelope<ProjectCache>(cacheProjectPath(projectId)), CACHE_TTL_MS.MEMBERS);
}

/** All cached projects (sorted by mtime asc) — used by `lwr cache list`. */
export function listCachedProjects(): { projectId: string; fetchedAt: number; data: ProjectCache }[] {
  const dir = cacheProjectsDir();
  if (!fs.existsSync(dir)) return [];
  const out: { projectId: string; fetchedAt: number; data: ProjectCache }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const env = readEnvelope<ProjectCache>(path.join(dir, entry));
    if (!env) continue;
    out.push({ projectId: entry.replace(/\.json$/, ''), fetchedAt: env.fetchedAt, data: env.data });
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

// --- Custom-fields catalog (opportunistic) --------------------------------
//
// Redmine's `/custom_fields.json` is admin-only on most installs, so we
// can't fetch the catalog on demand. Instead we accumulate it as a side
// effect of every issue payload that already carries
// `custom_fields: [{ id, name, value }]`. The catalog grows monotonically;
// entries are never removed automatically. If a cf is renamed in Redmine
// the old entry stays — `lwr cache clear --type cf` (or manual file
// removal) is the recovery path.

export interface CustomFieldEntry {
  id: number;
  name: string;
  /** Epoch ms — last issue payload we saw this cf in. */
  lastSeenAt: number;
}

export interface CustomFieldsCatalog {
  fields: Record<string, CustomFieldEntry>;
}

export function readCustomFieldsCatalog(): CustomFieldsCatalog | undefined {
  const env = readEnvelope<CustomFieldsCatalog>(cacheCustomFieldsPath());
  return env ? env.data : undefined;
}

/**
 * Merge observations from a single issue payload into the catalog.
 * Best-effort: a malformed cache file is replaced rather than crashing
 * the request, since cf observations are non-critical telemetry.
 */
export function recordCustomFields(
  observed: { id: number; name?: string | null }[],
): void {
  if (observed.length === 0) return;
  const valid = observed.filter(
    (cf): cf is { id: number; name: string } =>
      typeof cf.id === 'number' &&
      Number.isFinite(cf.id) &&
      cf.id > 0 &&
      typeof cf.name === 'string' &&
      cf.name.trim().length > 0,
  );
  if (valid.length === 0) return;

  const existing = readCustomFieldsCatalog() ?? { fields: {} };
  const now = Date.now();
  let dirty = false;

  for (const cf of valid) {
    const key = cf.name.trim();
    const prev = existing.fields[key];
    if (!prev || prev.id !== cf.id) {
      existing.fields[key] = { id: cf.id, name: key, lastSeenAt: now };
      dirty = true;
    } else if (now - prev.lastSeenAt > 60 * 60 * 1000) {
      // Refresh lastSeenAt at most hourly to avoid write storms in
      // a tight list loop.
      existing.fields[key] = { ...prev, lastSeenAt: now };
      dirty = true;
    }
  }

  if (dirty) {
    try {
      writeEnvelope<CustomFieldsCatalog>(cacheCustomFieldsPath(), existing);
    } catch {
      // Disk full, permission denied, etc. — non-fatal.
    }
  }
}

// --- Manual users fallback -------------------------------------------------

export interface ManualUserEntry {
  id: number;
  login?: string;
  name: string;
  mail?: string;
}

export interface ManualUsersFile {
  importedAt: number;
  source?: string;
  users: ManualUserEntry[];
}

export function readManualUsers(): ManualUsersFile | undefined {
  const file = cacheUsersManualPath();
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as ManualUsersFile;
    if (!Array.isArray(parsed.users)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write the user-supplied fallback list. Distinct from the auto cache —
 * stored in its own file so it's never overwritten when memberships are
 * refreshed, and kept across `cache refresh` runs.
 */
export function writeManualUsers(users: ManualUserEntry[], source?: string): void {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = cacheUsersManualPath();
  const payload: ManualUsersFile = { importedAt: Date.now(), source, users };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// --- Bulk operations -------------------------------------------------------

export type CacheType = 'statuses' | 'activities' | 'projects' | 'users';

export interface CacheClearResult {
  removed: { type: CacheType; path: string }[];
}

/**
 * Remove cache entries. `users` always means the manual list — automatic
 * member caches are part of `projects`. Pass an empty `types` array (or
 * omit) to clear everything except the manual users file (which requires
 * an explicit `users` to drop).
 */
export function clearCache(types?: CacheType[]): CacheClearResult {
  const t = types && types.length > 0 ? types : (['statuses', 'activities', 'projects'] as CacheType[]);
  const removed: { type: CacheType; path: string }[] = [];

  const tryRm = (type: CacheType, p: string): void => {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push({ type, path: p });
    }
  };

  if (t.includes('statuses')) tryRm('statuses', cacheStatusesPath());
  if (t.includes('activities')) tryRm('activities', cacheActivitiesPath());
  if (t.includes('projects')) {
    tryRm('projects', cacheProjectsIndexPath());
    tryRm('projects', cacheProjectsDir());
  }
  if (t.includes('users')) tryRm('users', cacheUsersManualPath());
  return { removed };
}

/**
 * Cache root listing — what's cached, when, freshness. Used by
 * `lwr cache list`. Read-only.
 */
export interface CacheInventory {
  root: string;
  statuses?: { fetchedAt: number; count: number; freshMs: number };
  activities?: { fetchedAt: number; count: number; freshMs: number };
  projectsIndex?: { fetchedAt: number; count: number; freshMs: number };
  projects: { projectId: string; project: IdName; fetchedAt: number; memberCount: number; freshMs: number }[];
  manualUsers?: { importedAt: number; count: number; source?: string };
  meta?: unknown;
}

export function inventory(): CacheInventory {
  const out: CacheInventory = { root: cacheDir(), projects: [] };
  const s = readStatusesCache();
  if (s) {
    out.statuses = {
      fetchedAt: s.fetchedAt,
      count: s.data.statuses.length,
      freshMs: CACHE_TTL_MS.STATUSES - (Date.now() - s.fetchedAt),
    };
  }
  const a = readActivitiesCache();
  if (a) {
    out.activities = {
      fetchedAt: a.fetchedAt,
      count: a.data.activities.length,
      freshMs: CACHE_TTL_MS.ACTIVITIES - (Date.now() - a.fetchedAt),
    };
  }
  const idx = readProjectsIndex();
  if (idx) {
    out.projectsIndex = {
      fetchedAt: idx.fetchedAt,
      count: idx.data.projects.length,
      freshMs: CACHE_TTL_MS.PROJECTS_INDEX - (Date.now() - idx.fetchedAt),
    };
  }
  for (const p of listCachedProjects()) {
    out.projects.push({
      projectId: p.projectId,
      project: { id: p.data.project.id, name: p.data.project.name },
      fetchedAt: p.fetchedAt,
      memberCount: p.data.members.length,
      freshMs: CACHE_TTL_MS.MEMBERS - (Date.now() - p.fetchedAt),
    });
  }
  const m = readManualUsers();
  if (m) {
    out.manualUsers = { importedAt: m.importedAt, count: m.users.length, source: m.source };
  }
  if (fs.existsSync(cacheMetaPath())) {
    try {
      out.meta = JSON.parse(fs.readFileSync(cacheMetaPath(), 'utf8'));
    } catch {
      // ignore
    }
  }
  return out;
}

// --- Type re-exports for caller convenience -------------------------------

export type ProjectMeta = ProjectCache['project'];
export type { RedmineProject };

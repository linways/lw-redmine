/**
 * `lwr cache list / refresh / clear`
 *
 * Inspect and manage the on-disk metadata cache (~/.lwr/cache/). This
 * exists so an agent (or human) can see what's in the cache, force a
 * re-fetch when something looks stale, or wipe entries entirely.
 *
 * The user-supplied manual list (`users`) is sacred: it is never touched
 * by `cache refresh` and only dropped by an explicit `cache clear --type
 * users`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { openSession } from '../foundation/session';
import {
  clearCache,
  inventory,
  listCachedProjects,
  type CacheType,
} from '../foundation/cache';
import { listActivities } from '../api/activities';
import { listStatuses } from '../api/statuses';
import { getProjectsIndex } from '../api/projects';
import { fetchProjectMembers } from '../api/users';
import { writeLine } from '../foundation/output';
import { renderTable, dim, header, success } from '../foundation/format';
import { ValidationError } from '../foundation/errors';
import { ERROR_CODES } from '../constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TYPES: ReadonlySet<CacheType> = new Set(['statuses', 'activities', 'projects', 'users']);

function parseTypes(raw?: string): CacheType[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  for (const p of parts) {
    if (!VALID_TYPES.has(p as CacheType)) {
      throw new ValidationError(
        `Unknown cache type "${p}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Valid: statuses, activities, projects, users.',
      );
    }
  }
  return parts as CacheType[];
}

function fmtAge(ms: number): string {
  if (ms < 0) return 'stale';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m fresh`;
  const hr = Math.floor(min / 60);
  return `${hr}h fresh`;
}

function fmtAgeFromNow(fetchedAt: number): string {
  const ms = Date.now() - fetchedAt;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// cache list
// ---------------------------------------------------------------------------

interface ListPayload {
  root: string;
  statuses?: { fetchedAt: number; count: number; freshFor: string };
  activities?: { fetchedAt: number; count: number; freshFor: string };
  projectsIndex?: { fetchedAt: number; count: number; freshFor: string };
  projects: { projectId: string; project: { id: number; name: string }; fetchedAt: number; memberCount: number; freshFor: string }[];
  manualUsers?: { importedAt: number; count: number; source?: string };
}

const listCmd: CommandFn<ListPayload> = async (): Promise<CommandResult<ListPayload>> => {
  const inv = inventory();
  const payload: ListPayload = {
    root: inv.root,
    projects: inv.projects.map(p => ({
      projectId: p.projectId,
      project: p.project,
      fetchedAt: p.fetchedAt,
      memberCount: p.memberCount,
      freshFor: fmtAge(p.freshMs),
    })),
  };
  if (inv.statuses) {
    payload.statuses = {
      fetchedAt: inv.statuses.fetchedAt,
      count: inv.statuses.count,
      freshFor: fmtAge(inv.statuses.freshMs),
    };
  }
  if (inv.activities) {
    payload.activities = {
      fetchedAt: inv.activities.fetchedAt,
      count: inv.activities.count,
      freshFor: fmtAge(inv.activities.freshMs),
    };
  }
  if (inv.projectsIndex) {
    payload.projectsIndex = {
      fetchedAt: inv.projectsIndex.fetchedAt,
      count: inv.projectsIndex.count,
      freshFor: fmtAge(inv.projectsIndex.freshMs),
    };
  }
  if (inv.manualUsers) {
    payload.manualUsers = inv.manualUsers;
  }

  return {
    json: payload,
    pretty: ctx => {
      writeLine(header(ctx, 'Cache inventory'));
      writeLine(dim(ctx, payload.root));
      writeLine('');

      if (payload.statuses) {
        writeLine(`statuses: ${payload.statuses.count} entries — ${payload.statuses.freshFor} (fetched ${fmtAgeFromNow(payload.statuses.fetchedAt)})`);
      } else {
        writeLine(dim(ctx, 'statuses: not cached'));
      }

      if (payload.activities) {
        writeLine(`activities: ${payload.activities.count} entries — ${payload.activities.freshFor} (fetched ${fmtAgeFromNow(payload.activities.fetchedAt)})`);
      } else {
        writeLine(dim(ctx, 'activities: not cached'));
      }

      if (payload.projectsIndex) {
        writeLine(`projects index: ${payload.projectsIndex.count} entries — ${payload.projectsIndex.freshFor} (fetched ${fmtAgeFromNow(payload.projectsIndex.fetchedAt)})`);
      } else {
        writeLine(dim(ctx, 'projects index: not cached'));
      }

      if (payload.projects.length === 0) {
        writeLine(dim(ctx, 'projects: none cached'));
      } else {
        writeLine('');
        writeLine(
          renderTable(ctx, {
            head: ['Key', 'Project', 'Members', 'Age', 'Freshness'],
            rows: payload.projects.map(p => [
              p.projectId,
              `#${p.project.id} ${p.project.name}`,
              p.memberCount,
              fmtAgeFromNow(p.fetchedAt),
              p.freshFor,
            ]),
            colWidths: [12, 30, 10, 12, 14],
          }),
        );
      }

      if (payload.manualUsers) {
        writeLine('');
        writeLine(
          `manual users: ${payload.manualUsers.count} entries (imported ${fmtAgeFromNow(payload.manualUsers.importedAt)}${payload.manualUsers.source ? ` from ${payload.manualUsers.source}` : ''})`,
        );
      }
    },
  };
};

export function cacheList(flags: GlobalFlags): Promise<never> {
  return runCommand('cache.list', flags, listCmd);
}

// ---------------------------------------------------------------------------
// cache clear
// ---------------------------------------------------------------------------

export interface CacheClearFlags extends GlobalFlags {
  type?: string;
}

interface ClearPayload {
  removed: { type: CacheType; path: string }[];
}

const clearCmd: CommandFn<ClearPayload> = async (flags): Promise<CommandResult<ClearPayload>> => {
  const f = flags as CacheClearFlags;
  const types = parseTypes(f.type);
  const result = clearCache(types);
  return {
    json: { removed: result.removed },
    pretty: ctx => {
      if (result.removed.length === 0) {
        writeLine(dim(ctx, 'Nothing to clear.'));
        return;
      }
      for (const r of result.removed) {
        writeLine(success(ctx, `Cleared ${r.type}: ${r.path}`));
      }
    },
  };
};

export function cacheClear(flags: CacheClearFlags): Promise<never> {
  return runCommand('cache.clear', flags, clearCmd);
}

// ---------------------------------------------------------------------------
// cache refresh
// ---------------------------------------------------------------------------

export interface CacheRefreshFlags extends GlobalFlags {
  type?: string;
}

interface RefreshPayload {
  refreshed: { type: 'statuses' | 'activities' | 'projects-index' | 'projects'; key?: string; count: number }[];
}

const refreshCmd: CommandFn<RefreshPayload> = async (flags): Promise<CommandResult<RefreshPayload>> => {
  const f = flags as CacheRefreshFlags;
  const requested = parseTypes(f.type) ?? (['statuses', 'activities', 'projects'] as CacheType[]);
  const session = await openSession(flags);
  const refreshed: RefreshPayload['refreshed'] = [];

  if (requested.includes('statuses')) {
    const s = await listStatuses(session.client, { noCache: true });
    refreshed.push({ type: 'statuses', count: s.length });
  }
  if (requested.includes('activities')) {
    const a = await listActivities(session.client, { noCache: true });
    refreshed.push({ type: 'activities', count: a.length });
  }
  if (requested.includes('projects')) {
    // (a) Always re-pull the id ↔ name index — that's the dictionary
    // agents use to resolve `--project "Linways AMS V4"`.
    const idx = await getProjectsIndex(session.client, { noCache: true });
    refreshed.push({ type: 'projects-index', count: idx.length });
    // (b) Refresh in place every per-project member cache that's already
    // present. We deliberately don't enumerate every project — that could
    // be hundreds and most won't be needed.
    const cached = listCachedProjects();
    for (const p of cached) {
      const result = await fetchProjectMembers(session.client, p.projectId, { noCache: true });
      refreshed.push({ type: 'projects', key: p.projectId, count: result.members.length });
    }
  }

  return {
    json: { refreshed },
    pretty: ctx => {
      if (refreshed.length === 0) {
        writeLine(dim(ctx, 'Nothing to refresh. Run a command that hits the cache first.'));
        return;
      }
      for (const r of refreshed) {
        let line: string;
        if (r.type === 'projects') line = `Refreshed project "${r.key}": ${r.count} member(s)`;
        else if (r.type === 'projects-index') line = `Refreshed projects index: ${r.count} project(s)`;
        else if (r.type === 'activities') line = `Refreshed activities: ${r.count} entries`;
        else line = `Refreshed statuses: ${r.count} entries`;
        writeLine(success(ctx, line));
      }
    },
  };
};

export function cacheRefresh(flags: CacheRefreshFlags): Promise<never> {
  return runCommand('cache.refresh', flags, refreshCmd);
}

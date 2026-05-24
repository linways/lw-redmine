/**
 * Time-entry activities (`/enumerations/time_entry_activities.json`).
 *
 * Mirrors `api/statuses.ts`: a global enumeration the agent reads once
 * per day, caches, and resolves names against. `lwr time log
 * --activity Development` flows through `resolveActivityId` here.
 *
 * Redmine response shape:
 *   { time_entry_activities: [{ id, name, is_default?, active? }, ...] }
 */

import { REDMINE_PATHS } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import {
  activitiesCacheFresh,
  readActivitiesCache,
  writeActivitiesCache,
} from '../foundation/cache';
import type { RedmineActivity } from './types';

export interface ListActivitiesOptions {
  /** Bypass the cache and fetch live. Default: false. */
  noCache?: boolean;
}

export async function listActivities(
  client: RedmineClient,
  opts: ListActivitiesOptions = {},
): Promise<RedmineActivity[]> {
  if (!opts.noCache && activitiesCacheFresh()) {
    const cached = readActivitiesCache();
    if (cached) return cached.data.activities;
  }
  const fresh = await http(async () => {
    const res = await client.get<{ time_entry_activities: RedmineActivity[] }>(
      REDMINE_PATHS.TIME_ENTRY_ACTIVITIES,
    );
    return res.data.time_entry_activities;
  });
  try {
    writeActivitiesCache(fresh);
  } catch {
    // Cache write is best-effort.
  }
  return fresh;
}

/**
 * Resolve a name OR numeric-id-as-string to an activity id. Names match
 * case-insensitively. Throws if no activity matches.
 */
export function resolveActivityId(activities: RedmineActivity[], input: string | number): number {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  const match = activities.find(a => a.name.toLowerCase() === lower);
  if (!match) {
    const names = activities.map(a => a.name).join(', ');
    throw new Error(`Unknown activity "${input}". Available: ${names}.`);
  }
  return match.id;
}

/** First activity flagged is_default; falls back to the first item. */
export function defaultActivity(activities: RedmineActivity[]): RedmineActivity | undefined {
  return activities.find(a => a.is_default === true) ?? activities[0];
}

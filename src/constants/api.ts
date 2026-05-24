/**
 * Redmine REST API endpoint paths.
 *
 * Every path lives here so a fork can retarget a non-standard Redmine
 * instance (e.g. one mounted under a sub-path) by editing this file alone.
 * No literal `/issues.json` strings should appear anywhere else in the codebase.
 */

export const REDMINE_PATHS = {
  CURRENT_USER: '/users/current.json',
  USERS: '/users.json',
  USER_BY_ID: (id: number | string) => `/users/${id}.json`,

  ISSUES: '/issues.json',
  ISSUE_BY_ID: (id: number | string) => `/issues/${id}.json`,

  PROJECTS: '/projects.json',
  PROJECT_BY_ID: (id: number | string) => `/projects/${id}.json`,
  PROJECT_MEMBERSHIPS: (id: number | string) => `/projects/${id}/memberships.json`,
  PROJECT_VERSIONS: (id: number | string) => `/projects/${id}/versions.json`,

  STATUSES: '/issue_statuses.json',
  PRIORITIES: '/enumerations/issue_priorities.json',
  TIME_ENTRY_ACTIVITIES: '/enumerations/time_entry_activities.json',
  TRACKERS: '/trackers.json',

  TIME_ENTRIES: '/time_entries.json',
  TIME_ENTRY_BY_ID: (id: number | string) => `/time_entries/${id}.json`,

  WIKI_INDEX: (project: string) => `/projects/${project}/wiki/index.json`,
  WIKI_PAGE: (project: string, title: string) =>
    `/projects/${project}/wiki/${encodeURIComponent(title)}.json`,

  ATTACHMENTS: (id: number | string) => `/attachments/${id}.json`,
  UPLOADS: '/uploads.json',

  ISSUE_WATCHERS: (id: number | string) => `/issues/${id}/watchers.json`,
  ISSUE_WATCHER_BY_ID: (id: number | string, userId: number | string) =>
    `/issues/${id}/watchers/${userId}.json`,

  QUERIES: '/queries.json',

  SEARCH: '/search.json',
} as const;

/**
 * Query parameter conventions Redmine expects.
 * Centralised so commands don't pepper the codebase with magic strings.
 */
export const REDMINE_PARAMS = {
  INCLUDE_ISSUE_DETAIL: 'attachments,journals,relations,children,watchers',
  INCLUDE_PROJECT_DETAIL: 'trackers,issue_categories,enabled_modules',
  INCLUDE_USER_DETAIL: 'memberships,groups',
} as const;

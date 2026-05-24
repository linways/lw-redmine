/**
 * Shared Redmine API types.
 *
 * We type only the fields we actively use rather than the full Redmine
 * surface — runtime safety for the rest comes from `zod` parsers in each
 * resource module when needed.
 */

export interface IdName {
  id: number;
  name: string;
}

export interface RedmineUser {
  id: number;
  login?: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
  api_key?: string;
}

export interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
  description?: string;
  status?: number;
  is_public?: boolean;
  parent?: IdName;
  created_on?: string;
  updated_on?: string;
}

export interface RedmineIssue {
  id: number;
  subject: string;
  description?: string;
  project: IdName;
  tracker: IdName;
  status: IdName;
  priority: IdName;
  author: IdName;
  assigned_to?: IdName;
  fixed_version?: IdName;
  category?: IdName;
  parent?: { id: number };
  start_date?: string;
  due_date?: string;
  done_ratio?: number;
  estimated_hours?: number;
  spent_hours?: number;
  created_on: string;
  updated_on: string;
  closed_on?: string;
  custom_fields?: { id: number; name: string; value: string | string[] | null }[];
  attachments?: RedmineAttachment[];
  journals?: RedmineJournal[];
  watchers?: { id: number; name: string }[];
  relations?: RedmineRelation[];
  /**
   * Statuses the *current user* is allowed to transition this issue to,
   * given Redmine's workflow + role permissions. Populated only when the
   * issue is fetched with `?include=allowed_statuses`.
   */
  allowed_statuses?: IssueAllowedStatus[];
}

export interface IssueAllowedStatus {
  id: number;
  name: string;
  is_closed?: boolean;
}

export interface RedmineAttachment {
  id: number;
  filename: string;
  filesize: number;
  content_type: string;
  description?: string;
  content_url: string;
  thumbnail_url?: string;
  author: IdName;
  created_on: string;
}

export interface RedmineJournal {
  id: number;
  user: IdName;
  notes?: string;
  created_on: string;
  private_notes?: boolean;
  details?: { property: string; name: string; old_value: string | null; new_value: string | null }[];
}

export interface RedmineRelation {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
  delay?: number | null;
}

/** Standard paginated list envelope from Redmine. */
export interface PageMeta {
  total_count: number;
  offset: number;
  limit: number;
}

export type IssuesPage = PageMeta & { issues: RedmineIssue[] };
export type ProjectsPage = PageMeta & { projects: RedmineProject[] };
export type UsersPage = PageMeta & { users: RedmineUser[] };

export interface RedmineMembership {
  id: number;
  project: IdName;
  user?: IdName;
  group?: IdName;
  roles: IdName[];
}
export type MembershipsPage = PageMeta & { memberships: RedmineMembership[] };

export interface RedmineVersion {
  id: number;
  project: IdName;
  name: string;
  description?: string;
  status: 'open' | 'locked' | 'closed' | string;
  due_date?: string | null;
  sharing?: string;
  wiki_page_title?: string;
  created_on: string;
  updated_on: string;
}
export interface VersionsList {
  versions: RedmineVersion[];
  total_count: number;
}

/**
 * Redmine time-entry activity (e.g. "Development", "Testing").
 * Lives in `/enumerations/time_entry_activities.json`. The list is
 * instance-wide, so the agent picks an activity by name and we
 * resolve to id once, then cache.
 */
export interface RedmineActivity {
  id: number;
  name: string;
  is_default?: boolean;
  active?: boolean;
}

/**
 * A single time entry. Created via POST `/time_entries.json` and aggregated
 * into the parent issue's `spent_hours`. We type the fields used by the CLI;
 * Redmine returns more (`project`, `created_on`, etc.) but they are not
 * part of any read path the agent needs.
 */
export interface RedmineTimeEntry {
  id: number;
  project: IdName;
  issue?: { id: number };
  user: IdName;
  activity: IdName;
  hours: number;
  comments?: string;
  /** Date the work was performed (YYYY-MM-DD). */
  spent_on: string;
  created_on: string;
  updated_on: string;
  custom_fields?: { id: number; name: string; value: string | string[] | null }[];
}

export type TimeEntriesPage = PageMeta & { time_entries: RedmineTimeEntry[] };

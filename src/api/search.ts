/**
 * Cross-resource full-text search.
 *
 * Wraps Redmine's `/search.json`. Each result has a `type` ("issue",
 * "wiki-page", "news", "document", "message", "project", "changeset",
 * "issue-closed") and a `url` we can normalise to a relative `/issues/123`
 * path so callers don't have to.
 */

import { REDMINE_PATHS, MAX_PAGE_SIZE } from '../constants';
import { http, type RedmineClient } from '../foundation/client';
import type { PageMeta } from './types';

export type SearchResultType =
  | 'issue'
  | 'issue-closed'
  | 'wiki-page'
  | 'news'
  | 'document'
  | 'message'
  | 'project'
  | 'changeset'
  | string;

export interface RedmineSearchResult {
  id: number;
  title: string;
  type: SearchResultType;
  url: string;
  description?: string;
  datetime?: string;
}

export type SearchPage = PageMeta & { results: RedmineSearchResult[] };

export interface SearchOptions {
  /** Restrict to a single project identifier or numeric id. */
  projectId?: number | string;
  /**
   * "self" (default), "subprojects", or "all".
   * Translates to the Redmine `scope=` param.
   */
  scope?: 'self' | 'subprojects' | 'all';
  /** Result types to include. Empty = all types. */
  types?: SearchResultType[];
  titlesOnly?: boolean;
  openOnly?: boolean;
  allWords?: boolean;
  limit?: number;
  offset?: number;
  all?: boolean;
}

const TYPE_TO_PARAM: Record<string, string> = {
  issue: 'issues',
  'issue-closed': 'issues',
  'wiki-page': 'wiki_pages',
  news: 'news',
  document: 'documents',
  message: 'messages',
  project: 'projects',
  changeset: 'changesets',
};

export async function search(
  client: RedmineClient,
  query: string,
  opts: SearchOptions = {},
): Promise<{ results: RedmineSearchResult[]; total: number }> {
  const params = buildParams(query, opts);

  if (opts.all) {
    const all: RedmineSearchResult[] = [];
    let offset = 0;
    const limit = MAX_PAGE_SIZE;
    let total = 0;
    while (true) {
      const page = await fetchPage(client, { ...params, offset, limit });
      all.push(...page.results);
      total = page.total_count;
      offset += page.results.length;
      if (offset >= total || page.results.length === 0) break;
    }
    return { results: all, total };
  }

  const page = await fetchPage(client, params);
  return { results: page.results, total: page.total_count };
}

function buildParams(query: string, opts: SearchOptions): Record<string, unknown> {
  const p: Record<string, unknown> = { q: query };
  if (opts.projectId !== undefined) p['project_id'] = opts.projectId;
  if (opts.scope) p['scope'] = opts.scope;
  if (opts.titlesOnly) p['titles_only'] = 1;
  if (opts.openOnly) p['open_issues'] = 1;
  if (opts.allWords) p['all_words'] = 1;
  if (opts.limit !== undefined) p['limit'] = opts.limit;
  if (opts.offset !== undefined) p['offset'] = opts.offset;
  if (opts.types && opts.types.length > 0) {
    const seen = new Set<string>();
    for (const t of opts.types) {
      const param = TYPE_TO_PARAM[t];
      if (param && !seen.has(param)) {
        p[param] = 1;
        seen.add(param);
      }
    }
  }
  return p;
}

async function fetchPage(
  client: RedmineClient,
  params: Record<string, unknown>,
): Promise<SearchPage> {
  return http(async () => {
    const res = await client.get<SearchPage>(REDMINE_PATHS.SEARCH, { params });
    return res.data;
  });
}

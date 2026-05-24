/**
 * `lwr search <query>`
 *
 * Cross-resource full-text search. Wraps Redmine's `/search.json`.
 *
 * Agent surface (JSON mode):
 *   data.results: [{id, type, title, description, datetime, url, ref}]
 *     ref is a stable, instance-relative pointer agents can hand back to
 *     `lwr issue view`, `lwr wiki view`, etc. without re-parsing the URL.
 */

import { DEFAULT_PAGE_SIZE } from '../constants';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { openSession } from '../foundation/session';
import { search as apiSearch, type RedmineSearchResult, type SearchResultType } from '../api/search';
import { resolveProjectRef } from '../api/projects';
import { writeLine } from '../foundation/output';
import { renderTable, dim, hyperlink } from '../foundation/format';
import { ValidationError } from '../foundation/errors';
import { ERROR_CODES } from '../constants';

export interface SearchFlags extends GlobalFlags {
  query?: string;
  /** Project identifier — restricts the search. */
  searchProject?: string;
  scope?: 'self' | 'subprojects' | 'all';
  types?: string;
  titlesOnly?: boolean;
  open?: boolean;
  allWords?: boolean;
  limit?: number;
  offset?: number;
  all?: boolean;
}

interface Row {
  id: number;
  type: SearchResultType;
  title: string;
  description: string | null;
  datetime: string | null;
  url: string;
  /** Stable internal reference like "issue:64602" or "wiki:my-project/Home". */
  ref: string;
}

interface Payload {
  total: number;
  query: string;
  results: Row[];
}

const VALID_TYPES = new Set([
  'issue',
  'wiki',
  'wiki-page',
  'news',
  'document',
  'message',
  'project',
  'changeset',
]);

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as SearchFlags;
  const query = (f.query ?? '').trim();
  if (query.length === 0) {
    throw new ValidationError(
      'Query is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr search "<query>"`.',
    );
  }

  const types = parseTypes(f.types);
  if (f.scope && !['self', 'subprojects', 'all'].includes(f.scope)) {
    throw new ValidationError(
      `Invalid --scope: ${f.scope}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Use one of: self, subprojects, all.',
    );
  }

  const session = await openSession(flags);
  const projectId = f.searchProject
    ? (await resolveProjectRef(session.client, f.searchProject)).id
    : undefined;
  const { results, total } = await apiSearch(session.client, query, {
    projectId,
    scope: f.scope,
    types: types.map(normaliseTypeForApi),
    titlesOnly: f.titlesOnly,
    openOnly: f.open,
    allWords: f.allWords,
    limit: f.limit ?? DEFAULT_PAGE_SIZE,
    offset: f.offset,
    all: f.all,
  });

  const rows = results.map(toRow);

  return {
    json: { total, query, results: rows },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, `(no matches for "${query}")`));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['Ref', 'Type', 'Title', 'When'],
          // Hyperlink the ref (#123456 / wiki:Foo / etc.) to its Redmine URL.
          // Each search hit already carries r.url from Redmine — no extra work.
          rows: rows.map(r => [hyperlink(ctx, r.url, r.ref), r.type, r.title, formatWhen(r.datetime)]),
          colWidths: [22, 14, 60, 20],
        }),
      );
      writeLine(dim(ctx, `${rows.length} of ${total} match(es) for "${query}"`));
    },
  };
};

function parseTypes(raw?: string): string[] {
  if (!raw) return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!VALID_TYPES.has(p)) {
      throw new ValidationError(
        `Unknown --type: ${p}`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        `Use a comma-separated list of: ${[...VALID_TYPES].join(', ')}.`,
      );
    }
  }
  return parts;
}

function normaliseTypeForApi(t: string): SearchResultType {
  // Accept the friendly alias "wiki" as a synonym for the API's "wiki-page".
  if (t === 'wiki') return 'wiki-page';
  return t as SearchResultType;
}

function toRow(r: RedmineSearchResult): Row {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    description: r.description ?? null,
    datetime: r.datetime ?? null,
    url: r.url,
    ref: makeRef(r),
  };
}

/**
 * Build a stable, agent-friendly ref string from a search result.
 *
 *   issue 64602          → "issue:64602"
 *   wiki page foo/Home   → "wiki:foo/Home" (project derived from URL)
 *   project my-proj      → "project:my-proj"
 *   anything else        → `${type}:${id}` as a graceful fallback
 *
 * Agents can hand any of these back to a follow-up lwr command.
 */
function makeRef(r: RedmineSearchResult): string {
  switch (r.type) {
    case 'issue':
    case 'issue-closed':
      return `issue:${r.id}`;
    case 'wiki-page': {
      const m = /\/projects\/([^/]+)\/wiki\/([^/?#]+)/.exec(r.url);
      if (m) return `wiki:${m[1]}/${decodeURIComponent(m[2] ?? '')}`;
      return `wiki:${r.id}`;
    }
    case 'project': {
      const m = /\/projects\/([^/?#]+)/.exec(r.url);
      if (m) return `project:${m[1]}`;
      return `project:${r.id}`;
    }
    default:
      return `${r.type}:${r.id}`;
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return '-';
  // Redmine returns ISO; trim to "YYYY-MM-DD HH:MM" for table density.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

export function searchCmd(flags: SearchFlags): Promise<never> {
  return runCommand('search', flags, cmd);
}

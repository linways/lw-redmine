/**
 * `lwr issue list`
 *
 * The agent's primary read path. Filters cleave into two groups:
 *
 *   1. Plain Redmine filters (--project, --status, --priority, --tracker,
 *      --subject, --assignee <id>) — direct mappings to Redmine query
 *      params.
 *
 *   2. Profile-aware lenses (--as <lens>) — the agent picks the lens
 *      from the user's question intent ("what am I developing?" → developer,
 *      "what am I testing?" → tester, "what's on my plate?" → ambiguous,
 *      ask or use `--as any`). The lens resolves to `cf_<id>=<userId>` for
 *      cf-backed roles, or `assigned_to_id=<userId>` / `author_id=<userId>`
 *      for the built-in lenses.
 *
 * Plus `--cf <id>=<value>` as a generic escape hatch for any custom-field
 * filter the lens system doesn't model.
 */

import {
  ERROR_CODES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  isEffectivelyDoneStatus,
} from '../../constants';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { activeProfile } from '../../foundation/profiles';
import { listIssues } from '../../api/issues';
import { resolveProjectRef, resolveVersionId } from '../../api/projects';
import { writeLine } from '../../foundation/output';
import { renderTable, dim, statusBadge, priorityBadge, hyperlink } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import type { Me } from '../../foundation/config';
import type { RedmineIssue } from '../../api/types';

const ROLE_LENSES = ['developer', 'tester', 'qa', 'lead'] as const;
const BUILTIN_LENSES = ['assignee', 'reporter'] as const;
const ALL_LENS = 'any' as const;
type RoleLens = (typeof ROLE_LENSES)[number];
type BuiltinLens = (typeof BUILTIN_LENSES)[number];
type AnyLens = typeof ALL_LENS;
export type Lens = RoleLens | BuiltinLens | AnyLens;
const VALID_LENSES: ReadonlyArray<Lens> = [...ROLE_LENSES, ...BUILTIN_LENSES, ALL_LENS];

export interface IssueListFlags extends GlobalFlags {
  project?: string;
  status?: string;
  /** Arbitrary user id ("123" or "me"); orthogonal to --as. */
  assignee?: string;
  priority?: string;
  tracker?: string;
  /**
   * Sprint / Redmine version — id or name. Names are resolved via the
   * project's versions list (substring + exact match). Requires
   * `--project` (or an active project from the profile) so we know which
   * project's versions to look in. Named `sprint` (not `version`) to
   * avoid colliding with commander's auto-injected `--version` flag.
   */
  sprint?: string;
  subject?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  /**
   * Profile-aware lens. The agent resolves the user's question intent
   * to one of these. Mutually exclusive with --assignee (since the lens
   * already encodes who).
   */
  as?: Lens;
  /**
   * Generic cf filter, repeatable. Each value is `<cfId>=<value>`.
   * e.g. `--cf 79=57 --cf 80=42`.
   */
  cf?: string[];
  /**
   * Opt back into Redmine's raw `status_id=open` semantic. At Linways
   * every status has `is_closed: false` (the flag is unused), so the
   * native filter never excludes anything — by default lwr post-filters
   * out names in EFFECTIVELY_DONE_STATUS_NAMES so "open" actually means
   * "still on my plate". Pass `--include-done` to disable that filter
   * (e.g., to see Resolved/Closed tickets).
   */
  includeDone?: boolean;
  /**
   * Comma-separated list of status names to exclude. Applied AFTER
   * Redmine's filter, in addition to the EFFECTIVELY_DONE filter (if
   * active). Used by agents to narrow a list to "currently in my court"
   * by hiding handoff states (`Development Completed`, `Testing
   * completed`, `Grooming Completed`, …).
   *
   *   `--exclude-status "Development Completed,Testing completed"`
   *
   * Names match case-insensitively. Unknown names are silently no-op.
   */
  excludeStatus?: string;
}

interface IssueRow {
  id: number;
  /**
   * Direct link to the issue in Redmine — `<baseUrl>/issues/<id>`.
   * Pre-computed in the JSON so the agent doesn't have to concatenate
   * baseUrl + id at render time. The agent uses this to build clickable
   * markdown links: `[#<id>](<url>)`.
   */
  url: string;
  subject: string;
  project: string;
  tracker: string;
  status: string;
  priority: string;
  assignee: string | null;
  /**
   * Linways-specific custom field "College" — every issue carries one
   * (e.g. "STJOSEPHSV4", "JAWAHARLAL"). Resolved by NAME (not by cf id)
   * so the same code works on Redmine instances where "College" is bound
   * to a different cf id, or absent entirely (returns null).
   */
  college: string | null;
  updated: string;
}

interface ListPayload {
  /**
   * Redmine's `total_count` for the underlying API query — i.e. how many
   * rows matched before lwr's local post-filter. Compare against
   * `issues.length` and `excludedByName.count` to reconcile the page.
   */
  total: number;
  issues: IssueRow[];
  /** Echoes back the resolved query — useful for the agent to verify intent. */
  query: {
    as?: Lens;
    customFieldFilters: Record<number, string | number>;
    assignee?: number | 'me';
  };
  /**
   * Local post-filter accounting. Present when at least one row in the
   * fetched page was dropped — either because it sat in
   * EFFECTIVELY_DONE_STATUS_NAMES (and `--include-done` wasn't passed)
   * or because it matched `--exclude-status`. Agents use `count > 0` to
   * offer the user "want to see the hidden ones too?" in natural
   * language without making a second call.
   */
  excludedByName?: {
    count: number;
    names: string[];
    /** True iff the EFFECTIVELY_DONE filter contributed at least one drop. */
    doneFilterActive: boolean;
    /** Names passed through `--exclude-status`, normalised. Empty when unused. */
    userExcluded: string[];
  };
}

const cmd: CommandFn<ListPayload> = async (flags): Promise<CommandResult<ListPayload>> => {
  const flgs = flags as IssueListFlags;

  validateLens(flgs.as);
  if (flgs.as && flgs.assignee) {
    throw new ValidationError(
      '--as and --assignee are mutually exclusive.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Pick one: `--as <lens>` for the logged-in user, or `--assignee <id>` for a specific user.',
    );
  }

  const session = await openSession(flags);
  // Resolve project first — `--version` needs a project anchor to find the
  // versions list, so use --project flag, the active profile project, or
  // bail with a clear error if neither.
  const projectId = flgs.project
    ? (await resolveProjectRef(session.client, flgs.project)).id
    : undefined;

  let fixedVersionId: number | undefined;
  if (flgs.sprint) {
    const versionAnchor = projectId ?? activeProfile().profile.activeProject?.id;
    if (!versionAnchor) {
      throw new ValidationError(
        '--sprint requires a project anchor.',
        ERROR_CODES.VALIDATION_MISSING_FLAG,
        'Pass --project <name-or-id>, or set a profile active project via `lwr project use <name>`.',
      );
    }
    const v = await resolveVersionId(session.client, versionAnchor, flgs.sprint);
    fixedVersionId = v.id;
  }

  const cfFilters = parseCfFlags(flgs.cf);

  // Resolve the lens to a concrete query *or* a fan-out plan ('any').
  const lensPlan: LensPlan = flgs.as
    ? planLens(flgs.as)
    : { kind: 'single', lensFilter: { cf: {} } };

  // Over-fetch enough headroom so that after the local post-filter the
  // user typically still sees the limit they asked for. Skipped when
  // the user passed --all (we're paginating everything anyway) or no
  // post-filter is active (no headroom needed).
  const userExclusions = parseExcludeStatus(flgs.excludeStatus);
  const doneFilterActive = shouldApplyDoneFilter(flgs);
  const requestedLimit = flgs.limit ?? DEFAULT_PAGE_SIZE;
  const willPostFilter = doneFilterActive || userExclusions.length > 0;
  const fetchLimit = willPostFilter && !flgs.all
    ? Math.min(Math.ceil(requestedLimit * 1.5), MAX_PAGE_SIZE)
    : requestedLimit;

  const baseOpts = {
    projectId,
    statusId: flgs.status,
    priorityId: parseNumeric(flgs.priority),
    trackerId: parseNumeric(flgs.tracker),
    fixedVersionId,
    subject: flgs.subject,
    sort: flgs.sort ?? 'priority:desc,updated_on:desc',
    limit: fetchLimit,
    offset: flgs.offset,
    all: flgs.all,
    // Ask Redmine for custom_fields on the list response so we can show
    // the per-issue College value. The list endpoint omits cfs by
    // default; including them adds a small per-row join cost on
    // Redmine's side but keeps us at one round-trip.
    include: ['custom_fields'],
  };

  let issues: RedmineIssue[];
  let total: number;
  if (lensPlan.kind === 'fanout') {
    ({ issues, total } = await fanoutAnyLens(session.client, baseOpts, cfFilters, flgs.assignee));
  } else {
    const { lensFilter } = lensPlan;
    ({ issues, total } = await listIssues(session.client, {
      ...baseOpts,
      assignedTo: parseAssignee(lensFilter.assignee ?? flgs.assignee),
      author: lensFilter.author,
      customFieldFilters: { ...lensFilter.cf, ...cfFilters },
    }));
  }

  // Apply local post-filter:
  //   1. EFFECTIVELY_DONE_STATUS_NAMES — only when the user is asking
  //      for "open" (no --status flag, or --status open). Disabled by
  //      --include-done. Reason: at Linways every status has
  //      `is_closed: false` so Redmine's native open filter is a no-op,
  //      and "Resolved"/"Closed" leak into "show my open tickets".
  //   2. --exclude-status — user/agent-supplied names. Always applied.
  const { kept, droppedNames } = applyStatusPostFilter(issues, {
    doneFilterActive,
    userExclusions,
  });

  // Trim back down to the user's requested limit so over-fetch is
  // invisible to the caller. Only meaningful for the paged form
  // (--all returns the full set, so no trim).
  const visible = !flgs.all && kept.length > requestedLimit
    ? kept.slice(0, requestedLimit)
    : kept;
  const rows = visible.map(i => toRow(i, session.baseUrl));

  return {
    json: {
      total,
      issues: rows,
      query: {
        as: flgs.as,
        customFieldFilters: cfFilters,
        assignee: parseAssignee(flgs.assignee),
      },
      ...(droppedNames.length > 0
        ? {
            excludedByName: {
              count: droppedNames.length,
              names: droppedNames,
              doneFilterActive,
              userExcluded: userExclusions,
            },
          }
        : {}),
    },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, '(no issues match)'));
        if (droppedNames.length > 0) {
          writeLine(dim(ctx, `(${droppedNames.length} hidden by status filter — pass --include-done to show)`));
        }
        return;
      }
      // Hyperlink each id to its Redmine URL so terminal users can
      // ⌘/Ctrl-click straight to the issue. In JSON mode (or
      // `--no-color`), this is a no-op — `r.id` renders as a plain int.
      const issueUrl = (id: number) => `${session.baseUrl}/issues/${id}`;
      writeLine(
        renderTable(ctx, {
          head: ['#ID', 'Subject', 'Project', 'College', 'Status', 'Priority', 'Assignee'],
          rows: rows.map(r => [
            hyperlink(ctx, issueUrl(r.id), String(r.id)),
            r.subject,
            r.project,
            r.college ?? '-',
            statusBadge(ctx, r.status),
            priorityBadge(ctx, r.priority),
            r.assignee ?? '-',
          ]),
          colWidths: [8, 44, 20, 14, 16, 14, 18],
        }),
      );
      const tailParts = [`${rows.length} of ${total} issue(s)`];
      if (droppedNames.length > 0) {
        tailParts.push(`${droppedNames.length} hidden (${uniqueSorted(droppedNames).join(', ')})`);
      }
      writeLine(dim(ctx, tailParts.join(' · ')));
    },
  };
};

// ---------------------------------------------------------------------------
// Status post-filter
// ---------------------------------------------------------------------------

/**
 * Whether the EFFECTIVELY_DONE filter should kick in for this invocation.
 *
 *   - `--include-done` always wins (user explicitly wants the raw view).
 *   - `--status` unset → user implicitly asked for "open" → filter on.
 *   - `--status open` → same → filter on.
 *   - `--status <anything-else>` → user named a specific status (or
 *     `closed`/`*`) → respect their query, filter off.
 */
export function shouldApplyDoneFilter(flags: IssueListFlags): boolean {
  if (flags.includeDone) return false;
  const s = flags.status?.trim().toLowerCase();
  if (s === undefined || s === '' || s === 'open') return true;
  return false;
}

export function parseExcludeStatus(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function applyStatusPostFilter(
  issues: RedmineIssue[],
  opts: { doneFilterActive: boolean; userExclusions: string[] },
): { kept: RedmineIssue[]; droppedNames: string[] } {
  if (!opts.doneFilterActive && opts.userExclusions.length === 0) {
    return { kept: issues, droppedNames: [] };
  }
  const userSet = new Set(opts.userExclusions.map(n => n.toLowerCase()));
  const kept: RedmineIssue[] = [];
  const droppedNames: string[] = [];
  for (const issue of issues) {
    const name = issue.status?.name ?? '';
    const lowered = name.toLowerCase();
    const dropByDone = opts.doneFilterActive && isEffectivelyDoneStatus(name);
    const dropByUser = userSet.has(lowered);
    if (dropByDone || dropByUser) {
      droppedNames.push(name);
    } else {
      kept.push(issue);
    }
  }
  return { kept, droppedNames };
}

function uniqueSorted(names: string[]): string[] {
  return Array.from(new Set(names)).sort();
}

// --- Lens resolution -------------------------------------------------------

interface LensFilter {
  /** assigned_to_id; pre-resolved to numeric or 'me'. */
  assignee?: number | 'me';
  /** author_id; pre-resolved to numeric or 'me'. */
  author?: number | 'me';
  /** cf_<id>=<value> filters this lens contributes. */
  cf: Record<number, number>;
}

type LensPlan =
  | { kind: 'single'; lensFilter: LensFilter }
  | { kind: 'fanout' };

function planLens(lens: Lens): LensPlan {
  if (lens === ALL_LENS) return { kind: 'fanout' };

  // Built-in lenses use Redmine's standard fields; no profile lookup needed.
  if (lens === 'assignee') return { kind: 'single', lensFilter: { assignee: 'me', cf: {} } };
  if (lens === 'reporter') return { kind: 'single', lensFilter: { author: 'me', cf: {} } };

  // Role lens — needs the profile's fieldMap binding.
  const me = readMe();
  const cf = me.fieldMap[lens];
  if (!cf) {
    throw new ValidationError(
      `Role "${lens}" is not in your profile.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Profile roles: ${me.roles.join(', ')}. Run \`lwr me detect --role ${lens}\` to add it, or pick from existing roles.`,
    );
  }
  return { kind: 'single', lensFilter: { cf: { [cf.cfId]: me.user.id } } };
}

/**
 * `--as any`: union all lenses the user has, minus duplicates by issue id.
 *
 * Pages: each lens is fetched at the requested limit; the merged total is
 * the deduplicated count we actually returned (not the sum, which would
 * double-count issues that match multiple lenses). `--all` is honoured per
 * lens, so the union is always complete relative to the requested page
 * across the *included* lenses.
 */
async function fanoutAnyLens(
  client: Parameters<typeof listIssues>[0],
  baseOpts: Omit<Parameters<typeof listIssues>[1], 'assignedTo' | 'author' | 'customFieldFilters'>,
  extraCf: Record<number, string | number>,
  assigneeFlag: string | undefined,
): Promise<{ issues: RedmineIssue[]; total: number }> {
  const me = readMe();
  const lenses: LensFilter[] = [
    { assignee: 'me', cf: {} },
    { author: 'me', cf: {} },
    ...me.roles.map<LensFilter>(role => {
      const cf = me.fieldMap[role];
      return { cf: cf ? { [cf.cfId]: me.user.id } : {} };
    }),
  ];

  const seen = new Map<number, RedmineIssue>();
  for (const lens of lenses) {
    const { issues } = await listIssues(client, {
      ...baseOpts,
      assignedTo: parseAssignee(lens.assignee ?? assigneeFlag),
      author: lens.author,
      customFieldFilters: { ...lens.cf, ...extraCf },
    });
    for (const i of issues) seen.set(i.id, i);
  }
  const merged = Array.from(seen.values()).sort((a, b) => b.id - a.id);
  return { issues: merged, total: merged.length };
}

// --- Helpers ---------------------------------------------------------------

function readMe(): Me {
  const { profile } = activeProfile();
  return profile.me;
}

function validateLens(lens: Lens | undefined): asserts lens is Lens | undefined {
  if (lens === undefined) return;
  if (!VALID_LENSES.includes(lens)) {
    throw new ValidationError(
      `Unknown lens: "${lens}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Valid lenses: ${VALID_LENSES.join(', ')}.`,
    );
  }
}

/**
 * Hard ceiling on `--cf <id>=<v>` ids. Real Redmine instances ship a few
 * dozen custom fields at most; this cap stops an agent (or a typo) from
 * stamping `cf_99999999=x` into Redmine query strings — the request
 * would still 422, but the URL noise is wasteful.
 */
const MAX_CF_ID = 10_000;

export function parseCfFlags(raw: string[] | undefined): Record<number, string> {
  if (!raw || raw.length === 0) return {};
  const out: Record<number, string> = {};
  for (const entry of raw) {
    const m = /^(\d+)=(.+)$/.exec(entry.trim());
    if (!m) {
      throw new ValidationError(
        `Bad --cf value: "${entry}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Use the form `--cf <cfId>=<value>`, e.g. `--cf 79=57`.',
      );
    }
    const id = Number(m[1]);
    if (id <= 0 || id > MAX_CF_ID) {
      throw new ValidationError(
        `--cf id out of range: ${id} (must be 1..${MAX_CF_ID}).`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Custom-field ids on Redmine are small positive integers; check `lwr cache list` or your instance admin.',
      );
    }
    out[id] = m[2];
  }
  return out;
}

function parseAssignee(v: string | number | 'me' | undefined): number | 'me' | undefined {
  if (v === undefined) return undefined;
  if (v === 'me') return 'me';
  if (typeof v === 'number') return v;
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseNumeric(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toRow(i: RedmineIssue, baseUrl: string): IssueRow {
  return {
    id: i.id,
    url: `${baseUrl}/issues/${i.id}`,
    subject: i.subject,
    project: i.project.name,
    tracker: i.tracker.name,
    status: i.status.name,
    priority: i.priority.name,
    assignee: i.assigned_to?.name ?? null,
    college: extractCollege(i.custom_fields),
    updated: i.updated_on,
  };
}

/**
 * Pull the "College" custom field's value off an issue. Linways binds
 * it to cf id 2 by convention but we match by name so the same code
 * works against any Redmine instance — and so a renamed cf still works
 * as long as it keeps the "College" label.
 *
 * Returns null when the cf is absent or empty (e.g. multi-instance
 * projects where College isn't a tracked dimension).
 */
function extractCollege(cfs: RedmineIssue['custom_fields']): string | null {
  if (!cfs || cfs.length === 0) return null;
  const cf = cfs.find(c => c.name.toLowerCase() === 'college');
  if (!cf || cf.value == null) return null;
  if (Array.isArray(cf.value)) {
    const filtered = cf.value.filter(v => typeof v === 'string' && v.trim().length > 0);
    return filtered.length > 0 ? filtered.join(', ') : null;
  }
  const s = String(cf.value).trim();
  return s.length > 0 ? s : null;
}

export function list(flags: IssueListFlags): Promise<never> {
  return runCommand('issue.list', flags, cmd);
}

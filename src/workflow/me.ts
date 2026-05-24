/**
 * Per-user "who am I" profile.
 *
 * `buildMeProfile` produces a complete `Me` block from a freshly-authenticated
 * Redmine session: identity from `users/current.json`, every cf-backed role
 * the user appears in across recent history, and the Redmine-instance-specific
 * custom field ids that back each role.
 *
 * The model has no "primary role." A user can simultaneously be a developer
 * on issue X, a tester on issue Y, and a lead on issue Z. Every role with
 * enough history lands in `me.roles[]`. The agent picks the right lens at
 * query time from the user's question — see SKILL.md.
 *
 * Pipeline:
 *
 *   1. Seed: fetch a small recent assignee-plate sample (~25 issues). Its
 *      only purpose is to surface the cf catalog as it exists on *this*
 *      Redmine — names like "Developer" / "Tester" aren't hardcoded ids;
 *      different installs bind them to different cf ids.
 *
 *   2. Probe per role: for each role pattern with a matching cf in the
 *      catalog, query Redmine directly: `GET /issues.json?cf_<id>=<userId>
 *      &limit=1`. Read `total_count`. If it >= the threshold, the user
 *      genuinely holds that role on this instance.
 *
 *      Probing matters because at Linways (and similar workflows) the
 *      assignee is typically the requestor / lead, NOT the developer —
 *      so the user's developer-cf issues do *not* show up in their own
 *      assignee plate. Counting cf hits in the seed sample misses them
 *      entirely. Probing asks Redmine the question we actually care about
 *      ("how many issues have me in cf X?") instead of inferring it from
 *      a tangentially-related sample.
 *
 *   3. If no role probes positive AND no `--role` override was given,
 *      fall back to an interactive multi-select (TTY) or throw
 *      VALIDATION_MISSING_FLAG (non-TTY) telling the agent to pass --role.
 *
 *   4. Build the `Me` record. Throws if any role's cf is missing on this
 *      instance — that's a real misconfig, not a degraded state.
 *
 * The orchestrator throws on every failure path. There is no "logged in
 * but role unset" half-state; if `buildMeProfile` returns, the result
 * satisfies the schema.
 */

import fs from 'node:fs';
import { checkbox } from '@inquirer/prompts';
import { ERROR_CODES, EXIT } from '../constants';
import { listIssues } from '../api/issues';
import type { RedmineClient } from '../foundation/client';
import type { RedmineIssue, RedmineUser } from '../api/types';
import type { RedmineUserWithIncludes } from '../api/users';
import type { ActiveIssue, ActiveProject, Me, Membership, Role, FieldMap } from '../foundation/config';
import { LwrError, ValidationError } from '../foundation/errors';
import { meMarkdownPath } from '../foundation/paths';
import type { OutputContext } from '../foundation/output';

// --- Tunables --------------------------------------------------------------

/**
 * How many recent assignee-plate issues we pull to seed the cf catalog.
 * Each Linways issue carries ~30 cfs, so 25 issues already surface every
 * cf the agent would care about — the bottleneck is the round-trip, not
 * issue count.
 */
const CATALOG_SEED_SAMPLE_SIZE = 25;

/**
 * Minimum `total_count` returned by a per-role probe before we'll include
 * that role. Three issues is the smallest pattern that isn't a one-off.
 */
const ROLE_MIN_COUNT = 3;

/**
 * Name patterns the role detector recognises. Keys are the canonical
 * `Role` enum values; values are the regexes we match cf names against
 * (case-insensitive). Order doesn't matter — every role is checked.
 *
 * If a Redmine instance uses a non-conventional name (e.g., "Lead Dev"
 * instead of "Developer"), the user can still complete login by passing
 * `--role developer` and `lwr me set field-map developer 79 "Lead Dev"`
 * after the fact.
 */
const ROLE_NAME_PATTERNS: Record<Role, RegExp> = {
  developer: /^developer$/i,
  tester: /^tester$/i,
  qa: /^qa$|^quality\s+(assurance|analyst)$/i,
  lead: /^(team\s+)?lead$/i,
};

/** Stable iteration order — used wherever output should be deterministic. */
const ROLE_ENUM_ORDER: ReadonlyArray<Role> = ['developer', 'tester', 'qa', 'lead'];

// --- Public API ------------------------------------------------------------

export interface BuildMeOptions {
  client: RedmineClient;
  /**
   * The current Redmine user. Pass the response of
   * `getCurrentUser(client, { include: ['memberships'] })` so the
   * `Me.memberships` block lands populated. Plain `RedmineUser` works
   * too — memberships fall back to an empty array.
   */
  user: RedmineUser | RedmineUserWithIncludes;
  /**
   * Identifier resolver for memberships. Redmine's `?include=memberships`
   * returns each project as `{id, name}` — no identifier. The caller
   * (login flow) supplies this so we can enrich the membership records
   * to match the schema. For tests / non-login callers, an empty fn
   * leaves identifier as the project id stringified.
   */
  identifierFor?: (projectId: number) => string | undefined;
  /**
   * If passed, skips probing and binds each role directly to its catalog
   * entry. The agent surface for `lwr auth login --role developer,tester`.
   */
  roleOverride?: Role[];
  /**
   * Output context — needed so the role-prompt fallback can refuse to
   * prompt in non-TTY (it'll throw VALIDATION_MISSING_FLAG instead).
   */
  ctx: OutputContext;
}

/**
 * Builds a complete `Me` block from a logged-in session. Throws on every
 * failure; never returns a partial profile.
 */
export async function buildMeProfile(opts: BuildMeOptions): Promise<Me> {
  const { client, user, ctx, roleOverride } = opts;

  // 1. Seed the cf catalog from a small sample.
  const seed = await sampleSeedIssues(client, user.id);
  const catalog = extractCfCatalog(seed);

  // 2. Decide roles + fieldMap.
  let roles: Role[];
  let fieldMap: FieldMap;
  if (roleOverride && roleOverride.length > 0) {
    roles = dedupeInEnumOrder(roleOverride);
    fieldMap = buildFieldMap(roles, catalog);
  } else {
    const probed = await probeRolesViaRedmine(client, user.id, catalog);
    if (probed.length === 0) {
      const asked = await askRolesInteractively(ctx, catalog);
      roles = dedupeInEnumOrder(asked);
      fieldMap = buildFieldMap(roles, catalog);
    } else {
      roles = probed.map(p => p.role);
      fieldMap = Object.fromEntries(probed.map(p => [p.role, p.cf])) as FieldMap;
    }
  }

  return {
    user: {
      id: user.id,
      login: requireLogin(user),
      name: displayName(user),
    },
    roles,
    fieldMap,
    memberships: extractMemberships(user, opts.identifierFor),
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Transforms Redmine's `?include=memberships` payload into our
 * `Membership[]` shape. Redmine returns each project as `{id, name}` —
 * we enrich with `identifier` via the caller-supplied resolver (the
 * projects-index cache, in the login path). If the resolver doesn't
 * know a project, we fall back to stringifying the id; the user can
 * still operate on it (Redmine accepts numeric ids everywhere) but
 * it's a minor data-quality dent.
 */
function extractMemberships(
  user: RedmineUser | RedmineUserWithIncludes,
  identifierFor: ((id: number) => string | undefined) | undefined,
): Membership[] {
  const raw = (user as RedmineUserWithIncludes).memberships;
  if (!raw || raw.length === 0) return [];
  const out: Membership[] = [];
  for (const m of raw) {
    out.push({
      projectId: m.project.id,
      identifier: identifierFor?.(m.project.id) ?? String(m.project.id),
      name: m.project.name,
      roles: m.roles.map(r => r.name),
    });
  }
  return out;
}

/**
 * Renders the `Me` block as a small markdown snippet and writes it to
 * `~/.lwr/me.md`. SKILL.md tells every agent to read this file before
 * answering questions involving "me". Pass the (optional) active
 * project so the rendered file shows the current working scope.
 */
export function writeMeMarkdown(
  me: Me,
  baseUrl: string,
  activeProject?: ActiveProject,
  activeIssue?: ActiveIssue,
): void {
  fs.writeFileSync(meMarkdownPath(), renderMeMarkdown(me, baseUrl, activeProject, activeIssue), { mode: 0o600 });
}

/**
 * Picks an "active project" from the user's most recent activity on
 * Redmine. Strategy:
 *
 *   1. Query the user's assigned-to plate, sorted newest-first, limit=1.
 *      If we get an issue, take its project — that's the most recent
 *      thing they touched as the standard assignee.
 *   2. If empty (rare — most accounts have at least one assignee), try
 *      the developer-cf plate the same way (works for users whose
 *      assigned_to is always the lead).
 *   3. If still empty, fall back to the first membership.
 *   4. If even that's empty, return undefined — caller can leave
 *      `activeProject` unset.
 *
 * The `identifierFor` callback enriches the project meta with its
 * identifier (Redmine returns only id+name on issue payloads); pass
 * the projects-index resolver from the caller.
 */
export async function recommendActiveProject(opts: {
  client: RedmineClient;
  user: RedmineUser;
  /** All cf-backed roles the user holds (with their cf bindings). */
  roles: Role[];
  fieldMap: FieldMap;
  /** Memberships, used as last-resort fallback. */
  memberships: Membership[];
  identifierFor: (projectId: number) => { identifier: string; name: string } | undefined;
}): Promise<ActiveProject | undefined> {
  const { client, user, roles, fieldMap, memberships, identifierFor } = opts;

  // 1. Most recent assignee-plate issue.
  const assigneeRecent = await listIssues(client, {
    assignedTo: user.id,
    sort: 'updated_on:desc',
    limit: 1,
  });
  if (assigneeRecent.issues.length > 0) {
    return materialiseActiveProject(assigneeRecent.issues[0].project, identifierFor);
  }

  // 2. Most recent role-cf-plate issue. Try each role; pick the newest
  //    across all of them.
  let bestIssue: { project: { id: number; name: string }; updated: string } | undefined;
  for (const role of roles) {
    const cf = fieldMap[role];
    if (!cf) continue;
    const { issues } = await listIssues(client, {
      customFieldFilters: { [cf.cfId]: user.id },
      sort: 'updated_on:desc',
      limit: 1,
    });
    if (issues.length === 0) continue;
    const i = issues[0];
    if (!bestIssue || i.updated_on > bestIssue.updated) {
      bestIssue = { project: i.project, updated: i.updated_on };
    }
  }
  if (bestIssue) {
    return materialiseActiveProject(bestIssue.project, identifierFor);
  }

  // 3. Fall back to the first membership — at least the user is *in* this project.
  if (memberships.length > 0) {
    const m = memberships[0];
    return {
      id: m.projectId,
      identifier: m.identifier,
      name: m.name,
      setAt: new Date().toISOString(),
    };
  }

  // 4. Nothing to anchor to.
  return undefined;
}

function materialiseActiveProject(
  project: { id: number; name: string },
  identifierFor: (projectId: number) => { identifier: string; name: string } | undefined,
): ActiveProject {
  const enriched = identifierFor(project.id);
  return {
    id: project.id,
    identifier: enriched?.identifier ?? String(project.id),
    name: enriched?.name ?? project.name,
    setAt: new Date().toISOString(),
  };
}

// --- Pure helpers (exported for tests) -------------------------------------

export interface CfCatalogEntry {
  cfId: number;
  name: string;
}

/**
 * Builds a name-keyed catalog of every custom field that appears in the
 * sample. Multiple distinct ids can share a name across Redmine instances
 * in theory; we keep them all so `findCfsForRole` can try each in turn.
 */
export function extractCfCatalog(issues: RedmineIssue[]): Map<string, CfCatalogEntry[]> {
  const catalog = new Map<string, CfCatalogEntry[]>();
  for (const issue of issues) {
    for (const cf of issue.custom_fields ?? []) {
      const key = cf.name.toLowerCase();
      const existing = catalog.get(key) ?? [];
      if (!existing.some(e => e.cfId === cf.id)) {
        existing.push({ cfId: cf.id, name: cf.name });
      }
      catalog.set(key, existing);
    }
  }
  return catalog;
}

/**
 * Returns every cf entry in the catalog whose name matches the role's
 * regex. Pure; the caller decides whether/how to probe each candidate.
 */
export function findCfsForRole(role: Role, catalog: Map<string, CfCatalogEntry[]>): CfCatalogEntry[] {
  const pattern = ROLE_NAME_PATTERNS[role];
  const out: CfCatalogEntry[] = [];
  for (const [, entries] of catalog) {
    for (const entry of entries) {
      if (pattern.test(entry.name)) out.push(entry);
    }
  }
  return out;
}

/**
 * Resolves each requested role to its custom-field on this Redmine
 * instance. Used by the override path — the user explicitly said they
 * hold these roles, so we don't probe; we just bind. Throws if a role's
 * cf is absent on this instance.
 */
export function buildFieldMap(roles: Role[], catalog: Map<string, CfCatalogEntry[]>): FieldMap {
  if (roles.length === 0) {
    throw new LwrError({
      message: 'Cannot build field map for an empty role list.',
      code: ERROR_CODES.CONFIG_PROFILE_MISSING,
      exit: EXIT.CONFIG,
      hint: 'At least one role is required.',
    });
  }
  const fieldMap: FieldMap = {};
  for (const role of roles) {
    const candidates = findCfsForRole(role, catalog);
    if (candidates.length === 0) {
      throw new LwrError({
        message: `No custom field on this Redmine matches role "${role}".`,
        code: ERROR_CODES.CONFIG_PROFILE_MISSING,
        exit: EXIT.CONFIG,
        hint: `Expected a custom field named like "${role}". Verify the Redmine instance has it, or drop "${role}" from --role.`,
      });
    }
    fieldMap[role] = candidates[0];
  }
  return fieldMap;
}

// --- Internals -------------------------------------------------------------

async function sampleSeedIssues(client: RedmineClient, userId: number): Promise<RedmineIssue[]> {
  // Newest-first; the cf catalog comes mostly from a handful of recent
  // issues since each one declares its full cf list. Custom_fields aren't
  // in the default list response, so we ask explicitly.
  const { issues } = await listIssues(client, {
    assignedTo: userId,
    sort: 'updated_on:desc',
    limit: CATALOG_SEED_SAMPLE_SIZE,
    include: ['custom_fields'],
  });
  return issues;
}

/**
 * For each role with a matching cf in the catalog, ask Redmine how many
 * issues have the user's id in that cf. Returns each role that clears
 * `ROLE_MIN_COUNT` along with the cf entry it binds to.
 *
 * Costs at most one HTTP call per role pattern that has a candidate. For
 * the canonical Linways setup that's typically 2-3 calls (Developer +
 * Tester + maybe Lead) — well within the latency budget of login.
 */
async function probeRolesViaRedmine(
  client: RedmineClient,
  userId: number,
  catalog: Map<string, CfCatalogEntry[]>,
): Promise<{ role: Role; cf: CfCatalogEntry }[]> {
  const detected: { role: Role; cf: CfCatalogEntry }[] = [];
  for (const role of ROLE_ENUM_ORDER) {
    const candidates = findCfsForRole(role, catalog);
    for (const cf of candidates) {
      // limit=1 — we only need total_count, not the issues themselves.
      const { total } = await listIssues(client, {
        customFieldFilters: { [cf.cfId]: userId },
        limit: 1,
      });
      if (total >= ROLE_MIN_COUNT) {
        detected.push({ role, cf });
        break; // first matching cf wins — usually only one cf per role anyway
      }
    }
  }
  return detected;
}

async function askRolesInteractively(
  ctx: OutputContext,
  catalog: Map<string, CfCatalogEntry[]>,
): Promise<Role[]> {
  if (!ctx.interactive) {
    throw new ValidationError(
      'Could not auto-detect any role from your Redmine history.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass `--role developer[,tester,qa,lead]` to `lwr auth login`. Multiple roles allowed.',
    );
  }
  const choices = ROLE_ENUM_ORDER.map(role => {
    const cfs = findCfsForRole(role, catalog);
    return {
      name: cfs.length > 0 ? `${role} (cf ${cfs[0].cfId} — "${cfs[0].name}")` : role,
      value: role,
      disabled: cfs.length === 0 ? '(no matching cf on this Redmine)' : false,
    };
  });
  return checkbox<Role>({
    message: 'Which roles do you hold on this Redmine? (space to toggle, enter to confirm)',
    choices,
    required: true,
    validate: list => list.length > 0 || 'Pick at least one role.',
  });
}

function dedupeInEnumOrder(roles: Role[]): Role[] {
  const set = new Set(roles);
  return ROLE_ENUM_ORDER.filter(r => set.has(r));
}

function requireLogin(user: RedmineUser): string {
  if (!user.login || user.login.length === 0) {
    throw new LwrError({
      message: `Redmine user #${user.id} has no login.`,
      code: ERROR_CODES.CONFIG_PROFILE_MISSING,
      exit: EXIT.CONFIG,
      hint: 'lwr requires a login on the authenticated account.',
    });
  }
  return user.login;
}

function displayName(user: RedmineUser): string {
  const f = user.firstname?.trim() ?? '';
  const l = user.lastname?.trim() ?? '';
  const full = `${f} ${l}`.trim();
  if (full.length > 0) return full;
  if (user.login && user.login.length > 0) return user.login;
  return `user ${user.id}`;
}

/**
 * Per-role question phrasings the agent should map to this lens. The
 * default phrases ("assigned to me / my work / on my plate / my issues /
 * my tasks") all live on the user's cf-backed roles — those are what the
 * user *means* when they say "assigned to me," even though Redmine has a
 * literal `assigned_to` field. The built-in `assignee` / `reporter`
 * lenses are reserved for *explicit* references to those fields and get
 * a different cue line below.
 */
const ROLE_QUESTION_HINTS: Record<Role, string> = {
  developer: '"my issues / my work / my tasks / on my plate / assigned to me / what am I developing / coding / fixing / implementing"',
  tester: '"my testing / my QA queue / what am I testing / verifying / regressing"',
  qa: '"my QA queue / what am I signing off / quality checks on me"',
  lead: '"what am I leading / managing / overseeing / shipping"',
};

function renderMeMarkdown(
  me: Me,
  baseUrl: string,
  activeProject?: ActiveProject,
  activeIssue?: ActiveIssue,
): string {
  const lines = [
    `# Your Redmine context`,
    ``,
    `**User:** ${me.user.name} (id: ${me.user.id}, login: \`${me.user.login}\`)`,
    `**Instance:** ${baseUrl}`,
  ];
  if (activeProject) {
    lines.push(
      `**Active project:** ${activeProject.name} (id ${activeProject.id}, identifier \`${activeProject.identifier}\`)  `,
      `_Sticky — only changes when the user explicitly says "switch to ..." (\`lwr project use <name>\`). Use this as the implicit \`--project\` for any question that doesn't name one._`,
    );
  } else {
    lines.push(
      `**Active project:** _unset_ — couldn't infer from your recent activity. Pass \`--project <name>\` per call, or run \`lwr project use <name>\` to fix.`,
    );
  }
  if (activeIssue) {
    lines.push(
      ``,
      `**Active issue:** #${activeIssue.id} — ${activeIssue.subject}  `,
      `_${activeIssue.tracker} · ${activeIssue.project.name} · status: ${activeIssue.status} (last known)_  `,
      `_Sticky — set by \`lwr issue use <id>\`, cleared by \`lwr issue clear\`. Use this as the implicit issue for any question that doesn't name one. The \`status\` shown is the last seen value; refresh with \`lwr issue view ${activeIssue.id}\` if it matters._`,
    );
  } else {
    lines.push(
      ``,
      `**Active issue:** _unset locally_ — the sticky pointer in \`~/.lwr/config.json\` is empty.`,
      `_This DOES NOT mean you have no active work — the user may have moved an issue to "Development in Progress" via the Redmine UI without going through lwr. Before telling the user "no active issue", run \`lwr issue current --json\`: it reconciles against Redmine and surfaces \`discoveredActiveIssue\` when a single dev-active match exists, \`mutexViolation\` when there are multiple, or no-active only when both sides are empty._`,
    );
  }
  lines.push(``, `## Roles available to you`, ``);
  for (const role of me.roles) {
    const cf = me.fieldMap[role];
    if (!cf) continue; // schema refine() guarantees this never fires
    lines.push(
      `- **${role}** — \`lwr issue list --as ${role} --json\`  `,
      `  resolves to \`cf_${cf.cfId}=${me.user.id}\` ("${cf.name}")  `,
      `  pick when the user's question is about ${ROLE_QUESTION_HINTS[role]}`,
    );
  }
  lines.push(
    ``,
    `> **Important:** at Linways the Redmine \`assigned_to\` field is usually the requestor / lead — *not* the implementer. So when the user says "assigned to me / my work / my issues," they mean their **cf-backed role** above, not the \`assigned_to\` field. Default to the role lens.`,
    ``,
    `## Built-in lenses — explicit references only`,
    ``,
    `- **assignee** — \`lwr issue list --as assignee --json\` (\`assigned_to_id=${me.user.id}\`)  `,
    `  pick **only** when the user *explicitly* refers to the Redmine \`assigned_to\` field, e.g. "where I'm listed as assignee in the Redmine UI" or "issues on my Redmine board". Otherwise their "assigned to me" is the role lens above.`,
    `- **reporter** — \`lwr issue list --as reporter --json\` (\`author_id=${me.user.id}\`)  `,
    `  pick **only** for explicit "I reported / I opened / I created / issues I logged".`,
    ``,
    `## Disambiguation`,
    ``,
    `For ambiguous "my issues / on my plate" questions:`,
    `- If only one role exists in this profile → use \`--as ${me.roles[0]}\`.`,
    `- If multiple roles → ask the user which one, or use \`--as any\` to union all.`,
    ``,
  );
  if (me.memberships.length > 0) {
    lines.push(
      `## Projects you're a member of`,
      ``,
      `Closed set the agent should match against when the user says "switch to X" or names a project loosely.`,
      ``,
    );
    for (const m of me.memberships) {
      const isActive = activeProject?.id === m.projectId ? ' ← active' : '';
      const roles = m.roles.length > 0 ? ` — ${m.roles.join(', ')}` : '';
      lines.push(`- **${m.name}** (id ${m.projectId}, \`${m.identifier}\`)${roles}${isActive}`);
    }
    lines.push(``);
  }
  lines.push(
    `_Last detected: ${me.detectedAt}_`,
    ``,
  );
  return lines.join('\n');
}

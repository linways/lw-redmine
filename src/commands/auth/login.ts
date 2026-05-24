/**
 * `lwr auth login`
 *
 * Persists an API key for a profile. Three input paths, in priority:
 *
 *   1. `--api-key` / $LWR_API_KEY — supply the key directly (used by CI
 *      and AI agents).
 *   2. `--username` (+ `--password`) — exchange basic-auth credentials for
 *      the user's api_key via `users/current.json`. Friendlier when the
 *      user knows their login but not their key. Password is never persisted.
 *   3. Interactive prompts — falls through to (2) by default. Pass
 *      `--method api-key` to interactively prompt for an api_key instead.
 *
 * In all cases we verify the resolved key by calling `users/current.json`
 * once with it before persisting.
 */

import { ENV, ERROR_CODES } from '../../constants';
import { setApiKey } from '../../foundation/auth';
import { createClient } from '../../foundation/client';
import {
  loadConfig,
  saveConfig,
  type ActiveProject,
  type FieldMap,
  type Profile,
  type Role,
} from '../../foundation/config';
import { askInput, askPassword } from '../../foundation/prompt';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { resolveBaseUrl } from '../../foundation/url';
import { fetchProjectMembers, getCurrentUser, type RedmineUserWithIncludes } from '../../api/users';
import { exchangeCredsForApiKey } from '../../api/auth-exchange';
import { getProjectsIndex } from '../../api/projects';
import { listStatuses } from '../../api/statuses';
import { buildMeProfile, recommendActiveProject, writeMeMarkdown } from '../../workflow/me';
import type { ProjectIndexEntry } from '../../foundation/cache';
import type { RedmineUser } from '../../api/types';

const VALID_ROLES: ReadonlyArray<Role> = ['developer', 'tester', 'qa', 'lead'];
const DEFAULT_PROFILE_NAME = 'default';

export interface LoginFlags extends GlobalFlags {
  username?: string;
  password?: string;
  /** `'api-key' | 'password'` — overrides interactive default when prompting. */
  method?: 'api-key' | 'password';
  /**
   * Override role auto-detection. Comma-separated list — e.g.
   * `--role developer,tester` for users who hold multiple roles.
   * Required only when running non-TTY (agents / `--api-key` flow) on
   * accounts whose history doesn't show enough role activity to detect.
   */
  role?: string;
}

interface LoginPayload {
  profile: string;
  baseUrl: string;
  storage: 'keychain' | 'file';
  method: 'api-key' | 'password';
  user: { id: number; login?: string; mail?: string };
  me: {
    roles: Role[];
    fieldMap: FieldMap;
    membershipCount: number;
  };
  activeProject?: ActiveProject;
  prefetched: {
    statusesCount: number;
    projectsIndexCount: number;
    membersForProjects: number[];
  };
}

function parseRoleOverride(raw: string | undefined): Role[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const parts = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length === 0) {
    throw new ValidationError(
      'Empty --role list.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Pass a comma-separated subset of: ${VALID_ROLES.join(', ')}.`,
    );
  }
  for (const p of parts) {
    if (!(VALID_ROLES as ReadonlyArray<string>).includes(p)) {
      throw new ValidationError(
        `Unknown role: "${p}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        `Valid roles: ${VALID_ROLES.join(', ')}.`,
      );
    }
  }
  return parts as Role[];
}

const cmd: CommandFn<LoginPayload> = async (flags, ctx): Promise<CommandResult<LoginPayload>> => {
  const flgs = flags as LoginFlags;
  const roleOverride = parseRoleOverride(flgs.role);

  const cfg = loadConfig();
  const profileName =
    flgs.profile ??
    process.env[ENV.PROFILE] ??
    (cfg.activeProfile.length > 0 ? cfg.activeProfile : DEFAULT_PROFILE_NAME);

  // Centralised resolution: flag → LWR_BASE_URL → existing profile.baseUrl
  // → config.defaultBaseUrl → DEFAULT_BASE_URL → throw CONFIG_BASE_URL_MISSING.
  // We never create a stub profile up front — the profile is saved atomically
  // at the end with the full `me` block, so a half-built profile never lands
  // on disk.
  const baseUrl = resolveBaseUrl({
    flagBaseUrl: flgs.baseUrl,
    profileBaseUrl: cfg.profiles[profileName]?.baseUrl,
    configDefaultBaseUrl: cfg.defaultBaseUrl,
  });

  const { apiKey, user, method } = await resolveCredentials(flgs, ctx, baseUrl);
  const client = createClient({ baseUrl, apiKey });

  // Step 1: verify key + fetch the current user with their full membership
  // list. The `?include=memberships` payload powers `Me.memberships`.
  // For the password path the basic-auth exchange already gave us a user,
  // but it lacks memberships — re-call so the data lands.
  const verifiedUser: RedmineUserWithIncludes = await getCurrentUser(client, {
    include: ['memberships', 'groups'],
  });

  // Step 2: prime instance-wide caches. These are independent so we
  // run them in parallel. `getProjectsIndex` returns the entries we'll
  // use to enrich memberships with their identifiers.
  const [statuses, projectsIndex] = await Promise.all([
    listStatuses(client, { noCache: true }),
    getProjectsIndex(client, { noCache: true }),
  ]);
  const identifierFor = makeIdentifierResolver(projectsIndex);

  // Step 3: build the `me` block (identity, roles, fieldMap, memberships)
  // using the projects-index as the identifier resolver.
  const me = await buildMeProfile({
    client,
    user: verifiedUser,
    ctx,
    roleOverride,
    identifierFor: id => identifierFor(id)?.identifier,
  });

  // Step 4: prefetch members for every project the user belongs to.
  // Done sequentially to be polite to Redmine on a fresh login (a few
  // round-trips, but logins are rare so the cost is fine). The result's
  // `source` is always 'live' here because we pass noCache=true.
  const membersForProjects: number[] = [];
  for (const m of me.memberships) {
    try {
      const result = await fetchProjectMembers(client, m.projectId, { noCache: true });
      void result;
      membersForProjects.push(m.projectId);
    } catch {
      // Best-effort — a single project's prefetch failure shouldn't kill
      // login. The lazy path will fetch on first need.
    }
  }

  // Step 5: pick the sticky `activeProject`. Prefer the existing value
  // (logins shouldn't disturb the user's context), only auto-pick when
  // there's none yet.
  const existingActive = cfg.profiles[profileName]?.activeProject;
  const activeProject =
    existingActive ??
    (await recommendActiveProject({
      client,
      user: verifiedUser,
      roles: me.roles,
      fieldMap: me.fieldMap,
      memberships: me.memberships,
      identifierFor,
    }));

  const storage = await setApiKey({ profile: profileName, apiKey });

  // Atomic save: profile + activeProfile pointer in one write.
  const profile: Profile = { baseUrl, activeProject, me };
  saveConfig({
    ...cfg,
    activeProfile: profileName,
    profiles: { ...cfg.profiles, [profileName]: profile },
  });

  // Render the agent-facing snippet last — if anything above throws, we
  // don't leave a stale me.md on disk pointing at credentials we never wrote.
  writeMeMarkdown(me, baseUrl, activeProject);

  void user; // password path returned a basic user; we don't need it once the include-fetch succeeded.
  return {
    json: {
      profile: profileName,
      baseUrl,
      storage,
      method,
      user: { id: verifiedUser.id, login: verifiedUser.login, mail: verifiedUser.mail },
      me: {
        roles: me.roles,
        fieldMap: me.fieldMap,
        membershipCount: me.memberships.length,
      },
      activeProject,
      prefetched: {
        statusesCount: statuses.length,
        projectsIndexCount: projectsIndex.length,
        membersForProjects,
      },
    },
    pretty: c => {
      const who = verifiedUser.login ?? verifiedUser.mail ?? `#${verifiedUser.id}`;
      writeLine(success(c, `Logged in as ${who} (${method})`));
      writeLine(`  profile: ${profileName}`);
      writeLine(`  baseUrl: ${baseUrl}`);
      writeLine(`  storage: ${storage}`);
      const roleSummary = me.roles
        .map(r => {
          const cf = me.fieldMap[r];
          return cf ? `${r} (cf ${cf.cfId})` : r;
        })
        .join(', ');
      writeLine(`  roles:   ${roleSummary}`);
      if (activeProject) {
        writeLine(`  active:  ${activeProject.name} (${activeProject.identifier})`);
      }
      writeLine(
        `  ${dim(c, 'prefetched:')} ${statuses.length} statuses, ${projectsIndex.length} projects, members for ${membersForProjects.length} project(s)`,
      );
    },
  };
};

/**
 * Returns a function that resolves a project id to its `{identifier, name}`
 * from the projects-index. Used to enrich memberships (Redmine's
 * `?include=memberships` returns `{id, name}` only) and to materialise
 * `ActiveProject` records.
 */
function makeIdentifierResolver(
  projects: ProjectIndexEntry[],
): (id: number) => { identifier: string; name: string } | undefined {
  const byId = new Map(projects.map(p => [p.id, { identifier: p.identifier, name: p.name }]));
  return id => byId.get(id);
}

interface ResolvedCreds {
  apiKey: string;
  user: RedmineUser;
  method: 'api-key' | 'password';
}

async function resolveCredentials(
  flgs: LoginFlags,
  ctx: Parameters<CommandFn<unknown>>[1],
  baseUrl: string,
): Promise<ResolvedCreds> {
  const envApiKey = process.env[ENV.API_KEY];

  // 1. Explicit api-key path
  if (flgs.apiKey || envApiKey) {
    const apiKey = (flgs.apiKey ?? envApiKey) as string;
    return { apiKey, user: { id: 0 }, method: 'api-key' };
  }

  // 2. Explicit username/password path (flag-driven; works in non-TTY)
  if (flgs.username) {
    const password =
      flgs.password ??
      (await askPassword({
        ctx,
        message: `Redmine password for "${flgs.username}"`,
        flagHint: '--password',
      }));
    const ex = await exchangeCredsForApiKey({ baseUrl, username: flgs.username, password });
    return { apiKey: ex.apiKey, user: ex.user, method: 'password' };
  }

  // 3. Interactive: choose path. Default = password (friendlier).
  const wantApiKey = flgs.method === 'api-key';

  if (!ctx.interactive) {
    throw new ValidationError(
      'No credentials provided.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass --api-key, or --username (+ --password), or run interactively in a TTY.',
    );
  }

  if (wantApiKey) {
    const apiKey = await askPassword({ ctx, message: 'Redmine API key', flagHint: '--api-key' });
    return { apiKey, user: { id: 0 }, method: 'api-key' };
  }

  const username = await askInput({ ctx, message: 'Redmine username', flagHint: '--username' });
  const password = await askPassword({
    ctx,
    message: `Redmine password for "${username}"`,
    flagHint: '--password',
  });
  const ex = await exchangeCredsForApiKey({ baseUrl, username, password });
  return { apiKey: ex.apiKey, user: ex.user, method: 'password' };
}

export function login(flags: LoginFlags): Promise<never> {
  return runCommand('auth.login', flags, cmd);
}

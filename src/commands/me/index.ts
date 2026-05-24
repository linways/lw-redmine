/**
 * `lwr me {show|detect|set field-map}`
 *
 * Inspect and mutate the per-profile `Me` block (identity + roles +
 * custom-field map). Login auto-builds this; these commands let the agent
 * (or user) inspect or correct it after the fact:
 *
 *   - `lwr me show`             — print the current me block
 *   - `lwr me detect [--role]`  — re-run role detection (after a job
 *                                  change, or to switch hats); `--role
 *                                  <list>` overrides what detection picks
 *   - `lwr me set field-map <role> <cfId> <name>`
 *                                — manual cf override for instances whose
 *                                  custom field names don't match the
 *                                  detector's patterns (e.g., "Lead Dev"
 *                                  instead of "Developer")
 */

import { ERROR_CODES } from '../../constants';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { activeProfile } from '../../foundation/profiles';
import { loadConfig, saveConfig, type FieldMap, type Me, type Role } from '../../foundation/config';
import { buildMeProfile, writeMeMarkdown } from '../../workflow/me';
import { getCurrentUser } from '../../api/users';
import { writeLine } from '../../foundation/output';
import { header, dim, success } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';

const VALID_ROLES: ReadonlyArray<Role> = ['developer', 'tester', 'qa', 'lead'];

// --- show ------------------------------------------------------------------

interface ShowPayload {
  profile: string;
  baseUrl: string;
  me: Me;
}

const showCmd: CommandFn<ShowPayload> = async (flags): Promise<CommandResult<ShowPayload>> => {
  const { name, profile } = activeProfile(flags.profile);
  return {
    json: { profile: name, baseUrl: profile.baseUrl, me: profile.me },
    pretty: ctx => {
      const me = profile.me;
      writeLine(header(ctx, `${me.user.name}  (id: ${me.user.id}, login: ${me.user.login})`));
      writeLine(`  ${dim(ctx, 'profile:')} ${name}`);
      writeLine(`  ${dim(ctx, 'baseUrl:')} ${profile.baseUrl}`);
      writeLine(`  ${dim(ctx, 'roles  :')} ${me.roles.join(', ')}`);
      for (const role of me.roles) {
        const cf = me.fieldMap[role];
        if (cf) writeLine(`           - ${role.padEnd(10)} → cf ${cf.cfId}  "${cf.name}"`);
      }
      writeLine(`  ${dim(ctx, 'updated:')} ${me.detectedAt}`);
    },
  };
};

export function show(flags: GlobalFlags): Promise<never> {
  return runCommand('me.show', flags, showCmd);
}

// --- detect ----------------------------------------------------------------

export interface DetectFlags extends GlobalFlags {
  /**
   * Override role auto-detection. Comma-separated, e.g. `--role
   * developer,tester`. When passed, every listed role is bound to its
   * cf in the active instance (throws if any role's cf is missing).
   */
  role?: string;
}

interface DetectPayload {
  profile: string;
  baseUrl: string;
  me: Me;
}

const detectCmd: CommandFn<DetectPayload> = async (flags, ctx): Promise<CommandResult<DetectPayload>> => {
  const flgs = flags as DetectFlags;
  const roleOverride = parseRoleList(flgs.role);

  const session = await openSession(flgs);
  const user = await getCurrentUser(session.client);

  const me = await buildMeProfile({ client: session.client, user, ctx, roleOverride });

  // Replace the active profile's me block atomically.
  const nextCfg = updateActiveProfileMe(session.profileName, me);
  saveConfig(nextCfg);
  const refreshed = nextCfg.profiles[session.profileName];
  writeMeMarkdown(me, session.baseUrl, refreshed?.activeProject, refreshed?.activeIssue);

  return {
    json: { profile: session.profileName, baseUrl: session.baseUrl, me },
    pretty: c => {
      const summary = me.roles
        .map(r => `${r}=${me.fieldMap[r]?.cfId ?? '?'}`)
        .join(', ');
      writeLine(success(c, `Re-detected roles for ${me.user.name}`));
      writeLine(`  ${dim(c, 'roles:')} ${summary}`);
    },
  };
};

export function detect(flags: DetectFlags): Promise<never> {
  return runCommand('me.detect', flags, detectCmd);
}

// --- set field-map ---------------------------------------------------------

export interface SetFieldMapFlags extends GlobalFlags {
  role?: Role;
  cfId?: number;
  cfName?: string;
}

interface SetFieldMapPayload {
  profile: string;
  me: Me;
}

const setFieldMapCmd: CommandFn<SetFieldMapPayload> = async (flags): Promise<CommandResult<SetFieldMapPayload>> => {
  const flgs = flags as SetFieldMapFlags;

  if (!flgs.role || !(VALID_ROLES as ReadonlyArray<string>).includes(flgs.role)) {
    throw new ValidationError(
      'A valid role is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      `Pass <role> as one of: ${VALID_ROLES.join(', ')}.`,
    );
  }
  if (!flgs.cfId || !Number.isInteger(flgs.cfId) || flgs.cfId <= 0) {
    throw new ValidationError(
      'A positive cfId is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass <cfId> as a positive integer (Redmine custom_field id).',
    );
  }
  if (!flgs.cfName || flgs.cfName.trim().length === 0) {
    throw new ValidationError(
      'A cf name is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass <name> in quotes, e.g. "Lead Developer".',
    );
  }

  const { name: profileName, profile } = activeProfile(flgs.profile);

  // Add the role to roles[] if it isn't already, then bind/overwrite its
  // fieldMap entry. The schema's refine() ensures these stay in sync.
  const roles = profile.me.roles.includes(flgs.role)
    ? profile.me.roles
    : sortRoles([...profile.me.roles, flgs.role]);
  const fieldMap: FieldMap = {
    ...profile.me.fieldMap,
    [flgs.role]: { cfId: flgs.cfId, name: flgs.cfName.trim() },
  };

  const me: Me = {
    ...profile.me,
    roles,
    fieldMap,
    detectedAt: new Date().toISOString(),
  };

  const nextCfg = updateActiveProfileMe(profileName, me);
  saveConfig(nextCfg);
  const refreshed = nextCfg.profiles[profileName];
  writeMeMarkdown(me, profile.baseUrl, refreshed?.activeProject, refreshed?.activeIssue);

  return {
    json: { profile: profileName, me },
    pretty: c => {
      writeLine(success(c, `Set field-map: ${flgs.role} → cf ${flgs.cfId} ("${flgs.cfName}")`));
      writeLine(`  ${dim(c, 'roles:')} ${roles.join(', ')}`);
    },
  };
};

export function setFieldMap(flags: SetFieldMapFlags): Promise<never> {
  return runCommand('me.set.field-map', flags, setFieldMapCmd);
}

// --- internals -------------------------------------------------------------

function parseRoleList(raw: string | undefined): Role[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const parts = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
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

function sortRoles(roles: Role[]): Role[] {
  const set = new Set(roles);
  return VALID_ROLES.filter(r => set.has(r));
}

/**
 * Returns a config transformer that replaces the named profile's `me`
 * block in place. Used by both `detect` and `set field-map` so they go
 * through the same atomic write path.
 */
function updateActiveProfileMe(profileName: string, me: Me) {
  const cfg = loadConfig();
  const existing = cfg.profiles[profileName];
  if (!existing) {
    throw new ValidationError(
      `Profile "${profileName}" not found.`,
      ERROR_CODES.CONFIG_PROFILE_MISSING,
      'Run `lwr auth login` first.',
    );
  }
  return {
    ...cfg,
    profiles: { ...cfg.profiles, [profileName]: { ...existing, me } },
  };
}

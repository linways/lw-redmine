/**
 * Config file CRUD.
 *
 * Reads and writes `~/.lwr/config.json` with zod validation. A missing
 * file yields an in-memory default so first-run commands work without
 * `init` ceremony.
 *
 * Resolution precedence (callers should respect this order):
 *   1. CLI flag
 *   2. Env var
 *   3. Config file (active profile)
 *   4. Hardcoded default in constants/
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors';
import { configDir, configFilePath } from './paths';
import { isAllowedRedmineUrl } from './url';

// --- Schema ---------------------------------------------------------------

/**
 * Custom-field-backed roles. A user is in one of these roles on a given
 * issue when their id appears in that issue's matching custom field
 * (e.g., `Developer` cf 79). A user can simultaneously hold multiple
 * cf-backed roles across different issues; `Me.roles` records all of them.
 *
 * The built-in lenses `assignee` (assigned_to_id) and `reporter` (author_id)
 * are NOT in this enum — they're always available without any profile
 * mapping, so they don't need to be detected or stored.
 */
const RoleSchema = z.enum(['developer', 'tester', 'qa', 'lead']);

/**
 * Per-role binding to the Redmine custom-field on the active instance.
 * Every role listed in `Me.roles` MUST have a corresponding entry here
 * (enforced by `Me.refine` below). Not used for built-in lenses.
 */
const FieldMapSchema = z.object({
  developer: z.object({ cfId: z.number().int().positive(), name: z.string().min(1) }).optional(),
  tester: z.object({ cfId: z.number().int().positive(), name: z.string().min(1) }).optional(),
  qa: z.object({ cfId: z.number().int().positive(), name: z.string().min(1) }).optional(),
  lead: z.object({ cfId: z.number().int().positive(), name: z.string().min(1) }).optional(),
});

/**
 * One project the logged-in user is a member of. Populated from
 * `/users/current.json?include=memberships` at login. The `roles[]`
 * here are Redmine's project-level role names (e.g. "Manager",
 * "Developer", "Tester") — distinct from `Me.roles`, which are the
 * cf-backed lenses the agent uses for issue queries.
 */
const MembershipSchema = z.object({
  projectId: z.number().int().positive(),
  identifier: z.string().min(1),
  name: z.string().min(1),
  roles: z.array(z.string()),
});

/**
 * Per-profile "who am I" block. Always populated by `lwr auth login`; if
 * login can't auto-detect at least one role, it prompts the user (TTY) or
 * accepts `--role developer,tester` (non-TTY, comma-separated).
 *
 * There is no concept of a "primary" role — the user can be a developer
 * on one issue and a tester on another simultaneously. The agent picks
 * the lens at query time from the user's question intent (see SKILL.md);
 * `roles[]` is the menu of options that profile makes available.
 */
const MeSchema = z
  .object({
    user: z.object({
      id: z.number().int().positive(),
      login: z.string().min(1),
      name: z.string().min(1),
    }),
    roles: z.array(RoleSchema).min(1),
    fieldMap: FieldMapSchema,
    /**
     * Every project the user is a member of. Filled at login from
     * `/users/current.json?include=memberships`. The agent reads this as
     * the closed set when the user names a project ("switch to AMS"),
     * and renders it into me.md so the LLM knows the working scope.
     */
    memberships: z.array(MembershipSchema),
    /** ISO timestamp of the last role-detect run (login or `lwr me detect`). */
    detectedAt: z.string().datetime(),
  })
  .refine(
    me => me.roles.every(r => me.fieldMap[r] !== undefined),
    me => ({
      message: `Every role in roles[] must have a fieldMap entry. Missing: ${me.roles.filter(r => me.fieldMap[r] === undefined).join(', ')}`,
      path: ['fieldMap'],
    }),
  );

/**
 * Sticky working-context project. Set automatically at login from the
 * "last activity" heuristic, persisted across sessions, and only
 * mutated by an explicit `lwr project use`. The agent uses this as
 * the implicit `--project` for any question that doesn't name a
 * project; per-call `--project <name>` always overrides.
 *
 * Stored as a full triple to avoid an index lookup on every command;
 * `setAt` is so the agent knows whether the choice is recent or
 * months-old.
 */
const ActiveProjectSchema = z.object({
  id: z.number().int().positive(),
  identifier: z.string().min(1),
  name: z.string().min(1),
  setAt: z.string().datetime(),
});

/**
 * Sticky working-context issue. Mirrors `activeProject` — one issue is
 * "active" at a time per profile, set by `lwr issue use <id>`, and
 * implicitly used as the `--issue` for any command that doesn't name
 * one. Stored as a small render-ready triple so the agent and `me.md`
 * never need to refetch just to display "what am I working on".
 *
 * `status` is the LAST KNOWN status name. The agent should refresh via
 * `lwr issue view <id>` when it matters; this field is for fast display.
 */
const ActiveIssueSchema = z.object({
  id: z.number().int().positive(),
  subject: z.string().min(1),
  project: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
  }),
  tracker: z.string().min(1),
  status: z.string().min(1),
  setAt: z.string().datetime(),
});

const ProfileSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine(isAllowedRedmineUrl, {
      message: 'baseUrl must be https:// (or http:// only for localhost) — other schemes are blocked to prevent API-key leaks.',
    }),
  /** Sticky project — set at login, only changes via `lwr project use`. */
  activeProject: ActiveProjectSchema.optional(),
  /** Sticky issue — only set/changed via `lwr issue use` / `lwr issue clear`. */
  activeIssue: ActiveIssueSchema.optional(),
  me: MeSchema,
});

const UiSchema = z.object({
  theme: z.enum(['auto', 'dark', 'light']).default('auto'),
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  table: z.enum(['rounded', 'ascii', 'minimal']).default('rounded'),
  markdown: z.boolean().default(true),
  images: z.enum(['auto', 'kitty', 'iterm', 'none']).default('auto'),
});

const TuiSchema = z.object({
  refreshIntervalMs: z.number().int().positive().default(30_000),
  defaultView: z.string().default('inbox'),
});

/**
 * Self-growing assistant layer (Phase 3).
 *
 * On by default — the apply-path for `~/.lwr/facts/preferences.json` is
 * always active so rules taught by one agent (Claude/Codex/Copilot) fire
 * for every other agent automatically. Users can opt out via
 * `lwr assistant disable`, which silences the events observer and leaves
 * `~/.lwr/events/*.ndjson` empty; the preferences apply-path is
 * intentionally NOT gated on this flag (it's a vanilla feature, not
 * observation).
 */
const AssistantSchema = z.object({
  enabled: z.boolean().default(true),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  /**
   * Empty string when no profile has been created yet (pre-`auth login`
   * state). Every command that needs the active profile resolves through
   * `resolveProfileName`, which throws `CONFIG_PROFILE_MISSING` when this
   * is empty — surfacing the "user not logged in" condition to the agent.
   */
  activeProfile: z.string(),
  profiles: z.record(z.string(), ProfileSchema),
  /**
   * Bootstrap fallback for the base URL — written by `lwr config base-url
   * <url>` before any profile exists. Sits between `profile.baseUrl` and
   * `DEFAULT_BASE_URL` in the resolution chain, so a forked build (e.g.,
   * the Linways fork that ships `DEFAULT_BASE_URL = 'https://redmine…'`)
   * still works out-of-the-box, and a public-repo user can set it via the
   * agent-callable command without editing source.
   *
   * Inert after `auth login` succeeds (profile.baseUrl takes over).
   */
  defaultBaseUrl: z.string().optional(),
  ui: UiSchema.default({
    theme: 'auto',
    color: 'auto',
    table: 'rounded',
    markdown: true,
    images: 'auto',
  }),
  tui: TuiSchema.default({ refreshIntervalMs: 30_000, defaultView: 'inbox' }),
  assistant: AssistantSchema.default({ enabled: true }),
});

export type Role = z.infer<typeof RoleSchema>;
export type FieldMap = z.infer<typeof FieldMapSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type Me = z.infer<typeof MeSchema>;
export type ActiveProject = z.infer<typeof ActiveProjectSchema>;
export type ActiveIssue = z.infer<typeof ActiveIssueSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Assistant = z.infer<typeof AssistantSchema>;
export type LwrConfig = z.infer<typeof ConfigSchema>;

// --- Defaults --------------------------------------------------------------

/**
 * The empty pre-login state. No profiles, no active profile. The first
 * successful `lwr auth login` populates a profile and points
 * `activeProfile` at it.
 */
export function defaultConfig(): LwrConfig {
  return {
    version: 1,
    activeProfile: '',
    profiles: {},
    ui: { theme: 'auto', color: 'auto', table: 'rounded', markdown: true, images: 'auto' },
    tui: { refreshIntervalMs: 30_000, defaultView: 'inbox' },
    assistant: { enabled: true },
  };
}

// --- IO --------------------------------------------------------------------

/** Load config, returning defaults if the file is missing. Throws on malformed. */
export function loadConfig(): LwrConfig {
  const file = configFilePath();
  if (!fs.existsSync(file)) return defaultConfig();

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Failed to read config file: ${file}`, undefined, undefined, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `Config file is not valid JSON: ${file}`,
      undefined,
      'Fix or delete the file; defaults will be re-created.',
      cause,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file failed validation: ${file}`,
      undefined,
      result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      result.error,
    );
  }
  return result.data;
}

/** Save config atomically (write to tmp, then rename). Mode 0600. */
export function saveConfig(cfg: LwrConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Update config with a transformer. Returns the new config. */
export function updateConfig(fn: (cfg: LwrConfig) => LwrConfig): LwrConfig {
  const next = fn(loadConfig());
  saveConfig(next);
  return next;
}

// --- Helpers ---------------------------------------------------------------

/** Path to where the config file lives — exposed so commands can hint about it. */
export function configFile(): string {
  return configFilePath();
}

/** Convenience: ensures the config dir exists before sibling writes (auth, cache). */
export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Re-export so other modules don't need to import from `paths` directly. */
export { configDir };
export const _internalsForTests = { ConfigSchema, path };

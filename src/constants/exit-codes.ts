/**
 * Process exit codes.
 *
 * Distinct numeric codes let AI agents and CI pipelines branch on failure
 * mode without parsing stderr. Codes are part of the CLI's public contract;
 * changing them is a breaking change.
 */

export const EXIT = {
  OK: 0,
  USER: 1, // generic user-facing failure (e.g. TUI launched in non-TTY)
  AUTH: 2, // 401 / 403 / missing API key
  NETWORK: 3, // connection refused, DNS, timeout, retries exhausted
  NOT_FOUND: 4, // 404
  SERVER: 5, // 5xx after retries
  CONFIG: 6, // malformed config file, profile not found, etc.
  VALIDATION: 7, // bad flag, missing required value, 422 from API
  INTERNAL: 10, // bug in `lwr` itself — should be reported
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Stable error code strings emitted in the `--json` envelope's `error.code`
 * field. AI agents are encouraged to branch on these instead of message text.
 */
export const ERROR_CODES = {
  // Auth
  AUTH_MISSING: 'AUTH_MISSING',
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',

  // Resource
  NOT_FOUND: 'NOT_FOUND',

  // Network
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  NETWORK_REFUSED: 'NETWORK_REFUSED',
  NETWORK_DNS: 'NETWORK_DNS',
  RATE_LIMITED: 'RATE_LIMITED',

  // Server
  SERVER_ERROR: 'SERVER_ERROR',

  // Config
  CONFIG_MALFORMED: 'CONFIG_MALFORMED',
  CONFIG_PROFILE_MISSING: 'CONFIG_PROFILE_MISSING',
  /**
   * No base URL resolved through the chain: --base-url flag, LWR_BASE_URL
   * env, active profile, config.defaultBaseUrl, DEFAULT_BASE_URL constant.
   * Agents should ask the user for their Redmine URL once, then call
   * `lwr config base-url <url>` to persist it.
   */
  CONFIG_BASE_URL_MISSING: 'CONFIG_BASE_URL_MISSING',

  // Validation
  VALIDATION_MISSING_FLAG: 'VALIDATION_MISSING_FLAG',
  VALIDATION_BAD_VALUE: 'VALIDATION_BAD_VALUE',
  VALIDATION_API_REJECTED: 'VALIDATION_API_REJECTED',
  /**
   * The requested status transition is not in the issue's allowed_statuses
   * list. Carries `details.allowed: [{id,name}]` so agents can pick a valid
   * target without re-fetching.
   */
  WORKFLOW_NOT_ALLOWED: 'WORKFLOW_NOT_ALLOWED',
  /**
   * No user matched the provided login / name in the searched scope
   * (project members, /users.json, or manual fallback list). `details`
   * names the scope that was searched so agents can widen the next attempt.
   */
  VALIDATION_USER_NOT_FOUND: 'VALIDATION_USER_NOT_FOUND',
  /**
   * Multiple users matched the provided login / name. `details.candidates`
   * is `[{id, login, name}]` so the agent can pick one and retry with the
   * exact id.
   */
  VALIDATION_AMBIGUOUS_USER: 'VALIDATION_AMBIGUOUS_USER',
  /**
   * No project matched the provided id, identifier, or name in the
   * cached project index (or after a forced refresh). `details.query`
   * names what was searched.
   */
  VALIDATION_PROJECT_NOT_FOUND: 'VALIDATION_PROJECT_NOT_FOUND',
  /**
   * Multiple projects matched the provided name. `details.candidates`
   * is `[{id, identifier, name}]` so the agent can pick one and retry
   * with the id or identifier.
   */
  VALIDATION_AMBIGUOUS_PROJECT: 'VALIDATION_AMBIGUOUS_PROJECT',
  /**
   * `--cf <name>=<value>` referenced a custom-field name that isn't in
   * the opportunistic catalog at `~/.lwr/cache/custom-fields.json`.
   * `details.query` is the raw key; `details.known` lists the cf names
   * we've ever observed (from prior issue payloads). The agent can pick
   * one and retry, or pass the numeric id directly.
   */
  VALIDATION_CF_NOT_FOUND: 'VALIDATION_CF_NOT_FOUND',
  /**
   * The cf-name lookup matched more than one catalog entry — shouldn't
   * happen on Redmine (cf names are unique) but possible after a rename.
   * `details.candidates` is `[{id, name}]`; pick one and retry by id.
   */
  VALIDATION_AMBIGUOUS_CF: 'VALIDATION_AMBIGUOUS_CF',

  // Preferences (cross-agent shared brain — ~/.lwr/facts/preferences.json)
  /**
   * The preferences file exists but isn't valid JSON. Non-fatal on load:
   * the apply-path proceeds with no rules and surfaces this code in
   * `meta.warnings[]`. Fatal on `lwr prefs add/remove` write — the
   * agent must know its teach didn't land.
   */
  PREFERENCES_PARSE_ERROR: 'PREFERENCES_PARSE_ERROR',
  /**
   * Preferences file has a `schema` field that isn't `lwr-preferences/v1`.
   * Non-fatal on load; fatal on write. Prevents a forward-compatible
   * future-schema file from being silently downgraded.
   */
  PREFERENCES_SCHEMA_MISMATCH: 'PREFERENCES_SCHEMA_MISMATCH',
  /**
   * Two rules share an `id` at load (`meta.warnings[]`), or `prefs add`
   * was called with an explicit `--id` that already exists (fatal — the
   * agent should call `prefs remove` first or pick a new id).
   */
  PREFERENCES_DUPLICATE_RULE_ID: 'PREFERENCES_DUPLICATE_RULE_ID',
  /** `lwr prefs remove <id>` was called with an unknown id. */
  PREFERENCES_RULE_NOT_FOUND: 'PREFERENCES_RULE_NOT_FOUND',
  /**
   * `lwr prefs add` invoked in a non-TTY context without `--reason`.
   * Forces every agent-written rule to quote the user, so future
   * `lwr prefs list` is auditable.
   */
  PREFERENCES_REASON_REQUIRED: 'PREFERENCES_REASON_REQUIRED',
  /**
   * `lwr prefs add` invoked in a non-TTY context without `--agent`.
   * Tags every rule with which agent (claude-code / codex / copilot / …)
   * wrote it, so the user can spot a misbehaving agent without git-archaeology.
   */
  PREFERENCES_AGENT_REQUIRED: 'PREFERENCES_AGENT_REQUIRED',

  // TUI
  TUI_REQUIRES_TTY: 'TUI_REQUIRES_TTY',

  // MCP (raised by `lwr serve` when a `tools/call` cannot be dispatched
  // — unknown tool name, argv-build failure, spawn failure, empty stdout
  // from the spawned `lwr`, or the spawn timing out. Carries no Redmine
  // signal; it's a wrapper-layer error agents branch on to retry vs.
  // surface to the user.)
  MCP_DISPATCH: 'MCP_DISPATCH',

  // Backup / restore
  /**
   * `lwr restore <file>` couldn't read or parse the bundle: file missing,
   * unreadable, not a gzipped JSON envelope, wrong schema string, or
   * exceeded BACKUP_MAX_BYTES. Agents should re-list with `lwr backup
   * list` and retry by name; never re-create a missing bundle on their own.
   */
  BACKUP_BUNDLE_INVALID: 'BACKUP_BUNDLE_INVALID',

  // Catch-all
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

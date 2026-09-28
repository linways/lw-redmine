/**
 * Configuration defaults, file-system layout, and HTTP behaviour.
 *
 * Anything a forker would reasonably want to retarget — base URL, state
 * directory, retry policy, page sizes — lives in this file.
 */

// --- Redmine target ---------------------------------------------------------

/**
 * Compile-time fallback base URL. Empty in the public/showcase repo —
 * users (or AI agents on their behalf) set the URL at runtime via
 * `lwr config base-url <url>`. A fork that targets a single deployment
 * can hard-code its URL here (the Linways fork does, which is why
 * Linways users see zero setup on first install).
 *
 * Resolution chain (top wins):
 *   --base-url flag  →  LWR_BASE_URL env  →  profile.baseUrl
 *   →  config.defaultBaseUrl (runtime override)  →  DEFAULT_BASE_URL
 *   →  throws CONFIG_BASE_URL_MISSING
 */
export const DEFAULT_BASE_URL = 'https://redmine.linways.com';

// --- File system layout ----------------------------------------------------
//
// `lwr` owns its own dotdir at `~/.lwr/`. All state — config, auth fallback,
// metadata cache, per-issue downloads — lives under this single root, so
// there's exactly one path to clean up and zero chance of clashing with
// files written by `lw-cli` or any other tool.

export const CONFIG_ROOT = '.lwr';
export const CONFIG_FILE = 'config.json';
export const AUTH_FILE_FALLBACK = 'auth.json';
export const ATTACHMENT_TMP_DIR = '/tmp/lwr';

/**
 * Per-profile rendered "who am I" snippet (`~/.lwr/me.md`).
 *
 * Auto-written every time `buildMeProfile` produces a new `me` block. The
 * SKILL.md instructs every agent to read this file before interpreting
 * "me / my issues / my work" in a question.
 */
export const ME_FILE = 'me.md';

/** Per-issue fetch directory: `~/.lwr/issues/<id>/`. */
export const ISSUES_DIR_NAME = 'issues';

// --- Feedback (Phase 1 — agent capability-gap log) -------------------------
//
// One markdown file per incident under `~/.lwr/feedback/<UTC-date>/`.
// Designed for weekly `tar` + manual review by the maintainer; agents
// write through `lwr feedback log`, users read via `lwr feedback list/show`.
// See FEEDBACK_SPEC.md for the full design.

/** Subdirectory under `~/.lwr/` for incident-log files. */
export const FEEDBACK_DIR = 'feedback';

/**
 * Schema string stamped into every file's frontmatter. Bumped on
 * breaking shape changes so future readers can refuse stale layouts
 * rather than mis-parse.
 */
export const FEEDBACK_SCHEMA_VERSION = 'lwr-feedback/v1';

/** Allowed values for the `kind:` frontmatter field. */
export const FEEDBACK_KINDS = ['gap', 'error'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * Agents the spec recognises as upstream callers. `cli` is the manual
 * fallback when a human types `lwr feedback log` directly. Anything
 * else is rejected by `--agent` to keep grep-by-agent reliable for the
 * maintainer.
 */
export const FEEDBACK_AGENTS = ['claude-code', 'codex', 'gemini', 'cli'] as const;
export type FeedbackAgent = (typeof FEEDBACK_AGENTS)[number];

/** Default `agent:` value when `--agent` is not passed. */
export const FEEDBACK_AGENT_DEFAULT: FeedbackAgent = 'cli';

/** Max characters of `query`/`reason` retained in the `summary` field of `list`. */
export const FEEDBACK_SUMMARY_MAX_CHARS = 80;

/** Default `list` window in days (used when no --since/--week/--month flag). */
export const FEEDBACK_LIST_DEFAULT_DAYS = 7;

/** `~/.lwr/feedback/2026-05-11/065132-gap-set-tester.md`. */
export const feedbackEntryFile = (timeUtc: string, kind: FeedbackKind, slug: string): string =>
  `${timeUtc}-${kind}-${slug}.md`;

/**
 * Remote-mirror webhook for `lwr feedback log`. Every successful local
 * write also POSTs one row to this Google Form (which appends to a
 * linked sheet) so the maintainer sees incidents in real time instead
 * of waiting for a weekly `tar` bundle.
 *
 * **On by default for any non-empty FORM_URL.** Two ways to disable:
 *
 * - Set `FORM_URL: ''` here (forks, or self-hosted lwr without a sheet).
 * - Export `LWR_FEEDBACK_NO_WEBHOOK=1` in the shell (CI / scripted
 *   contexts that don't want to leak rows into the team sheet).
 *
 * The local file at `~/.lwr/feedback/...` remains the source of truth;
 * the sheet is a real-time mirror. POST failure → debug-level stderr
 * only; never blocks the command, never affects the exit code, local
 * file is already on disk.
 *
 * **Schema lock:** the FIELDS map below must match the form's entry
 * ids 1:1. Changing the schema means regenerating the form using the
 * prompt in `FEEDBACK_SPEC.md` (Appendix) and pasting the new entry
 * ids back into this file. A schema/form mismatch shows up as rows
 * landing in the wrong columns.
 */
export type FeedbackWebhookField =
  | 'recorded_at'
  | 'kind'
  | 'slug'
  | 'user_login'
  | 'user_name'
  | 'user_redmine_id'
  | 'lwr_version'
  | 'profile'
  | 'agent'
  | 'issue_context'
  | 'command'
  | 'exit_code'
  | 'error_code'
  | 'body_md';

export const FEEDBACK_WEBHOOK: {
  FORM_URL: string;
  FIELDS: Record<FeedbackWebhookField, string>;
  TIMEOUT_MS: number;
} = {
  FORM_URL:
    'https://docs.google.com/forms/d/e/1FAIpQLSexeEMfKpr-w_kBXYcybnqjDOic8psUWYDskjp828tJ5xGkhA/formResponse',
  FIELDS: {
    recorded_at: 'entry.1786956419',
    kind: 'entry.981789315',
    slug: 'entry.1819677823',
    user_login: 'entry.2089452673',
    user_name: 'entry.1093021993',
    user_redmine_id: 'entry.557291823',
    lwr_version: 'entry.1120959178',
    profile: 'entry.1159857469',
    agent: 'entry.1540787189',
    issue_context: 'entry.120555273',
    command: 'entry.930076485',
    exit_code: 'entry.688603449',
    error_code: 'entry.6836318',
    body_md: 'entry.1322352361',
  },
  /**
   * Hard cap on the POST round-trip. Tight on purpose — agents call
   * `feedback log` synchronously and we don't want a flaky Google
   * Forms endpoint blocking a turn. 3s covers a healthy round-trip
   * with margin; anything beyond is treated as a failed mirror.
   */
  TIMEOUT_MS: 3_000,
};

/**
 * Plain-JSON metadata cache root (`~/.lwr/cache/`). Used for the
 * statuses dictionary, per-project member lists, and the user-supplied
 * fallback list. SQLite was considered and skipped — flat files keep
 * the cache trivially inspectable and consistent with `~/.lwr/issues/`.
 */
export const CACHE_DIR_NAME = 'cache';
export const CACHE_FILE_NAMES = {
  STATUSES: 'statuses.json',
  /**
   * Instance-wide time-entry activity dictionary
   * (`/enumerations/time_entry_activities.json`). Used by `lwr time log`
   * to resolve `--activity Development` → numeric id without a round-trip
   * on every log. Refreshed daily.
   */
  ACTIVITIES: 'activities.json',
  /**
   * Instance-wide project dictionary `{id, identifier, name}` — the
   * id ↔ name map an agent uses to translate "Linways AMS V4" → 51
   * before calling any other command. Refreshed at most once per day.
   */
  PROJECTS_INDEX: 'projects-index.json',
  /** Sub-directory: `~/.lwr/cache/projects/<pid>.json`. */
  PROJECTS_DIR: 'projects',
  /**
   * User-supplied fallback list (`lwr user import`). Sacred — the cache
   * layer never overwrites this automatically; a manual `cache clear
   * --type users` is required to drop it.
   */
  USERS_MANUAL: 'users-manual.json',
  /**
   * Opportunistic custom-field name ↔ id catalog. Populated as a side
   * effect of every issue fetch/list response that carries
   * `custom_fields: [{id, name, ...}]` — `/custom_fields.json` is
   * admin-only on most Redmine installs, so we accumulate the map from
   * data already passing through the client. Used by the `--cf` setter
   * to resolve `--cf "Tester=Alex Biju"` → `{ id: 88, value: <userId> }`.
   */
  CUSTOM_FIELDS: 'custom-fields.json',
  META: 'meta.json',
} as const;

/** Files written into each `~/.lwr/issues/<id>/` folder. */
export const ISSUE_FILE = {
  RAW_JSON: 'issue.json',
  MARKDOWN: 'issue.md',
  MANIFEST: 'manifest.json',
} as const;

// --- Attachment converters -------------------------------------------------
//
// Binary names and probe args are pulled out so a fork can swap pdftoppm for
// `mutool draw`, point at a LibreOffice fork, etc. Install hints are colocated
// since they're the natural "missing dependency" surface.

export const CONVERTER_BIN = {
  PDFTOPPM: 'pdftoppm',
  LIBREOFFICE: 'libreoffice',
} as const;

export const CONVERTER_PROBE_ARGS = {
  PDFTOPPM: ['-v'],
  LIBREOFFICE: ['--version'],
} as const;

export const CONVERTER_INSTALL_HINTS = {
  PDFTOPPM: {
    darwin: 'brew install poppler',
    linux: 'sudo apt install poppler-utils   # or: sudo yum install poppler-utils',
  },
  LIBREOFFICE: {
    darwin: 'brew install --cask libreoffice',
    linux: 'sudo apt install libreoffice   # or: sudo yum install libreoffice',
  },
} as const;

// --- Credential storage ----------------------------------------------------
//
// One keytar service ('lwr') is shared by every profile on the same OS
// user — by design. Per-profile isolation is achieved through the
// account string (`<profile>:apiKey`) so two installs targeting different
// Redmine instances don't collide. A separate OS user gets a separate
// keychain bucket; a single OS user with multiple profiles gets one
// shared bucket with namespaced accounts.

export const KEYTAR_SERVICE = 'lwr';
export const KEYTAR_ACCOUNT = (profile: string) => `${profile}:apiKey`;

/**
 * Budget for $LWR_API_KEY_COMMAND. Keeps the "never hang in non-TTY"
 * contract honest when a secret broker is down — a stuck unix-socket
 * call or a network-backed vault must fail, not block an agent forever.
 */
export const KEY_COMMAND_TIMEOUT_MS = 10_000;

// --- HTTP -------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 15_000;
export const HTTP_RETRY_COUNT = 3;
export const HTTP_RETRY_BASE_MS = 500;

/**
 * Wire content-type for Redmine's two-step attachment upload — POST to
 * `/uploads.json` requires a raw octet-stream body. Centralised here so
 * forks can override (some Redmine plugins gate uploads on a custom
 * content-type).
 */
export const REDMINE_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

// --- MCP --------------------------------------------------------------------

/**
 * Per-call timeout when the MCP server spawns a fresh `lwr` subprocess
 * to handle a `tools/call`. Each tool's HTTP layer has its own retry
 * budget (~45s worst-case at HTTP_TIMEOUT_MS × HTTP_RETRY_COUNT), so
 * this MUST be at least that high or slow Redmine round-trips are
 * killed mid-write.
 */
export const MCP_DISPATCH_TIMEOUT_MS = 60_000;

// --- Pagination ------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// --- Input bounds ----------------------------------------------------------

/**
 * Hard cap on the size of a `lwr user import <file>` payload. Defends
 * against an accidental drag-and-drop of a multi-GB blob OOM-ing the CLI.
 * 10 MB is well above any plausible Linways user roster (~10k users at
 * 1 KB/entry).
 */
export const USER_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

// --- Cache TTLs (used in Phase 2) -----------------------------------------

export const CACHE_TTL_MS = {
  STATUSES: 24 * 60 * 60 * 1000, // 1 day
  ACTIVITIES: 24 * 60 * 60 * 1000, // 1 day — same shape as statuses
  PRIORITIES: 24 * 60 * 60 * 1000,
  TRACKERS: 24 * 60 * 60 * 1000,
  /**
   * Project list (id ↔ name dictionary). Long TTL because new Redmine
   * projects appear rarely — agents only hit cache misses on the day
   * a brand-new project shows up, and `lwr cache refresh` fixes that.
   */
  PROJECTS_INDEX: 24 * 60 * 60 * 1000, // 1 day
  PROJECTS: 60 * 60 * 1000, // 1 hour
  MEMBERS: 60 * 60 * 1000,
  VERSIONS: 60 * 60 * 1000,
  RECENT_ISSUES: 5 * 60 * 1000, // 5 min
} as const;

// --- Environment variable names -------------------------------------------
//
// Using a single namespace prefix keeps surface visible and fork-friendly.

export const ENV = {
  BASE_URL: 'LWR_BASE_URL',
  PROFILE: 'LWR_PROFILE',
  API_KEY: 'LWR_API_KEY',
  /**
   * Shell command that prints the API key on stdout. Resolved fresh on
   * every invocation and never persisted — the backend for secret brokers
   * that can't inject an env var into a CLI process (Muse/Jarvis authd,
   * 1Password `op read`, `pass`, Vault, gcloud secrets).
   */
  API_KEY_COMMAND: 'LWR_API_KEY_COMMAND',
  NO_INTERACTIVE: 'LWR_NO_INTERACTIVE',
  DEBUG: 'LWR_DEBUG',
  CONFIG_DIR: 'LWR_CONFIG_DIR', // override for tests
  /**
   * Opt out of the `feedback log` remote-mirror POST for this invocation
   * (or this whole shell, if exported). Local file is still written —
   * only the Google Form POST is skipped. For CI / scripted contexts
   * where the team-sheet noise isn't wanted.
   */
  FEEDBACK_NO_WEBHOOK: 'LWR_FEEDBACK_NO_WEBHOOK',
} as const;

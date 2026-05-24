/**
 * Self-growing assistant layer — constants.
 *
 * Plug-and-play opt-in feature group (Phase 3). Off by default; nothing
 * here causes side effects until `lwr assistant enable` flips the bit.
 *
 * This file declares the directory layout + retention windows up front so
 * later tiers (events log, inferred preferences, taught knowledge) all
 * read from one place. Per the project's constants-files rule, anything
 * a forker would reasonably retarget lives here.
 */

/** Subdirectory under `~/.lwr/` for append-only behaviour event logs. */
export const ASSISTANT_EVENTS_DIR = 'events';

/** Subdirectory under `~/.lwr/` for taught/inferred fact JSON files. */
export const ASSISTANT_FACTS_DIR = 'facts';

/**
 * Schema version stamped on every `facts/preferences.json` write. Loader
 * rejects (with `PREFERENCES_SCHEMA_MISMATCH`) anything else so a forward-
 * compatible future format can't be silently downgraded.
 */
export const PREFERENCES_SCHEMA = 'lwr-preferences/v1';

/**
 * Filenames inside `~/.lwr/events/`. Each is newline-delimited JSON,
 * one event per line, append-only. Retention window is enforced by
 * `lwr events prune` (and lazily on append).
 */
export const ASSISTANT_EVENT_FILES = {
  /** Every command run with its flags + resolved values. ~200 B/line. */
  COMMANDS: 'commands.ndjson',
  /** Every agent-driven mutation with reasoning. ~500 B/line. */
  DECISIONS: 'decisions.ndjson',
  /** User corrections to agent decisions. Kept longer (high-signal). */
  OVERRIDES: 'overrides.ndjson',
} as const;

/**
 * Filenames inside `~/.lwr/facts/`. Each is canonical JSON, source of
 * truth for the assistant's "what it has learned / been told". Bounded
 * size — the assistant never writes Redmine-derived state here.
 */
export const ASSISTANT_FACT_FILES = {
  /** Team lead's mental model of who knows what. */
  TEAM_KNOWLEDGE: 'team-knowledge.json',
  /** Inferred user preferences (defaults, disambiguators). */
  PREFERENCES: 'preferences.json',
  /** Inferred org-workflow rules. */
  ORG_PATTERNS: 'org-patterns.json',
  /** Communication patterns (templates, frequent stakeholders). */
  COMMUNICATION: 'communication.json',
  /** Active reminders / follow-ups. */
  FOLLOW_UPS: 'follow-ups.json',
} as const;

/**
 * Retention window for behaviour events, in milliseconds. Beyond this,
 * events are pruned on the next assistant op. Long enough to derive
 * recent patterns; short enough that the on-disk footprint stays
 * inspectable with `tail`/`jq`.
 */
export const ASSISTANT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Override events kept longer than commands/decisions — they're the
 * highest-signal data for refining the agent's model and they're rare.
 */
export const ASSISTANT_OVERRIDE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

/**
 * Commands the observer skips when assistant is enabled. Observing
 * these would be noise:
 *   - `assistant.*` would self-observe every toggle
 *   - `events.*` would self-observe every inspection
 *   - `commands` is high-frequency agent introspection (boring)
 *   - `serve` is the long-running MCP server itself; per-tool
 *     subprocess invocations are observed separately
 */
export const EXCLUDED_FROM_OBSERVATION: ReadonlySet<string> = new Set([
  'assistant.enable',
  'assistant.disable',
  'assistant.status',
  'events.status',
  'commands',
  'serve',
]);

/**
 * Flag-name patterns for redaction in the event log:
 *   - SECRET keys are dropped entirely (api keys, passwords).
 *   - PROSE keys keep only `<name>Length` so we can detect "user
 *     usually attaches a 200-char note" without recording the body.
 */
export const REDACT_SECRET_FLAG_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'password',
  'token',
  'secret',
]);

export const REDACT_PROSE_FLAG_KEYS: ReadonlySet<string> = new Set([
  'message',
  'description',
  'descriptionFile',
  'notes',
  'comments',
  'body',
  'messageFile',
  'notesFile',
]);

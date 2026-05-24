/**
 * Per-command safety + idempotency annotations.
 *
 * The single source of truth for "what does this command do to the world":
 *   - safety:       read | mutate | destructive
 *   - idempotent:   does running it twice yield the same end state?
 *   - network:      does it reach Redmine?
 *
 * Used by `lwr commands` to give agents a machine-readable safety map of
 * the CLI surface, and (later) by the MCP layer to populate
 * tool-list metadata.
 *
 * Keys are dotted command paths matching the `command` field of the JSON
 * envelope (e.g. `issue.note` — same string `runCommand` is called with).
 *
 * Conventions:
 *   - "destructive" implies data loss that the user/agent cannot trivially
 *     reverse (deletes a remote resource, removes credentials, wipes
 *     ~/.lwr/). All destructive verbs are gated by `confirmDestructive`.
 *   - "mutate" covers anything that changes server or local state but
 *     where re-running with identical inputs converges (e.g. `issue edit`
 *     setting the same status).
 *   - "read" is purely fetch + render. No POST/PUT/DELETE on Redmine and
 *     no writes to ~/.lwr/ (cache writes are an internal optimisation,
 *     not a user-visible state change, and don't flip the bit here).
 *   - POST endpoints that create a *new* resource on each call are
 *     `idempotent: false` (e.g. `time.log`, `issue.create`, `issue.note`,
 *     `issue.attach`). PUT and DELETE are idempotent in the REST sense.
 *
 * If you add a new command, add its entry here. The `lwr commands` test
 * walks the registered tree and asserts every leaf has an annotation —
 * forgetting one fails CI rather than shipping unannotated.
 */

export type Safety = 'read' | 'mutate' | 'destructive';

export interface CommandAnnotation {
  safety: Safety;
  idempotent: boolean;
  network: boolean;
}

export const COMMAND_ANNOTATIONS: Record<string, CommandAnnotation> = {
  // --- auth ----------------------------------------------------------------
  'auth.login': { safety: 'mutate', idempotent: true, network: true },
  'auth.logout': { safety: 'destructive', idempotent: true, network: false },
  'auth.whoami': { safety: 'read', idempotent: true, network: true },

  // --- profile -------------------------------------------------------------
  'profile.list': { safety: 'read', idempotent: true, network: false },
  'profile.use': { safety: 'mutate', idempotent: true, network: false },
  'profile.remove': { safety: 'destructive', idempotent: true, network: false },

  // --- me ------------------------------------------------------------------
  'me.show': { safety: 'read', idempotent: true, network: false },
  'me.detect': { safety: 'mutate', idempotent: true, network: true },
  'me.set.field-map': { safety: 'mutate', idempotent: true, network: false },

  // --- project -------------------------------------------------------------
  'project.list': { safety: 'read', idempotent: true, network: true },
  'project.use': { safety: 'mutate', idempotent: true, network: true },
  'project.members': { safety: 'read', idempotent: true, network: true },
  'project.versions': { safety: 'read', idempotent: true, network: true },
  'project.resolve': { safety: 'read', idempotent: true, network: true },

  // --- issue ---------------------------------------------------------------
  'issue.use': { safety: 'mutate', idempotent: true, network: true },
  // Network: true because the verb live-refreshes the sticky issue's
  // status from Redmine before display (auto-clears if it turned out
  // closed). Falls back to cached + freshness label on network failure.
  'issue.current': { safety: 'read', idempotent: true, network: true },
  'issue.active': { safety: 'read', idempotent: true, network: true },
  // PUT status=Resolved is idempotent; the POST time entry is not — re-running
  // creates a duplicate time entry. So the verb as a whole is not idempotent.
  'issue.resolve': { safety: 'mutate', idempotent: false, network: true },
  'issue.clear': { safety: 'mutate', idempotent: true, network: true },
  // Removes ~/.lwr/issues/<id>/ directories — destructive (data loss),
  // but trivially recoverable via `lwr issue fetch`. Local-only.
  'issue.prune': { safety: 'destructive', idempotent: true, network: false },
  // With --status: PUT to Redmine + local close. Without: local close only.
  // Either way idempotent in the REST sense — re-running converges (issue
  // already at the target status; session already closed → NotFound).
  'issue.pause': { safety: 'mutate', idempotent: true, network: true },

  // --- log -----------------------------------------------------------------
  'log.show': { safety: 'read', idempotent: true, network: false },
  // Destructive: removes files. `--before` is required so this can't
  // accidentally wipe everything.
  'log.clear': { safety: 'destructive', idempotent: true, network: false },

  // --- feedback (Phase 1: capability-gap incident log) --------------------
  // Each call writes a brand-new file (timestamped path); re-running with
  // identical args creates a separate file, so not idempotent.
  // Network is true because the remote-mirror POST to the configured
  // Google Form fires by default (FEEDBACK_WEBHOOK.FORM_URL). Disabling
  // the mirror — empty FORM_URL, or LWR_FEEDBACK_NO_WEBHOOK=1 — makes
  // the actual call network-free, but the annotation reflects the
  // default-config behaviour.
  'feedback.log': { safety: 'mutate', idempotent: false, network: true },
  'feedback.list': { safety: 'read', idempotent: true, network: false },
  'feedback.show': { safety: 'read', idempotent: true, network: false },
  // prefs — cross-agent shared brain (writes ~/.lwr/facts/preferences.json,
  // no Redmine round-trip beyond cf-name resolution in `add`). `remove` is
  // intentionally `mutate` (not destructive) — a removed rule is trivially
  // re-taught via `prefs add`, so requiring `--confirm` would add friction
  // to the agent's primary correction path.
  'prefs.add': { safety: 'mutate', idempotent: true, network: true },
  'prefs.remove': { safety: 'mutate', idempotent: true, network: false },
  'prefs.list': { safety: 'read', idempotent: true, network: false },

  'issue.list': { safety: 'read', idempotent: true, network: true },
  'issue.view': { safety: 'read', idempotent: true, network: true },
  // POST creates a brand-new issue every call → not idempotent.
  'issue.create': { safety: 'mutate', idempotent: false, network: true },
  'issue.edit': { safety: 'mutate', idempotent: true, network: true },
  // Local materialisation; re-runs converge (--force re-downloads).
  'issue.fetch': { safety: 'mutate', idempotent: true, network: true },
  // Each call uploads + appends to the journal — not idempotent.
  'issue.attach': { safety: 'mutate', idempotent: false, network: true },
  'issue.status': { safety: 'mutate', idempotent: true, network: true },
  'issue.close': { safety: 'mutate', idempotent: true, network: true },
  'issue.assign': { safety: 'mutate', idempotent: true, network: true },
  'issue.watch': { safety: 'mutate', idempotent: true, network: true },
  'issue.unwatch': { safety: 'mutate', idempotent: true, network: true },
  // Computes the canonical URL; --browser launches but no server mutation.
  'issue.open': { safety: 'read', idempotent: true, network: false },
  'issue.transitions': { safety: 'read', idempotent: true, network: true },
  // Each call appends a new journal — not idempotent.
  'issue.note': { safety: 'mutate', idempotent: false, network: true },

  // --- time ----------------------------------------------------------------
  // POST creates a new time entry every call.
  'time.log': { safety: 'mutate', idempotent: false, network: true },
  'time.list': { safety: 'read', idempotent: true, network: true },
  'time.edit': { safety: 'mutate', idempotent: true, network: true },
  'time.delete': { safety: 'destructive', idempotent: true, network: true },
  'time.activities': { safety: 'read', idempotent: true, network: true },

  // --- search / status / user ---------------------------------------------
  'search': { safety: 'read', idempotent: true, network: true },
  'status.list': { safety: 'read', idempotent: true, network: true },
  'user.list': { safety: 'read', idempotent: true, network: true },
  // Writes a manual-fallback file; same bytes → same end state.
  'user.import': { safety: 'mutate', idempotent: true, network: false },
  'user.resolve': { safety: 'read', idempotent: true, network: true },

  // --- cache ---------------------------------------------------------------
  'cache.list': { safety: 'read', idempotent: true, network: false },
  'cache.clear': { safety: 'destructive', idempotent: true, network: false },
  'cache.refresh': { safety: 'mutate', idempotent: true, network: true },

  // --- assistant (Phase 3 opt-in) ------------------------------------------
  // All three are local-only flag flips. `enable` and `disable` mutate the
  // persisted config; `status` is a pure read.
  'assistant.enable': { safety: 'mutate', idempotent: true, network: false },
  'assistant.disable': { safety: 'mutate', idempotent: true, network: false },
  'assistant.status': { safety: 'read', idempotent: true, network: false },
  // `lwr events status` is a pure read of the on-disk event log.
  'events.status': { safety: 'read', idempotent: true, network: false },

  // `lwr issue handover` writes a time entry + (typically) changes the
  // issue status. Mutate-not-destructive; same end state on retry per id +
  // --stopped. Hits Redmine.
  'issue.handover': { safety: 'mutate', idempotent: false, network: true },

  // `lwr config base-url` writes the bootstrap URL to ~/.lwr/config.json.
  // Idempotent (re-running with the same URL is a no-op). Local-only.
  'config.base-url': { safety: 'mutate', idempotent: true, network: false },

  // --- memory (queryable SQLite index over assistant activity) ------------
  // `recall` and `status` are pure local reads — safe for MCP exposure.
  // `prune` is destructive (DELETEs observation rows past the retention
  // window). It stays callable but agents should think twice before
  // running it; the destructiveHint surfaces that in MCP clients.
  'memory.recall': { safety: 'read', idempotent: true, network: false },
  'memory.status': { safety: 'read', idempotent: true, network: false },
  'memory.prune': { safety: 'destructive', idempotent: true, network: false },

  // --- backup / restore ----------------------------------------------------
  // `backup create` writes a brand-new <timestamp>_backup.lwr each call —
  // not idempotent (running twice yields two files). Pure local I/O.
  // `backup list` is a pure read. `restore` is destructive (clear-and-
  // restore) but auto-snapshots current state first, so it's reversible
  // by restoring the pre-restore-*.lwr that was just written.
  'backup.create': { safety: 'mutate', idempotent: false, network: false },
  'backup.list': { safety: 'read', idempotent: true, network: false },
  // `backup prune` removes old bundles — destructive (data loss), but
  // idempotent (re-running with the same --keep is a no-op).
  'backup.prune': { safety: 'destructive', idempotent: true, network: false },
  'restore': { safety: 'destructive', idempotent: true, network: false },

  // --- misc ----------------------------------------------------------------
  'doctor': { safety: 'read', idempotent: true, network: true },
  'update': { safety: 'mutate', idempotent: true, network: true },
  'update-skill': { safety: 'mutate', idempotent: true, network: false },
  'skill-paths': { safety: 'read', idempotent: true, network: false },
  'install-skill': { safety: 'mutate', idempotent: true, network: false },
  'clear-data': { safety: 'destructive', idempotent: true, network: false },
  'uninstall': { safety: 'destructive', idempotent: true, network: false },

  // `commands` itself — the introspection verb. Pure read of the in-memory
  // commander tree; no Redmine call, no disk write.
  'commands': { safety: 'read', idempotent: true, network: false },

  // `home` — the bare-`lwr` landing view. Best-effort GET on the
  // active issue so the greeting never quotes a stale status; falls
  // back to cached + freshness label when network is unavailable.
  'home': { safety: 'read', idempotent: true, network: true },

  // `serve` — boots the MCP server. Long-running, no Redmine call by itself
  // (each tool the agent invokes spawns its own subprocess with its own
  // annotation). Treated as `read` because the orchestrator process is
  // observation-only.
  'serve': { safety: 'read', idempotent: true, network: false },
};

/**
 * Per-command set of repeatable option long-names. Repeatable options
 * accumulate across invocations (commander argParser pattern
 * `(val, prev = []) => [...prev, val]`); the MCP layer needs to know
 * which options accept arrays so it can both (a) advertise the right
 * JSON Schema and (b) reject array-shaped inputs for non-repeatable
 * options to prevent silent overwrite or argv injection.
 *
 * If a new option uses the array-accumulator parser, list it here.
 */
export const REPEATABLE_OPTIONS: Record<string, ReadonlySet<string>> = {
  'issue.list': new Set(['--cf']),
  'issue.edit': new Set(['--cf']),
  'issue.create': new Set(['--cf']),
  'feedback.log': new Set(['--attempt']),
  'prefs.add': new Set(['--set']),
};

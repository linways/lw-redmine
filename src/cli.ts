#!/usr/bin/env node
/**
 * lwr — Redmine CLI + Claude Code plugin substrate.
 *
 * This file is the single entry point. It builds the commander tree,
 * threads global flags through to each command, and delegates real work
 * to `commands/*`.
 *
 * Per PLAN.md §0.5: bare `lwr` prints help. The TUI is reachable only via
 * `lwr dash` (Phase 3). CLI commands are non-blocking by default for
 * agents — every prompt has a flag equivalent.
 */

import { Command } from 'commander';
import * as authLogin from './commands/auth/login';
import * as authLogout from './commands/auth/logout';
import * as authWhoami from './commands/auth/whoami';
import * as profileCmds from './commands/profile';
import * as meCmds from './commands/me';
import * as projectList from './commands/project/list';
import * as projectUse from './commands/project/use';
import * as projectMembers from './commands/project/members';
import * as projectVersions from './commands/project/versions';
import * as projectResolve from './commands/project/resolve';
import * as issueList from './commands/issue/list';
import * as issueView from './commands/issue/view';
import * as issueCreate from './commands/issue/create';
import * as issueEdit from './commands/issue/edit';
import * as issueNote from './commands/issue/note';
import * as issueFetch from './commands/issue/fetch';
import * as issueAttach from './commands/issue/attach';
import * as issueVerbs from './commands/issue/verbs';
import * as issueTransitions from './commands/issue/transitions';
import * as issueUse from './commands/issue/use';
import * as issueCurrent from './commands/issue/current';
import * as issueActive from './commands/issue/active';
import * as issueResolve from './commands/issue/resolve';
import * as issueHandover from './commands/issue/handover';
import * as issueClear from './commands/issue/clear';
import * as issuePrune from './commands/issue/prune';
import * as issuePause from './commands/issue/pause';
import * as logShow from './commands/log/show';
import * as logClear from './commands/log/clear';
import * as feedbackLog from './commands/feedback/log';
import * as feedbackList from './commands/feedback/list';
import * as feedbackShow from './commands/feedback/show';
import * as timeLog from './commands/time/log';
import * as timeListCmd from './commands/time/list';
import * as timeEdit from './commands/time/edit';
import * as timeDelete from './commands/time/delete';
import * as timeActivities from './commands/time/activities';
import * as statusCmd from './commands/status';
import * as userCmd from './commands/user';
import * as cacheCmd from './commands/cache';
import * as doctorCmd from './commands/util/doctor';
import * as searchCmd from './commands/search';
import * as clearDataCmd from './commands/clear-data';
import * as uninstallCmd from './commands/uninstall';
import * as backupCmd from './commands/backup';
import * as homeCmd from './commands/home';
import * as updateSkillCmd from './commands/update-skill';
import * as skillPathsCmd from './commands/skill-paths';
import * as installSkillCmd from './commands/install-skill';
import * as updateCmd from './commands/update';
import * as commandsCmdMod from './commands/commands';
import * as serveCmd from './commands/serve';
import * as assistantCmd from './commands/assistant';
import * as eventsCmd from './commands/events';
import * as memoryCmd from './commands/memory';
import * as configBaseUrlCmd from './commands/config/base-url';
import * as prefsCmd from './commands/prefs';
import { bootstrapAssistantObserver } from './assistant/observer';
import { bootstrapDailyRollover } from './workflow/daily-rollover';
import type { GlobalFlags } from './foundation/run';

import pkg from '../package.json';

function pickGlobals(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals();
  return {
    json: Boolean(opts.json),
    noColor: Boolean(opts.noColor),
    noInteractive: Boolean(opts.noInteractive),
    debug: Boolean(opts.debug),
    silent: Boolean(opts.silent),
    profile: typeof opts.profile === 'string' ? opts.profile : undefined,
    baseUrl: typeof opts.baseUrl === 'string' ? opts.baseUrl : undefined,
    apiKey: typeof opts.apiKey === 'string' ? opts.apiKey : undefined,
    dryRun: Boolean(opts.dryRun),
  };
}

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer, got "${value}"`);
  return n;
}

function build(): Command {
  const program = new Command();

  program
    .name('lwr')
    .description(pkg.description)
    .version(pkg.version)
    .option('--json', 'Output JSON envelope (lwr/v1) — for scripts and AI agents')
    .option('--no-color', 'Disable colored output')
    .option('--no-interactive', 'Never prompt; missing values become validation errors')
    .option('--debug', 'Verbose diagnostic logging on stderr')
    .option('--silent', 'Suppress all stderr output (errors still print)')
    .option('--profile <name>', 'Profile to use (overrides config + $LWR_PROFILE)')
    .option('--base-url <url>', 'Override Redmine base URL for this invocation')
    .option('--api-key <key>', 'Override API key for this invocation')
    .option('--dry-run', 'Show what a mutating command *would* do (resolved ids, payload, passed guards) without sending the POST/PUT/DELETE. No-op for read commands.')
    .showHelpAfterError();

  // --- home ---------------------------------------------------------------
  //
  // The bare `lwr` landing experience: time-aware greeting + context-
  // dependent suggestions (active issue, last work-log day, rollover ack,
  // frequent commands from memory). Pure local — no Redmine call.
  // Also exposed as the explicit `lwr home` verb so it's discoverable in
  // `lwr commands` and testable in isolation.
  program
    .command('home')
    .description('Friendly landing view — greeting + suggested next steps based on your current state. Reconciles local active-issue pointer with Redmine; the discovery half is cached for 60s in-process.')
    .option('--no-cache', 'Force a fresh dev-active discovery query, bypassing the 60s in-process cache.')
    .action(async function (this: Command) {
      const opts = this.opts<{ cache?: boolean }>();
      // commander turns `--no-cache` into `cache: false`; normalise to `noCache: true` for the command.
      const noCache = opts.cache === false ? true : false;
      await homeCmd.home({ ...pickGlobals(this), noCache });
    });

  // Bare `lwr` with no subcommand delegates to `home`. Commander only
  // runs this when no other command matched, so `lwr --help`,
  // `lwr --version`, `lwr issue list`, etc. continue to work as before.
  program.action(async function (this: Command) {
    await homeCmd.home(pickGlobals(this));
  });

  // --- auth ---------------------------------------------------------------

  const auth = program.command('auth').description('Authentication: login, logout, whoami');

  auth
    .command('login')
    .description('Store an API key + build the user profile (identity, role, custom-field map)')
    .option('--username <user>', 'Redmine username (exchanged for API key via basic auth)')
    .option('--password <pass>', 'Redmine password (used once, never stored)')
    .option('--method <m>', 'Interactive prompt method: "password" (default) | "api-key"')
    .option(
      '--role <list>',
      'Override role auto-detection — comma-separated, e.g. "developer,tester" (developer|tester|qa|lead)',
    )
    .action(async function (this: Command) {
      const opts = this.opts<{
        username?: string;
        password?: string;
        method?: 'api-key' | 'password';
        role?: string;
      }>();
      await authLogin.login({ ...pickGlobals(this), ...opts });
    });

  auth
    .command('logout')
    .description('Log out: remove API key, profile entry (identity, roles, memberships, activeProject), and ~/.lwr/me.md. Caches & downloaded issues are kept. Requires --confirm "logout" --yes (or interactive).')
    .option('--confirm <action>', 'Type the literal "logout" to acknowledge — required in non-TTY')
    .option('--yes', 'Final non-TTY ack — pair with --confirm "logout"')
    .action(async function (this: Command) {
      const opts = this.opts<{ confirm?: string; yes?: boolean }>();
      await authLogout.logout({ ...pickGlobals(this), ...opts });
    });

  auth
    .command('whoami')
    .description('Show the current Redmine user (verifies auth + network)')
    .action(async function (this: Command) {
      await authWhoami.whoami(pickGlobals(this));
    });

  // --- profile ------------------------------------------------------------

  const profile = program.command('profile').description('Manage Redmine profiles');

  profile
    .command('list')
    .description('List all configured profiles')
    .action(async function (this: Command) {
      await profileCmds.list(pickGlobals(this));
    });

  profile
    .command('use <name>')
    .description('Switch the active profile')
    .action(async function (this: Command, name: string) {
      await profileCmds.use({ ...pickGlobals(this), name });
    });

  profile
    .command('remove <name>')
    .description('Remove a profile')
    .action(async function (this: Command, name: string) {
      await profileCmds.remove({ ...pickGlobals(this), name });
    });

  // --- me -----------------------------------------------------------------

  const me = program
    .command('me')
    .description('Inspect or correct the per-profile Me block (identity, roles, custom-field map)');

  me
    .command('show')
    .description('Print the active profile\'s Me block')
    .action(async function (this: Command) {
      await meCmds.show(pickGlobals(this));
    });

  me
    .command('detect')
    .description('Re-run role detection from the user\'s recent issues')
    .option(
      '--role <list>',
      'Override detection — comma-separated, e.g. "developer,tester" (developer|tester|qa|lead)',
    )
    .action(async function (this: Command) {
      const opts = this.opts<{ role?: string }>();
      await meCmds.detect({ ...pickGlobals(this), ...opts });
    });

  const meSet = me.command('set').description('Manually correct the Me block');

  meSet
    .command('field-map <role> <cfId> <name>')
    .description('Bind a role to a specific custom-field id + name (overrides detection)')
    .action(async function (this: Command, role: string, cfId: string, name: string) {
      const parsedId = Number.parseInt(cfId, 10);
      await meCmds.setFieldMap({
        ...pickGlobals(this),
        role: role as 'developer' | 'tester' | 'qa' | 'lead',
        cfId: Number.isNaN(parsedId) ? undefined : parsedId,
        cfName: name,
      });
    });

  // --- project ------------------------------------------------------------

  const project = program.command('project').description('Projects');

  project
    .command('list')
    .description('List projects')
    .option('--limit <n>', 'Page size', intArg)
    .option('--offset <n>', 'Page offset', intArg)
    .option('--all', 'Fetch every page')
    .action(async function (this: Command) {
      const opts = this.opts<{ limit?: number; offset?: number; all?: boolean }>();
      await projectList.list({ ...pickGlobals(this), ...opts });
    });

  project
    .command('use <id>')
    .description('Set the active profile\'s default project (verifies it exists)')
    .action(async function (this: Command, id: string) {
      await projectUse.useProject({ ...pickGlobals(this), project: id });
    });

  project
    .command('members <id>')
    .description('List project members (users + groups + roles)')
    .option('--limit <n>', 'Page size', intArg)
    .option('--offset <n>', 'Page offset', intArg)
    .option('--all', 'Fetch every page')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ limit?: number; offset?: number; all?: boolean }>();
      await projectMembers.members({ ...pickGlobals(this), project: id, ...opts });
    });

  project
    .command('versions <id>')
    .description('List project versions / milestones')
    .action(async function (this: Command, id: string) {
      await projectVersions.versions({ ...pickGlobals(this), project: id });
    });

  project
    .command('resolve <query>')
    .description('Resolve a project name / id / identifier (debug helper for --project)')
    .option('--no-cache', 'Skip cache; refresh the index live')
    .action(async function (this: Command, query: string) {
      const opts = this.opts<{ cache?: boolean }>();
      await projectResolve.resolve({ ...pickGlobals(this), query, noCache: opts.cache === false });
    });

  // --- issue --------------------------------------------------------------

  const issue = program.command('issue').description('Issues');

  issue
    .command('use <id>')
    .description('Use when the user picks a new issue to focus on. Sets the local active-issue pointer (the sticky "what am I on" marker that `lwr current`, `lwr home`, and `me.md` read). Pointer-only — no Redmine status change. To actually start work, follow with `lwr issue status <id> "Development in Progress"`; that PUT fires the dev-active mutex sweep and pauses any other in-progress issue.')
    .action(async function (this: Command, id: string) {
      await issueUse.useIssue({ ...pickGlobals(this), issue: id });
    });

  issue
    .command('current')
    .description('Use when the user asks "what am I on?" / "what\'s my current issue?". Reads the local sticky pointer, reconciles against the live Redmine dev-active set (auto-clears if terminal, surfaces conflicts/discoveries). Discovery cached for 60s in-process. For raw Redmine truth (no local pointer), use `lwr issue active`.')
    .option('--no-cache', 'Force a fresh dev-active discovery query, bypassing the 60s in-process cache.')
    .action(async function (this: Command) {
      const opts = this.opts<{ cache?: boolean }>();
      const noCache = opts.cache === false ? true : false;
      await issueCurrent.currentIssue({ ...pickGlobals(this), noCache });
    });

  issue
    .command('active')
    .description('Use when the user wants raw Redmine truth ("what\'s actually In-Progress for me right now?"), bypassing the local pointer. Queries DEV_ACTIVE_STATUS_NAMES with Developer cf = me; >1 row signals a mutex violation. For the local-pointer + reconciliation view, use `lwr issue current`.')
    .action(async function (this: Command) {
      await issueActive.activeIssue({ ...pickGlobals(this) });
    });

  issue
    .command('resolve <id>')
    .description('Use when an issue is deployed to production ("I deployed #X" / "push #X live"). Auto-pauses the active pointer first when it\'s a different issue (interrupt rule), PUTs target → Resolved, optionally POSTs a deploy time entry with --spent. For backfilling forgotten dev hours from a past day, use `lwr time log --date` (which does NOT fire the interrupt-pause).')
    .option('--spent <duration>', 'Time spent on the deploy, today (e.g. 5m, 10m, 15m, 1h, 1h30m, 0.25). Omit to skip the time entry.')
    .option('--activity <name>', 'Override the default time-entry activity ("Configurations").')
    .option('--note <text>', 'Resolve comment, appears in the Redmine journal and the time entry.')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ spent?: string; activity?: string; note?: string }>();
      await issueResolve.resolve({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('handover [id]')
    .description('Use when reconciling a daily-rollover signal — "you didn\'t pause last night; lwr left the issue in a dev-active status". Backfills a time entry from the last action-log timestamp through --stopped, then pauses (default) / resolves / resumes. `--dismiss` clears today\'s rollover warning without backfilling.')
    .option('--stopped <time>', 'When work actually ended. HH:MM (combined with the date of last activity) or full ISO. Required unless --dismiss.')
    .option('--mode <pause|resolve|resume>', 'What to do after backfill (default: pause).')
    .option('--note <text>', 'Comment for the time entry; defaults to an auto-generated handover note.')
    .option('--dismiss', 'Skip backfill — just mark today acknowledged so the rollover warning stops surfacing.')
    .action(async function (this: Command, id: string | undefined) {
      const opts = this.opts<{ stopped?: string; mode?: string; note?: string; dismiss?: boolean }>();
      await issueHandover.handoverIssue({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('clear')
    .description('Use when the user is dropping focus without a Redmine status change ("forget what I was on" / "I\'m done for today, don\'t resume this"). Unsets the local active-issue pointer. Does NOT change Redmine — for actual status changes, use `lwr issue pause` (keeps pointer, sets status) or `lwr issue status` (full transition).')
    .action(async function (this: Command) {
      await issueClear.clearIssue({ ...pickGlobals(this) });
    });

  issue
    .command('prune')
    .description('Delete old per-issue materialisation directories under ~/.lwr/issues/. Materialisations are re-fetchable via `lwr issue fetch`. Defaults to dropping directories last touched > 30 days ago.')
    .option('--before <date>', 'Drop issue dirs whose newest file is older than this ISO date (YYYY-MM-DD or full ISO).')
    .option('--keep <n>', 'Keep only the N most recently touched issue dirs; drop the rest. Mutually exclusive with --before.', intArg)
    .action(async function (this: Command) {
      const opts = this.opts<{ before?: string; keep?: number }>();
      await issuePrune.pruneIssue({ ...pickGlobals(this), ...opts });
    });

  issue
    .command('pause')
    .description('Use when the user is stopping work on the active issue ("pausing for the day" / "taking a break"). PUTs the active issue to --status (default "Paused") and re-syncs the local pointer\'s status snapshot, keeping the pointer SET so `lwr issue use <same-id>` resumes cleanly later. Unlike `clear`, the pointer survives.')
    .option('--status <name>', 'Redmine status to set at pause (default "Paused"). Resolves against the cached statuses dict + the issue\'s allowed_statuses guard. Pass a different transition to bounce (e.g. tester sending issue back: --status "Need More Information").')
    .option('--note <text>', 'Optional one-line note appended as a Redmine journal comment on the pause PUT')
    .action(async function (this: Command) {
      const opts = this.opts<{ status?: string; note?: string }>();
      await issuePause.pauseIssue({ ...pickGlobals(this), ...opts });
    });

  issue
    .command('list')
    .description('List issues — pass --as <lens> to filter by your role on this Redmine')
    .option('--project <id>', 'Project id or identifier')
    .option('--status <id>', 'Status id (or `*` for any)')
    .option('--assignee <id>', 'Assignee id (or `me`); use --as <lens> for role-aware filtering')
    .option(
      '--as <lens>',
      'Role lens: developer | tester | qa | lead | assignee | reporter | any (reads ~/.lwr profile)',
    )
    .option(
      '--cf <kv>',
      'Custom-field filter, repeatable. Form: <cfId>=<value>. e.g. --cf 79=57',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option('--priority <id>', 'Priority id')
    .option('--tracker <id>', 'Tracker id')
    .option(
      '--sprint <id-or-name>',
      'Filter by sprint / Redmine version. Pass a numeric id or a name (substring match against `lwr project versions`).',
    )
    .option('--subject <text>', 'Filter by subject (substring match)')
    .option('--sort <spec>', 'Sort spec, e.g. "priority:desc,id:desc"')
    .option('--limit <n>', 'Page size', intArg)
    .option('--offset <n>', 'Page offset', intArg)
    .option('--all', 'Fetch every page')
    .option(
      '--include-done',
      'Disable the default "open" post-filter and show terminal-status tickets (Resolved, Closed, Rejected, …). At Linways every status has `is_closed: false`, so the native open filter would otherwise leak them.',
    )
    .option(
      '--exclude-status <names>',
      'Comma-separated status names to hide from results. Case-insensitive. Use to narrow to "currently in my court" by hiding handoff states like "Development Completed,Testing completed".',
    )
    .action(async function (this: Command) {
      const opts = this.opts<Parameters<typeof issueList.list>[0]>();
      await issueList.list({ ...pickGlobals(this), ...opts });
    });

  issue
    .command('view <id>')
    .description('View an issue with journals + attachments')
    .option('--no-detail', 'Skip journals/attachments/relations')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ detail?: boolean }>();
      await issueView.view({ ...pickGlobals(this), id, detail: opts.detail });
    });

  issue
    .command('create')
    .description('Create an issue')
    .option('--project <id>', 'Project id or identifier (required)')
    .option('--subject <text>', 'Subject (required)')
    .option('--description <text>', 'Description')
    .option('--description-file <path>', 'Read description from file (or - for stdin)')
    .option('--tracker-id <n>', 'Tracker id', intArg)
    .option('--status-id <n>', 'Status id', intArg)
    .option('--priority-id <n>', 'Priority id', intArg)
    .option('--assignee-id <n>', 'Assignee user id', intArg)
    .option('--assignee <name>', 'Assignee by login or name (resolved via project members)')
    .option('--parent-issue-id <n>', 'Parent issue id', intArg)
    .option('--start-date <yyyy-mm-dd>', 'Start date')
    .option('--due-date <yyyy-mm-dd>', 'Due date')
    .option('--estimated-hours <n>', 'Estimated hours', Number)
    .option(
      '--cf <kv>',
      'Custom-field setter, repeatable. Form: <name-or-id>=<value>. e.g. --cf "Tester=Alex Biju" or --cf 88=42. Prefix `raw:` to force a literal string, `id:` for an explicit id.',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await issueCreate.create({ ...pickGlobals(this), ...opts });
    });

  issue
    .command('edit <id>')
    .description('Edit an issue')
    .option('--subject <text>', 'New subject')
    .option('--description <text>', 'New description')
    .option('--description-file <path>', 'Read description from file (or - for stdin)')
    .option('--tracker-id <n>', 'Tracker id', intArg)
    .option('--status-id <n>', 'Status id (numeric)', intArg)
    .option('--status <name>', 'Status by name (resolved against `lwr status list`)')
    .option('--priority-id <n>', 'Priority id', intArg)
    .option('--assignee-id <n>', 'Assignee user id', intArg)
    .option('--assignee <name>', 'Assignee by login or name (resolved via project members)')
    .option('--parent-issue-id <n>', 'Parent issue id', intArg)
    .option('--start-date <yyyy-mm-dd>', 'Start date')
    .option('--due-date <yyyy-mm-dd>', 'Due date')
    .option('--estimated-hours <n>', 'Estimated hours', Number)
    .option('--done-ratio <n>', 'Percent done (0-100)', intArg)
    .option('--notes <text>', 'Add a note alongside the edit')
    .option('--notes-file <path>', 'Read notes from file (or - for stdin)')
    .option('--private-notes', 'Mark notes as private')
    .option(
      '--cf <kv>',
      'Custom-field setter, repeatable. Form: <name-or-id>=<value>. e.g. --cf "Tester=Alex Biju" or --cf 88=42. Prefix `raw:` to force a literal string, `id:` for an explicit id.',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await issueEdit.edit({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('fetch <id>')
    .description('Download issue + attachments to ~/.lwr/issues/<id>/ (with PDF→PNG conversion)')
    .option('--force', 'Re-download attachments even if already cached')
    .option('--no-convert', 'Skip PDF/DOCX/XLSX conversions (originals only)')
    .option('--out <dir>', 'Override target directory')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ force?: boolean; convert?: boolean; out?: string }>();
      await issueFetch.fetch({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('attach <id> <files...>')
    .description('Upload one or more files as attachments on an issue')
    .option('--description <text>', 'Description applied to every attachment')
    .option('--message <text>', 'Optional note posted alongside the attachments')
    .option('--message-file <path>', 'Read note from file (or - for stdin)')
    .option('--private', 'Mark the accompanying note as private')
    .option('--filename-as <name>', 'Override the displayed filename (single-file only)')
    .option('--content-type <ct>', 'Override the content-type Redmine records')
    .action(async function (this: Command, id: string, files: string[]) {
      const opts = this.opts<Record<string, unknown>>();
      await issueAttach.attach({ ...pickGlobals(this), id, files, ...opts });
    });

  issue
    .command('status <id> <status>')
    .description('Set issue status by name or numeric id')
    .option('--note <text>', 'Add a note alongside the status change')
    .option('--private', 'Mark the note as private')
    .action(async function (this: Command, id: string, status: string) {
      const opts = this.opts<Record<string, unknown>>();
      await issueVerbs.statusVerb({ ...pickGlobals(this), id, status, ...opts });
    });

  issue
    .command('close <id>')
    .description('Close an issue (uses the first is_closed status by default)')
    .option('--as <name>', 'Pick a specific closed status (e.g., "Rejected")')
    .option('--note <text>', 'Add a closing note')
    .option('--private', 'Mark the note as private')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await issueVerbs.closeVerb({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('assign <id> <user>')
    .description('Set assignee — user is `me`, `none`, a numeric id, a login, or a name')
    .option('--note <text>', 'Add a note alongside the assignment')
    .option('--private', 'Mark the note as private')
    .action(async function (this: Command, id: string, user: string) {
      const opts = this.opts<Record<string, unknown>>();
      await issueVerbs.assignVerb({ ...pickGlobals(this), id, user, ...opts });
    });

  issue
    .command('watch <id>')
    .description('Add a watcher (defaults to the current user)')
    .option('--user <id>', '`me` or numeric user id (default: me)')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ user?: string }>();
      await issueVerbs.watchVerb({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('unwatch <id>')
    .description('Remove a watcher (defaults to the current user)')
    .option('--user <id>', '`me` or numeric user id (default: me)')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ user?: string }>();
      await issueVerbs.unwatchVerb({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('open <id>')
    .description('Print the canonical URL for an issue (--browser to launch)')
    .option('--browser', 'Launch in the default browser (interactive TTY only)')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<{ browser?: boolean }>();
      await issueVerbs.openVerb({ ...pickGlobals(this), id, ...opts });
    });

  issue
    .command('transitions <id>')
    .description('List allowed status transitions for the current user on an issue')
    .action(async function (this: Command, id: string) {
      await issueTransitions.transitions({ ...pickGlobals(this), id });
    });

  issue
    .command('note <id>')
    .description('Add a note to an issue')
    .option('--message <text>', 'Note text')
    .option('--message-file <path>', 'Read note from file (or - for stdin)')
    .option('--private', 'Mark as private')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await issueNote.note({ ...pickGlobals(this), id, ...opts });
    });

  // --- log ----------------------------------------------------------------

  const log = program
    .command('log')
    .description('Action audit log: every mutating lwr command, one per line, at ~/.lwr/log/<date>.ndjson');

  log
    .command('show')
    .description('Render the action log for one day (defaults to today)')
    .option('--today', 'render today (default)')
    .option('--yesterday', 'render yesterday')
    .option('--date <yyyy-mm-dd>', 'render a specific ISO date')
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await logShow.showLog({ ...pickGlobals(this), ...opts });
    });

  log
    .command('clear')
    .description('Remove day files strictly older than --before')
    .option('--before <yyyy-mm-dd>', 'remove all days strictly before this date')
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await logClear.clearLog({ ...pickGlobals(this), ...opts });
    });

  // --- feedback (Phase 1: capability-gap incident log) --------------------
  //
  // One Markdown file per incident under `~/.lwr/feedback/<UTC-date>/`. The
  // agent writes via `feedback log` when it detects a missing verb/flag and
  // bails. The user inspects via `list` / `show`. Phase 2 hooks the same
  // writer from the global error formatter. Spec: FEEDBACK_SPEC.md.

  const feedback = program
    .command('feedback')
    .description('Beta observability — local incident log of capability gaps and recoverable errors');

  feedback
    .command('log')
    .description('Record one incident (capability gap or recoverable error) as a Markdown file under ~/.lwr/feedback/')
    .option('--kind <kind>', 'gap | error (required)')
    .option('--query <text>', 'The user\'s natural-language request (required; redacted before write)')
    .option('--reason <text>', 'One-line note on why this is being logged (required; redacted)')
    .option('--details <text>', 'Optional longer body — full error.message + error.details for trigger B (redacted)')
    .option('--command <verb>', 'Closest matching lwr dotted verb, e.g. "issue.edit"')
    .option('--issue <id>', 'Optional issue id the incident was about')
    .option('--exit-code <n>', 'Exit code (trigger B only)', Number)
    .option('--error-code <code>', 'Stable error code, e.g. VALIDATION_CF_NOT_FOUND (trigger B only)')
    .option('--agent <name>', 'Upstream agent: claude-code | codex | gemini | cli (default: cli)')
    .option(
      '--attempt <action|outcome>',
      'Repeatable. Format "<action>|<outcome>" — one entry per agent step before bailing. Gap kind only.',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await feedbackLog.logFeedback({ ...pickGlobals(this), ...opts });
    });

  feedback
    .command('list')
    .description('List recorded incidents, newest first')
    .option('--since <Nd>', 'Window in days, e.g. --since 14d')
    .option('--week', 'Shortcut for --since 7d (default window)')
    .option('--month', 'Shortcut for --since 30d')
    .option('--all', 'No window — every recorded incident')
    .option('--kind <kind>', 'Filter to gap | error')
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await feedbackList.listFeedbackCmd({ ...pickGlobals(this), ...opts });
    });

  feedback
    .command('show <ref>')
    .description('Print one feedback file — by slug or relative path under ~/.lwr/feedback/')
    .action(async function (this: Command, ref: string) {
      await feedbackShow.showFeedback({ ...pickGlobals(this), ref });
    });

  // --- prefs (cross-agent shared brain) -----------------------------------
  //
  // `~/.lwr/facts/preferences.json` is the single durable home for
  // user-declared facts that should apply across every agent (Claude
  // Code, Codex, Copilot, …). Agents teach lwr via `prefs add` instead
  // of stashing rules in their own per-agent memory; the apply-path on
  // `issue edit/create/status/close` then fires them automatically.

  const prefs = program
    .command('prefs')
    .description('Cross-agent shared brain — user-declared CF defaults applied by issue edit/create/status/close.');

  prefs
    .command('add')
    .description('Teach lwr a rule. e.g. `lwr prefs add --when "Developer=Sibin" --set "Tester=Alex Biju" --reason "..." --agent claude-code`')
    .requiredOption('--when <cf=value>', 'Single condition: a custom-field id/name and the value that triggers the rule')
    .option('--set <cf=value...>', 'One or more cf=value pairs to inject when the condition matches (repeat for multiple)')
    .option('--reason <text>', 'Why this rule exists (REQUIRED in non-TTY; quote the user verbatim when possible)')
    .option('--agent <name>', 'Self-identifier of the calling agent (claude-code / codex / copilot / human). REQUIRED in non-TTY.')
    .option('--id <slug>', 'Explicit rule id. Defaults to a deterministic id derived from --when + --set so re-teaching is idempotent.')
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await prefsCmd.addPrefs({ ...pickGlobals(this), ...opts });
    });

  prefs
    .command('remove <id>')
    .description('Remove a rule by id. List ids with `lwr prefs list --json`.')
    .action(async function (this: Command, id: string) {
      await prefsCmd.removePrefs({ ...pickGlobals(this), id });
    });

  prefs
    .command('list')
    .description('Show every rule lwr knows about — full provenance (reason, addedBy, lastTriggered, count).')
    .action(async function (this: Command) {
      await prefsCmd.listPrefs(pickGlobals(this));
    });

  // --- time ---------------------------------------------------------------

  const time = program
    .command('time')
    .description('Time entries: log, list, edit, delete (powers issue spent_hours)');

  time
    .command('log <id>')
    .description('Log work time on an issue. e.g. `lwr time log 12345 --hours 2.5 --activity Development`')
    .option('--hours <n>', 'Hours as a decimal, e.g. 2.5 (required)', Number)
    .option('--activity <name>', 'Activity by name (resolved against `lwr time activities`)')
    .option('--activity-id <n>', 'Activity by numeric id', intArg)
    .option('--date <yyyy-mm-dd>', 'Date the work was done (defaults to today)')
    .option('--comments <text>', 'Free-text note attached to the time entry')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await timeLog.log({ ...pickGlobals(this), id, ...opts });
    });

  time
    .command('list')
    .description('List time entries — filter by issue, user, project, activity, date range')
    .option('--issue <id>', 'Restrict to one issue')
    .option('--user <id>', '`me` or numeric user id')
    .option('--project <id>', 'Project id or identifier (ignored when --issue is set)')
    .option('--activity <name>', 'Activity by name')
    .option('--activity-id <n>', 'Activity by numeric id', intArg)
    .option('--from <yyyy-mm-dd>', 'Spent-on lower bound (inclusive)')
    .option('--to <yyyy-mm-dd>', 'Spent-on upper bound (inclusive)')
    .option('--sort <spec>', 'Sort spec, default `spent_on:desc`')
    .option('--limit <n>', 'Page size', intArg)
    .option('--offset <n>', 'Page offset', intArg)
    .option('--all', 'Fetch every page')
    .action(async function (this: Command) {
      const opts = this.opts<Record<string, unknown>>();
      await timeListCmd.list({ ...pickGlobals(this), ...opts });
    });

  time
    .command('edit <entry-id>')
    .description('Edit an existing time entry (use `lwr time list` to find the id)')
    .option('--hours <n>', 'New hours (decimal)', Number)
    .option('--activity <name>', 'New activity by name')
    .option('--activity-id <n>', 'New activity by numeric id', intArg)
    .option('--date <yyyy-mm-dd>', 'New spent-on date')
    .option('--comments <text>', 'New comments')
    .option('--issue <id>', 'Move the entry to a different issue')
    .option('--project <id>', 'Move the entry to a different project (when not anchored to an issue)')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await timeEdit.edit({ ...pickGlobals(this), id, ...opts });
    });

  time
    .command('delete <entry-id>')
    .description('Delete a time entry. Requires --confirm "delete-time-entry" --yes (or interactive).')
    .option('--confirm <action>', 'Type the literal "delete-time-entry" to acknowledge — required in non-TTY')
    .option('--yes', 'Final non-TTY ack — pair with --confirm "delete-time-entry"')
    .action(async function (this: Command, id: string) {
      const opts = this.opts<Record<string, unknown>>();
      await timeDelete.del({ ...pickGlobals(this), id, ...opts });
    });

  time
    .command('activities')
    .description('List the time-entry activities defined on this Redmine instance (cache-first)')
    .option('--no-cache', 'Skip cache; fetch live')
    .action(async function (this: Command) {
      const opts = this.opts<{ cache?: boolean }>();
      await timeActivities.activities({ ...pickGlobals(this), noCache: opts.cache === false });
    });

  // --- search -------------------------------------------------------------

  program
    .command('search <query>')
    .description('Cross-resource full-text search (issues, wiki, news, …)')
    .option('--search-project <id>', 'Restrict to a project id or identifier')
    .option('--scope <scope>', 'self | subprojects | all (default: self)')
    .option('--types <list>', 'Comma-separated: issue,wiki,news,document,message,project,changeset')
    .option('--titles-only', 'Match in titles only')
    .option('--open', 'Only open issues')
    .option('--all-words', 'Require every word to match')
    .option('--limit <n>', 'Page size', intArg)
    .option('--offset <n>', 'Page offset', intArg)
    .option('--all', 'Fetch every page')
    .action(async function (this: Command, query: string) {
      const opts = this.opts<Record<string, unknown>>();
      await searchCmd.searchCmd({ ...pickGlobals(this), query, ...opts });
    });

  // --- status -------------------------------------------------------------

  const status = program.command('status').description('Issue statuses (instance-wide dictionary)');

  status
    .command('list')
    .description('List every issue status defined on this Redmine instance')
    .action(async function (this: Command) {
      await statusCmd.statusList(pickGlobals(this));
    });

  // --- user ---------------------------------------------------------------

  const user = program.command('user').description('Users — list, import a fallback list, resolve names → ids');

  user
    .command('list')
    .description('List users (--project for memberships, --search for /users.json admin search)')
    .option('--project <id>', 'Project id or identifier (uses memberships, cache-first)')
    .option('--search <q>', 'Free-text search (admin-only when used without --project)')
    .option('--no-cache', 'Skip cache; fetch live from Redmine')
    .action(async function (this: Command) {
      const opts = this.opts<{ project?: string; search?: string; cache?: boolean }>();
      await userCmd.userList({ ...pickGlobals(this), project: opts.project, search: opts.search, noCache: opts.cache === false });
    });

  user
    .command('import <file>')
    .description('Import a manual user fallback list (used when /users.json is forbidden)')
    .action(async function (this: Command, file: string) {
      await userCmd.userImport({ ...pickGlobals(this), file });
    });

  user
    .command('resolve <query>')
    .description('Resolve a name/login to a user id (debug helper for agent flows)')
    .option('--issue <id>', 'Anchor lookup to this issue\'s project (preferred)')
    .option('--project <id>', 'Anchor lookup to this project')
    .option('--no-cache', 'Skip cache; fetch live')
    .action(async function (this: Command, query: string) {
      const opts = this.opts<{ issue?: string; project?: string; cache?: boolean }>();
      await userCmd.userResolve({ ...pickGlobals(this), query, issue: opts.issue, project: opts.project, noCache: opts.cache === false });
    });

  // --- cache --------------------------------------------------------------

  const cache = program.command('cache').description('Inspect and manage the on-disk metadata cache');

  cache
    .command('list')
    .description('Show what is cached, ages, and freshness')
    .action(async function (this: Command) {
      await cacheCmd.cacheList(pickGlobals(this));
    });

  cache
    .command('clear')
    .description('Clear cache entries (defaults to statuses + activities + projects; users requires explicit --type users)')
    .option('--type <list>', 'Comma-separated: statuses, activities, projects, users')
    .action(async function (this: Command) {
      const opts = this.opts<{ type?: string }>();
      await cacheCmd.cacheClear({ ...pickGlobals(this), type: opts.type });
    });

  cache
    .command('refresh')
    .description('Re-fetch cache entries (statuses + activities + every cached project by default)')
    .option('--type <list>', 'Comma-separated: statuses, activities, projects')
    .action(async function (this: Command) {
      const opts = this.opts<{ type?: string }>();
      await cacheCmd.cacheRefresh({ ...pickGlobals(this), type: opts.type });
    });

  // --- assistant (Phase 3 opt-in) -----------------------------------------
  //
  // Plug-and-play feature group. Disabled by default — flipping the bit
  // only persists state; the actual observation/inference/suggest layers
  // ship in subsequent tiers and themselves gate every effect on the
  // same flag. With assistant disabled, lwr behaviour is byte-identical
  // to the audit-shipped baseline (PR #1).

  const assistant = program
    .command('assistant')
    .description('Self-growing assistant layer (opt-in): personal preferences + taught team knowledge + behaviour observation. Disabled by default.');

  assistant
    .command('enable')
    .description('Turn the assistant on. Persists `assistant.enabled = true`. No effect until later tiers ship.')
    .action(async function (this: Command) {
      await assistantCmd.enable(pickGlobals(this));
    });

  assistant
    .command('disable')
    .description('Turn the assistant off. lwr returns to vanilla behaviour.')
    .action(async function (this: Command) {
      await assistantCmd.disable(pickGlobals(this));
    });

  assistant
    .command('status')
    .description('Show whether the assistant is currently enabled.')
    .action(async function (this: Command) {
      await assistantCmd.status(pickGlobals(this));
    });

  // Diagnostic for the assistant's event log. Verb sits at the top
  // level (not nested under `assistant`) because it's a separate
  // concern — the assistant feature flag controls whether events are
  // *recorded*; this verb just reports what's been recorded so far.
  const events = program
    .command('events')
    .description('Inspect the assistant\'s behaviour-event log (Phase 3 opt-in).');

  events
    .command('status')
    .description('Counts, file size, and oldest/newest timestamps for the event log. Read-only.')
    .action(async function (this: Command) {
      await eventsCmd.status(pickGlobals(this));
    });

  // --- memory (queryable SQLite index over agent activity) ----------------
  //
  // Auto-populated: every command observation (via the observer), every
  // resolved cf on a mutating command (via decisions), every `prefs add|
  // remove` (as a `fact` row with supersession), and rule candidates from
  // the detector. These verbs are the read + cleanup surface; the write
  // path is purely automatic.
  const memory = program
    .command('memory')
    .description('Queryable memory store — recall past activity, see status, prune stale rows.');

  memory
    .command('recall [query]')
    .description('Search memory for matching rows. Substring match on content; optional --kind / --cf-id / --rule-id filters. JSON envelope.')
    .option('--kind <kind>', 'Filter by kind: observation | fact | rule-candidate')
    .option('--cf-id <id>', 'Filter rows whose metadata.cf_id matches')
    .option('--rule-id <id>', 'Filter rows whose metadata.rule_id matches')
    .option('--limit <n>', 'Cap results (default 50, max 1000)')
    .option('--include-superseded', 'Include rows that have been superseded (audit history)')
    .action(async function (this: Command, query: string | undefined, opts: Record<string, unknown>) {
      await memoryCmd.recallMemory({ ...pickGlobals(this), query, ...opts });
    });

  memory
    .command('status')
    .description('Memory DB stats: counts per kind, file size, oldest/newest, last prune.')
    .action(async function (this: Command) {
      await memoryCmd.statusMemory(pickGlobals(this));
    });

  memory
    .command('prune')
    .description('Delete observation rows older than the retention window. Facts and rule-candidates are kept.')
    .action(async function (this: Command) {
      await memoryCmd.pruneMemory(pickGlobals(this));
    });

  // --- config (bootstrap settings — agent-callable, no credentials) -------
  //
  // For values an AI agent can ask the user once and persist without ever
  // touching credentials. Today: base-url. Future: anything else that's
  // "ask once, durable, non-sensitive."
  const config = program
    .command('config')
    .description('Bootstrap settings — non-sensitive, agent-callable persistence.');

  config
    .command('base-url <url>')
    .description('Set the Redmine base URL persistently. Writes config.defaultBaseUrl and, if a profile already exists, also updates profile.baseUrl. Resolves CONFIG_BASE_URL_MISSING.')
    .action(async function (this: Command, url: string) {
      await configBaseUrlCmd.configBaseUrl({ ...pickGlobals(this), url });
    });

  // --- introspection ------------------------------------------------------

  program
    .command('commands')
    .description('Machine-readable enumeration of every CLI verb (path, args, options, safety, idempotent, network). Pure read; no Redmine round-trip.')
    .option('--filter <prefix>', 'Restrict to commands whose dotted path starts with this prefix, e.g. "issue" or "time"')
    .action(async function (this: Command) {
      const opts = this.opts<{ filter?: string }>();
      // `this.parent` is the root program — we serialize from there so
      // descend covers every group.
      const root = (this.parent ?? this) as Command;
      await commandsCmdMod.commandsCmd(root)({ ...pickGlobals(this), filter: opts.filter });
    });

  // --- serve (MCP) --------------------------------------------------------

  program
    .command('serve')
    .description('Run lwr as an MCP server (stdio). Exposes every CLI verb as an MCP tool plus `lwr://me` as a resource.')
    .option('--mcp', 'Run the MCP server (currently the only mode)')
    .action(async function (this: Command) {
      const opts = this.opts<{ mcp?: boolean }>();
      await serveCmd.serve(program, { ...pickGlobals(this), ...opts });
    });

  // --- doctor -------------------------------------------------------------

  program
    .command('doctor')
    .description('Self-test: runtime, config, auth, network, converters, terminal')
    .action(async function (this: Command) {
      await doctorCmd.doctor(pickGlobals(this));
    });

  // --- skill maintenance --------------------------------------------------

  program
    .command('update')
    .description('Update lwr itself: git pull (if clean) → npm install → build → npm link → refresh skill snapshot. Discoverable wrapper around `node <repo>/install.mjs update`.')
    .action(async function (this: Command) {
      await updateCmd.update(pickGlobals(this));
    });

  program
    .command('update-skill')
    .description('Refresh ~/.lwr/skill/SKILL.md from the repo and re-link every AI tool. Cheap, idempotent, no git/npm/build.')
    .action(async function (this: Command) {
      await updateSkillCmd.updateSkill(pickGlobals(this));
    });

  program
    .command('skill-paths')
    .description('Print the canonical SKILL.md + recipes paths and per-tool symlink state. No network. Use this when running on an unsupported host (Kilo, Continue, etc.) so the agent can read the skill directly.')
    .action(async function (this: Command) {
      await skillPathsCmd.skillPaths(pickGlobals(this));
    });

  program
    .command('install-skill')
    .description('Symlink SKILL.md + recipes/ into one explicit target folder (for unsupported AI hosts). Target must be under $HOME. Idempotent.')
    .requiredOption('--target <dir>', 'Skill folder for the host, e.g. ~/.kilo/skills/lw-redmine')
    .action(async function (this: Command) {
      const opts = this.opts<{ target: string }>();
      await installSkillCmd.installSkill({ ...pickGlobals(this), target: opts.target });
    });

  // --- backup / restore ---------------------------------------------------
  //
  // Bundle ~/.lwr/ (except credentials + backups dir) into a single
  // <timestamp>_backup.lwr file. Restore is destructive but
  // double-snapshotted: a pre-restore-*.lwr is written before any wipe.
  const backup = program
    .command('backup')
    .description('Snapshot and list lwr state bundles. Credentials are excluded; re-run `lwr auth login` after restore.');

  backup
    .command('create')
    .description('Capture current state to ~/.lwr/backups/<timestamp>_backup.lwr (or --out path).')
    .option('--out <path>', 'Write the bundle to this path instead of ~/.lwr/backups/')
    .action(async function (this: Command) {
      const opts = this.opts<{ out?: string }>();
      await backupCmd.backupCreate({ ...pickGlobals(this), ...opts });
    });

  backup
    .command('list')
    .description('List available backups in ~/.lwr/backups/. Newest first.')
    .action(async function (this: Command) {
      await backupCmd.backupList(pickGlobals(this));
    });

  backup
    .command('prune')
    .description('Delete all but the N most recent bundles in ~/.lwr/backups/. Keeps user-initiated and pre-restore snapshots separately or together via --kind.')
    .option('--keep <n>', 'How many bundles (per `--kind` scope) to keep. Default 5.', intArg)
    .option('--kind <which>', 'Scope: "user" (manual backups), "pre-restore" (auto-snapshots), or "all" (default).')
    .action(async function (this: Command) {
      const opts = this.opts<{ keep?: number; kind?: 'user' | 'pre-restore' | 'all' }>();
      await backupCmd.backupPrune({ ...pickGlobals(this), ...opts });
    });

  program
    .command('restore <file>')
    .description('Restore lwr state from a <timestamp>_backup.lwr bundle. Auto-snapshots current state first. Requires --confirm "restore" --yes (or interactive).')
    .option('--confirm <action>', 'Type the literal "restore" to acknowledge — required in non-TTY')
    .option('--yes', 'Final non-TTY ack — pair with --confirm "restore"')
    .action(async function (this: Command, file: string) {
      const opts = this.opts<{ confirm?: string; yes?: boolean }>();
      await backupCmd.restore({ ...pickGlobals(this), file, ...opts });
    });

  // --- destructive lifecycle ---------------------------------------------

  program
    .command('clear-data')
    .description('Wipe accumulated cache + downloaded issues. Keeps credentials + profile + me.md. Requires --confirm "clear-data" --yes (or interactive).')
    .option('--confirm <action>', 'Type the literal "clear-data" to acknowledge — required in non-TTY')
    .option('--yes', 'Final non-TTY ack — pair with --confirm "clear-data"')
    .action(async function (this: Command) {
      const opts = this.opts<{ confirm?: string; yes?: boolean }>();
      await clearDataCmd.clearData({ ...pickGlobals(this), ...opts });
    });

  program
    .command('uninstall')
    .description('Full reset: wipe ~/.lwr, remove all AI-tool skill symlinks, and `npm unlink` the lwr binary. Requires --confirm "uninstall" --yes (or interactive).')
    .option('--confirm <action>', 'Type the literal "uninstall" to acknowledge — required in non-TTY')
    .option('--yes', 'Final non-TTY ack — pair with --confirm "uninstall"')
    .action(async function (this: Command) {
      const opts = this.opts<{ confirm?: string; yes?: boolean }>();
      await uninstallCmd.uninstall({ ...pickGlobals(this), ...opts });
    });

  // Footer printed at the bottom of `lwr --help` (and bare `lwr`). Tells
  // any agent loading just the help output where the agent-friendly
  // skill content lives — the chicken-and-egg fallback for hosts whose
  // skill-loading didn't (or couldn't) wire SKILL.md in.
  program.addHelpText(
    'after',
    [
      '',
      'For agent-friendly usage:',
      '  Skill:   ~/.lwr/skill/SKILL.md  (read this first)',
      '  Recipes: ~/.lwr/skill/recipes/',
      '  Or:      `lwr skill-paths --json`',
      '',
      'On an unsupported host (Kilo, Continue, …):',
      '  `lwr install-skill --target ~/.<host>/skills/lw-redmine`',
    ].join('\n'),
  );

  return program;
}

async function main(): Promise<void> {
  // Bootstrap the assistant observer iff the persisted feature flag is
  // on. Disabled state is a cheap no-op (one config-file read at most;
  // no observer is registered, so runCommand's null-check short-
  // circuits with zero allocation).
  bootstrapAssistantObserver();
  // Wire the daily-rollover detector into the pre-flight slot. Surfaces
  // `meta.dailyRollover` + a stderr warning when the active issue was
  // left in a dev-active status overnight (or >4h gap on the same day).
  bootstrapDailyRollover();

  const program = build();
  await program.parseAsync(process.argv);
}

main().catch(err => {
  // Last-resort handler. `runCommand` already formats LwrError; this only
  // catches errors raised before a command starts (e.g. commander parse).
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

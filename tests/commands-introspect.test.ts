/**
 * Contract tests for `lwr commands` — the agent-facing CLI introspection.
 *
 * Two invariants:
 *   1. Every leaf command in the live commander tree has an entry in
 *      COMMAND_ANNOTATIONS. (Forgetting one would ship `safety: "unknown"`
 *      to agents — fail CI instead.)
 *   2. The serializer's payload is stable in shape — names dotted, args +
 *      options populated, --filter narrows correctly, no Redmine call.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { buildPayload } from '../src/commands/commands';
import { COMMAND_ANNOTATIONS } from '../src/cli-annotations';

/**
 * Build a *minimal* program tree that mirrors `cli.ts`'s shape — the same
 * groups + subcommands, with empty action handlers. We don't need the real
 * action wiring; the serializer only walks `name`, `description`,
 * `options`, `commands`, and `registeredArguments`.
 *
 * Keep this in sync with `cli.ts` when commands are added/removed; the
 * "every annotation key exists in the tree" assertion will fail otherwise.
 */
function buildMockProgram(): Command {
  const program = new Command();
  program
    .name('lwr')
    .option('--json', 'json output')
    .option('--no-color', 'disable color')
    .option('--profile <name>', 'profile to use');

  const auth = program.command('auth');
  auth.command('login').description('login').option('--username <u>', 'user');
  auth.command('logout').description('logout').option('--confirm <a>', 'confirm');
  auth.command('whoami').description('whoami');

  const profile = program.command('profile');
  profile.command('list').description('list profiles');
  profile.command('use <name>').description('use profile');
  profile.command('remove <name>').description('remove profile');

  const me = program.command('me');
  me.command('show').description('show me');
  me.command('detect').description('detect roles');
  const meSet = me.command('set');
  meSet.command('field-map <role> <cfId> <name>').description('field map override');

  const project = program.command('project');
  project.command('list').description('list projects').option('--limit <n>', 'limit');
  project.command('use <id>').description('use project');
  project.command('members <id>').description('members');
  project.command('versions <id>').description('versions');
  project.command('resolve <query>').description('resolve');

  const issue = program.command('issue');
  issue.command('use <id>').description('use issue');
  issue.command('current').description('current issue');
  issue.command('active').description('live active issue');
  issue.command('resolve <id>').description('mark resolved + log time')
    .option('--spent <d>', 'duration')
    .option('--activity <n>', 'activity')
    .option('--note <t>', 'note');
  issue.command('clear').description('clear active issue');
  issue.command('prune').description('prune issue dirs').option('--before <d>', 'before').option('--keep <n>', 'keep');
  issue.command('pause').description('pause active session').option('--status <s>', 'status').option('--note <n>', 'note');
  issue.command('list').description('list issues').option('--project <id>', 'project');
  issue.command('view <id>').description('view');
  issue.command('create').description('create issue');
  issue.command('edit <id>').description('edit issue');
  issue.command('fetch <id>').description('fetch');
  issue.command('attach <id> <files...>').description('attach');
  issue.command('status <id> <status>').description('status');
  issue.command('close <id>').description('close');
  issue.command('assign <id> <user>').description('assign');
  issue.command('watch <id>').description('watch');
  issue.command('unwatch <id>').description('unwatch');
  issue.command('open <id>').description('open');
  issue.command('transitions <id>').description('transitions');
  issue.command('note <id>').description('note');
  issue
    .command('handover [id]')
    .description('daily rollover handover')
    .option('--stopped <t>', 'stopped time')
    .option('--mode <m>', 'mode')
    .option('--note <n>', 'note')
    .option('--dismiss', 'dismiss');

  const log = program.command('log');
  log.command('show').description('show day').option('--today', 'today').option('--yesterday', 'yesterday').option('--date <d>', 'date');
  log.command('clear').description('clear').option('--before <d>', 'before');

  const feedback = program.command('feedback');
  feedback
    .command('log')
    .description('log incident')
    .option('--kind <k>', 'kind')
    .option('--query <q>', 'query')
    .option('--reason <r>', 'reason')
    .option('--attempt <a>', 'attempt', (val: string, prev: string[] = []) => [...prev, val]);
  feedback.command('list').description('list incidents').option('--since <d>', 'since').option('--kind <k>', 'kind');
  feedback.command('show <ref>').description('show one incident');

  const prefs = program.command('prefs');
  prefs
    .command('add')
    .description('teach a rule')
    .requiredOption('--when <cf=v>', 'condition')
    .option('--set <cf=v...>', 'targets', (val: string, prev: string[] = []) => [...prev, val])
    .option('--reason <r>', 'reason')
    .option('--agent <a>', 'agent')
    .option('--id <id>', 'rule id');
  prefs.command('remove <id>').description('remove a rule');
  prefs.command('list').description('list rules');

  const time = program.command('time');
  time.command('log <id>').description('log').option('--hours <n>', 'hours');
  time.command('list').description('list time entries');
  time.command('edit <entry-id>').description('edit time entry');
  time.command('delete <entry-id>').description('delete time entry');
  time.command('activities').description('list activities');

  program.command('search <query>').description('search');

  const status = program.command('status');
  status.command('list').description('status list');

  const user = program.command('user');
  user.command('list').description('user list');
  user.command('import <file>').description('user import');
  user.command('resolve <query>').description('user resolve');

  const cache = program.command('cache');
  cache.command('list').description('cache list');
  cache.command('clear').description('cache clear');
  cache.command('refresh').description('cache refresh');

  const assistant = program.command('assistant');
  assistant.command('enable').description('enable');
  assistant.command('disable').description('disable');
  assistant.command('status').description('status');

  const events = program.command('events');
  events.command('status').description('events status');

  const memory = program.command('memory');
  memory
    .command('recall [query]')
    .description('recall memory')
    .option('--kind <k>', 'kind')
    .option('--cf-id <id>', 'cf id')
    .option('--rule-id <id>', 'rule id')
    .option('--limit <n>', 'limit')
    .option('--include-superseded', 'include superseded');
  memory.command('status').description('memory status');
  memory.command('prune').description('memory prune');

  const config = program.command('config');
  config.command('base-url <url>').description('set base url');

  const backup = program.command('backup');
  backup.command('create').description('create backup').option('--out <p>', 'out path');
  backup.command('list').description('list backups');
  backup.command('prune').description('prune old backups').option('--keep <n>', 'keep').option('--kind <k>', 'kind');
  program
    .command('restore <file>')
    .description('restore from backup')
    .option('--confirm <a>', 'confirm')
    .option('--yes', 'yes');

  program.command('home').description('landing view');
  program.command('commands').description('introspect').option('--filter <p>', 'filter');
  program.command('serve').description('mcp server').option('--mcp', 'mcp mode');
  program.command('doctor').description('doctor');
  program.command('update').description('update lwr itself');
  program.command('update-skill').description('update skill');
  program.command('skill-paths').description('skill paths');
  program.command('install-skill').description('install skill').option('--target <dir>', 'target dir');
  program.command('clear-data').description('clear data');
  program.command('uninstall').description('uninstall');

  return program;
}

describe('lwr commands', () => {
  it('emits a non-empty list of leaf commands', () => {
    const payload = buildPayload(buildMockProgram());
    expect(payload.totalCommands).toBeGreaterThan(20);
    expect(payload.commands.every(c => c.name.length > 0)).toBe(true);
  });

  it('uses dotted paths matching the JSON envelope `command` field', () => {
    const payload = buildPayload(buildMockProgram());
    const names = payload.commands.map(c => c.name);
    expect(names).toContain('issue.list');
    expect(names).toContain('time.log');
    expect(names).toContain('me.set.field-map');
    expect(names).toContain('cache.refresh');
    // Top-level (single-segment) commands stay single-segment:
    expect(names).toContain('search');
    expect(names).toContain('doctor');
    expect(names).toContain('clear-data');
  });

  it('serializes positional args (required, variadic flags)', () => {
    const payload = buildPayload(buildMockProgram());
    const attach = payload.commands.find(c => c.name === 'issue.attach');
    expect(attach).toBeDefined();
    // <id> is required, single. <files...> is required, variadic.
    expect(attach!.args).toEqual([
      { name: 'id', required: true, variadic: false },
      { name: 'files', required: true, variadic: true },
    ]);
  });

  it('serializes options with --long, argName placeholder, description', () => {
    const payload = buildPayload(buildMockProgram());
    const log = payload.commands.find(c => c.name === 'time.log');
    expect(log).toBeDefined();
    const hours = log!.options.find(o => o.long === '--hours');
    expect(hours).toBeDefined();
    expect(hours!.argName).toBe('<n>');
  });

  it('every leaf in the tree has an annotation in the registry', () => {
    // The load-bearing invariant. If this fails, an agent calling
    // `lwr commands --json` would see `safety: "unknown"` for the
    // un-annotated leaf — better to fail the test.
    const payload = buildPayload(buildMockProgram());
    const unannotated = payload.commands.filter(c => c.safety === 'unknown');
    expect(unannotated, `Missing annotations for: ${unannotated.map(c => c.name).join(', ')}`).toEqual([]);
  });

  it('every annotation key corresponds to a real leaf in the tree', () => {
    // Inverse direction: if we delete a command from the tree but forget
    // to drop its annotation, this fails. Keeps the registry honest.
    const payload = buildPayload(buildMockProgram());
    const treeNames = new Set(payload.commands.map(c => c.name));
    const orphaned = Object.keys(COMMAND_ANNOTATIONS).filter(k => !treeNames.has(k));
    expect(orphaned, `Annotations exist for non-existent commands: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('--filter narrows by dotted prefix', () => {
    const all = buildPayload(buildMockProgram());
    const issueOnly = buildPayload(buildMockProgram(), 'issue');
    expect(issueOnly.totalCommands).toBeLessThan(all.totalCommands);
    expect(issueOnly.commands.every(c => c.name.startsWith('issue.'))).toBe(true);
    expect(issueOnly.query).toEqual({ filter: 'issue' });
  });

  it('--filter accepts an exact leaf name', () => {
    const filtered = buildPayload(buildMockProgram(), 'issue.list');
    expect(filtered.totalCommands).toBe(1);
    expect(filtered.commands[0].name).toBe('issue.list');
  });

  it('exposes top-level globals separately from per-command options', () => {
    const payload = buildPayload(buildMockProgram());
    const longs = payload.globals.map(o => o.long);
    expect(longs).toContain('--json');
    expect(longs).toContain('--profile');
  });

  it('classifies destructive verbs correctly', () => {
    const payload = buildPayload(buildMockProgram());
    const destructive = payload.commands.filter(c => c.safety === 'destructive').map(c => c.name).sort();
    // The user/agent contract — these are the only verbs that should ever
    // require `--confirm "<action>" --yes` for an agent.
    expect(destructive).toEqual([
      'auth.logout',
      'backup.prune',
      'cache.clear',
      'clear-data',
      'issue.prune',
      'log.clear',
      'memory.prune',
      'profile.remove',
      'restore',
      'time.delete',
      'uninstall',
    ]);
  });
});

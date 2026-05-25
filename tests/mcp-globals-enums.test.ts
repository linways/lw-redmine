/**
 * MCP `tools/list` schema + `tools/call` argv pass-through for:
 *   1. Agent-relevant root-program globals (`--dry-run`, `--profile`,
 *      `--base-url`, `--api-key`, `--debug`) merged onto every tool.
 *   2. Enum constraints on options (pipe-separated placeholder or
 *      explicit registry).
 *
 * Both are agent-visible: bad enum guesses cost a round-trip with a
 * VALIDATION error; missing globals make `--dry-run` unreachable from
 * MCP entirely (the audit's F-01).
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { buildTools, pickAgentGlobals } from '../src/mcp/tools';
import { buildArgv } from '../src/mcp/argv';
import { buildPayload } from '../src/commands/commands';
import type { SerializedCommand, SerializedOption } from '../src/commands/commands';

/** Minimal commander program shaped like the real lwr root + a leaf. */
function makeProgram(): Command {
  const program = new Command('lwr')
    .option('--json', 'output JSON envelope')
    .option('--no-interactive', 'never prompt')
    .option('--no-color', 'disable color')
    .option('--silent', 'suppress stderr')
    .option('--debug', 'verbose stderr')
    .option('--profile <name>', 'profile')
    .option('--base-url <url>', 'override base url')
    .option('--api-key <key>', 'override api key')
    .option('--dry-run', 'show would-do without sending');

  const issue = program.command('issue').description('issues');
  issue
    .command('handover [id]')
    .description('reconcile rollover signal')
    .option('--stopped <time>', 'stopped at')
    .option('--mode <pause|resolve|resume>', 'what to do after')
    .option('--dismiss', 'just ack today');

  issue
    .command('list')
    .description('list issues')
    .option('--as <lens>', 'role lens (developer|tester|...)')
    .option('--cf <kv>', 'repeatable cf', (val: string, prev: string[] = []) => [...prev, val]);

  return program;
}

describe('pickAgentGlobals', () => {
  it('filters root globals to the allowlist (dry-run, profile, base-url, api-key, debug)', () => {
    const program = makeProgram();
    const globals = buildPayload(program).globals;
    const picked = pickAgentGlobals(globals).map(g => g.long).sort();
    expect(picked).toEqual(['--api-key', '--base-url', '--debug', '--dry-run', '--profile']);
  });

  it('excludes --json / --no-interactive / --no-color / --silent (auto-handled or output-shaping)', () => {
    const program = makeProgram();
    const picked = pickAgentGlobals(buildPayload(program).globals).map(g => g.long);
    expect(picked).not.toContain('--json');
    expect(picked).not.toContain('--no-interactive');
    expect(picked).not.toContain('--no-color');
    expect(picked).not.toContain('--silent');
  });
});

describe('buildTools — global-flag merge', () => {
  it('exposes --dry-run / --profile / --base-url / --api-key / --debug on every leaf tool', () => {
    const program = makeProgram();
    const tools = buildTools(program);
    for (const t of tools) {
      const props = t.inputSchema.properties;
      expect(props).toHaveProperty('dryRun');
      expect(props.dryRun).toMatchObject({ type: 'boolean' });
      expect(props).toHaveProperty('profile');
      expect(props.profile).toMatchObject({ type: 'string' });
      expect(props).toHaveProperty('baseUrl');
      expect(props).toHaveProperty('apiKey');
      expect(props).toHaveProperty('debug');
    }
  });

  it('command-specific options take precedence on key collision (no overwrite)', () => {
    // If we ever introduce a per-command --profile (currently we don't),
    // the global merge MUST skip — otherwise the command-specific schema
    // would be silently overwritten.
    const program = new Command('lwr')
      .option('--profile <name>', 'GLOBAL profile');
    program
      .command('sub')
      .description('sub')
      .option('--profile <local>', 'LOCAL profile override');
    const tools = buildTools(program);
    const sub = tools.find(t => t.name === 'sub');
    expect(sub).toBeDefined();
    expect(sub!.inputSchema.properties.profile.description).toBe('LOCAL profile override');
  });
});

describe('buildTools — enum extraction', () => {
  it('extracts enum from placeholder `<a|b|c>` (handover --mode)', () => {
    const program = makeProgram();
    const tools = buildTools(program);
    const handover = tools.find(t => t.name === 'issue_handover');
    expect(handover).toBeDefined();
    expect(handover!.inputSchema.properties.mode).toMatchObject({
      type: 'string',
      enum: ['pause', 'resolve', 'resume'],
    });
  });

  it('honors ENUM_OPTIONS registry (issue.list --as)', () => {
    const program = makeProgram();
    const tools = buildTools(program);
    const list = tools.find(t => t.name === 'issue_list');
    expect(list).toBeDefined();
    expect(list!.inputSchema.properties.as).toMatchObject({ type: 'string' });
    // The registry is keyed on the production cmd.name ('issue.list'),
    // which matches the test program's leaf path → enum applied.
    expect(list!.inputSchema.properties.as.enum).toEqual([
      'developer', 'tester', 'qa', 'lead', 'assignee', 'reporter', 'any',
    ]);
  });

  it('leaves non-enum options untouched (e.g. --stopped <time>)', () => {
    const program = makeProgram();
    const tools = buildTools(program);
    const handover = tools.find(t => t.name === 'issue_handover');
    expect(handover!.inputSchema.properties.stopped).toMatchObject({ type: 'string' });
    expect(handover!.inputSchema.properties.stopped).not.toHaveProperty('enum');
  });
});

describe('buildArgv — globals pass-through', () => {
  /** A cmd shape that mirrors `issue handover [id] --mode <…>`. */
  const handoverCmd: SerializedCommand = {
    name: 'issue.handover',
    path: ['issue', 'handover'],
    description: 'handover',
    args: [{ name: 'id', required: false, variadic: false }],
    options: [
      { long: '--mode', argName: '<pause|resolve|resume>', description: 'mode', required: false, negate: false, repeatable: false },
      { long: '--dismiss', description: 'ack', required: false, negate: false, repeatable: false },
    ],
    safety: 'mutate',
    idempotent: false,
    network: true,
  };
  const globals: SerializedOption[] = [
    { long: '--dry-run', description: 'dry run', required: false, negate: false, repeatable: false },
    { long: '--profile', argName: '<name>', description: 'profile', required: false, negate: false, repeatable: false },
    { long: '--debug', description: 'debug', required: false, negate: false, repeatable: false },
  ];

  it('emits --dry-run when dryRun:true passed by the agent', () => {
    const argv = buildArgv(handoverCmd, { args: { id: '12345', mode: 'pause', dryRun: true }, globals });
    expect(argv).toContain('--dry-run');
    // Order: command path, positional, command options, globals, forced flags.
    expect(argv.indexOf('--dry-run')).toBeGreaterThan(argv.indexOf('--mode'));
  });

  it('emits --profile <name> when profile passed', () => {
    const argv = buildArgv(handoverCmd, { args: { id: '12345', dismiss: true, profile: 'work' }, globals });
    const i = argv.indexOf('--profile');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('work');
  });

  it('does NOT emit globals the agent did not pass', () => {
    const argv = buildArgv(handoverCmd, { args: { id: '12345', dismiss: true }, globals });
    expect(argv).not.toContain('--dry-run');
    expect(argv).not.toContain('--profile');
    expect(argv).not.toContain('--debug');
  });

  it('coexists with --json / --no-interactive forced suffix', () => {
    const argv = buildArgv(handoverCmd, { args: { id: '12345', dismiss: true, dryRun: true }, globals });
    // The forced flags land AFTER the globals.
    const dryIdx = argv.indexOf('--dry-run');
    const jsonIdx = argv.indexOf('--json');
    expect(dryIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(dryIdx);
  });
});

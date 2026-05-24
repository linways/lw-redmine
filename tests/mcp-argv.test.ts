/**
 * Tests for the MCP→CLI argv translator. Pure function, no I/O.
 */

import { describe, expect, it } from 'vitest';
import { buildArgv, normaliseArgs, toolNameFromPath, toolNameToPath } from '../src/mcp/argv';
import type { SerializedCommand } from '../src/commands/commands';

const issueList: SerializedCommand = {
  name: 'issue.list',
  path: ['issue', 'list'],
  description: 'List issues',
  args: [],
  options: [
    { long: '--project', argName: '<id>', description: 'project', required: false, negate: false, repeatable: false },
    { long: '--as', argName: '<lens>', description: 'role lens', required: false, negate: false, repeatable: false },
    { long: '--sprint', argName: '<id-or-name>', description: 'sprint', required: false, negate: false, repeatable: false },
    { long: '--all', description: 'fetch every page', required: false, negate: false, repeatable: false },
    { long: '--cf', argName: '<kv>', description: 'repeatable cf', required: false, negate: false, repeatable: true },
  ],
  safety: 'read',
  idempotent: true,
  network: true,
};

const timeLog: SerializedCommand = {
  name: 'time.log',
  path: ['time', 'log'],
  description: 'Log time',
  args: [{ name: 'id', required: true, variadic: false }],
  options: [
    { long: '--hours', argName: '<n>', description: 'hours', required: false, negate: false, repeatable: false },
    { long: '--activity', argName: '<name>', description: 'activity', required: false, negate: false, repeatable: false },
    { long: '--date', argName: '<yyyy-mm-dd>', description: 'date', required: false, negate: false, repeatable: false },
  ],
  safety: 'mutate',
  idempotent: false,
  network: true,
};

const issueAttach: SerializedCommand = {
  name: 'issue.attach',
  path: ['issue', 'attach'],
  description: 'Attach files',
  args: [
    { name: 'id', required: true, variadic: false },
    { name: 'files', required: true, variadic: true },
  ],
  options: [{ long: '--message', argName: '<text>', description: 'note', required: false, negate: false, repeatable: false }],
  safety: 'mutate',
  idempotent: false,
  network: true,
};

describe('toolNameFromPath / toolNameToPath', () => {
  it('round-trips simple paths', () => {
    expect(toolNameFromPath(['issue', 'list'])).toBe('issue_list');
    expect(toolNameToPath('issue_list')).toEqual(['issue', 'list']);
  });
  it('preserves hyphens inside segment names', () => {
    expect(toolNameFromPath(['me', 'set', 'field-map'])).toBe('me_set_field-map');
    expect(toolNameToPath('me_set_field-map')).toEqual(['me', 'set', 'field-map']);
  });
  it('handles single-segment commands', () => {
    expect(toolNameFromPath(['clear-data'])).toBe('clear-data');
    expect(toolNameToPath('clear-data')).toEqual(['clear-data']);
  });
});

describe('buildArgv', () => {
  it('emits command path then options, plus --json --no-interactive by default', () => {
    const argv = buildArgv(issueList, { args: { as: 'developer', sprint: 1055 } });
    expect(argv[0]).toBe('issue');
    expect(argv[1]).toBe('list');
    expect(argv).toContain('--as');
    expect(argv).toContain('developer');
    expect(argv).toContain('--sprint');
    expect(argv).toContain('1055');
    expect(argv).toContain('--json');
    expect(argv).toContain('--no-interactive');
  });

  it('emits booleans as bare flags when true', () => {
    const argv = buildArgv(issueList, { args: { all: true } });
    expect(argv).toContain('--all');
    // Don't synthesise a value
    expect(argv).not.toContain('true');
  });

  it('omits booleans when false', () => {
    const argv = buildArgv(issueList, { args: { all: false } });
    expect(argv).not.toContain('--all');
  });

  it('expands array values into repeated --flag value pairs', () => {
    const argv = buildArgv(issueList, { args: { cf: ['79=57', '88=42'] } });
    // Two `--cf` flags, each followed by its value.
    const cfIndices = argv.reduce<number[]>((acc, v, i) => (v === '--cf' ? [...acc, i] : acc), []);
    expect(cfIndices).toHaveLength(2);
    expect(argv[cfIndices[0] + 1]).toBe('79=57');
    expect(argv[cfIndices[1] + 1]).toBe('88=42');
  });

  it('emits required positional args before flags', () => {
    const argv = buildArgv(timeLog, { args: { id: 125415, hours: 2.5, activity: 'Development' } });
    expect(argv).toEqual([
      'time',
      'log',
      '125415',
      '--hours',
      '2.5',
      '--activity',
      'Development',
      '--json',
      '--no-interactive',
    ]);
  });

  it('expands variadic positional args in place', () => {
    const argv = buildArgv(issueAttach, {
      args: { id: 64602, files: ['./a.png', './b.txt'], message: 'note' },
    });
    expect(argv).toEqual([
      'issue',
      'attach',
      '64602',
      './a.png',
      './b.txt',
      '--message',
      'note',
      '--json',
      '--no-interactive',
    ]);
  });

  it('throws when a required positional is missing', () => {
    expect(() => buildArgv(timeLog, { args: { hours: 1 } })).toThrow(/Missing required positional/);
  });

  it('omits options not provided', () => {
    const argv = buildArgv(timeLog, { args: { id: 1, hours: 1 } });
    expect(argv).not.toContain('--activity');
    expect(argv).not.toContain('--date');
  });
});

describe('normaliseArgs', () => {
  it('produces both kebab and camelCase keys so either lookup works', () => {
    const n = normaliseArgs({ 'no-color': true });
    expect(n).toMatchObject({ noColor: true, 'no-color': true });
  });
});

describe('buildArgv injection guards', () => {
  it('rejects positionals beginning with - to prevent option injection', () => {
    expect(() =>
      buildArgv(timeLog, { args: { id: '--profile=evil', hours: 1 } }),
    ).toThrow(/may not start with '-'/);
  });

  it('rejects negative-id-style positionals (also leading -)', () => {
    expect(() => buildArgv(timeLog, { args: { id: '-5', hours: 1 } })).toThrow(/may not start with '-'/);
  });

  it('rejects variadic positional elements that begin with -', () => {
    expect(() =>
      buildArgv(issueAttach, {
        args: { id: 1, files: ['./safe.png', '--evil'] },
      }),
    ).toThrow(/may not start with '-'/);
  });

  it('accepts paths that begin with ./ (the documented escape hatch)', () => {
    const argv = buildArgv(issueAttach, {
      args: { id: 1, files: ['./-foo.png'] },
    });
    expect(argv).toContain('./-foo.png');
  });

  it('rejects arrays for non-repeatable options', () => {
    expect(() =>
      buildArgv(timeLog, { args: { id: 1, hours: ['1', '2'] } }),
    ).toThrow(/not repeatable/);
  });

  it('still accepts arrays for repeatable options (--cf)', () => {
    const argv = buildArgv(issueList, { args: { cf: ['79=42', '80=11'] } });
    expect(argv.filter(a => a === '--cf')).toHaveLength(2);
  });

  it('accepts a single string for a repeatable option as well', () => {
    const argv = buildArgv(issueList, { args: { cf: '79=42' } });
    expect(argv).toContain('--cf');
    expect(argv).toContain('79=42');
  });
});

describe('buildArgv negate-option semantics', () => {
  // Build a command that has both a regular boolean and a negate boolean,
  // so we can pin the asymmetric emit rules.
  const cmd: SerializedCommand = {
    name: 'test.cmd',
    path: ['test', 'cmd'],
    description: '',
    args: [],
    options: [
      { long: '--debug', description: 'regular boolean', required: false, negate: false, repeatable: false },
      { long: '--no-color', description: 'negate boolean', required: false, negate: true, repeatable: false },
      { long: '--no-interactive', description: 'negate boolean', required: false, negate: true, repeatable: false },
    ],
    safety: 'read',
    idempotent: true,
    network: false,
  };

  it('regular boolean: emits flag only when value is true', () => {
    expect(buildArgv(cmd, { args: { debug: true } })).toContain('--debug');
    expect(buildArgv(cmd, { args: { debug: false } })).not.toContain('--debug');
    expect(buildArgv(cmd, { args: {} })).not.toContain('--debug');
  });

  it('negate boolean: emits flag only when value is explicitly false', () => {
    // Default (true) → omit; only `false` flips it.
    expect(buildArgv(cmd, { args: { noColor: false } })).toContain('--no-color');
    expect(buildArgv(cmd, { args: { noColor: true } })).not.toContain('--no-color');
    // Omitting the key entirely keeps the default (true) — no flag emitted.
    expect(buildArgv(cmd, { args: {} })).not.toContain('--no-color');
  });

  it('always-on --json --no-interactive still appended after a negate flip', () => {
    const argv = buildArgv(cmd, { args: { noInteractive: false } });
    // Note: even though --no-interactive is in our cmd's options as a
    // negate flag with value=false → emitted, the always-on suffix
    // appends another --no-interactive at the end. Both land in argv;
    // commander's last-wins resolves cleanly.
    const noInteractiveCount = argv.filter(a => a === '--no-interactive').length;
    expect(noInteractiveCount).toBeGreaterThanOrEqual(1);
    expect(argv).toContain('--json');
  });
});

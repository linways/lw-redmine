/**
 * `lwr commands [--filter prefix]`
 *
 * Machine-readable enumeration of every leaf command in the CLI tree.
 *
 * Why this exists:
 *   Agents shouldn't have to read 700 lines of SKILL.md prose to discover
 *   what `lwr` can do. They call this once, cache the result, and have a
 *   structured map of (path, args, options, description, safety, idempotent,
 *   network) for every verb. Same shape will back the future MCP
 *   `tools/list` so we keep one source of truth for the CLI surface.
 *
 *   No Redmine round-trip — pure walk of the in-memory commander tree
 *   plus the static annotations registry. Cheap to call.
 */

import type { Command, Option } from 'commander';
import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../foundation/run';
import { writeLine } from '../foundation/output';
import { renderTable, dim, header } from '../foundation/format';
import { COMMAND_ANNOTATIONS, REPEATABLE_OPTIONS, type CommandAnnotation } from '../cli-annotations';

export interface CommandsFlags extends GlobalFlags {
  /** Restrict output to commands whose dotted path starts with this prefix. */
  filter?: string;
}

export interface SerializedArg {
  name: string;
  required: boolean;
  variadic: boolean;
  description?: string;
}

export interface SerializedOption {
  long: string;
  short?: string;
  /** The placeholder bit, e.g. "<id>", "<id-or-name>", or undefined for booleans. */
  argName?: string;
  description: string;
  /** Required by commander (`--flag <x>` declared as required). */
  required: boolean;
  /** `--no-color`-style negated boolean flags. */
  negate: boolean;
  /** True when the option accumulates values (e.g. `--cf` → array). */
  repeatable: boolean;
}

export interface SerializedCommand {
  /** Dotted path matching the JSON envelope `command` field, e.g. `issue.list`. */
  name: string;
  /** Same path as an array, easier for agents to compose. */
  path: string[];
  description: string;
  args: SerializedArg[];
  options: SerializedOption[];
  /** Annotation lookup result; `undefined` only if the registry is missing an entry. */
  safety: CommandAnnotation['safety'] | 'unknown';
  idempotent: boolean | null;
  network: boolean | null;
}

export interface CommandsPayload {
  totalCommands: number;
  /** Top-level flags that apply to every command (auto-pulled from the root program). */
  globals: SerializedOption[];
  commands: SerializedCommand[];
  /** Set when --filter excluded everything else. */
  query?: { filter?: string };
}

/**
 * Walk a commander Command tree and return only the *leaf* commands —
 * groups (`auth`, `profile`, `me`, `me set`, `issue`, `time`, `cache`,
 * `user`, `status`, `project`) are dispatchers, not agent-callable verbs,
 * so they're skipped.
 */
function walkLeaves(node: Command, path: string[] = []): SerializedCommand[] {
  const out: SerializedCommand[] = [];
  for (const child of node.commands) {
    if (child.name() === 'help') continue;
    const childPath = [...path, child.name()];
    if (child.commands.length > 0) {
      // Group: descend, don't emit.
      out.push(...walkLeaves(child, childPath));
    } else {
      out.push(serializeCommand(child, childPath));
    }
  }
  return out;
}

function serializeCommand(cmd: Command, path: string[]): SerializedCommand {
  const dotted = path.join('.');
  const ann = COMMAND_ANNOTATIONS[dotted];
  const repeatable = REPEATABLE_OPTIONS[dotted] ?? new Set<string>();

  return {
    name: dotted,
    path,
    description: cmd.description() ?? '',
    args: serializeArgs(cmd),
    options: cmd.options.map(opt => {
      const o = serializeOption(opt);
      return { ...o, repeatable: repeatable.has(o.long) };
    }),
    safety: ann ? ann.safety : 'unknown',
    idempotent: ann ? ann.idempotent : null,
    network: ann ? ann.network : null,
  };
}

/**
 * Pull positional argument metadata from commander. Public access varies
 * by version; we go through `registeredArguments` (commander v12+) and
 * fall back to the synopsis parser if it isn't present.
 */
function serializeArgs(cmd: Command): SerializedArg[] {
  const reg = (cmd as unknown as { registeredArguments?: unknown[] }).registeredArguments;
  if (Array.isArray(reg)) {
    return reg.map(a => {
      const arg = a as { _name?: string; name?: () => string; required?: boolean; variadic?: boolean; description?: string };
      const name = typeof arg.name === 'function' ? arg.name() : (arg._name ?? 'arg');
      return {
        name,
        required: Boolean(arg.required),
        variadic: Boolean(arg.variadic),
        ...(arg.description ? { description: arg.description } : {}),
      };
    });
  }
  // Fallback: parse the usage string.
  return parseArgsFromUsage(cmd.usage());
}

function parseArgsFromUsage(usage: string): SerializedArg[] {
  const args: SerializedArg[] = [];
  // commander synopsis bits look like "<id>", "[id]", "<files...>".
  const re = /([<\[])([^>\]]+)([>\]])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(usage)) !== null) {
    const required = m[1] === '<';
    const raw = m[2];
    const variadic = raw.endsWith('...');
    const name = variadic ? raw.slice(0, -3) : raw;
    args.push({ name, required, variadic });
  }
  return args;
}

function serializeOption(opt: Option): SerializedOption {
  // commander Option exposes `long`, `short`, `flags`, `description`, `mandatory`, `negate`.
  const o = opt as unknown as {
    long?: string;
    short?: string;
    flags: string;
    description: string;
    mandatory?: boolean;
    negate?: boolean;
  };
  return {
    long: o.long ?? o.flags,
    ...(o.short ? { short: o.short } : {}),
    ...(extractArgName(o.flags) ? { argName: extractArgName(o.flags) as string } : {}),
    description: o.description ?? '',
    required: Boolean(o.mandatory),
    negate: Boolean(o.negate),
    repeatable: false,
  };
}

/** Pull the placeholder out of a flag definition like "--project <id>" → "<id>". */
function extractArgName(flags: string): string | undefined {
  const m = /\s([<\[][^>\]]+[>\]])$/.exec(flags);
  return m ? m[1] : undefined;
}

export function buildPayload(program: Command, filter?: string): CommandsPayload {
  let commands = walkLeaves(program);
  if (filter && filter.length > 0) {
    commands = commands.filter(c => c.name === filter || c.name.startsWith(`${filter}.`));
  }
  return {
    totalCommands: commands.length,
    globals: program.options.map(serializeOption),
    commands,
    ...(filter ? { query: { filter } } : {}),
  };
}

export function commandsCmd(program: Command) {
  return (flags: CommandsFlags): Promise<never> => {
    const cmd: CommandFn<CommandsPayload> = async (): Promise<CommandResult<CommandsPayload>> => {
      const payload = buildPayload(program, flags.filter);
      return {
        json: payload,
        pretty: ctx => {
          if (payload.commands.length === 0) {
            writeLine(dim(ctx, `No commands match filter "${flags.filter ?? ''}".`));
            return;
          }
          writeLine(header(ctx, `lwr — ${payload.totalCommands} command(s)${flags.filter ? ` (filter: ${flags.filter})` : ''}`));
          writeLine('');
          writeLine(
            renderTable(ctx, {
              head: ['Path', 'Safety', 'Idem', 'Net', 'Description'],
              rows: payload.commands.map(c => [
                c.name,
                c.safety,
                c.idempotent === null ? '?' : c.idempotent ? 'yes' : 'no',
                c.network === null ? '?' : c.network ? 'yes' : 'no',
                truncate(c.description, 60),
              ]),
              colWidths: [22, 12, 6, 5, 60],
            }),
          );
          writeLine('');
          writeLine(dim(ctx, `Run \`lwr commands --json\` for full args + options.`));
        },
      };
    };
    return runCommand('commands', flags, cmd);
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

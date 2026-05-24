/**
 * MCP `tools/call` arguments → lwr CLI argv.
 *
 * Pure translation. No side effects, no I/O. Tested in isolation, then
 * fed into the dispatcher which spawns the lwr binary with the resulting
 * argv array.
 *
 * Mapping rules:
 *   - Tool name uses underscore-joined dotted command path.
 *     `issue_list` → ["issue", "list"]
 *     `me_set_field-map` → ["me", "set", "field-map"]
 *     We split on `_` everywhere except inside option/arg names that
 *     happen to contain a hyphen — but command segments never do, except
 *     for `field-map` which is itself a hyphenated leaf. We resolve this
 *     by always splitting on the boundary present in the originating
 *     SerializedCommand.path (which IS the source of truth).
 *
 *   - Positional args are emitted in the order declared by the command's
 *     `args` array, before any flags. Variadic args expand in place.
 *
 *   - Options become `--long-name <value>` (commander's kebab-case).
 *     Booleans → bare flag if true, omitted if false. Arrays → repeated
 *     `--long <value>` pairs, one per element. Negate options
 *     (`--no-color`, `--no-interactive`) are emitted literally when
 *     `false` is passed; omitted when `true` (the default).
 *
 *   - We always append `--json` and `--no-interactive` so the spawned
 *     CLI returns a parseable envelope and never blocks on a prompt.
 */

import type { SerializedCommand, SerializedOption, SerializedArg } from '../commands/commands';

/**
 * Convert an MCP tool name back to a command-path array.
 *
 * Tool names are produced as `path.join('_')`, e.g.:
 *   ["issue", "list"]            → "issue_list"
 *   ["me", "set", "field-map"]   → "me_set_field-map"
 *   ["clear-data"]               → "clear-data"
 *
 * Splitting on `_` reverses the join; existing hyphens stay put because
 * they're not part of the join character.
 */
export function toolNameToPath(toolName: string): string[] {
  return toolName.split('_');
}

export function toolNameFromPath(path: string[]): string {
  return path.join('_');
}

export interface BuildArgvOptions {
  /**
   * MCP `tools/call.params.arguments` — keys are camelCase or kebab-case
   * matching the option's `--long` (minus the `--`) or the arg's `name`.
   */
  args: Record<string, unknown>;
  /** Always set; we never want a prompt from a spawned lwr. */
  forceJson?: boolean;
}

/**
 * Build argv from a SerializedCommand + an MCP arguments object.
 *
 * Returns the argv array suitable for `child_process.spawn(lwrBin, argv)`.
 *
 * Throws if a required positional arg is missing (the MCP layer should
 * have schema-validated already, but we double-check defensively).
 */
export function buildArgv(cmd: SerializedCommand, opts: BuildArgvOptions): string[] {
  const out: string[] = [];

  // 1. Command path: ["issue", "list"] → "issue list ..."
  out.push(...cmd.path);

  // 2. Positional args, in order.
  for (const arg of cmd.args) {
    const v = pickPositional(opts.args, arg);
    if (v === undefined || v === null) {
      if (arg.required) {
        throw new Error(`Missing required positional argument: <${arg.name}>`);
      }
      continue;
    }
    if (arg.variadic) {
      if (!Array.isArray(v)) {
        throw new Error(`Variadic argument <${arg.name}...> must be an array`);
      }
      for (const item of v) out.push(safePositional(arg.name, item));
    } else {
      out.push(safePositional(arg.name, v));
    }
  }

  // 3. Options.
  for (const opt of cmd.options) {
    const key = optionKey(opt);
    const val = opts.args[key];
    if (val === undefined) continue;

    // Boolean: bare flag.
    if (opt.argName === undefined) {
      // Negate option (`--no-color`): emit only when explicitly `false`.
      if (opt.negate) {
        if (val === false) out.push(opt.long);
      } else {
        if (val === true) out.push(opt.long);
      }
      continue;
    }

    if (Array.isArray(val)) {
      // Only repeatable options accept arrays. Anything else would either
      // silently overwrite (commander's last-wins behaviour) or smuggle
      // extra flags into argv.
      if (!opt.repeatable) {
        throw new Error(
          `Option ${opt.long} is not repeatable; pass a single string, not an array. ` +
          `(Repeatable options accept arrays; this one does not.)`,
        );
      }
      for (const item of val) {
        out.push(opt.long, String(item));
      }
      continue;
    }

    out.push(opt.long, String(val));
  }

  // 4. Always-on flags: JSON envelope + no prompts.
  if (opts.forceJson !== false) {
    out.push('--json', '--no-interactive');
  }

  return out;
}

/**
 * Resolve a positional value from the MCP args object. We accept the
 * arg's `name` directly (the canonical key the schema advertises).
 */
function pickPositional(args: Record<string, unknown>, arg: SerializedArg): unknown {
  return args[arg.name];
}

/**
 * Stringify a positional value, rejecting anything that begins with `-`
 * so a malicious tool-call input like `id: "--profile=attacker"` cannot
 * be consumed by commander as a flag rather than a positional. Filenames
 * that genuinely begin with a dash should be passed as `./-foo.png`.
 */
function safePositional(argName: string, value: unknown): string {
  const s = String(value);
  if (s.startsWith('-')) {
    throw new Error(
      `Positional <${argName}> may not start with '-' to prevent option injection ` +
      `(got ${JSON.stringify(s)}). Prefix file paths with './' if needed.`,
    );
  }
  return s;
}

/**
 * Compute the MCP-facing option key from a CLI option definition.
 *
 * `--my-flag` → `myFlag` (camelCase) is what we expose to MCP, since
 * agents prefer JS-friendly object keys. We normalize incoming MCP
 * arguments by checking both forms — agents can pass `myFlag` or
 * `my-flag` and either works.
 */
function optionKey(opt: SerializedOption): string {
  // Prefer the camelCase form; the dispatcher's "double lookup" below
  // also tries the kebab-case form for forgiving callers.
  const stripped = opt.long.replace(/^--/, '');
  return kebabToCamel(stripped);
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Pre-flight: normalise an args object so option keys can be looked up
 * by either casing. The dispatcher calls this before `buildArgv` so an
 * agent passing `{ "no-color": true }` and an agent passing
 * `{ noColor: true }` both work.
 */
export function normaliseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[kebabToCamel(k)] = v;
    // Keep the original too (positional names use literal form).
    out[k] = v;
  }
  return out;
}

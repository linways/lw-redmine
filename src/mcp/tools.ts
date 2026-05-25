/**
 * Generate the MCP `tools/list` response from lwr's existing introspection.
 *
 * Single source of truth: walks the same commander tree `lwr commands`
 * walks, then maps each leaf's args + options + annotations into an MCP
 * Tool with a JSON Schema input definition and the MCP-standard
 * `annotations` block (readOnlyHint / destructiveHint / idempotentHint /
 * openWorldHint).
 *
 * The mapping is deliberately permissive:
 *   - Boolean flags → `{ type: "boolean" }`
 *   - Anything with an arg placeholder (`<id>`, `<n>`, `<text>`) → string
 *     OR array of strings (so agents can pass repeated values for `--cf`,
 *     variadic positionals, etc. without us having to maintain a separate
 *     "is-repeatable" registry).
 *   - Variadic positionals → array of strings, required.
 *
 * Tool name = dotted command path with `.` replaced by `_`. So
 * `issue.list` → `issue_list`, `me.set.field-map` → `me_set_field-map`.
 */

import type { Command } from 'commander';
import type { SerializedCommand, SerializedOption } from '../commands/commands';
import { buildPayload } from '../commands/commands';
import { ENUM_OPTIONS } from '../cli-annotations';
import { toolNameFromPath } from './argv';

/**
 * Long-flag names of root-program globals that we expose to MCP agents.
 *
 * The full global set on `lwr` includes flags MCP doesn't want or that
 * the dispatcher hard-codes (--json / --no-interactive are auto-appended;
 * --silent / --no-color are output-shaping flags useless on a JSON-only
 * transport). The allowlist below picks only the ones an agent has a
 * concrete reason to override per-call.
 */
const AGENT_GLOBALS_ALLOWLIST: ReadonlySet<string> = new Set([
  '--dry-run',
  '--profile',
  '--base-url',
  '--api-key',
  '--debug',
]);

/**
 * Reusable filter: pick agent-relevant globals out of `payload.globals`.
 * Exported so the dispatcher uses the SAME filter — keeps the schema and
 * the argv emission perfectly in sync (any new entry to the allowlist
 * lights up both surfaces with no second change).
 */
export function pickAgentGlobals(globals: SerializedOption[]): SerializedOption[] {
  return globals.filter(g => AGENT_GLOBALS_ALLOWLIST.has(g.long));
}

/**
 * Subset of the MCP Tool shape we actually populate. Kept structural
 * (rather than `import type` from the SDK) so this module stays
 * compatible with the SDK living in ESM-only territory while we're CJS.
 */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpJsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpJsonSchema {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: McpJsonSchema;
  enum?: readonly string[];
  oneOf?: McpJsonSchema[];
}

export function buildTools(program: Command): McpTool[] {
  const payload = buildPayload(program);
  const agentGlobals = pickAgentGlobals(payload.globals);
  return payload.commands
    // `commands` and `serve` are agent-introspection-only — exposing them
    // as MCP tools is silly: the agent already knows the tool list (it
    // just received it), and `serve` would loop the server back into
    // itself.
    .filter(c => c.name !== 'commands' && c.name !== 'serve')
    .map(c => serializeAsMcpTool(c, agentGlobals));
}

function serializeAsMcpTool(cmd: SerializedCommand, agentGlobals: SerializedOption[]): McpTool {
  const properties: Record<string, McpJsonSchema> = {};
  const required: string[] = [];

  // Positional args first.
  for (const arg of cmd.args) {
    properties[arg.name] = arg.variadic
      ? { type: 'array', items: { type: 'string' }, description: arg.description ?? `Variadic <${arg.name}...>` }
      : { type: 'string', description: arg.description ?? `Positional <${arg.name}>` };
    if (arg.required) required.push(arg.name);
  }

  const enumRegistry = ENUM_OPTIONS[cmd.name] ?? {};

  // Options.
  for (const opt of cmd.options) {
    const key = camelKey(opt.long);
    properties[key] = optionSchema(opt, enumRegistry[opt.long]);
    if (opt.required) required.push(key);
  }

  // Agent-relevant globals merged in. Command-specific options win on
  // key collision (filter below) — defensible because if a command
  // explicitly redefines a global, the command-level semantics are
  // authoritative for that call.
  for (const g of agentGlobals) {
    const key = camelKey(g.long);
    if (key in properties) continue;
    properties[key] = optionSchema(g);
  }

  return {
    name: toolNameFromPath(cmd.path),
    title: cmd.path.join(' '),
    description: cmd.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: cmd.path.join(' '),
      // Read-only iff the static annotation says so.
      ...(cmd.safety === 'read' ? { readOnlyHint: true } : {}),
      ...(cmd.safety === 'destructive' ? { destructiveHint: true } : {}),
      idempotentHint: cmd.idempotent === true,
      // openWorldHint = "interacts with external systems" per MCP spec.
      // True for anything that hits Redmine; false for purely local
      // verbs (cache.list, profile.use, me.show, …).
      openWorldHint: cmd.network === true,
    },
  };
}

/**
 * Build the JSON Schema for a single option. Centralised so command-
 * specific options and merged globals follow identical rules (and any
 * future addition — e.g. `pattern` constraints on id-shaped positionals
 * — lands in one place).
 *
 * Enum precedence: explicit `enumValues` (from ENUM_OPTIONS) wins, then
 * pipe-separated alternatives auto-extracted from the placeholder
 * (`<pause|resolve|resume>` → `['pause','resolve','resume']`).
 */
function optionSchema(opt: SerializedOption, enumValues?: readonly string[]): McpJsonSchema {
  if (opt.argName === undefined) {
    // Boolean flag. Negate flags (`--no-color`) default to true; the
    // agent passes `false` to flip them.
    return {
      type: 'boolean',
      description: opt.description || (opt.negate ? `(default: true; pass false to disable)` : undefined),
    };
  }

  const enumFromPlaceholder = extractEnumFromPlaceholder(opt.argName);
  const finalEnum = enumValues ?? enumFromPlaceholder;

  if (opt.repeatable) {
    // Repeatable option (commander argParser accumulator). Accept a
    // single string or an array of strings; both expand to repeated
    // `--flag value` pairs at argv-build time. Enum (if any) applies
    // to each scalar value, so the oneOf branches share the same enum.
    const scalar: McpJsonSchema = { type: 'string', ...(finalEnum ? { enum: finalEnum } : {}) };
    return {
      oneOf: [scalar, { type: 'array', items: scalar }],
      description: opt.description,
    };
  }

  // Single-value option: strict string. Arrays here would silently
  // overwrite (commander last-wins) and are rejected at argv build
  // time, but advertising the narrower schema also helps well-behaved
  // MCP clients catch the bug client-side.
  return {
    type: 'string',
    ...(finalEnum ? { enum: finalEnum } : {}),
    description: opt.description,
  };
}

/**
 * Pull a pipe-separated enum out of an option placeholder. Returns
 * `undefined` for the common single-name forms (`<id>`, `<name>`) and
 * the brace/bracket forms commander itself uses.
 *
 * Examples:
 *   "<pause|resolve|resume>"  → ['pause', 'resolve', 'resume']
 *   "<id>"                    → undefined
 *   "[id]"                    → undefined
 *   "<some name>"             → undefined  (spaces aren't enums)
 */
function extractEnumFromPlaceholder(argName: string): readonly string[] | undefined {
  // Strip outer <…> or […].
  const m = /^[<\[]([^>\]]+)[>\]]$/.exec(argName.trim());
  if (!m) return undefined;
  const inner = m[1];
  if (!inner.includes('|')) return undefined;
  const parts = inner.split('|').map(s => s.trim()).filter(Boolean);
  // Sanity: each enum value should look like a flag/word (no spaces).
  if (parts.length < 2) return undefined;
  if (parts.some(p => /\s/.test(p))) return undefined;
  return parts;
}

function camelKey(longFlag: string): string {
  return longFlag.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

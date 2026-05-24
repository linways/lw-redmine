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
import type { SerializedCommand } from '../commands/commands';
import { buildPayload } from '../commands/commands';
import { toolNameFromPath } from './argv';

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
  return payload.commands
    // `commands` and `serve` are agent-introspection-only — exposing them
    // as MCP tools is silly: the agent already knows the tool list (it
    // just received it), and `serve` would loop the server back into
    // itself.
    .filter(c => c.name !== 'commands' && c.name !== 'serve')
    .map(serializeAsMcpTool);
}

function serializeAsMcpTool(cmd: SerializedCommand): McpTool {
  const properties: Record<string, McpJsonSchema> = {};
  const required: string[] = [];

  // Positional args first.
  for (const arg of cmd.args) {
    properties[arg.name] = arg.variadic
      ? { type: 'array', items: { type: 'string' }, description: arg.description ?? `Variadic <${arg.name}...>` }
      : { type: 'string', description: arg.description ?? `Positional <${arg.name}>` };
    if (arg.required) required.push(arg.name);
  }

  // Options.
  for (const opt of cmd.options) {
    const key = camelKey(opt.long);
    if (opt.argName === undefined) {
      // Boolean flag. Negate flags (`--no-color`) default to true; the
      // agent passes `false` to flip them.
      properties[key] = {
        type: 'boolean',
        description: opt.description || (opt.negate ? `(default: true; pass false to disable)` : undefined),
      };
    } else if (opt.repeatable) {
      // Repeatable option (commander argParser accumulator). Accept a
      // single string or an array of strings; both expand to repeated
      // `--flag value` pairs at argv-build time.
      properties[key] = {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: opt.description,
      };
    } else {
      // Single-value option: strict string. Arrays here would silently
      // overwrite (commander last-wins) and are rejected at argv build
      // time, but advertising the narrower schema also helps well-
      // behaved MCP clients catch the bug client-side.
      properties[key] = {
        type: 'string',
        description: opt.description,
      };
    }
    if (opt.required) required.push(key);
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

function camelKey(longFlag: string): string {
  return longFlag.replace(/^--/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

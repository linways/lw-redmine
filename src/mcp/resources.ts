/**
 * MCP resources exposed by lwr.
 *
 * Today there is exactly one: `lwr://me` — the rendered identity context
 * (`~/.lwr/me.md`). Why a resource rather than a tool: it's read-only
 * ambient context the agent uses to *interpret* the user's request, not
 * an action the agent takes.
 *
 * A future revival of this layer might add `lwr://commands` (the same
 * data `lwr commands --json` returns, surfaced as a resource so MCP
 * clients without tool-introspection UI can browse the surface) but for
 * v1 we keep it tight.
 */

import fs from 'node:fs';
import { meMarkdownPath } from '../foundation/paths';
import { wrapUntrusted } from './sentinel';

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** Spec-defined `_meta` and forward-compat extensions. */
  [extraField: string]: unknown;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  /** lwr always returns text contents (markdown). Required so the type
   *  matches the SDK's `ReadResourceResult.contents[*]` text variant. */
  text: string;
  /** Spec-defined `_meta` and forward-compat extensions. */
  [extraField: string]: unknown;
}

const ME_URI = 'lwr://me';

export function listResources(): McpResource[] {
  return [
    {
      uri: ME_URI,
      name: 'Active lwr profile (me.md)',
      description:
        'Rendered identity context for the active profile: user id/name, roles, custom-field bindings (Developer/Tester cf ids), project memberships, active project. Use this to interpret "me / my issues" in user requests before calling tools.',
      mimeType: 'text/markdown',
    },
  ];
}

export function readResource(uri: string): McpResourceContent {
  if (uri === ME_URI) {
    return readMe();
  }
  throw new Error(`Unknown resource URI: ${uri}`);
}

function readMe(): McpResourceContent {
  const path = meMarkdownPath();
  if (!fs.existsSync(path)) {
    // Surface a recognisable message rather than a raw ENOENT — the
    // agent can branch on the text or recommend `lwr auth login` to the
    // user. (MCP `resources/read` doesn't have an error envelope shape
    // as standardised as tools/call, so the convention is "throw" and
    // let the SDK marshal it.)
    throw new Error(
      `lwr profile not found: ${path}. The user has not run \`lwr auth login\` yet.`,
    );
  }
  return {
    uri: ME_URI,
    mimeType: 'text/markdown',
    text: wrapUntrusted(fs.readFileSync(path, 'utf8')),
  };
}

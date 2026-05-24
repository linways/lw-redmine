/**
 * MCP server entry — orchestrates SDK boot + handler registration.
 *
 * The `@modelcontextprotocol/sdk` package is pure ESM; lwr is CommonJS.
 * Rather than convert the whole project, we load the SDK lazily via
 * dynamic `import()` here. That confines the ESM/CJS boundary to one
 * file and lets the rest of lwr stay synchronous.
 *
 * Stdio transport only. A future iteration could add HTTP/SSE for
 * hosted deployments — see PLAN.md §15.7 if/when that becomes a real
 * requirement.
 */

import type { Command } from 'commander';
import type {
  CallToolResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { buildTools } from './tools';
import { dispatchTool } from './dispatch';
import { listResources, readResource } from './resources';
import { INSECURE_CONTENT_INSTRUCTIONS } from './sentinel';
import pkg from '../../package.json';

export interface StartMcpServerOptions {
  /** The commander root program — used to introspect the tool tree. */
  program: Command;
  /** Override the lwr binary path used when spawning subprocesses. */
  lwrBin?: string;
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  // Dynamic ESM imports.
  const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);

  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
  } = types;

  const server = new Server(
    { name: 'lwr', version: pkg.version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: INSECURE_CONTENT_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => ({ tools: buildTools(opts.program) }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> =>
      dispatchTool(opts.program, {
        toolName: req.params.name,
        args: req.params.arguments ?? {},
        lwrBin: opts.lwrBin,
      }),
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (): Promise<ListResourcesResult> => ({ resources: listResources() }),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (req): Promise<ReadResourceResult> => ({ contents: [readResource(req.params.uri)] }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // From here the server runs until the parent disconnects (EOF on stdin).
}

/**
 * `lwr serve --mcp`
 *
 * Boots an MCP server over stdio that exposes lwr's CLI surface to any
 * MCP-aware agent (Cursor, Cline, Zed, ChatGPT desktop, generic MCP
 * clients). Tools list comes from the same `COMMAND_ANNOTATIONS`
 * registry the CLI uses; tool calls are dispatched by spawning the lwr
 * binary as a subprocess and forwarding its JSON envelope.
 *
 * The server runs until stdin closes — typically when the parent agent
 * disconnects. Logs go to stderr; stdout is reserved for the JSON-RPC
 * protocol.
 */

import type { Command } from 'commander';
import type { GlobalFlags } from '../foundation/run';
import { startMcpServer } from '../mcp/server';

export interface ServeFlags extends GlobalFlags {
  mcp?: boolean;
}

/**
 * Note: this command does NOT go through `runCommand`. `runCommand`
 * writes a JSON envelope to stdout and exits — both wrong for a
 * long-lived stdio server that needs stdout exclusively for JSON-RPC.
 *
 * Instead we call `startMcpServer` directly and let it own stdio for
 * the lifetime of the process.
 */
export async function serve(program: Command, flags: ServeFlags): Promise<void> {
  if (flags.mcp !== true) {
    process.stderr.write(
      'lwr serve currently only supports --mcp. Pass --mcp to start the MCP server over stdio.\n',
    );
    process.exit(1);
  }
  // Anything we write to stdout from here on would corrupt the JSON-RPC
  // stream, so we only log to stderr and only when --debug is set.
  if (flags.debug) {
    process.stderr.write('lwr: starting MCP server (stdio)…\n');
  }
  await startMcpServer({ program });
  // We don't expect to reach here — the SDK keeps the event loop alive
  // until the transport closes — but if it does, exit cleanly.
}

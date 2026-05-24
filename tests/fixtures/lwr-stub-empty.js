#!/usr/bin/env node
/**
 * Stand-in for `lwr` that exits 0 without writing anything to stdout.
 * MCP dispatcher should surface this as an MCP_DISPATCH error envelope
 * (see dispatch.ts:135 — empty-stdout branch).
 */
process.exit(0);

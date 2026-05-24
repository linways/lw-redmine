#!/usr/bin/env node
/**
 * Stand-in for the `lwr` CLI used by mcp-dispatch tests.
 *
 * Prints a canonical lwr/v1 success envelope and exits 0. The MCP
 * dispatcher should:
 *   1. parse the envelope as JSON
 *   2. wrap the text in <insecure-content-{uuid}> tags
 *   3. mirror the parsed envelope on `structuredContent`
 *   4. NOT set isError
 */
const env = {
  schema: 'lwr/v1',
  command: 'issue.view',
  requestId: 'fixture-success-uuid',
  ok: true,
  data: { id: 12345, subject: 'Fixture' },
};
process.stdout.write(JSON.stringify(env) + '\n');
process.exit(0);

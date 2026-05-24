/**
 * Spawn-path coverage for `dispatchTool`. The existing `mcp-smoke`
 * suite drives the live MCP server end-to-end via dist/cli.js, but
 * three branches inside `spawnLwr` were never exercised:
 *
 *   - happy path: envelope round-trip + structuredContent mirror
 *   - timeout/SIGTERM (dispatch.ts:107-110)
 *   - empty stdout (dispatch.ts:135)
 *
 * We drive `dispatchTool` directly with `lwrBin` overridden to a small
 * fixture script so the test process controls what the spawned "lwr"
 * prints (or doesn't).
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Command } from 'commander';
import { dispatchTool } from '../src/mcp/dispatch';

const FIXTURES = path.resolve(__dirname, 'fixtures');

/**
 * Build a minimal commander tree that exposes a single `issue.view`
 * leaf. The dispatcher only needs the leaf to exist — the fixture
 * script ignores the argv and prints whatever envelope the test wants.
 */
function programWithIssueView(): Command {
  const program = new Command();
  program.name('lwr').description('test program').version('0.0.0');
  const issue = program.command('issue').description('issues');
  issue.command('view <id>').description('view an issue');
  return program;
}

const program = programWithIssueView();

function unwrapInsecure(text: string): string {
  const re = /^<insecure-content-([0-9a-f-]{36})>\n([\s\S]*)\n<\/insecure-content-\1>$/;
  const m = re.exec(text);
  if (!m) throw new Error(`text not wrapped: ${text.slice(0, 80)}`);
  return m[2];
}

describe('dispatchTool spawn paths', () => {
  it('happy path: parses the envelope, wraps text, mirrors structuredContent', async () => {
    const result = await dispatchTool(program, {
      toolName: 'issue_view',
      args: { id: '12345' },
      lwrBin: path.join(FIXTURES, 'lwr-stub-success.js'),
      nodeBin: process.execPath,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    // Inner text is the canonical envelope.
    const inner = unwrapInsecure(result.content[0].text);
    const env = JSON.parse(inner);
    expect(env).toMatchObject({
      schema: 'lwr/v1',
      command: 'issue.view',
      ok: true,
      data: { id: 12345, subject: 'Fixture' },
    });

    // structuredContent mirrors the parsed envelope.
    expect(result.structuredContent).toMatchObject({ ok: true, data: { id: 12345 } });
  }, 10_000);

  it('empty stdout: surfaces an MCP_DISPATCH error envelope', async () => {
    const result = await dispatchTool(program, {
      toolName: 'issue_view',
      args: { id: '12345' },
      lwrBin: path.join(FIXTURES, 'lwr-stub-empty.js'),
      nodeBin: process.execPath,
    });

    expect(result.isError).toBe(true);
    const inner = unwrapInsecure(result.content[0].text);
    const env = JSON.parse(inner);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MCP_DISPATCH');
    expect(env.error.message).toMatch(/empty stdout/i);
    // Envelope flows through jsonFailure → carries a real requestId.
    expect(typeof env.requestId).toBe('string');
  }, 10_000);

  it('timeout: kills the child via SIGTERM and surfaces an MCP_DISPATCH error', async () => {
    const result = await dispatchTool(program, {
      toolName: 'issue_view',
      args: { id: '12345' },
      lwrBin: path.join(FIXTURES, 'lwr-stub-hang.js'),
      nodeBin: process.execPath,
      timeoutMs: 250,
    });

    expect(result.isError).toBe(true);
    const inner = unwrapInsecure(result.content[0].text);
    const env = JSON.parse(inner);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MCP_DISPATCH');
    expect(env.error.message).toMatch(/timeout/i);
  }, 10_000);

  it('unknown tool name: synthesises MCP_DISPATCH error before any spawn', async () => {
    const result = await dispatchTool(program, {
      toolName: 'this_tool_does_not_exist',
      args: {},
      // Note: no lwrBin override needed — lookupCommand fails before spawn.
    });

    expect(result.isError).toBe(true);
    const inner = unwrapInsecure(result.content[0].text);
    const env = JSON.parse(inner);
    expect(env.error.code).toBe('MCP_DISPATCH');
    expect(env.error.message).toMatch(/unknown tool/i);
  });
});

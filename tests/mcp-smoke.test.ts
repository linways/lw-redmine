/**
 * Live smoke test for the MCP server over stdio.
 *
 * Spawns the built `lwr serve --mcp` binary, drives the MCP handshake +
 * a few requests via newline-delimited JSON-RPC, and asserts the
 * responses look right. No Redmine round-trip — `tools/list`,
 * `resources/list`, and `resources/read` are all local operations.
 *
 * `tools/call` is intentionally NOT exercised here: it would spawn a
 * second lwr subprocess that hits Redmine, which means real auth + real
 * network. That belongs in an end-to-end test that sets up nock'd
 * fixtures separately.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_JS = path.join(REPO_ROOT, 'dist', 'cli.js');
const NODE_BIN = process.execPath;

/**
 * Strip the per-subprocess `<insecure-content-{uuid}>...</insecure-content-{uuid}>`
 * sentinel that wraps every tool result and resource read. The UUID is
 * generated inside the spawned `lwr` so the test process can't know it
 * upfront — match the shape with a regex instead.
 */
function unwrapInsecure(text: string): string {
  const re = /^<insecure-content-([0-9a-f-]{36})>\n([\s\S]*)\n<\/insecure-content-\1>$/;
  const m = re.exec(text);
  if (!m) throw new Error(`text was not wrapped in <insecure-content-{uuid}> tags: ${text.slice(0, 80)}`);
  return m[2];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Spawn `lwr serve --mcp`, send a sequence of newline-delimited JSON-RPC
 * messages, and collect all id-bearing responses. Notifications (no `id`)
 * are skipped. Resolves once we've collected `expectIds.size` responses
 * or the child exits.
 */
function rpcRoundtrip(messages: object[], expectIds: Set<number>, timeoutMs = 8000): Promise<{ responses: JsonRpcResponse[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [CLI_JS, 'serve', '--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const responses: JsonRpcResponse[] = [];
    const seen = new Set<number>();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeoutMs}ms. Got ${seen.size}/${expectIds.size} responses. stdout: ${stdout.slice(-500)}; stderr: ${stderr.slice(-500)}`));
    }, timeoutMs);

    const tryFinish = (): void => {
      if (settled) return;
      let allSeen = true;
      for (const id of expectIds) {
        if (!seen.has(id)) { allSeen = false; break; }
      }
      if (allSeen) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ responses, stderr });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let msg: JsonRpcResponse;
        try { msg = JSON.parse(trimmed); }
        catch { continue; }
        responses.push(msg);
        if (typeof msg.id === 'number') seen.add(msg.id);
        tryFinish();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Fire all messages back-to-back. The server processes them in
    // order; responses come back as they're produced.
    for (const m of messages) {
      child.stdin.write(JSON.stringify(m) + '\n');
    }
  });
}

describe('lwr serve --mcp (live)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI_JS)) {
      // Build is required for this suite; we don't auto-trigger it
      // because the parent `npm test` doesn't run a build. CI/full-run
      // should `npm run build` first.
      const r = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('build failed');
    }
  });

  it('handles initialize → tools/list → resources/list', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lwr-smoke', version: '0.1.0' },
      },
    };
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const resList = { jsonrpc: '2.0', id: 3, method: 'resources/list' };

    const { responses } = await rpcRoundtrip(
      [init, initialized, toolsList, resList],
      new Set([1, 2, 3]),
    );

    const initRes = responses.find(r => r.id === 1);
    expect(initRes?.result).toBeDefined();
    expect((initRes!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('lwr');

    const toolsRes = responses.find(r => r.id === 2);
    const tools = (toolsRes!.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] }).tools;
    // Sanity: lwr exposes more than 30 tools, includes the most-used ones,
    // and excludes the introspection/server-only verbs (commands, serve).
    expect(tools.length).toBeGreaterThan(30);
    const names = tools.map(t => t.name);
    expect(names).toContain('issue_list');
    expect(names).toContain('time_log');
    expect(names).toContain('me_show');
    expect(names).not.toContain('commands');
    expect(names).not.toContain('serve');
    // Annotation contract: time_delete is destructive, issue_list is read-only.
    expect(tools.find(t => t.name === 'time_delete')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'issue_list')?.annotations?.readOnlyHint).toBe(true);

    const resRes = responses.find(r => r.id === 3);
    const res = (resRes!.result as { resources: { uri: string; mimeType?: string }[] }).resources;
    expect(res.find(r => r.uri === 'lwr://me')).toBeDefined();
    expect(res.find(r => r.uri === 'lwr://me')?.mimeType).toBe('text/markdown');
  }, 15_000);

  it('resources/read for lwr://me returns the markdown', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lwr-smoke', version: '0.1.0' },
      },
    };
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const read = {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'lwr://me' },
    };

    const { responses } = await rpcRoundtrip([init, initialized, read], new Set([1, 2]));
    const readRes = responses.find(r => r.id === 2);
    // Either the file exists (most dev machines) or we get a JSON-RPC
    // error pointing at `lwr auth login`. Either is correct — just don't
    // crash the server.
    if (readRes?.error) {
      expect(readRes.error.message).toMatch(/lwr auth login|profile not found/i);
    } else {
      const result = readRes!.result as { contents: { mimeType: string; text: string }[] };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('text/markdown');
      // The text must be wrapped in the insecure-content sentinel (H1).
      const inner = unwrapInsecure(result.contents[0].text);
      expect(inner.length).toBeGreaterThan(0);
    }
  }, 15_000);

  it('rejects unknown tool name with an isError envelope', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lwr-smoke', version: '0.1.0' },
      },
    };
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const callBogus = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'this_tool_does_not_exist', arguments: {} },
    };
    const { responses } = await rpcRoundtrip([init, initialized, callBogus], new Set([1, 2]));
    const callRes = responses.find(r => r.id === 2);
    const result = callRes!.result as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    // Error envelope is also wrapped (H1).
    const env = JSON.parse(unwrapInsecure(result.content[0].text));
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MCP_DISPATCH');
    // Q3: MCP error envelope routes through jsonFailure() — same canonical
    // schema string and a per-call requestId, identical shape to the CLI
    // failure path so agent log-stitching works across both surfaces.
    expect(env.schema).toBe('lwr/v1');
    expect(typeof env.requestId).toBe('string');
    expect((env.requestId as string).length).toBeGreaterThan(0);
  }, 15_000);
});

/**
 * MCP `tools/call` → spawn the lwr binary as a subprocess.
 *
 * Why subprocess (instead of in-process dispatch):
 *   - Zero refactoring of the existing CLI command tree. Every tool the
 *     CLI exposes is automatically an MCP tool with the same exact
 *     contract — they share one source of truth (`COMMAND_ANNOTATIONS`)
 *     and one execution path.
 *   - The CLI's `runCommand` already returns a stable `lwr/v1` JSON
 *     envelope on stdout (success or failure). The dispatcher just
 *     forwards the envelope as the MCP tool result.
 *   - Auth, profile, cache, retries, error mapping — all reused.
 *   - Spawn overhead (~50–150ms per call) is acceptable for an
 *     interactive agent flow. We can optimize later if profiling shows
 *     a hot path.
 *
 * The CLI binary path is taken from `process.argv[1]` — i.e. *this*
 * binary. The MCP server is itself a `lwr serve --mcp` invocation, so
 * `process.argv[1]` always points at the lwr CLI entry.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { buildArgv, normaliseArgs, toolNameToPath } from './argv';
import { buildPayload } from '../commands/commands';
import type { SerializedCommand } from '../commands/commands';
import { wrapUntrusted } from './sentinel';
import { LwrError } from '../foundation/errors';
import { jsonFailure } from '../foundation/output';
import { ERROR_CODES, EXIT, MCP_DISPATCH_TIMEOUT_MS } from '../constants';

export interface McpToolResult {
  /**
   * MCP `content` array. We always return one text part containing the
   * JSON envelope — that's the agent contract.
   */
  content: { type: 'text'; text: string }[];
  /**
   * MCP `isError` flag. True iff the spawned CLI returned a non-OK
   * envelope. The envelope's `error.code` is the stable branching key
   * for agents.
   */
  isError?: boolean;
  /**
   * MCP supports a structured payload alongside the text content. We
   * mirror the CLI envelope here so MCP clients that prefer structured
   * data over text parsing can use it directly.
   */
  structuredContent?: Record<string, unknown>;
  /** Spec-defined `_meta` and forward-compat extensions live here. */
  [extraField: string]: unknown;
}

export interface DispatchOptions {
  toolName: string;
  args: Record<string, unknown>;
  /** Path to the lwr CLI binary; defaults to `process.argv[1]`. */
  lwrBin?: string;
  /** Path to the node binary; defaults to `process.argv[0]`. */
  nodeBin?: string;
  /** Spawn timeout (ms). Defaults to MCP_DISPATCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export async function dispatchTool(program: Command, opts: DispatchOptions): Promise<McpToolResult> {
  const cmd = lookupCommand(program, opts.toolName);
  if (!cmd) {
    return errorEnvelope(opts.toolName, `Unknown tool: ${opts.toolName}`);
  }

  let argv: string[];
  try {
    argv = buildArgv(cmd, { args: normaliseArgs(opts.args ?? {}) });
  } catch (err) {
    return errorEnvelope(opts.toolName, err instanceof Error ? err.message : String(err));
  }

  return spawnLwr({
    nodeBin: opts.nodeBin ?? process.argv[0],
    lwrBin: opts.lwrBin ?? process.argv[1],
    argv,
    timeoutMs: opts.timeoutMs ?? MCP_DISPATCH_TIMEOUT_MS,
  });
}

function lookupCommand(program: Command, toolName: string): SerializedCommand | undefined {
  const path = toolNameToPath(toolName);
  const dotted = path.join('.');
  return buildPayload(program).commands.find(c => c.name === dotted);
}

interface SpawnArgs {
  nodeBin: string;
  lwrBin: string;
  argv: string[];
  timeoutMs: number;
}

function spawnLwr(s: SpawnArgs): Promise<McpToolResult> {
  return new Promise(resolve => {
    const child = spawn(s.nodeBin, [s.lwrBin, ...s.argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubbedEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, s.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      clearTimeout(timer);
      resolve(errorEnvelope('spawn', `Failed to launch lwr: ${err.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(errorEnvelope('spawn', `Timeout after ${s.timeoutMs}ms`));
        return;
      }

      // Parse the JSON envelope. The CLI guarantees a single line of JSON
      // on stdout in --json mode, success or failure, with a known shape
      // (schema: lwr/v1). If it didn't print one, something genuinely
      // unexpected happened — surface stderr.
      const text = stdout.trim();
      if (text.length === 0) {
        resolve(errorEnvelope('spawn', `Empty stdout (exit ${code}). stderr: ${stderr.trim()}`));
        return;
      }

      // The CLI's --json contract guarantees a top-level object envelope
      // (success or failure). If JSON.parse succeeds we accept it as a
      // record; isSuccessEnvelope checks the shape downstream.
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        resolve(
          errorEnvelope(
            'spawn',
            `Could not parse lwr stdout as JSON (exit ${code}): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      const ok = isSuccessEnvelope(envelope);
      resolve({
        content: [{ type: 'text', text: wrapUntrusted(text) }],
        ...(ok ? {} : { isError: true }),
        structuredContent: envelope,
      });
    });
  });
}

/**
 * Build the env passed to the spawned `lwr` subprocess.
 *
 * The MCP server inherits whatever env the user (or MCP host) launched it
 * with — typically including secrets unrelated to lwr (AWS keys, GitHub
 * tokens, etc.). Forwarding all of that wholesale to the subprocess is
 * an unnecessary blast-radius widening: the spawned `lwr` only needs
 * what's required for keytar / config-dir / locale / output context.
 */
export function scrubbedEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const passthroughKeys = new Set([
    'HOME', 'USER', 'LOGNAME',
    'PATH', 'TMPDIR', 'TEMP', 'TMP',
    'TERM', 'NO_COLOR', 'COLORTERM', 'LANG', 'LC_ALL',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'NODE_OPTIONS', 'NODE_PATH',
  ]);
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    // lwr's own namespace + locale variants (LC_*) + standard pass-through.
    if (k.startsWith('LWR_') || k.startsWith('LC_') || passthroughKeys.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function isSuccessEnvelope(env: unknown): boolean {
  return Boolean(
    env
      && typeof env === 'object'
      && 'ok' in (env as Record<string, unknown>)
      && (env as Record<string, unknown>).ok === true,
  );
}

/**
 * Synthesise an MCP tool-result envelope for failures that occur *before*
 * we can spawn or parse the CLI output. The envelope flows through the
 * canonical `jsonFailure()` builder so MCP failures share one source of
 * truth with the CLI failure path — same `schema` string, same
 * `requestId` plumbing, no drift if either side evolves.
 */
function errorEnvelope(command: string, message: string): McpToolResult {
  const err = new LwrError({
    message,
    code: ERROR_CODES.MCP_DISPATCH,
    exit: EXIT.INTERNAL,
  });
  const env = jsonFailure(command, err, { requestId: randomUUID() });
  return {
    content: [{ type: 'text', text: wrapUntrusted(JSON.stringify(env)) }],
    isError: true,
    // jsonFailure returns the typed `JsonFailure` envelope; we re-spread
    // it so the value carries the open-ended `Record<string, unknown>`
    // shape the SDK's structuredContent slot expects (a plain JS record
    // with arbitrary keys). The runtime values are identical.
    structuredContent: { ...env },
  };
}

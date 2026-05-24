/**
 * `lwr doctor`
 *
 * One-shot self-test of the lwr install. Surfaces, in a single command:
 *
 *   1. Runtime    — Node version, platform, config dir writable
 *   2. Config     — config.json readable, has an active profile
 *   3. Auth       — keychain availability, API-key resolution + verification
 *   4. Network    — Redmine reachable, latency
 *   5. Converters — optional binaries used by `lwr issue fetch`
 *   6. Terminal   — TTY, color, image protocol (kitty/iTerm) for previews
 *
 * **Convention** (load-bearing — read this before adding a feature):
 *   Every new feature with an external dependency, optional binary, or any
 *   non-trivial environmental requirement MUST add a check here. Doctor is
 *   the canonical "what's working / what's not" report — if a feature can
 *   fail silently due to a missing dep, doctor must surface it. The pattern
 *   is: write a `check*` function in this file and append it to the section
 *   it belongs to. Promote a new section when none fits.
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { hostname, platform, release, type } from 'node:os';
import path from 'node:path';

import {
  CONVERTER_BIN,
  ENV,
  EXIT,
  KEYTAR_SERVICE,
} from '../../constants';
import { getCurrentUser } from '../../api/users';
import { isKeychainAvailable } from '../../foundation/auth';
import { createClient } from '../../foundation/client';
import { loadConfig } from '../../foundation/config';
import {
  detectConverters,
  libreofficeInstallHint,
  pdftoppmInstallHint,
} from '../../foundation/converters';
import { LwrError, AuthMissingError, asLwrError } from '../../foundation/errors';
import { dim, header } from '../../foundation/format';
import { writeLine } from '../../foundation/output';
import { configDir } from '../../foundation/paths';
import { activeProfile } from '../../foundation/profiles';
import { resolveBaseUrlFromProfile } from '../../foundation/url';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { getApiKey } from '../../foundation/auth';
import { SYMBOLS } from '../../constants';
import type { OutputContext } from '../../foundation/output';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  /** Dotted machine-readable name, e.g. `auth.keychain`. */
  name: string;
  /** Human-readable section label. */
  category: string;
  status: CheckStatus;
  /** Short result line. */
  message: string;
  /** Actionable next step. Only relevant for warn / fail. */
  hint?: string;
  /** Extra structured data exposed in JSON mode. */
  details?: Record<string, unknown>;
}

interface DoctorPayload {
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number; skip: number };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const cmd: CommandFn<DoctorPayload> = async (flags): Promise<CommandResult<DoctorPayload>> => {
  const checks: CheckResult[] = [];
  const push = (...rs: CheckResult[]): void => {
    checks.push(...rs);
  };

  // ── 1. Runtime ─────────────────────────────────────────────────────────
  push(checkNode(), checkPlatform(), checkConfigDir());

  // ── 2. Config ──────────────────────────────────────────────────────────
  const cfgCheck = checkConfig();
  push(cfgCheck);

  // Stop downstream checks that need a profile if config is broken.
  const profileCtx = cfgCheck.status === 'ok' ? resolveProfile(flags) : null;

  // ── 3. Auth ────────────────────────────────────────────────────────────
  push(await checkKeychain());
  const authResolved = profileCtx
    ? await resolveApiKeyForCheck(profileCtx.name, flags.apiKey)
    : { check: skip('auth.apiKey', 'Auth', 'no profile resolved — cannot look up API key'), apiKey: null };
  push(authResolved.check);

  // ── 4. Network + auth verify (combined: one network call validates both) ──
  if (profileCtx && authResolved.check.status === 'ok' && authResolved.apiKey) {
    push(await checkNetworkAndAuth(profileCtx.baseUrl, authResolved.apiKey));
  } else {
    push(skip('network.redmine', 'Network', 'skipped (auth or config not ready)'));
  }

  // ── 5. Converters (optional — used by `lwr issue fetch`) ───────────────
  push(...(await checkConverters()));

  // ── 6. Terminal ────────────────────────────────────────────────────────
  push(...checkTerminal());

  // ── Aggregate ──────────────────────────────────────────────────────────
  const summary = checks.reduce(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { ok: 0, warn: 0, fail: 0, skip: 0 },
  );

  return {
    json: { checks, summary },
    pretty: ctx => renderPretty(ctx, checks, summary),
    // Exit non-zero when any check failed, so callers (CI, agents) can react.
    // Uses USER (1) — doctor failures aren't lwr bugs, they're env issues.
    exitCode: summary.fail > 0 ? EXIT.USER : EXIT.OK,
  };
};

// ---------------------------------------------------------------------------
// Section 1: Runtime
// ---------------------------------------------------------------------------

function checkNode(): CheckResult {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  const ok = Number.isFinite(major) && major >= 18;
  return {
    name: 'runtime.node',
    category: 'Runtime',
    status: ok ? 'ok' : 'fail',
    message: `Node ${v}`,
    hint: ok ? undefined : 'Upgrade to Node 18+ — `nvm install --lts` or your platform equivalent.',
    details: { version: v, major },
  };
}

function checkPlatform(): CheckResult {
  return {
    name: 'runtime.platform',
    category: 'Runtime',
    status: 'ok',
    message: `${type()} ${release()} (${platform()})`,
    details: { platform: platform(), release: release(), hostname: hostname() },
  };
}

function checkConfigDir(): CheckResult {
  const dir = configDir();
  try {
    accessSync(dir, fsConstants.W_OK);
    return {
      name: 'runtime.configDir',
      category: 'Runtime',
      status: 'ok',
      message: `${dir} (writable)`,
      details: { path: dir },
    };
  } catch {
    // Not yet created is fine — we'll create on first write.
    try {
      accessSync(path.dirname(dir), fsConstants.W_OK);
      return {
        name: 'runtime.configDir',
        category: 'Runtime',
        status: 'ok',
        message: `${dir} (will be created on first write)`,
        details: { path: dir, exists: false },
      };
    } catch {
      return {
        name: 'runtime.configDir',
        category: 'Runtime',
        status: 'fail',
        message: `${dir} (parent not writable)`,
        hint: `Check permissions on ${path.dirname(dir)}.`,
        details: { path: dir },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Section 2: Config
// ---------------------------------------------------------------------------

function checkConfig(): CheckResult {
  try {
    const cfg = loadConfig();
    const profileNames = Object.keys(cfg.profiles);
    if (profileNames.length === 0) {
      return {
        name: 'config.profiles',
        category: 'Config',
        status: 'warn',
        message: 'No profiles configured',
        hint: 'Run `lwr auth login` to create a profile and store an API key.',
        details: { activeProfile: cfg.activeProfile, profileCount: 0 },
      };
    }
    const active = cfg.activeProfile;
    if (!cfg.profiles[active]) {
      return {
        name: 'config.profiles',
        category: 'Config',
        status: 'fail',
        message: `Active profile "${active}" is not in profiles[]`,
        hint: `Run \`lwr profile use <name>\` to pick one of: ${profileNames.join(', ')}`,
        details: { activeProfile: active, profileNames },
      };
    }
    return {
      name: 'config.profiles',
      category: 'Config',
      status: 'ok',
      message: `${profileNames.length} profile${profileNames.length === 1 ? '' : 's'} (active: ${active})`,
      details: { activeProfile: active, profileNames },
    };
  } catch (err) {
    const e = asLwrError(err);
    return {
      name: 'config.profiles',
      category: 'Config',
      status: 'fail',
      message: e.message,
      hint: e.hint ?? 'Inspect or delete the config file and re-run `lwr auth login`.',
    };
  }
}

function resolveProfile(flags: GlobalFlags): { name: string; baseUrl: string } | null {
  try {
    const { name, profile } = activeProfile(flags.profile);
    // Doctor is read-only diagnostic; if no URL is resolvable we surface
    // that as the empty string (the doctor report still renders) rather
    // than throwing the structured error a real command would.
    let baseUrl = '';
    try {
      baseUrl = resolveBaseUrlFromProfile({
        flagBaseUrl: flags.baseUrl,
        profile,
        configDefaultBaseUrl: loadConfig().defaultBaseUrl,
      });
    } catch {
      // No URL configured — leave baseUrl empty so the doctor report
      // shows "(not configured)" instead of the active-issue path.
    }
    return { name, baseUrl };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Section 3: Auth
// ---------------------------------------------------------------------------

async function checkKeychain(): Promise<CheckResult> {
  const ok = await isKeychainAvailable();
  return {
    name: 'auth.keychain',
    category: 'Auth',
    status: ok ? 'ok' : 'warn',
    message: ok
      ? `OS keychain available (service: ${KEYTAR_SERVICE})`
      : 'OS keychain unavailable — using file fallback',
    hint: ok ? undefined : 'Install libsecret if you want OS-keychain storage on Linux: `sudo apt install libsecret-1-dev`.',
    details: { service: KEYTAR_SERVICE, available: ok },
  };
}

async function resolveApiKeyForCheck(
  profile: string,
  flagApiKey?: string,
): Promise<{ check: CheckResult; apiKey: string | null }> {
  try {
    const apiKey = await getApiKey(profile, flagApiKey);
    const source = sourceOfApiKey(flagApiKey, apiKey);
    return {
      apiKey,
      check: {
        name: 'auth.apiKey',
        category: 'Auth',
        status: 'ok',
        message: `Resolved (source: ${source})`,
        details: { source, profile, fingerprint: redactKey(apiKey) },
      },
    };
  } catch (err) {
    if (err instanceof AuthMissingError) {
      return {
        apiKey: null,
        check: {
          name: 'auth.apiKey',
          category: 'Auth',
          status: 'fail',
          message: 'No API key found',
          hint: 'Run `lwr auth login` (username + password) or set $LWR_API_KEY.',
          details: { profile },
        },
      };
    }
    const e = asLwrError(err);
    return {
      apiKey: null,
      check: {
        name: 'auth.apiKey',
        category: 'Auth',
        status: 'fail',
        message: e.message,
        hint: e.hint,
      },
    };
  }
}

/** Last-4 fingerprint — never expose the full key in any output channel. */
function redactKey(key: string): string {
  if (key.length <= 8) return '****';
  return `****${key.slice(-4)}`;
}

function sourceOfApiKey(flagApiKey: string | undefined, resolved: string): string {
  if (flagApiKey && flagApiKey === resolved) return 'flag';
  if (process.env[ENV.API_KEY] && process.env[ENV.API_KEY] === resolved) return 'env';
  // We can't tell keychain vs file from outside auth.ts without another probe.
  return 'keychain or file';
}

// ---------------------------------------------------------------------------
// Section 4: Network + auth verify
// ---------------------------------------------------------------------------

async function checkNetworkAndAuth(baseUrl: string, apiKey: string): Promise<CheckResult> {
  const client = createClient({ baseUrl, apiKey });
  const startedAt = Date.now();
  try {
    const user = await getCurrentUser(client);
    const elapsedMs = Date.now() - startedAt;
    const who = user.login ?? user.mail ?? `#${user.id}`;
    return {
      name: 'network.redmine',
      category: 'Network',
      status: 'ok',
      message: `${baseUrl} → ${who} (#${user.id}) in ${elapsedMs}ms`,
      details: { baseUrl, elapsedMs, userId: user.id, login: user.login },
    };
  } catch (err) {
    const e = asLwrError(err);
    const elapsedMs = Date.now() - startedAt;
    return {
      name: 'network.redmine',
      category: 'Network',
      status: 'fail',
      message: `${baseUrl} → ${e.message}`,
      hint: e.hint ?? errorHint(e),
      details: { baseUrl, elapsedMs, code: e.code },
    };
  }
}

function errorHint(e: LwrError): string | undefined {
  switch (e.code) {
    case 'AUTH_INVALID':
      return 'Re-run `lwr auth login` — the stored key may have been revoked.';
    case 'NETWORK_DNS':
    case 'NETWORK_REFUSED':
    case 'NETWORK_TIMEOUT':
      return 'Check the baseUrl, your VPN, and DNS resolution.';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Section 5: Converters (used by `lwr issue fetch`)
// ---------------------------------------------------------------------------

async function checkConverters(): Promise<CheckResult[]> {
  const av = await detectConverters();
  return [
    {
      name: 'converter.pdftoppm',
      category: 'Converters',
      status: av.pdftoppm ? 'ok' : 'warn',
      message: av.pdftoppm
        ? `${CONVERTER_BIN.PDFTOPPM} available (PDF → PNG)`
        : `${CONVERTER_BIN.PDFTOPPM} not found — PDFs won't be split into PNGs`,
      hint: av.pdftoppm ? undefined : pdftoppmInstallHint(),
      details: { available: av.pdftoppm, used_by: 'issue fetch (PDF, DOCX→PDF→PNG)' },
    },
    {
      name: 'converter.libreoffice',
      category: 'Converters',
      status: av.libreoffice ? 'ok' : 'warn',
      message: av.libreoffice
        ? `${CONVERTER_BIN.LIBREOFFICE} available (DOCX/XLSX conversions)`
        : `${CONVERTER_BIN.LIBREOFFICE} not found — DOCX/XLSX won't be converted`,
      hint: av.libreoffice ? undefined : libreofficeInstallHint(),
      details: { available: av.libreoffice, used_by: 'issue fetch (DOCX, XLSX)' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Section 6: Terminal
// ---------------------------------------------------------------------------

function checkTerminal(): CheckResult[] {
  const out: CheckResult[] = [];
  const isTTY = Boolean(process.stdout.isTTY);
  out.push({
    name: 'terminal.tty',
    category: 'Terminal',
    status: 'ok',
    message: isTTY ? 'stdout is a TTY' : 'stdout is not a TTY (pipe / redirect / agent)',
    details: { isTTY },
  });

  const noColor = Boolean(process.env.NO_COLOR);
  out.push({
    name: 'terminal.color',
    category: 'Terminal',
    status: 'ok',
    message: noColor ? 'NO_COLOR set — colors disabled' : `colors ${isTTY ? 'enabled' : 'auto-disabled (non-TTY)'}`,
    details: { noColor, colorEnabled: !noColor && isTTY },
  });

  const term = process.env.TERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const proto = detectImageProtocol(term, termProgram);
  out.push({
    name: 'terminal.imageProtocol',
    category: 'Terminal',
    status: proto === 'none' ? 'warn' : 'ok',
    message:
      proto === 'none'
        ? 'No inline-image protocol detected (used by Phase 2 attachment preview)'
        : `${proto} image protocol detected`,
    hint:
      proto === 'none'
        ? 'kitty / iTerm2 / WezTerm support inline images. Skip if you don\'t need attachment previews.'
        : undefined,
    details: { protocol: proto, TERM: term, TERM_PROGRAM: termProgram },
  });

  return out;
}

function detectImageProtocol(term: string, termProgram: string): 'kitty' | 'iterm' | 'wezterm' | 'none' {
  if (term.includes('kitty')) return 'kitty';
  if (termProgram === 'iTerm.app') return 'iterm';
  if (termProgram === 'WezTerm' || term === 'wezterm') return 'wezterm';
  return 'none';
}

// ---------------------------------------------------------------------------
// Pretty rendering
// ---------------------------------------------------------------------------

function renderPretty(
  ctx: OutputContext,
  checks: CheckResult[],
  summary: DoctorPayload['summary'],
): void {
  const groups = groupByCategory(checks);
  for (const [category, items] of groups) {
    writeLine('');
    writeLine(`${ctx.color ? pc.bold(SYMBOLS.sectionMarker) : SYMBOLS.sectionMarker} ${header(ctx, category)}`);
    for (const c of items) {
      writeLine(`  ${badge(ctx, c.status)}  ${pad(c.name, 24)}  ${c.message}`);
      if (c.hint && (c.status === 'warn' || c.status === 'fail')) {
        writeLine(`      ${dim(ctx, 'hint:')} ${c.hint}`);
      }
    }
  }
  writeLine('');
  writeLine(
    `${dim(ctx, 'Summary:')}  ${green(ctx, `${summary.ok} ok`)}   ${yellow(ctx, `${summary.warn} warn`)}   ${red(ctx, `${summary.fail} fail`)}   ${dim(ctx, `${summary.skip} skip`)}`,
  );
}

function groupByCategory(checks: CheckResult[]): Map<string, CheckResult[]> {
  const m = new Map<string, CheckResult[]>();
  for (const c of checks) {
    const arr = m.get(c.category) ?? [];
    arr.push(c);
    m.set(c.category, arr);
  }
  return m;
}

function badge(ctx: OutputContext, status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return green(ctx, SYMBOLS.success);
    case 'warn':
      return yellow(ctx, SYMBOLS.warning);
    case 'fail':
      return red(ctx, SYMBOLS.failure);
    case 'skip':
      return dim(ctx, SYMBOLS.skip);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function green(ctx: OutputContext, s: string): string {
  return ctx.color ? pc.green(s) : s;
}
function yellow(ctx: OutputContext, s: string): string {
  return ctx.color ? pc.yellow(s) : s;
}
function red(ctx: OutputContext, s: string): string {
  return ctx.color ? pc.red(s) : s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(name: string, category: string, message: string): CheckResult {
  return { name, category, status: 'skip', message };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function doctor(flags: GlobalFlags): Promise<never> {
  return runCommand('doctor', flags, cmd);
}

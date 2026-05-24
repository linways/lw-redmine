/**
 * Feedback log — core module.
 *
 * One Markdown file per incident under
 * `~/.lwr/feedback/<YYYY-MM-DD>/<HHMMSS>-<kind>-<slug>.md` (UTC date + time).
 *
 * Phase 1: only the `lwr feedback log/list/show` verbs use this. Phase 2
 * will hook the same writer from the global error formatter (Trigger B in
 * `FEEDBACK_SPEC.md` §4.2).
 *
 * Redaction reuses `redactNote` from `work-log.ts` per the spec — every
 * free-text field (`query`, `reason`, `details`, `command`, each
 * `attempts[].action` / `attempts[].outcome`) flows through it before the
 * bytes hit disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_KINDS,
  FEEDBACK_AGENTS,
  FEEDBACK_AGENT_DEFAULT,
  FEEDBACK_SUMMARY_MAX_CHARS,
  FEEDBACK_WEBHOOK,
  ENV,
  type FeedbackKind,
  type FeedbackAgent,
  type FeedbackWebhookField,
} from '../constants';
import { feedbackDir, feedbackDayDir, feedbackEntryPath } from '../foundation/paths';
import { redactNote } from './work-log';
import { loadConfig } from '../foundation/config';
import pkg from '../../package.json';

// --- Types -----------------------------------------------------------------

export interface FeedbackAttempt {
  action: string;
  outcome: string;
}

/** Input the command layer assembles before handing to {@link writeFeedback}. */
export interface FeedbackInput {
  kind: FeedbackKind;
  /** The user's words / closest paraphrase. Free text, redacted on write. */
  query: string;
  /**
   * One-line explanation of *why* this is being logged — for `gap`, which
   * verb/flag is missing; for `error`, why the error fired. Redacted.
   */
  reason: string;
  /** Optional longer body. Redacted. */
  details?: string;
  /** Closest matching lwr dotted verb (e.g. `issue.edit`). */
  command?: string;
  attempts?: FeedbackAttempt[];
  /** Optional issue id the incident was about. */
  issueContext?: number;
  /** Process exit code (Trigger B only). */
  exitCode?: number;
  /** Stable error code (Trigger B only). */
  errorCode?: string;
  /** Upstream agent identity. Defaults to `cli`. */
  agent?: FeedbackAgent;
}

export interface FeedbackEntryMeta {
  /** Path relative to {@link feedbackDir}, with `/` separators. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  kind: FeedbackKind;
  slug: string;
  /** UTC ISO-8601 instant, from frontmatter. */
  recordedAt: string;
  /** Closest matching verb, from frontmatter. `null` when not set. */
  command: string | null;
  /** One-line preview of the user's words, trimmed. */
  summary: string;
}

export interface ListOptions {
  /** Days back from today (UTC). `null` means "all days". */
  windowDays: number | null;
  /** Filter to one kind. */
  kind?: FeedbackKind;
}

// --- Time helpers ----------------------------------------------------------

/** UTC `YYYY-MM-DD` for `at` (defaults to now). */
export function utcDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** UTC `HHMMSS` for `at` (filename time component). */
export function utcTime(at: Date = new Date()): string {
  return at.toISOString().slice(11, 19).replace(/:/g, '');
}

/** Full UTC ISO-8601 with trailing `Z`, no millis (matches spec sample). */
export function utcIso(at: Date = new Date()): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- Slug --------------------------------------------------------------------

const SLUG_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'as', 'of', 'for', 'in', 'on', 'by', 'is', 'are',
  'be', 'and', 'or', 'with', 'my', 'me', 'i', 'we', 'do', 'does', 'set',
  'this', 'that', 'these', 'those', 'it', 'into', 'from',
]);

/**
 * Derive a 2–3 word kebab-case slug from a free-text query (or a fallback
 * source). Drops stopwords; if the result would be empty, falls back to
 * the secondary source, and finally to `incident`.
 */
export function slugify(primary: string, fallback?: string): string {
  const fromPrimary = wordsFor(primary);
  if (fromPrimary.length > 0) return fromPrimary.slice(0, 3).join('-');
  if (fallback) {
    const fromFallback = wordsFor(fallback);
    if (fromFallback.length > 0) return fromFallback.slice(0, 3).join('-');
  }
  return 'incident';
}

function wordsFor(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !SLUG_STOPWORDS.has(w));
}

// --- Frontmatter -----------------------------------------------------------

/**
 * Minimal YAML emitter for the fixed-shape frontmatter the spec defines.
 * No nested arrays in frontmatter (attempts live in the body) — so a
 * hand-rolled emitter is safer than pulling a YAML dep that might quote
 * differently across versions.
 */
function emitFrontmatter(opts: {
  kind: FeedbackKind;
  recordedAt: string;
  user: { login: string; name: string; redmineId: number } | null;
  lwrVersion: string;
  profile: string | null;
  agent: FeedbackAgent;
  issueContext: number | null;
  command: string | null;
  exitCode: number | null;
  errorCode: string | null;
}): string {
  const lines: string[] = ['---'];
  lines.push(`schema: ${FEEDBACK_SCHEMA_VERSION}`);
  lines.push(`kind: ${opts.kind}`);
  lines.push(`recorded_at: ${opts.recordedAt}`);
  if (opts.user) {
    lines.push('user:');
    lines.push(`  login: ${yamlScalar(opts.user.login)}`);
    lines.push(`  name: ${yamlScalar(opts.user.name)}`);
    lines.push(`  redmine_id: ${opts.user.redmineId}`);
  } else {
    lines.push('user: null');
  }
  lines.push(`lwr_version: ${yamlScalar(opts.lwrVersion)}`);
  lines.push(`profile: ${opts.profile === null ? 'null' : yamlScalar(opts.profile)}`);
  lines.push(`agent: ${opts.agent}`);
  lines.push(`issue_context: ${opts.issueContext === null ? 'null' : opts.issueContext}`);
  lines.push(`command: ${opts.command === null ? 'null' : yamlScalar(opts.command)}`);
  lines.push(`exit_code: ${opts.exitCode === null ? 'null' : opts.exitCode}`);
  lines.push(`error_code: ${opts.errorCode === null ? 'null' : yamlScalar(opts.errorCode)}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * Quote a scalar when it contains characters that would confuse a naive
 * YAML reader (colons, leading dashes, hash, quotes, etc). Otherwise emit
 * bare. The maintainer reads these by eye; we keep them legible.
 */
function yamlScalar(s: string): string {
  if (/[:#\n"'{}\[\],&*?|<>=!%@`]|^\s|\s$|^-|^null$|^true$|^false$/i.test(s) || s.length === 0) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

// --- File content ----------------------------------------------------------

function buildBody(input: FeedbackInput): string {
  const sections: string[] = [];

  sections.push('## What the user asked');
  sections.push('');
  sections.push(blockquote(input.query));

  sections.push('');
  sections.push('## What lwr returned');
  sections.push('');
  sections.push(input.reason);
  if (input.details && input.details.trim().length > 0) {
    sections.push('');
    sections.push(input.details);
  }

  if (input.kind === 'gap') {
    sections.push('');
    sections.push('## What the agent tried before bailing');
    sections.push('');
    sections.push('```yaml');
    sections.push('attempts:');
    if (input.attempts && input.attempts.length > 0) {
      for (const a of input.attempts) {
        sections.push(`  - action: ${yamlScalar(a.action)}`);
        sections.push(`    outcome: ${yamlScalar(a.outcome)}`);
      }
    } else {
      sections.push('  []');
    }
    sections.push('```');
  }

  sections.push('');
  return sections.join('\n');
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map(l => (l.length > 0 ? `> ${l}` : '>'))
    .join('\n');
}

// --- Write -----------------------------------------------------------------

export interface WriteResult {
  /** Path relative to {@link feedbackDir}, with `/` separators. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  kind: FeedbackKind;
  slug: string;
  /** Full UTC ISO recorded into the file's frontmatter. */
  recordedAt: string;
  /** True when called with `dryRun` — the bytes were NOT written. */
  dryRun: boolean;
  /**
   * Outcome of the remote-mirror POST. Absent when the mirror is
   * disabled (empty `FEEDBACK_WEBHOOK.FORM_URL` or
   * `LWR_FEEDBACK_NO_WEBHOOK=1`) or when `dryRun` is true. Always
   * surfaces `posted: boolean`; on failure, `error` carries a one-line
   * diagnostic for the agent to display.
   */
  mirror?: MirrorResult;
}

export interface MirrorResult {
  posted: boolean;
  status?: number;
  error?: string;
  durationMs?: number;
}

export interface WriteOptions {
  /** When true, compute the path/frontmatter but don't write anything. */
  dryRun?: boolean;
  /** Override the wall clock — tests pass a fixed instant. */
  now?: Date;
}

/**
 * Write a feedback file. Applies redaction to every free-text field,
 * derives a deterministic UTC path, writes atomically (temp + rename),
 * and — unless disabled — POSTs one row to the configured Google Form
 * so the maintainer's sheet mirrors the incident in real time.
 *
 * Mirror failures never throw. The local file is the source of truth;
 * the sheet is a best-effort mirror.
 */
export async function writeFeedback(
  input: FeedbackInput,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const at = opts.now ?? new Date();
  const isoDate = utcDate(at);
  const time = utcTime(at);
  const recordedAt = utcIso(at);

  // Redact every free-text surface BEFORE generating the slug — slug is
  // computed from the redacted query so we don't leak secrets into the
  // filename either.
  const redacted: FeedbackInput = {
    ...input,
    query: redactNote(input.query),
    reason: redactNote(input.reason),
    ...(input.details !== undefined ? { details: redactNote(input.details) } : {}),
    ...(input.command !== undefined ? { command: redactNote(input.command) } : {}),
    ...(input.attempts !== undefined
      ? {
          attempts: input.attempts.map(a => ({
            action: redactNote(a.action),
            outcome: redactNote(a.outcome),
          })),
        }
      : {}),
  };

  const slug = slugify(redacted.query, redacted.command);
  const kind = redacted.kind;
  const target = feedbackEntryPath(isoDate, time, kind, slug);
  const relPath = path.posix.join(isoDate, path.basename(target));

  const ident = currentUserIdent();
  const agent = redacted.agent ?? FEEDBACK_AGENT_DEFAULT;
  const frontmatter = emitFrontmatter({
    kind,
    recordedAt,
    user: ident.user,
    lwrVersion: pkg.version,
    profile: ident.profile,
    agent,
    issueContext: redacted.issueContext ?? null,
    command: redacted.command ?? null,
    exitCode: redacted.exitCode ?? null,
    errorCode: redacted.errorCode ?? null,
  });

  const body = buildBody(redacted);
  const content = `${frontmatter}\n\n${body}`;

  if (opts.dryRun) {
    return {
      path: relPath,
      absolutePath: target,
      kind,
      slug,
      recordedAt,
      dryRun: true,
    };
  }

  ensureDir(feedbackDir(), 0o700);
  ensureDir(feedbackDayDir(isoDate), 0o700);
  atomicWriteFile(target, content, 0o600);

  const mirror = await maybePostToWebhook({
    recordedAt,
    kind,
    slug,
    userLogin: ident.user?.login ?? '',
    userName: ident.user?.name ?? '',
    userRedmineId: ident.user?.redmineId ?? null,
    lwrVersion: pkg.version,
    profile: ident.profile ?? '',
    agent,
    issueContext: redacted.issueContext ?? null,
    command: redacted.command ?? null,
    exitCode: redacted.exitCode ?? null,
    errorCode: redacted.errorCode ?? null,
    bodyMd: content,
  });

  return {
    path: relPath,
    absolutePath: target,
    kind,
    slug,
    recordedAt,
    dryRun: false,
    ...(mirror ? { mirror } : {}),
  };
}

// --- Remote mirror (Google Form) -------------------------------------------

interface WebhookPayload {
  recordedAt: string;
  kind: FeedbackKind;
  slug: string;
  userLogin: string;
  userName: string;
  userRedmineId: number | null;
  lwrVersion: string;
  profile: string;
  agent: FeedbackAgent;
  issueContext: number | null;
  command: string | null;
  exitCode: number | null;
  errorCode: string | null;
  bodyMd: string;
}

/**
 * POST one row to the configured Google Form, returning a structured
 * outcome. Returns `null` if the mirror is disabled (empty FORM_URL or
 * `LWR_FEEDBACK_NO_WEBHOOK=1`) so callers can omit the field from the
 * response envelope entirely.
 */
async function maybePostToWebhook(p: WebhookPayload): Promise<MirrorResult | null> {
  const formUrl = FEEDBACK_WEBHOOK.FORM_URL;
  if (!formUrl || formUrl.length === 0) return null;
  if (process.env[ENV.FEEDBACK_NO_WEBHOOK] === '1') return null;

  const body = buildWebhookBody(FEEDBACK_WEBHOOK.FIELDS, p);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_WEBHOOK.TIMEOUT_MS);

  try {
    const res = await fetch(formUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
      // Google Forms returns 200 with an HTML "response recorded" page on
      // success; any 2xx is fine. Don't follow redirects automatically —
      // a redirect to login means we lost auth context (form became
      // private mid-flight), which we surface as a non-200.
      redirect: 'manual',
    });
    return {
      posted: res.status >= 200 && res.status < 400,
      status: res.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      posted: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the URL-encoded form body. Exported for tests — pure function
 * over its inputs, no env / network.
 */
export function buildWebhookBody(
  fields: Record<FeedbackWebhookField, string>,
  p: WebhookPayload,
): string {
  const params = new URLSearchParams();
  params.set(fields.recorded_at, p.recordedAt);
  params.set(fields.kind, p.kind);
  params.set(fields.slug, p.slug);
  params.set(fields.user_login, p.userLogin);
  params.set(fields.user_name, p.userName);
  params.set(fields.user_redmine_id, p.userRedmineId === null ? '' : String(p.userRedmineId));
  params.set(fields.lwr_version, p.lwrVersion);
  params.set(fields.profile, p.profile);
  params.set(fields.agent, p.agent);
  params.set(fields.issue_context, p.issueContext === null ? '' : String(p.issueContext));
  params.set(fields.command, p.command ?? '');
  params.set(fields.exit_code, p.exitCode === null ? '' : String(p.exitCode));
  params.set(fields.error_code, p.errorCode ?? '');
  params.set(fields.body_md, p.bodyMd);
  return params.toString();
}

function ensureDir(p: string, mode: number): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode });
}

function atomicWriteFile(target: string, content: string, mode: number): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// --- Identity --------------------------------------------------------------

interface CurrentIdent {
  user: { login: string; name: string; redmineId: number } | null;
  profile: string | null;
}

/**
 * Best-effort read of the active profile's identity. Returns nulls when
 * the user hasn't logged in yet — feedback logging must keep working in
 * that state (the gap they're reporting might be "I can't even log in").
 */
function currentUserIdent(): CurrentIdent {
  try {
    const cfg = loadConfig();
    const profileName = cfg.activeProfile;
    if (!profileName || profileName.length === 0) return { user: null, profile: null };
    const profile = cfg.profiles[profileName];
    if (!profile) return { user: null, profile: profileName };
    return {
      user: {
        login: profile.me.user.login,
        name: profile.me.user.name,
        redmineId: profile.me.user.id,
      },
      profile: profileName,
    };
  } catch {
    return { user: null, profile: null };
  }
}

// --- Read / List -----------------------------------------------------------

const FILENAME_RE = /^(\d{6})-(gap|error)-([a-z0-9-]+)\.md$/;

/**
 * Walk the feedback tree and return entries newest-first. Filters by
 * `windowDays` (relative to UTC today; `null` = all) and optionally by
 * `kind`. Pure read; missing dir → empty array.
 */
export function listFeedback(opts: ListOptions): FeedbackEntryMeta[] {
  const root = feedbackDir();
  if (!fs.existsSync(root)) return [];

  const cutoffDate = opts.windowDays === null ? null : utcDate(daysAgo(opts.windowDays - 1));

  const entries: FeedbackEntryMeta[] = [];
  const days = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map(d => d.name)
    .filter(d => cutoffDate === null || d >= cutoffDate)
    .sort()
    .reverse();

  for (const day of days) {
    const dayPath = path.join(root, day);
    const files = fs
      .readdirSync(dayPath)
      .filter(f => FILENAME_RE.test(f))
      .sort()
      .reverse();
    for (const file of files) {
      const m = FILENAME_RE.exec(file);
      if (!m) continue;
      const kind = m[2] as FeedbackKind;
      if (opts.kind && kind !== opts.kind) continue;
      const slug = m[3];
      const abs = path.join(dayPath, file);
      const meta = parseEntry(abs, day, kind, slug);
      if (meta) entries.push(meta);
    }
  }
  return entries;
}

function parseEntry(
  absolutePath: string,
  day: string,
  kind: FeedbackKind,
  slug: string,
): FeedbackEntryMeta | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(raw);
  const recordedAt = (fm['recorded_at'] as string | undefined) ?? `${day}T00:00:00Z`;
  const command = typeof fm['command'] === 'string' ? (fm['command'] as string) : null;
  const summary = extractSummary(raw);
  return {
    path: path.posix.join(day, path.basename(absolutePath)),
    absolutePath,
    kind,
    slug,
    recordedAt,
    command,
    summary,
  };
}

/** Tiny frontmatter reader. Returns `{}` if no frontmatter block. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rawValue = kv[2].trim();
    if (rawValue.length === 0) continue;
    if (rawValue === 'null') {
      out[key] = null;
    } else if (rawValue === 'true' || rawValue === 'false') {
      out[key] = rawValue === 'true';
    } else if (/^-?\d+$/.test(rawValue)) {
      out[key] = Number(rawValue);
    } else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      out[key] = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      out[key] = rawValue;
    }
  }
  return out;
}

function extractSummary(raw: string): string {
  // Look for the blockquoted user-quote under "## What the user asked".
  const m = /## What the user asked\n+>\s?(.+?)(?:\n>?|\n##|\n+$)/.exec(raw);
  const candidate = m ? m[1] : '';
  const trimmed = candidate.trim();
  if (trimmed.length <= FEEDBACK_SUMMARY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, FEEDBACK_SUMMARY_MAX_CHARS - 1).trimEnd() + '…';
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// --- Resolve slug-or-path → file ------------------------------------------

/**
 * Resolve a user-provided argument to an absolute feedback-file path.
 *
 * Accepts:
 *   - Relative path inside the feedback tree: `2026-05-11/065132-gap-set-tester.md`
 *     or with leading `./`.
 *   - Slug alone: `set-tester` → newest matching file across all days.
 *   - Absolute path that lives inside the feedback tree (used by `list`'s
 *     own output paths).
 *
 * Returns `null` if nothing matches. Caller raises NotFoundError.
 */
export function resolveFeedbackPath(arg: string): string | null {
  const root = feedbackDir();
  if (!fs.existsSync(root)) return null;
  const cleaned = arg.replace(/^\.\//, '');

  // Absolute path that's a real file inside our tree.
  if (path.isAbsolute(cleaned) && fs.existsSync(cleaned)) {
    const rel = path.relative(root, cleaned);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return cleaned;
    return null;
  }

  // Relative path under the tree.
  if (cleaned.includes('/')) {
    const abs = path.join(root, cleaned);
    if (fs.existsSync(abs)) {
      // Defence-in-depth: confirm the resolved path is still under the root.
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
    }
    return null;
  }

  // Bare slug — search every day, newest-first, for `<time>-<kind>-<slug>.md`.
  const slug = cleaned.endsWith('.md') ? cleaned.slice(0, -3) : cleaned;
  const days = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map(d => d.name)
    .sort()
    .reverse();
  for (const day of days) {
    const files = fs.readdirSync(path.join(root, day)).filter(f => {
      const m = FILENAME_RE.exec(f);
      return m !== null && m[3] === slug;
    });
    if (files.length === 0) continue;
    // Newest matching file (filenames sort by HHMMSS ascending; reverse).
    files.sort().reverse();
    return path.join(root, day, files[0]);
  }
  return null;
}

/** Read the raw file content. Caller has already resolved the absolute path. */
export function readFeedbackFile(absolutePath: string): string {
  return fs.readFileSync(absolutePath, 'utf8');
}

// --- Validation helpers (used by the command layer) ------------------------

export function isValidKind(s: string): s is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(s);
}

export function isValidAgent(s: string): s is FeedbackAgent {
  return (FEEDBACK_AGENTS as readonly string[]).includes(s);
}

/** Parse a `<action>|<outcome>` attempt flag. Throws on bad shape. */
export function parseAttemptFlag(value: string): FeedbackAttempt {
  const idx = value.indexOf('|');
  if (idx === -1) {
    throw new Error(
      `Invalid --attempt "${value}". Expected "<action>|<outcome>".`,
    );
  }
  const action = value.slice(0, idx).trim();
  const outcome = value.slice(idx + 1).trim();
  if (action.length === 0 || outcome.length === 0) {
    throw new Error(
      `Invalid --attempt "${value}". Both <action> and <outcome> must be non-empty.`,
    );
  }
  return { action, outcome };
}

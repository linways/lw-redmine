/**
 * `lwr log show [--today | --yesterday | --date YYYY-MM-DD]`
 *
 * Renders the action log for one day — every mutating lwr command that
 * fired, with timestamp, command name, args, and outcome. Default is
 * `--today`.
 *
 * This is the *observed* record, not an inferred timeline: each line
 * was written at the wall-clock moment the command completed. For
 * "what happened to this issue on Redmine" (which includes web-UI
 * changes lwr didn't fire), use `lwr issue view <id>` and read the
 * journals.
 *
 * JSON envelope:
 *   { date, total, entries: [ActionLogEntry, ...] }
 *
 * Pretty mode shows one line per entry: `HH:MM:SS  cmd  summary`.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import pc from 'picocolors';
import { dim, header } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import { isValidIsoDate, todayInWorkTz } from '../../workflow/work-log';
import { workLogDayPath } from '../../foundation/paths';
import type { ActionLogEntry } from '../../foundation/action-log';

interface ShowFlags extends GlobalFlags {
  today?: boolean;
  yesterday?: boolean;
  date?: string;
}

interface Payload {
  date: string;
  total: number;
  entries: ActionLogEntry[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as ShowFlags;
  const date = resolveDate(f);
  const entries = readDayActions(date);

  return {
    json: { date, total: entries.length, entries },
    pretty: ctx => {
      writeLine(header(ctx, prettyDateHeader(date, entries.length)));
      if (entries.length === 0) {
        writeLine(`  ${dim(ctx, 'No actions logged.')}`);
        return;
      }
      writeLine(dim(ctx, '─'.repeat(64)));
      for (const e of entries) {
        renderEntry(ctx, e);
      }
      writeLine(dim(ctx, '─'.repeat(64)));
    },
  };
};

function resolveDate(f: ShowFlags): string {
  if (f.today) return todayInWorkTz();
  if (f.yesterday) {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
  if (f.date) {
    if (!isValidIsoDate(f.date)) {
      throw new ValidationError(
        `Invalid date "${f.date}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Use ISO format YYYY-MM-DD with a real month and day.',
      );
    }
    return f.date;
  }
  return todayInWorkTz();
}

function readDayActions(date: string): ActionLogEntry[] {
  const path = workLogDayPath(date);
  if (!fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, 'utf-8');
  const entries: ActionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown> & { schema?: unknown };
      // Skip stray non-action-log lines (e.g. orphan v1 session lines left over).
      if (typeof obj.schema === 'number' && obj.schema >= 2 && typeof obj.cmd === 'string') {
        entries.push(obj as unknown as ActionLogEntry);
      }
    } catch {
      // Skip unparseable lines silently.
    }
  }
  return entries;
}

function prettyDateHeader(date: string, count: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
  const word = count === 1 ? 'action' : 'actions';
  return `${parts}                            ${count} ${word}`;
}

function renderEntry(ctx: import('../../foundation/output').OutputContext, e: ActionLogEntry): void {
  const t = formatTime(e.at);
  const mark = e.outcome === 'success'
    ? (ctx.color ? pc.green('✓') : '✓')
    : (ctx.color ? pc.red('✗') : '✗');
  const summary = summarise(e);
  writeLine(`${t}  ${mark}  ${header(ctx, e.cmd.padEnd(18))}  ${summary}`);
  if (e.outcome === 'error' && e.error) {
    writeLine(`            ${dim(ctx, `[${e.error.code}] ${e.error.message}`)}`);
  }
}

/**
 * One-line gloss of what the entry represents. Falls through to a generic
 * "args: {...}" rendering when no command-specific summary fits.
 */
function summarise(e: ActionLogEntry): string {
  const args = e.args ?? {};
  const result = (e.result as Record<string, unknown> | undefined) ?? {};
  switch (e.cmd) {
    case 'issue.use': {
      const id = args.issue ?? (result.activeIssue as { id?: number } | undefined)?.id;
      const paused = result.paused as { id?: number } | null | undefined;
      return paused ? `→ #${id}  (paused #${paused.id})` : `→ #${id}`;
    }
    case 'issue.clear':
      return 'cleared active pointer';
    case 'issue.pause':
      return `#${(result as { issueId?: number }).issueId ?? '?'} → ${(result as { newStatus?: string }).newStatus ?? 'Paused'}`;
    case 'issue.status': {
      const inner = result.issue as { id?: number; status?: { name?: string } } | undefined;
      const paused = (result.pausedIssue as { id?: number } | null | undefined);
      const base = `#${inner?.id ?? args.id ?? '?'} → ${inner?.status?.name ?? args.status}`;
      return paused ? `${base}  (paused #${paused.id})` : base;
    }
    case 'issue.resolve': {
      const resolved = result.resolved as { id?: number; newStatus?: string } | undefined;
      const paused = result.paused as { id?: number } | null | undefined;
      const te = result.timeEntry as { hours?: number; activity?: string } | null | undefined;
      const parts = [`#${resolved?.id ?? args.id ?? '?'} → ${resolved?.newStatus ?? 'Resolved'}`];
      if (te) parts.push(`+ ${te.hours}h ${te.activity}`);
      if (paused) parts.push(`(paused #${paused.id})`);
      return parts.join(' ');
    }
    case 'issue.assign':
      return `#${(result as { id?: number }).id ?? args.id} → ${args.user}`;
    case 'issue.note':
      return `+ note on #${(result as { id?: number }).id ?? args.id}`;
    case 'issue.create':
      return `created #${(result as { id?: number }).id ?? '?'} — ${(result as { subject?: string }).subject ?? args.subject ?? ''}`;
    case 'issue.edit':
      return `edited #${args.id}`;
    case 'time.log': {
      const te = result as { hours?: number; activity?: { name?: string } };
      return `+ ${te.hours ?? args.hours}h on #${args.id} (${te.activity?.name ?? args.activity ?? '?'})`;
    }
    default:
      // Fall through to a compact args dump.
      return JSON.stringify(args);
  }
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 19);
  }
}

export function showLog(flags: ShowFlags): Promise<never> {
  return runCommand('log.show', flags, cmd);
}

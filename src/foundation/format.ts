/**
 * Pretty-mode rendering primitives.
 *
 * Tables, badges, headers — colors are conditional on `OutputContext.color`.
 * No business logic here; commands compose these into their own renderers.
 */

import pc from 'picocolors';
import Table from 'cli-table3';
import { COLORS, SYMBOLS, TABLE_MAX_COL_WIDTH } from '../constants';
import type { OutputContext } from './output';

type ColorFn = (s: string) => string;

const PALETTE: Record<string, ColorFn> = {
  black: pc.black,
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  magenta: pc.magenta,
  cyan: pc.cyan,
  white: pc.white,
  gray: pc.gray,
  redBright: pc.redBright,
  greenBright: pc.greenBright,
  yellowBright: pc.yellowBright,
  blueBright: pc.blueBright,
  magentaBright: pc.magentaBright,
  cyanBright: pc.cyanBright,
  whiteBright: pc.whiteBright,
};

function paint(ctx: OutputContext, fn: ColorFn, s: string): string {
  return ctx.color ? fn(s) : s;
}

export function statusBadge(ctx: OutputContext, status: string): string {
  const key = status.toLowerCase();
  const colorName = COLORS.status[key] ?? 'white';
  const fn = PALETTE[colorName] ?? pc.white;
  return paint(ctx, fn, status);
}

export function priorityBadge(ctx: OutputContext, priority: string): string {
  const key = priority.toLowerCase();
  const colorName = COLORS.priority[key] ?? 'white';
  const fn = PALETTE[colorName] ?? pc.white;
  return paint(ctx, fn, `${SYMBOLS.priorityDot} ${priority}`);
}

export function header(ctx: OutputContext, text: string): string {
  return paint(ctx, pc.bold, text);
}

export function dim(ctx: OutputContext, text: string): string {
  return paint(ctx, pc.gray, text);
}

export function success(ctx: OutputContext, text: string): string {
  return `${paint(ctx, pc.green, SYMBOLS.success)} ${text}`;
}

export function warn(ctx: OutputContext, text: string): string {
  return `${paint(ctx, pc.yellow, '⚠')} ${text}`;
}

/**
 * Wraps `text` in an OSC 8 hyperlink so modern terminals (iTerm2, Kitty,
 * WezTerm, GNOME Terminal, Windows Terminal, recent VS Code terminal)
 * render it as clickable. Older / minimal terminals just see `text`.
 *
 * Format: `\x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\`
 *
 * Gated on `ctx.color` — same proxy we use for ANSI color escapes. When
 * the user pipes to JSON or has `--no-color`, the function returns plain
 * text so escape sequences don't pollute the stream.
 */
export function hyperlink(ctx: OutputContext, url: string, text: string): string {
  if (!ctx.color) return text;
  const ESC = '\x1b';
  const ST = `${ESC}\\`;
  return `${ESC}]8;;${url}${ST}${text}${ESC}]8;;${ST}`;
}

export interface RenderTableOptions {
  head: string[];
  rows: (string | number)[][];
  /** Per-column widths. Each entry caps that column. */
  colWidths?: number[];
}

export function renderTable(ctx: OutputContext, opts: RenderTableOptions): string {
  const head = ctx.color ? opts.head.map(h => pc.bold(h)) : opts.head;
  const colWidths = opts.colWidths ?? opts.head.map(() => TABLE_MAX_COL_WIDTH);
  const t = new Table({
    head,
    colWidths,
    wordWrap: true,
    style: ctx.color ? { head: [], border: [] } : { head: [], border: [], compact: false },
  });
  for (const row of opts.rows) t.push(row.map(cell => String(cell ?? '')));
  return t.toString();
}

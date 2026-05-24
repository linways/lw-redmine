/**
 * Date helpers + free-text redaction.
 *
 * Originally a much larger module that held the session-based work-log
 * machinery (sessions, anomalies, ack sidecars, git capture). All of
 * that was replaced by the action-log model — see `foundation/action-log.ts`.
 * What remains here is the small set of utilities other modules still
 * depend on:
 *
 *   - `WORK_TZ`, `todayInWorkTz`, `nowIsoInWorkTz`, `isValidIsoDate` —
 *     date / timestamp utilities used by the action log and the read
 *     verbs (`lwr log show --yesterday`).
 *   - `redactNote` — note-text scrubbing used by the feedback module
 *     before persisting user-typed strings.
 *
 * The module name is kept for now to avoid a wide import rename across
 * the codebase; treat it as "date + redaction utilities".
 */

import { WORK_TZ } from '../constants';

export { WORK_TZ };

/** Local-ISO date (`YYYY-MM-DD`) in the configured `WORK_TZ`. */
export function todayInWorkTz(): string {
  return ymdInTz(new Date(), WORK_TZ);
}

/**
 * True iff `s` is a real `YYYY-MM-DD` date — shape AND a valid month/day.
 * Round-trips through `Date.UTC` so `2026-13-99` rejects as expected
 * (mere regex shape-checks accept that as 4-2-2 digits).
 */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const ts = Date.UTC(y, m - 1, d);
  const back = new Date(ts);
  return (
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === m - 1 &&
    back.getUTCDate() === d
  );
}

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** ISO-8601 with offset, e.g. "2026-05-10T09:32:00+05:30", in WORK_TZ. */
export function nowIsoInWorkTz(): string {
  return isoInTz(new Date(), WORK_TZ);
}

function isoInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? '';
  let h = get('hour');
  if (h === '24') h = '00';
  const tzName = get('timeZoneName');
  const offset = tzName === 'GMT' ? '+00:00' : tzName.replace(/^(GMT|UTC)/, '');
  return `${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}:${get('second')}${offset}`;
}

/**
 * Strip obvious secrets from free-text note content. Conservative —
 * better to keep too much than leak a token to disk. Used by the
 * feedback module before writing user-typed strings.
 */
export function redactNote(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|apikey|password|passwd|secret|token|access[_-]?key)\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '[REDACTED]');
}

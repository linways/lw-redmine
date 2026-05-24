/**
 * Flag redaction for the assistant event log.
 *
 * Two policies, applied per-key:
 *   1. SECRET keys (`apiKey`, `password`, etc.) are dropped entirely.
 *      We never want them on disk in any form, even rendered.
 *   2. PROSE keys (`message`, `description`, `notes`, …) keep only
 *      a `<name>Length` integer so inference can detect "user
 *      usually attaches a 200-char note" without recording the body.
 *
 * Everything else is kept verbatim. Numbers, booleans, short strings
 * (project ids, activity names, status names) are exactly the data
 * the future inference layer will pattern-match against.
 *
 * Pure function; no I/O.
 */

import { REDACT_SECRET_FLAG_KEYS, REDACT_PROSE_FLAG_KEYS } from '../constants';

export function redactFlags(flags: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    if (REDACT_SECRET_FLAG_KEYS.has(k)) continue; // drop entirely
    if (REDACT_PROSE_FLAG_KEYS.has(k)) {
      // Keep length-only. Buffer.byteLength would be more accurate for
      // multi-byte content, but this is a debug-friendly counter not
      // a security boundary — string.length is fine.
      const len = typeof v === 'string' ? v.length : 0;
      out[`${k}Length`] = len;
      continue;
    }
    out[k] = v;
  }
  return out;
}

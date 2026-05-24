/**
 * Assistant event log — file-system layer.
 *
 * Tier 2 ships only what the observer needs:
 *   - `appendCommandEvent(payload)` — synchronous append of one
 *     newline-delimited JSON object to `~/.lwr/events/commands.ndjson`
 *   - `getCommandsLogStatus()` — diagnostic snapshot for `lwr events status`
 *
 * No prune verb yet (deferred to Tier 3). Failures are silently swallowed
 * so the assistant layer can never break a user's command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assistantCommandsLogPath, assistantEventsDir } from '../foundation/paths';

/** Append one event as a single NDJSON line. Best-effort; errors are eaten. */
export function appendCommandEvent(payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(assistantEventsDir(), { recursive: true });
    const line = `${JSON.stringify(payload)}\n`;
    fs.appendFileSync(assistantCommandsLogPath(), line, { mode: 0o644 });
  } catch {
    // Observer failure must NEVER break the user's command.
  }
}

export interface CommandsLogStatus {
  /** Where events would be written. */
  path: string;
  /** Whether the file exists yet (absent until first append). */
  exists: boolean;
  /** Total NDJSON lines (one per event). 0 when file absent. */
  totalLines: number;
  /** File size in bytes. 0 when file absent. */
  sizeBytes: number;
  /** First event's `at` timestamp, or null when file empty. */
  oldestAt: string | null;
  /** Last event's `at` timestamp, or null when file empty. */
  newestAt: string | null;
}

/**
 * Diagnostic snapshot for `lwr events status`. Reads the file once;
 * for very large logs (10k+ events) this scans up to a few MB. NDJSON
 * means we can sample first/last line cheaply.
 */
export function getCommandsLogStatus(): CommandsLogStatus {
  const file = assistantCommandsLogPath();
  const empty: CommandsLogStatus = {
    path: file,
    exists: false,
    totalLines: 0,
    sizeBytes: 0,
    oldestAt: null,
    newestAt: null,
  };
  if (!fs.existsSync(file)) return empty;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return empty;
  }
  if (stat.size === 0) {
    return { ...empty, exists: true };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...empty, exists: true, sizeBytes: stat.size };
  }
  const lines = raw.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) {
    return { ...empty, exists: true, sizeBytes: stat.size };
  }
  return {
    path: file,
    exists: true,
    totalLines: lines.length,
    sizeBytes: stat.size,
    oldestAt: extractAt(lines[0]),
    newestAt: extractAt(lines[lines.length - 1]),
  };
}

function extractAt(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { at?: unknown };
    return typeof parsed.at === 'string' ? parsed.at : null;
  } catch {
    return null;
  }
}

// --- Used by the upcoming `lwr assistant disable --purge` ------------------
// Tier 3 will wire `--purge`. Exported now so the path layer is complete.

export function eventsDirectoryPath(): string {
  return path.dirname(assistantCommandsLogPath());
}

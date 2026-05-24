/**
 * The assistant's `CommandObserver` — built once per lwr process at
 * startup *iff* the assistant feature flag is enabled, and unregistered
 * when not. Keeping the wiring here means `src/foundation/run.ts` doesn't
 * import from `src/assistant/`; the dependency is one-way.
 */

import { setCommandObserver, type CommandEvent, type CommandObserver } from '../foundation/run';
import { isAssistantEnabled, memoryBankId } from './state';
import { appendCommandEvent } from './events';
import { redactFlags } from './redact';
import { EXCLUDED_FROM_OBSERVATION } from '../constants';
import { retain } from '../memory';

/** Build the persisted shape from the in-memory event. Pure function. */
export function buildEventRecord(event: CommandEvent): Record<string, unknown> {
  const record: Record<string, unknown> = {
    at: event.at,
    cmd: event.cmd,
    requestId: event.requestId,
    flags: redactFlags(event.flags),
    outcome: event.outcome,
    exitCode: event.exitCode,
    durationMs: event.durationMs,
  };
  if (event.errorCode !== undefined) record.errorCode = event.errorCode;
  if (event.safety !== undefined) record.safety = event.safety;
  if (event.network !== undefined) record.network = event.network;
  return record;
}

function createObserver(): CommandObserver {
  return {
    onComplete(event) {
      // Skip self-observing / high-frequency / long-running commands.
      if (EXCLUDED_FROM_OBSERVATION.has(event.cmd)) return;
      appendCommandEvent(buildEventRecord(event));
      retainCommandObservation(event);
    },
  };
}

/**
 * Mirror the command event into the memory module as an `observation`.
 * The NDJSON file is the immutable audit log; memory is the queryable
 * index. Both must coexist for now — memory recall is what agents read,
 * NDJSON is what humans grep.
 *
 * Errors are silently swallowed: memory writes must never fail a command.
 */
function retainCommandObservation(event: CommandEvent): void {
  try {
    const metadata: Record<string, string | number | boolean | null> = {
      cmd: event.cmd,
      outcome: event.outcome,
      exit_code: event.exitCode,
    };
    if (event.safety !== undefined) metadata.safety = event.safety;
    if (event.network !== undefined) metadata.network = event.network;
    if (event.errorCode !== undefined) metadata.error_code = event.errorCode;
    retain({
      bankId: memoryBankId(),
      kind: 'observation',
      content: `${event.cmd} (${event.outcome}, ${event.durationMs}ms)`,
      metadata,
    });
  } catch {
    // Memory writes are best-effort.
  }
}

/**
 * Bootstrap the observer if the persisted flag says so. Called from
 * `cli.ts` before commander dispatches. With the flag off, this is a
 * single config read (~1 ms) and no observer is registered — the run
 * path stays a pure null-check.
 */
export function bootstrapAssistantObserver(): void {
  try {
    if (isAssistantEnabled()) {
      setCommandObserver(createObserver());
    }
  } catch {
    // Bootstrap must NEVER block lwr from running. A corrupt config
    // would surface from the next real command anyway, with the
    // proper error envelope.
  }
}

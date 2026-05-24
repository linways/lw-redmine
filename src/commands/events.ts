/**
 * `lwr events status`
 *
 * Diagnostic verb for the assistant's event log. Reports whether the
 * observer is enabled, where the file is, and basic counts/timestamps.
 *
 * Tier 2 ships only `status` (read-only). `list` (paginated browse)
 * and `prune` (manual cleanup) come in Tier 3 — for now the file is
 * trivially inspectable with `cat ~/.lwr/events/commands.ndjson | jq`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, header } from '../foundation/format';
import { getCommandsLogStatus } from '../assistant/events';
import { isAssistantEnabled } from '../assistant/state';

interface StatusPayload {
  /** Whether the observer would record the next command. */
  assistantEnabled: boolean;
  /** Where events are written. */
  eventsFile: string;
  /** Whether the file currently exists. */
  exists: boolean;
  /** NDJSON line count. */
  totalLines: number;
  /** File size on disk. */
  sizeBytes: number;
  /** Timestamp of the first / oldest recorded event, or null. */
  oldestAt: string | null;
  /** Timestamp of the most recent event, or null. */
  newestAt: string | null;
}

const cmd: CommandFn<StatusPayload> = async (): Promise<CommandResult<StatusPayload>> => {
  const enabled = isAssistantEnabled();
  const log = getCommandsLogStatus();
  const data: StatusPayload = {
    assistantEnabled: enabled,
    eventsFile: log.path,
    exists: log.exists,
    totalLines: log.totalLines,
    sizeBytes: log.sizeBytes,
    oldestAt: log.oldestAt,
    newestAt: log.newestAt,
  };
  return {
    json: data,
    pretty: ctx => {
      writeLine(header(ctx, 'lwr events'));
      writeLine(`assistant: ${enabled ? 'enabled' : 'disabled'}`);
      writeLine(`file:      ${log.path}`);
      if (!log.exists) {
        writeLine(dim(ctx, '  (no events recorded yet)'));
        return;
      }
      writeLine(`events:    ${log.totalLines} (${log.sizeBytes} bytes)`);
      if (log.oldestAt) writeLine(`oldest:    ${log.oldestAt}`);
      if (log.newestAt) writeLine(`newest:    ${log.newestAt}`);
    },
  };
};

export function status(flags: GlobalFlags): Promise<never> {
  return runCommand('events.status', flags, cmd);
}

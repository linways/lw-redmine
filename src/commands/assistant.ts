/**
 * `lwr assistant enable | disable | status`
 *
 * Thin verbs that flip the `assistant.enabled` flag in the persisted
 * config. Foundation tier (Phase 3) — once enabled, later tiers
 * (events log, taught knowledge, inference, suggested defaults) start
 * doing work. Until then this only persists a bit.
 *
 * Disabled by default; vanilla lwr behaviour is byte-identical with
 * `enabled: false`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, success } from '../foundation/format';
import {
  disableAssistant,
  enableAssistant,
  getAssistantState,
  type AssistantState,
} from '../assistant/state';

interface AssistantPayload extends AssistantState {
  /** Always true — lets agents distinguish a no-op state read from a flip. */
  readonly persisted: true;
}

const enableCmd: CommandFn<AssistantPayload> = async (ctx): Promise<CommandResult<AssistantPayload>> => {
  void ctx;
  const state = enableAssistant();
  return {
    json: { ...state, persisted: true },
    pretty: c => {
      if (!state.enabled) {
        writeLine(success(c, 'Assistant unchanged.'));
        return;
      }
      writeLine(success(c, 'Assistant enabled.'));
      writeLine(dim(c, '  - Each command you run is appended to ~/.lwr/events/commands.ndjson.'));
      writeLine(dim(c, '  - Sensitive flags (api-key, message bodies) are redacted before write.'));
      writeLine(dim(c, '  - Inspect: `lwr events status` or `tail ~/.lwr/events/commands.ndjson | jq`.'));
      writeLine(dim(c, '  - Disable any time with `lwr assistant disable`.'));
    },
  };
};

const disableCmd: CommandFn<AssistantPayload> = async (): Promise<CommandResult<AssistantPayload>> => {
  const state = disableAssistant();
  return {
    json: { ...state, persisted: true },
    pretty: ctx =>
      writeLine(
        success(
          ctx,
          state.enabled
            ? 'Assistant unchanged.'
            : 'Assistant disabled. lwr now behaves as vanilla CLI.',
        ),
      ),
  };
};

const statusCmd: CommandFn<AssistantPayload> = async (): Promise<CommandResult<AssistantPayload>> => {
  const state = getAssistantState();
  return {
    json: { ...state, persisted: true },
    pretty: ctx => {
      writeLine(`assistant: ${state.enabled ? 'enabled' : 'disabled'}`);
      if (!state.enabled) {
        writeLine(dim(ctx, '  Run `lwr assistant enable` to opt in.'));
      }
    },
  };
};

export function enable(flags: GlobalFlags): Promise<never> {
  return runCommand('assistant.enable', flags, enableCmd);
}

export function disable(flags: GlobalFlags): Promise<never> {
  return runCommand('assistant.disable', flags, disableCmd);
}

export function status(flags: GlobalFlags): Promise<never> {
  return runCommand('assistant.status', flags, statusCmd);
}

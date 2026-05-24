/**
 * Interactive prompt helpers — wrap @inquirer/prompts so commands never
 * touch them directly. Every prompt here checks `ctx.interactive` first;
 * if false (non-TTY, --no-interactive, --json), it throws a typed
 * ValidationError telling the agent which flag to pass instead.
 *
 * Per PLAN.md §0.5 rule 3, every prompt MUST have a flag equivalent.
 */

import { input as inquirerInput, password as inquirerPassword } from '@inquirer/prompts';
import { ValidationError } from './errors';
import { ERROR_CODES } from '../constants';
import type { OutputContext } from './output';

export interface PromptOptions {
  ctx: OutputContext;
  /** What flag the caller should pass instead, e.g. `--api-key`. */
  flagHint: string;
}

export interface AskInputOptions extends PromptOptions {
  message: string;
  default?: string;
}

export async function askInput(opts: AskInputOptions): Promise<string> {
  if (!opts.ctx.interactive) {
    throw new ValidationError(
      `Missing required value: ${opts.message}`,
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      `Pass ${opts.flagHint} or run interactively in a TTY.`,
    );
  }
  return inquirerInput({ message: opts.message, default: opts.default });
}

export async function askPassword(opts: PromptOptions & { message: string }): Promise<string> {
  if (!opts.ctx.interactive) {
    throw new ValidationError(
      `Missing required secret: ${opts.message}`,
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      `Pass ${opts.flagHint} or run interactively in a TTY.`,
    );
  }
  return inquirerPassword({ message: opts.message, mask: '•' });
}

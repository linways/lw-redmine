/**
 * Double-confirmation helper for destructive commands.
 *
 * Three commands need it: `auth logout`, `clear-data`, `uninstall`. Each
 * touches state that's expensive to re-create (credentials, caches, the
 * whole `~/.lwr/` tree), so we guard with a two-step ack:
 *
 *   - TTY: prompt 1 asks the user to TYPE the action keyword (e.g.
 *     "uninstall" — not just "y"); prompt 2 asks for the literal "YES".
 *     A typo at either step bails without touching anything.
 *
 *   - Non-TTY (agents): require both `--confirm "<action>"` and `--yes`.
 *     Missing either throws `VALIDATION_MISSING_FLAG` with a hint listing
 *     both. The agent has to deliberately commit twice.
 *
 * Design notes:
 *
 *   - Asking for the action keyword (not just "yes") means the agent has
 *     to read what action it's confirming — defeats blanket
 *     "accept all prompts" automation.
 *
 *   - Two flags (not one with a verbose value) lets agents pattern-match
 *     errors and decide per-flag whether to retry.
 *
 *   - The "affected paths" list is displayed in TTY mode only; structured
 *     callers can pass it for parity with what they'll log to JSON.
 */

import { input } from '@inquirer/prompts';
import { ERROR_CODES } from '../constants';
import { ValidationError } from './errors';
import { writeLine } from './output';
import { warn, dim } from './format';
import type { OutputContext } from './output';

export interface DoubleConfirmFlags {
  /** Must equal the action keyword exactly to satisfy non-TTY confirmation. */
  confirm?: string;
  /** Second-level non-TTY ack. Must be set alongside --confirm. */
  yes?: boolean;
}

export interface DoubleConfirmOptions {
  /** Short keyword the user must type (and matches `--confirm`). e.g. "logout". */
  action: string;
  /** One-line description of what's about to happen. */
  description: string;
  /** Paths that will be touched — listed to the user in TTY mode for transparency. */
  affectedPaths?: string[];
  ctx: OutputContext;
  flags: DoubleConfirmFlags;
}

/**
 * Throws if the user (TTY or agent) hasn't double-confirmed. Returns
 * normally on success — caller proceeds with the destructive action.
 */
export async function confirmDestructive(opts: DoubleConfirmOptions): Promise<void> {
  const { action, description, affectedPaths, ctx, flags } = opts;

  if (!ctx.interactive) {
    // Non-TTY: both flags must be set.
    if (typeof flags.confirm !== 'string' || flags.confirm !== action) {
      throw new ValidationError(
        `Confirmation required. About to ${description}.`,
        ERROR_CODES.VALIDATION_MISSING_FLAG,
        `Pass --confirm "${action}" and --yes to proceed (both flags are required).`,
      );
    }
    if (flags.yes !== true) {
      throw new ValidationError(
        `Final confirmation missing.`,
        ERROR_CODES.VALIDATION_MISSING_FLAG,
        `Pass --yes alongside --confirm "${action}" to proceed.`,
      );
    }
    return;
  }

  // TTY: human flow with two literal prompts.
  writeLine(warn(ctx, `About to ${description}.`));
  if (affectedPaths && affectedPaths.length > 0) {
    writeLine(dim(ctx, 'This will touch:'));
    for (const p of affectedPaths) writeLine(dim(ctx, `  • ${p}`));
  }

  const ack1 = await input({
    message: `Type "${action}" to confirm (or anything else to cancel):`,
  });
  if (ack1.trim() !== action) {
    throw new ValidationError(
      `Cancelled — expected "${action}", got "${ack1.trim()}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Re-run when you are ready.',
    );
  }

  const ack2 = await input({
    message: 'Final confirmation. Type YES (uppercase) to proceed:',
  });
  if (ack2.trim() !== 'YES') {
    throw new ValidationError(
      `Cancelled — expected "YES", got "${ack2.trim()}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Re-run when you are ready.',
    );
  }
}

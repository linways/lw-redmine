/**
 * `lwr feedback show <slug-or-relative-path>`
 *
 * Print one feedback file to stdout. Pretty mode just cats the markdown
 * so it's directly grep-able; JSON mode wraps it in the lwr/v1 envelope
 * with the parsed frontmatter as structured data plus the raw body.
 */

import path from 'node:path';
import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { NotFoundError, ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import {
  parseFrontmatter,
  readFeedbackFile,
  resolveFeedbackPath,
} from '../../workflow/feedback';
import { feedbackDir } from '../../foundation/paths';

interface ShowFlags extends GlobalFlags {
  ref?: string;
}

interface ShowPayload {
  path: string;
  absolutePath: string;
  frontmatter: Record<string, unknown>;
  /** Full file contents (frontmatter + body). */
  content: string;
}

const cmd: CommandFn<ShowPayload> = async (flags): Promise<CommandResult<ShowPayload>> => {
  const f = flags as ShowFlags;
  if (!f.ref || f.ref.trim().length === 0) {
    throw new ValidationError(
      'Slug or relative path is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'e.g. `lwr feedback show set-tester` or `lwr feedback show 2026-05-11/065132-gap-set-tester.md`.',
    );
  }
  const absolutePath = resolveFeedbackPath(f.ref);
  if (!absolutePath) {
    throw new NotFoundError(
      `No feedback file matches "${f.ref}".`,
      'Run `lwr feedback list --json` to see what exists.',
    );
  }
  const content = readFeedbackFile(absolutePath);
  const frontmatter = parseFrontmatter(content);
  const rel = path.relative(feedbackDir(), absolutePath);

  const payload: ShowPayload = {
    path: rel.split(path.sep).join('/'),
    absolutePath,
    frontmatter,
    content,
  };

  return {
    json: payload,
    pretty: () => {
      // Cat the file directly — keeps the markdown faithful for piping
      // to `less`, `glow`, or just reading.
      process.stdout.write(content.endsWith('\n') ? content : content + '\n');
    },
  };
};

export function showFeedback(flags: ShowFlags): Promise<never> {
  return runCommand('feedback.show', flags, cmd);
}

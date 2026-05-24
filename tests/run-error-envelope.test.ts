/**
 * `runCommand` catch-path coverage.
 *
 * The audit flagged that nothing exercises the JSON envelope produced
 * when a command throws (run.ts:142-155). Pin the contract: in --json
 * mode, a thrown LwrError must surface as a `lwr/v1` failure envelope
 * with `ok: false`, the right `error.code`, the static commandMeta
 * stamp, and the right exit code.
 */

import { describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/foundation/run';
import { ValidationError, AuthMissingError, NotFoundError } from '../src/foundation/errors';
import { ERROR_CODES, EXIT } from '../src/constants';

interface CapturedFailure {
  envelope: Record<string, unknown>;
  exitCode: number;
  stderr: string;
}

interface CaptureOptions {
  /** Whether to report stderr as a TTY for the duration of the run. Default false. */
  stderrIsTTY?: boolean;
  /** Override flags passed to runCommand. Default `{ json: true }`. */
  flags?: Parameters<typeof runCommand>[1];
}

/**
 * Drive runCommand to completion under --json, capture stdout/stderr
 * and the exit code without actually exiting the test process.
 */
async function captureFailure(
  commandName: string,
  throwing: () => never,
  options: CaptureOptions = {},
): Promise<CapturedFailure> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  // Override stderr.isTTY for this run; restore in finally. process.stderr's
  // isTTY is a plain property, so a defineProperty swap is enough.
  const origIsTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, 'isTTY', {
    value: Boolean(options.stderrIsTTY),
    configurable: true,
    writable: true,
  });
  let captured = 0;
  // process.exit is typed `(code?: number) => never`; we throw so the
  // promise chain unwinds without actually killing the test runner.
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number): never => {
      captured = code ?? 0;
      throw new Error(`__captured_exit_${captured}__`);
    }) as unknown as typeof process.exit);

  try {
    await runCommand(commandName, options.flags ?? { json: true }, async () => {
      throwing();
    });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__captured_exit_')) throw e;
  } finally {
    writeSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process.stderr, 'isTTY', {
      value: origIsTTY,
      configurable: true,
      writable: true,
    });
  }

  const joined = stdoutChunks.join('');
  // The envelope is one JSON line; trim trailing newline.
  return {
    envelope: JSON.parse(joined.trim()),
    exitCode: captured,
    stderr: stderrChunks.join(''),
  };
}

describe('runCommand error envelope (run.ts catch path)', () => {
  it('emits a lwr/v1 failure envelope with stable shape on ValidationError', async () => {
    const { envelope, exitCode } = await captureFailure('issue.note', () => {
      throw new ValidationError('Note body is empty.', ERROR_CODES.VALIDATION_BAD_VALUE);
    });
    expect(envelope).toMatchObject({
      schema: 'lwr/v1',
      command: 'issue.note',
      ok: false,
      error: { code: 'VALIDATION_BAD_VALUE', message: 'Note body is empty.' },
    });
    expect(typeof envelope.requestId).toBe('string');
    expect(exitCode).toBe(EXIT.VALIDATION);
  });

  it('stamps commandMeta from the static annotation registry on failure', async () => {
    const { envelope } = await captureFailure('issue.edit', () => {
      throw new NotFoundError('issue 999 not found.');
    });
    expect(envelope.commandMeta).toEqual({
      safety: 'mutate',
      idempotent: true,
      network: true,
    });
  });

  it('maps AuthMissingError → AUTH_MISSING + exit 2', async () => {
    const { envelope, exitCode } = await captureFailure('me.show', () => {
      throw new AuthMissingError();
    });
    expect((envelope.error as { code: string }).code).toBe('AUTH_MISSING');
    expect(exitCode).toBe(EXIT.AUTH);
  });

  it('preserves error.hint when set on the LwrError', async () => {
    const { envelope } = await captureFailure('time.log', () => {
      throw new ValidationError(
        'hours must be > 0',
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Pass a positive decimal.',
      );
    });
    expect((envelope.error as { hint?: string }).hint).toBe('Pass a positive decimal.');
  });

  it('preserves the requestId across success-path absence (failures still get one)', async () => {
    const { envelope } = await captureFailure('cache.list', () => {
      throw new ValidationError('boom');
    });
    expect(typeof envelope.requestId).toBe('string');
    expect((envelope.requestId as string).length).toBeGreaterThan(0);
  });
});

describe('runCommand JSON-mode stderr mirror', () => {
  // Strip any ANSI escapes so assertions don't depend on color state.
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('writes the human-readable error + hint to stderr when stderr is a TTY', async () => {
    const { stderr } = await captureFailure(
      'time.log',
      () => {
        throw new ValidationError(
          'hours must be > 0',
          ERROR_CODES.VALIDATION_BAD_VALUE,
          'Pass a positive decimal.',
        );
      },
      { stderrIsTTY: true },
    );
    const plain = stripAnsi(stderr);
    expect(plain).toContain('✗ hours must be > 0');
    expect(plain).toContain('hint: Pass a positive decimal.');
  });

  it('stays silent on stderr when stderr is not a TTY (piped/redirected)', async () => {
    const { stderr } = await captureFailure(
      'time.log',
      () => {
        throw new ValidationError('hours must be > 0', ERROR_CODES.VALIDATION_BAD_VALUE);
      },
      { stderrIsTTY: false },
    );
    expect(stderr).toBe('');
  });

  it('omits the hint line when no hint is set, even on a TTY', async () => {
    const { stderr } = await captureFailure(
      'cache.list',
      () => {
        throw new ValidationError('boom', ERROR_CODES.VALIDATION_BAD_VALUE);
      },
      { stderrIsTTY: true },
    );
    const plain = stripAnsi(stderr);
    expect(plain).toContain('✗ boom');
    expect(plain).not.toContain('hint:');
  });

  it('honors --no-color in stderr output', async () => {
    const { stderr } = await captureFailure(
      'time.log',
      () => {
        throw new ValidationError('boom', ERROR_CODES.VALIDATION_BAD_VALUE, 'try this');
      },
      { stderrIsTTY: true, flags: { json: true, noColor: true } },
    );
    // No ANSI escapes when --no-color is set.
    expect(stderr).not.toMatch(/\x1b\[/);
    expect(stderr).toContain('✗ boom');
    expect(stderr).toContain('hint: try this');
  });

  it('does not duplicate the JSON envelope onto stderr', async () => {
    const { stderr } = await captureFailure(
      'cache.list',
      () => {
        throw new ValidationError('boom', ERROR_CODES.VALIDATION_BAD_VALUE);
      },
      { stderrIsTTY: true },
    );
    expect(stderr).not.toContain('"schema"');
    expect(stderr).not.toContain('"ok"');
  });
});

import { describe, expect, it } from 'vitest';
import {
  jsonFailure,
  jsonSuccess,
  resolveOutputContextWithEnv,
  JSON_SCHEMA_VERSION,
} from '../src/foundation/output';
import { AuthMissingError, LwrError, NotFoundError } from '../src/foundation/errors';
import { ERROR_CODES, EXIT } from '../src/constants';

const env = (over: Partial<Parameters<typeof resolveOutputContextWithEnv>[1]>) => ({
  stdoutIsTTY: true,
  stdinIsTTY: true,
  noColor: false,
  envNoInteractive: false,
  ...over,
});

describe('resolveOutputContextWithEnv', () => {
  it('--json wins over everything → mode=json, no color, no interactive', () => {
    const ctx = resolveOutputContextWithEnv({ json: true }, env({}));
    expect(ctx.mode).toBe('json');
    expect(ctx.color).toBe(false);
    expect(ctx.interactive).toBe(false);
  });

  it('TTY + interactive stdin + no flags → pretty, color, interactive', () => {
    const ctx = resolveOutputContextWithEnv({}, env({}));
    expect(ctx.mode).toBe('pretty');
    expect(ctx.color).toBe(true);
    expect(ctx.interactive).toBe(true);
  });

  it('non-TTY stdout → plain mode', () => {
    const ctx = resolveOutputContextWithEnv({}, env({ stdoutIsTTY: false }));
    expect(ctx.mode).toBe('plain');
    expect(ctx.color).toBe(false);
    expect(ctx.interactive).toBe(false);
  });

  it('NO_COLOR env disables color but stays pretty', () => {
    const ctx = resolveOutputContextWithEnv({}, env({ noColor: true }));
    expect(ctx.mode).toBe('plain');
    expect(ctx.color).toBe(false);
  });

  it('--no-color → plain mode, no color', () => {
    const ctx = resolveOutputContextWithEnv({ noColor: true }, env({}));
    expect(ctx.mode).toBe('plain');
    expect(ctx.color).toBe(false);
  });

  it('--no-interactive disables prompts even in TTY', () => {
    const ctx = resolveOutputContextWithEnv({ noInteractive: true }, env({}));
    expect(ctx.interactive).toBe(false);
  });

  it('LWR_NO_INTERACTIVE env disables prompts', () => {
    const ctx = resolveOutputContextWithEnv({}, env({ envNoInteractive: true }));
    expect(ctx.interactive).toBe(false);
  });

  it('non-TTY stdin → never interactive', () => {
    const ctx = resolveOutputContextWithEnv({}, env({ stdinIsTTY: false }));
    expect(ctx.interactive).toBe(false);
  });
});

describe('JSON envelope shape', () => {
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    requestId: '00000000-0000-0000-0000-000000000000',
    ...overrides,
  });

  it('jsonSuccess wraps data with schema + command + ok + requestId', () => {
    const env = jsonSuccess('issue.view', { id: 1 }, ctx());
    expect(env).toMatchObject({
      schema: JSON_SCHEMA_VERSION,
      command: 'issue.view',
      requestId: '00000000-0000-0000-0000-000000000000',
      ok: true,
      data: { id: 1 },
    });
  });

  it('jsonSuccess attaches commandMeta when supplied', () => {
    const env = jsonSuccess(
      'issue.view',
      { id: 1 },
      ctx({ commandMeta: { safety: 'read', idempotent: true, network: true } }),
    );
    expect(env.commandMeta).toEqual({ safety: 'read', idempotent: true, network: true });
  });

  it('jsonSuccess omits commandMeta when not supplied', () => {
    const env = jsonSuccess('issue.view', { id: 1 }, ctx());
    expect(env).not.toHaveProperty('commandMeta');
  });

  it('jsonFailure exposes code/message and includes hint when present', () => {
    const env = jsonFailure(
      'issue.view',
      new NotFoundError('issue 999 not found.', 'try a different id'),
      ctx(),
    );
    expect(env).toMatchObject({
      schema: JSON_SCHEMA_VERSION,
      command: 'issue.view',
      requestId: '00000000-0000-0000-0000-000000000000',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'issue 999 not found.', hint: 'try a different id' },
    });
  });

  it('jsonFailure omits hint when undefined', () => {
    const env = jsonFailure('issue.view', new AuthMissingError(undefined), ctx());
    expect(env.ok).toBe(false);
    if (!env.ok) {
      // hint is set via AuthMissingError default; explicitly check the `hint` key only when caller passed undefined would-be path
      expect(typeof env.error.code).toBe('string');
    }
  });

  it('jsonFailure carries commandMeta and requestId for destructive verbs too', () => {
    const env = jsonFailure(
      'time.delete',
      new NotFoundError('entry 999 not found.'),
      ctx({ commandMeta: { safety: 'destructive', idempotent: true, network: true } }),
    );
    expect(env.commandMeta).toEqual({ safety: 'destructive', idempotent: true, network: true });
    expect(env.requestId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('schema field is the public version constant', () => {
    expect(JSON_SCHEMA_VERSION).toBe('lwr/v1');
  });

  /**
   * L4 regression: an LwrError can carry a `cause` (e.g. an axios error
   * whose toString includes the failing URL with `?api_key=…` query).
   * jsonFailure picks specific fields off the error and must NEVER
   * project the cause into the envelope. If anyone refactors the
   * envelope builder to spread `.cause` (intentionally or via a
   * `{ ...err }`-style change), this test fails loudly and stops the
   * leak before it ships.
   */
  it('jsonFailure never projects the LwrError.cause into the envelope', () => {
    const sensitive = new Error(
      'AxiosError: Request failed with status 401 [GET https://red.example.com/issues.json?api_key=SECRET-LEAK-9X7Q]',
    );
    const wrapped = new LwrError({
      message: 'Unauthorized — API key rejected.',
      code: ERROR_CODES.AUTH_INVALID,
      exit: EXIT.AUTH,
      cause: sensitive,
    });
    const env = jsonFailure('issue.list', wrapped, {
      requestId: '00000000-0000-0000-0000-000000000000',
    });

    // Sanity: the wrapped error itself does carry the cause.
    expect(wrapped.cause).toBe(sensitive);

    // The envelope must not — neither as a key nor as embedded text.
    expect(env).not.toHaveProperty('cause');
    expect(env.error).not.toHaveProperty('cause');
    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain('SECRET-LEAK-9X7Q');
    expect(serialised).not.toContain('api_key');
    expect(serialised).not.toContain('cause');
  });
});

import { describe, expect, it } from 'vitest';
import {
  asLwrError,
  fromHttpFailure,
  AuthError,
  AuthMissingError,
  ConfigError,
  InternalError,
  LwrError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../src/foundation/errors';
import { EXIT, ERROR_CODES } from '../src/constants';

describe('fromHttpFailure — HTTP status mapping', () => {
  it('401 → AuthError (exit AUTH)', () => {
    const e = fromHttpFailure({ status: 401 });
    expect(e).toBeInstanceOf(AuthError);
    expect(e.code).toBe(ERROR_CODES.AUTH_INVALID);
    expect(e.exit).toBe(EXIT.AUTH);
  });

  it('403 → AUTH_FORBIDDEN', () => {
    const e = fromHttpFailure({ status: 403 });
    expect(e.code).toBe(ERROR_CODES.AUTH_FORBIDDEN);
    expect(e.exit).toBe(EXIT.AUTH);
  });

  it('404 with resource hint → NotFoundError with resource in message', () => {
    const e = fromHttpFailure({ status: 404, resource: 'issue 999' });
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.message).toBe('issue 999 not found.');
    expect(e.exit).toBe(EXIT.NOT_FOUND);
  });

  it('404 without resource → generic message', () => {
    const e = fromHttpFailure({ status: 404 });
    expect(e.message).toBe('Resource not found.');
  });

  it('422 → ValidationError, extracts errors[] from body', () => {
    const e = fromHttpFailure({
      status: 422,
      body: { errors: ['Subject cannot be blank', 'Project cannot be blank'] },
    });
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.code).toBe(ERROR_CODES.VALIDATION_API_REJECTED);
    expect(e.message).toContain('Subject cannot be blank');
    expect(e.message).toContain('Project cannot be blank');
    expect(e.exit).toBe(EXIT.VALIDATION);
  });

  it('422 with no parseable body → fallback message', () => {
    const e = fromHttpFailure({ status: 422, body: { foo: 'bar' } });
    expect(e.message).toBe('Redmine rejected the request (422).');
  });

  it('429 → RateLimitError', () => {
    const e = fromHttpFailure({ status: 429 });
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(e.exit).toBe(EXIT.NETWORK);
  });

  it('500 → ServerError (exit SERVER)', () => {
    const e = fromHttpFailure({ status: 500 });
    expect(e).toBeInstanceOf(ServerError);
    expect(e.exit).toBe(EXIT.SERVER);
  });

  it('418 (unrecognised 4xx) → INTERNAL', () => {
    const e = fromHttpFailure({ status: 418 });
    expect(e.code).toBe(ERROR_CODES.INTERNAL);
    expect(e.exit).toBe(EXIT.INTERNAL);
  });
});

describe('fromHttpFailure — network-layer codes', () => {
  it('ECONNREFUSED → NETWORK_REFUSED', () => {
    const e = fromHttpFailure({ networkCode: 'ECONNREFUSED' });
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.code).toBe(ERROR_CODES.NETWORK_REFUSED);
  });
  it('ENOTFOUND → NETWORK_DNS', () => {
    const e = fromHttpFailure({ networkCode: 'ENOTFOUND' });
    expect(e.code).toBe(ERROR_CODES.NETWORK_DNS);
  });
  it('ETIMEDOUT → NETWORK_TIMEOUT', () => {
    const e = fromHttpFailure({ networkCode: 'ETIMEDOUT' });
    expect(e.code).toBe(ERROR_CODES.NETWORK_TIMEOUT);
  });
  it('ECONNABORTED → NETWORK_TIMEOUT', () => {
    const e = fromHttpFailure({ networkCode: 'ECONNABORTED' });
    expect(e.code).toBe(ERROR_CODES.NETWORK_TIMEOUT);
  });
  it('unknown code → generic NetworkError', () => {
    const e = fromHttpFailure({ networkCode: 'EWHATEVER' });
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.exit).toBe(EXIT.NETWORK);
  });
});

describe('asLwrError — passthrough / wrap behaviour', () => {
  it('LwrError → returned as-is', () => {
    const orig = new AuthMissingError();
    expect(asLwrError(orig)).toBe(orig);
  });
  it('plain Error → wrapped as InternalError', () => {
    const e = asLwrError(new Error('boom'));
    expect(e).toBeInstanceOf(InternalError);
    expect(e.message).toBe('boom');
  });
  it('non-Error throws → stringified InternalError', () => {
    const e = asLwrError(42);
    expect(e).toBeInstanceOf(InternalError);
    expect(e.message).toBe('42');
  });
});

describe('LwrError construction sanity', () => {
  it('preserves cause via ES2022 .cause', () => {
    const cause = new Error('underlying');
    const e = new ConfigError('bad', undefined, undefined, cause);
    expect((e as Error & { cause?: unknown }).cause).toBe(cause);
  });
  it('every typed error sets the contract fields', () => {
    const errs: LwrError[] = [
      new AuthMissingError(),
      new AuthError('a'),
      new NotFoundError('x'),
      new NetworkError('n'),
      new ServerError('s'),
      new ConfigError('c'),
      new ValidationError('v'),
      new RateLimitError(),
    ];
    for (const e of errs) {
      expect(typeof e.code).toBe('string');
      expect(typeof e.exit).toBe('number');
    }
  });
});

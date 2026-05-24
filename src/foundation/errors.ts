/**
 * Custom error hierarchy.
 *
 * Every error thrown out of `lwr` core / api / commands inherits from
 * `LwrError` so the top-level CLI handler can format it consistently
 * (Pretty or JSON) and exit with the right code.
 *
 * Error contract:
 *   .code   — stable string from ERROR_CODES (AI agents branch on this)
 *   .message — human readable
 *   .hint   — actionable next step (or undefined)
 *   .exit   — process exit code
 *   .cause  — original error (kept on .cause per ES2022)
 */

import { EXIT, ERROR_CODES, type ErrorCode, type ExitCode } from '../constants';

export interface LwrErrorOptions {
  message: string;
  code: ErrorCode;
  exit: ExitCode;
  hint?: string;
  cause?: unknown;
  /**
   * Structured payload exposed under `error.details` in the JSON envelope.
   * For workflow errors this is `{ allowed: [{id,name}] }`; agents branch on
   * `error.code` and read `details` to recover without re-fetching.
   */
  details?: Record<string, unknown>;
}

export class LwrError extends Error {
  readonly code: ErrorCode;
  readonly exit: ExitCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(opts: LwrErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
    this.exit = opts.exit;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

export class AuthError extends LwrError {
  constructor(message: string, hint?: string, cause?: unknown) {
    super({ message, code: ERROR_CODES.AUTH_INVALID, exit: EXIT.AUTH, hint, cause });
  }
}

export class AuthMissingError extends LwrError {
  constructor(hint = 'Run `lwr auth login` to set an API key.', cause?: unknown) {
    super({
      message: 'No API key configured for the active profile.',
      code: ERROR_CODES.AUTH_MISSING,
      exit: EXIT.AUTH,
      hint,
      cause,
    });
  }
}

export class NotFoundError extends LwrError {
  constructor(message: string, hint?: string, cause?: unknown) {
    super({ message, code: ERROR_CODES.NOT_FOUND, exit: EXIT.NOT_FOUND, hint, cause });
  }
}

export class NetworkError extends LwrError {
  constructor(
    message: string,
    code: ErrorCode = ERROR_CODES.NETWORK_TIMEOUT,
    hint?: string,
    cause?: unknown,
  ) {
    super({ message, code, exit: EXIT.NETWORK, hint, cause });
  }
}

export class RateLimitError extends LwrError {
  constructor(message = 'Rate limited by Redmine.', hint?: string, cause?: unknown) {
    super({ message, code: ERROR_CODES.RATE_LIMITED, exit: EXIT.NETWORK, hint, cause });
  }
}

export class ServerError extends LwrError {
  constructor(message: string, hint?: string, cause?: unknown) {
    super({ message, code: ERROR_CODES.SERVER_ERROR, exit: EXIT.SERVER, hint, cause });
  }
}

export class ConfigError extends LwrError {
  constructor(
    message: string,
    code: ErrorCode = ERROR_CODES.CONFIG_MALFORMED,
    hint?: string,
    cause?: unknown,
  ) {
    super({ message, code, exit: EXIT.CONFIG, hint, cause });
  }
}

export class ValidationError extends LwrError {
  constructor(
    message: string,
    code: ErrorCode = ERROR_CODES.VALIDATION_BAD_VALUE,
    hint?: string,
    cause?: unknown,
  ) {
    super({ message, code, exit: EXIT.VALIDATION, hint, cause });
  }
}

export class TuiRequiresTtyError extends LwrError {
  constructor(hint = 'Run `lwr dash` from an interactive terminal.', cause?: unknown) {
    super({
      message: 'Interactive TUI requires a TTY.',
      code: ERROR_CODES.TUI_REQUIRES_TTY,
      exit: EXIT.USER,
      hint,
      cause,
    });
  }
}

export class InternalError extends LwrError {
  constructor(message: string, cause?: unknown) {
    super({
      message,
      code: ERROR_CODES.INTERNAL,
      exit: EXIT.INTERNAL,
      hint: 'This is likely a bug in lwr. Please report it.',
      cause,
    });
  }
}

/**
 * Map an Axios-style HTTP failure to a typed LwrError.
 *
 * Accepts the bare failure shape we need rather than importing Axios types,
 * so this stays usable from tests and from non-axios code paths.
 */
export interface HttpFailure {
  status?: number;
  /** Redmine error body — typically `{ errors: string[] }` for 422. */
  body?: unknown;
  /** Original error for debugging. */
  cause?: unknown;
  /** Resource hint, e.g. "issue 121204". */
  resource?: string;
  /** A network-layer code, e.g. 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'. */
  networkCode?: string;
}

export function fromHttpFailure(f: HttpFailure): LwrError {
  // No HTTP status → network layer
  if (f.status === undefined) {
    switch (f.networkCode) {
      case 'ECONNREFUSED':
        return new NetworkError(
          'Connection refused.',
          ERROR_CODES.NETWORK_REFUSED,
          'Check that the Redmine base URL is correct and reachable.',
          f.cause,
        );
      case 'ENOTFOUND':
        return new NetworkError(
          'Host not found (DNS).',
          ERROR_CODES.NETWORK_DNS,
          'Verify the host in your config and your network connection.',
          f.cause,
        );
      case 'ETIMEDOUT':
      case 'ECONNABORTED':
        return new NetworkError(
          'Request timed out.',
          ERROR_CODES.NETWORK_TIMEOUT,
          'Try again, or raise the timeout via config.',
          f.cause,
        );
      default:
        return new NetworkError(
          'Network error.',
          ERROR_CODES.NETWORK_TIMEOUT,
          undefined,
          f.cause,
        );
    }
  }

  switch (f.status) {
    case 401:
      return new AuthError(
        'Unauthorized — API key missing or rejected.',
        'Run `lwr auth login` to refresh your API key.',
        f.cause,
      );
    case 403:
      return new LwrError({
        message: 'Forbidden — your account cannot perform this action.',
        code: ERROR_CODES.AUTH_FORBIDDEN,
        exit: EXIT.AUTH,
        hint: 'Check project membership and role permissions in Redmine.',
        cause: f.cause,
      });
    case 404:
      return new NotFoundError(
        f.resource ? `${f.resource} not found.` : 'Resource not found.',
        undefined,
        f.cause,
      );
    case 422: {
      const detail = extract422Detail(f.body);
      return new ValidationError(
        detail ?? 'Redmine rejected the request (422).',
        ERROR_CODES.VALIDATION_API_REJECTED,
        'Check required fields, allowed status transitions, and project visibility.',
        f.cause,
      );
    }
    case 429:
      return new RateLimitError(
        'Rate limited by Redmine.',
        'Slow down or retry in a moment.',
        f.cause,
      );
    default:
      if (f.status >= 500) {
        return new ServerError(
          `Redmine server error (${f.status}).`,
          'Retry shortly. If it persists, check the Redmine instance.',
          f.cause,
        );
      }
      return new LwrError({
        message: `Unexpected HTTP ${f.status} from Redmine.`,
        code: ERROR_CODES.INTERNAL,
        exit: EXIT.INTERNAL,
        hint: undefined,
        cause: f.cause,
      });
  }
}

function extract422Detail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.every(e => typeof e === 'string')) {
    return errors.join('; ');
  }
  return undefined;
}

/** Normalise any thrown value into an LwrError. */
export function asLwrError(err: unknown): LwrError {
  if (err instanceof LwrError) return err;
  if (err instanceof Error) return new InternalError(err.message, err);
  return new InternalError(String(err));
}

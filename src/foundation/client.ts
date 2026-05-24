/**
 * Axios factory for talking to a Redmine instance.
 *
 * - Adds `X-Redmine-API-Key` header per request
 * - Retries idempotent failures (network + 5xx + 429) with exponential
 *   backoff using `axios-retry`
 * - Maps every failure into a typed `LwrError` via `fromHttpFailure`
 *
 * The factory is profile-aware: callers pass the resolved profile +
 * apiKey rather than re-resolving them. This keeps the client stateless
 * and easy to test.
 */

import axios, { type AxiosInstance, type AxiosError, isAxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { HTTP_TIMEOUT_MS, HTTP_RETRY_COUNT, HTTP_RETRY_BASE_MS } from '../constants';
import { fromHttpFailure } from './errors';
import { logger } from './logger';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Override for tests. */
  timeoutMs?: number;
}

export type RedmineClient = AxiosInstance;

export function createClient(opts: ClientOptions): RedmineClient {
  const client = axios.create({
    baseURL: opts.baseUrl,
    timeout: opts.timeoutMs ?? HTTP_TIMEOUT_MS,
    headers: {
      'X-Redmine-API-Key': opts.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'lwr-cli',
    },
    // We handle 4xx/5xx ourselves through the response interceptor.
    validateStatus: () => true,
  });

  axiosRetry(client, {
    retries: HTTP_RETRY_COUNT,
    retryDelay: retryCount => HTTP_RETRY_BASE_MS * Math.pow(2, retryCount - 1),
    retryCondition: err => {
      if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
      const status = err.response?.status;
      if (status === 429) return true;
      if (status !== undefined && status >= 500 && status <= 599) return true;
      return false;
    },
    onRetry: (count, err) => {
      logger.debug(`retry ${count}: ${err.message}`);
    },
  });

  client.interceptors.request.use(req => {
    logger.debug(`→ ${(req.method ?? 'GET').toUpperCase()} ${req.url ?? ''}`);
    return req;
  });

  client.interceptors.response.use(res => {
    const status = res.status;
    if (status >= 200 && status < 300) {
      logger.debug(`← ${status} ${res.config.url ?? ''}`);
      return res;
    }
    // Convert non-2xx into a typed LwrError using the shared mapper.
    const fail = fromHttpFailure({
      status,
      body: res.data,
      cause: undefined,
      resource: extractResourceHint(res.config?.url),
    });
    throw fail;
  });

  return client;
}

/**
 * Wrap an axios call so any axios error / network error is normalised.
 * Use this in api/* wrappers — it lets the caller `try/catch (LwrError)`.
 */
export async function http<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAxiosError(err)) throw fromAxiosError(err);
    throw err; // already an LwrError, or something else we want to bubble
  }
}

function fromAxiosError(err: AxiosError): ReturnType<typeof fromHttpFailure> {
  return fromHttpFailure({
    status: err.response?.status,
    body: err.response?.data,
    cause: err,
    resource: extractResourceHint(err.config?.url),
    networkCode: typeof err.code === 'string' ? err.code : undefined,
  });
}

function extractResourceHint(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // E.g. "/issues/121204.json" → "issue 121204"
  const issueMatch = /\/issues\/(\d+)/.exec(url);
  if (issueMatch) return `issue ${issueMatch[1]}`;
  const projectMatch = /\/projects\/([^/.]+)/.exec(url);
  if (projectMatch) return `project ${projectMatch[1]}`;
  return undefined;
}

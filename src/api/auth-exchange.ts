/**
 * Exchange username + password for the user's API key.
 *
 * Redmine returns `user.api_key` on `GET /users/current.json` only when the
 * request authenticates with HTTP Basic auth (username/password). This is
 * the canonical way to bootstrap an API key without making the user dig
 * through the My Account page.
 *
 * We never persist the password — only the resulting api_key.
 */

import axios, { isAxiosError } from 'axios';
import { REDMINE_PATHS, HTTP_TIMEOUT_MS } from '../constants';
import { ConfigError, fromHttpFailure } from '../foundation/errors';
import type { RedmineUser } from './types';

export interface ExchangeOptions {
  baseUrl: string;
  username: string;
  password: string;
}

export interface ExchangeResult {
  apiKey: string;
  user: RedmineUser;
}

export async function exchangeCredsForApiKey(opts: ExchangeOptions): Promise<ExchangeResult> {
  let res;
  try {
    res = await axios.get<{ user: RedmineUser }>(REDMINE_PATHS.CURRENT_USER, {
      baseURL: opts.baseUrl,
      timeout: HTTP_TIMEOUT_MS,
      auth: { username: opts.username, password: opts.password },
      headers: { Accept: 'application/json', 'User-Agent': 'lwr-cli' },
      validateStatus: () => true,
    });
  } catch (err) {
    throw fromHttpFailure({
      networkCode: isAxiosError(err) && typeof err.code === 'string' ? err.code : undefined,
      cause: err,
    });
  }

  if (res.status < 200 || res.status >= 300) {
    throw fromHttpFailure({
      status: res.status,
      body: res.data,
      resource: 'current user',
    });
  }

  const user = res.data?.user;
  if (!user?.api_key) {
    throw new ConfigError(
      'Redmine accepted the password but returned no API key.',
      undefined,
      'Ensure REST API access is enabled (Administration → Settings → API) and that this user has generated an API key in their account page.',
    );
  }

  return { apiKey: user.api_key, user };
}

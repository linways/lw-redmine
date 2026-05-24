/**
 * Session helper: resolve profile + API key + base URL into an axios client.
 *
 * Most commands need exactly this combination; centralising it here keeps
 * commands tiny and ensures the resolution precedence (flag → env → config
 * → constants) is identical everywhere.
 */

import { activeProfile } from './profiles';
import { getApiKey } from './auth';
import { createClient, type RedmineClient } from './client';
import { resolveBaseUrlFromProfile } from './url';
import { loadConfig } from './config';
import type { GlobalFlags } from './run';

export interface Session {
  profileName: string;
  baseUrl: string;
  client: RedmineClient;
}

export async function openSession(flags: GlobalFlags): Promise<Session> {
  const { name, profile } = activeProfile(flags.profile);

  // Centralised resolution: flag → LWR_BASE_URL → profile.baseUrl
  // → config.defaultBaseUrl → DEFAULT_BASE_URL → throw CONFIG_BASE_URL_MISSING.
  // The helper also runs each layer through the allow-list, so a malicious
  // URL stored in any layer is rejected before the client is built.
  const baseUrl = resolveBaseUrlFromProfile({
    flagBaseUrl: flags.baseUrl,
    profile,
    configDefaultBaseUrl: loadConfig().defaultBaseUrl,
  });

  const apiKey = await getApiKey(name, flags.apiKey);

  const client = createClient({ baseUrl, apiKey });
  return { profileName: name, baseUrl, client };
}

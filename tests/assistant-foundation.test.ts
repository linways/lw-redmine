/**
 * Assistant foundation tier — plug-and-play guarantees.
 *
 * Foundation persists a single boolean. As of the cross-agent shared-
 * brain PR (2026-05-12), the flag defaults to `true` so the events
 * observer + preferences apply-path run out-of-the-box for every new
 * agent connecting to lwr. Users can opt out via `lwr assistant disable`.
 *
 * The job of these tests is to pin TWO contracts:
 *
 *   1. The flag round-trips correctly through the persisted config.
 *   2. The disable path still works — a user who turns the assistant
 *      off gets vanilla behaviour (no observer writes, etc.).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  defaultConfig,
} from '../src/foundation/config';
import {
  enableAssistant,
  disableAssistant,
  getAssistantState,
  isAssistantEnabled,
} from '../src/assistant/state';
import { ENV } from '../src/constants';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-assistant-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

describe('assistant foundation: feature flag', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('defaults to enabled when no config file exists', () => {
    expect(isAssistantEnabled()).toBe(true);
    expect(getAssistantState()).toEqual({ enabled: true });
  });

  it('defaultConfig() includes assistant.enabled = true', () => {
    expect(defaultConfig().assistant).toEqual({ enabled: true });
  });

  it('disableAssistant() flips the flag and persists it to disk', () => {
    expect(isAssistantEnabled()).toBe(true);
    const result = disableAssistant();
    expect(result).toEqual({ enabled: false });
    expect(isAssistantEnabled()).toBe(false);
    // Reload directly from disk — proves persistence, not in-memory caching.
    expect(loadConfig().assistant.enabled).toBe(false);
  });

  it('enableAssistant() flips it back to on', () => {
    disableAssistant();
    expect(isAssistantEnabled()).toBe(false);
    enableAssistant();
    expect(isAssistantEnabled()).toBe(true);
    expect(loadConfig().assistant.enabled).toBe(true);
  });

  it('round-trips through disable → enable → disable', () => {
    expect(disableAssistant().enabled).toBe(false);
    expect(enableAssistant().enabled).toBe(true);
    expect(disableAssistant().enabled).toBe(false);
    expect(loadConfig().assistant.enabled).toBe(false);
  });
});

describe('assistant foundation: backward-compatible config schema', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  /**
   * Plug-and-play promise: a config.json written by an older lwr binary
   * (pre-flip) with no `assistant` field must still load cleanly. The
   * new default applies — fresh installs and old configs alike land on
   * `assistant.enabled = true`. The user can opt out anytime.
   */
  it('loads a pre-flip config (no `assistant` field) without erroring', () => {
    const file = path.join(cfgDir, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        activeProfile: '',
        profiles: {},
        ui: { theme: 'auto', color: 'auto', table: 'rounded', markdown: true, images: 'auto' },
        tui: { refreshIntervalMs: 30_000, defaultView: 'inbox' },
      }),
      'utf8',
    );

    const cfg = loadConfig();
    expect(cfg.assistant).toEqual({ enabled: true });
    expect(isAssistantEnabled()).toBe(true);
  });

  it('preserves an explicitly-disabled assistant flag across re-reads', () => {
    disableAssistant();
    const cfgBefore = loadConfig();
    expect(cfgBefore.assistant.enabled).toBe(false);

    const fileBefore = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
    expect(fileBefore).toContain('"assistant"');
    expect(fileBefore).toContain('"enabled": false');
  });
});

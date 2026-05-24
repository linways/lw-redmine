/**
 * Config + profile resolution tests.
 *
 * Each test runs in an isolated tempdir (via $LWR_CONFIG_DIR). Profile
 * resolution honours flag > env > config — exercised explicitly here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  updateConfig,
  type Me,
  type Profile,
} from '../src/foundation/config';
import {
  activeProfile,
  getProfile,
  resolveProfileName,
  useProfile,
  removeProfile,
} from '../src/foundation/profiles';
import { ConfigError } from '../src/foundation/errors';

let tmpDir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-test-'));
  process.env.LWR_CONFIG_DIR = tmpDir;
  delete process.env.LWR_PROFILE;
  delete process.env.LWR_API_KEY;
});

afterEach(() => {
  process.env = { ...origEnv };
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Test fixtures ---------------------------------------------------------

/**
 * A schema-valid `Me` block. Tests construct profiles inline rather than
 * going through `buildMeProfile` (which would need a Redmine to talk to).
 */
function mockMe(overrides: Partial<Me> = {}): Me {
  return {
    user: { id: 42, login: 'jdoe', name: 'Jane Doe' },
    roles: ['developer'],
    fieldMap: { developer: { cfId: 79, name: 'Developer' } },
    memberships: [],
    detectedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

function mockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    baseUrl: 'https://redmine.example',
    me: mockMe(),
    ...overrides,
  };
}

/** Convenience: write a valid config with one or more named profiles. */
function seedConfig(profiles: Record<string, Profile>, activeName: string): void {
  saveConfig({ ...defaultConfig(), activeProfile: activeName, profiles });
}

// --- loadConfig / defaults --------------------------------------------------

describe('loadConfig', () => {
  it('returns the empty pre-login state when the file is missing', () => {
    const cfg = loadConfig();
    expect(cfg.activeProfile).toBe('');
    expect(cfg.profiles).toEqual({});
  });

  it('round-trips through saveConfig', () => {
    const orig = { ...defaultConfig(), activeProfile: 'p1', profiles: { p1: mockProfile() } };
    saveConfig(orig);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
    const back = loadConfig();
    expect(back).toEqual(orig);
  });

  it('throws ConfigError on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ not json }');
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('throws ConfigError when schema validation fails', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ version: 99 }));
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('rejects a profile that has no `me` block', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        version: 1,
        activeProfile: 'p1',
        profiles: { p1: { baseUrl: 'https://x.example' } },
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('rejects a profile whose `me.roles` is empty', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        version: 1,
        activeProfile: 'p1',
        profiles: { p1: mockProfile({ me: mockMe({ roles: [] }) }) },
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('rejects a profile whose `me.roles` lists a role with no fieldMap entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        version: 1,
        activeProfile: 'p1',
        profiles: {
          p1: mockProfile({
            me: mockMe({
              roles: ['developer', 'tester'],
              // tester is in roles[] but missing from fieldMap → reject.
              fieldMap: { developer: { cfId: 79, name: 'Developer' } },
            }),
          }),
        },
      }),
    );
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('accepts a profile with multiple roles each bound in fieldMap', () => {
    seedConfig(
      {
        p1: mockProfile({
          me: mockMe({
            roles: ['developer', 'tester'],
            fieldMap: {
              developer: { cfId: 79, name: 'Developer' },
              tester: { cfId: 88, name: 'Tester' },
            },
          }),
        }),
      },
      'p1',
    );
    const cfg = loadConfig();
    expect(cfg.profiles.p1.me.roles).toEqual(['developer', 'tester']);
    expect(cfg.profiles.p1.me.fieldMap.tester?.cfId).toBe(88);
  });

  it('updateConfig applies the transformer atomically', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    updateConfig(cfg => ({
      ...cfg,
      activeProfile: 'staging',
      profiles: { ...cfg.profiles, staging: mockProfile({ baseUrl: 'https://s.example' }) },
    }));
    const after = loadConfig();
    expect(after.activeProfile).toBe('staging');
    expect(after.profiles.staging.baseUrl).toBe('https://s.example');
  });

  it('saveConfig writes the file with mode 0600', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    const stat = fs.statSync(path.join(tmpDir, 'config.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// --- resolveProfileName ----------------------------------------------------

describe('resolveProfileName — precedence', () => {
  beforeEach(() => {
    seedConfig({ 'cfg-active': mockProfile({ baseUrl: 'https://from-cfg.example' }) }, 'cfg-active');
  });

  it('flag wins over env and config', () => {
    process.env.LWR_PROFILE = 'env-profile';
    expect(resolveProfileName('flag-profile')).toBe('flag-profile');
  });

  it('env wins over config when no flag', () => {
    process.env.LWR_PROFILE = 'env-profile';
    expect(resolveProfileName()).toBe('env-profile');
  });

  it('falls back to active profile in config', () => {
    expect(resolveProfileName()).toBe('cfg-active');
  });

  it('empty-string flag does not override env', () => {
    process.env.LWR_PROFILE = 'env-profile';
    expect(resolveProfileName('')).toBe('env-profile');
  });

  it('throws CONFIG_PROFILE_MISSING when nothing is configured (pre-login state)', () => {
    // No config file exists in this scenario; defaults to empty active profile.
    fs.rmSync(path.join(tmpDir, 'config.json'));
    expect(() => resolveProfileName()).toThrow(ConfigError);
  });
});

// --- profile CRUD ----------------------------------------------------------

describe('profile CRUD', () => {
  it('useProfile errors when name not found', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    expect(() => useProfile('nope')).toThrow(ConfigError);
  });

  it('removeProfile refuses to delete the active one', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    expect(() => removeProfile('p1')).toThrow(ConfigError);
  });

  it('removeProfile errors when name not found', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    expect(() => removeProfile('nope')).toThrow(ConfigError);
  });

  it('getProfile throws ConfigError on missing profile', () => {
    seedConfig({ p1: mockProfile() }, 'p1');
    expect(() => getProfile('nope')).toThrow(ConfigError);
  });

  it('activeProfile returns the resolved profile', () => {
    seedConfig(
      {
        p1: mockProfile({
          baseUrl: 'https://p1.example',
          activeProject: {
            id: 51,
            identifier: 'linways-ams-v4',
            name: 'Linways AMS V4',
            setAt: '2026-05-09T00:00:00.000Z',
          },
        }),
      },
      'p1',
    );
    const { name, profile } = activeProfile();
    expect(name).toBe('p1');
    expect(profile.baseUrl).toBe('https://p1.example');
    expect(profile.activeProject?.identifier).toBe('linways-ams-v4');
    expect(profile.me.user.id).toBe(42);
  });

  it('persists memberships on the me block round-trip', () => {
    seedConfig(
      {
        p1: mockProfile({
          me: mockMe({
            memberships: [
              { projectId: 51, identifier: 'linways-ams-v4', name: 'Linways AMS V4', roles: ['Developer'] },
              { projectId: 12, identifier: 'cht-examination', name: 'CHT - Examination', roles: ['Developer', 'Member'] },
            ],
          }),
        }),
      },
      'p1',
    );
    const { profile } = activeProfile();
    expect(profile.me.memberships).toHaveLength(2);
    expect(profile.me.memberships[0].identifier).toBe('linways-ams-v4');
    expect(profile.me.memberships[1].roles).toEqual(['Developer', 'Member']);
  });
});

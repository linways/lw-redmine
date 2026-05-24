import { describe, expect, it } from 'vitest';
import { scrubbedEnv } from '../src/mcp/dispatch';

describe('scrubbedEnv', () => {
  it('passes through LWR_* namespace', () => {
    const out = scrubbedEnv({
      LWR_CONFIG_DIR: '/tmp/lwr',
      LWR_DEBUG: '1',
      LWR_BASE_URL: 'https://redmine.example.com',
    });
    expect(out).toMatchObject({
      LWR_CONFIG_DIR: '/tmp/lwr',
      LWR_DEBUG: '1',
      LWR_BASE_URL: 'https://redmine.example.com',
    });
  });

  it('passes through standard Unix env (HOME, PATH, USER, TMPDIR)', () => {
    const out = scrubbedEnv({
      HOME: '/home/u',
      PATH: '/usr/bin',
      USER: 'u',
      TMPDIR: '/tmp',
    });
    expect(out).toMatchObject({ HOME: '/home/u', PATH: '/usr/bin', USER: 'u', TMPDIR: '/tmp' });
  });

  it('passes through locale (LANG, LC_ALL, LC_*) and terminal (TERM, NO_COLOR)', () => {
    const out = scrubbedEnv({
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_TIME: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    });
    expect(Object.keys(out).sort()).toEqual(['LANG', 'LC_ALL', 'LC_TIME', 'NO_COLOR', 'TERM']);
  });

  it('drops unrelated secrets (AWS, GitHub, GCP)', () => {
    const out = scrubbedEnv({
      HOME: '/home/u',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'ghp_...',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/gcp.json',
      OPENAI_API_KEY: 'sk-...',
    });
    expect(out).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(out).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toHaveProperty('GITHUB_TOKEN');
    expect(out).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
    // But HOME survives.
    expect(out).toHaveProperty('HOME', '/home/u');
  });

  it('drops keys whose value is undefined', () => {
    const out = scrubbedEnv({ HOME: '/home/u', LWR_DEBUG: undefined });
    expect(out).toHaveProperty('HOME');
    expect(out).not.toHaveProperty('LWR_DEBUG');
  });
});

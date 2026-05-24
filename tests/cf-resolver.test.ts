/**
 * Tests for the custom-field setter resolver — `parseCfPair`, `resolveCfKey`,
 * `resolveCfValue`.
 *
 * Pure logic only: the network-touching `resolveCustomFieldPairs` lives behind
 * the `resolveUserId` path and is exercised via the dry-run command tests.
 * Here we mock the user resolver to cover the cf-value pipeline branches
 * (numeric, raw:, id:, user-resolved fallback, literal fallback).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV } from '../src/constants';
import { parseCfPair, resolveCfKey, resolveCfValue, resolveCustomFieldPairs } from '../src/foundation/cf-resolver';
import { recordCustomFields } from '../src/foundation/cache';
import { LwrError, ValidationError } from '../src/foundation/errors';
import { ERROR_CODES } from '../src/constants';

// Mock the user resolver — we drive each branch by controlling what it returns.
vi.mock('../src/api/users', () => ({
  resolveUserId: vi.fn(),
}));
import { resolveUserId } from '../src/api/users';

const mockResolveUserId = vi.mocked(resolveUserId);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-cf-test-'));
}

describe('parseCfPair', () => {
  it('splits at the first =', () => {
    expect(parseCfPair('Tester=Alex Biju')).toEqual({ key: 'Tester', value: 'Alex Biju' });
  });

  it('preserves additional = inside the value', () => {
    expect(parseCfPair('URL=https://x.io?a=1&b=2')).toEqual({ key: 'URL', value: 'https://x.io?a=1&b=2' });
  });

  it('trims outer whitespace on key and value', () => {
    expect(parseCfPair('  Tester  =  Alex Biju  ')).toEqual({ key: 'Tester', value: 'Alex Biju' });
  });

  it('rejects missing =', () => {
    expect(() => parseCfPair('Tester')).toThrow(ValidationError);
    expect(() => parseCfPair('Tester')).toThrow(/Bad --cf value/);
  });

  it('rejects an = with no key (pre-trim strips whitespace, so leading-= is caught here)', () => {
    expect(() => parseCfPair('=Alex')).toThrow(/Bad --cf value/);
    expect(() => parseCfPair('   =Alex')).toThrow(/Bad --cf value/);
  });

  it('rejects empty value', () => {
    expect(() => parseCfPair('Tester=')).toThrow(/empty value/);
    expect(() => parseCfPair('Tester=   ')).toThrow(/empty value/);
  });
});

describe('resolveCfKey', () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = tmpDir();
    prevEnv = process.env[ENV.CONFIG_DIR];
    process.env[ENV.CONFIG_DIR] = dir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV.CONFIG_DIR];
    else process.env[ENV.CONFIG_DIR] = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('short-circuits a numeric key to that id', () => {
    expect(resolveCfKey('88')).toEqual({ id: 88 });
    expect(resolveCfKey('79')).toEqual({ id: 79 });
  });

  it('rejects numeric ids outside 1..10000', () => {
    expect(() => resolveCfKey('0')).toThrow(/out of range/);
    expect(() => resolveCfKey('10001')).toThrow(/out of range/);
  });

  it('looks up by name in the opportunistic catalog (case-insensitive)', () => {
    recordCustomFields([
      { id: 88, name: 'Tester' },
      { id: 79, name: 'Developer' },
      { id: 94, name: 'Assigned Team' },
    ]);
    expect(resolveCfKey('Tester').id).toBe(88);
    expect(resolveCfKey('tester').id).toBe(88);
    expect(resolveCfKey('DEVELOPER').id).toBe(79);
    expect(resolveCfKey('Assigned Team').id).toBe(94);
  });

  it('returns the matched cf entry for source reporting', () => {
    recordCustomFields([{ id: 88, name: 'Tester' }]);
    const r = resolveCfKey('tester');
    expect(r.matched?.name).toBe('Tester');
    expect(r.matched?.id).toBe(88);
  });

  it('throws VALIDATION_CF_NOT_FOUND with the known list when name misses', () => {
    recordCustomFields([
      { id: 88, name: 'Tester' },
      { id: 79, name: 'Developer' },
    ]);
    try {
      resolveCfKey('Reviewer');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LwrError);
      const e = err as LwrError;
      expect(e.code).toBe(ERROR_CODES.VALIDATION_CF_NOT_FOUND);
      expect(e.details?.query).toBe('Reviewer');
      expect((e.details?.known as { name: string }[]).map(k => k.name)).toEqual(
        expect.arrayContaining(['Tester', 'Developer']),
      );
    }
  });

  it('hints to fetch an issue first when the catalog is empty', () => {
    try {
      resolveCfKey('Tester');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LwrError).hint).toMatch(/Catalog is empty/);
    }
  });
});

describe('resolveCfValue', () => {
  const client = {} as never;

  beforeEach(() => {
    mockResolveUserId.mockReset();
  });

  it('strips raw: prefix and passes value through', async () => {
    const r = await resolveCfValue(client, 'raw:Some Literal', { issueId: 1 });
    expect(r).toEqual({ value: 'Some Literal', source: 'raw-prefix' });
    expect(mockResolveUserId).not.toHaveBeenCalled();
  });

  it('strips id: prefix and parses a numeric remainder as a number', async () => {
    const r = await resolveCfValue(client, 'id:42', { issueId: 1 });
    expect(r).toEqual({ value: 42, source: 'id-prefix' });
    expect(mockResolveUserId).not.toHaveBeenCalled();
  });

  it('passes id: with a non-numeric remainder through as a string', async () => {
    const r = await resolveCfValue(client, 'id:abc', { issueId: 1 });
    expect(r).toEqual({ value: 'abc', source: 'id-prefix' });
  });

  it('passes pure integers through as numbers without resolving', async () => {
    const r = await resolveCfValue(client, '42', { issueId: 1 });
    expect(r).toEqual({ value: 42, source: 'numeric' });
    expect(mockResolveUserId).not.toHaveBeenCalled();
  });

  it('runs the user resolver on a name and uses the resolved id', async () => {
    mockResolveUserId.mockResolvedValueOnce({ id: 57, name: 'Alex Biju', source: 'project-members' });
    const r = await resolveCfValue(client, 'Alex Biju', { issueId: 1 });
    expect(r).toEqual({ value: 57, source: 'user-resolved' });
    expect(mockResolveUserId).toHaveBeenCalledWith(client, 'Alex Biju', { issueId: 1, projectId: undefined });
  });

  it('falls back to literal string when no user matches', async () => {
    mockResolveUserId.mockRejectedValueOnce(
      new LwrError({
        message: 'no match',
        code: ERROR_CODES.VALIDATION_USER_NOT_FOUND,
        exit: 7,
      }),
    );
    const r = await resolveCfValue(client, 'Mobile', { issueId: 1 });
    expect(r).toEqual({ value: 'Mobile', source: 'literal' });
  });

  it('re-throws on ambiguous user', async () => {
    mockResolveUserId.mockRejectedValueOnce(
      new LwrError({
        message: 'ambiguous',
        code: ERROR_CODES.VALIDATION_AMBIGUOUS_USER,
        exit: 7,
        details: { candidates: [] },
      }),
    );
    await expect(resolveCfValue(client, 'Alex', { issueId: 1 })).rejects.toThrow(/ambiguous/);
  });

  it('treats `none` as the literal token (resolveUserId returns source=none)', async () => {
    mockResolveUserId.mockResolvedValueOnce({ id: -1, name: '(none)', source: 'none' });
    const r = await resolveCfValue(client, 'none', { issueId: 1 });
    expect(r).toEqual({ value: 'none', source: 'literal' });
  });
});

describe('resolveCustomFieldPairs', () => {
  const client = {} as never;
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    mockResolveUserId.mockReset();
    dir = tmpDir();
    prevEnv = process.env[ENV.CONFIG_DIR];
    process.env[ENV.CONFIG_DIR] = dir;
    recordCustomFields([
      { id: 88, name: 'Tester' },
      { id: 79, name: 'Developer' },
    ]);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV.CONFIG_DIR];
    else process.env[ENV.CONFIG_DIR] = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no pairs are passed', async () => {
    expect(await resolveCustomFieldPairs(client, [], { issueId: 1 })).toEqual([]);
  });

  it('resolves a name-by-name pair end-to-end', async () => {
    mockResolveUserId.mockResolvedValueOnce({ id: 57, name: 'Alex Biju', source: 'project-members' });
    const out = await resolveCustomFieldPairs(client, ['Tester=Alex Biju'], { issueId: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 88,
      value: 57,
      raw: 'Tester=Alex Biju',
      source: 'user-resolved',
    });
    expect(out[0].matchedCf?.name).toBe('Tester');
  });

  it('rejects duplicate cf ids in the same call', async () => {
    mockResolveUserId.mockResolvedValue({ id: 57, name: 'X', source: 'project-members' });
    await expect(
      resolveCustomFieldPairs(client, ['Tester=Alex', '88=42'], { issueId: 1 }),
    ).rejects.toThrow(/Duplicate --cf id: 88/);
  });

  it('mixes numeric ids, name lookups, and raw: in one call', async () => {
    mockResolveUserId.mockResolvedValueOnce({ id: 57, name: 'Alex', source: 'project-members' });
    const out = await resolveCustomFieldPairs(
      client,
      ['Developer=42', 'Tester=Alex', '99=raw:Frozen Literal'],
      { issueId: 1 },
    );
    expect(out).toEqual([
      expect.objectContaining({ id: 79, value: 42, source: 'numeric' }),
      expect.objectContaining({ id: 88, value: 57, source: 'user-resolved' }),
      expect.objectContaining({ id: 99, value: 'Frozen Literal', source: 'raw-prefix' }),
    ]);
  });
});

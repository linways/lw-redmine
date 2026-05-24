/**
 * Tests for the parsing helpers exposed by `commands/issue/list`.
 *
 * The lens-resolution path needs an active profile + Redmine, so it's
 * exercised via the full command in integration tests; here we only cover
 * the pure validators (`parseCfFlags`).
 */

import { describe, expect, it } from 'vitest';
import {
  parseCfFlags,
  parseExcludeStatus,
  shouldApplyDoneFilter,
  applyStatusPostFilter,
} from '../src/commands/issue/list';
import { ValidationError } from '../src/foundation/errors';
import type { RedmineIssue } from '../src/api/types';

function issueWithStatus(name: string, id = 100): RedmineIssue {
  return {
    id,
    subject: `subj-${id}`,
    project: { id: 1, name: 'P1' },
    tracker: { id: 1, name: 'Bug' },
    status: { id: 1, name },
    priority: { id: 4, name: 'Normal' },
    author: { id: 1, name: 'A' },
    created_on: '2026-01-01T00:00:00Z',
    updated_on: '2026-05-23T00:00:00Z',
  };
}

describe('parseCfFlags', () => {
  it('returns an empty map when no flags are passed', () => {
    expect(parseCfFlags(undefined)).toEqual({});
    expect(parseCfFlags([])).toEqual({});
  });

  it('parses a single key=value pair', () => {
    expect(parseCfFlags(['79=57'])).toEqual({ 79: '57' });
  });

  it('parses multiple flags, last write wins for duplicate keys', () => {
    expect(parseCfFlags(['79=57', '88=42', '79=99'])).toEqual({ 79: '99', 88: '42' });
  });

  it('preserves non-numeric values as strings', () => {
    // Some cf values are strings (text fields); we don't assume numeric.
    expect(parseCfFlags(['132=All institutions'])).toEqual({ 132: 'All institutions' });
  });

  it('trims surrounding whitespace on the entry but not within the value', () => {
    expect(parseCfFlags(['  79=57  '])).toEqual({ 79: '57' });
    expect(parseCfFlags(['132=A b c'])).toEqual({ 132: 'A b c' });
  });

  it('throws ValidationError on malformed entries', () => {
    expect(() => parseCfFlags(['junk'])).toThrow(ValidationError);
    expect(() => parseCfFlags(['=57'])).toThrow(ValidationError);
    expect(() => parseCfFlags(['abc=57'])).toThrow(ValidationError);
    expect(() => parseCfFlags(['79='])).toThrow(ValidationError);
  });

  it('error message includes the canonical flag form', () => {
    try {
      parseCfFlags(['junk']);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).hint).toMatch(/--cf <cfId>=<value>/);
    }
  });

  it('accepts ids up to the 10000 cap', () => {
    expect(parseCfFlags(['10000=ok'])).toEqual({ 10000: 'ok' });
  });

  it('rejects --cf ids above the 10000 cap (L6)', () => {
    expect(() => parseCfFlags(['10001=x'])).toThrow(ValidationError);
    expect(() => parseCfFlags(['99999999=x'])).toThrow(/out of range/);
  });

  it('rejects --cf id of 0 (and lower) — Redmine ids are positive', () => {
    expect(() => parseCfFlags(['0=x'])).toThrow(/out of range/);
  });
});

describe('parseExcludeStatus', () => {
  it('returns [] for undefined/empty', () => {
    expect(parseExcludeStatus(undefined)).toEqual([]);
    expect(parseExcludeStatus('')).toEqual([]);
    expect(parseExcludeStatus('   ')).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseExcludeStatus('Foo, Bar ,Baz')).toEqual(['Foo', 'Bar', 'Baz']);
  });

  it('drops empty segments from trailing commas', () => {
    expect(parseExcludeStatus('Foo,,Bar,')).toEqual(['Foo', 'Bar']);
  });
});

describe('shouldApplyDoneFilter', () => {
  it('is on by default when --status is unset', () => {
    expect(shouldApplyDoneFilter({})).toBe(true);
  });

  it('is on when --status open is passed explicitly', () => {
    expect(shouldApplyDoneFilter({ status: 'open' })).toBe(true);
    expect(shouldApplyDoneFilter({ status: 'OPEN' })).toBe(true);
    expect(shouldApplyDoneFilter({ status: '  open  ' })).toBe(true);
  });

  it('is off when --include-done is passed (always wins)', () => {
    expect(shouldApplyDoneFilter({ includeDone: true })).toBe(false);
    expect(shouldApplyDoneFilter({ status: 'open', includeDone: true })).toBe(false);
  });

  it('is off when --status names a specific status (Redmine semantic respected)', () => {
    expect(shouldApplyDoneFilter({ status: 'Resolved' })).toBe(false);
    expect(shouldApplyDoneFilter({ status: 'closed' })).toBe(false);
    expect(shouldApplyDoneFilter({ status: '*' })).toBe(false);
    expect(shouldApplyDoneFilter({ status: '5' })).toBe(false);
  });
});

describe('applyStatusPostFilter', () => {
  const newIssue = issueWithStatus('New', 1);
  const inProg = issueWithStatus('Development in Progress', 2);
  const resolved = issueWithStatus('Resolved', 3);
  const closed = issueWithStatus('Closed', 4);
  const devCompleted = issueWithStatus('Development Completed', 5);

  it('drops EFFECTIVELY_DONE status names when the done filter is active', () => {
    const result = applyStatusPostFilter(
      [newIssue, resolved, inProg, closed],
      { doneFilterActive: true, userExclusions: [] },
    );
    expect(result.kept.map(i => i.id)).toEqual([1, 2]);
    expect(result.droppedNames).toEqual(['Resolved', 'Closed']);
  });

  it('matches done-status names case-insensitively', () => {
    const lowerResolved = issueWithStatus('resolved', 6);
    const result = applyStatusPostFilter(
      [lowerResolved],
      { doneFilterActive: true, userExclusions: [] },
    );
    expect(result.kept).toEqual([]);
    expect(result.droppedNames).toEqual(['resolved']);
  });

  it('keeps done statuses when filter is inactive (--include-done semantic)', () => {
    const result = applyStatusPostFilter(
      [newIssue, resolved, closed],
      { doneFilterActive: false, userExclusions: [] },
    );
    expect(result.kept.map(i => i.id)).toEqual([1, 3, 4]);
    expect(result.droppedNames).toEqual([]);
  });

  it('applies --exclude-status independently of the done filter', () => {
    const result = applyStatusPostFilter(
      [newIssue, devCompleted, inProg],
      { doneFilterActive: false, userExclusions: ['Development Completed'] },
    );
    expect(result.kept.map(i => i.id)).toEqual([1, 2]);
    expect(result.droppedNames).toEqual(['Development Completed']);
  });

  it('user exclusions are case-insensitive', () => {
    const result = applyStatusPostFilter(
      [devCompleted],
      { doneFilterActive: false, userExclusions: ['development completed'] },
    );
    expect(result.kept).toEqual([]);
    expect(result.droppedNames).toEqual(['Development Completed']);
  });

  it('combines done filter + user exclusions', () => {
    const result = applyStatusPostFilter(
      [newIssue, resolved, devCompleted, inProg],
      { doneFilterActive: true, userExclusions: ['Development Completed'] },
    );
    expect(result.kept.map(i => i.id)).toEqual([1, 2]);
    expect(result.droppedNames.sort()).toEqual(['Development Completed', 'Resolved']);
  });

  it('is a no-op when nothing is configured', () => {
    const result = applyStatusPostFilter(
      [newIssue, resolved, closed],
      { doneFilterActive: false, userExclusions: [] },
    );
    expect(result.kept.map(i => i.id)).toEqual([1, 3, 4]);
    expect(result.droppedNames).toEqual([]);
  });
});

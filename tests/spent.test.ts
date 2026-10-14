import { describe, it, expect } from 'vitest';
import { parseSpent, assertSpentAllowed } from '../src/commands/issue/spent';

describe('parseSpent', () => {
  it('returns null when --spent is absent or "none"', () => {
    expect(parseSpent(undefined)).toBeNull();
    expect(parseSpent('none')).toBeNull();
  });

  it('parses minutes, hours, mixed and bare decimals', () => {
    expect(parseSpent('30m')).toBe(0.5);
    expect(parseSpent('1h')).toBe(1);
    expect(parseSpent('1h30m')).toBe(1.5);
    expect(parseSpent('0.25')).toBe(0.25);
    expect(parseSpent(' 2H ')).toBe(2);
  });

  it('rejects empty, zero and malformed values with VALIDATION_BAD_VALUE', () => {
    for (const bad of ['', '0', '0m', '1x', '-1h', 'abc']) {
      expect(() => parseSpent(bad)).toThrowError(expect.objectContaining({ code: 'VALIDATION_BAD_VALUE' }));
    }
  });
});

describe('assertSpentAllowed', () => {
  const issue = {
    id: 1,
    status: { id: 2, name: 'Development in Progress' },
    allowed_statuses: [
      { id: 2, name: 'Development in Progress', is_closed: false },
      { id: 3, name: 'Development Completed', is_closed: false },
      { id: 17, name: 'completed', is_closed: true },
    ],
  } as unknown as Parameters<typeof assertSpentAllowed>[0];

  it('allows an open final status', () => {
    expect(() => assertSpentAllowed(issue, 3)).not.toThrow();
  });

  it('rejects a closed final status before any PUT', () => {
    expect(() => assertSpentAllowed(issue, 17)).toThrowError(expect.objectContaining({ code: 'VALIDATION_BAD_VALUE' }));
  });
});

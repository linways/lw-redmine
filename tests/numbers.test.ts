/**
 * `roundHours` is the load-bearing fix for Redmine's float-precision
 * artifacts. Every hour-bearing field on every public payload flows
 * through it.
 */

import { describe, expect, it } from 'vitest';
import { roundHours } from '../src/foundation/numbers';

describe('roundHours', () => {
  it('rounds typical Redmine float-precision noise to 2 decimals', () => {
    expect(roundHours(2.560000002384186)).toBe(2.56);
    expect(roundHours(3.6500000953674316)).toBe(3.65);
    expect(roundHours(1.100000023841858)).toBe(1.1);
    expect(roundHours(2.059999942779541)).toBe(2.06);
    expect(roundHours(1.4500000476837158)).toBe(1.45);
    expect(roundHours(1.4800000190734863)).toBe(1.48);
  });

  it('preserves whole numbers and clean decimals', () => {
    expect(roundHours(0)).toBe(0);
    expect(roundHours(2)).toBe(2);
    expect(roundHours(2.5)).toBe(2.5);
    expect(roundHours(3.25)).toBe(3.25);
  });

  it('passes null/undefined through (do not synthesize zeros)', () => {
    expect(roundHours(null)).toBeNull();
    expect(roundHours(undefined)).toBeUndefined();
  });

  it('passes non-finite values through', () => {
    // Defensive: NaN/Infinity should never appear, but if they do we
    // don't want to mask the bug with a faked zero.
    expect(Number.isNaN(roundHours(Number.NaN) as number)).toBe(true);
    expect(roundHours(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('rounds half-up at the 2nd decimal', () => {
    expect(roundHours(0.005)).toBe(0.01);
    expect(roundHours(0.014)).toBe(0.01);
    expect(roundHours(0.015)).toBe(0.02);
  });
});

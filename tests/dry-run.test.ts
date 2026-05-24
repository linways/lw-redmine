/**
 * Contract tests for the `dryRunPreview` helper.
 *
 * Per-command flow coverage (the real "no PUT/POST/DELETE was sent"
 * guarantee) lives in the nock-based integration tests. This file just
 * pins the *shape* the helper produces, since every mutating command
 * relies on it producing the same fields in the same order.
 */

import { describe, expect, it } from 'vitest';
import { dryRunPreview } from '../src/foundation/run';

describe('dryRunPreview', () => {
  it('produces the minimal envelope when only method/path/payload are given', () => {
    const p = dryRunPreview({
      method: 'POST',
      path: '/time_entries.json',
      payload: { time_entry: { issue_id: 42, hours: 1.5, activity_id: 9 } },
    });
    expect(p).toEqual({
      dry_run: true,
      method: 'POST',
      path: '/time_entries.json',
      payload: { time_entry: { issue_id: 42, hours: 1.5, activity_id: 9 } },
    });
  });

  it('omits resolved/guards keys when not provided (no synthesized empties)', () => {
    const p = dryRunPreview({ method: 'PUT', path: '/issues/1.json', payload: null });
    expect(p).not.toHaveProperty('resolved');
    expect(p).not.toHaveProperty('guards');
  });

  it('attaches resolved + guards when provided', () => {
    const p = dryRunPreview({
      method: 'PUT',
      path: '/issues/125415.json',
      payload: { issue: { status_id: 78 } },
      resolved: { issueId: 125415, status: { id: 78, name: 'Resolved' } },
      guards: ['workflow.allowed_transition'],
    });
    expect(p.resolved).toEqual({ issueId: 125415, status: { id: 78, name: 'Resolved' } });
    expect(p.guards).toEqual(['workflow.allowed_transition']);
  });

  it('payload accepts null (DELETE has no body)', () => {
    const p = dryRunPreview({
      method: 'DELETE',
      path: '/time_entries/22562.json',
      payload: null,
      resolved: { entryId: 22562, hours: 2.5 },
    });
    expect(p.payload).toBeNull();
    expect(p.method).toBe('DELETE');
  });

  it('preserves dry_run: true as the agent branching signal', () => {
    // Agents should branch on `data.dry_run === true`, not on the absence
    // of an `id` field. Pin this contract.
    const p = dryRunPreview({ method: 'POST', path: '/x', payload: {} });
    expect(p.dry_run).toBe(true);
  });
});

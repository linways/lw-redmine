import { describe, it, expect } from 'vitest';
import { extractHints } from '../src/commands/route';

describe('route extractHints', () => {
  it('pulls issue ids and a normalised duration', () => {
    expect(extractHints('mark 132188 dev completed and log 1h')).toEqual({ issueIds: [132188], spent: '1h' });
    expect(extractHints('log 30 minutes on #111233')).toEqual({ issueIds: [111233], spent: '30m' });
    expect(extractHints('took 1.5 hours on 120001 and 120002')).toEqual({ issueIds: [120001, 120002], spent: '1.5h' });
  });

  it('does not mistake durations for ids, and returns empties when absent', () => {
    expect(extractHints('log 1500 min')).toEqual({ issueIds: [], spent: '1500m' });
    expect(extractHints('update my redmine issue')).toEqual({ issueIds: [], spent: null });
  });
});

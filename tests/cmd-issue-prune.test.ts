/**
 * `lwr issue prune [--before <date>] [--keep <n>]`
 *
 * Four scenarios:
 *   1. `--before <date>` drops dirs older than the cutoff, keeps fresher.
 *   2. `--keep <n>` keeps the N most-recently-touched, drops the rest.
 *   3. `--before` and `--keep` are mutually exclusive.
 *   4. No flags → default 30-day cutoff (newest dirs are always safe).
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { pruneIssue } from '../src/commands/issue/prune';
import { configDir } from '../src/foundation/paths';
import { ISSUES_DIR_NAME, ERROR_CODES } from '../src/constants';

function seedIssueDir(root: string, id: string, mtime: Date): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'issue.json');
  fs.writeFileSync(file, JSON.stringify({ id: Number(id) }));
  fs.utimesSync(file, mtime, mtime);
  return dir;
}

describe('lwr issue prune', () => {
  let fixture: FixtureHandle;
  let issuesRoot: string;

  beforeEach(() => {
    fixture = setupTestProfile();
    issuesRoot = path.join(configDir(), ISSUES_DIR_NAME);
    fs.mkdirSync(issuesRoot, { recursive: true });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('--before drops dirs older than the cutoff', async () => {
    const old1 = new Date('2026-01-01T00:00:00Z');
    const old2 = new Date('2026-02-15T00:00:00Z');
    const fresh = new Date(); // now
    seedIssueDir(issuesRoot, '100', old1);
    seedIssueDir(issuesRoot, '200', old2);
    seedIssueDir(issuesRoot, '300', fresh);

    const { envelope, exitCode } = await runCommandAndCapture(
      pruneIssue as (f: Record<string, unknown>) => Promise<never>,
      { before: '2026-03-01' },
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as {
      removed: { id: string }[];
      kept: { id: string }[];
      cutoff: { mode: string; value: string };
    };
    expect(data.removed.map(r => r.id).sort()).toEqual(['100', '200']);
    expect(data.kept.map(k => k.id)).toEqual(['300']);
    expect(data.cutoff).toEqual({ mode: 'before', value: '2026-03-01' });

    // Disk truth: only #300 survives.
    expect(fs.readdirSync(issuesRoot).sort()).toEqual(['300']);
  });

  it('--keep N retains the N most-recently-touched', async () => {
    seedIssueDir(issuesRoot, '100', new Date('2026-01-01T00:00:00Z'));
    seedIssueDir(issuesRoot, '200', new Date('2026-02-01T00:00:00Z'));
    seedIssueDir(issuesRoot, '300', new Date('2026-03-01T00:00:00Z'));
    seedIssueDir(issuesRoot, '400', new Date('2026-04-01T00:00:00Z'));

    const { envelope, exitCode } = await runCommandAndCapture(
      pruneIssue as (f: Record<string, unknown>) => Promise<never>,
      { keep: 2 },
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as { removed: { id: string }[]; kept: { id: string }[] };
    expect(data.kept.map(k => k.id)).toEqual(['400', '300']); // newest-first
    expect(data.removed.map(r => r.id).sort()).toEqual(['100', '200']);
    expect(fs.readdirSync(issuesRoot).sort()).toEqual(['300', '400']);
  });

  it('rejects --before AND --keep together', async () => {
    seedIssueDir(issuesRoot, '100', new Date('2026-01-01T00:00:00Z'));

    const { envelope, exitCode } = await runCommandAndCapture(
      pruneIssue as (f: Record<string, unknown>) => Promise<never>,
      { before: '2026-02-01', keep: 1 },
    );

    expect(exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as Record<string, unknown>).code).toBe(ERROR_CODES.VALIDATION_BAD_VALUE);
  });

  it('default cutoff (no flags) is 30 days back — recent dirs survive', async () => {
    seedIssueDir(issuesRoot, '300', new Date()); // brand new

    const { envelope, exitCode } = await runCommandAndCapture(
      pruneIssue as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as {
      removed: unknown[];
      kept: { id: string }[];
      cutoff: { mode: string; value: string };
    };
    expect(data.removed).toHaveLength(0);
    expect(data.kept.map(k => k.id)).toEqual(['300']);
    expect(data.cutoff.mode).toBe('before');
  });

  it('skips non-numeric subdirs (defensive)', async () => {
    seedIssueDir(issuesRoot, '100', new Date('2026-01-01T00:00:00Z'));
    // Manually create a junk subdir that isn't a numeric issue id.
    fs.mkdirSync(path.join(issuesRoot, 'README'), { recursive: true });
    fs.writeFileSync(path.join(issuesRoot, 'README', 'note.md'), 'hi');

    const { envelope } = await runCommandAndCapture(
      pruneIssue as (f: Record<string, unknown>) => Promise<never>,
      { before: '2026-12-01' }, // future cutoff — would drop #100
    );
    const data = envelope.data as { removed: { id: string }[] };
    expect(data.removed.map(r => r.id)).toEqual(['100']);
    // README/ survives because the prune only touches numeric dirs.
    expect(fs.existsSync(path.join(issuesRoot, 'README'))).toBe(true);
  });
});

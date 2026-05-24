/**
 * Feedback core + command-layer tests.
 *
 * Phase 1 covers: writeFeedback (write/dry-run/redaction), listFeedback
 * (window + kind filters, newest-first), resolveFeedbackPath (slug,
 * relative path), parseFrontmatter. The verb wrappers in
 * `src/commands/feedback/*` thin-wrap `runCommand` and are exercised
 * via the same payload shape returned from these calls — the JSON
 * `data` field is identical to {@link WriteResult} / {@link ListPayload}
 * / {@link ShowPayload} by construction.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebhookBody,
  listFeedback,
  parseAttemptFlag,
  parseFrontmatter,
  resolveFeedbackPath,
  slugify,
  writeFeedback,
} from '../src/workflow/feedback';
import { feedbackDir } from '../src/foundation/paths';
import { FEEDBACK_WEBHOOK } from '../src/constants';

let tmpDir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-feedback-test-'));
  process.env.LWR_CONFIG_DIR = tmpDir;
  // Disable the webhook by default so the rest of the suite never hits
  // the network. Webhook-specific tests opt in by clearing this var and
  // stubbing global.fetch.
  process.env.LWR_FEEDBACK_NO_WEBHOOK = '1';
});

afterEach(() => {
  process.env = { ...origEnv };
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const FROZEN_AT = new Date('2026-05-11T06:51:32.000Z');

// --- slugify ---------------------------------------------------------------

describe('slugify', () => {
  it('extracts a 2–3 word kebab slug from a free-text query', () => {
    expect(slugify('set Alex Biju as tester')).toBe('alex-biju-tester');
  });

  it('drops common stopwords', () => {
    expect(slugify('rename a sprint to next quarter')).toBe('rename-sprint-next');
  });

  it('falls back to a secondary source when the primary is unhelpful', () => {
    expect(slugify('to me', 'issue.edit')).toBe('issue-edit');
  });

  it('falls back to "incident" when both sources are empty', () => {
    expect(slugify('   ', '   ')).toBe('incident');
  });
});

// --- writeFeedback ---------------------------------------------------------

describe('writeFeedback', () => {
  it('writes a Markdown file under ~/.lwr/feedback/<utc-date>/ with the spec shape', async () => {
    const result = await writeFeedback(
      {
        kind: 'gap',
        query: 'set Alex Biju as tester',
        reason: 'issue.edit has no --cf flag',
        command: 'issue.edit',
        attempts: [
          { action: 'ran lwr issue edit --help', outcome: 'no --cf flag found' },
          { action: 'considered raw curl', outcome: 'stopped per bail-fast contract' },
        ],
        issueContext: 125584,
        agent: 'claude-code',
      },
      { now: FROZEN_AT },
    );

    expect(result.dryRun).toBe(false);
    expect(result.path).toBe('2026-05-11/065132-gap-alex-biju-tester.md');
    expect(result.kind).toBe('gap');
    expect(result.slug).toBe('alex-biju-tester');
    expect(result.recordedAt).toBe('2026-05-11T06:51:32Z');
    expect(result.absolutePath).toBe(
      path.join(feedbackDir(), '2026-05-11', '065132-gap-alex-biju-tester.md'),
    );

    expect(fs.existsSync(result.absolutePath)).toBe(true);
    const content = fs.readFileSync(result.absolutePath, 'utf8');

    // Frontmatter contains every spec-required field.
    expect(content).toMatch(/^---\nschema: lwr-feedback\/v1\n/);
    expect(content).toMatch(/kind: gap/);
    expect(content).toMatch(/recorded_at: 2026-05-11T06:51:32Z/);
    expect(content).toMatch(/agent: claude-code/);
    expect(content).toMatch(/issue_context: 125584/);
    expect(content).toMatch(/command: issue\.edit/);
    expect(content).toMatch(/exit_code: null/);
    expect(content).toMatch(/error_code: null/);

    // Body has the three required sections for a `gap` incident.
    expect(content).toContain('## What the user asked');
    expect(content).toContain('> set Alex Biju as tester');
    expect(content).toContain('## What lwr returned');
    expect(content).toContain('issue.edit has no --cf flag');
    expect(content).toContain('## What the agent tried before bailing');
    expect(content).toContain('action: ran lwr issue edit --help');
    expect(content).toContain('outcome: no --cf flag found');
  });

  it('--dry-run computes the path + slug but writes nothing', async () => {
    const result = await writeFeedback(
      {
        kind: 'gap',
        query: 'rename sprint',
        reason: 'no project.versions edit verb',
      },
      { dryRun: true, now: FROZEN_AT },
    );

    expect(result.dryRun).toBe(true);
    expect(result.path).toBe('2026-05-11/065132-gap-rename-sprint.md');
    expect(fs.existsSync(result.absolutePath)).toBe(false);
    expect(fs.existsSync(feedbackDir())).toBe(false);
  });

  it('redacts JWT-shaped tokens from the query before write', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = await writeFeedback(
      {
        kind: 'gap',
        query: `assign issue using token ${jwt}`,
        reason: 'verb missing',
      },
      { now: FROZEN_AT },
    );

    const content = fs.readFileSync(result.absolutePath, 'utf8');
    expect(content).not.toContain(jwt);
    expect(content).toContain('[REDACTED]');
  });

  it('omits the attempts block for kind=error', async () => {
    const result = await writeFeedback(
      {
        kind: 'error',
        query: 'lwr issue edit 123 --cf "Tester=Alex"',
        reason: 'VALIDATION_CF_NOT_FOUND',
        errorCode: 'VALIDATION_CF_NOT_FOUND',
        exitCode: 7,
      },
      { now: FROZEN_AT },
    );
    const content = fs.readFileSync(result.absolutePath, 'utf8');
    expect(content).toMatch(/kind: error/);
    expect(content).toMatch(/error_code: VALIDATION_CF_NOT_FOUND/);
    expect(content).toMatch(/exit_code: 7/);
    expect(content).not.toContain('## What the agent tried before bailing');
  });

  it('writes mode 0600 (private to the user)', async () => {
    const result = await writeFeedback(
      { kind: 'gap', query: 'foo', reason: 'bar' },
      { now: FROZEN_AT },
    );
    if (process.platform !== 'win32') {
      const mode = fs.statSync(result.absolutePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

// --- listFeedback ----------------------------------------------------------

describe('listFeedback', () => {
  it('returns entries newest-first, filtered by window and kind', async () => {
    await writeFeedback(
      { kind: 'gap', query: 'set tester to Alex', reason: 'no --cf' },
      { now: new Date('2026-05-11T06:51:32Z') },
    );
    await writeFeedback(
      { kind: 'error', query: 'workflow blocked', reason: 'transition not allowed' },
      { now: new Date('2026-05-10T09:12:03Z') },
    );
    await writeFeedback(
      { kind: 'gap', query: 'rename sprint', reason: 'no verb' },
      { now: new Date('2026-05-12T10:30:45Z') },
    );

    const all = listFeedback({ windowDays: null });
    expect(all).toHaveLength(3);
    expect(all[0].slug).toBe('rename-sprint'); // 2026-05-12
    expect(all[1].slug).toBe('tester-alex'); // 2026-05-11
    expect(all[2].slug).toBe('workflow-blocked'); // 2026-05-10

    const onlyGaps = listFeedback({ windowDays: null, kind: 'gap' });
    expect(onlyGaps.map(e => e.slug)).toEqual(['rename-sprint', 'tester-alex']);
  });

  it('shape: each entry exposes path, kind, slug, recorded_at, command, summary', async () => {
    await writeFeedback(
      {
        kind: 'gap',
        query: 'set Alex Biju as tester',
        reason: 'no --cf flag',
        command: 'issue.edit',
      },
      { now: FROZEN_AT },
    );
    const [entry] = listFeedback({ windowDays: null });
    expect(entry).toMatchObject({
      path: '2026-05-11/065132-gap-alex-biju-tester.md',
      kind: 'gap',
      slug: 'alex-biju-tester',
      recordedAt: '2026-05-11T06:51:32Z',
      command: 'issue.edit',
    });
    expect(entry.summary).toContain('set Alex Biju as tester');
  });

  it('returns [] when the feedback dir does not exist yet', () => {
    expect(listFeedback({ windowDays: null })).toEqual([]);
  });
});

// --- resolveFeedbackPath ---------------------------------------------------

describe('resolveFeedbackPath', () => {
  it('resolves a bare slug to the newest matching file', async () => {
    const older = await writeFeedback(
      { kind: 'gap', query: 'set tester', reason: 'no flag' },
      { now: new Date('2026-05-10T06:00:00Z') },
    );
    const newer = await writeFeedback(
      { kind: 'gap', query: 'set tester', reason: 'no flag' },
      { now: new Date('2026-05-12T06:00:00Z') },
    );
    expect(older.slug).toBe('tester');
    expect(newer.slug).toBe('tester');
    const resolved = resolveFeedbackPath('tester');
    expect(resolved).toBe(newer.absolutePath);
  });

  it('resolves a relative path under the feedback dir', async () => {
    const r = await writeFeedback(
      { kind: 'gap', query: 'rename sprint', reason: 'no verb' },
      { now: FROZEN_AT },
    );
    expect(resolveFeedbackPath(r.path)).toBe(r.absolutePath);
  });

  it('returns null for a path that doesn\'t exist', () => {
    expect(resolveFeedbackPath('does-not-exist')).toBeNull();
  });

  it('refuses paths outside the feedback dir', () => {
    // Even if /etc/passwd exists, it must not resolve.
    expect(resolveFeedbackPath('/etc/passwd')).toBeNull();
  });
});

// --- parseFrontmatter ------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses scalars, nulls, ints, and quoted strings', () => {
    const raw = [
      '---',
      'schema: lwr-feedback/v1',
      'kind: gap',
      'recorded_at: 2026-05-11T06:51:32Z',
      'agent: claude-code',
      'issue_context: 125584',
      'command: "issue.edit"',
      'exit_code: null',
      '---',
      '',
      '## What the user asked',
    ].join('\n');
    const fm = parseFrontmatter(raw);
    expect(fm['schema']).toBe('lwr-feedback/v1');
    expect(fm['kind']).toBe('gap');
    expect(fm['recorded_at']).toBe('2026-05-11T06:51:32Z');
    expect(fm['agent']).toBe('claude-code');
    expect(fm['issue_context']).toBe(125584);
    expect(fm['command']).toBe('issue.edit');
    expect(fm['exit_code']).toBeNull();
  });

  it('returns {} when no frontmatter block is present', () => {
    expect(parseFrontmatter('# Just a heading\n\nBody.')).toEqual({});
  });
});

// --- parseAttemptFlag ------------------------------------------------------

describe('parseAttemptFlag', () => {
  it('splits on the first |', () => {
    expect(parseAttemptFlag('ran lwr issue edit --help|no --cf flag')).toEqual({
      action: 'ran lwr issue edit --help',
      outcome: 'no --cf flag',
    });
  });

  it('rejects values missing the separator', () => {
    expect(() => parseAttemptFlag('just an action')).toThrow(/Expected/);
  });

  it('rejects empty action or outcome', () => {
    expect(() => parseAttemptFlag('|something')).toThrow(/non-empty/);
    expect(() => parseAttemptFlag('something|')).toThrow(/non-empty/);
  });
});

// --- buildWebhookBody ------------------------------------------------------

describe('buildWebhookBody', () => {
  it('maps every payload field onto its configured entry id', () => {
    const body = buildWebhookBody(FEEDBACK_WEBHOOK.FIELDS, {
      recordedAt: '2026-05-11T06:51:32Z',
      kind: 'gap',
      slug: 'alex-biju-tester',
      userLogin: 'sibin',
      userName: 'Sibin Baby',
      userRedmineId: 57,
      lwrVersion: '0.1.0',
      profile: 'default',
      agent: 'claude-code',
      issueContext: 125584,
      command: 'issue.edit',
      exitCode: null,
      errorCode: null,
      bodyMd: '---\nschema: lwr-feedback/v1\n---\n\n## What the user asked\n\n> set tester',
    });
    const parsed = new URLSearchParams(body);
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.recorded_at)).toBe('2026-05-11T06:51:32Z');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.kind)).toBe('gap');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.slug)).toBe('alex-biju-tester');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.user_login)).toBe('sibin');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.user_redmine_id)).toBe('57');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.issue_context)).toBe('125584');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.command)).toBe('issue.edit');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.exit_code)).toBe('');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.error_code)).toBe('');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.body_md)).toContain('schema: lwr-feedback/v1');
  });

  it('renders nullable numerics as empty strings (not "null")', () => {
    const body = buildWebhookBody(FEEDBACK_WEBHOOK.FIELDS, {
      recordedAt: '2026-05-11T06:51:32Z',
      kind: 'gap',
      slug: 's',
      userLogin: '',
      userName: '',
      userRedmineId: null,
      lwrVersion: '0.1.0',
      profile: '',
      agent: 'cli',
      issueContext: null,
      command: null,
      exitCode: null,
      errorCode: null,
      bodyMd: '',
    });
    const parsed = new URLSearchParams(body);
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.user_redmine_id)).toBe('');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.issue_context)).toBe('');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.exit_code)).toBe('');
  });
});

// --- Remote-mirror integration --------------------------------------------

describe('writeFeedback remote mirror', () => {
  it('LWR_FEEDBACK_NO_WEBHOOK=1 skips the POST entirely', async () => {
    // beforeEach already sets this; spy on fetch to assert it's never called.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await writeFeedback(
      { kind: 'gap', query: 'no-webhook test', reason: 'should not POST' },
      { now: FROZEN_AT },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.mirror).toBeUndefined();
  });

  it('posts to the form URL and records a successful mirror result', async () => {
    delete process.env.LWR_FEEDBACK_NO_WEBHOOK;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('OK', { status: 200 }) as unknown as Response);

    const result = await writeFeedback(
      { kind: 'gap', query: 'webhook posts a row', reason: 'verify POST path' },
      { now: FROZEN_AT },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe(FEEDBACK_WEBHOOK.FORM_URL);
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body as string;
    const parsed = new URLSearchParams(body);
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.kind)).toBe('gap');
    expect(parsed.get(FEEDBACK_WEBHOOK.FIELDS.slug)).toBe('webhook-posts-row');
    expect(result.mirror).toMatchObject({ posted: true, status: 200 });
  });

  it('on POST failure: local file still written, mirror.posted=false, no throw', async () => {
    delete process.env.LWR_FEEDBACK_NO_WEBHOOK;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await writeFeedback(
      { kind: 'gap', query: 'network failure mode', reason: 'test fallback' },
      { now: FROZEN_AT },
    );

    expect(fs.existsSync(result.absolutePath)).toBe(true);
    expect(result.mirror?.posted).toBe(false);
    expect(result.mirror?.error).toContain('network down');
  });

  it('on non-2xx HTTP: mirror.posted=false, status surfaced', async () => {
    delete process.env.LWR_FEEDBACK_NO_WEBHOOK;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 }) as unknown as Response,
    );

    const result = await writeFeedback(
      { kind: 'gap', query: 'http 403', reason: 'sheet went private' },
      { now: FROZEN_AT },
    );

    expect(result.mirror).toMatchObject({ posted: false, status: 403 });
  });

  it('--dry-run skips the POST', async () => {
    delete process.env.LWR_FEEDBACK_NO_WEBHOOK;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await writeFeedback(
      { kind: 'gap', query: 'dry run skips webhook', reason: 'no side effects' },
      { dryRun: true, now: FROZEN_AT },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.mirror).toBeUndefined();
  });
});

/**
 * Tests for the pure helpers exposed by `workflow/me.ts`.
 *
 * The orchestrator (`buildMeProfile`) needs a Redmine to talk to and the
 * probe-based detector hits the API directly. We cover its components:
 *
 *   - extractCfCatalog: issue list → cf-name → ids[]
 *   - findCfsForRole:    catalog → candidate cfs whose name matches the role pattern
 *   - buildFieldMap:     bind every requested role to a cf id; throw on missing
 */

import { describe, expect, it } from 'vitest';
import {
  extractCfCatalog,
  findCfsForRole,
  buildFieldMap,
  type CfCatalogEntry,
} from '../src/workflow/me';
import { LwrError } from '../src/foundation/errors';
import type { RedmineIssue } from '../src/api/types';
import type { Role } from '../src/foundation/config';

// --- Fixtures --------------------------------------------------------------

function issue(opts: {
  id: number;
  cfs?: { id: number; name: string; value: string | string[] | null }[];
}): RedmineIssue {
  return {
    id: opts.id,
    subject: `issue ${opts.id}`,
    project: { id: 1, name: 'Test' },
    tracker: { id: 1, name: 'Bug' },
    status: { id: 1, name: 'New' },
    priority: { id: 1, name: 'Normal' },
    author: { id: 100, name: 'Author' },
    created_on: '2026-01-01T00:00:00Z',
    updated_on: '2026-01-01T00:00:00Z',
    custom_fields: opts.cfs,
  };
}

function catalog(...entries: { name: string; cfId: number }[]): Map<string, CfCatalogEntry[]> {
  const m = new Map<string, CfCatalogEntry[]>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    const list = m.get(key) ?? [];
    list.push({ cfId: e.cfId, name: e.name });
    m.set(key, list);
  }
  return m;
}

// --- extractCfCatalog ------------------------------------------------------

describe('extractCfCatalog', () => {
  it('builds a name → entry map across multiple issues', () => {
    const issues = [
      issue({ id: 1, cfs: [{ id: 79, name: 'Developer', value: '42' }] }),
      issue({ id: 2, cfs: [{ id: 88, name: 'Tester', value: '42' }] }),
      issue({ id: 3, cfs: [{ id: 79, name: 'Developer', value: '12' }] }),
    ];
    const cat = extractCfCatalog(issues);
    expect(cat.get('developer')).toEqual([{ cfId: 79, name: 'Developer' }]);
    expect(cat.get('tester')).toEqual([{ cfId: 88, name: 'Tester' }]);
  });

  it('returns an empty catalog for issues with no custom_fields', () => {
    const cat = extractCfCatalog([issue({ id: 1 })]);
    expect(cat.size).toBe(0);
  });

  it('records distinct ids when the same cf name binds to different ids', () => {
    const issues = [
      issue({ id: 1, cfs: [{ id: 79, name: 'Developer', value: '42' }] }),
      issue({ id: 2, cfs: [{ id: 99, name: 'Developer', value: '42' }] }),
    ];
    const entries = extractCfCatalog(issues).get('developer');
    expect(entries).toHaveLength(2);
    expect(entries?.map(e => e.cfId).sort()).toEqual([79, 99]);
  });
});

// --- findCfsForRole --------------------------------------------------------

describe('findCfsForRole', () => {
  it('returns the matching cf entry for a role', () => {
    const cat = catalog({ name: 'Developer', cfId: 79 }, { name: 'Tester', cfId: 88 });
    expect(findCfsForRole('developer' as Role, cat)).toEqual([{ cfId: 79, name: 'Developer' }]);
    expect(findCfsForRole('tester' as Role, cat)).toEqual([{ cfId: 88, name: 'Tester' }]);
  });

  it('matches case-insensitively', () => {
    const cat = catalog({ name: 'developer', cfId: 79 });
    expect(findCfsForRole('developer' as Role, cat)).toEqual([{ cfId: 79, name: 'developer' }]);
  });

  it('returns multiple cfs when several share a name pattern', () => {
    const cat = catalog({ name: 'Developer', cfId: 79 }, { name: 'developer', cfId: 99 });
    const matches = findCfsForRole('developer' as Role, cat);
    expect(matches.map(e => e.cfId).sort()).toEqual([79, 99]);
  });

  it('returns empty when no cf matches', () => {
    const cat = catalog({ name: 'College', cfId: 2 });
    expect(findCfsForRole('developer' as Role, cat)).toEqual([]);
  });

  it('matches the QA pattern across "QA" and "Quality Assurance"', () => {
    expect(findCfsForRole('qa' as Role, catalog({ name: 'QA', cfId: 100 }))).toHaveLength(1);
    expect(findCfsForRole('qa' as Role, catalog({ name: 'Quality Assurance', cfId: 200 }))).toHaveLength(1);
  });

  it('matches the lead pattern across "Lead" and "Team Lead"', () => {
    expect(findCfsForRole('lead' as Role, catalog({ name: 'Lead', cfId: 300 }))).toHaveLength(1);
    expect(findCfsForRole('lead' as Role, catalog({ name: 'Team Lead', cfId: 301 }))).toHaveLength(1);
  });
});

// --- buildFieldMap ---------------------------------------------------------

describe('buildFieldMap', () => {
  it('binds a single role to its catalog entry', () => {
    const fm = buildFieldMap(['developer'] as Role[], catalog({ name: 'Developer', cfId: 79 }));
    expect(fm.developer).toEqual({ cfId: 79, name: 'Developer' });
    expect(fm.tester).toBeUndefined();
  });

  it('binds every role in the input list', () => {
    const cat = catalog(
      { name: 'Developer', cfId: 79 },
      { name: 'Tester', cfId: 88 },
      { name: 'Lead', cfId: 100 },
    );
    const fm = buildFieldMap(['developer', 'tester', 'lead'] as Role[], cat);
    expect(fm.developer?.cfId).toBe(79);
    expect(fm.tester?.cfId).toBe(88);
    expect(fm.lead?.cfId).toBe(100);
    expect(fm.qa).toBeUndefined();
  });

  it('throws CONFIG_PROFILE_MISSING when ANY requested role has no matching cf', () => {
    expect(() =>
      buildFieldMap(['developer', 'tester'] as Role[], catalog({ name: 'Developer', cfId: 79 })),
    ).toThrow(LwrError);
  });

  it('throws when given an empty role list', () => {
    expect(() => buildFieldMap([] as Role[], catalog({ name: 'Developer', cfId: 79 }))).toThrow(LwrError);
  });

  it('matches role → cf via the canonical name pattern (case-insensitive)', () => {
    const fm = buildFieldMap(['developer'] as Role[], catalog({ name: 'developer', cfId: 79 }));
    expect(fm.developer?.cfId).toBe(79);
  });
});

#!/usr/bin/env node
// Verifies redmine-muse-AGENTS.md still matches the live instance.
// Muse guide §10: "Every documented status code is actually returned as documented."
// Run: REDMINE_KEY=... node scripts/check-redmine-connector.mjs
//
// ponytail: read-only probes only. Nothing here writes to Redmine, so it is
// safe to run against production. Add write-path checks only against a test
// issue you own.

import { readFile } from 'node:fs/promises';

const BASE = 'https://redmine.linways.com';
const KEY = process.env.REDMINE_KEY;
if (!KEY) {
  console.error('REDMINE_KEY not set');
  process.exit(2);
}

async function probe(path, key = KEY) {
  const res = await fetch(BASE + path, { headers: { 'X-Redmine-API-Key': key } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON, e.g. a Cloudflare page */ }
  return { status: res.status, ct: res.headers.get('content-type') ?? '', text, body };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('§3 valid key authenticates', async () => {
  const r = await probe('/users/current.json');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.body?.user?.id, 'no user.id in body');
});

check('§6 401 on bad key, empty JSON body', async () => {
  const r = await probe('/issues.json?limit=1', 'deadbeef'.repeat(5));
  assert(r.status === 401, `expected 401, got ${r.status}`);
  assert(r.ct.includes('application/json'), `expected JSON content-type, got "${r.ct}"`);
  assert(r.text === '', `doc says the 401 body is empty; got ${r.text.length} bytes`);
});

check('§6 403 is distinct from 401 (admin-only endpoints)', async () => {
  for (const p of ['/users.json?limit=1', '/custom_fields.json']) {
    const r = await probe(p);
    assert(r.status === 403, `${p}: expected 403, got ${r.status}`);
  }
});

check('§6 404 on unknown issue and unknown path', async () => {
  for (const p of ['/issues/999999999.json', '/nope.json']) {
    const r = await probe(p);
    assert(r.status === 404, `${p}: expected 404, got ${r.status}`);
  }
});

check('§5 memberships readable by non-admin (name→id recipe)', async () => {
  const r = await probe('/projects/am/memberships.json?limit=1');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(Array.isArray(r.body?.memberships), 'no memberships array');
});

check('§5 custom-field catalog arrives inline on an issue', async () => {
  const r = await probe('/issues.json?limit=1');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  const cf = r.body?.issues?.[0]?.custom_fields;
  assert(Array.isArray(cf) && cf.length > 0, 'no custom_fields on the issue payload');
  assert(cf.every((f) => f.id != null && f.name), 'custom_fields entries lack id/name');
});

check('§7.1 bad filters fail silently, in the three documented ways', async () => {
  const count = async (q) => {
    const r = await probe(`/issues.json?limit=1&${q}`);
    assert(r.status === 200, `${q}: expected 200, got ${r.status}`);
    return r.body.total_count;
  };
  const base = await count('');

  // Unknown param and unknown cf id are IGNORED -> you get the unfiltered set.
  for (const q of ['wibble=foo', 'cf_999999=x']) {
    assert(
      (await count(q)) === base,
      `doc says "${q}" is ignored (unfiltered result), but total_count moved off the ` +
        `baseline of ${base} — Redmine may now reject unknown filters`,
    );
  }

  // A bad VALUE on a known filter yields zero rows, not an error.
  for (const q of ['status_id=nope', 'assigned_to_id=notaperson']) {
    assert(
      (await count(q)) === 0,
      `doc says "${q}" returns 0 rows, but it did not — Redmine may now validate values`,
    );
  }

  // The one filter that errors properly.
  const bad = await probe('/issues.json?limit=1&project_id=no-such-project');
  assert(bad.status === 404, `bad project_id: expected 404, got ${bad.status}`);
});

check('§7.2 /issues.json defaults to open issues only', async () => {
  const count = async (q) => (await probe(`/issues.json?limit=1&${q}`)).body.total_count;
  const [bare, open, all] = [await count(''), await count('status_id=open'), await count('status_id=*')];
  assert(bare === open, `bare query (${bare}) should match status_id=open (${open})`);
  assert(all > bare, `status_id=* (${all}) should exceed the open-only default (${bare})`);
});

check('§7.3 limit is capped at 100 server-side', async () => {
  const r = await probe('/issues.json?limit=200');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.body.issues.length <= 100, `got ${r.body.issues.length} rows, expected <= 100`);
  assert(typeof r.body.total_count === 'number', 'no total_count for pagination');
});

check('§11b state store: wiki page holds parseable JSON', async () => {
  const r = await probe('/projects/lwr-state/wiki/Custom-fields.json');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  const text = r.body?.wiki_page?.text;
  assert(typeof text === 'string' && text.length > 0, 'wiki_page.text missing');

  let cfg;
  try {
    cfg = JSON.parse(text); // the contract: raw JSON, no markdown fences
  } catch {
    throw new Error('wiki_page.text is not raw JSON — someone added prose or code fences');
  }

  assert(Array.isArray(cfg.fields) && cfg.fields.length > 0, 'no fields array');
  assert(
    cfg.fields.every((f) => Number.isInteger(f.id) && typeof f.name === 'string'),
    'field entries must carry an integer id and a name',
  );
  assert(cfg.count === cfg.fields.length, `count ${cfg.count} != fields ${cfg.fields.length}`);
});

check('§11b state store is private and wiki-only', async () => {
  const r = await probe('/projects/lwr-state.json?include=enabled_modules');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  const p = r.body.project;
  assert(p.is_public === false, 'project must stay private');
  const mods = (p.enabled_modules ?? []).map((m) => m.name);
  assert(mods.includes('wiki'), 'wiki module must stay enabled');
  assert(!mods.includes('issue_tracking'), 'issue tracking should stay off — this is not a work project');
});

check('§11b Required-cfs matches lwr\'s schema and the catalog', async () => {
  const r = await probe('/projects/lwr-state/wiki/Required-cfs.json');
  assert(r.status === 200, `expected 200, got ${r.status}`);

  let cfg;
  try {
    cfg = JSON.parse(r.body.wiki_page.text);
  } catch {
    throw new Error('Required-cfs is not raw JSON — prose or code fences crept in');
  }

  // Mirrors the zod shape in src/assistant/required-cfs.ts, so this page can be
  // synced down to ~/.lwr/facts/required-cfs.json verbatim.
  assert(cfg.version === 1, `version must be 1, got ${cfg.version}`);
  assert(['warn', 'block'].includes(cfg.mode), `mode must be warn|block, got ${cfg.mode}`);
  assert(Array.isArray(cfg.rules) && cfg.rules.length > 0, 'rules must be a non-empty array');
  for (const rule of cfg.rules) {
    assert(typeof rule.status === 'string' && rule.status, 'rule.status must be a non-empty string');
    assert(Array.isArray(rule.requires) && rule.requires.length > 0, `${rule.status}: requires must be non-empty`);
    for (const req of rule.requires) {
      assert(Number.isInteger(req.cf), `${rule.status}: cf must be an integer`);
      assert(typeof req.name === 'string' && req.name, `${rule.status}: cf ${req.cf} needs a name`);
    }
  }

  // Cross-page: every cf a rule names must exist in the catalog, with the same name.
  const cat = JSON.parse((await probe('/projects/lwr-state/wiki/Custom-fields.json')).body.wiki_page.text);
  const byId = new Map(cat.fields.map((f) => [f.id, f.name]));
  for (const rule of cfg.rules) {
    for (const req of rule.requires) {
      const actual = byId.get(req.cf);
      assert(actual !== undefined, `${rule.status}: cf ${req.cf} ("${req.name}") is not in the catalog`);
      assert(
        actual === req.name,
        `${rule.status}: cf ${req.cf} is "${actual}" in the catalog but "${req.name}" in the rule — one of them is stale`,
      );
    }
  }

  // The statuses a rule names must be real, or the guard silently never fires.
  const statuses = (await probe('/issue_statuses.json')).body.issue_statuses.map((s) => s.name);
  for (const rule of cfg.rules) {
    assert(statuses.includes(rule.status), `rule targets status "${rule.status}", which does not exist on this instance`);
  }
});

check('§11b Preferences matches lwr\'s schema and the catalog', async () => {
  const r = await probe('/projects/lwr-state/wiki/Preferences.json');
  assert(r.status === 200, `expected 200, got ${r.status}`);

  let cfg;
  try {
    cfg = JSON.parse(r.body.wiki_page.text);
  } catch {
    throw new Error('Preferences is not raw JSON — prose or code fences crept in');
  }

  // Mirrors the zod shape in src/assistant/preferences.ts. lastTriggeredAt and
  // triggerCount are required there (nullable, not optional), so a page missing
  // them would fail to sync back down.
  assert(cfg.schema === 'lwr-preferences/v1', `schema must be lwr-preferences/v1, got ${cfg.schema}`);
  assert(typeof cfg.updatedAt === 'string', 'updatedAt must be a datetime string');
  assert(Array.isArray(cfg.rules) && cfg.rules.length > 0, 'rules must be a non-empty array');

  const cat = JSON.parse((await probe('/projects/lwr-state/wiki/Custom-fields.json')).body.wiki_page.text);
  const byId = new Map(cat.fields.map((f) => [f.id, f.name]));

  for (const rule of cfg.rules) {
    assert(typeof rule.id === 'string' && rule.id, 'rule.id must be a non-empty string');
    assert(typeof rule.reason === 'string' && rule.reason, `${rule.id}: reason is required`);
    assert(typeof rule.addedBy === 'string' && rule.addedBy, `${rule.id}: addedBy is required`);
    assert('lastTriggeredAt' in rule, `${rule.id}: lastTriggeredAt is required (may be null)`);
    assert(Number.isInteger(rule.triggerCount) && rule.triggerCount >= 0, `${rule.id}: triggerCount must be a non-negative integer`);

    // Every cf touched — the condition and every value it sets — must be real.
    const touched = [rule.when, ...rule.set];
    for (const t of touched) {
      assert(Number.isInteger(t.cf) && t.cf > 0, `${rule.id}: cf must be a positive integer`);
      const actual = byId.get(t.cf);
      assert(actual !== undefined, `${rule.id}: cf ${t.cf} ("${t.cfName}") is not in the catalog`);
      if (t.cfName !== undefined) {
        assert(
          actual === t.cfName,
          `${rule.id}: cf ${t.cf} is "${actual}" in the catalog but "${t.cfName}" here — one is stale`,
        );
      }
    }
  }
});

check('§11 published AGENTS page matches the repo copy', async () => {
  const r = await probe('/projects/lwr-state/wiki/AGENTS.json');
  assert(r.status === 200, `expected 200, got ${r.status}`);

  const remote = r.body?.wiki_page?.text;
  assert(typeof remote === 'string' && remote.length > 0, 'AGENTS page is empty');

  const local = await readFile(new URL('../docs/muse-connector-AGENTS.md', import.meta.url), 'utf8');
  assert(
    remote === local,
    `published page and docs/muse-connector-AGENTS.md have drifted ` +
      `(repo ${local.length} bytes, wiki ${remote.length} bytes) — republish from the repo`,
  );
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

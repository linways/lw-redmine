/**
 * `applyUpdateSkill` — directory-aware skill snapshot + per-tool symlink.
 *
 * Phase B added a `recipes/` directory alongside SKILL.md. Each
 * detected AI tool now gets two links: the existing SKILL.md file
 * symlink, plus a new directory symlink for `recipes/`. These tests
 * pin the contract end-to-end against tmp dirs so we don't need to
 * mock os.homedir() / configDir().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdateSkill } from '../src/commands/update-skill';

interface Sandbox {
  root: string;
  repoRoot: string;
  configRoot: string;
  homeRoot: string;
  tools: ReadonlyArray<{ name: string; rel: string }>;
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-update-skill-'));
  const repoRoot = path.join(root, 'repo');
  const configRoot = path.join(root, 'lwr');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });

  // Realistic repo layout: SKILL.md + recipes/.
  fs.writeFileSync(path.join(repoRoot, 'SKILL.md'), '# fake SKILL\n');
  fs.mkdirSync(path.join(repoRoot, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'recipes', 'time-tracking.md'), '# time\n');
  fs.writeFileSync(path.join(repoRoot, 'recipes', 'work-log.md'), '# work-log\n');

  // Two tools: one "installed" (its parent dir exists), one not.
  // .claude/ is created so the "Claude Code" tool is detected.
  fs.mkdirSync(path.join(homeRoot, '.claude'), { recursive: true });
  const tools = [
    { name: 'Claude Code', rel: '.claude/skills' },
    { name: 'Codex CLI', rel: '.codex/skills' }, // .codex/ not created → skipped
  ];

  return { root, repoRoot, configRoot, homeRoot, tools };
}

function readlinkSafe(p: string): string {
  return fs.readlinkSync(p);
}

describe('applyUpdateSkill — directory-aware snapshot + symlink', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(() => {
    fs.rmSync(sb.root, { recursive: true, force: true });
  });

  it('writes SKILL.md and recipes/ into the canonical config dir', () => {
    const result = applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    const canonicalSkill = path.join(sb.configRoot, 'skill', 'SKILL.md');
    const canonicalRecipes = path.join(sb.configRoot, 'skill', 'recipes');

    expect(fs.existsSync(canonicalSkill)).toBe(true);
    expect(fs.readFileSync(canonicalSkill, 'utf8')).toBe('# fake SKILL\n');

    expect(fs.existsSync(canonicalRecipes)).toBe(true);
    const recipeFiles = fs.readdirSync(canonicalRecipes).sort();
    expect(recipeFiles).toEqual(['time-tracking.md', 'work-log.md']);

    expect(result.canonical).toBe(canonicalSkill);
    expect(result.recipesCanonical).toBe(canonicalRecipes);
    expect(result.recipesCount).toBe(2);
  });

  it('creates a SKILL.md file symlink AND a recipes/ directory symlink for each detected tool', () => {
    applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    const claudeSkillLink = path.join(sb.homeRoot, '.claude/skills/lw-redmine/SKILL.md');
    const claudeRecipesLink = path.join(sb.homeRoot, '.claude/skills/lw-redmine/recipes');

    // SKILL.md symlink resolves to the canonical file.
    expect(fs.lstatSync(claudeSkillLink).isSymbolicLink()).toBe(true);
    expect(readlinkSafe(claudeSkillLink)).toBe(path.join(sb.configRoot, 'skill', 'SKILL.md'));

    // recipes/ symlink resolves to the canonical directory.
    expect(fs.lstatSync(claudeRecipesLink).isSymbolicLink()).toBe(true);
    expect(readlinkSafe(claudeRecipesLink)).toBe(path.join(sb.configRoot, 'skill', 'recipes'));

    // Following the dir symlink resolves the actual recipe files.
    const seenRecipes = fs.readdirSync(claudeRecipesLink).sort();
    expect(seenRecipes).toEqual(['time-tracking.md', 'work-log.md']);
  });

  it('skips tools whose parent dir does not exist', () => {
    const { symlinks } = applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    const codex = symlinks.find(s => s.tool === 'Codex CLI');
    expect(codex).toBeDefined();
    expect(codex!.status).toBe('skipped-not-installed');

    // Both kinds appear for Claude — one record per kind.
    const claudeSkill = symlinks.find(s => s.tool === 'Claude Code' && s.kind === 'skill');
    const claudeRecipes = symlinks.find(s => s.tool === 'Claude Code' && s.kind === 'recipes');
    expect(claudeSkill?.status).toBe('created');
    expect(claudeRecipes?.status).toBe('created');
  });

  it('is idempotent — second run flips status from "created" to "refreshed"', () => {
    applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });
    const second = applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });
    const claudeRecords = second.symlinks.filter(s => s.tool === 'Claude Code');
    expect(claudeRecords).toHaveLength(2);
    for (const r of claudeRecords) {
      expect(r.status).toBe('refreshed');
    }
  });

  it('removes recipes upstream → re-snapshot drops them from the canonical', () => {
    applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });
    // Delete one recipe upstream.
    fs.unlinkSync(path.join(sb.repoRoot, 'recipes', 'work-log.md'));

    const result = applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    expect(result.recipesCount).toBe(1);
    const canonicalRecipes = path.join(sb.configRoot, 'skill', 'recipes');
    expect(fs.readdirSync(canonicalRecipes)).toEqual(['time-tracking.md']);

    // The old recipe is also gone via the dir symlink in each tool.
    const claudeRecipes = path.join(sb.homeRoot, '.claude/skills/lw-redmine/recipes');
    expect(fs.readdirSync(claudeRecipes)).toEqual(['time-tracking.md']);
  });

  it('omits recipes-related fields when the repo has no recipes/ directory', () => {
    fs.rmSync(path.join(sb.repoRoot, 'recipes'), { recursive: true, force: true });

    const result = applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    expect(result.recipesCanonical).toBeUndefined();
    expect(result.recipesCount).toBeUndefined();

    // No 'recipes' kind symlink emitted.
    const recipeRecords = result.symlinks.filter(s => s.kind === 'recipes');
    expect(recipeRecords).toHaveLength(0);

    // SKILL.md still landed in each detected tool.
    const claudeSkill = path.join(sb.homeRoot, '.claude/skills/lw-redmine/SKILL.md');
    expect(fs.lstatSync(claudeSkill).isSymbolicLink()).toBe(true);
  });

  it('replaces a leftover real `recipes/` directory (e.g. from an older install) with a symlink', () => {
    // Simulate a pre-Phase-B install that wrote a real directory rather
    // than a symlink (or a future state where someone hand-copied files).
    const claudeRoot = path.join(sb.homeRoot, '.claude/skills/lw-redmine');
    fs.mkdirSync(path.join(claudeRoot, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'recipes', 'stale.md'), 'leftover');

    applyUpdateSkill({
      repoSkill: path.join(sb.repoRoot, 'SKILL.md'),
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
      toolRels: sb.tools,
    });

    const claudeRecipes = path.join(claudeRoot, 'recipes');
    expect(fs.lstatSync(claudeRecipes).isSymbolicLink()).toBe(true);
    // stale.md is gone; the canonical recipes are visible through the link.
    expect(fs.readdirSync(claudeRecipes).sort()).toEqual(['time-tracking.md', 'work-log.md']);
  });
});

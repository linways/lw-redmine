/**
 * `buildSkillPathsPayload` — pure-filesystem inspector behind
 * `lwr skill-paths`. Tests pin the contract: which fields it reports,
 * how `linked` is computed, and how missing canonical state surfaces.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillPathsPayload } from '../src/commands/skill-paths';

interface Sandbox {
  root: string;
  configRoot: string;
  homeRoot: string;
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-skill-paths-'));
  const configRoot = path.join(root, 'lwr');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  return { root, configRoot, homeRoot };
}

function writeCanonical(sb: Sandbox, recipes: string[] = []): void {
  const skillDir = path.join(sb.configRoot, 'skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# canonical\n');
  if (recipes.length > 0) {
    const r = path.join(skillDir, 'recipes');
    fs.mkdirSync(r, { recursive: true });
    for (const name of recipes) {
      fs.writeFileSync(path.join(r, name), `# ${name}\n`);
    }
  }
}

function writeLinks(sb: Sandbox, toolRel: string): void {
  // Make this tool "installed" (parent dotdir exists) and create both links.
  const parent = path.join(sb.homeRoot, toolRel.split(path.sep)[0]);
  fs.mkdirSync(parent, { recursive: true });
  const skillFolder = path.join(sb.homeRoot, toolRel, 'lw-redmine');
  fs.mkdirSync(skillFolder, { recursive: true });
  fs.symlinkSync(path.join(sb.configRoot, 'skill', 'SKILL.md'), path.join(skillFolder, 'SKILL.md'), 'file');
  fs.symlinkSync(path.join(sb.configRoot, 'skill', 'recipes'), path.join(skillFolder, 'recipes'), 'dir');
}

describe('buildSkillPathsPayload', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(() => {
    fs.rmSync(sb.root, { recursive: true, force: true });
  });

  it('reports canonical paths even when nothing is on disk yet', () => {
    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    expect(p.skill).toBe(path.join(sb.configRoot, 'skill', 'SKILL.md'));
    expect(p.recipes).toBe(path.join(sb.configRoot, 'skill', 'recipes'));
    expect(p.skillExists).toBe(false);
    expect(p.recipesExists).toBe(false);
    expect(p.recipeFiles).toEqual([]);
  });

  it('returns a sorted recipe-file list when the canonical recipes/ exists', () => {
    writeCanonical(sb, ['work-log.md', 'time-tracking.md', 'README.txt']);
    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    expect(p.recipeFiles).toEqual(['time-tracking.md', 'work-log.md']);
    // Non-md siblings are filtered out.
    expect(p.recipeFiles).not.toContain('README.txt');
  });

  it('reports each tool as not-installed when its parent dotdir is missing', () => {
    writeCanonical(sb, ['x.md']);
    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    for (const t of p.tools) {
      expect(t.installed).toBe(false);
      expect(t.linked).toBe(false);
    }
  });

  it('marks linked=true when both SKILL.md and recipes/ symlinks resolve to canonical', () => {
    writeCanonical(sb, ['x.md']);
    writeLinks(sb, '.claude/skills');
    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    const claude = p.tools.find(t => t.name === 'Claude Code');
    expect(claude).toBeDefined();
    expect(claude!.installed).toBe(true);
    expect(claude!.linked).toBe(true);
  });

  it('marks linked=false when the tool is installed but the symlinks are missing', () => {
    writeCanonical(sb, ['x.md']);
    fs.mkdirSync(path.join(sb.homeRoot, '.claude'), { recursive: true });
    // No skill folder created → symlinks absent.

    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    const claude = p.tools.find(t => t.name === 'Claude Code');
    expect(claude!.installed).toBe(true);
    expect(claude!.linked).toBe(false);
  });

  it('marks linked=false when SKILL.md link points elsewhere (stale link)', () => {
    writeCanonical(sb, ['x.md']);
    fs.mkdirSync(path.join(sb.homeRoot, '.claude'), { recursive: true });
    const skillFolder = path.join(sb.homeRoot, '.claude/skills/lw-redmine');
    fs.mkdirSync(skillFolder, { recursive: true });
    // Stale: points at a different file.
    const otherSkill = path.join(sb.root, 'old-SKILL.md');
    fs.writeFileSync(otherSkill, '# stale\n');
    fs.symlinkSync(otherSkill, path.join(skillFolder, 'SKILL.md'), 'file');
    fs.symlinkSync(path.join(sb.configRoot, 'skill', 'recipes'), path.join(skillFolder, 'recipes'), 'dir');

    const p = buildSkillPathsPayload({ homeRoot: sb.homeRoot, configRoot: sb.configRoot });
    const claude = p.tools.find(t => t.name === 'Claude Code');
    expect(claude!.linked).toBe(false);
  });
});

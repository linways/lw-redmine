/**
 * `applyInstallSkill` — manual-target self-bootstrap behind
 * `lwr install-skill --target <dir>`. Tests pin: the $HOME safety
 * guard, missing-canonical refusal, happy path, idempotent re-run,
 * and that the recipes link is omitted when the canonical lacks one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyInstallSkill } from '../src/commands/install-skill';
import { ValidationError, LwrError } from '../src/foundation/errors';

interface Sandbox {
  root: string;
  configRoot: string;
  homeRoot: string;
}

function makeSandbox(withCanonical = true, withRecipes = true): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-install-skill-'));
  const configRoot = path.join(root, 'lwr');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });

  if (withCanonical) {
    const skillDir = path.join(configRoot, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# canonical\n');
    if (withRecipes) {
      fs.mkdirSync(path.join(skillDir, 'recipes'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'recipes', 'work-log.md'), '# work-log\n');
    }
  }
  return { root, configRoot, homeRoot };
}

describe('applyInstallSkill', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(() => {
    fs.rmSync(sb.root, { recursive: true, force: true });
  });

  it('symlinks SKILL.md and recipes/ into the named target', () => {
    const target = path.join(sb.homeRoot, '.kilo/skills/lw-redmine');
    const result = applyInstallSkill({
      target,
      configRoot: sb.configRoot,
      homeRoot: sb.homeRoot,
    });

    const skillLink = path.join(target, 'SKILL.md');
    const recipesLink = path.join(target, 'recipes');
    expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(skillLink)).toBe(path.join(sb.configRoot, 'skill', 'SKILL.md'));
    expect(fs.lstatSync(recipesLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(recipesLink)).toBe(path.join(sb.configRoot, 'skill', 'recipes'));

    // Reading through the dir symlink returns the canonical recipe.
    expect(fs.readdirSync(recipesLink)).toEqual(['work-log.md']);

    // Payload mirrors what landed.
    expect(result.target).toBe(target);
    expect(result.canonicalSkill).toBe(path.join(sb.configRoot, 'skill', 'SKILL.md'));
    expect(result.canonicalRecipes).toBe(path.join(sb.configRoot, 'skill', 'recipes'));
    expect(result.symlinks).toHaveLength(2);
    expect(result.symlinks.map(s => s.kind).sort()).toEqual(['recipes', 'skill']);
  });

  it('rejects targets outside $HOME with VALIDATION_BAD_VALUE', () => {
    expect(() =>
      applyInstallSkill({
        target: '/etc/lwr-skill',
        configRoot: sb.configRoot,
        homeRoot: sb.homeRoot,
      }),
    ).toThrow(ValidationError);

    try {
      applyInstallSkill({
        target: '/etc/lwr-skill',
        configRoot: sb.configRoot,
        homeRoot: sb.homeRoot,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe('VALIDATION_BAD_VALUE');
      expect((e as ValidationError).message).toContain('Target must be under $HOME');
    }
  });

  it('rejects the literal "/" target (not under any reasonable home)', () => {
    expect(() =>
      applyInstallSkill({
        target: '/',
        configRoot: sb.configRoot,
        homeRoot: sb.homeRoot,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty target with VALIDATION_MISSING_FLAG', () => {
    try {
      applyInstallSkill({
        target: '',
        configRoot: sb.configRoot,
        homeRoot: sb.homeRoot,
      });
      throw new Error('expected ValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe('VALIDATION_MISSING_FLAG');
    }
  });

  it('refuses when the canonical SKILL.md does not exist (CONFIG_MALFORMED)', () => {
    const empty = makeSandbox(false /* no canonical */);
    try {
      applyInstallSkill({
        target: path.join(empty.homeRoot, '.kilo/skills/lw-redmine'),
        configRoot: empty.configRoot,
        homeRoot: empty.homeRoot,
      });
      throw new Error('expected LwrError');
    } catch (e) {
      expect(e).toBeInstanceOf(LwrError);
      expect((e as LwrError).code).toBe('CONFIG_MALFORMED');
      expect((e as LwrError).hint).toContain('lwr update-skill');
    } finally {
      fs.rmSync(empty.root, { recursive: true, force: true });
    }
  });

  it('omits the recipes link when the canonical has no recipes/', () => {
    const noRec = makeSandbox(true, false /* no recipes */);
    const target = path.join(noRec.homeRoot, '.kilo/skills/lw-redmine');
    const result = applyInstallSkill({
      target,
      configRoot: noRec.configRoot,
      homeRoot: noRec.homeRoot,
    });
    expect(result.canonicalRecipes).toBeUndefined();
    expect(result.symlinks).toHaveLength(1);
    expect(result.symlinks[0].kind).toBe('skill');
    expect(fs.existsSync(path.join(target, 'recipes'))).toBe(false);
    fs.rmSync(noRec.root, { recursive: true, force: true });
  });

  it('is idempotent — second call flips status from "created" to "refreshed"', () => {
    const target = path.join(sb.homeRoot, '.kilo/skills/lw-redmine');
    applyInstallSkill({ target, configRoot: sb.configRoot, homeRoot: sb.homeRoot });
    const second = applyInstallSkill({ target, configRoot: sb.configRoot, homeRoot: sb.homeRoot });
    for (const s of second.symlinks) {
      expect(s.status).toBe('refreshed');
    }
  });

  it('only writes under the named target — does not touch unrelated home subdirs', () => {
    // Pre-populate a "Claude Code" skill folder; install-skill must not touch it.
    const claudeRoot = path.join(sb.homeRoot, '.claude/skills/lw-redmine');
    fs.mkdirSync(claudeRoot, { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'sentinel.txt'), 'do not touch');

    const target = path.join(sb.homeRoot, '.kilo/skills/lw-redmine');
    applyInstallSkill({ target, configRoot: sb.configRoot, homeRoot: sb.homeRoot });

    expect(fs.existsSync(path.join(claudeRoot, 'sentinel.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(claudeRoot, 'sentinel.txt'), 'utf8')).toBe('do not touch');
    // Claude folder did NOT get install-skill's links.
    expect(fs.existsSync(path.join(claudeRoot, 'SKILL.md'))).toBe(false);
  });
});

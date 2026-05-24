/**
 * `lwr update-skill`
 *
 * Refreshes the SKILL.md and `recipes/` bundle the agents read. Cheap,
 * idempotent, no git/npm/build — the typical "you edited SKILL.md,
 * propagate it" path.
 *
 * Architecture (mirrors install.mjs):
 *
 *   <repo>/SKILL.md            <repo>/recipes/*.md
 *        │ (copy)                    │ (recursive copy)
 *        ▼                            ▼
 *   ~/.lwr/skill/SKILL.md   ~/.lwr/skill/recipes/  ← canonical snapshot
 *        ▲                            ▲
 *        │ (file symlink)             │ (directory symlink)
 *        │                            │
 *   ~/.claude/skills/lw-redmine/{SKILL.md, recipes/}
 *   ~/.copilot/skills/lw-redmine/{SKILL.md, recipes/}
 *   ~/.codex/skills/lw-redmine/{SKILL.md, recipes/}
 *   ~/.gemini/antigravity/skills/lw-redmine/{SKILL.md, recipes/}
 *
 * The lwr binary lives in <repo>/dist/cli.js (npm-linked). We resolve the
 * binary's realpath to find <repo>/SKILL.md without the agent needing to
 * know where it cloned the repo. recipes/ sits next to SKILL.md in the
 * repo, so the same realpath unlocks both.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { success, dim, warn } from '../foundation/format';
import { LwrError } from '../foundation/errors';
import { ERROR_CODES, EXIT, ME_FILE } from '../constants';
import { configDir } from '../foundation/paths';
import {
  AI_TOOL_SKILL_RELS,
  RECIPES_DIR_NAME,
  SKILL_FILE_NAME,
  SKILL_NAME,
  replaceSymlink,
  type SymlinkRecord,
} from '../workflow/skill-bundle';

interface UpdateSkillPayload {
  source: string;
  canonical: string;
  /** Canonical recipes/ directory, present when the repo ships recipes. */
  recipesCanonical?: string;
  /** Number of recipe files mirrored into the canonical snapshot. */
  recipesCount?: number;
  symlinks: SymlinkRecord[];
}

/**
 * Pure(-ish) core: copies SKILL.md + recipes/ from a repo root into a
 * canonical snapshot dir, then symlinks both into each detected AI
 * tool's skill folder under `homeRoot`. Exported so tests can drive it
 * with tmp dirs instead of mocking `os.homedir()` / `configDir()`.
 *
 * Side-effects only on the filesystem paths derived from `opts`. Safe
 * to re-run (idempotent — existing links/dirs are replaced).
 */
export interface ApplyUpdateSkillOpts {
  /** Absolute path to the repo's SKILL.md file. */
  repoSkill: string;
  /** Path that plays the role of `~/.lwr` (the canonical config dir). */
  configRoot: string;
  /** Path that plays the role of `$HOME` for AI-tool detection. */
  homeRoot: string;
  /** Override the AI tool list (test injection). Defaults to the real list. */
  toolRels?: ReadonlyArray<{ name: string; rel: string }>;
}

export interface ApplyUpdateSkillResult {
  source: string;
  canonical: string;
  recipesCanonical?: string;
  recipesCount?: number;
  symlinks: SymlinkRecord[];
}

export function applyUpdateSkill(opts: ApplyUpdateSkillOpts): ApplyUpdateSkillResult {
  const { repoSkill, configRoot, homeRoot } = opts;
  const tools = opts.toolRels ?? AI_TOOL_SKILL_RELS;

  const repoRoot = path.dirname(repoSkill);
  const repoRecipes = path.join(repoRoot, RECIPES_DIR_NAME);
  const hasRecipes = fs.existsSync(repoRecipes) && fs.statSync(repoRecipes).isDirectory();

  const skillDir = path.join(configRoot, 'skill');
  const canonical = path.join(skillDir, SKILL_FILE_NAME);
  const recipesCanonical = path.join(skillDir, RECIPES_DIR_NAME);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(repoSkill, canonical);

  let recipesCount = 0;
  if (hasRecipes) {
    if (fs.existsSync(recipesCanonical)) {
      fs.rmSync(recipesCanonical, { recursive: true, force: true });
    }
    fs.cpSync(repoRecipes, recipesCanonical, { recursive: true });
    recipesCount = fs.readdirSync(recipesCanonical).filter(f => f.endsWith('.md')).length;
  }

  const symlinks: SymlinkRecord[] = [];
  for (const tool of tools) {
    const parent = path.join(homeRoot, tool.rel.split(path.sep)[0]);
    if (!fs.existsSync(parent)) {
      symlinks.push({ tool: tool.name, path: '', status: 'skipped-not-installed', kind: 'skill' });
      continue;
    }
    const skillRoot = path.join(homeRoot, tool.rel, SKILL_NAME);
    fs.mkdirSync(skillRoot, { recursive: true });

    symlinks.push(replaceSymlink(tool.name, skillRoot, SKILL_FILE_NAME, canonical, 'skill', 'file'));

    if (hasRecipes) {
      symlinks.push(replaceSymlink(tool.name, skillRoot, RECIPES_DIR_NAME, recipesCanonical, 'recipes', 'dir'));
    }
  }

  const result: ApplyUpdateSkillResult = { source: repoSkill, canonical, symlinks };
  if (hasRecipes) {
    result.recipesCanonical = recipesCanonical;
    result.recipesCount = recipesCount;
  }
  return result;
}

const cmd: CommandFn<UpdateSkillPayload> = async (): Promise<CommandResult<UpdateSkillPayload>> => {
  const repoSkill = locateRepoSkill();
  if (!repoSkill) {
    throw new LwrError({
      message: 'Could not locate the repo SKILL.md.',
      code: ERROR_CODES.CONFIG_MALFORMED,
      exit: EXIT.CONFIG,
      hint: 'lwr expects to be installed via `npm link` from the repo. If you ran the binary in some other way, run `node <repo>/install.mjs update-skill` directly.',
    });
  }

  const result = applyUpdateSkill({
    repoSkill,
    configRoot: configDir(),
    homeRoot: os.homedir(),
  });

  void ME_FILE; // me.md sits next to skill/; touching it isn't this command's job

  const hasRecipes = result.recipesCanonical !== undefined;
  return {
    json: result,
    pretty: c => {
      writeLine(success(c, `Skill snapshot refreshed: ${result.canonical}`));
      writeLine(`  ${dim(c, 'source:')} ${result.source}`);
      if (hasRecipes) {
        const n = result.recipesCount ?? 0;
        writeLine(`  ${dim(c, 'recipes:')} ${result.recipesCanonical} ${dim(c, `(${n} file${n === 1 ? '' : 's'})`)}`);
      }
      for (const s of result.symlinks) {
        if (s.status === 'skipped-not-installed') {
          writeLine(`  ${dim(c, '— ' + s.tool + ' (not installed)')}`);
        } else if (s.status === 'failed') {
          writeLine(warn(c, `${s.tool} (${s.kind}): ${s.error}`));
        } else {
          writeLine(`  ${dim(c, s.status + ':')} ${s.tool} ${dim(c, s.kind === 'recipes' ? '(recipes/) → ' : '→ ')}${dim(c, s.path)}`);
        }
      }
      writeLine(`  ${dim(c, 'agents: open a fresh session to load the new content.')}`);
    },
  };
};

/**
 * Find <repo>/SKILL.md by resolving the running binary's symlink chain.
 * The npm-linked `lwr` binary's realpath is `<repo>/dist/cli.js`; the
 * SKILL.md lives at the repo root, one directory up.
 *
 * Two candidates, in order: process.argv[1] (fastest, doesn't depend on
 * PATH) and `which lwr` as a fallback for unusual launch paths.
 */
function locateRepoSkill(): string | null {
  const candidates: string[] = [];
  if (process.argv[1]) candidates.push(process.argv[1]);
  const which = spawnSync('which', ['lwr'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim().length > 0) {
    candidates.push(which.stdout.trim());
  }
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      const repoRoot = path.resolve(path.dirname(real), '..');
      const skill = path.join(repoRoot, SKILL_FILE_NAME);
      if (fs.existsSync(skill)) return skill;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function updateSkill(flags: GlobalFlags): Promise<never> {
  return runCommand('update-skill', flags, cmd);
}

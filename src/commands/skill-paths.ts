/**
 * `lwr skill-paths`
 *
 * Reports where the canonical SKILL.md + recipes live, plus the
 * symlink state under each known AI tool's skill folder. No network,
 * no writes — pure filesystem inspection.
 *
 * Why this exists:
 *   An agent running on an *unsupported* host (Kilo, Continue, Cursor,
 *   …) can call this to discover the canonical files and read them
 *   directly via its own file-read tool. The agent doesn't have to
 *   know lwr's internal layout — this command is the contract.
 *
 *   It's also useful for diagnosis on a *supported* host when symlinks
 *   are missing or broken: the per-tool record reports `linked: false`
 *   for any tool whose folder exists but lacks (or has a stale)
 *   symlink, so the agent can offer to repair via `lwr update-skill`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, header, success } from '../foundation/format';
import { configDir } from '../foundation/paths';
import {
  AI_TOOL_SKILL_RELS,
  RECIPES_DIR_NAME,
  SKILL_FILE_NAME,
  SKILL_NAME,
} from '../workflow/skill-bundle';

export interface ToolLinkState {
  /** Display name (e.g. "Claude Code"). */
  name: string;
  /** Where lwr would symlink under this tool, e.g. ~/.claude/skills/lw-redmine. */
  skillFolder: string;
  /**
   * `installed` reflects whether the tool's parent dotdir exists at all
   * (e.g. `~/.claude/`). When false, the tool isn't present on this
   * machine — lwr deliberately skips it during install/update.
   */
  installed: boolean;
  /**
   * `linked` is true when both the SKILL.md file and the recipes/
   * directory link exist under `skillFolder` AND resolve to the
   * canonical paths. False on broken/stale/missing links.
   */
  linked: boolean;
}

export interface SkillPathsPayload {
  /** Absolute path to the canonical SKILL.md (or expected location). */
  skill: string;
  /** Whether the canonical SKILL.md exists on disk. */
  skillExists: boolean;
  /** Absolute path to the canonical recipes/ directory (or expected). */
  recipes: string;
  /** Whether the canonical recipes/ directory exists. */
  recipesExists: boolean;
  /** Recipe file basenames (sorted) when the canonical recipes/ exists. */
  recipeFiles: string[];
  /** Per-tool symlink state. */
  tools: ToolLinkState[];
}

export interface SkillPathsOpts {
  /** Override $HOME (test injection); defaults to os.homedir(). */
  homeRoot?: string;
  /** Override the canonical lwr config dir (test injection). */
  configRoot?: string;
}

/**
 * Pure filesystem inspector. Exported for tests so they can drive it
 * with tmp dirs without touching the real $HOME.
 */
export function buildSkillPathsPayload(opts: SkillPathsOpts = {}): SkillPathsPayload {
  const homeRoot = opts.homeRoot ?? os.homedir();
  const cfgRoot = opts.configRoot ?? configDir();
  const skillRoot = path.join(cfgRoot, 'skill');
  const skill = path.join(skillRoot, SKILL_FILE_NAME);
  const recipes = path.join(skillRoot, RECIPES_DIR_NAME);

  const skillExists = fs.existsSync(skill) && fs.statSync(skill).isFile();
  const recipesExists = fs.existsSync(recipes) && fs.statSync(recipes).isDirectory();
  const recipeFiles = recipesExists
    ? fs.readdirSync(recipes).filter(f => f.endsWith('.md')).sort()
    : [];

  const tools: ToolLinkState[] = AI_TOOL_SKILL_RELS.map(({ name, rel }) => {
    const parent = path.join(homeRoot, rel.split(path.sep)[0]);
    const installed = fs.existsSync(parent);
    const skillFolder = path.join(homeRoot, rel, SKILL_NAME);
    let linked = false;
    if (installed) {
      const linkSkill = path.join(skillFolder, SKILL_FILE_NAME);
      const linkRecipes = path.join(skillFolder, RECIPES_DIR_NAME);
      linked = resolvesTo(linkSkill, skill) && resolvesTo(linkRecipes, recipes);
    }
    return { name, skillFolder, installed, linked };
  });

  return { skill, skillExists, recipes, recipesExists, recipeFiles, tools };
}

/**
 * True when `link` exists, is a symlink (or hardlink/file), and the
 * realpath equals `target`. Both files and directories are accepted.
 */
function resolvesTo(link: string, target: string): boolean {
  try {
    if (!fs.existsSync(link)) return false;
    return fs.realpathSync(link) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

const cmd: CommandFn<SkillPathsPayload> = async (): Promise<CommandResult<SkillPathsPayload>> => {
  const payload = buildSkillPathsPayload();
  return {
    json: payload,
    pretty: c => {
      writeLine(header(c, 'lwr skill bundle'));
      writeLine('');
      const skillState = payload.skillExists ? success(c, '✓ present') : dim(c, '— missing');
      writeLine(`  ${dim(c, 'SKILL.md:')} ${payload.skill} ${skillState}`);
      const recipesState = payload.recipesExists
        ? success(c, `✓ ${payload.recipeFiles.length} file${payload.recipeFiles.length === 1 ? '' : 's'}`)
        : dim(c, '— missing');
      writeLine(`  ${dim(c, 'recipes/:')} ${payload.recipes} ${recipesState}`);
      if (payload.recipesExists && payload.recipeFiles.length > 0) {
        for (const f of payload.recipeFiles) {
          writeLine(`    ${dim(c, '· ' + f)}`);
        }
      }
      writeLine('');
      writeLine(dim(c, 'AI tools:'));
      for (const t of payload.tools) {
        if (!t.installed) {
          writeLine(`  ${dim(c, '— ' + t.name + ' (not installed)')}`);
        } else if (t.linked) {
          writeLine(`  ${success(c, '✓')} ${t.name} ${dim(c, '↦ ' + t.skillFolder)}`);
        } else {
          writeLine(`  ${dim(c, '⚠ ' + t.name + ' (symlinks missing/stale)')} — run \`lwr update-skill\` to repair`);
        }
      }
      writeLine('');
      writeLine(dim(c, 'For unsupported hosts: `lwr install-skill --target <your-skill-folder>`'));
    },
  };
};

export function skillPaths(flags: GlobalFlags): Promise<never> {
  return runCommand('skill-paths', flags, cmd);
}

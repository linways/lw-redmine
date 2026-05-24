/**
 * `lwr install-skill --target <dir>`
 *
 * Manual-target self-bootstrap for AI hosts lwr doesn't auto-detect
 * (Kilo, Continue, Cursor, future tools, …). Symlinks the canonical
 * SKILL.md + recipes/ into the named target directory. Touches only
 * that target — never the four supported tools, never anything else.
 *
 * Companion to `update-skill`:
 *   - `update-skill`  → "auto-refresh every detected tool" (the four
 *                       hardcoded names). For known hosts.
 *   - `install-skill` → "symlink into this one explicit folder."
 *                       For everything else.
 *
 * Safety guard: the target must be under $HOME. Anything outside is
 * rejected with VALIDATION_BAD_VALUE before any filesystem write —
 * an agent or human typo can't accidentally land symlinks in /etc,
 * /usr, /tmp, or somewhere even more surprising.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, success, warn } from '../foundation/format';
import { LwrError, ValidationError } from '../foundation/errors';
import { ERROR_CODES, EXIT } from '../constants';
import { configDir } from '../foundation/paths';
import {
  RECIPES_DIR_NAME,
  SKILL_FILE_NAME,
  replaceSymlink,
  type SymlinkRecord,
} from '../workflow/skill-bundle';

export interface InstallSkillFlags extends GlobalFlags {
  /** Absolute or `~`-prefixed path to the target skill folder. Required. */
  target?: string;
}

export interface InstallSkillPayload {
  target: string;
  canonicalSkill: string;
  canonicalRecipes?: string;
  symlinks: SymlinkRecord[];
}

export interface ApplyInstallSkillOpts {
  /** The user-supplied target (already expanded — see `expandHome`). */
  target: string;
  /** Path that plays the role of `~/.lwr` (the canonical config dir). */
  configRoot: string;
  /** Path that plays the role of `$HOME` for the safety guard. */
  homeRoot: string;
}

/**
 * Pure-ish core: validates the target, resolves canonical paths, and
 * symlinks SKILL.md + recipes/ into the target. Exported for tests so
 * they can drive it with tmp dirs.
 *
 * Throws ValidationError when:
 *   - target is missing or empty.
 *   - target is not under homeRoot (after realpath / normalise).
 *   - the canonical SKILL.md is missing — the user hasn't run
 *     `update-skill` (or `install`) yet, and we have nothing to link.
 */
export function applyInstallSkill(opts: ApplyInstallSkillOpts): InstallSkillPayload {
  const { target, configRoot, homeRoot } = opts;
  if (!target || target.trim().length === 0) {
    throw new ValidationError(
      '--target is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass --target <skill-folder>, e.g. `--target ~/.kilo/skills/lw-redmine`.',
    );
  }

  const absTarget = path.resolve(target);

  // Safety guard: only write under $HOME. Compare normalised absolute
  // paths so a user passing `~/foo/../bar` (which resolves to ~/bar)
  // is accepted, but `/etc` is not.
  const absHome = path.resolve(homeRoot);
  if (absTarget !== absHome && !absTarget.startsWith(absHome + path.sep)) {
    throw new ValidationError(
      `Target must be under $HOME (got ${absTarget}).`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Pass a path under ${absHome} so install-skill can't accidentally write to system directories.`,
    );
  }

  const canonicalSkill = path.join(configRoot, 'skill', SKILL_FILE_NAME);
  const canonicalRecipes = path.join(configRoot, 'skill', RECIPES_DIR_NAME);

  if (!fs.existsSync(canonicalSkill)) {
    throw new LwrError({
      message: 'Canonical SKILL.md not found.',
      code: ERROR_CODES.CONFIG_MALFORMED,
      exit: EXIT.CONFIG,
      hint: `Run \`lwr update-skill\` (or re-run \`node install.mjs install\`) first to populate ${canonicalSkill}.`,
    });
  }

  fs.mkdirSync(absTarget, { recursive: true });

  const symlinks: SymlinkRecord[] = [];
  const targetLabel = absTarget; // displayed verbatim in JSON / pretty
  symlinks.push(replaceSymlink(targetLabel, absTarget, SKILL_FILE_NAME, canonicalSkill, 'skill', 'file'));

  const hasRecipes = fs.existsSync(canonicalRecipes) && fs.statSync(canonicalRecipes).isDirectory();
  if (hasRecipes) {
    symlinks.push(replaceSymlink(targetLabel, absTarget, RECIPES_DIR_NAME, canonicalRecipes, 'recipes', 'dir'));
  }

  const result: InstallSkillPayload = {
    target: absTarget,
    canonicalSkill,
    symlinks,
  };
  if (hasRecipes) {
    result.canonicalRecipes = canonicalRecipes;
  }
  return result;
}

/**
 * Expand a leading `~` against `homeRoot`. Doesn't try to resolve
 * `~user` (single-tilde only) — agents using this command should be
 * passing absolute paths or `~/...` paths, not username-relative.
 */
function expandHome(p: string, homeRoot: string): string {
  if (p === '~') return homeRoot;
  if (p.startsWith('~/')) return path.join(homeRoot, p.slice(2));
  return p;
}

const cmd: CommandFn<InstallSkillPayload> = async (flags): Promise<CommandResult<InstallSkillPayload>> => {
  const flgs = flags as InstallSkillFlags;
  const homeRoot = os.homedir();
  const target = flgs.target ? expandHome(flgs.target, homeRoot) : '';

  const result = applyInstallSkill({
    target,
    configRoot: configDir(),
    homeRoot,
  });

  return {
    json: result,
    pretty: c => {
      writeLine(success(c, `Skill installed at: ${result.target}`));
      writeLine(`  ${dim(c, 'SKILL.md →')} ${result.canonicalSkill}`);
      if (result.canonicalRecipes) {
        writeLine(`  ${dim(c, 'recipes/ →')} ${result.canonicalRecipes}`);
      }
      for (const s of result.symlinks) {
        if (s.status === 'failed') {
          writeLine(warn(c, `  ${s.kind} link failed: ${s.error}`));
        } else {
          writeLine(`  ${dim(c, s.status + ':')} ${s.path}`);
        }
      }
      writeLine(`  ${dim(c, 'agents: open a fresh session in this host to load the skill.')}`);
    },
  };
};

export function installSkill(flags: InstallSkillFlags): Promise<never> {
  return runCommand('install-skill', flags, cmd);
}

/**
 * Shared primitives for the skill-bundle commands (`update-skill`,
 * `install-skill`, `skill-paths`).
 *
 * The canonical layout under `~/.lwr/skill/` is:
 *
 *   ~/.lwr/skill/SKILL.md          ← entry point (auto-loaded by hosts)
 *   ~/.lwr/skill/recipes/*.md      ← on-demand referenced files
 *
 * Each detected AI tool's skill folder symlinks to that canonical:
 *
 *   <tool-skills-root>/lw-redmine/SKILL.md  → canonical SKILL.md
 *   <tool-skills-root>/lw-redmine/recipes   → canonical recipes/ (dir symlink)
 *
 * Three commands manipulate this bundle:
 *   - `update-skill` snapshots from the repo + relinks every detected tool.
 *   - `install-skill --target X` symlinks into one named target (for
 *     unsupported hosts or repair).
 *   - `skill-paths` reports the canonical paths + per-tool link state
 *     without writing anything.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SKILL_FILE_NAME = 'SKILL.md';
export const RECIPES_DIR_NAME = 'recipes';
export const SKILL_NAME = 'lw-redmine';

/**
 * Each AI tool's expected skill location, relative to $HOME. Kept in
 * sync with install.mjs by hand — same list, same semantics.
 */
export const AI_TOOL_SKILL_RELS: ReadonlyArray<{ name: string; rel: string }> = [
  { name: 'Claude Code', rel: '.claude/skills' },
  { name: 'GitHub Copilot', rel: '.copilot/skills' },
  { name: 'Codex CLI', rel: '.codex/skills' },
  { name: 'Gemini Antigravity', rel: '.gemini/antigravity/skills' },
];

export type LinkStatus = 'created' | 'refreshed' | 'skipped-not-installed' | 'failed';

export interface SymlinkRecord {
  tool: string;
  path: string;
  status: LinkStatus;
  error?: string;
  /** Whether this entry refers to the SKILL.md file or the recipes/ directory. */
  kind: 'skill' | 'recipes';
}

/**
 * Idempotently replace a symlink under `skillRoot/<name>` so it points
 * at `target`. Existing symlinks (or directories left by older installs)
 * are removed first. Returns a structured record for the JSON envelope.
 *
 * Used by both `update-skill` (auto-detect mode) and `install-skill`
 * (manual --target mode) — same primitive, different drivers.
 */
export function replaceSymlink(
  toolName: string,
  skillRoot: string,
  name: string,
  target: string,
  kind: 'skill' | 'recipes',
  type: 'file' | 'dir',
): SymlinkRecord {
  const link = path.join(skillRoot, name);
  let status: LinkStatus = 'created';
  if (fs.existsSync(link) || isLink(link)) {
    try {
      const st = fs.lstatSync(link);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        fs.rmSync(link, { recursive: true, force: true });
      } else {
        fs.unlinkSync(link);
      }
      status = 'refreshed';
    } catch (err) {
      return { tool: toolName, path: link, status: 'failed', error: errMsg(err), kind };
    }
  }
  try {
    fs.symlinkSync(target, link, type);
    return { tool: toolName, path: link, status, kind };
  } catch (err) {
    return { tool: toolName, path: link, status: 'failed', error: errMsg(err), kind };
  }
}

function isLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `lwr uninstall`
 *
 * Full reset. Removes:
 *
 *   1. The OS keychain entry / `~/.lwr/auth.json` for every profile.
 *   2. The entire `~/.lwr/` directory (config, profiles, caches, issues, me.md).
 *   3. AI tool skill symlinks at `~/.claude|.copilot|.codex|.gemini/.../skills/lw-redmine/SKILL.md`.
 *   4. The npm-linked `lwr` binary (`npm unlink -g <pkg>`).
 *
 * After this command exits, `lwr` is gone from PATH and no state remains
 * on disk. To reinstall, clone the repo again and run `node install.mjs install`.
 *
 * Requires double confirmation — TTY: type `uninstall` then `YES`;
 * agents: pass `--confirm "uninstall" --yes`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { confirmDestructive, type DoubleConfirmFlags } from '../foundation/confirm';
import { loadConfig } from '../foundation/config';
import { deleteApiKey } from '../foundation/auth';
import { configDir } from '../foundation/paths';
import { writeLine } from '../foundation/output';
import { success, dim, warn } from '../foundation/format';

const SKILL_NAME = 'lw-redmine';

/**
 * Each AI tool's expected skill location, relative to $HOME. Mirrors the
 * list in `install.mjs` — kept in sync manually because the installer
 * runs without lwr's source on disk after install (npm-linked).
 */
const AI_TOOL_SKILL_RELS: ReadonlyArray<{ name: string; rel: string }> = [
  { name: 'Claude Code', rel: '.claude/skills' },
  { name: 'GitHub Copilot', rel: '.copilot/skills' },
  { name: 'Codex CLI', rel: '.codex/skills' },
  { name: 'Gemini Antigravity', rel: '.gemini/antigravity/skills' },
];

export interface UninstallFlags extends GlobalFlags, DoubleConfirmFlags {}

interface UninstallPayload {
  removedKeychainProfiles: string[];
  removedLwrDir: boolean;
  removedSkillSymlinks: string[];
  npmUnlinked: boolean;
}

const cmd: CommandFn<UninstallPayload> = async (flags, ctx): Promise<CommandResult<UninstallPayload>> => {
  const flgs = flags as UninstallFlags;
  const HOME = os.homedir();
  const lwrDir = configDir();

  // Snapshot affected paths before any deletion so the confirm prompt
  // can list them. Once confirmed, we re-walk to delete.
  const skillTargets = AI_TOOL_SKILL_RELS.map(t => ({
    name: t.name,
    target: path.join(HOME, t.rel, SKILL_NAME, 'SKILL.md'),
    parent: path.join(HOME, t.rel, SKILL_NAME),
  }));
  const presentSkills = skillTargets.filter(t => exists(t.target));

  const cfg = loadConfigSafe();
  const profileNames = cfg ? Object.keys(cfg.profiles) : [];

  await confirmDestructive({
    action: 'uninstall',
    description: 'completely remove lw-redmine — credentials for every profile, ~/.lwr/, all AI-tool skill symlinks, and the lwr binary itself',
    affectedPaths: [
      ...profileNames.map(p => `keychain entry for profile "${p}"`),
      ...(fs.existsSync(lwrDir) ? [lwrDir] : []),
      ...presentSkills.map(t => t.target),
      'npm-linked lwr binary (`npm unlink -g`)',
    ],
    ctx,
    flags: { confirm: flgs.confirm, yes: flgs.yes },
  });

  // === STEP 0: resolve npm-package metadata BEFORE any deletion ===
  // The binary's repo is found via `which lwr` → realpath. If the user
  // ran us from inside `~/.lwr/` (which we're about to delete), waiting
  // until after the rmtree would leave Node with an invalid cwd and
  // `spawnSync('which')` would fail — falling back to a default name
  // that doesn't match the real `@scope/...` and missing the unlink.
  // Pin the name now so the unlink at the end works regardless of cwd.
  const pkgName = resolvePkgName() ?? 'lw-redmine';

  // Move out of any cwd inside ~/.lwr so subsequent shell-outs
  // (npm unlink) don't run with a stale-or-deleted working directory.
  try {
    process.chdir(HOME);
  } catch {
    // If even $HOME is gone, give up on chdir; npm will fail later.
  }

  // 1. Drop credentials for every known profile (keychain + auth.json).
  const removedKeychainProfiles: string[] = [];
  for (const name of profileNames) {
    try {
      const r = await deleteApiKey(name);
      if (r.keychain || r.file) removedKeychainProfiles.push(name);
    } catch {
      // best-effort; we're nuking everything anyway
    }
  }

  // 2. Remove ~/.lwr/ entirely. config.json, all caches, all issues, me.md, auth.json fallback.
  let removedLwrDir = false;
  if (fs.existsSync(lwrDir)) {
    try {
      fs.rmSync(lwrDir, { recursive: true, force: true });
      removedLwrDir = true;
    } catch {
      // best-effort
    }
  }

  // 3. AI tool skill symlinks. Remove the symlink and the now-empty
  //    lw-redmine/ subdir under each tool's skills/ folder.
  const removedSkillSymlinks: string[] = [];
  for (const t of skillTargets) {
    if (!exists(t.target)) continue;
    try {
      fs.unlinkSync(t.target);
      removedSkillSymlinks.push(t.target);
      // Best-effort: drop the lw-redmine/ dir if empty.
      if (fs.existsSync(t.parent) && fs.readdirSync(t.parent).length === 0) {
        fs.rmdirSync(t.parent);
      }
    } catch {
      // best-effort
    }
  }

  // 4. npm unlink — last step. The binary is currently executing; on
  //    POSIX, unlinking an open file is fine (the FD stays valid until
  //    process exit), so the rest of this function still completes.
  //    No further `lwr` invocations will resolve afterward.
  //
  //    Capture stderr so a failure shows *why* — common causes are
  //    permission issues on the npm prefix or a stale npm-link state.
  let npmUnlinked = false;
  let npmUnlinkError: string | undefined;
  try {
    // execFile (not exec) so the package name is passed as an argv entry
    // — never shell-interpolated. A malicious package.json `name` field
    // (e.g. from a forked install) cannot escape into a shell command.
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmBin, ['unlink', '-g', pkgName], {
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: HOME,
    });
    npmUnlinked = true;
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    npmUnlinkError = stderr || e.message || 'unknown error';
  }
  // Surface the manual fallback in the payload so the agent (or human)
  // can finish the job without guessing the package name.
  const manualUnlinkCommand = `npm unlink -g ${pkgName}`;

  return {
    json: {
      removedKeychainProfiles,
      removedLwrDir,
      removedSkillSymlinks,
      npmUnlinked,
      ...(npmUnlinked
        ? {}
        : { npmUnlinkError, manualUnlinkCommand }),
    } as UninstallPayload & { npmUnlinkError?: string; manualUnlinkCommand?: string },
    pretty: c => {
      writeLine(success(c, 'lw-redmine uninstalled.'));
      if (removedKeychainProfiles.length > 0) {
        writeLine(`  ${dim(c, 'credentials removed for:')} ${removedKeychainProfiles.join(', ')}`);
      }
      if (removedLwrDir) writeLine(`  ${dim(c, 'removed:')} ${lwrDir}`);
      for (const p of removedSkillSymlinks) writeLine(`  ${dim(c, 'unlinked skill:')} ${p}`);
      if (npmUnlinked) {
        writeLine(`  ${dim(c, `npm unlinked: ${pkgName}`)}`);
      } else {
        writeLine(warn(c, `npm unlink failed (${npmUnlinkError ?? 'unknown'}).`));
        writeLine(`  ${dim(c, 'finish manually:')} ${manualUnlinkCommand}`);
      }
    },
  };
};

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function loadConfigSafe(): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * Walks up from the running binary to find the repo's package.json and
 * returns its `name` (e.g. `"@sibincbaby/lw-redmine"`). Used only to feed
 * `npm unlink -g <name>` — the unlink target must match the canonical
 * package name on disk, not a guess.
 *
 * Two ways the binary can be located:
 *
 *   1. `process.argv[1]` (fastest, doesn't depend on PATH or shell-outs).
 *      Set when invoked through the `lwr` symlink.
 *   2. `which lwr` (fallback if argv[1] is empty / non-symlink).
 *
 * Both resolve via `realpath` to the actual `dist/cli.js`, then walk one
 * dir up to find `package.json`. Returns null if either step fails.
 */
function resolvePkgName(): string | null {
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
      const pkg = path.join(repoRoot, 'package.json');
      if (fs.existsSync(pkg)) {
        const name = (JSON.parse(fs.readFileSync(pkg, 'utf8')).name as string) || null;
        if (name && name.length > 0) return name;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function uninstall(flags: UninstallFlags): Promise<never> {
  return runCommand('uninstall', flags, cmd);
}

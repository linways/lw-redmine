#!/usr/bin/env node
/**
 * lw-redmine installer / updater.
 *
 * One entry point for both humans and AI agents:
 *
 *   node install.mjs install     — first-time setup
 *   node install.mjs update      — pull latest, rebuild, refresh skill
 *   node install.mjs status      — what's installed where
 *   node install.mjs uninstall   — remove binary link + all skill symlinks
 *                                  (preserves ~/.lwr/ user data)
 *
 * Architecture:
 *
 *   repo/SKILL.md ──(copy at install/update)──▶ ~/.lwr/skill/SKILL.md
 *                                                       ▲
 *                                                       │ (symlinks)
 *                                                       │
 *   ~/.claude/skills/lw-redmine/SKILL.md ────────────────┤
 *   ~/.copilot/skills/lw-redmine/SKILL.md ───────────────┤
 *   ~/.codex/skills/lw-redmine/SKILL.md ─────────────────┤
 *   ~/.gemini/antigravity/skills/lw-redmine/SKILL.md ────┘
 *
 * Each AI tool symlinks to the canonical snapshot, so an update touches
 * one file and every tool sees the new content. The snapshot is a
 * *copy* (not a symlink to the repo) so the installed state doesn't
 * change under agents while they're running.
 *
 * Zero runtime deps — Node stdlib only, so this script runs before
 * `npm install` if needed.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const LWR_DIR = path.join(HOME, '.lwr');
const SKILL_DIR = path.join(LWR_DIR, 'skill');
const CANONICAL_SKILL = path.join(SKILL_DIR, 'SKILL.md');
const CANONICAL_RECIPES = path.join(SKILL_DIR, 'recipes');
const REPO_SKILL = path.join(REPO_ROOT, 'SKILL.md');
const REPO_RECIPES = path.join(REPO_ROOT, 'recipes');
const SKILL_NAME = 'lw-redmine';
const REPO_DIST = path.join(REPO_ROOT, 'dist', 'cli.js');
const REPO_PKG = path.join(REPO_ROOT, 'package.json');

/**
 * Permission rules we inject into Claude Code's user settings so the
 * agent can use lwr without firing prompts on every call. Two surgical
 * rules — neither grants anything beyond lwr's own footprint:
 *
 *   - `Read(~/.lwr/**)` — read profile, me.md, caches. Nothing else.
 *   - `Bash(lwr:*)`     — invoke any `lwr <subcommand>`. Safe because
 *                         lwr's destructive verbs (`uninstall`,
 *                         `clear-data`, `auth logout`) gate themselves
 *                         with `--confirm "<action>" --yes`; granting
 *                         Bash access doesn't bypass those.
 */
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const CLAUDE_PERMISSION_RULES = ['Read(~/.lwr/**)', 'Bash(lwr:*)'];

/**
 * Each AI tool we support. `parent` is the dotdir we probe to decide
 * whether the tool is installed; `skillsRel` is the path under $HOME
 * where the tool expects skill folders.
 */
const AI_TOOLS = [
  { id: 'claude-code', name: 'Claude Code', parent: '.claude', skillsRel: '.claude/skills' },
  { id: 'copilot', name: 'GitHub Copilot', parent: '.copilot', skillsRel: '.copilot/skills' },
  { id: 'codex', name: 'Codex CLI', parent: '.codex', skillsRel: '.codex/skills' },
  { id: 'antigravity', name: 'Gemini Antigravity', parent: '.gemini', skillsRel: '.gemini/antigravity/skills' },
];

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// ---------------------------------------------------------------------------
// Entry point

function main() {
  const arg = process.argv[2] ?? 'install';
  switch (arg) {
    case 'install':
      return install();
    case 'update':
      return update();
    case 'update-skill':
      return updateSkillOnly();
    case 'status':
      return status();
    case 'uninstall':
      return uninstall();
    case '--help':
    case '-h':
    case 'help':
      return printHelp();
    default:
      console.error(`Unknown command: ${arg}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp() {
  console.log(`lw-redmine installer

Usage:
  node install.mjs <command>

Commands:
  install        First-time setup: build, link binary, install skill in detected AI tools
  update         Pull latest, rebuild, refresh canonical skill (idempotent)
  update-skill   Skill-only refresh — copy SKILL.md to canonical and re-link AI tools (no git/npm/build)
  status         Show what's installed where, with freshness
  uninstall      Remove binary link + skill symlinks (preserves ~/.lwr user data)

After install, run:  lwr auth login
`);
}

// ---------------------------------------------------------------------------
// Commands

function install() {
  header('lw-redmine installer');

  ensureRepo();
  ensureNode();
  ensureDeps();
  ensureBuild();
  linkBinary();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();
  printNextSteps();
}

function update() {
  header('lw-redmine updater');

  ensureRepo();
  pullIfClean();
  ensureDeps({ forceCheck: true });
  build();
  linkBinary();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();

  console.log();
  ok('Update complete.');
  printDoctorHint();
}

/**
 * Skill-only refresh — fast path when SKILL.md changed but nothing else.
 * Skips git, dependency install, build, and binary linking; just re-snapshots
 * the canonical skill and re-creates AI-tool symlinks.
 */
function updateSkillOnly() {
  header('lw-redmine — skill update only');
  ensureRepo();
  refreshCanonicalSkill();
  installAllSkills();
  installClaudePermissions();
  console.log();
  ok('Skill refreshed. Open a fresh agent session to load the new content.');
}

function status() {
  header('lw-redmine status');

  const lwrPath = whichLwr();
  if (lwrPath) {
    ok(`lwr binary: ${lwrPath}`);
  } else {
    warn('lwr binary not on PATH');
  }

  if (fs.existsSync(CANONICAL_SKILL)) {
    const stat = fs.statSync(CANONICAL_SKILL);
    ok(`canonical skill: ${CANONICAL_SKILL} (${humanAge(Date.now() - stat.mtimeMs)})`);
  } else {
    warn(`canonical skill missing: ${CANONICAL_SKILL}`);
  }

  if (fs.existsSync(CANONICAL_RECIPES) && fs.statSync(CANONICAL_RECIPES).isDirectory()) {
    const recipeFiles = fs.readdirSync(CANONICAL_RECIPES).filter(f => f.endsWith('.md'));
    ok(`canonical recipes: ${CANONICAL_RECIPES} (${recipeFiles.length} file${recipeFiles.length === 1 ? '' : 's'})`);
  } else {
    console.log(`  ${C.dim}— canonical recipes/ not present${C.reset}`);
  }

  console.log();
  console.log('Claude Code permissions:');
  reportClaudePermissions();

  console.log();
  console.log('AI tools:');
  for (const tool of AI_TOOLS) {
    const target = path.join(HOME, tool.skillsRel, SKILL_NAME, 'SKILL.md');
    if (!toolDetected(tool)) {
      console.log(`  ${C.dim}—${C.reset} ${tool.name} ${C.dim}(not installed)${C.reset}`);
      continue;
    }
    if (fs.existsSync(target) || isBrokenSymlink(target)) {
      const t = readSymlink(target);
      const points = t === CANONICAL_SKILL ? 'canonical' : `(other: ${t})`;
      ok(`${tool.name} ↦ ${points}`);
    } else {
      warn(`${tool.name} detected but skill not installed`);
    }
  }
}

function uninstall() {
  header('lw-redmine uninstaller');

  console.log('Removing Claude Code permission rules…');
  uninstallClaudePermissions();

  console.log('\nRemoving AI tool skill symlinks…');
  for (const tool of AI_TOOLS) {
    const skillDir = path.join(HOME, tool.skillsRel, SKILL_NAME);
    const target = path.join(skillDir, 'SKILL.md');
    const recipesTarget = path.join(skillDir, 'recipes');
    let removed = false;
    if (fs.existsSync(target) || isBrokenSymlink(target)) {
      try {
        fs.unlinkSync(target);
        removed = true;
      } catch (err) {
        warn(`failed to remove ${target}: ${(err && err.message) || err}`);
      }
    }
    if (fs.existsSync(recipesTarget) || isBrokenSymlink(recipesTarget)) {
      try {
        const st = fs.lstatSync(recipesTarget);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          fs.rmSync(recipesTarget, { recursive: true, force: true });
        } else {
          fs.unlinkSync(recipesTarget);
        }
        removed = true;
      } catch (err) {
        warn(`failed to remove ${recipesTarget}: ${(err && err.message) || err}`);
      }
    }
    if (removed) {
      // Remove the lw-redmine subdir if it becomes empty.
      if (fs.existsSync(skillDir) && fs.readdirSync(skillDir).length === 0) {
        fs.rmdirSync(skillDir);
      }
      ok(`removed ${tool.name}`);
    }
  }

  console.log('\nUnlinking lwr binary…');
  // Read package.json to get the canonical npm name (handles scoped packages).
  let pkgName = 'lw-redmine';
  try {
    pkgName = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8')).name || pkgName;
  } catch {
    // ignore
  }
  try {
    execSync(`npm unlink -g ${pkgName}`, { stdio: 'pipe' });
    ok(`npm unlink ${pkgName}`);
  } catch {
    warn('npm unlink failed — you may need to remove the binary manually');
  }

  console.log();
  console.log(`${C.dim}~/.lwr/ is preserved (auth credentials, profile, cache).`);
  console.log(`Delete it manually if you want a full reset:  rm -rf ~/.lwr${C.reset}`);
}

// ---------------------------------------------------------------------------
// Steps — install

function ensureRepo() {
  if (!fs.existsSync(REPO_PKG)) {
    fail(`Not a lw-redmine repo (missing package.json at ${REPO_ROOT})`);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(REPO_PKG, 'utf8'));
    // Accept both bare and scoped names (e.g. @sibincbaby/lw-redmine).
    if (!pkg.name || !pkg.name.endsWith('lw-redmine')) {
      fail(`package.json is not lw-redmine (got "${pkg.name}")`);
    }
  } catch (err) {
    fail(`Failed to parse package.json: ${(err && err.message) || err}`);
  }
}

function ensureNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    fail(`Node ≥ 20 required (running ${process.versions.node}). Upgrade Node and retry.`);
  }
}

function ensureDeps({ forceCheck = false } = {}) {
  const nodeModules = path.join(REPO_ROOT, 'node_modules');
  if (!fs.existsSync(nodeModules) || forceCheck) {
    step('Installing npm dependencies…');
    runOrFail('npm install', { cwd: REPO_ROOT });
  } else {
    skip('npm dependencies already present');
  }
}

function ensureBuild() {
  if (!fs.existsSync(REPO_DIST)) {
    build();
  } else {
    skip(`build artefacts present (${REPO_DIST})`);
  }
}

function build() {
  step('Building TypeScript…');
  runOrFail('npm run build', { cwd: REPO_ROOT });
}

function linkBinary() {
  const lwrPath = whichLwr();
  if (lwrPath && lwrPath.startsWith(REPO_ROOT)) {
    skip(`lwr already linked to this repo (${lwrPath})`);
    return;
  }
  step('Linking lwr binary globally (npm link)…');
  runOrFail('npm link', { cwd: REPO_ROOT });
  const after = whichLwr();
  if (!after) {
    fail('npm link succeeded but `lwr` is not on PATH. Check your npm global bin: `npm bin -g`.');
  }
  ok(`lwr linked: ${after}`);
}

function refreshCanonicalSkill() {
  if (!fs.existsSync(REPO_SKILL)) {
    fail(`Source SKILL.md missing at ${REPO_SKILL}`);
  }
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.copyFileSync(REPO_SKILL, CANONICAL_SKILL);
  // Track when we wrote it so `status` can show age.
  fs.utimesSync(CANONICAL_SKILL, new Date(), new Date());
  ok(`canonical skill snapshot → ${CANONICAL_SKILL}`);

  // Recipes ship alongside SKILL.md so the agent can pull them on
  // demand. We mirror the entire repo `recipes/` into the canonical
  // location — wipe-and-recopy keeps the snapshot in sync if a recipe
  // was removed upstream.
  if (fs.existsSync(REPO_RECIPES) && fs.statSync(REPO_RECIPES).isDirectory()) {
    if (fs.existsSync(CANONICAL_RECIPES)) {
      fs.rmSync(CANONICAL_RECIPES, { recursive: true, force: true });
    }
    fs.cpSync(REPO_RECIPES, CANONICAL_RECIPES, { recursive: true });
    const count = fs.readdirSync(CANONICAL_RECIPES).filter(f => f.endsWith('.md')).length;
    ok(`canonical recipes snapshot → ${CANONICAL_RECIPES} (${count} file${count === 1 ? '' : 's'})`);
  }
}

function installAllSkills() {
  console.log('\nInstalling skill into detected AI tools:');
  let any = false;
  for (const tool of AI_TOOLS) {
    if (!toolDetected(tool)) {
      console.log(`  ${C.dim}—${C.reset} ${tool.name} ${C.dim}(${tool.parent}/ not present — skipping)${C.reset}`);
      continue;
    }
    installSkillFor(tool);
    any = true;
  }
  if (!any) {
    warn('No AI tools detected. Install Claude Code / Codex CLI / Copilot / Antigravity first, then re-run install.');
  }
}

/**
 * Inject `Read(~/.lwr/**)` into Claude Code's user-level
 * `settings.json` so the agent can read `~/.lwr/me.md` (and the rest
 * of lwr's state) without firing a permission prompt on every session
 * start.
 *
 * The rule is **scoped** to `~/.lwr/` — adding it doesn't grant the
 * agent access to anything else on the filesystem. The settings file
 * itself is user-global (`~/.claude/settings.json`) but that's just
 * where Claude Code reads personal rules from; nothing about other
 * projects' permissions changes.
 *
 * Idempotent: rules that already exist are left untouched. Only writes
 * the file when something actually changed. Skips silently if Claude
 * Code's parent dir (`~/.claude/`) doesn't exist — the user just
 * doesn't have Claude Code installed.
 */
/**
 * Read-only inspection of Claude Code permission state. Used by `status`.
 */
/**
 * Inverse of `installClaudePermissions` — remove the rules we added.
 * Idempotent: missing rules are no-ops. Empty `permissions.allow` is
 * left as `[]` (we don't drop user-authored entries).
 */
function uninstallClaudePermissions() {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    skip('Claude Code settings.json not present');
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    warn('Claude settings.json malformed — skipping');
    return;
  }
  if (!Array.isArray(settings?.permissions?.allow)) {
    skip('No permission rules to remove');
    return;
  }
  const before = settings.permissions.allow.length;
  settings.permissions.allow = settings.permissions.allow.filter(r => !CLAUDE_PERMISSION_RULES.includes(r));
  const removed = before - settings.permissions.allow.length;
  if (removed === 0) {
    skip('Our permission rules already absent');
    return;
  }
  try {
    const tmp = `${CLAUDE_SETTINGS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    ok(`removed ${removed} permission rule(s) from Claude settings.json`);
  } catch (err) {
    warn(`failed to write settings.json: ${(err && err.message) || err}`);
  }
}

function reportClaudePermissions() {
  if (!fs.existsSync(path.join(HOME, '.claude'))) {
    console.log(`  ${C.dim}— Claude Code not installed${C.reset}`);
    return;
  }
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(`  ${C.dim}— ${CLAUDE_SETTINGS_PATH} doesn't exist (no permissions set yet)${C.reset}`);
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch (err) {
    warn(`settings.json malformed: ${(err && err.message) || err}`);
    return;
  }
  const allow = settings?.permissions?.allow ?? [];
  for (const rule of CLAUDE_PERMISSION_RULES) {
    if (allow.includes(rule)) {
      ok(rule);
    } else {
      console.log(`  ${C.yellow}⚠${C.reset}  ${rule} ${C.dim}(missing — re-run \`install\` or \`update-skill\` to add)${C.reset}`);
    }
  }
}

function installClaudePermissions() {
  const claudeDir = path.join(HOME, '.claude');
  if (!fs.existsSync(claudeDir)) {
    return; // Claude Code not installed; nothing to do
  }

  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        warn(`Claude settings.json isn't an object — skipping permission injection.`);
        return;
      }
    } catch (err) {
      warn(`Claude settings.json is malformed — skipping permission injection. (${(err && err.message) || err})`);
      return;
    }
  }

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  const before = new Set(settings.permissions.allow);
  const added = [];
  for (const rule of CLAUDE_PERMISSION_RULES) {
    if (!before.has(rule)) {
      settings.permissions.allow.push(rule);
      added.push(rule);
    }
  }

  if (added.length === 0) {
    skip('Claude Code permissions already grant Read(~/.lwr/**)');
    return;
  }

  // Atomic write — settings.json is critical to Claude Code so we
  // never leave it in a half-written state.
  const tmp = `${CLAUDE_SETTINGS_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
    ok(`Claude Code permissions: added ${added.join(', ')}`);
  } catch (err) {
    warn(`Failed to write Claude settings.json: ${(err && err.message) || err}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function installSkillFor(tool) {
  const skillDir = path.join(HOME, tool.skillsRel, SKILL_NAME);
  const link = path.join(skillDir, 'SKILL.md');
  const recipesLink = path.join(skillDir, 'recipes');

  fs.mkdirSync(skillDir, { recursive: true });

  // If link already exists (file or symlink), unlink and recreate idempotently.
  if (fs.existsSync(link) || isBrokenSymlink(link)) {
    try {
      fs.unlinkSync(link);
    } catch (err) {
      warn(`could not remove existing ${link}: ${(err && err.message) || err}`);
      return;
    }
  }

  try {
    fs.symlinkSync(CANONICAL_SKILL, link, 'file');
    ok(`${tool.name}: ${link} → ${C.dim}${CANONICAL_SKILL}${C.reset}`);
  } catch (err) {
    warn(`${tool.name}: failed to symlink — ${(err && err.message) || err}`);
    return;
  }

  // Mirror the recipes directory as a single directory symlink. SKILL.md
  // references files via relative paths (`recipes/work-log.md`), and the
  // agent's Read tool resolves them against this symlink target. Adding a
  // 5th recipe upstream auto-appears here on the next snapshot — no extra
  // install step needed.
  if (fs.existsSync(CANONICAL_RECIPES)) {
    if (fs.existsSync(recipesLink) || isBrokenSymlink(recipesLink)) {
      try {
        // unlinkSync handles symlinks (file OR dir) on POSIX; for safety
        // on a real directory leftover from older installs, fall back to
        // recursive remove.
        const st = fs.lstatSync(recipesLink);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          fs.rmSync(recipesLink, { recursive: true, force: true });
        } else {
          fs.unlinkSync(recipesLink);
        }
      } catch (err) {
        warn(`${tool.name}: could not remove existing ${recipesLink}: ${(err && err.message) || err}`);
        return;
      }
    }
    try {
      fs.symlinkSync(CANONICAL_RECIPES, recipesLink, 'dir');
      ok(`${tool.name}: ${recipesLink} → ${C.dim}${CANONICAL_RECIPES}${C.reset}`);
    } catch (err) {
      warn(`${tool.name}: failed to symlink recipes — ${(err && err.message) || err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Steps — update

function pullIfClean() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    skip('not a git repo — skipping git pull');
    return;
  }
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (dirty.status !== 0) {
    warn('git status failed — skipping pull');
    return;
  }
  if (dirty.stdout.trim().length > 0) {
    warn('working tree dirty — skipping `git pull`. Commit/stash to enable auto-pull on update.');
    return;
  }
  step('git pull…');
  const r = spawnSync('git', ['pull', '--ff-only'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) {
    warn('git pull failed — proceeding with current HEAD');
  }
}

// ---------------------------------------------------------------------------
// Helpers

function toolDetected(tool) {
  return fs.existsSync(path.join(HOME, tool.parent));
}

function isBrokenSymlink(p) {
  try {
    fs.lstatSync(p);
    return true; // symlink exists; whether broken or not, we'll unlink and remake
  } catch {
    return false;
  }
}

function readSymlink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return p;
  }
}

function whichLwr() {
  const r = spawnSync('which', ['lwr'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const trimmed = r.stdout.trim();
  if (trimmed.length === 0) return null;
  // Resolve symlink to its target so we can compare against REPO_DIST.
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

function runOrFail(cmd, opts = {}) {
  const r = spawnSync(cmd, { ...opts, shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    fail(`Command failed: ${cmd}`);
  }
}

function header(title) {
  console.log(`\n${C.bold}${title}${C.reset}\n`);
}

function step(msg) {
  console.log(`${C.dim}…${C.reset} ${msg}`);
}

function ok(msg) {
  console.log(`${C.green}✓${C.reset} ${msg}`);
}

function skip(msg) {
  console.log(`${C.dim}↷ ${msg}${C.reset}`);
}

function warn(msg) {
  console.log(`${C.yellow}⚠${C.reset}  ${msg}`);
}

function fail(msg) {
  console.error(`${C.red}✗${C.reset} ${msg}`);
  process.exit(1);
}

function humanAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function printNextSteps() {
  console.log(`
${C.bold}Next:${C.reset}
  ${C.green}lwr auth login${C.reset}       create your Redmine profile (one-time)

${C.bold}When the repo updates:${C.reset}
  ${C.green}git pull && node install.mjs update${C.reset}
  ${C.dim}or simply:${C.reset}
  ${C.green}node install.mjs update${C.reset}
`);
}

function printDoctorHint() {
  console.log(`${C.dim}Run \`node install.mjs status\` to inspect the install.${C.reset}`);
}

main();

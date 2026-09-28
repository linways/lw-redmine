# Changelog

All notable changes to **lwr** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`$LWR_API_KEY_COMMAND` auth backend** — a command that prints the API key on
  stdout, run once per invocation and never persisted. Covers every secret
  broker (1Password, `pass`, Vault, Muse/Jarvis authd surrogates) without
  per-vendor code, and makes `lwr` usable on hosts where no static key can be
  planted. Slots between `$LWR_API_KEY` and the keychain. New error code
  `AUTH_KEY_COMMAND_FAILED`; 10s timeout keeps the never-hang contract.
- **Muse skill host** — `install.mjs` now mirrors the skill bundle into
  `~/workspace/skills/lw-redmine` when that directory exists.
- **`MUSE.md`** — agent guide for Muse hosts, whose one rule is that the agent
  must never obtain the user's API key itself (no browser, no chat, no file);
  the only path is a Secure Vault connector plus the `$LWR_API_KEY_COMMAND`
  broker. Mirrored to `~/.lwr/skill/MUSE.md` alongside the canonical SKILL.md,
  referenced from SKILL.md's auth section and the README, and printed by
  `install.mjs` when Muse is the detected host — a doc only guides if it gets
  opened, and installer stdout is the one place an agent reliably reads.

### Changed

- **`keytar` is an optional dependency.** Its native build fails on restricted
  machines (no toolchain, no libsecret, non-root npm prefix) and used to abort
  the whole install, even though the file fallback would have worked. Install
  now retries with `--ignore-scripts` and warns instead of dying.
- **`npm link` failure no longer aborts the install.** It falls back to a
  `~/.local/bin/lwr` wrapper — agents can't `sudo`, and a good build shouldn't
  be discarded over a link step.
- **`lwr doctor`** reports the real key source (`flag` / `env` / `command` /
  `keychain` / `file`) instead of guessing `keychain or file`, and skips the
  keychain check entirely on a broker-managed install.
- **`lwr auth login`** stores nothing when `$LWR_API_KEY_COMMAND` is set — it
  builds the profile and reports `storage: none`. Previously it would have
  written a short-lived surrogate to the keychain or `auth.json`.

## [0.1.0] — 2026-05-24

Initial public release.

### Added

- **JSON envelope contract** (`schema: lwr/v1`) — every command returns a stable
  `{ ok, data, error, meta }` shape with typed `error.code` strings and distinct
  exit codes (see `src/constants/exit-codes.ts`).
- **Agent introspection** — `lwr commands --json` enumerates every leaf verb with
  safety, idempotency, and network annotations.
- **Bundled Claude Code skill** — `SKILL.md` + `recipes/` ship with the package
  and install into `~/.claude/skills/lw-redmine/` via `lwr install-skill`.
- **MCP transport** — `lwr serve --mcp` exposes the CLI surface as an MCP server.
- **Single-active-issue mutex** — discovery, reconciliation, and auto-pause keep
  Redmine status as the source of truth for what you're working on.
- **Discovery cache** — 60-second in-process cache + skip-refresh fast path when
  local pointer is already represented in discovery results.
- **Backup + retention** — `lwr backup create|list|prune`, `lwr restore`,
  `lwr issue prune` for bounded disk footprint.
- **Zero-setup onboarding** — `lwr auth login` auto-builds the profile (whoami +
  custom-field catalog + role detection) on first run.
- **Feedback + preferences** — `lwr feedback log` for incident capture,
  `lwr prefs add` for cross-agent shared rules.
- **Memory module** — Hindsight-inspired retain/recall for cross-session context.
- **Daily rollover handover** — `lwr issue handover` resolves overnight gaps in
  active-issue continuity.

### Security

- Path-traversal hardening for attachments (`safeAttachmentBasename`).
- Allow-list URL validation against the configured Redmine base
  (`assertAllowedRedmineUrl`).
- Untrusted-content wrappers for issue bodies and comments (`wrapUntrusted`).
- Scrubbed environment forwarding for spawned subprocesses (`scrubbedEnv`).

[0.1.0]: https://github.com/linways/lw-redmine/releases/tag/v0.1.0

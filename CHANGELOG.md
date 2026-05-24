# Changelog

All notable changes to **lwr** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/sibincbaby/lw-redmine/releases/tag/v0.1.0

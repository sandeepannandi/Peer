# Changelog

All notable changes to Peer are documented in this file.

## Unreleased

### Added

- ESLint and Prettier quality tooling with TypeScript-aware flat configuration.
- `lint`, `lint:fix`, `format`, `format:check`, and `ci` npm scripts.
- `AGENTS.md`, `CONTRIBUTING.md`, and project conventions for contributors.
- Tooling setup tests for scripts, dependencies, configuration, and required documentation.
- GitHub Actions CI pipeline (`.github/workflows/ci.yml`) running typecheck, lint, format-check, and tests on push/PR.
- Dependabot configuration (`.github/dependabot.yml`) for automated dependency updates.
- `.editorconfig` for cross-editor indentation and encoding consistency.
- `.claude/CLAUDE.md` workspace rules constraining Claude Code's review workspace to read-only inspection.

### Changed

- Standardized import ordering and formatting across source and test files.
- Removed unused test imports and an unnecessary regex escape.
- `better-sqlite3` dependency relaxed from exact pin `12.9.0` to `~12.9.0` (allows patch updates while staying compatible with Node 20).
- `src/context/pack.ts`: removed unnecessary `contextDir_` alias; replaced `content ?? ''` pattern with explicit null-check that skips unreadable files instead of writing empty placeholders.
- `README.md`: Prettier-formatted to fix non-ASCII character warnings.

## 0.1.0

### Added

- Cross-repository GitHub pull-request review pipeline.
- Shallow repository mirroring and SQLite symbol indexing.
- Lexical probe extraction and budget-capped context packing.
- Claude Code review execution with schema validation and one repair retry.
- GitHub PR review posting with inline comments and head-SHA deduplication.
- Webhook listener with signature verification.
- Local fixture mode for credential-free end-to-end testing.
- Environment doctor and security-focused test coverage.

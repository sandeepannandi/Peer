# Changelog

All notable changes to Peer are documented in this file.

## Unreleased

### Added

- ESLint and Prettier quality tooling with TypeScript-aware flat configuration.
- `lint`, `lint:fix`, `format`, `format:check`, and `ci` npm scripts.
- `AGENTS.md`, `CONTRIBUTING.md`, and project conventions for contributors.
- Tooling setup tests for scripts, dependencies, configuration, and required documentation.

### Changed

- Standardized import ordering and formatting across source and test files.
- Removed unused test imports and an unnecessary regex escape.

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

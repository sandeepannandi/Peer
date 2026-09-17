# Peer — Improvement Plan

## Project Summary

**Peer** is a cross-repo GitHub code-review bot (V1) built in TypeScript/Node.js. It mirrors an organisation's repositories, indexes symbols into SQLite, extracts probes (symbols, imports, routes, tables) from a PR diff, builds a budget-capped context pack from _other_ repositories, runs Claude Code (subscription auth) to review the diff against that pack, and posts a structured JSON review as GitHub PR inline comments — deduped per head commit.

**Stack:** TypeScript (strict, NodeNext), Node 20+, `better-sqlite3`, Octokit, `execa`, `commander`, `zod`, `pino`, `@anthropic-ai/claude-agent-sdk`. 98 tests / 23 suites, all passing. CLI-first with `--local` fixture mode for zero-credential testing.

**AI-assisted development note:** The Claude Code agent is the review engine; the surrounding pipeline (context retrieval, packing, formatting, posting) is deterministic code with unit tests — by design, so review quality is attributable and debuggable.

---

## Current State Assessment

### Strengths

- Clean modular architecture: `config / github / mirror / context / claude / review / webhook / local / store / util`
- 98 tests across 23 suites with dependency injection (stub Octokit, fake Claude query fn, temp dirs) — no network dependency in tests
- Security-conscious: installation-token redaction in git errors, `ANTHROPIC_API_KEY` guard at startup, webhook HMAC verification, emoji stripping from model output, credentials stripped from `.git/config`
- Budget-capped context packing with the "CTO packing bug" fix (pattern files can't starve source files)
- `--local` fixture mode enables fully offline end-to-end testing
- Strict TypeScript: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- ESLint + Prettier configured, AGENTS.md, CONTRIBUTING.md, CHANGELOG.md present
- `peer doctor` environment health check

### Gaps & Opportunities

| Area           | Gap                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure | No CI/CD pipeline (`.github/workflows/`), no `.editorconfig`, empty `.claude/` (no CLAUDE.md rules), no Dependabot config                                                                       |
| Code quality   | Minor smells: `contextDir_` alias in `pack.ts`, redundant `content ?? ''` after null check, dead `?? ''` on `split()` in `search.ts`, `README.md` has non-ASCII chars failing `format:check`    |
| Dependencies   | `better-sqlite3` pinned exactly to `12.9.0` (no caret/tilde)                                                                                                                                    |
| Reliability    | Single retry only on JSON parse failure; no GitHub API backoff; no workspace cleanup; no health endpoint; `CLAUDE_MODEL` not validated; webhook misses draft PRs and has no concurrency control |
| Testing        | No CLI integration tests; no tests for workspace cleanup, health endpoint, backoff, draft PR handling, or concurrency                                                                           |
| Observability  | No metrics; DB stores only dedup flag, not full review content; no verbose mode; no actionable error guidance                                                                                   |
| V2 features    | No semantic search, no job queue, no Check API, no comment resolution tracking, no config file support                                                                                          |

---

## Phase 1: Foundation & Tooling

**Goal:** Establish robust infrastructure, fix code quality debt, enable automated CI so all subsequent changes are validated by green gates.

| #   | Step                            | Files                            | Rationale                                                                                                 |
| --- | ------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Add GitHub Actions CI           | `.github/workflows/ci.yml` (new) | Automates `npm run ci` (typecheck + lint + format:check + test) on push/PR                                |
| 2   | Add `.editorconfig`             | `.editorconfig` (new)            | Normalize indentation, encoding, line endings across editors                                              |
| 3   | Add CLAUDE.md workspace rules   | `.claude/CLAUDE.md` (new)        | Constrains Claude Code (running in workspace dir) to read-only inspection of `diff.txt` + `context/` only |
| 4   | Fix README.md formatting        | `README.md`                      | Prettier flags non-ASCII apostrophes; `format:check` must pass in CI                                      |
| 5   | Fix code smells in `pack.ts`    | `src/context/pack.ts`            | Remove `contextDir_` alias; remove redundant `content ?? ''` after null check                             |
| 6   | Fix dead `?? ''` in `search.ts` | `src/context/search.ts`          | Tighten the `prefix()` helper type with `noUncheckedIndexedAccess`                                        |
| 7   | Unpin `better-sqlite3`          | `package.json`                   | Use `~12.9.0` to allow patch updates while staying compatible with Node 20 (v13+ requires Node 22)        |
| 8   | Add Dependabot config           | `.github/dependabot.yml` (new)   | Automated dependency updates with grouping                                                                |

**Validation:** `npm run ci` passes green.

---

## Phase 2: Reliability & Resilience

**Goal:** Make the system production-robust — retry on transient failures, manage resources, validate config, handle edge cases.

| #   | Step                           | Files                                      | Rationale                                                                                                                                                 |
| --- | ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Improve Claude retry logic     | `src/claude/runner.ts`                     | Retry on timeout, empty result, error-result events with exponential backoff. Configurable `CLAUDE_MAX_RETRIES`. Distinguish retryable from fatal errors. |
| 2   | GitHub API retry with backoff  | `src/github/*.ts`                          | Wrap Octokit calls with exponential backoff for 403 rate-limit and 5xx. Use `retry-after` header when available.                                          |
| 3   | Workspace lifecycle management | `src/util/workspace.ts`, `src/index.ts`    | Add `peer clean [--before <hours>]`; auto-prune at start of each review. Configurable `WORKSPACE_TTL_HOURS`.                                              |
| 4   | Health/readiness endpoint      | `src/webhook/server.ts`                    | `GET /health` → 200; `GET /metrics` → JSON with review counts                                                                                             |
| 5   | Validate `CLAUDE_MODEL`        | `src/config/env.ts`                        | Zod allowlist: `sonnet`, `opus`, `haiku`. Fail fast on typos.                                                                                             |
| 6   | Skip draft PRs in webhook      | `src/webhook/server.ts`                    | Check `pull_request.draft === true`, return 204                                                                                                           |
| 7   | Webhook concurrency control    | `src/webhook/server.ts`                    | Configurable semaphore (`WEBHOOK_MAX_CONCURRENT_REVIEWS`) to prevent resource exhaustion under bursts                                                     |
| 8   | Webhook retry / dead-letter    | `src/store/db.ts`, `src/webhook/server.ts` | Store failed webhook events in DB; background retry loop                                                                                                  |
| 9   | Add `--dry-run` flag           | `src/index.ts`                             | Build context pack + emit prompt but skip Claude call                                                                                                     |

**Validation:** All new behaviors unit-tested with stubs. `npm run ci` green.

---

## Phase 3: Testing — Coverage Gaps

**Goal:** Close all testing gaps, especially CLI dispatch and new reliability features.

| #   | Step                             | Files                                       | Rationale                                                                 |
| --- | -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | CLI integration tests            | `tests/cli/review.test.ts` (new)            | Command dispatch, option validation, error handling, `--local` end-to-end |
| 2   | Test workspace cleanup           | `tests/util/workspace.test.ts` (new)        | TTL pruning, recent dirs kept                                             |
| 3   | Test health endpoint             | `tests/webhook/server.test.ts` (extension)  | `GET /health` → 200; `GET /metrics` → JSON                                |
| 4   | Test Claude retry with backoff   | `tests/claude/runner.test.ts` (extension)   | Error-then-success, assert retry + backoff timing                         |
| 5   | Test GitHub API backoff          | `tests/github/backoff.test.ts` (new)        | 403 rate-limit → retry with delay                                         |
| 6   | Test draft PR skipping           | `tests/webhook/server.test.ts` (extension)  | Draft PR → 204, no review called                                          |
| 7   | Test `CLAUDE_MODEL` validation   | `tests/smoke.test.ts` (extension)           | Invalid model → throws; valid accepted                                    |
| 8   | Test concurrency semaphore       | `tests/webhook/server.test.ts` (extension)  | Concurrent webhooks bounded by max                                        |
| 9   | Test ANTHROPIC_API_KEY in errors | `tests/claude/security.test.ts` (extension) | No key leakage in any error path                                          |

**Validation:** 98 → ~140 tests, all passing. `npm run ci` green.

---

## Phase 4: Observability & Developer Experience

**Goal:** Make the system observable, debuggable, and pleasant to operate.

| #   | Step                      | Files                                | Rationale                                                                                 |
| --- | ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | Structured metrics        | `src/util/metrics.ts` (new)          | Counters: reviews attempted/succeeded/failed/deduped, Claude calls. Expose via `/metrics` |
| 2   | Persist full review in DB | `src/store/db.ts`                    | Extend `reviews` table with `findings_json`, `overall`, `context_files` for audit trail   |
| 3   | Actionable error messages | `src/index.ts`, `src/util/doctor.ts` | Common failure modes get guidance ("run `peer doctor`", "run `claude login`")             |
| 4   | Verbose mode              | `src/config/env.ts`, `src/index.ts`  | `--verbose` CLI flag sets debug log level; review pipeline logs each phase                |
| 5   | Review summary in console | `src/review/pipeline.ts`             | Print concise summary (verdict, findings count, posted count)                             |
| 6   | Auto-prune workspaces     | `src/util/workspace.ts`              | Call `pruneWorkspaces()` at start of each review                                          |

---

## Phase 5: Advanced Features (V2 — opt-in)

| #   | Step                           | Rationale                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------- |
| 1   | Semantic context retrieval     | Optional embedding-based similarity search alongside lexical              |
| 2   | Background job queue           | Replace fire-and-forget with bounded in-process queue (or BullMQ + Redis) |
| 3   | GitHub Check API               | Post reviews as checks with diff annotations                              |
| 4   | PR comment resolution tracking | Detect resolved findings, avoid re-reporting                              |
| 5   | Config file support            | `.peerrc.ts` for project-level review config                              |
| 6   | `peer report` command          | Generate standalone HTML/PDF report from `review.json`                    |

---

## Implementation Order

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
```

Each phase depends on the previous one's CI being green. Phase 2 and Phase 3 are developed together (feature + tests).

## Quality Gate (per AGENTS.md)

```sh
npm run ci    # typecheck + lint + format:check + test
```

## Security Principles (non-negotiable)

- Reviews run through Claude Code only — **never** a direct Anthropic API call
- GitHub App tokens are short-lived, redacted from errors, stripped from mirror remotes
- Webhook payloads verified with `X-Hub-Signature-256`
- Context files include repository and path headers and never include the PR repository
- Review output validated against `ReviewSchema` before formatting or posting
- Posted reviews deduplicated by owner, repository, pull request, and head SHA
- `--local` mode provides zero-credential end-to-end testing

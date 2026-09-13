# Peer — Improvement Plan

## Project Summary

**Peer** is a cross-repo GitHub code-review bot. It mirrors an org's repos → indexes symbols into SQLite → extracts probes (symbols, imports, routes, tables) from a PR diff → builds a budget-capped context pack from *other* repos → invokes Claude Code (via subscription auth) to review the diff against the pack → posts structured JSON findings as GitHub PR review inline comments, deduped per head commit.

**Tech stack:** TypeScript (strict, NodeNext), Node 20+, `better-sqlite3`, Octokit, `execa`, `commander`, `zod`, `pino`, `@anthropic-ai/claude-agent-sdk`. Tests via Vitest (95 tests / 22 suites). CLI-first with `--local` fixture mode for zero-credential testing.

## Current State Assessment

### Strengths
- Clean modular architecture (config/github/mirror/context/claude/review/webhook/local/store/util)
- Solid test coverage with dependency injection (stub Octokit, fake Claude query fn, temp dirs)
- Security-conscious: token redaction in git errors, `ANTHROPIC_API_KEY` guard, webhook HMAC verification, emoji stripping from model output, credential never persisted in `.git/config`
- Budget-capped context packing with the "CTO packing bug" fix (pattern files can't starve source files)
- `--local` fixture mode enables fully offline testing
- Strict TypeScript config with good strictness flags

### Gaps & Opportunities

1. **No linting or formatting** — no ESLint, no Prettier. Codebase relies solely on `tsc --noEmit` for type checking.
2. **No CI pipeline** — no GitHub Actions / CI config at all.
3. **No AGENTS.md** — README references AGENTS.md as an org pattern file, but the project has none to define its own conventions.
4. **No CONTRIBUTING.md / CHANGELOG.md** — barrier to external contribution.
5. **Workspace lifecycle unmanaged** — `data/workspace/` accumulates job directories (each review) indefinitely; no cleanup, no TTL.
6. **Single retry only on JSON parse failure** — `runClaudeReviewWithRetry` retries once only when the parsed text fails schema validation. Timeouts, empty results, and error-result events are unhandled (fail hard, no backoff).
7. **Webhook fire-and-forget** — review runs async with no queue or retry; a transient failure (GitHub API rate limit, Claude timeout) is logged and lost. No retry, no dead-letter, no rate-limit backoff.
8. **No health/readiness endpoint** on the webhook server — blind ops for bot mode.
9. **`CLAUDE_MODEL` not validated** — accepts any string; no allowlist against known Claude Code models.
10. **No tests for CLI dispatch / `index.ts`** — command parsing, option validation, error handling untested.
11. **No `.clinerules`/`ignore` for Claude workspace** — the workspace dir given to Claude Code contains diff.txt + context/, but no `.clinerules` constrains Claude's inspection scope or prevents reading sensitive files.
12. **`better-sqlite3` pinned to exact version** — `12.9.0` (no `^`), which blocks automatic patch updates.
13. **Minor code smells** — `contextDir_` alias in `pack.ts`, redundant `content ?? ''` after null check, `?? ''` on `split` result in `search.ts` (dead with `noUncheckedIndexedAccess`).

## Prioritized Next Steps

### Phase 1 — Foundation (high impact, low effort)

| # | Step | Rationale |
|---|------|-----------|
| 1 | **Add ESLint + Prettier** | Enforces code style, catches unused vars, import ordering. `package.json` devDeps + config files (`eslint.config.js`, `.prettierrc.json`). Wire `npm run lint` and `npm run format`. |
| 2 | **Add AGENTS.md** | Document project conventions: architecture map, coding standards, testing patterns (DI, temp dirs, stub functions), where to add CLI commands, security rules (no ANTHROPIC_API_KEY, token redaction). |
| 3 | **Add CONTRIBUTING.md** | Clone/run/test/lint instructions, test file conventions, how to add fixtures. |
| 4 | **Add CHANGELOG.md** | Track changes; start with the "CTO packing bug" fix noted in tests. |

### Phase 2 — Resilience & Production-Readiness

| # | Step | Rationale |
|---|------|-----------|
| 5 | **Improve Claude retry logic** | `src/claude/runner.ts`: retry on timeout/error-result in addition to JSON parse failure. Add exponential backoff. Distinguish retryable errors (timeout, rate limit) from fatal (invalid credentials, disallowed tool). |
| 6 | **Add GitHub API retry/backoff** | `src/github/auth.ts` / `src/github/pr.ts` / `src/mirror/mirror.ts`: wrap Octokit calls with exponential backoff for 403 rate-limit and 5xx errors. Prevents failed reviews from transient API issues. |
| 7 | **Workspace cleanup command** | Add `peer clean [--before <hours>]` or auto-TTL in `src/index.ts` + `src/util/`: prune `data/workspace/` dirs older than N hours. Or add a `pruneWorkspaces()` utility called before each review. |
| 8 | **Health endpoint for webhook** | `src/webhook/server.ts`: add `GET /health` returning 200 with status. Optionally `GET /metrics` for review counts. |
| 9 | **Validate `CLAUDE_MODEL`** | `src/config/env.ts`: add zod refinement to allowlist known models (`sonnet`, `opus`, `haiku`) to fail fast on typos. |

### Phase 3 — Process & Testing

| # | Step | Rationale |
|---|------|-----------|
| 10 | **Add GitHub Actions CI** | `.github/workflows/ci.yml`: `npm ci`, `tsc --noEmit`, `npm run lint`, `npm test` on push/PR. |
| 11 | **Add CLI integration tests** | `tests/cli/` — dispatch `peer review --local` via child process or direct import of commander, assert exit codes, output files (`review.json`, `review.md`). |
| 12 | **Add `.clinerules`** | In workspace dir or project root: instruct Claude to only read from `diff.txt` + `context/`, never modify files, never run shell. Reinforces `disallowedTools: ['Bash']` at the agent level. |

### Phase 4 — Optional / Longer-Term

| # | Step | Rationale |
|---|------|-----------|
| 13 | **Unpin `better-sqlite3`** | Use `^12.9.0` to allow patch updates, or add a Dependabot config. |
| 14 | **Add `.editorconfig`** | Normalize indentation/encoding across editors. |
| 15 | **Fix minor code smells** | Clean up `contextDir_` alias, redundant nullish coalescing, dead `?? ''` in `search.ts`. |
| 16 | **Batching/queueing for reviews** | README lists "no batching or queueing yet" as a limitation. A simple in-process queue or background job runner would allow handling multiple concurrent webhooks. |
| 17 | **Semantic retrieval** | Context retrieval is currently lexical. Consider an optional embedding-based semantic search as a future enhancement (marked as V2 in README). |

## Key Files Referenced

- `src/claude/runner.ts` — review retry logic (Step 5)
- `src/github/auth.ts` — Octokit auth, needs retry wrapper (Step 6)
- `src/context/pack.ts` — context pack builder, workspace creation (Step 7)
- `src/index.ts` — CLI commands, add `clean` command (Step 7)
- `src/webhook/server.ts` — add health endpoint (Step 8)
- `src/config/env.ts` — model validation (Step 9)
- `tests/local/e2e.test.ts` — existing e2e pattern to follow for CLI tests (Step 11)

## Validation Plan

After implementing Phase 1–3:

1. `npm run lint` passes with zero errors/warnings
2. `tsc --noEmit` passes (unchanged baseline)
3. `npm test` — 95+ tests pass (new CLI/integration tests added)
4. `peer review --owner X --repo Y --pr Z --local` works end-to-end (existing fixture)
5. `peer clean --before 1` removes old workspace dirs
6. Webhook `GET /health` returns 200
7. `CLAUDE_MODEL=invalid-model peer review --local` fails fast

## Out of Scope (V2)

- Semantic/contextual search (requires embedding service)
- Distributed queueing (Redis/bullmq)
- PR comment threading/resolution tracking
- GitHub Check API integration (vs PR reviews)
- Multi-turn review conversation

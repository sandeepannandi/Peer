# Peer

A cross-repo code-review bot for GitHub organisations. Peer reviews a pull request against relevant context from the **other repositories in the org** — catching API-contract breaks, duplicated logic, and org-pattern violations that a single-repo review would miss — then posts the result as a GitHub PR review with inline comments.

The review reasoning runs through **Claude Code** (subscription auth via `claude login`) — never a direct Anthropic API call.

## Highlights

- **Cross-repo context** — local mirror + SQLite symbol index, probe-based retrieval, budget-capped context pack
- **CLI-first, bot-ready** — one CLI plus a webhook listener sharing a single review pipeline
- **Structured output** — zod-validated JSON reviews, one repair retry, inline comments anchored to diff lines, deduped per head commit
- **Zero-credential proof** — `--local` fixture mode runs the full pipeline with no GitHub access or API key
- **Tested** — 85 tests across 19 suites; engine calls are dependency-injected, so tests never hit the network

## How it works

1. **Mirror** — shallow-clones the org's repositories and indexes their files and symbols into SQLite.
2. **Probe** — parses the PR diff into a numbered diff and extracts probe terms: symbols, imports, routes, tables.
3. **Context pack** — finds matching files in the *other* repos, ranks them, and stages the top files next to the numbered diff (capped by count and token budget), plus org pattern files (`AGENTS.md`, `README.md`).
4. **Review** — Claude Code reviews the diff against the pack and returns a single JSON review: summary, verdict, strengths, and findings with severity, category, file, line, suggestion, and cross-repo evidence.
5. **Post** — the JSON is schema-validated, findings are anchored to real new-file lines, and the review is posted as inline comments (or saved locally without `--post`).

## Requirements

- Node.js **20+**
- `git`
- Claude Code CLI, installed and logged in with your subscription (`claude login`)

## Setup

```sh
npm install
cp .env.example .env     # then fill in your credentials
npm run typecheck
npm test
```

Verify the environment with `peer doctor` (git, Claude Code, GitHub App credentials, SQLite).

## Usage

| Command | Description |
|---|---|
| `peer doctor` | Environment health check |
| `peer mirror --owner <org>` | Clone/refresh the org's repositories |
| `peer index --owner <org>` | Build the SQLite symbol index |
| `peer context --owner <org> --repo <r> --pr <n>` | Build and inspect a PR's context pack |
| `peer review --owner <org> --repo <r> --pr <n> [--post]` | Review a PR — save locally, or post to GitHub with `--post` |
| `peer review --owner <org> --repo <r> --pr <n> --local` | Full pipeline against bundled fixtures, no credentials |
| `peer webhook [--port <n>]` | Bot mode: auto-review PRs on `opened`/`synchronize` |

```sh
npm run dev -- review --owner acme --repo repo-a --pr 1 --local
./scripts/demo.sh <org> <repo> <pr> --post
```

## Configuration

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH` / `GITHUB_PRIVATE_KEY` | GitHub App credentials (one key source only) |
| `GITHUB_ORG` | Org whose repos are mirrored (defaults to the PR owner) |
| `GITHUB_WEBHOOK_SECRET`, `WEBHOOK_PORT` | Webhook bot mode |
| `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS` | Review engine (default `sonnet`, max 30 turns) |
| `REVIEW_MAX_CONTEXT_FILES`, `CONTEXT_TOKEN_BUDGET` | Context-pack sizing (defaults 12 files / 40k chars) |
| `MAX_REVIEW_COMMENTS` | Inline-comment cap (default 20) |
| `DATA_DIR`, `LOG_LEVEL` | Paths and logging |

## Project structure

```
src/
├── index.ts          CLI entry (commander)
├── config/env.ts     zod env schema + ANTHROPIC_API_KEY guard
├── github/           GitHub App auth, PR fetch, review posting
├── mirror/           shallow mirror, SQLite symbol index
├── context/          probes → cross-repo search → context pack
├── claude/           Claude Code runner + reviewer prompt
├── review/           zod schema, line mapping, posting, shared pipeline
├── webhook/          signature verification + PR event dispatch
├── local/            fixture mode (deterministic reviewer)
├── store/db.ts       SQLite schema + queries
└── util/             git wrapper (secret redaction), diff parser, doctor, logging
tests/                19 vitest suites, 85 tests, bundled fixture repos
```

## Security

- GitHub App **installation tokens** are minted per run, injected only into the git clone URL, stripped from the stored remote, and scrubbed from error output — never persisted.
- `.env`, `*.pem`, and `data/` are gitignored.
- Startup **fails fast if `ANTHROPIC_API_KEY` is set** — reviews never use a direct Anthropic API call.
- Webhook requests are verified with `X-Hub-Signature-256` before processing.

## Limitations

- Context retrieval is lexical (symbol/basename/content matching), not semantic.
- Findings must map to new-file lines inside diff hunks; unanchored findings are rendered in the review body instead.
- Each review is a single model call (~1–3 min); no batching or queueing yet.

## License

[MIT](LICENSE)

# Peer

A cross-repo GitHub code-review bot (V1). It reviews a pull request in one repository using relevant context pulled from **other repositories in the same GitHub org** — catching API-contract breaks, duplicated logic, and org-pattern violations that a single-repo review would miss.

The review reasoning runs through **Claude Code** (your Claude subscription via `claude login`) — never a direct Anthropic API call.

> **Status:** All phases complete (0–6). `peer review ... --post` runs the full pipeline end-to-end (fetch PR → lazy mirror+index → context pack → **Claude Code** → zod-validated review → inline-comment PR review, deduped per head commit). `peer webhook` runs the bot listener: it verifies `X-Hub-Signature-256` and auto-reviews PRs on `opened`/`synchronize` — the CLI and the webhook share one review pipeline. `peer doctor` checks the environment; `peer review --local` proves cross-repo awareness against bundled fixtures (no GitHub, no Claude).

## Prerequisites

- Node.js **20+** (tested on v20.19.0)
- `git`
- Claude Code CLI, installed and logged in with your subscription:

  ```sh
  npm install -g @anthropic-ai/claude-code
  claude login    # one-time
  ```

  **Do not** set `ANTHROPIC_API_KEY` — Peer refuses to start if it is present.

## Setup

```sh
npm install
cp .env.example .env    # then fill in your GitHub App credentials
npm run typecheck       # strict TypeScript — should pass
npm test                # unit tests
```

## Usage

```sh
npm run dev -- --help                                            # list commands
npm run dev -- doctor                                            # environment health check (git, Claude Code + auth, GitHub App, SQLite)
npm run dev -- review --owner <org> --repo <repo> --pr 42        # review a PR, save review.json + review.md locally
npm run dev -- review --owner <org> --repo <repo> --pr 42 --post # review AND post a GitHub PR review with inline comments
npm run dev -- mirror --owner <org>                              # clone/refresh org repos
npm run dev -- index --owner <org>                               # build SQLite index
npm run dev -- review --owner acme --repo repo-a --pr 1 --local  # full pipeline on bundled fixtures (no GitHub, no Claude)
npm run dev -- webhook                                           # bot mode: auto-review PRs on opened/synchronize
./scripts/demo.sh <org> <repo> <pr> [--post]                     # one-command demo
```

### Bot mode (webhook)

1. Set `GITHUB_WEBHOOK_SECRET` (and optionally `WEBHOOK_PORT`) in `.env`.
2. In your GitHub App settings, add a webhook pointing at your deployed server (e.g. `https://your-host/webhook`) with the same secret, and subscribe to the `pull_request` event.
3. Run `npm run dev -- webhook`. Every `opened`/`synchronize` PR event is verified by signature, then reviewed and posted using the same pipeline as the CLI.

Or build and run the compiled CLI:

```sh
npm run build
node dist/index.js --help
```

## Configuration

See `.env.example` for all variables: GitHub App (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH` / `GITHUB_PRIVATE_KEY`), Claude Code (`CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`), context-pack sizing (`REVIEW_MAX_CONTEXT_FILES`, `CONTEXT_TOKEN_BUDGET`), posting caps (`MAX_REVIEW_COMMENTS`), and `DATA_DIR` / `LOG_LEVEL`.

## Project structure

```
src/
├── index.ts          # CLI entry (commander)
├── config/env.ts     # zod env schema + load (with ANTHROPIC_API_KEY guard)
├── github/           # Octokit App auth, PR fetch, review posting
├── mirror/           # clone/fetch org repos, SQLite symbol index
├── context/          # diff probes → cross-repo search → context pack
├── claude/           # Claude Code runner + reviewer prompt
├── review/           # output schema, formatting, posting, shared pipeline
├── webhook/          # bot listener: signature verify + PR event dispatch
├── local/            # fixture mode: stage repos, load PRs, deterministic reviewer
├── store/db.ts       # SQLite init/queries
└── util/             # logger, git exec wrapper, diff parser, doctor
scripts/demo.sh       # one-command demo on a real PR
tests/                # vitest unit tests + local multi-repo fixtures
```

## How it works

1. **Mirror** the org's repositories locally (shallow clones) and build a lightweight SQLite file/symbol index.
2. **Fetch** the PR diff and extract *probe terms* (changed symbols, routes, imports, file basenames).
3. **Search** the other repos' index/content for matches and assemble a bounded **context pack**.
4. **Claude Code** (Agent SDK subprocess, subscription auth) reviews the diff against the context pack with read-only tools and returns a structured JSON review.
5. **Validate** the JSON, map findings to real PR line numbers, and **post** a GitHub review with inline comments (or save locally with `--local`).

See `PLAN.md` for the full architecture, decisions, and build phases.

## Decisions (summary)

| Decision | Rationale |
|---|---|
| CLI-first (webhook as stretch) | Matches the assignment; keeps V1 focused |
| Claude Code via Agent SDK subprocess | Real Claude Code binary → subscription auth, no API key |
| GitHub App (not PAT) | One install covers the whole org; short-lived tokens |
| Local mirror + SQLite index | No search-API rate limits; Claude reads full files |
| Structured JSON review (zod) | Deterministic, testable, maps to real inline comments |

## Roadmap

Phase 0 ✅ scaffold — Phase 1 ✅ GitHub App + mirror + index — Phase 2 ✅ PR fetch + probes + context pack — Phase 3 ✅ Claude Code runner — Phase 4 ✅ post review (dedup, inline comments) — Phase 5 ✅ doctor + local E2E fixtures + demo script — Phase 6 ✅ webhook bot listener.

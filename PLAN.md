# Peer — Cross-Repo GitHub Code-Review Bot (V1)

**Plan, Architecture & Build Guide**

> Take-home assignment: build a working V1 of a GitHub code-review bot that reviews a pull request with relevant context from other repositories in the organisation. The primary AI review workflow is powered by **Claude Code** (subscription), not a direct Anthropic API.

---

## 1. Executive Summary

We build **Peer**: a TypeScript CLI (extensible to a webhook-driven GitHub bot) that:

1. Takes a PR from any repo in a GitHub organisation.
2. Mirrors the organisation's repositories locally (shallow clones) and builds a lightweight file/symbol index (SQLite).
3. Extracts "probe terms" from the PR diff (changed filenames, function/class names, API routes, imports, schema tables).
4. Finds *relevant code in the other repos* that matches those probes and stages it into a scratch workspace as a **context pack**.
5. Runs the review reasoning through **Claude Code headlessly** (`@anthropic-ai/claude-agent-sdk` → the real Claude Code CLI as a subprocess, authenticated with the user's Claude subscription via `claude login`).
6. Validates the structured JSON review, maps findings to real GitHub line numbers, and posts it as a **GitHub PR review with inline comments** (or saves locally).

The V1 is deliberately focused: **CLI-first, review-only (no code edits), mirror+index context, GitHub App auth, inline-comment posting.** A webhook bot mode was designed as a stretch addition and is also built (Phase 6): the CLI and the webhook share one review pipeline. (Build status + owner handoff: §22.)

---

## 2. Problem & Goals

### Problem
Multiple repos power one product. A PR can look fine in isolation but:
- break an API contract used by another service,
- duplicate existing logic,
- conflict with another service's expectations,
- violate an organisational pattern (e.g., the org's `AGENTS.md`, conventions, shared schemas).

A reviewer that only sees the PR's own repo cannot catch these.

### Goals for V1
- **End-to-end working system**: give it a PR, get a useful review back.
- **Demonstrable cross-repo awareness**: findings cite evidence (`repo/file:line`) from *other* repositories.
- **Claude Code subscription as the only AI path** — no `ANTHROPIC_API_KEY`, no direct Anthropic API calls.
- **No hard-coded findings** — every run is genuinely generated.
- **Credentials handled responsibly** — GitHub App private key from env, local state gitignored, private code never leaves the machine.

---

## 3. Key Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| 1 | **TypeScript on Node 20+** | Native fit with the Claude Agent SDK and Octokit; strict types for LLM output validation; first-class Windows support. |
| 2 | **Claude Code via Agent SDK subprocess** | Runs the actual Claude Code binary → authenticates via the logged-in Claude subscription (OAuth). Satisfies the core constraint *"Claude Code subscription instead of any API"*. |
| 3 | **GitHub App (not PAT)** | One install covers the whole org; short-lived installation tokens (auto-refresh via `@octokit/auth-app`); no personal credential baked into the tool; the realistic path to a real bot. |
| 4 | **Local mirror + SQLite symbol index** | Deterministic, no API rate limits, Claude can `Grep`/read *full files* from other repos. GitHub Code Search API is used only as an optional fallback (10 req/min cap). |
| 5 | **Post review as a real GitHub review** | `POST /repos/{o}/{r}/pulls/{n}/reviews` with inline comments mapped to new-file line numbers — the UX a team expects. |
| 6 | **Read-only Claude workspace** | Claude Code gets only `Read`/`Grep`/`Glob` tools in the review workspace — it can analyse, never modify. Safe for unattended runs. |
| 7 | **CLI-first, webhook as stretch** | Matches the assignment ("a CLI or minimal interface that can be converted to a GitHub bot is completely acceptable") and keeps V1 focused. |
| 8 | **Custom minimal unified-diff parser** | We need hunk→new-file-line mapping to post valid inline comments (`line` + `side: "RIGHT"`). The deprecated `position` field is avoided. |

---

## 4. Tech Stack

| Layer | Technology | Version* | Purpose |
|---|---|---|---|
| Language / runtime | TypeScript (strict) + Node.js | 20.x LTS | Core implementation |
| AI orchestration | `@anthropic-ai/claude-agent-sdk` | ^0.3.227 | Run Claude Code headlessly (subprocess, subscription auth) |
| CLI binary (managed by SDK) | `@anthropic-ai/claude-code` | 2.x | The Claude Code engine underneath the SDK |
| Model | Claude **Sonnet** (configurable) | — | Review reasoning quality/cost balance |
| GitHub client | `octokit` | ^5 | REST API wrapper |
| GitHub App auth | `@octokit/auth-app` | ^8 | JWT → installation token flow, auto-refresh |
| Local index | `better-sqlite3` | 12.9.0 (pinned) | Files + symbols + review-dedup state |
| Diff parsing | custom `util/diff.ts` | — | Hunk parsing → numbered diff + line maps |
| Config & LLM output validation | `zod` | ^4 | Env schema + review JSON schema |
| CLI | `commander` | ^12 | `peer review|mirror|index|webhook` |
| Subprocess (git) | `execa` | ^9 | Shallow clone/fetch, safe arg passing |
| Logging | `pino` | ^9 | Structured JSON logs per review run |
| Tests | `vitest` | ^2 | Unit + local-fixture end-to-end |
| Dev execution | `tsx` | ^4 | Run TS directly without a build step |

*\*Versions verified against the npm registry at planning time; pin/adjust during Phase 0.*

**Phase 0 adjustments (verified 2026-08-11, running Node 20.19.0):**
- `zod` → **^4** — `@anthropic-ai/claude-agent-sdk@0.3.227` declares a peer dependency on zod ^4 (npm ERESOLVE otherwise).
- `better-sqlite3` → **pinned exactly 12.9.0** — v13 requires Node ≥22; v12.10+ ships no prebuilt binary for Node 20/win32-x64 (falls back to node-gyp, which needs VS Build Tools). 12.9.0 ships the `node-v115` prebuild, verified working on Node 20.19.0.
- `typescript` → **^5.9** — TS 7 (the native compiler) is intentionally avoided; 5.x is the stable choice with vitest/tsx.
- Kept per plan: `commander` ^12, `execa` ^9, `pino` ^9, `vitest` ^2, `octokit` ^5, `@octokit/auth-app` ^8, `tsx` ^4.

---

## 5. Architecture Overview

```
┌─────────────────────────── CLI (peer) ────────────────────────────┐
│   review --owner O --repo R --pr 42 [--post]                         │
│   mirror --owner O        index --owner O        webhook (stretch)   │
└──────────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
 ┌───────────────┐     ┌──────────────────────┐   ┌───────────────────┐
 │ GitHub module │     │  Mirror + Indexer    │   │  Claude module    │
 │ Octokit App   │     │  git clone/fetch     │   │  Agent SDK query  │
 │ PR, diff,     │     │  SQLite index:       │   │  cwd = workspace  │
 │ files, review │     │  repos/files/symbols │   │  read-only tools  │
 └───────┬───────┘     └──────────┬───────────┘   └─────────┬─────────┘
         │                       │                          │
         └───────────┬───────────┘                          │
                     ▼                                      │
         ┌─────────────────────────┐                       │
         │  Context builder        │  probe terms → rank   │
         │  diff → probes → pack   │  → context pack files │
         └─────────────────────────┘                       │
                     └──────────────► workspace/ (numbered diff + pack + prompt)
                                                           │
                                     ┌─────────────────────┘
                                     ▼
                     ┌─────────────────────────────────────────┐
                     │  Review pipeline: parse → zod → map →   │
                     │  format → post (or save .md/.json)      │
                     └─────────────────────────────────────────┘
```

**State directories**
- `data/mirror/{owner}/{repo}/` — shallow clones of org repos (gitignored)
- `data/index.db` — SQLite (repos, files, symbols, reviews)
- `data/workspace/{jobId}/` — per-review scratch: numbered diffs, context pack, prompt, output (gitignored)

---

## 6. End-to-End Review Flow

1. **Authenticate** — Build Octokit `App` from env (`GITHUB_APP_ID`, private key). Find the org's installation (`GET /app/installations`, filter `account.login`). Get an installation-scoped Octokit via `app.getInstallationOctokit(installationId)`.
2. **Fetch PR facts** —
   - `GET /repos/{o}/{r}/pulls/{n}` with `Accept: application/vnd.github.diff` → raw unified diff.
   - `GET /repos/{o}/{r}/pulls/{n}/files` → per-file status/additions/deletions/`patch`.
   - `GET /repos/{o}/{r}/pulls/{n}/commits` → head commit SHA (used for dedup + `commit_id` on the review).
3. **Ensure mirror + index (lazy)** — for each org repo not yet cloned or stale: `git clone --depth 1` (or `git fetch --depth 1 && git reset --hard origin/HEAD`); then re-index files + symbols. (Commands: `peer mirror` / `peer index`, or auto on review.)
4. **Extract probes** — from added/removed diff lines: changed file basenames, `function`/`class`/`const` names, `export` symbols, import paths, string literals that look like routes (`/api/…`), and table/schema names.
5. **Build context pack** —
   - Query the index: files in *other* repos whose basename, symbols, or content match the probes (SQL for symbols + `rg` over the mirror for content hits).
   - Rank by (probe type weight, hit count); cap at `REVIEW_MAX_CONTEXT_FILES` and `CONTEXT_TOKEN_BUDGET`.
   - Include org pattern files when present (`AGENTS.md`, `README.md` per repo) — these encode the org's conventions.
6. **Run Claude Code** — Agent SDK `query()`:
   - `cwd` = the job workspace (numbered diffs + context pack + `REVIEW_PROMPT.md`).
   - `systemPrompt` = reviewer instructions + output schema (see §11).
   - `allowedTools` = `['Read', 'Grep', 'Glob', 'Bash(git:*)']`; `permissionMode = 'bypassPermissions'`.
   - Collect the streamed result; extract the final assistant text (JSON).
7. **Validate** — parse JSON, validate with the zod review schema; on parse failure, retry once with a repair prompt.
8. **Map lines** — the numbered diff already annotates new-file line numbers; findings carry `(file, line)`. The formatter cross-checks against the hunk table and drops/nearest-maps invalid lines.
9. **Post** — `POST /repos/{o}/{r}/pulls/{n}/reviews`:
   - `event`: `REQUEST_CHANGES` if any `error`/`warning` findings, else `COMMENT`.
   - `comments[]`: `{ path, line, side: 'RIGHT', body }` (capped at `MAX_REVIEW_COMMENTS`).
   - Dedup: skip if a review for `(owner, repo, pr, head_sha)` already exists in SQLite.
   - Without `--post`, write `review.md` + `review.json` to the workspace instead.

---

## 7. Project Structure

```
peer/
├── .env.example
├── .gitignore                      # data/, .env, *.pem, node_modules/
├── package.json
├── tsconfig.json                   # strict
├── vitest.config.ts
├── README.md                       # setup + run + demo + loom notes
├── PLAN.md                         # this document
├── src/
│   ├── index.ts                    # CLI entry (commander)
│   ├── config/
│   │   └── env.ts                  # zod env schema + load
│   ├── github/
│   │   ├── app.ts                  # Octokit App factory
│   │   ├── auth.ts                 # find org installation + token
│   │   └── pr.ts                   # fetch PR, diff, files, head sha
│   ├── mirror/
│   │   ├── mirror.ts               # clone/fetch org repos
│   │   └── indexer.ts              # build/refresh SQLite index
│   ├── context/
│   │   ├── probes.ts               # extract probe terms from diff
│   │   ├── search.ts               # index queries + content hits + rank
│   │   └── pack.ts                 # assemble workspace context pack
│   ├── claude/
│   │   ├── runner.ts               # Agent SDK query() wrapper
│   │   └── prompt.ts               # reviewer system prompt builder
│   ├── review/
│   │   ├── schema.ts               # zod review output schema
│   │   ├── format.ts               # findings → GitHub comments (line mapping)
│   │   ├── post.ts                 # dedup + post
│   │   └── pipeline.ts             # shared review flow (CLI + webhook)
│   ├── webhook/
│   │   ├── verify.ts               # X-Hub-Signature-256 verification
│   │   └── server.ts               # HTTP listener + pull_request dispatch
│   ├── local/
│   │   ├── fixture.ts              # fixture mode: stage repos, load PRs
│   │   └── reviewer.ts             # deterministic fixture-driven reviewer
│   ├── store/
│   │   └── db.ts                   # SQLite init, migrations, queries
│   └── util/
│       ├── logger.ts               # pino wrapper
│       ├── exec.ts                 # execa wrapper for git
│       ├── diff.ts                 # unified-diff hunk parser + line maps
│       └── doctor.ts               # environment health checks
├── tests/
│   ├── claude/                     # prompt + runner tests
│   ├── context/                    # probes, search, pack tests
│   ├── github/                     # pr fetch test
│   ├── local/                      # multi-repo E2E (fixtures, no GitHub/Claude)
│   ├── mirror/                     # git mirror + indexer tests
│   ├── review/                     # schema, format, post tests
│   ├── store/                      # db tests
│   ├── util/                       # diff, exec, doctor tests
│   ├── webhook/                    # signature + handler tests
│   ├── smoke.test.ts               # env schema tests
│   └── fixtures/                   # tiny multi-repo fixtures (no credentials needed)
│       ├── repo-a/                 # API service owning `getUser` (with prs/1.diff)
│       └── repo-b/                 # web client consuming `getUser`
└── scripts/
    └── demo.sh                     # one-command demo on a real PR
```

---

## 8. Module Deep-Dives

### 8.1 GitHub client (`src/github/`)
- `app.ts` — `new App({ appId, privateKey })` from env; private key read from `GITHUB_PRIVATE_KEY_PATH` (or base64 `GITHUB_PRIVATE_KEY`).
- `auth.ts` — `findInstallationForOrg(org)`: `GET /app/installations`, pick `account.login === org`. Then `app.getInstallationOctokit(installationId)` (handles token minting + refresh, 1h expiry).
- `pr.ts` — `fetchPr(octokit, owner, repo, number)` → `{ title, body, baseRef, headSha, diff (raw), files[] }`.
- `review.ts` — `postReview(...)` → `POST /repos/{o}/{r}/pulls/{n}/reviews` with `{ commit_id, event, body, comments[] }`.

### 8.2 Repo mirror (`src/mirror/`)
- List org repos: `GET /installation/repositories`.
- Clone: `git clone --depth 1 --branch <default_branch> https://x-access-token:<token>@github.com/<owner>/<repo>.git` (or mirror config in `.git/config`).
- Refresh: `git fetch --depth 1 origin <branch> && git reset --hard origin/<branch>`.
- Token never persists in `.git/config` when using a one-shot `GIT_ASKPASS`/URL; prefer injecting via env for the git call only.

### 8.3 Context index (`src/mirror/indexer.ts` + `src/store/db.ts`)
- Schema: `repos`, `files` (`repo_id`, `path`, `basename`, `lang`, `size`), `symbols` (`file_id`, `kind`, `name`, `line`), `reviews`.
- Symbol extraction: language-aware regex pass (functions/classes/interfaces/exported consts; JSON/JS/TS/Python/Go/Java prioritised). Good enough for V1 — precision beats completeness.
- Rebuild strategy: full re-index per repo on refresh (repos are small at V1 scale).

### 8.4 Probe extraction (`src/context/probes.ts`)
From added/removed lines of the diff:
- `paths` — changed file paths + basenames
- `symbols` — `function <n>`, `class <n>`, `interface <n>`, `export ... <n>`, `const <n> =`
- `imports` — `from '<pkg>'`, `require('<pkg>')`
- `routes` — `"…/api/…"` string literals
- `tables` — `CREATE TABLE <n>`, `<schema>.<table>` patterns

### 8.5 Context pack builder (`src/context/pack.ts`)
- Candidate sources: (a) symbol index match (SQL), (b) basename match (SQL), (c) content hit (`rg -l` over mirror with probe terms, capped).
- Ranking score: weighted sum per match type; tie-break by repo "relatedness" (same repo group/prefix).
- Output cap: `REVIEW_MAX_CONTEXT_FILES` (default 12) and `CONTEXT_TOKEN_BUDGET` (default ~40k chars ≈ 10k tokens).
- Always include org pattern files (`AGENTS.md`, `README.md`) up to the budget.

### 8.6 Claude Code runner (`src/claude/runner.ts`)
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = await query({
  prompt: buildReviewPrompt(jobId),          // see 8.7 / §11
  systemPrompt: REVIEWER_SYSTEM_PROMPT,      // static reviewer identity + schema
  model: env.CLAUDE_MODEL,                   // e.g. 'sonnet'
  cwd: workspaceDir,                         // diffs + context pack only
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
  permissionMode: 'bypassPermissions',
  maxTurns: env.CLAUDE_MAX_TURNS,
});
// iterate stream; final assistant text = JSON review
```
Notes:
- The SDK bundles/runs the real Claude Code binary as a subprocess. Auth comes from the **logged-in CLI session** (`claude login` with the subscription). **Never set `ANTHROPIC_API_KEY`** in this environment — that would bill the API, violating the constraint.
- Result shape: the SDK returns a stream of events; collect `type: 'result'` final message → `result.result` string (exact shape is version-dependent — assert in a small wrapper during Phase 3).
- The workspace is strictly read-only for Claude (`Read`, `Grep`, `Glob`; `Bash` restricted to `git:*`), so an unattended run cannot mutate anything.

### 8.7 Reviewer prompt design (`src/claude/prompt.ts`)
The prompt instructs Claude to review **this PR against the provided context pack from the org**, and to:
- Check: API contract changes vs. known consumers, duplicated logic, cross-service coupling, org patterns from `AGENTS.md`/READMEs.
- Only cite evidence actually present in the pack or diff (file paths as given in the numbered diff).
- Output **one JSON object** matching the schema (see §12): `{ summary, overall, findings[] }` with `severity ∈ {error, warning, info}`, `file`, `line` (new-file line as shown in the numbered diff), `title`, `body`, `evidence[]` (repo, file, line, quote).
- Never invent line numbers or files; return `[]` findings when nothing is wrong.

### 8.8 Review formatting & posting (`src/review/`)
- `format.ts` — validate each finding against the hunk map for `file`; drop out-of-range lines, dedupe identical comments, cap at `MAX_REVIEW_COMMENTS`, build the review body (summary + markdown finding list).
- `post.ts` — idempotency check against SQLite (`reviews` unique on `owner+repo+pr+head_sha`), then `createReview`; record outcome.

---

## 9. APIs & Integrations

### GitHub REST (via Octokit)
| Call | Purpose | Notes |
|---|---|---|
| `GET /app/installations` | find the org's app installation | filter by `account.login` |
| `POST /app/installations/{id}/access_tokens` | mint installation token | handled automatically by `@octokit/auth-app` (1h expiry, auto-refresh) |
| `GET /installation/repositories` | list org repos for mirroring | paginate |
| `GET /repos/{o}/{r}/pulls/{n}` | PR metadata + raw diff | header `Accept: application/vnd.github.diff` |
| `GET /repos/{o}/{r}/pulls/{n}/files` | changed files + per-file patch | patch truncated for very large files |
| `GET /repos/{o}/{r}/pulls/{n}/commits` | head SHA for dedup / `commit_id` | take last commit |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | post review + inline comments | `comments: [{path, line, side: 'RIGHT', body}]` |
| `GET /search/code` | optional fallback cross-repo search | `q=org:<owner> <term>`; **10 req/min** authenticated; default branch only; auth required |

Rate limits (installation tokens): core **5,000 req/h**; search **10 req/min**. Mirroring once per day + lazy refresh keeps us far below both.

### Claude Code (the only AI path)
- `@anthropic-ai/claude-agent-sdk` `query()` → real Claude Code subprocess → **subscription auth** via `claude login`.
- No `ANTHROPIC_API_KEY`. No Anthropic HTTP API. This is the core constraint, enforced in config validation (fail fast if `ANTHROPIC_API_KEY` is set in `.env`).

### System tools
- `git` (shallow clone/fetch/reset) via `execa` — POSIX-safe on Windows.
- `better-sqlite3` local index.
- `rg` (ripgrep) optional for content-hit search over the mirror (falls back to a Node walk + include filter).

---

## 10. Cross-Repo Context Strategy

The differentiator of this assignment. Strategy in three layers:

1. **Structural (index)** — same basename or symbol names in other repos → strong signal of shared contract/duplication.
2. **Lexical (rg)** — probe terms appearing in other repos' code → contract usage, route consumers.
3. **Organisational (pattern files)** — `AGENTS.md`/README conventions → pattern compliance checks.

**Why a local mirror beats GitHub search for V1:** full file bodies, no 10 req/min cap, no default-branch-only limitation, deterministic, and Claude Code can read/grep real files with its native tools. The trade-off is staleness; we mitigate with lazy refresh (`fetch --depth 1` per review, cheap).

**Honest limitation:** we rank by lexical/structural similarity, not semantics. A deeper "contract graph" (find where each exported symbol is consumed across repos) is listed in §19 (Future Work).

---

## 11. Claude Code Integration — Subscription Constraint

- **Auth:** the machine must run `claude login` once with the subscription account. The Agent SDK subprocess inherits that session.
- **Verification step (Phase 3):** run `claude -p "hello"` headlessly and confirm it completes without an API key. Add a `peer doctor` command that checks: `claude` reachable, auth present, git available, GitHub App credentials valid, SQLite writable.
- **Cost control:** read-only tools, bounded `maxTurns`, capped context pack, `CONTEXT_TOKEN_BUDGET`. Review runs are short (<2 min typical).
- **Windows:** Claude Code 2.x runs natively on Windows; the SDK handles the CLI. Git must be in `PATH`. (Note in README.)

---

## 12. Review Output Schema (zod)

```ts
const EvidenceSchema = z.object({
  repo: z.string(),            // org/repo
  file: z.string(),
  line: z.number().optional(),
  quote: z.string().optional(),
});

const FindingSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  file: z.string(),            // path within the PR repo (as in numbered diff)
  line: z.number().optional(), // new-file line number
  title: z.string(),
  body: z.string(),
  evidence: z.array(EvidenceSchema).max(5).default([]), // cross-repo citations
});

export const ReviewSchema = z.object({
  summary: z.string(),
  overall: z.enum(['changes_requested', 'comment', 'approve']),
  findings: z.array(FindingSchema).max(20),
});
```

Mapping to GitHub: `overall === 'changes_requested'` → `event: 'REQUEST_CHANGES'`, else `COMMENT`. Findings without a valid mapped line become bullets in the review body instead of inline comments.

---

## 13. Configuration (`.env.example`)

```env
# GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=C:/secure/peer-app.private-key.pem   # or GITHUB_PRIVATE_KEY=<base64>
GITHUB_WEBHOOK_SECRET=                                        # optional (webhook mode)

# Org (optional; defaults to the PR's owner)
GITHUB_ORG=your-org

# Claude Code (subscription auth via `claude login` — do NOT set ANTHROPIC_API_KEY)
CLAUDE_MODEL=sonnet
CLAUDE_MAX_TURNS=30

# Context pack
REVIEW_MAX_CONTEXT_FILES=12
CONTEXT_TOKEN_BUDGET=40000

# Posting
MAX_REVIEW_COMMENTS=20

# Paths / logging
DATA_DIR=./data
LOG_LEVEL=info
```

---

## 14. Data Model (SQLite)

```sql
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL, name TEXT NOT NULL,
  default_branch TEXT, cloned_at TEXT, last_indexed_at TEXT,
  UNIQUE(owner, name)
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY, repo_id INTEGER REFERENCES repos(id),
  path TEXT NOT NULL, basename TEXT NOT NULL, lang TEXT, size INTEGER,
  UNIQUE(repo_id, path)
);
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY, file_id INTEGER REFERENCES files(id),
  kind TEXT NOT NULL, name TEXT NOT NULL, line INTEGER
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, status TEXT, summary TEXT, created_at TEXT,
  UNIQUE(owner, repo, pr_number, head_sha)
);
```

---

## 15. Build Plan — One AI-Assisted Day (~10h focused)

| Phase | Time | Deliverable | Exit criteria | Status |
|---|---|---|---|---|
| **0. Scaffold** | 45m | npm project, TS strict, deps, `.env.example`, `.gitignore`, CLI skeleton | `npm run typecheck` passes; CLI prints help | ✅ complete |
| **1. GitHub App + Mirror + Index** | 2h | `github/app.ts`, `auth.ts`, `mirror.ts`, `indexer.ts` | `peer mirror --owner X` clones org repos; `index` fills SQLite | ✅ complete (tested via local git E2E) |
| **2. PR fetch + Probes + Context pack** | 2h | `pr.ts`, `diff.ts`, `probes.ts`, `search.ts`, `pack.ts` | workspace contains numbered diff + cross-repo context pack | ✅ complete |
| **3. Claude Code runner** | 2.5h | `runner.ts`, `prompt.ts`, `schema.ts` | `peer review` prints a valid zod-validated JSON review | ✅ complete (needs `claude login` for live run) |
| **4. Post review** | 1.5h | `format.ts`, `post.ts`, dedup | `--post` creates a GitHub review; re-run doesn't duplicate | ✅ complete (dedup unit-tested) |
| **5. Polish & ship** | 1.5h | tests, `doctor`, README, `scripts/demo.sh` | Local multi-repo E2E passes; typecheck + tests green | ✅ complete — **74/74 tests green** |
| **6. Stretch (webhook)** | — | webhook listener | auto-review on `pull_request` opened/synchronize | ✅ complete — CLI + webhook share one pipeline |
| **7. User setup & submission** | you | GitHub App registration, `claude login`, deploy webhook, Loom, write-ups | live review on a real PR; submission sent | ⏳ **left for you — see §22** |

---

## 16. Testing Strategy

- **Unit (vitest):** probe extraction, diff hunk parsing/line mapping, review→comment formatting, zod schema, dedup logic, SQL queries.
- **Local E2E fixture:** two tiny git repos in `tests/fixtures/` (e.g. `api-service` and `web-client` sharing a contract file). Create a PR-like diff locally; run the pipeline with `--local` mode (no GitHub, no real Claude: a fake "reviewer" that returns canned-but-not-hardcoded answers driven by the fixture). This proves the plumbing end-to-end in CI without credentials.
- **Live smoke:** `peer doctor` + one real review on a test org PR (demo script).
- **Typecheck + lint** in CI: `npm run typecheck`, `npm test`.

---

## 17. Security & Credential Handling

- GitHub App private key: env-only, never committed; `.gitignore` covers `.env`, `*.pem`, `data/`.
- Installation tokens: minted per-run by Octokit, never persisted; git clone URL token injected via env for the single git call, not stored in `.git/config`.
- Claude Code: subscription session stays on the operator's machine; review workspace is local-only. **Private code never leaves the machine.**
- Config guard: fail fast if `ANTHROPIC_API_KEY` is present (enforces the Claude-Code-only constraint).
- Webhook mode: `X-Hub-Signature-256` verified with the webhook secret before any processing (built in Phase 6).
- No hard-coded findings anywhere; all review content is generated per-run.

---

## 18. Known Limitations (V1)

1. **Staleness** — mirror reflects default branches at last refresh (lazy-refreshed per review). Long-lived PR branches aren't mirrored.
2. **Lexical, not semantic, context** — probe matching can miss semantically-similar but differently-named code.
3. **Line-number fidelity** — inline comments map to new-file lines; we drop lines outside diff hunks (fine-grained but not exhaustive).
4. **Review cost/latency** — each review consumes subscription tokens and takes ~1–3 min; no parallel batching.
5. **Language coverage** — symbol extractor prioritises a handful of languages.
6. **No authz model** — any org the app is installed on can be reviewed; fine for V1.
7. **No retry/queueing beyond a single retry** for Claude output parse failures.

---

## 19. What We'd Build Next (with more time)

1. **Contract graph** — index exported symbols → consumers across repos; review diffs against known consumers explicitly ("changing `POST /users` breaks `web-client/src/api.ts:44`").
2. **Webhook hardening** — the V1 listener (built in Phase 6) is single-process fire-and-forget; add a job queue, retries, status checks, and request dedup for scale. Search-API fallback and result caching also remain.
3. **Semantic context retrieval** — embeddings over the mirror (e.g. SQLite-vec) to complement lexical matching.
4. **Caching & budgets** — token budgets per repo, result caching by `(pr, head_sha)`, cheaper pre-filter model for probe ranking.
5. **Policy file support** — org `AGENTS.md`/`REVIEW_POLICY.md` parsing into checkable rules.
6. **Comments on comment threads** — reply to review threads rather than only creating new reviews.
7. **Dashboard/report** — review history UI or export to Markdown/CI artifact.

---

## 20. Deliverables Checklist (for submission)

- [x] Working source code (this repo)
- [x] Setup & run instructions (`README.md`)
- [x] Demo script (`scripts/demo.sh` runs `peer review --owner O --repo R --pr N --post` on a real PR)
- [ ] Loom: short demo + architecture walkthrough — **you record this**
- [x] Architecture & decisions explained (this document + README "Decisions" section)
- [x] Known limitations (§18)
- [x] What next (§19)
- [x] AI-assisted development notes (§21)

---

## 22. Build Status & Handoff (what's done / what's left)

> Written after Phase 6. The codebase is feature-complete and fully tested; the remaining items require your GitHub/Claude accounts and a demo video.

### 22.1 What's DONE (code, verified)

**Verified on this machine:** `npm run typecheck` passes; `npm test` passes — **74 tests across 19 files**.

| Area | What exists | Evidence |
|---|---|---|
| CLI | `peer review / mirror / index / context / doctor / webhook` | `--help` lists all; `review --local` runs end-to-end |
| GitHub App auth | App factory + installation token (PLAN §3 decision #3) | `doctor` validates credentials; mirror/index/clone tested against real local git repos |
| Mirror + index | shallow clone/refresh, token never persisted, SQLite file/symbol index | `tests/mirror/` — real-git E2E (clone → token strip → refresh) |
| Context | diff parser → probes → cross-repo search → bounded context pack | `tests/context/` + `tests/util/diff.test.ts` |
| Claude Code | Agent SDK runner, read-only tools, one repair retry, zod schema | `tests/claude/` (injected fake query — never needs a live Claude) |
| Posting | findings → inline comments with (file,line) anchoring, dedup on head commit | `tests/review/` — payload shape + dedup asserted |
| Webhook bot | X-Hub-Signature-256 verification, pull_request opened/synchronize dispatch, 202-then-review | `tests/webhook/` + live server smoke (202/401/204 verified) |
| Local E2E | bundled fixtures (`repo-a` + `repo-b` sharing a symbol) prove cross-repo findings with zero credentials | `tests/local/e2e.test.ts` — finding cites `acme/repo-b/src/client.ts` |
| Doctor | git, Claude binary + auth, GitHub App, SQLite writability | `tests/util/doctor.test.ts` |
| Demo script | `scripts/demo.sh <owner> <repo> <pr> [--post]` | bash syntax-validated |

### 22.2 What's LEFT FOR YOU (step by step)

Everything here needs your accounts/credentials — the code cannot do it for you.

**Step 1 — Install & log in Claude Code (10 min)**
```sh
npm install -g @anthropic-ai/claude-code
claude login          # one-time, browser OAuth with your Claude subscription
```
Do **not** set `ANTHROPIC_API_KEY` — Peer fails fast if it's present (PLAN §11).

**Step 2 — Register the GitHub App (20 min)**
1. GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.
2. Permissions (org-level): **Contents: Read**, **Pull requests: Read & write**, **Metadata: Read** (always on).
3. Events: subscribe to **Pull request**.
4. Webhook: can be left blank for CLI-only use; set it to your deployed URL later for bot mode.
5. Generate a **private key** → save the `.pem`.
6. Install the app on your org (org settings → Install → choose repos).

**Step 3 — Configure `.env` (5 min)**
```sh
cp .env.example .env
# GITHUB_APP_ID=<the app id>
# GITHUB_PRIVATE_KEY_PATH=<absolute path to your .pem>
# GITHUB_WEBHOOK_SECRET=<random string, only needed for bot mode>
```
Verify with `npm run dev -- doctor` — every check should pass.

**Step 4 — Run the live review (10 min)**
```sh
npm install
npm run dev -- mirror --owner <your-org>
npm run dev -- index --owner <your-org>
./scripts/demo.sh <your-org> <repo> <pr> --post   # posts an inline-comment review to GitHub
```
Re-run the same command — it will skip (dedup) because the head commit was already reviewed.

**Step 5 — (Optional) Bot mode via webhook (30 min)**
1. Deploy the repo to a server with a public HTTPS URL (or a tunnel like `cloudflared`/`ngrok` for a demo).
2. Set `GITHUB_WEBHOOK_SECRET` in `.env` and in the GitHub App's webhook config.
3. Run `npm run dev -- webhook` — every `opened`/`synchronize` PR is auto-reviewed and posted.

**Step 6 — Record the Loom (15–20 min)** — suggested script:
1. `npm run dev -- doctor` → all green.
2. `npm run dev -- review --owner <org> --repo <repo> --pr <n> --local` → show the cross-repo finding citing the other repo's file.
3. `./scripts/demo.sh <org> <repo> <pr> --post` → show the real review + inline comment on GitHub.
4. (Optional) Trigger a webhook and show it auto-post.
5. 1–2 min on architecture: mirror+index → context pack → Claude Code → post, and why (PLAN §3).
6. 30 s on limitations (PLAN §18) and next steps (PLAN §19).

**Step 7 — Write the submission (30 min)**
- Copy §21 (AI notes) and §18–19 (limitations/next) into the submission doc; record answers in your own voice.
- Attach the Loom link, the repo (or zip), and this PLAN.md.

---

## 21. AI-Assisted Development Notes (for the submission note)

- **Planning phase:** research on the Claude Agent SDK, GitHub App auth flow, and GitHub API specifics was done with AI-assisted web/documentation research; versions verified against the npm registry.
- **Implementation:** Claude Code / Copilot-style assistance for scaffolding, prompt engineering, and test writing; the reviewer prompt itself was iterated on with real PR smoke tests.
- **Verification:** AI-assisted code review passes (typecheck, unit tests, local E2E fixture) before the live demo.
- **Honest note:** the review *engine* is Claude Code; the *pipeline* around it (context retrieval, formatting, posting) is deterministic code with unit tests — by design, so review quality is attributable and debuggable.

---

*Document version 1.2 — renamed to **Peer**; all build phases 0–6 complete; §22 documents the handoff (what's done vs. what needs the owner's accounts).*

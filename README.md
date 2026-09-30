# Peer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen)](https://nodejs.org/)

A cross-repo code-review bot for GitHub organisations. Peer reviews a pull request against relevant context from the **other repositories in the org** — catching API-contract breaks, duplicated logic, and org-pattern violations that a single-repo review would miss — then posts the result as a GitHub PR review with inline comments.

The review reasoning runs through **Claude Code** (subscription auth via `claude login`) — never a direct Anthropic API call.

---

## Highlights

- **Cross-repo context** — local mirror + SQLite symbol index, probe-based retrieval, budget-capped context pack
- **CLI-first, bot-ready** — one CLI plus a webhook listener sharing a single review pipeline
- **Structured output** — zod-validated JSON reviews, one repair retry, inline comments anchored to diff lines, deduped per head commit
- **Zero-credential proof** — `--local` fixture mode runs the retrieval and context-packing pipeline against bundled fixtures, then uses a deterministic stub reviewer (no GitHub access or API key needed)
- **Tested** — 95 tests across 22 suites; engine calls are dependency-injected, so tests never hit the network

---

## How it works

1. **Mirror** — shallow-clones the org's repositories and indexes their files and symbols into SQLite.
2. **Probe** — parses the PR diff into a numbered diff and extracts probe terms: symbols, imports, routes, tables.
3. **Context pack** — finds matching files in the _other_ repos, ranks them, and stages the top files next to the numbered diff (capped by count and token budget), plus org pattern files (`AGENTS.md`, `README.md`).
4. **Review** — Claude Code reviews the diff against the pack and returns a single JSON review: summary, verdict, strengths, and findings with severity, category, file, line, suggestion, and cross-repo evidence.
5. **Post** — the JSON is schema-validated, findings are anchored to real new-file lines, and the review is posted as inline comments (or saved locally without `--post`).

---

## Requirements

- Node.js **20+**
- `git`
- Claude Code CLI, installed and logged in with your subscription (`claude login`)

---

## Setup

```sh
npm install
cp .env.example .env     # then fill in your credentials
npm run ci
```

Verify the environment with `peer doctor` (git, Claude Code, GitHub App credentials, SQLite).

---

## Usage

| Command                                                  | Description                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `peer doctor`                                            | Environment health check                                                                           |
| `peer mirror --owner <org>`                              | Clone/refresh the org repositories                                                                 |
| `peer index --owner <org>`                               | Build the SQLite symbol index                                                                      |
| `peer context --owner <org> --repo <r> --pr <n>`         | Build and inspect a PR's context pack                                                              |
| `peer review --owner <org> --repo <r> --pr <n> [--post]` | Review a PR — save locally, or post to GitHub with `--post`                                        |
| `peer review --owner <org> --repo <r> --pr <n> --local`  | Retrieval + context pack against bundled fixtures, then deterministic stub review (no credentials) |
| `peer webhook [--port <n>]`                              | Bot mode: auto-review PRs on `opened`/`synchronize`                                                |

```sh
npm run dev -- review --owner acme --repo repo-a --pr 1 --local
./scripts/demo.sh <org> <repo> <pr> --post
```

---

## Configuration

| Variable                                                          | Purpose                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH` / `GITHUB_PRIVATE_KEY` | GitHub App credentials (one key source only)                   |
| `GITHUB_ORG`                                                      | Org whose repositories are mirrored (defaults to the PR owner) |
| `GITHUB_WEBHOOK_SECRET`, `WEBHOOK_PORT`                           | Webhook bot mode                                               |
| `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`                                | Review engine (default `sonnet`, max 30 turns)                 |
| `REVIEW_MAX_CONTEXT_FILES`, `CONTEXT_TOKEN_BUDGET`                | Context-pack sizing (defaults 12 files / 40k chars)            |
| `MAX_REVIEW_COMMENTS`                                             | Inline-comment cap (default 20)                                |
| `DATA_DIR`, `LOG_LEVEL`                                           | Paths and logging                                              |

---

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
tests/                22 vitest suites, 95 tests, bundled fixture repos
```

---

## Security

- GitHub App **installation tokens** are minted per run, injected only into the git clone URL, stripped from the stored remote, and scrubbed from error output — never persisted.
- `.env`, `*.pem`, and `data/` are gitignored.
- Startup **fails fast if `ANTHROPIC_API_KEY` is set** — reviews never use a direct Anthropic API call.
- Webhook requests are verified with `X-Hub-Signature-256` before processing.

---

## Limitations

- Context retrieval is lexical (symbol/basename/content matching), not semantic.
- Findings must map to new-file lines inside diff hunks; unanchored findings are rendered in the review body instead.
- Each review is a single model call (~1–3 min); no batching or queueing yet.

---

## License

[MIT](LICENSE)

### Reviewer tool boundary

The Claude reviewer has only `Read`, `Grep`, and `Glob` available. A `PreToolUse`
hook checks every call before the SDK's automatic read permissions: paths must
stay inside the job's packed workspace, refer to existing regular files or
directories, and contain no symlinks. Recursive searches reject trees containing
symlinks or special files. Unknown tools and unsafe glob patterns fail closed.
The runner does not use `bypassPermissions`; filesystem settings, skills, plugins,
and ambient MCP server configuration are disabled for each attempt, including
JSON-repair retries. Subscription authentication is unchanged.

This is an SDK tool policy, **not an operating-system sandbox**. The host must own
and protect the packed workspace from concurrent modification. Path checks cannot
prevent a hostile local process from swapping a file between validation and use,
or protect against SDK/CLI vulnerabilities. Do not run Peer alongside untrusted
local processes or place secrets in the context pack. A dedicated process/container
boundary is separate deployment hardening. The adversarial tests exercise the
policy callbacks and option wiring without calling a live model.

### Durable webhook jobs

Webhook mode persists verified `opened`/`synchronize` events to SQLite before
responding HTTP 202. The delivery ID and `(owner, repo, PR, head SHA)` are deduped.
Keep `DATA_DIR` on persistent local storage. The queue shares the existing database
and uses WAL with full synchronous commits; it does not survive deleting that data.

One leased worker drains jobs, including jobs left by a restart. It renews a
60-second lease every 10 seconds. Retryable pre-post failures get at most three
attempts with 30/60-second backoff. Expired leases are recovered; exhausted jobs
remain `failed`. Jobs for a changed head are `superseded`; the head is checked again
before posting. The GitHub review is pinned to the checked SHA, but a PR can still
change after that last check. Run `peer jobs` to inspect the latest 100 jobs.

Posting uses an atomic durable claim, shared by CLI and webhook callers, before
any GitHub review-creation request. Once that request may have started, Peer does
**not** automatically resend it after a timeout, crash, or response-loss. Such jobs
remain `blocked` (or become blocked when recovered), and the durable post claim
remains `uncertain`. This favors no duplicate bot reviews over automatic delivery:
GitHub review creation has no idempotency key, so Peer does not promise exactly-once
remote delivery. Automatic Octokit transport and rate-limit retries are disabled on the GitHub App
client; the queue owns bounded retries before posting.

For a blocked job, an operator must check the PR's reviews at the recorded head
and reconcile the `review_posts` claim with the actual GitHub result. Do not delete
an uncertain claim simply because no review is immediately visible: the original
request may still complete. Peer deliberately provides no blind retry/reset command.
Multiple hosts must not share this SQLite database over a network filesystem.
A worker lease fences posting, not hostile/stalled processes accessing mirror files;
host isolation and immutable context snapshots remain separate hardening.

### Snapshot evidence and coverage

Each job writes `manifest.json` with its checked PR head, diff hash, and every
packed source's repository/path, commit (when available), content hash and line counts. The host retains exact source text for validation. Committed context is read from pinned Git blobs, not mutable working-tree
bytes. Local fixture sources are explicitly unpinned. PR metadata is checked before
and after diff/files acquisition; a changed head or base aborts the snapshot.

The host validates both initial and repaired model replies: finding files/lines
must exist in the diff; evidence must identify a packed source; line numbers must
be positive integers within that source; quotes must match the exact text and
cited line. Cross-repo findings need evidence. Invented citations fail the review,
not merely fall back to body comments. Source identities/quotes are preserved
without prose normalization, and staged input bytes are rechecked after the run.

Peer's current retrieval is heuristic, not an exhaustive consumer inventory.
Coverage is therefore explicitly incomplete: output is comment-only, never an
approval or request-changes verdict, with a coverage note. Missing mirrors,
unpinned inputs, omitted patches and budget omissions add named limits. This
prevents an empty findings list from pretending to prove org-wide compatibility.
The manifest pins included evidence, not the completeness of the retrieval index.
It also does not prove semantic correctness of model claims or authenticate source
comments as instructions. Context code/docs are untrusted data. Stronger retrieval
coverage is a later work item; no flag silently bypasses this verdict gate.

### Context budget and retrieval limits

`CONTEXT_TOKEN_BUDGET` is a legacy name: its unit is JavaScript string characters,
not model tokenizer tokens. It now caps numbered diff plus packed source text and
source headers together. A diff exceeding that character budget aborts clearly,
never silently truncates. Source files get first use of the remaining space;
README/AGENTS supplements have a 30% cap but reserve no unused allowance. The
source file cap remains `REVIEW_MAX_CONTEXT_FILES`. Retrieval looks beyond that
cap (a bounded ranked pool) so one oversized top result cannot hide smaller matches.

Content search reads pinned committed blobs when Git provenance exists; local
fixtures use deterministic sorted file walks. Missing mirrors, unreadable/binary
inputs, oversized content, term/file/result limits and packing omissions appear
in coverage diagnostics (up to 100 distinct notes plus an omitted-count note). The content scan remains capped at 1,000 files/repo,
512 KiB/source and 15 terms; it is not exhaustive. Index matches remain heuristic.
The on-disk manifest carries hashes/commit identities and line counts, not duplicate
source text; the host retains exact evidence privately for validation. Prompt,
manifest metadata, system instructions and SDK overhead are outside this _content_
character limit, so it is not a model context-window guarantee. Comment-only
coverage gating remains in force.

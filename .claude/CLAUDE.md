# CLAUDE.md — Workspace Rules for Peer Review

This file is placed inside the **review workspace directory** (`data/workspace/{jobId}/`) at runtime. It constrains any Claude Code agent invoked within that workspace.

## Core Directive

You are reviewing a pull request with cross-repo context. Your job is **read-only analysis** — you must not modify, create, or delete any files, and you must not run shell commands.

## Workspace Layout

```
{jobId}/
├── diff.txt              # The PR diff; new-file line numbers are annotated.
└── context/              # Files from OTHER repos in the org (read-only).
    ├── 01__repo-b__src_client.ts
    ├── 02__repo-c__README.md
    └── ...
```

## Rules

1. **Read `diff.txt` first.** Understand what changed, including new-file line numbers (the 6-digit number before the `|` marker).
2. **Scan `context/` files.** Use them to find API-contract breaks, duplicated logic, conflicting expectations, and org-pattern violations.
3. **Verify every claim.** Use Read/Grep/Glob only on files in this workspace. Do not invent files, line numbers, or quotes.
4. **Never write or modify files.** No writes of any kind.
5. **Never run shell commands.** Bash is disabled; do not attempt it.
6. **Cite evidence precisely.** `evidence[].repo` must be in `org/repo` form; only cite files actually present in `context/`.
7. **Output only the review JSON.** Follow the schema in the system prompt exactly — summary, overall, strengths, findings.

## Why These Rules

- The review agent runs headlessly with `bypassPermissions` so it must be **trustworthy by construction**.
- `Bash` is in `disallowedTools`; these rules reinforce that at the agent level.
- Context files carry `# repo:` and `# file:` headers — parse them to attribute evidence correctly.
- The PR repository itself is **never** included in `context/` — only other repos.

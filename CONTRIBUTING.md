# Contributing to Peer

## Setup

Local development requires Node.js 20 or newer and Git. Live reviews also
need a Claude subscription login and GitHub App configuration.

From Bash or PowerShell:

```sh
git clone https://github.com/sandeepannandi/Peer.git
cd Peer
npm ci
npm run demo:local
```

The compiled no-credential demo runs in a temporary directory and cleans up.
It does not read a project `.env` or contact GitHub/Claude. Its reviewer is a
deterministic fixture stub, not a live model benchmark.

For live use, copy `.env.example` to `.env` (`cp` in Bash or `Copy-Item` in
PowerShell) and add the GitHub App settings. Run `npm run dev -- doctor`, or
`npm run build` then `node dist/index.js doctor`. There is no `npm run doctor`
script and setup does not install the private package as a global `peer`
command. Doctor verifies explicit local auth status, not a model request.

## Quality checks

Run all checks before submitting a change:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run smoke:compiled
```

Use `npm run lint:fix` and `npm run format` for automatic fixes. The combined `npm run ci` command runs the complete quality gate.

## Making changes

1. Create a focused branch.
2. Keep changes small and scoped to one behavior or module.
3. Add or update tests for new behavior and regressions.
4. Run the quality checks.
5. Submit a pull request with a clear summary, test evidence, and any operational notes.

## Testing conventions

- Use Vitest and temporary directories for filesystem state.
- Stub Octokit, Git execution, and Claude SDK calls instead of making network requests.
- Keep tests deterministic and independent of the current working directory.
- Add cross-repo integration coverage when changing retrieval, context packing, or review formatting.
- Add security tests for credential handling, webhook verification, and output validation.

## Fixture conventions

Local fixtures live under `tests/fixtures/<repo>/`. A local pull request uses:

```text
tests/fixtures/<repo>/prs/<number>.diff
tests/fixtures/<repo>/prs/<number>.json
```

The `.diff` file contains a unified diff. The optional `.json` file contains title, body, base branch, and head SHA metadata.

## Security rules

- Do not commit `.env`, private keys, generated databases, mirrors, workspaces, logs, or other local state.
- Do not introduce direct Anthropic API usage.
- Do not log tokens or private-key contents.
- Keep webhook signature verification enabled in every deployment path.

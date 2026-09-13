# AGENTS.md

## Project conventions

- Use strict TypeScript with `NodeNext` module resolution. Keep explicit `.js` extensions on local imports.
- Keep modules small and focused. Inject GitHub, Claude Code, database, and filesystem dependencies where behavior must be testable.
- Use `pino` for application logs. Reserve direct console output for CLI result payloads.
- Never call the Anthropic API or direct GitHub App credentials.
- Reviews must run through Claude Code with subscription authentication. Never add a direct Anthropic API integration.
- Never persist installation tokens, private keys, or generated review data in repository files.
- Keep the PR repository out of cross-repo context results and keep context packing within the configured character budget.
- Anchor inline findings only to valid new-file lines in the diff.

## Testing

- Use Vitest for unit and integration tests.
- Use temporary directories for mirrors, databases, and workspaces; remove them after each test.
- Stub network clients and the Claude SDK query function. Tests must not depend on network access or a signed-in Claude session.
- Add focused tests beside the affected module and add end-to-end coverage under `tests/local/` for retrieval, packing, and review output.
- Cover security-sensitive behavior such as token redaction, webhook signature verification, credential guards, schema validation, and context-budget limits.

## Quality checks

Run the complete local quality gate before opening a change:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

The equivalent combined command is:

```sh
npm run ci
```

## Review checklist

- Environment variables are validated by `src/config/env.ts`.
- GitHub App tokens are short-lived, redacted from errors, and stripped from mirror remotes.
- Webhook payloads are verified with `X-Hub-Signature-256`.
- Context files include repository and path headers and never include the PR repository.
- Review output is validated against `ReviewSchema` before formatting or posting.
- Posted reviews are deduplicated by owner, repository, pull request, and head SHA.

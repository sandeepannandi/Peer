#!/usr/bin/env bash
set -euo pipefail

# One-command demo (PLAN.md §20): mirror + index + review a real PR.
# Usage: scripts/demo.sh <owner> <repo> <pr> [--post]
#   e.g.  scripts/demo.sh acme api 42 --post

OWNER="${1:-}"
REPO="${2:-}"
PR="${3:-}"
POST="${4:-}"

# Zero-credential fixture demo: runs the full pipeline on the bundled
# repo-a/repo-b fixtures — no GitHub account, no AI, nothing to install.
if [[ "$POST" == "--local" ]]; then
  echo "==> running local fixture demo (no GitHub, no AI required)"
  npm run dev -- review --owner acme --repo repo-a --pr 1 --local
  echo "==> done. Fixture review saved under data/workspace/"
  exit 0
fi

if [[ -z "$OWNER" || -z "$REPO" || -z "$PR" ]]; then
  echo "Usage: scripts/demo.sh <owner> <repo> <pr> [--post|--local]" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill in your GitHub App credentials." >&2
  exit 1
fi

echo "==> mirroring org repos"
npm run dev -- mirror --owner "$OWNER"

echo "==> building index"
npm run dev -- index --owner "$OWNER"

if [[ "$POST" == "--post" ]]; then
  echo "==> reviewing and posting PR $PR"
  npm run dev -- review --owner "$OWNER" --repo "$REPO" --pr "$PR" --post
else
  echo "==> reviewing PR $PR (add --post to publish to GitHub)"
  npm run dev -- review --owner "$OWNER" --repo "$REPO" --pr "$PR"
fi

echo "==> done. Workspace: data/workspace/"

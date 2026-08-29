#!/usr/bin/env bash
# Is the committed bundle the one this source produces?
#
# A JavaScript action runs `dist/index.js` and nothing else, so an edit under
# src/ that was not rebuilt means CI executes the OLD logic and reports success.
# That is this fleet's documented generated-artifact failure -- "a stale dist
# does not fail, it does the OLD thing and reports success" -- arriving in the
# one file every consuming repository runs.
#
# Rebuild and diff. Deliberately NOT a timestamp comparison: a fresh clone,
# `git checkout` and `git worktree add` all restamp files, so mtimes would
# report staleness on a tree that is fine and teach everyone to ignore it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run --silent build:action >/dev/null

if git diff --quiet -- dist/; then
    echo "bundle is current ($(wc -c < dist/index.js) bytes)"
    exit 0
fi

printf '\n\033[31mThe committed bundle does not match src/.\033[0m\n' >&2
git --no-pager diff --stat -- dist/ >&2
printf '\nRun `npm run build:action` and commit dist/.\n' >&2
exit 1

#!/usr/bin/env bash
# The built bundle, enforcing coverage against a stubbed GitHub API.
#
# `check:bundle` proves the bundle is CURRENT and the unit tests prove the
# decision is RIGHT. Neither proves the two are wired together — inputs read,
# event payload parsed, pages followed, verdict acted on, exit code set. Each of
# those is a place the gate could pass while checking nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT=8749
trap 'rm -rf "$WORK"; kill %1 2>/dev/null || true' EXIT

mkdir -p "$WORK/repo"
cat > "$WORK/repo/feature-map.json" <<'JSON'
{ "product": "e2e", "governedRoots": ["apps/**"],
  "featureGroups": [{ "key": "BILLING", "name": "Billing",
    "features": [{ "key": "BILLING.INVOICES", "name": "Invoices",
                   "codePaths": ["apps/web/billing/**"] }] }] }
JSON
printf '[submodule "apps/web"]\n\tpath = apps/web\n' > "$WORK/repo/.gitmodules"
echo '{"pull_request":{"number":7}}' > "$WORK/event.json"

cat > "$WORK/api.mjs" <<'JS'
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"
const files = JSON.parse(process.env.STUB_FILES)
// COMMENT_MODE: ok | forbidden | existing — so the e2e can drive the paths that
// matter, including the one where a fork's read-only token refuses the write.
const mode = process.env.COMMENT_MODE ?? "ok"
const log = process.env.COMMENT_LOG
createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.endsWith("/files")) {
    const page = Number(url.searchParams.get("page") ?? "1")
    return json(200, page === 1 ? files : [])
  }
  if (url.pathname.includes("/issues/")) {
    if (mode === "forbidden") return json(403, { message: "Resource not accessible by integration" })
    if (req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1")
      const existing = mode === "existing" && page === 1
        ? [{ id: 42, body: "stale verdict <!-- feature-mapping-comment -->" }]
        : []
      return json(200, existing)
    }
    let body = ""
    req.on("data", (c) => { body += c })
    return req.on("end", () => {
      if (log) appendFileSync(log, `${req.method} ${url.pathname}\n`)
      json(req.method === "POST" ? 201 : 200, { id: 42 })
    })
  }
  json(404, {})
}).listen(Number(process.env.PORT), () => process.stdout.write("ready\n"))
JS

fail=0
run_case() {
    local what="$1" want="$2" files="$3"
    STUB_FILES="$files" PORT="$PORT" COMMENT_MODE="${COMMENT_MODE:-ok}" COMMENT_LOG="$WORK/comments" \
      node "$WORK/api.mjs" >/dev/null 2>&1 &
    local api=$!
    sleep 1
    set +e
    GITHUB_WORKSPACE="$WORK/repo" GITHUB_OUTPUT="$WORK/out" GITHUB_EVENT_PATH="$WORK/event.json" \
      GITHUB_REPOSITORY="o/r" GITHUB_API_URL="http://127.0.0.1:$PORT" INPUT_TOKEN="t" \
      node "$ROOT/dist/index.js" > "$WORK/log" 2>&1
    local got=$?
    set -e
    kill "$api" 2>/dev/null || true; wait "$api" 2>/dev/null || true

    if [ "$got" = "$want" ]; then
        printf '  ok   %s (exit %s)\n' "$what" "$got"
    else
        printf '  \033[31mFAIL\033[0m %s — exit %s, wanted %s\n' "$what" "$got" "$want" >&2
        sed 's/^/       | /' "$WORK/log" >&2
        fail=1
    fi
}

run_case "a mapped file passes"                       0 '[{"filename":"apps/web/billing/x.ts","status":"modified"}]'
run_case "an unmapped governed file FAILS"            1 '[{"filename":"apps/web/rogue.ts","status":"added"}]'
run_case "THE REGRESSION: a gitlink bump passes"      0 '[{"filename":"apps/web","status":"modified"}]'
run_case "a removed governed file passes"             0 '[{"filename":"apps/web/gone.ts","status":"removed"}]'
run_case "an out-of-scope file passes"                0 '[{"filename":"docs/x.md","status":"modified"}]'
run_case "one bad file among good ones still FAILS"   1 '[{"filename":"apps/web/billing/x.ts","status":"modified"},{"filename":"apps/web/rogue.ts","status":"added"}]'

# Without a token the coverage half cannot read anything, and the action must
# FAIL rather than skip -- a gate that quietly checks nothing is worse than one
# that is switched off.
set +e
GITHUB_WORKSPACE="$WORK/repo" GITHUB_OUTPUT="$WORK/out" GITHUB_EVENT_PATH="$WORK/event.json" \
  GITHUB_REPOSITORY="o/r" env -u INPUT_TOKEN node "$ROOT/dist/index.js" >/dev/null 2>&1
notoken=$?
set -e
if [ "$notoken" = "1" ]; then printf '  ok   a missing token FAILS rather than skipping\n'
else printf '  \033[31mFAIL\033[0m a missing token should fail, got %s\n' "$notoken" >&2; fail=1; fi

# A push run has no pull request. It must validate the map and say plainly that
# it had nothing to gate, rather than reporting a coverage pass it never made.
set +e
# `env -u`, because CI SETS GITHUB_EVENT_PATH — without clearing it this case
# reads the runner's own pull_request payload instead of the absence it means
# to test, and asserts nothing about a push run.
env -u GITHUB_EVENT_PATH GITHUB_WORKSPACE="$WORK/repo" GITHUB_OUTPUT="$WORK/out" GITHUB_REPOSITORY="o/r" \
  node "$ROOT/dist/index.js" > "$WORK/push.log" 2>&1
push=$?
set -e
if [ "$push" = "0" ] && grep -q "no changed files to gate" "$WORK/push.log"; then
    printf '  ok   a non-pull-request run says it had nothing to gate\n'
else
    printf '  \033[31mFAIL\033[0m non-PR run: exit %s\n' "$push" >&2; sed 's/^/       | /' "$WORK/push.log" >&2; fail=1
fi

# ── the comment ─────────────────────────────────────────────────────────────
: > "$WORK/comments"
run_case "a comment is POSTed when none exists"       0 '[{"filename":"apps/web/billing/x.ts","status":"modified"}]'
grep -q "^POST /repos/o/r/issues/7/comments" "$WORK/comments" \
    && printf '  ok   the report is posted as a new comment\n' \
    || { printf '  \033[31mFAIL\033[0m no comment was posted\n' >&2; fail=1; }

: > "$WORK/comments"
COMMENT_MODE=existing run_case "an existing comment is PATCHed, not duplicated" 0 '[{"filename":"apps/web/billing/x.ts","status":"modified"}]'
grep -q "^PATCH /repos/o/r/issues/comments/42" "$WORK/comments" \
    && printf '  ok   an existing comment is updated in place\n' \
    || { printf '  \033[31mFAIL\033[0m the existing comment was not updated\n' >&2; fail=1; }

# THE ONE THAT MATTERS. A fork's token is read-only whatever the workflow
# grants, so a 403 here must not turn a passing gate red -- otherwise every fork
# pull request fails for a reason unrelated to coverage.
COMMENT_MODE=forbidden run_case "a 403 on the comment does NOT fail a passing gate" 0 '[{"filename":"apps/web/billing/x.ts","status":"modified"}]'
COMMENT_MODE=forbidden run_case "...and does not rescue a failing one either"      1 '[{"filename":"apps/web/rogue.ts","status":"added"}]'

[ "$fail" = 0 ] && printf '\n\033[32mACTION E2E OK\033[0m — 14 cases\n' || { printf '\n\033[31mACTION E2E FAILED\033[0m\n' >&2; exit 1; }

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
const files = JSON.parse(process.env.STUB_FILES)
createServer((req, res) => {
  const page = Number(new URL(req.url, "http://x").searchParams.get("page") ?? "1")
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(page === 1 ? files : []))
}).listen(Number(process.env.PORT), () => process.stdout.write("ready\n"))
JS

fail=0
run_case() {
    local what="$1" want="$2" files="$3"
    STUB_FILES="$files" PORT="$PORT" node "$WORK/api.mjs" >/dev/null 2>&1 &
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

[ "$fail" = 0 ] && printf '\n\033[32mACTION E2E OK\033[0m — 8 cases\n' || { printf '\n\033[31mACTION E2E FAILED\033[0m\n' >&2; exit 1; }

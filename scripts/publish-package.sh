#!/usr/bin/env bash
# Copyright (C) 2026 StoneDogCode L.L.C.
# SPDX-License-Identifier: Apache-2.0
#
# Publish @stonedogcode/featuremap to npm, end to end.
#
#   npm run publish:stonedog-featuremap
#
# Run it from a terminal, INTERACTIVELY. npm prompts for the 2FA one-time
# password itself (account `stonedogcode`) and the login flow needs a browser —
# neither works unattended, which is why this is a script a person runs rather
# than a step in CI. An agent cannot complete it.
#
# You do NOT need to log in first. If `npm whoami` comes back empty the script
# starts `npm login` for you and carries on, the way the sibling packages'
# scripts do. Refusing there only makes the operator run the whole preflight a
# second time for no reason.
#
# It keeps the lesson those scripts were built on: a publish that prints no
# error can still have published nothing, or the wrong thing. So it reads the
# tarball before publishing and installs from the REGISTRY afterwards, because
# "the registry lists it" and "a consumer can install it" are different claims
# and the second is the last to start answering yes.
#
# ## Traps specific to this package
#
# 1. `./schema` exports a JSON FILE. `files` must ship `schema/`, and a tarball
#    missing it installs cleanly — the failure appears only when a consumer
#    resolves that entry point, or worse when Ajv compiles an empty object and
#    validates everything. `verify:package` resolves it and asserts it has
#    substance.
#
# 2. It ships TypeScript SOURCE under `src/`, so anything shipped there is
#    parsed by the consumer's build. `files` excludes `src/**/__tests__/**` and
#    `verify:package` refuses a tarball that carries test files anyway.
#
# 3. `ajv` is a runtime DEPENDENCY, not a peer. Moved to devDependencies it
#    would install fine and throw at the consumer's first validate() call.
#
# 4. The scope. A scoped package defaults to `access: restricted` on npm;
#    publishing one without `--access public` succeeds, prints nothing unusual,
#    and then 404s for every consumer — which reads as a missing package rather
#    than as a private one.
#
# 5. `engines` is `>=22`, matching the fleet's newer packages. Do not "fix" it
#    downward to match an older consumer; bump the consumer.
set -euo pipefail

PACKAGE="@stonedogcode/featuremap"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { printf '\n\033[31mREFUSING: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Publish from a clean, current `main`.
# ---------------------------------------------------------------------------
step "1/7  checkout state"

BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || fail "this checkout is in detached HEAD. Run: git checkout main && git pull"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH'. Publish from main: a tarball built from a feature branch carries code no tag can find."
[ -z "$(git status --porcelain | grep -v '^??' || true)" ] || fail "the working tree has uncommitted changes. A publish is not reproducible from a dirty tree."

git fetch -q origin
BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$BEHIND" = "0" ] || fail "this checkout is $BEHIND commit(s) behind origin/main. A stale checkout publishes a tarball missing the thing you are publishing for, and it looks like a success."

echo "on main, clean, up to date with origin/main"

# ---------------------------------------------------------------------------
# 2. The version must not already exist. Once published it can never be reused.
# ---------------------------------------------------------------------------
step "2/7  version"

VERSION="$(node -p "require('./package.json').version")"
echo "about to publish $PACKAGE@$VERSION"

# `npm view` exits non-zero with E404 for a package that has never been
# published, which is the expected state for a first release — so a failure here
# is not evidence of anything on its own.
PUBLISHED="$(npm view "$PACKAGE@$VERSION" version 2>/dev/null || true)"
[ -z "$PUBLISHED" ] || fail "$PACKAGE@$VERSION is already on the registry. A version ships at most once; bump with npm run version:bump:patch."

# ---------------------------------------------------------------------------
# 3. The gate. Never publish something whose tests were not run.
# ---------------------------------------------------------------------------
step "3/7  gate (typecheck, lint, unit, integration)"
npm run gate

# ---------------------------------------------------------------------------
# 4. Prove the PACKAGE, not just the checkout.
# ---------------------------------------------------------------------------
step "4/7  verify the tarball as a consumer would"
npm run verify:package

# ---------------------------------------------------------------------------
# 5. The right account.
# ---------------------------------------------------------------------------
step "5/7  npm account"

# A 404 from `npm publish` means AUTH, not a missing package — npm answers 404
# rather than 403 so it will not leak whether a package exists. `npm whoami`
# turns that confusing failure into a clear one, and is the only thing that
# reveals an `_authToken` that is present but expired.
if ! WHOAMI="$(npm whoami 2>/dev/null)"; then
  echo "  not logged in — starting the browser login flow"
  npm login
  WHOAMI="$(npm whoami)"
fi
echo "  authenticated as $WHOAMI"
[ "$WHOAMI" = "stonedogcode" ] || printf '\033[33m  warning: expected account stonedogcode\033[0m\n'

# Ownership, but only if the package already exists. On a first publish there is
# nothing to own yet, and `npm owner ls` on a nonexistent package fails in a way
# that reads exactly like a permissions problem.
if npm view "$PACKAGE" version >/dev/null 2>&1; then
  npm owner ls "$PACKAGE" 2>/dev/null | grep -q "^$WHOAMI " \
    || fail "'$WHOAMI' is not an owner of $PACKAGE, so publishing will fail with a misleading 404."
  echo "  $WHOAMI is an owner of $PACKAGE"
else
  echo "  $PACKAGE does not exist on the registry yet — this is the FIRST publish, which creates it"
fi

# ---------------------------------------------------------------------------
# 6. Publish. npm prompts for the OTP here.
# ---------------------------------------------------------------------------
step "6/7  publish"
printf 'npm will prompt for your 2FA one-time password.\n'
npm publish --access public

# ---------------------------------------------------------------------------
# 7. Prove a consumer can actually install it.
# ---------------------------------------------------------------------------
step "7/7  install from the registry"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"
cat > package.json <<'JSON'
{ "name": "registry-check", "private": true, "type": "module", "version": "1.0.0" }
JSON

# The registry is eventually consistent; a fresh version can 404 for a few
# seconds after a successful publish.
INSTALLED=""
for attempt in 1 2 3 4 5 6; do
  if npm install --silent --no-audit --no-fund "$PACKAGE@$VERSION" >/dev/null 2>&1; then
    INSTALLED="yes"
    break
  fi
  echo "  not installable yet (attempt $attempt), waiting…"
  sleep 10
done
[ -n "$INSTALLED" ] || fail "$PACKAGE@$VERSION published but could not be installed from the registry."

RESOLVED="$(node -p "require('$PACKAGE/package.json').version")"
[ "$RESOLVED" = "$VERSION" ] || fail "installed $RESOLVED but published $VERSION"

# Read the entry points back off the INSTALLED copy, so this proves the
# published `exports` map rather than the local one — and resolve the schema,
# because it is a data file and its absence is invisible until someone reads it.
node -e "
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(process.cwd() + '/');
const pkg = JSON.parse(readFileSync(require.resolve('$PACKAGE/package.json'), 'utf8'));
for (const key of ['.', './schema', './package.json']) {
  if (!(key in pkg.exports)) { console.error('missing export ' + key); process.exit(1); }
}
const schema = req('$PACKAGE/schema');
if (!schema['\$defs'] || !schema['\$defs'].featureGroup) {
  console.error('the published ./schema is empty or truncated, which would accept every document');
  process.exit(1);
}
console.log('published exports:', Object.keys(pkg.exports).join(', '));
console.log('schema resolves:', schema.title);
"

printf '\n\033[32mPUBLISHED\033[0m  %s@%s — verified installable from the registry.\n' "$PACKAGE" "$VERSION"
printf 'Next: the feature-map gate can now depend on it (NEH-1203/NEH-1201), and remember a published version can never be reused.\n'

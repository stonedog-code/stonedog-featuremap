#!/usr/bin/env bash
# Copyright (C) 2026 StoneDogCode L.L.C.
# SPDX-License-Identifier: Apache-2.0
#
# Prove the PACKAGE works, not just the checkout.
#
# Everything the test suite does runs against source files sitting in this
# repository, where `files`, the `exports` map and the tarball contents are
# invisible. Those are exactly what breaks at publish time — after review, when
# the version is already burned and cannot be reused.
#
# So: pack it, install the tarball into a throwaway project, and use it the way a
# consumer would — typecheck against the published `exports`, then RUN the
# validator in both directions.
#
# ## Both directions, because this package's whole job is refusing
#
# A validator that accepts everything passes any check that only feeds it valid
# input. So the consumer script below asserts a good map is accepted AND a bad
# one is refused. Checking only the first would let a tarball whose schema file
# is empty or truncated sail through — and an empty JSON Schema accepts every
# document, which is the exact failure this package exists to prevent.
#
# ## Traps specific to this package
#
# 1. `./schema` exports a JSON FILE, not code. `files` must ship `schema/`, and
#    a tarball missing it installs cleanly: the failure only appears when a
#    consumer resolves that entry point, or — worse — when Ajv compiles an empty
#    object and validates everything.
#
# 2. `ajv` is a real runtime DEPENDENCY, not a peer. If it ever moves to
#    devDependencies the package installs fine and throws at first use, so the
#    consumer check below imports and actually validates rather than only
#    typechecking.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Sanity floor for the tarball. Comfortably under the real count so ordinary
# growth does not trip it, far above what a `files`-misconfigured package would
# produce (3: package.json, README, LICENSE).
MIN_FILES=8

fail() { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

# The filename is read by GLOBBING the (empty, freshly-made) destination, not by
# taking the last line of `npm pack`'s output. `npm pack | tail -1` is the
# obvious form and it is unreliable: npm's notice block is not consistently on
# stderr, so `tail -1` sometimes returns a notice line instead of the filename.
# Every `tar -tzf` then reads nothing and the script reports a MISSING ENTRY
# POINT for a tarball that contains it — a guard failing for the wrong reason,
# which sends the reader to fix a file that is fine.
npm pack --pack-destination "$WORK" >/dev/null 2>&1 || fail "npm pack failed"
TARBALL="$(find "$WORK" -maxdepth 1 -name '*.tgz' | head -1)"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || fail "npm pack produced no tarball in $WORK"
echo "packed: $(basename "$TARBALL")"

# The listing is read ONCE into a variable, and nothing below pipes into
# `grep -q`. Under `set -o pipefail` that combination is a real trap: `grep -q`
# exits on first match, `tar` dies of SIGPIPE (141), and the pipeline reports
# failure — so a successful match reads as "no match" and the guard silently
# never fires. `grep -c` consumes all its input and cannot provoke it.
LISTING="$(tar -tzf "$TARBALL")"

FILES="$(printf '%s\n' "$LISTING" | grep -c . || true)"
echo "tarball contains $FILES entries"
[ "$FILES" -ge "$MIN_FILES" ] || fail "only $FILES entries in the tarball; expected at least $MIN_FILES. Check \`files\` in package.json."

# No test file may reach a consumer. They import jest globals that are not
# dependencies, and this package ships SOURCE, so anything under src/ may be
# parsed by a consumer's build.
case "$LISTING" in
  *__tests__*)
    printf '%s\n' "$LISTING" | grep "__tests__" >&2 || true
    fail "the tarball contains test files"
    ;;
esac
echo "no test files in the tarball"

# Every path the `exports` map names, plus the modules the barrel re-exports —
# a `files` pattern could ship the barrel without them, and a tarball missing
# any of these installs cleanly and fails at the consumer's first import.
for entry in \
  package/src/index.ts \
  package/src/validate.ts \
  package/src/derive.ts \
  package/src/types.ts \
  package/schema/feature-map.schema.json
do
  found="$(printf '%s\n' "$LISTING" | grep -Fxc "$entry" || true)"
  [ "$found" -ge 1 ] || fail "the tarball is missing $entry, which the package needs"
done
echo "the barrel, its modules and the schema file are all present"

mkdir -p "$WORK/consumer/src"
cd "$WORK/consumer"

cat > package.json <<'JSON'
{ "name": "consumer-check", "private": true, "type": "module", "version": "1.0.0" }
JSON

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "resolveJsonModule": true, "lib": ["esnext"], "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
JSON

# Imports through the package NAME, never a relative path, so this resolves via
# the published `exports` map rather than the local file layout.
cat > src/check.ts <<'TS'
import {
  validate, validateText, schema,
  featureKeys, claimedPaths, duplicateKeys, misprefixedFeatureKeys, isLeafGroup,
  type FeatureMap, type Validation,
} from "@stonedogcode/featuremap";

const NESTED: FeatureMap = {
  product: "consumer-check",
  governedRoots: ["src/"],
  featureGroups: [
    {
      key: "BILLING",
      name: "Billing",
      features: [
        { key: "BILLING.INVOICES", name: "Invoices", codePaths: ["src/billing/invoice.ts"] },
      ],
    },
  ],
};

const LEAF: FeatureMap = {
  product: "consumer-check-flat",
  governedRoots: ["src/"],
  featureGroups: [{ key: "SCANNER", name: "Scanner", codePaths: ["src/scanner/**"] }],
};

// The schema must be a real document. An empty or truncated one accepts every
// input, so the "refuses" assertions below would pass over nothing.
const defs = (schema as { $defs?: Record<string, unknown> }).$defs ?? {};
if (!("featureGroup" in defs)) throw new Error("the exported schema has no featureGroup definition");

// --- accepts ---------------------------------------------------------------
const ok: Validation = validate(NESTED);
if (!ok.valid) throw new Error("a valid nested map was refused");
if (!validate(LEAF).valid) throw new Error("a valid flat map was refused");

// --- refuses, which is the half a broken tarball would silently drop --------
const both = JSON.parse(JSON.stringify(NESTED)) as Record<string, unknown>;
(both.featureGroups as Record<string, unknown>[])[0]!.codePaths = ["src/x.ts"];
if (validate(both).valid) throw new Error("a group with BOTH codePaths and features was accepted");

const noRoots = JSON.parse(JSON.stringify(NESTED)) as Partial<FeatureMap>;
delete noRoots.governedRoots;
if (validate(noRoots).valid) throw new Error("a map with no governedRoots was accepted");

const escaping = JSON.parse(JSON.stringify(LEAF)) as FeatureMap;
escaping.featureGroups[0]!.codePaths = ["../../etc/passwd"];
if (validate(escaping).valid) throw new Error("a path escaping the repository was accepted");

if (validateText("{ not json").valid) throw new Error("unparseable JSON was accepted");

// --- derivations -----------------------------------------------------------
if (featureKeys(NESTED).join() !== "BILLING.INVOICES") throw new Error("featureKeys broken");
if (featureKeys(LEAF).join() !== "SCANNER") throw new Error("a leaf group must count as a feature");
if (claimedPaths(LEAF).length !== 1) throw new Error("claimedPaths broken");
if (duplicateKeys(LEAF).length !== 0) throw new Error("a leaf key must not read as its own duplicate");
if (misprefixedFeatureKeys(NESTED).length !== 0) throw new Error("misprefixedFeatureKeys broken");
if (!isLeafGroup(LEAF.featureGroups[0]!)) throw new Error("isLeafGroup broken");

console.log("consumer check OK");
TS

npm install --silent --no-audit --no-fund "$TARBALL" typescript@^5.7.2 @types/node@^22 >/dev/null
echo "installed the tarball into a throwaway consumer"

# `ajv` must have come along as a real dependency. If it ever moves to
# devDependencies the install still succeeds and the package throws at first
# use, which is a runtime failure in someone else's build.
[ -d node_modules/ajv ] || fail "ajv did not install as a dependency of the package; it must not be a devDependency"
echo "ajv resolved as a runtime dependency"

# The JSON entry point, resolved through the published exports map.
node -e "
const { createRequire } = require('node:module');
const req = createRequire(process.cwd() + '/');
const s = req('@stonedogcode/featuremap/schema');
if (!s || !s['\$defs'] || !s['\$defs'].featureGroup) {
  console.error('the ./schema export did not resolve to a usable schema');
  process.exit(1);
}
console.log('./schema resolves, title:', s.title);
" || fail "the ./schema export is not usable by a consumer"

npx tsc --noEmit || fail "the package does not typecheck through its published exports"
echo "typecheck through published exports: clean"

npx tsx src/check.ts 2>/dev/null || npx --yes tsx src/check.ts || fail "the installed package does not run"

printf '\n\033[32mPACKAGE OK\033[0m — packed, installed, typechecked and executed as a consumer, in both directions.\n'

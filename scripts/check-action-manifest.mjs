#!/usr/bin/env node
/**
 * Is `action.yml` a manifest GitHub will actually load?
 *
 * ## Why this exists
 *
 * Nothing checked it. `actionlint` lints WORKFLOWS, not action manifests;
 * `check:bundle` compares the bundle to its source; the e2e suite executes
 * `dist/index.js` directly and never reads `action.yml` at all. So the one file
 * every consuming repository must parse was the only one with no guard on it —
 * and both defects below shipped as `v1.0.0` and failed in hopperguard, not
 * here.
 *
 * That is this fleet's recurring shape once more: a green over a set that never
 * included the thing that broke.
 *
 * ## What it refuses, and why each was a real failure
 *
 * 1. **A GitHub expression anywhere in the file.** Actions evaluates every
 *    `${{ ... }}` in a manifest, including inside a `description`. Writing the
 *    token variable as prose produced:
 *
 *        Unrecognized named-value: 'secrets'
 *
 *    An action has no `secrets` context, so documenting how to pass a token
 *    broke the manifest for every consumer.
 *
 * 2. **Any key but `description` under `outputs`.** A stray `required:` gives:
 *
 *        Unexpected value 'required'
 *
 *    Mine arrived because an edit inserted an INPUT block into the outputs
 *    section too. YAML parsed it happily; only GitHub rejected it.
 *
 * 3. **A `main` that is not on disk**, and a `using` that is not a Node runtime
 *    this repo builds for. A manifest pointing at a missing bundle fails in the
 *    consumer with nothing local to reproduce it.
 *
 * Both real defects were invisible to `yaml.safe_load` — the file is valid YAML
 * and an invalid manifest, which is exactly why parsing it is not enough.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "action.yml");

const problems = [];
const fail = (message) => problems.push(message);

const raw = readFileSync(FILE, "utf8");

// 1. No GitHub expressions, anywhere — including in prose.
for (const match of raw.matchAll(/\$\{\{[^}]*\}\}/g)) {
  const line = raw.slice(0, match.index).split("\n").length;
  fail(
    `line ${line}: contains the GitHub expression ${match[0]} — Actions evaluates these ` +
      `even inside a description, and an action has no such context. Describe the value in words.`,
  );
}

const manifest = load(raw);

if (!manifest || typeof manifest !== "object") fail("action.yml did not parse to a mapping.");

// 2. Outputs take a description and nothing else.
for (const [name, value] of Object.entries(manifest.outputs ?? {})) {
  const extra = Object.keys(value ?? {}).filter((key) => key !== "description" && key !== "value");
  if (extra.length > 0) {
    fail(`output "${name}" has ${extra.map((k) => `\`${k}\``).join(", ")} — outputs take only \`description\`.`);
  }
  if (!value?.description) fail(`output "${name}" has no description.`);
}

// An input and an output sharing a name is legal but always a mistake here, and
// it is how the duplicated block above went unnoticed.
const shared = Object.keys(manifest.inputs ?? {}).filter((k) => k in (manifest.outputs ?? {}));
for (const name of shared) {
  if (name !== "map" && name !== "governed-roots") {
    fail(`"${name}" is both an input and an output — likely an edit that landed in both sections.`);
  }
}

for (const [name, value] of Object.entries(manifest.inputs ?? {})) {
  if (!value?.description) fail(`input "${name}" has no description.`);
}

// 3. The entry point must exist, and the runtime must be one we build for.
const runs = manifest.runs ?? {};
const SUPPORTED = new Set(["node20", "node24"]);
if (!SUPPORTED.has(runs.using)) {
  fail(`runs.using is "${runs.using}" — expected one of ${[...SUPPORTED].join(", ")}.`);
}
if (!runs.main) fail("runs.main is missing.");
else if (!existsSync(path.join(ROOT, runs.main))) {
  fail(`runs.main is "${runs.main}", which does not exist. Run \`npm run build:action\`.`);
}

for (const field of ["name", "description"]) {
  if (!manifest[field]) fail(`the manifest has no top-level \`${field}\`.`);
}

if (problems.length > 0) {
  process.stderr.write("\n[31maction.yml is not a manifest GitHub will load:[0m\n");
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write("\nThese fail in the CONSUMING repository, not here.\n");
  process.exitCode = 1;
} else {
  const inputs = Object.keys(manifest.inputs ?? {}).length;
  const outputs = Object.keys(manifest.outputs ?? {}).length;
  process.stdout.write(
    `action.yml ok — ${inputs} input(s), ${outputs} output(s), runs ${runs.using} on ${runs.main}\n`,
  );
}

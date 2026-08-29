/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * `validate <path>` -- the entry point the coverage gate calls.
 *
 * ## Three exit codes, because there are three outcomes
 *
 * | code | means |
 * |---|---|
 * | 0 | the map is valid |
 * | 1 | the map was read and is INVALID |
 * | 2 | the map could not be read at all |
 *
 * Collapsing 2 into 1 is the tempting simplification and it is wrong. "There is
 * no feature-map.json" and "your feature-map.json is malformed" send a person
 * to two completely different places, and a gate that cannot tell them apart
 * reports a missing file as a broken one -- which reads as "somebody corrupted
 * the map" when the truth is "this repository never had one".
 *
 * It also prints the size of what it examined on success. A validator that says
 * only "ok" has not told you whether it read the map you meant: `0 groups` and
 * `28 groups` are the same word otherwise.
 */

import { readFileSync } from "node:fs";

import { claimedPaths, featureKeys } from "./derive.js";
import { validateText } from "./validate.js";

function main(argv: string[]): number {
  const path = argv[0];
  if (!path) {
    process.stderr.write("usage: validate <path-to-feature-map.json>\n");
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${path} — ${(error as Error).message}\n`);
    return 2;
  }

  const result = validateText(text);
  if (!result.valid) {
    process.stderr.write(`${path} is not a valid feature map:\n`);
    for (const error of result.errors) {
      process.stderr.write(`  ${error.path || "(document)"}: ${error.message}\n`);
    }
    return 1;
  }

  const { map } = result;
  process.stdout.write(
    `${path}: valid — ${map.featureGroups.length} group(s), ` +
      `${featureKeys(map).length} feature(s), ` +
      `${claimedPaths(map).length} claimed path(s), ` +
      `${map.governedRoots.length} governed root(s)\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));

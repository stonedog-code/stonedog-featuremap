/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The schema, against the maps it was written for.
 *
 * ## Why this tier exists separately from the unit tests
 *
 * The unit tests validate fixtures this repository wrote. They prove the rules
 * fire, and prove nothing about whether the corpus can satisfy them -- a schema
 * that accepts its own examples and rejects every real document would pass all
 * of them. That gap is the seam, and it has already earned its place once: it
 * caught the first draft inventing kebab-case keys when every real map uses
 * SCREAMING_SNAKE.
 *
 * ## Read from `origin/main`, NOT from the working tree
 *
 * This first read the file on disk, and that was wrong in a way only using it
 * revealed. hopperguard's canonical checkout sits at whatever commit its owner
 * last worked from -- it was behind, with uncommitted submodule work, at the
 * moment the migration merged -- so the file on disk was the PRE-migration map
 * while `origin/main` had the migrated one. The suite would have gone red
 * saying "this map is invalid" when the truth was "this checkout is old". An
 * absent fix and an unpulled fix look identical.
 *
 * `git show origin/main:<file>` asks the question that actually matters -- is
 * the map valid AS MERGED -- and is independent of what anyone's working tree
 * holds. Every case prints the sha it read, so a disagreement is attributable
 * rather than mysterious.
 *
 * ## Why it is allowed to skip, and why the skip is loud
 *
 * These are private repositories cloned on one workstation. In CI they are
 * absent, so every case skips -- but the suite ALWAYS asserts how many maps it
 * examined and prints their names, so `0 examined` can never be mistaken for
 * `3 passed`. A green tier over an empty set is the failure this fleet keeps
 * repeating, and a test that silently examines nothing is the purest form of it.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { describe, expect, it } from "@jest/globals";

import { claimedPaths, featureKeys } from "../../src/derive.js";
import { validateText } from "../../src/validate.js";

/** The real maps, by the repository that owns them. */
const REAL_MAPS = [
  {
    repo: "hopperguard",
    // Migrated in ElderLink-Solutions/hopperguard#1108: `governedRoots` moved
    // out of the workflow, and the derived top-level `features` was dropped.
    clone: "/home/nehsa/src/elderlink/hopperguard",
    file: "feature-map.json",
  },
  {
    repo: "rozcards",
    // Needed no migration at all -- it is where `governedRoots` was done right,
    // and it never carried the denormalised top-level `features`.
    clone: "/home/nehsa/src/stonedogcode/card-sorter/rozcards",
    file: "feature-map.json",
  },
  {
    repo: "card-sorter/sorter-python",
    // Also already conformant, which was the surprise: the map nobody gated is
    // the one that needed no fixing. Its problem is the workflow beside it, not
    // the document.
    clone: "/home/nehsa/src/stonedogcode/card-sorter",
    file: "sorter-python/feature-map.json",
  },
] as const;

/**
 * The file as `origin/main` has it, or undefined if this clone cannot answer.
 *
 * Undefined covers every "not available here" case identically -- no clone, no
 * remote, no such path on main -- because for this suite they are one fact:
 * there is nothing to examine. A thrown error would instead read as a broken
 * map, which is the opposite of what it means.
 */
function fromOriginMain(clone: string, file: string): { body: string; sha: string } | undefined {
  if (!existsSync(clone)) return undefined;
  try {
    const sha = execFileSync("git", ["-C", clone, "rev-parse", "--short", "origin/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const body = execFileSync("git", ["-C", clone, "show", `origin/main:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { body, sha };
  } catch {
    return undefined;
  }
}

const resolved = REAL_MAPS.map((entry) => ({
  entry,
  found: fromOriginMain(entry.clone, entry.file),
}));
const present = resolved.filter((row) => row.found !== undefined);

describe("the real feature maps, as merged on origin/main", () => {
  it("says how many it examined, so a skip cannot read as a pass", () => {
    const names = present.map((row) => row.entry.repo).join(", ") || "(none)";
    process.stdout.write(
      `\n  examined ${present.length} of ${REAL_MAPS.length} real map(s): ${names}\n`,
    );
    // Not an assertion that any exist -- CI has none. It asserts the suite
    // KNOWS how many it looked at, which is the number a reader needs.
    expect(present.length).toBeLessThanOrEqual(REAL_MAPS.length);
  });

  for (const { entry, found } of resolved) {
    const run = found ? it : it.skip;

    run(`${entry.repo}: is valid`, () => {
      const { body, sha } = found!;
      const result = validateText(body);
      if (!result.valid) {
        process.stdout.write(
          `\n  ${entry.repo} @ ${sha}:\n${result.errors
            .map((error) => `    ${error.path || "(document)"}: ${error.message}`)
            .join("\n")}\n`,
        );
      }
      // There is deliberately no "not migrated yet" allowance. A map that does
      // not satisfy the schema should not be on main, and encoding "this one is
      // permitted to fail" is how a suite stops noticing that it still does.
      expect(result.valid).toBe(true);
    });

    run(`${entry.repo}: derivations run over it and report non-zero`, () => {
      const { body, sha } = found!;
      const parsed = JSON.parse(body);
      const keys = featureKeys(parsed);
      const paths = claimedPaths(parsed);
      process.stdout.write(
        `\n  ${entry.repo} @ ${sha}: ${parsed.featureGroups.length} group(s), ` +
          `${keys.length} feature(s), ${paths.length} claimed path(s)\n`,
      );
      // Both live shapes, over real data rather than the two fixtures upstairs.
      expect(keys.length).toBeGreaterThan(0);
      expect(paths.length).toBeGreaterThan(0);
    });
  }
});

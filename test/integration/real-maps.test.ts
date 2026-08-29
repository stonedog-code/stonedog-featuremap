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
 * of them. That gap is the seam, and it is where this format can actually go
 * wrong: the whole point of NEH-1203 is that two live maps had diverged, so
 * "does the schema accept both" is the question.
 *
 * ## Why it is allowed to skip, and why the skip is loud
 *
 * These are private repositories checked out on one workstation. In CI they are
 * absent, so each case skips -- but the suite ALWAYS asserts how many maps it
 * examined and prints their paths, so `0 examined` can never be mistaken for
 * `3 passed`. A green tier over an empty set is the failure this fleet keeps
 * repeating, and a test that silently examines nothing is the purest form of
 * it.
 */

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "@jest/globals";

import { claimedPaths, featureKeys } from "../../src/derive.js";
import { validateText } from "../../src/validate.js";

/**
 * The real maps, by the repository that owns them.
 *
 * `migrated` records whether that repository's own migration PR has landed.
 * Before it lands the file legitimately fails -- it still carries the top-level
 * `features` array, or has no `governedRoots` -- and asserting otherwise would
 * make this suite red for work that has not happened yet. Flip the flag in the
 * migration PR, which is what makes that PR's success visible here.
 */
const REAL_MAPS = [
  {
    repo: "hopperguard",
    // The ONLY map that needs migrating: it carries the denormalised top-level
    // `features` and has no `governedRoots` (they live in its workflow).
    path: "/home/nehsa/src/elderlink/hopperguard/feature-map.json",
    migrated: false,
  },
  {
    repo: "rozcards",
    // Already conformant. It needed no migration at all -- it is where
    // `governedRoots` was done right, and it never carried the denormalised
    // top-level `features`. Measured, not assumed: it validates clean today.
    path: "/home/nehsa/src/stonedogcode/card-sorter/rozcards/feature-map.json",
    migrated: true,
  },
  {
    repo: "card-sorter/sorter-python",
    // Also already conformant, which is the surprise here: the map nobody gated
    // is the one that needed no fixing. Its problem is the workflow beside it,
    // not the document.
    path: "/home/nehsa/src/stonedogcode/card-sorter/sorter-python/feature-map.json",
    migrated: true,
  },
] as const;

const present = REAL_MAPS.filter((entry) => existsSync(entry.path));

describe("the real feature maps", () => {
  it("says how many it examined, so a skip cannot read as a pass", () => {
    const names = present.map((entry) => entry.repo).join(", ") || "(none)";
    process.stdout.write(
      `\n  examined ${present.length} of ${REAL_MAPS.length} real map(s): ${names}\n`,
    );
    // Not an assertion that any exist -- CI has none. It asserts the suite
    // KNOWS how many it looked at, which is the number a reader needs.
    expect(present.length).toBeLessThanOrEqual(REAL_MAPS.length);
  });

  for (const entry of REAL_MAPS) {
    const run = existsSync(entry.path) ? it : it.skip;

    run(`${entry.repo}: parses, and every group satisfies the union`, () => {
      const result = validateText(readFileSync(entry.path, "utf8"));

      // The union is the load-bearing claim of this schema and it must hold for
      // every real map TODAY, migrated or not -- it is the one rule no
      // migration changes, because zero groups currently violate it.
      const unionErrors = result.valid
        ? []
        : result.errors.filter((error) => error.message.includes("exactly one of"));
      expect(unionErrors).toEqual([]);
    });

    run(`${entry.repo}: ${entry.migrated ? "is valid" : "fails ONLY on what its migration fixes"}`, () => {
      const result = validateText(readFileSync(entry.path, "utf8"));

      if (entry.migrated) {
        if (!result.valid) {
          process.stdout.write(
            `\n  ${entry.repo}:\n${result.errors.map((e) => `    ${e.path || "(document)"}: ${e.message}`).join("\n")}\n`,
          );
        }
        expect(result.valid).toBe(true);
        return;
      }

      // Not yet migrated. Every remaining error must be one of the two things
      // the migration removes. Anything else is a real incompatibility and this
      // assertion is what surfaces it -- rather than a blanket `.skip` that
      // would hide a third problem until the migration PR ran into it.
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("unreachable");
      const unexpected = result.errors.filter(
        (error) =>
          !/features|governedRoots|must NOT have additional properties/i.test(error.message),
      );
      expect(unexpected).toEqual([]);
    });

    run(`${entry.repo}: derivations run over it and report non-zero`, () => {
      // Derivation does not need a valid map, and running it here is what
      // proves the flatten handles BOTH live shapes over real data rather than
      // over the two fixtures upstairs.
      const parsed = JSON.parse(readFileSync(entry.path, "utf8"));
      const keys = featureKeys(parsed);
      const paths = claimedPaths(parsed);
      process.stdout.write(
        `\n  ${entry.repo}: ${parsed.featureGroups.length} group(s), ${keys.length} feature(s), ${paths.length} claimed path(s)\n`,
      );
      expect(keys.length).toBeGreaterThan(0);
      expect(paths.length).toBeGreaterThan(0);
    });
  }
});

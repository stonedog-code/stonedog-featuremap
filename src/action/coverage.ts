/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The coverage decision: does a changed file have to be claimed by a feature?
 *
 * Ported from hopperguard's `scripts/lib/feature-map-gate.mjs`, deliberately
 * and not from rozcards' inline copy. NEH-1201 is emphatic about which: the
 * rozcards version predates the gitlink fix below, and extracting it would
 * reintroduce that failure into every repository at once.
 *
 * These are pure functions over strings and sets. Everything that talks to
 * GitHub lives elsewhere, so the rule that decides whether a pull request is
 * blocked can be tested without a runner, an API, or a repository.
 */

import type { FeatureMap } from "../types.js";
import { features } from "../derive.js";

/**
 * Parse submodule paths out of a `.gitmodules` file.
 *
 * `.gitmodules` is the authoritative list, so the gate stays correct as
 * submodules are added or removed rather than depending on a hand-maintained
 * deny-list that would drift the first time somebody forgot it.
 */
export function parseSubmodulePaths(gitmodulesText: string): Set<string> {
  if (!gitmodulesText) return new Set();
  return new Set(
    gitmodulesText
      .split("\n")
      .map((line) => /^\s*path\s*=\s*(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]!),
  );
}

/**
 * Is this changed path a submodule gitlink, as opposed to a file inside one?
 *
 * Exact-path match only: `apps/web` is a gitlink, `apps/web/src/page.tsx` is a
 * file inside a submodule and is gated normally by that repository's own CI.
 */
export function isGitlink(filePath: string, submodulePaths: Set<string>): boolean {
  return submodulePaths.has(filePath);
}

/** Convert one glob to a RegExp. `**` crosses directories, `*` does not. */
function globToRegExp(glob: string): RegExp {
  const escape = (part: string) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = glob
    .split("**")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Does `filePath` match `glob`? */
export function matchesGlob(filePath: string, glob: string): boolean {
  return globToRegExp(glob).test(filePath);
}

/**
 * Is this path inside any governed root?
 *
 * A root of `src/` is a PREFIX, not a glob that must match the whole path --
 * rozcards writes `["src/"]` and means everything under it. A root containing
 * `*` is treated as a glob, which is how hopperguard writes `apps/**`. Both
 * live maps rely on their own reading, so the action supports both rather than
 * forcing one to change.
 */
export function isGoverned(filePath: string, governedRoots: readonly string[]): boolean {
  return governedRoots.some((root) =>
    root.includes("*") ? matchesGlob(filePath, root) : filePath.startsWith(root),
  );
}

export interface BlocksOptions {
  governed: boolean;
  submodulePaths: Set<string>;
  /** Did the change DELETE this path? */
  removed?: boolean;
}

/**
 * Should an unmapped changed file FAIL the gate?
 *
 * Only call this for files that matched no feature; a mapped file never blocks.
 *
 * ## The gitlink exemption, and why it is not a convenience
 *
 * Every `apps/*` and `packages/*` entry in a superproject is a git submodule,
 * so a pointer-bump pull request reports a change to the bare path (`apps/web`)
 * whose whole patch is `-Subproject commit <sha>` / `+Subproject commit <sha>`.
 * That path is a gitlink, never a code file, so it cannot be mapped to a
 * feature -- and it failed the gate on EVERY bump (hopperguard #483, #485,
 * #488, #489). The original comment is blunt about the cost: it "trained us to
 * merge those PRs red and cost the gate its meaning."
 *
 * A gate people have learned to merge past is worse than no gate, because it
 * still looks like one.
 *
 * ## A removed path can never be mapped
 *
 * Also not a convenience. Removing a submodule deletes the gitlink AND its
 * `.gitmodules` entry in one commit, so the exemption above disappears in
 * exactly the commit that needs it: the gate then demands a feature-map entry
 * for a path that no longer exists, and adding one to satisfy it would be worse
 * than the violation. Found while removing `packages/hopper-mud` (NEH-635).
 */
export function blocksGate(
  filePath: string,
  { governed, submodulePaths, removed = false }: BlocksOptions,
): boolean {
  if (!governed) return false;
  if (removed) return false;
  return !isGitlink(filePath, submodulePaths);
}

/** One changed file, in the shape the GitHub API reports it. */
export interface ChangedFile {
  filename: string;
  status?: string;
}

export interface CoverageVerdict {
  /** Governed, unmapped, and not exempt — these fail the gate. */
  blocking: string[];
  /** Outside every governed root. Reported, never blocking. */
  outOfScope: string[];
  /** Claimed by at least one feature. */
  mapped: string[];
  /** Governed and unmapped, but exempt (a gitlink, or removed). */
  exempt: string[];
}

/**
 * Classify every changed file against the map.
 *
 * Returns four disjoint lists rather than a boolean, because the caller has to
 * report what it examined. `0 blocking over 0 examined` and `0 blocking over
 * 47` are the same verdict and completely different facts, and only the counts
 * distinguish a gate that passed from one that looked at nothing.
 */
export function classify(
  changed: readonly ChangedFile[],
  map: FeatureMap,
  submodulePaths: Set<string>,
): CoverageVerdict {
  // `relatedComponents` is deliberately NOT consulted: it documents what a
  // feature touches without owning, so folding it in would let a file be
  // "claimed" by a feature that does not implement it -- exactly the coverage
  // the gate exists to refuse.
  const claims = features(map).flatMap((feature) => feature.codePaths);

  const verdict: CoverageVerdict = { blocking: [], outOfScope: [], mapped: [], exempt: [] };

  for (const file of changed) {
    const filePath = file.filename;
    const governed = isGoverned(filePath, map.governedRoots);

    if (claims.some((claim) => matchesGlob(filePath, claim))) {
      verdict.mapped.push(filePath);
      continue;
    }
    if (!governed) {
      verdict.outOfScope.push(filePath);
      continue;
    }
    const removed = file.status === "removed";
    if (blocksGate(filePath, { governed, submodulePaths, removed })) verdict.blocking.push(filePath);
    else verdict.exempt.push(filePath);
  }

  return verdict;
}

/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The `stonedog-featuremap` action's entry point (NEH-1201).
 *
 * This first increment answers ONE question: **is this repository's feature map
 * well-formed?** The coverage decision (does every changed governed file belong
 * to a feature) and the PR reporting land on top of it, as their own changes.
 *
 * ## No `@actions/core`
 *
 * `src/action/runner.ts` implements the six calls this needs. The official
 * package pulls in an HTTP client for OIDC that is never used here -- 1.1 MB of
 * committed bundle -- and, more decisively, it would not run: this package is
 * `"type": "module"`, so a CJS bundle dies with `module is not defined`, and an
 * ESM one dies on `tunnel`'s dynamic `require("net")`. Both observed.
 *
 * ## Why a JavaScript action and not a composite one
 *
 * NEH-1201 specified a composite action, and that was right when the gate was
 * three pure functions over Node builtins. It is not right any more: the gate
 * now validates against the shared JSON Schema, which needs `ajv` and a package
 * that ships TypeScript SOURCE. A composite action is a sequence of steps, so
 * it would have to INSTALL those at run time -- reintroducing exactly the
 * install step that issue gives as its reason not to use npm, and demanding a
 * TypeScript runner in six Python repositories that have no Node toolchain.
 *
 * A JavaScript action is bundled: the runner supplies Node, `dist/index.js`
 * carries `ajv` and the compiled validator inside it, and nothing installs
 * anywhere. Every argument in that issue survives; only the mechanism changes.
 *
 * ## The bundle is the thing that runs, and it can go stale
 *
 * `dist/index.js` is committed, so an edit here that is not rebuilt means CI
 * silently executes the OLD logic and reports success -- the failure this fleet
 * already documents about generated artifacts ("a stale dist does not fail, it
 * does the old thing and reports success"). `npm run check:bundle` rebuilds and
 * refuses a diff, and CI runs it.
 *
 * ## Three outcomes, kept apart
 *
 * | | |
 * |---|---|
 * | no map found | this repository is not set up for the gate |
 * | map found, invalid | the MAP is broken |
 * | map found, valid | proceed |
 *
 * Only the second is a defect in the document under review. A gate that reports
 * a missing file and a corrupt one identically sends people to the wrong place,
 * and one that treats "absent" as "fine" is worse still: it would pass over
 * every repository that never adopted a map, silently, forever.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import * as core from "./runner.js";

import { claimedPaths, featureKeys, validateText } from "../index.js";
import { parseList, resolveMapPath } from "./inputs.js";

/**
 * `GITHUB_WORKSPACE` is where the runner checked the repository out. A
 * JavaScript action's own cwd is not specified, so every relative path in this
 * file resolves against the workspace and never against `process.cwd()`.
 */
function workspace(): string {
  const dir = process.env.GITHUB_WORKSPACE;
  if (!dir) throw new Error("GITHUB_WORKSPACE is unset — this action must run on a checked-out repository.");
  return dir;
}

export async function run(): Promise<void> {
  const root = workspace();

  const { found, tried } = resolveMapPath(root, core.getInput("map"));
  if (!found) {
    const relative = tried.map((p) => path.relative(root, p)).join(", ");
    core.setFailed(
      `No feature map found. Tried, relative to the repository root: ${relative}. ` +
        `If this repository is not meant to be gated, remove the step rather than ` +
        `leaving it to pass over nothing.`,
    );
    return;
  }

  const relative = path.relative(root, found);

  let text: string;
  try {
    text = readFileSync(found, "utf8");
  } catch (error) {
    core.setFailed(`Cannot read ${relative} — ${(error as Error).message}`);
    return;
  }

  const result = validateText(text);

  // `=== false`, not `!result.valid`. A consumer's tsconfig may have
  // `strictNullChecks` off, and without it TypeScript does not narrow a
  // discriminated union through a plain negation -- the same trap that failed
  // hopperguard's tooling type-check in NEH-1203. It costs nothing to write the
  // form that narrows under either setting.
  if (result.valid === false) {
    for (const problem of result.errors) {
      // An annotation per problem, so they land on the Files-changed tab
      // against the file rather than only in the log.
      core.error(`${problem.path || "(document)"}: ${problem.message}`, { file: relative });
    }
    core.setFailed(
      `${relative} does not satisfy the feature-map schema (${result.errors.length} problem(s)). ` +
        `The MAP is wrong, not necessarily this pull request.`,
    );
    return;
  }

  const { map } = result;

  // An input-set line, always. "valid" over a map with two features and "valid"
  // over one with 133 are the same word and different facts, and only the count
  // shows the document did not quietly shrink.
  const features = featureKeys(map).length;
  const paths = claimedPaths(map).length;
  core.info(
    `${relative}: valid — ${map.featureGroups.length} group(s), ${features} feature(s), ` +
      `${paths} claimed path(s), ${map.governedRoots.length} governed root(s)`,
  );

  // Governed roots come from the map. The input exists only to OVERRIDE them,
  // which a repository should rarely want -- NEH-1203 moved these into the map
  // precisely because a gate whose scope lives outside the document it reads
  // cannot be shared.
  const override = parseList(core.getInput("governed-roots"));
  if (override.length > 0) {
    core.warning(
      `governed-roots was overridden to [${override.join(", ")}]; the map declares ` +
        `[${map.governedRoots.join(", ")}]. The map is the intended home for this.`,
    );
  }

  core.setOutput("map", relative);
  core.setOutput("groups", String(map.featureGroups.length));
  core.setOutput("features", String(features));
  core.setOutput("claimed-paths", String(paths));
  core.setOutput("governed-roots", (override.length > 0 ? override : map.governedRoots).join(","));
}

// `void` rather than a floating promise: an unhandled rejection in an action
// exits 0 on some Node versions, which would turn a crash into a pass.
run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

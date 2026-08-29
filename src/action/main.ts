/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The `stonedog-featuremap` action's entry point (NEH-1201).
 *
 * It answers two questions, in order, and keeps their verdicts apart:
 *
 * 1. **Is the map well-formed?** If not, the MAP is broken and the pull request
 *    may be innocent.
 * 2. **Does every changed governed file belong to a feature?** If not, THIS
 *    pull request left something unclaimed.
 *
 * The PR reporting -- a sticky comment and the coverage chart -- lands on top,
 * as its own change.
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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as core from "./runner.js";

import { claimedPaths, featureKeys, validateText } from "../index.js";
import { upsertComment } from "./comment.js";
import { classify, parseSubmodulePaths } from "./coverage.js";
import { buildReport } from "./report.js";
import { fetchChangedFiles, pullNumberFrom } from "./changed-files.js";
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

  const governedRoots = override.length > 0 ? override : map.governedRoots;

  core.setOutput("map", relative);
  core.setOutput("groups", String(map.featureGroups.length));
  core.setOutput("features", String(features));
  core.setOutput("claimed-paths", String(paths));
  core.setOutput("governed-roots", governedRoots.join(","));

  // ---------------------------------------------------------------------------
  // 2. Coverage.
  // ---------------------------------------------------------------------------

  const pull = pullNumberFrom(readEventPayload());
  if (pull === undefined) {
    // A push or schedule run has no pull request and therefore no changed-file
    // set to gate. Said out loud rather than passed over: "the gate ran" and
    // "the gate had something to examine" are different claims, and a silent
    // pass here would read as the second.
    core.info("Not a pull request — the map was validated; there are no changed files to gate.");
    core.setOutput("examined", "0");
    core.setOutput("blocking", "0");
    return;
  }

  const token = core.getInput("token");
  if (!token) {
    core.setFailed(
      "No `token` input. The coverage half needs to read the pull request's changed files; " +
        "pass `token: ${{ secrets.GITHUB_TOKEN }}`. Failing rather than skipping, because a " +
        "gate that quietly checks nothing is worse than one that is switched off.",
    );
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  if (!owner || !repo) {
    core.setFailed("GITHUB_REPOSITORY is unset or malformed; cannot read the pull request.");
    return;
  }

  let changed;
  try {
    changed = await fetchChangedFiles({
      token,
      owner,
      repo,
      pull,
      apiUrl: process.env.GITHUB_API_URL ?? undefined,
    });
  } catch (error) {
    core.setFailed((error as Error).message);
    return;
  }

  if (changed.atApiCeiling) {
    // The API caps at 3000 files. Nothing here can see past it, so say so --
    // a gate reporting "0 unmapped" over a truncated list is exactly the green
    // over an incomplete set this whole design is trying to avoid.
    core.warning(
      `This pull request hit the API's 3000-file ceiling, so the changed-file list may be ` +
        `incomplete and this verdict covers only what was returned.`,
    );
  }

  const gitmodulesPath = path.resolve(root, ".gitmodules");
  const submodulePaths = parseSubmodulePaths(
    existsSync(gitmodulesPath) ? readFileSync(gitmodulesPath, "utf8") : "",
  );

  const verdict = classify(changed.files, { ...map, governedRoots }, submodulePaths);

  // The input-set line, before the branch, so it appears whether the gate
  // passes or fails. A count reported only on failure cannot tell you the gate
  // went quiet.
  core.info(
    `Gate input: ${governedRoots.length} governed root(s), ${features} feature(s) claiming ` +
      `${paths} path(s), ${changed.files.length} changed file(s) examined — ` +
      `${verdict.mapped.length} mapped, ${verdict.outOfScope.length} out of scope, ` +
      `${verdict.exempt.length} exempt, ${verdict.blocking.length} unmapped.`,
  );

  core.setOutput("examined", String(changed.files.length));
  core.setOutput("blocking", String(verdict.blocking.length));

  // The comment is the EXPLANATION; the exit code below is the enforcement.
  // It is posted before the verdict is acted on, so a failing run still leaves
  // the reader the list of files -- a red check saying only "failed" is what
  // gets merged past.
  if (core.getInput("comment") !== "false") {
    const report = buildReport({
      verdict,
      mapPath: relative,
      groups: map.featureGroups.length,
      features,
      claimedPaths: paths,
      governedRoots,
      atApiCeiling: changed.atApiCeiling,
    });
    const posted = await upsertComment({
      token,
      owner,
      repo,
      issue: pull,
      body: report,
      apiUrl: process.env.GITHUB_API_URL ?? undefined,
    });
    if (posted.status === "skipped") {
      // A warning, never a failure. Commenting needs `pull-requests: write`,
      // and a fork's token is read-only whatever the workflow grants -- so
      // failing here would turn every fork pull request red for a reason
      // unrelated to coverage, and the fix people reach for is disabling the
      // gate.
      core.warning(`Could not post the coverage comment (${posted.reason}). The verdict below still stands.`);
    } else {
      core.info(`Coverage comment ${posted.status}.`);
    }
  }

  if (verdict.blocking.length > 0) {
    for (const file of verdict.blocking) {
      core.error(`No feature in ${relative} claims this file.`, { file });
    }
    core.setFailed(
      `${verdict.blocking.length} changed file(s) under a governed root are not mapped to a ` +
        `feature in ${relative}:\n` +
        verdict.blocking.map((f) => `  - ${f}`).join("\n"),
    );
    return;
  }

  // Says which, rather than "all mapped". A run whose governed files were all
  // EXEMPT -- a gitlink bump, or deletions -- checked nothing against the map,
  // and reporting that as "mapped to a feature" would overstate it in exactly
  // the direction that makes a green meaningless.
  core.info(
    verdict.mapped.length > 0
      ? `Pass — ${verdict.mapped.length} changed file(s) mapped to a feature` +
          (verdict.exempt.length > 0 ? `, ${verdict.exempt.length} exempt.` : ".")
      : verdict.exempt.length > 0
        ? `Pass — nothing to check: ${verdict.exempt.length} governed file(s) were exempt ` +
          `(gitlink bumps or deletions) and ${verdict.outOfScope.length} were out of scope.`
        : `Pass — no changed file fell under a governed root (${verdict.outOfScope.length} out of scope).`,
  );
}

/**
 * The event payload the runner wrote, or null when there is none.
 *
 * Unreadable is treated as absent rather than fatal: the only thing derived
 * from it is the pull-request number, and "not a pull request" is already a
 * handled state.
 */
function readEventPayload(): unknown {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// `void` rather than a floating promise: an unhandled rejection in an action
// exits 0 on some Node versions, which would turn a crash into a pass.
run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The pull-request comment body.
 *
 * A pure function from a verdict to markdown. Everything that talks to the API
 * lives in `comment.ts`, so what a reader actually sees can be asserted without
 * a network, a token or a pull request.
 *
 * ## What this is for
 *
 * The gate's exit code is the enforcement; this is the explanation. A red check
 * that says only "failed" gets merged past, and a gate people merge past is
 * worse than no gate because it still looks like one -- that is the lesson
 * hopperguard paid for on PRs #483/#485/#488/#489, and the reason the comment
 * leads with WHICH files and WHY rather than with a chart.
 */

import type { CoverageVerdict } from "./coverage.js";

/**
 * Identifies our comment so a re-run updates it instead of adding another.
 *
 * Deliberately the SAME marker hopperguard's inline gate uses. A repository
 * adopting the action mid-stream would otherwise grow a second comment beside
 * the old one, and nothing would ever clean the first up -- it would sit there
 * with a stale verdict, indistinguishable from a current one.
 */
export const COMMENT_MARKER = "<!-- feature-mapping-comment -->";

export interface ReportInput {
  verdict: CoverageVerdict;
  /** Path of the map, relative to the repository root. */
  mapPath: string;
  groups: number;
  features: number;
  claimedPaths: number;
  governedRoots: readonly string[];
  /** True when the API's file list may have been truncated at its ceiling. */
  atApiCeiling?: boolean;
}

/** How many file paths to list before collapsing the rest into a count. */
const MAX_LISTED = 25;

function listFiles(files: readonly string[]): string[] {
  const shown = files.slice(0, MAX_LISTED).map((file) => `- \`${file}\``);
  if (files.length > MAX_LISTED) {
    shown.push(`- …and ${files.length - MAX_LISTED} more`);
  }
  return shown;
}

/**
 * The mermaid pie, or nothing.
 *
 * Returns an empty array when every bucket is zero. A pie chart of nothing
 * renders as an error block in GitHub's mermaid, so a PR that changed only
 * out-of-scope files would carry a broken image and look like a tooling fault.
 */
function pie(verdict: CoverageVerdict): string[] {
  // Typed as tuples up front rather than cast afterwards: a cast here would
  // have hidden the `possibly undefined` the checker correctly raised on the
  // destructured element.
  const all: Array<{ label: string; count: number }> = [
    { label: "Mapped", count: verdict.mapped.length },
    { label: "Unmapped (blocking)", count: verdict.blocking.length },
    { label: "Exempt", count: verdict.exempt.length },
    { label: "Out of scope", count: verdict.outOfScope.length },
  ];
  const slices = all.filter((slice) => slice.count > 0);

  if (slices.length === 0) return [];

  return [
    "```mermaid",
    "pie showData",
    "    title Changed files by coverage",
    ...slices.map((slice) => `    "${slice.label}" : ${slice.count}`),
    "```",
  ];
}

/**
 * Build the comment.
 *
 * The counts come first and unconditionally, because "0 unmapped" over 0
 * examined and over 47 are the same headline and completely different facts --
 * and a reader who cannot tell them apart cannot tell a passing gate from a
 * silent one.
 */
export function buildReport(input: ReportInput): string {
  const { verdict, mapPath, groups, features, claimedPaths, governedRoots } = input;
  const examined =
    verdict.mapped.length + verdict.blocking.length + verdict.exempt.length + verdict.outOfScope.length;
  const failed = verdict.blocking.length > 0;

  const lines: string[] = ["## Feature map coverage", ""];

  lines.push(
    failed
      ? `### ⛔ Failed — ${verdict.blocking.length} changed file(s) belong to no feature`
      : verdict.mapped.length > 0
        ? `### ✅ Passed — ${verdict.mapped.length} changed file(s) mapped to a feature`
        : `### ✅ Passed — nothing to check`,
    "",
  );

  // The input set, always. This is the line that distinguishes a gate that
  // looked at 47 files from one that looked at none.
  lines.push(
    `Examined **${examined}** changed file(s) against \`${mapPath}\` — ` +
      `${groups} group(s), ${features} feature(s) claiming ${claimedPaths} path(s), ` +
      `governed roots \`${governedRoots.join("`, `") || "(none)"}\`.`,
    "",
    `| | |`,
    `|---|---|`,
    `| mapped | ${verdict.mapped.length} |`,
    `| unmapped (blocking) | ${verdict.blocking.length} |`,
    `| exempt (gitlink bump or deletion) | ${verdict.exempt.length} |`,
    `| out of scope | ${verdict.outOfScope.length} |`,
    "",
  );

  if (input.atApiCeiling) {
    lines.push(
      `> ⚠️ This pull request hit the API's 3000-file ceiling, so the changed-file list ` +
        `may be incomplete and this verdict covers only what was returned.`,
      "",
    );
  }

  if (failed) {
    lines.push(
      `These files are under a governed root and no feature in \`${mapPath}\` claims them. ` +
        `Add them to a feature's \`codePaths\`, or if they genuinely belong to no feature, ` +
        `say so in review rather than widening a glob to silence this.`,
      "",
      ...listFiles(verdict.blocking),
      "",
    );
  }

  // Exempt is called out even on a pass, because it is the case where the gate
  // examined governed files and checked NONE of them against the map. Leaving
  // that implicit is how a green comes to mean less than it appears to.
  if (verdict.exempt.length > 0) {
    lines.push(
      `<details><summary>${verdict.exempt.length} governed file(s) exempt — submodule gitlinks and deletions, which can never be mapped</summary>`,
      "",
      ...listFiles(verdict.exempt),
      "",
      "</details>",
      "",
    );
  }

  if (verdict.outOfScope.length > 0) {
    lines.push(
      `<details><summary>${verdict.outOfScope.length} changed file(s) out of scope — outside every governed root</summary>`,
      "",
      ...listFiles(verdict.outOfScope),
      "",
      "</details>",
      "",
    );
  }

  const chart = pie(verdict);
  if (chart.length > 0) lines.push(...chart, "");

  lines.push(COMMENT_MARKER);
  return lines.join("\n");
}

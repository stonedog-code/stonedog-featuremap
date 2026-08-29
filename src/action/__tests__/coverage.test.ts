/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The coverage decision.
 *
 * Every case hopperguard's own `feature-map-gate.test.ts` covers is here,
 * because those tests encode incidents rather than opinions — two of them are
 * named THE REGRESSION and are the reason the gate is still trusted. Porting
 * the code without them would move the logic and leave its evidence behind.
 *
 * The new cases are for what this file adds: governed-root matching (two live
 * maps write roots in two different styles) and the classification that turns
 * the decision into countable lists.
 */

import { describe, expect, it } from "@jest/globals";

import type { FeatureMap } from "../../types.js";
import { blocksGate, classify, isGoverned, isGitlink, matchesGlob, parseSubmodulePaths } from "../coverage.js";

const GITMODULES = `
[submodule "apps/web"]
	path = apps/web
	url = git@github.com:org/web.git
[submodule "packages/hopper-db"]
	path = packages/hopper-db
	url = git@github.com:org/db.git
`;

const MAP: FeatureMap = {
  product: "fixture",
  governedRoots: ["apps/**", "packages/**"],
  featureGroups: [
    {
      key: "BILLING",
      name: "Billing",
      features: [
        { key: "BILLING.INVOICES", name: "Invoices", codePaths: ["apps/web/billing/**"] },
        {
          key: "BILLING.REFUNDS",
          name: "Refunds",
          codePaths: ["apps/web/refund.ts"],
          relatedComponents: ["apps/web/ui/Money.tsx"],
        },
      ],
    },
  ],
};

describe("parseSubmodulePaths", () => {
  it("parses every submodule path", () => {
    expect(parseSubmodulePaths(GITMODULES)).toEqual(new Set(["apps/web", "packages/hopper-db"]));
  });

  it("tolerates a missing or empty .gitmodules", () => {
    expect(parseSubmodulePaths("")).toEqual(new Set());
  });

  it("ignores url and name lines, so only real paths land in the set", () => {
    expect(parseSubmodulePaths(GITMODULES).has("git@github.com:org/web.git")).toBe(false);
  });
});

describe("isGitlink", () => {
  it("matches the exact path only, never a file inside it", () => {
    const subs = parseSubmodulePaths(GITMODULES);
    expect(isGitlink("apps/web", subs)).toBe(true);
    expect(isGitlink("apps/web/src/page.tsx", subs)).toBe(false);
  });
});

describe("blocksGate", () => {
  const submodulePaths = parseSubmodulePaths(GITMODULES);

  it("THE REGRESSION: a gitlink-only bump does not block", () => {
    // hopperguard #483/#485/#488/#489 failed on every pointer bump, which
    // "trained us to merge those PRs red and cost the gate its meaning".
    expect(blocksGate("apps/web", { governed: true, submodulePaths })).toBe(false);
  });

  it("a multi-submodule bump does not block either", () => {
    for (const p of ["apps/web", "packages/hopper-db"]) {
      expect(blocksGate(p, { governed: true, submodulePaths })).toBe(false);
    }
  });

  it("still blocks genuinely unmapped source under a governed root", () => {
    expect(blocksGate("packages/new-pkg/src/x.ts", { governed: true, submodulePaths })).toBe(true);
  });

  it("files outside a governed root are informational, gitlink or not", () => {
    expect(blocksGate("docs/readme.md", { governed: false, submodulePaths })).toBe(false);
    expect(blocksGate("apps/web", { governed: false, submodulePaths })).toBe(false);
  });

  it("a REMOVED path never blocks, even when governed and no longer a gitlink", () => {
    // Removing a submodule deletes the gitlink AND its .gitmodules entry in one
    // commit, so the exemption above vanishes in exactly the commit that needs
    // it (NEH-635).
    expect(
      blocksGate("packages/hopper-mud", { governed: true, submodulePaths: new Set(), removed: true }),
    ).toBe(false);
  });

  it("removed defaults to false, so a caller that omits it is unchanged", () => {
    expect(blocksGate("packages/gone", { governed: true, submodulePaths: new Set() })).toBe(true);
  });
});

describe("isGoverned — the two live maps write roots differently", () => {
  it("treats a trailing-slash root as a prefix, which is how rozcards writes it", () => {
    expect(isGoverned("src/app/page.tsx", ["src/"])).toBe(true);
    expect(isGoverned("docs/x.md", ["src/"])).toBe(false);
  });

  it("treats a root containing * as a glob, which is how hopperguard writes it", () => {
    expect(isGoverned("apps/web/src/x.ts", ["apps/**", "packages/**"])).toBe(true);
    expect(isGoverned("docs/x.md", ["apps/**", "packages/**"])).toBe(false);
  });

  it("governs nothing when the list is empty, rather than everything", () => {
    // An empty governedRoots is legal and means "governs nothing". Reading it
    // as "governs everything" would fail every PR in a repository that was
    // mid-adoption.
    expect(isGoverned("apps/web/x.ts", [])).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("* does not cross a directory boundary, ** does", () => {
    expect(matchesGlob("apps/web/x.ts", "apps/*")).toBe(false);
    expect(matchesGlob("apps/web", "apps/*")).toBe(true);
    expect(matchesGlob("apps/web/deep/x.ts", "apps/**")).toBe(true);
  });

  it("escapes regex metacharacters in a literal path", () => {
    // A path with a dot must not have it read as "any character", or
    // `apps/webXts` would satisfy a claim on `apps/web.ts`.
    expect(matchesGlob("apps/webXts", "apps/web.ts")).toBe(false);
    expect(matchesGlob("apps/web.ts", "apps/web.ts")).toBe(true);
  });
});

describe("classify", () => {
  const subs = parseSubmodulePaths(GITMODULES);
  const run = (files: { filename: string; status?: string }[]) => classify(files, MAP, subs);

  it("puts a claimed file in mapped", () => {
    expect(run([{ filename: "apps/web/billing/invoice.ts" }]).mapped).toEqual([
      "apps/web/billing/invoice.ts",
    ]);
  });

  it("puts an ungoverned file out of scope, not blocking", () => {
    const v = run([{ filename: "docs/readme.md" }]);
    expect(v.outOfScope).toEqual(["docs/readme.md"]);
    expect(v.blocking).toEqual([]);
  });

  it("blocks governed, unmapped source", () => {
    expect(run([{ filename: "packages/new/src/x.ts" }]).blocking).toEqual(["packages/new/src/x.ts"]);
  });

  it("exempts a gitlink rather than blocking or mapping it", () => {
    const v = run([{ filename: "apps/web" }]);
    expect(v.exempt).toEqual(["apps/web"]);
    expect(v.blocking).toEqual([]);
  });

  it("exempts a removed governed file", () => {
    const v = run([{ filename: "packages/gone/src/x.ts", status: "removed" }]);
    expect(v.exempt).toEqual(["packages/gone/src/x.ts"]);
    expect(v.blocking).toEqual([]);
  });

  it("does NOT let relatedComponents claim a file", () => {
    // Folding those in would let a file be claimed by a feature that does not
    // implement it, which is precisely the coverage the gate exists to refuse.
    const v = run([{ filename: "apps/web/ui/Money.tsx" }]);
    expect(v.mapped).toEqual([]);
    expect(v.blocking).toEqual(["apps/web/ui/Money.tsx"]);
  });

  it("the four lists are disjoint and account for every file", () => {
    // The counts are what the caller reports, so a file falling through two
    // lists — or none — would make the report quietly wrong.
    const files = [
      { filename: "apps/web/billing/invoice.ts" },
      { filename: "docs/readme.md" },
      { filename: "packages/new/src/x.ts" },
      { filename: "apps/web" },
      { filename: "packages/gone/y.ts", status: "removed" },
    ];
    const v = run(files);
    const all = [...v.mapped, ...v.outOfScope, ...v.blocking, ...v.exempt];
    expect(all).toHaveLength(files.length);
    expect(new Set(all).size).toBe(files.length);
  });
});

/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The validator, asserted in BOTH directions.
 *
 * A schema that has only ever been observed accepting valid documents has not
 * been tested, it has been run. Every rule below is planted as a failure and
 * watched to fail, and the healthy map is confirmed to pass -- otherwise a
 * schema that accepts everything looks identical to one that works.
 */

import { describe, expect, it } from "@jest/globals";

import { claimedPaths, duplicateKeys, featureKeys, features, misprefixedFeatureKeys } from "../derive.js";
import { validate, validateText } from "../validate.js";
import type { FeatureMap } from "../types.js";

/** A minimal map that must always be valid. Every planted failure edits a copy. */
const NESTED: FeatureMap = {
  product: "example",
  governedRoots: ["src/"],
  featureGroups: [
    {
      key: "BILLING",
      name: "Billing",
      features: [
        { key: "BILLING.INVOICES", name: "Invoices", codePaths: ["src/billing/invoice.ts"] },
        {
          key: "BILLING.REFUNDS",
          name: "Refunds",
          codePaths: ["src/billing/refund.ts"],
          relatedComponents: ["src/ui/Money.tsx"],
        },
      ],
    },
  ],
};

/** The other live shape: groups that own their paths directly. */
const LEAF: FeatureMap = {
  product: "example-flat",
  governedRoots: ["src/", "lib/"],
  featureGroups: [
    { key: "SCANNER", name: "Scanner", codePaths: ["src/scanner/**"] },
    { key: "DICE", name: "Dice", codePaths: ["src/dice.ts"] },
  ],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Assert invalid, and return the messages so a test can say WHICH rule fired. */
function messagesFor(input: unknown): string[] {
  const result = validate(input);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("unreachable");
  return result.errors.map((error) => `${error.path} ${error.message}`);
}

describe("the healthy direction", () => {
  it("accepts a nested map", () => {
    expect(validate(NESTED).valid).toBe(true);
  });

  it("accepts a flat map, because a group may BE a feature", () => {
    expect(validate(LEAF).valid).toBe(true);
  });

  it("accepts an empty governedRoots, which means the gate governs nothing", () => {
    // A real state during adoption, and distinguishable from the key being
    // absent -- which the schema forbids outright.
    expect(validate({ ...clone(LEAF), governedRoots: [] }).valid).toBe(true);
  });
});

describe("the union: exactly one of codePaths or features", () => {
  it("refuses a group carrying BOTH", () => {
    const map = clone(NESTED) as unknown as Record<string, unknown>;
    (map.featureGroups as Record<string, unknown>[])[0]!.codePaths = ["src/x.ts"];
    expect(messagesFor(map).join("\n")).toMatch(/exactly one of `codePaths` or `features`/);
  });

  it("refuses a group carrying NEITHER", () => {
    const map = clone(NESTED) as unknown as Record<string, unknown>;
    delete (map.featureGroups as Record<string, unknown>[])[0]!.features;
    expect(messagesFor(map).join("\n")).toMatch(/exactly one of `codePaths` or `features`/);
  });
});

describe("the fields that must exist", () => {
  it("refuses a map with no governedRoots at all", () => {
    // The whole reason the field is required: hopperguard kept these in its
    // workflow, so the map could not say what the gate governed.
    const map = clone(NESTED) as Partial<FeatureMap>;
    delete map.governedRoots;
    expect(messagesFor(map).join("\n")).toMatch(/governedRoots/);
  });

  it("refuses a top-level `features` array", () => {
    // The denormalised index the schema deliberately drops. It must be REFUSED
    // rather than ignored, or a repository keeps maintaining a copy that
    // nothing reads and nothing checks.
    const map = { ...clone(NESTED), features: ["invoices", "refunds"] };
    expect(messagesFor(map).join("\n")).toMatch(/features/);
  });

  it("refuses an empty codePaths, which would claim nothing while looking covered", () => {
    const map = clone(LEAF);
    map.featureGroups[0]!.codePaths = [];
    expect(messagesFor(map).length).toBeGreaterThan(0);
  });
});

describe("paths cannot escape the repository", () => {
  // The first four are the obvious forms. The last five are the ones a review
  // found accepted by an earlier pattern that enumerated forward-slash
  // traversal only -- every clause checked for `/`, so every backslash form
  // walked through, and the bare `..` slipped past a rule that required a
  // leading or trailing slash. They are listed individually rather than
  // summarised because each is a bypass that actually existed.
  it.each([
    "/etc/passwd",
    "../../etc/passwd",
    "src/../../secrets",
    "C:/windows",
    "..",
    "..\\..\\etc\\passwd",
    "\\absolute\\path",
    "src\\..\\..\\x",
    "a/../../b",
  ])("refuses %j", (path) => {
    const map = clone(LEAF);
    map.featureGroups[0]!.codePaths = [path];
    expect(messagesFor(map).length).toBeGreaterThan(0);
  });

  it.each(["src/", "src/**/*.ts", "a/b/c.ts", "packages/x/src/**"])(
    "still accepts %j",
    (path) => {
      // The other direction. A traversal guard that refuses everything is a
      // guard nobody can satisfy, and it fails identically to a correct one.
      const map = clone(LEAF);
      map.featureGroups[0]!.codePaths = [path];
      expect(validate(map).valid).toBe(true);
    },
  );

  it("still accepts an ordinary glob", () => {
    const map = clone(LEAF);
    map.featureGroups[0]!.codePaths = ["src/**/*.ts"];
    expect(validate(map).valid).toBe(true);
  });
});

describe("keys", () => {
  it.each(["billing", "Billing", "TRAILING_", "HAS SPACE", "WITH-HYPHEN"])("refuses group key %s", (key) => {
    const map = clone(LEAF);
    map.featureGroups[0]!.key = key;
    expect(messagesFor(map).length).toBeGreaterThan(0);
  });

  it("refuses a duplicate key across the two nesting levels", () => {
    // JSON Schema cannot express this, so it is checked in code -- and it is
    // reported as a validation error rather than a warning, because a key is an
    // identity and two things sharing one silently overwrite each other.
    const map = clone(NESTED);
    map.featureGroups.push({
      key: "BILLING",
      name: "Duplicate group",
      features: [{ key: "BILLING.INVOICES", name: "Invoices again", codePaths: ["src/other.ts"] }],
    });
    expect(messagesFor(map).join("\n")).toMatch(/duplicate key `BILLING/);
  });

  it("does NOT report a leaf group's own key as a duplicate of itself", () => {
    // A leaf group is both a group and a feature, so its key legitimately
    // appears twice in the count. Getting this wrong would make every flat map
    // invalid -- which is two of the three real maps in the fleet.
    expect(duplicateKeys(LEAF)).toEqual([]);
    expect(validate(LEAF).valid).toBe(true);
  });
});

describe("a feature key must be prefixed by its group", () => {
  it("refuses a feature pasted into the wrong group", () => {
    // The error this catches is completely silent otherwise: every field is
    // well-formed, the schema passes, and the feature simply reports under a
    // group that does not own it.
    const map = clone(NESTED);
    (map.featureGroups[0] as { features: Array<{ key: string }> }).features[0]!.key = "SHIPPING.INVOICES";
    expect(messagesFor(map).join("\n")).toMatch(/not prefixed `BILLING\.`/);
  });

  it("refuses an undotted feature key outright", () => {
    const map = clone(NESTED);
    (map.featureGroups[0] as { features: Array<{ key: string }> }).features[0]!.key = "INVOICES";
    expect(messagesFor(map).length).toBeGreaterThan(0);
  });

  it("does not apply to leaf groups, which have no inner features", () => {
    expect(misprefixedFeatureKeys(LEAF)).toEqual([]);
    expect(validate(LEAF).valid).toBe(true);
  });
});

describe("the errors a person actually reads", () => {
  it("does not bury the union message under the union's own internals", () => {
    // Ajv expresses the union as `oneOf` over two `not` branches, so a bad
    // group yields three errors at one path -- two bare "must NOT be valid"
    // above the one sentence that explains anything. The noise is filtered,
    // because the message a reader scrolls past is a message that did not run.
    const map = clone(NESTED) as unknown as Record<string, unknown>;
    (map.featureGroups as Record<string, unknown>[])[0]!.codePaths = ["src/x.ts"];
    const messages = messagesFor(map);
    expect(messages.filter((m) => /must NOT be valid/.test(m))).toEqual([]);
    expect(messages.filter((m) => /exactly one of/.test(m))).toHaveLength(1);
  });

  it("names the offending property when one is unrecognised", () => {
    // Ajv puts it in `params`, not in the message, so the top-level `features`
    // array this schema exists to remove produced an error that did not
    // contain the word "features".
    const map = { ...clone(NESTED), features: ["BILLING.INVOICES"] };
    expect(messagesFor(map).join("\n")).toMatch(/unknown property `features`/);
  });
});

describe("validateText", () => {
  it("reports unparseable JSON as a verdict, not an exception", () => {
    // The gate must be able to say "your map is malformed" without that being
    // a crash it cannot tell apart from "your map is fine and your change is
    // not". So this is a return value, and it names the parse failure.
    expect(() => validateText("{ not json")).not.toThrow();
    const result = validateText("{ not json");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.errors[0]!.message).toMatch(/not valid JSON/);
  });

  it("round-trips a valid map", () => {
    expect(validateText(JSON.stringify(NESTED)).valid).toBe(true);
  });
});

describe("derivations replace the field the schema dropped", () => {
  it("flattens nested features", () => {
    expect(featureKeys(NESTED)).toEqual(["BILLING.INVOICES", "BILLING.REFUNDS"]);
  });

  it("treats a leaf group as a feature in its own right", () => {
    // Otherwise a repository on the flat shape reports zero features while
    // plainly having some.
    expect(featureKeys(LEAF)).toEqual(["DICE", "SCANNER"]);
  });

  it("de-duplicates and sorts claimed paths", () => {
    expect(claimedPaths(NESTED)).toEqual(["src/billing/invoice.ts", "src/billing/refund.ts"]);
  });

  it("excludes relatedComponents from claimed paths", () => {
    // Including them would let a file be claimed by a feature that does not
    // implement it, which is exactly the coverage the gate exists to refuse.
    expect(claimedPaths(NESTED)).not.toContain("src/ui/Money.tsx");
  });

  it("carries the group a feature came from", () => {
    expect(features(NESTED).map((f) => f.groupKey)).toEqual(["BILLING", "BILLING"]);
  });
});

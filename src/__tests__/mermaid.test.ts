/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The `.mer` generator.
 *
 * The property that matters most is not "it draws a diagram" but "it draws the
 * SAME bytes every time" -- the collector regenerates every diagram hourly and
 * commits only what changed, so any instability is a commit per run forever.
 * Determinism is therefore asserted against a shuffled input, not merely by
 * calling twice on one object (which would pass for an unstable sort too).
 */

import { describe, expect, it } from "@jest/globals";

import { escapeLabel, toMermaid } from "../mermaid.js";
import type { FeatureMap } from "../types.js";

const NESTED: FeatureMap = {
  product: "example",
  governedRoots: ["src/"],
  featureGroups: [
    {
      key: "BILLING",
      name: "Billing",
      features: [
        { key: "BILLING.REFUNDS", name: "Refunds", codePaths: ["src/billing/refund.ts"], relatedComponents: ["src/ui/Money.tsx"] },
        { key: "BILLING.INVOICES", name: "Invoices", codePaths: ["src/billing/invoice.ts", "src/billing/pdf/**"] },
      ],
    },
    { key: "SCANNER", name: "Scanner", codePaths: ["src/scanner/**"] },
  ],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("toMermaid", () => {
  it("yields one diagram per feature, a leaf group counting as its own feature, sorted by key", () => {
    const keys = toMermaid(NESTED).map((d) => d.key);
    expect(keys).toEqual(["BILLING.INVOICES", "BILLING.REFUNDS", "SCANNER"]);
  });

  it("names each file after its key", () => {
    expect(toMermaid(NESTED).map((d) => d.fileName)).toEqual([
      "BILLING.INVOICES.mer",
      "BILLING.REFUNDS.mer",
      "SCANNER.mer",
    ]);
  });

  it("renders the exact bytes for a feature -- header comments, flowchart, every path, related as dotted", () => {
    const refunds = toMermaid(NESTED).find((d) => d.key === "BILLING.REFUNDS");
    expect(refunds?.text).toBe(
      [
        "%% title: Refunds",
        "%% description: Billing · 1 code path · 1 related component",
        "%% generated from feature-map.json by @stonedogcode/featuremap -- edit the map, not this file",
        "",
        "flowchart LR",
        '    F["<b>Refunds</b><br/><code>BILLING.REFUNDS</code>"]',
        '    P0["src/billing/refund.ts"]',
        "    F --> P0",
        '    R0["src/ui/Money.tsx"]',
        "    F -.->|related| R0",
        "",
      ].join("\n"),
    );
  });

  it("keeps code paths in the order the map declares them", () => {
    const invoices = toMermaid(NESTED).find((d) => d.key === "BILLING.INVOICES");
    expect(invoices?.text).toMatch(/P0\["src\/billing\/invoice\.ts"\][\s\S]*P1\["src\/billing\/pdf\/\*\*"\]/);
    expect(invoices?.text).toContain("%% description: Billing · 2 code paths\n");
  });

  it("is byte-identical whatever order the groups and features arrive in", () => {
    const shuffled = clone(NESTED);
    shuffled.featureGroups.reverse();
    const billing = shuffled.featureGroups.find((g) => g.key === "BILLING");
    if (billing && "features" in billing && billing.features) billing.features.reverse();

    expect(toMermaid(shuffled)).toEqual(toMermaid(NESTED));
    // And the plant: had the output followed input order, the reversal would
    // have shown. Confirm the input really did change shape.
    expect(shuffled.featureGroups.map((g) => g.key)).not.toEqual(NESTED.featureGroups.map((g) => g.key));
  });

  it("ends every file in exactly one newline", () => {
    for (const diagram of toMermaid(NESTED)) {
      expect(diagram.text.endsWith("\n")).toBe(true);
      expect(diagram.text.endsWith("\n\n")).toBe(false);
    }
  });

  it("refuses a map whose keys collide, rather than silently overwriting a diagram", () => {
    const planted = clone(NESTED);
    planted.featureGroups.push({ key: "SCANNER", name: "Scanner again", codePaths: ["src/other.ts"] });
    expect(() => toMermaid(planted)).toThrow(/duplicate keys: SCANNER/);
  });

  it("keeps a multi-line name inside its header comment", () => {
    const planted = clone(NESTED);
    planted.featureGroups = planted.featureGroups.map((g) => (g.key === "SCANNER" ? { ...g, name: "Scan\nflowchart TD" } : g));
    const scanner = toMermaid(planted).find((d) => d.key === "SCANNER");
    expect(scanner?.text.split("\n")[0]).toBe("%% title: Scan flowchart TD");
    // The injected line must not appear as a line of its own.
    expect(scanner?.text.split("\n")).not.toContain("flowchart TD");
  });

  it("escapes a label that would otherwise close its quotes", () => {
    const planted = clone(NESTED);
    planted.featureGroups[1] = { key: "SCANNER", name: 'Say "hi"', codePaths: ['src/a"b.ts'] };
    const text = toMermaid(planted).find((d) => d.key === "SCANNER")?.text ?? "";
    expect(text).toContain('P0["src/a#quot;b.ts"]');
    expect(text).toContain("<b>Say #quot;hi#quot;</b>");
  });
});

describe("escapeLabel", () => {
  it("escapes # first, so an existing entity-looking string is not decoded", () => {
    expect(escapeLabel("docs/#quot;.md")).toBe("docs/#35;quot;.md");
  });

  it("escapes the quote and the three HTML-significant characters", () => {
    expect(escapeLabel(`a"b&c<d>e`)).toBe("a#quot;b#amp;c#lt;d#gt;e");
  });

  it("leaves glob characters alone -- they are legal inside a quoted label", () => {
    expect(escapeLabel("src/**/{a,b}/[x]?.ts")).toBe("src/**/{a,b}/[x]?.ts");
  });
});

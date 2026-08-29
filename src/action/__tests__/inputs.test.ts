/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Input resolution.
 *
 * The rules here decide WHICH document gets gated, and getting one wrong does
 * not throw -- it gates a different file, or none, in somebody else's
 * repository where the only evidence is a log line.
 */

import { describe, expect, it } from "@jest/globals";

import { DEFAULT_CANDIDATES, parseList, resolveMapPath } from "../inputs.js";

/** A fake `existsSync` over a fixed set of absolute paths. */
const only = (...present: string[]) => (p: string) => present.includes(p);

describe("resolveMapPath", () => {
  it("tries the three known locations in order", () => {
    const { tried } = resolveMapPath("/repo", undefined, () => false);
    expect(tried).toEqual(DEFAULT_CANDIDATES.map((c) => `/repo/${c}`));
  });

  it("prefers feature_map/ over the root file, matching the live workflows", () => {
    const { found } = resolveMapPath(
      "/repo",
      undefined,
      only("/repo/feature_map/feature-map.json", "/repo/feature-map.json"),
    );
    expect(found).toBe("/repo/feature_map/feature-map.json");
  });

  it("falls through to the second candidate when the first is absent", () => {
    const { found } = resolveMapPath("/repo", undefined, only("/repo/feature-map.json"));
    expect(found).toBe("/repo/feature-map.json");
  });

  it("reports every path it tried when none exist", () => {
    // The error message is the only thing a reader gets, so the paths must be
    // in it rather than a bare "not found".
    const { found, tried } = resolveMapPath("/repo", undefined, () => false);
    expect(found).toBeUndefined();
    expect(tried).toHaveLength(3);
  });

  it("an explicit input is the ONLY candidate, with no fallback", () => {
    // Naming a file and then silently gating a different one is worse than
    // failing: the run would be green about a document nobody asked about.
    const { found, tried } = resolveMapPath(
      "/repo",
      "custom/map.json",
      only("/repo/feature-map.json"),
    );
    expect(tried).toEqual(["/repo/custom/map.json"]);
    expect(found).toBeUndefined();
  });

  it("resolves relative paths against the WORKSPACE, not the process cwd", () => {
    // A JavaScript action runs with an unspecified cwd, so anything relative to
    // it is a coin flip on someone else's runner.
    const { tried } = resolveMapPath("/checkout", "map.json", () => false);
    expect(tried).toEqual(["/checkout/map.json"]);
  });

  it("leaves an absolute input alone", () => {
    const { tried } = resolveMapPath("/repo", "/elsewhere/map.json", () => false);
    expect(tried).toEqual(["/elsewhere/map.json"]);
  });

  it("treats a whitespace-only input as unset", () => {
    const { tried } = resolveMapPath("/repo", "   ", () => false);
    expect(tried).toHaveLength(3);
  });
});

describe("parseList", () => {
  it("accepts commas", () => {
    expect(parseList("apps/**,packages/**")).toEqual(["apps/**", "packages/**"]);
  });

  it("accepts newlines, which is what a YAML block scalar produces", () => {
    expect(parseList("apps/**\npackages/**\n")).toEqual(["apps/**", "packages/**"]);
  });

  it("drops empties, so a trailing comma is harmless", () => {
    expect(parseList("a,,b,")).toEqual(["a", "b"]);
  });

  it("trims, so 'a, b' is two entries and not one with a space", () => {
    expect(parseList("a, b")).toEqual(["a", "b"]);
  });

  it("returns nothing for absent or empty", () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
    expect(parseList("  ")).toEqual([]);
  });
});

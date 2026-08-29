/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The Actions runtime calls, asserted rather than trusted.
 *
 * These exist because `runner.ts` reimplements a handful of `@actions/core`
 * behaviours, and every one of them fails SILENTLY when wrong: an input read
 * from the wrong variable is empty, an unescaped annotation loses everything
 * after its first newline, and a malformed output line is simply not there. No
 * exception, no red step -- just a gate that quietly did less than you think.
 *
 * The two subtle rules were checked against `@actions/core`'s own source before
 * being written down, and are asserted here so a future "tidy-up" cannot
 * reintroduce the obvious-but-wrong version.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing, getInput, setOutput } from "../runner.js";

const { escapeData, escapeProperty } = __testing;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.GITHUB_OUTPUT;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key];
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  dirs.push(dir);
  return dir;
}

describe("getInput", () => {
  it("KEEPS hyphens and only converts spaces", () => {
    // The rule that is easy to get backwards. `@actions/core` does
    // `name.replace(/ /g, "_").toUpperCase()` -- so a hyphenated input reads
    // from INPUT_GOVERNED-ROOTS, and "helpfully" converting dashes to
    // underscores would make every hyphenated input silently empty.
    process.env["INPUT_GOVERNED-ROOTS"] = "apps/**,packages/**";
    expect(getInput("governed-roots")).toBe("apps/**,packages/**");
    process.env["INPUT_GOVERNED_ROOTS"] = "wrong";
    expect(getInput("governed-roots")).toBe("apps/**,packages/**");
  });

  it("uppercases and converts spaces", () => {
    process.env["INPUT_TWO_WORDS"] = "x";
    expect(getInput("two words")).toBe("x");
  });

  it("treats absent and empty as the same, and trims", () => {
    expect(getInput("nothing-set")).toBe("");
    process.env["INPUT_PADDED"] = "  spaced  ";
    expect(getInput("padded")).toBe("spaced");
  });
});

describe("workflow-command escaping", () => {
  it("escapes the characters that would truncate a message", () => {
    // A schema error can be multi-line. Unescaped, everything after the first
    // newline is silently dropped from the annotation.
    expect(escapeData("a\nb")).toBe("a%0Ab");
    expect(escapeData("a\r\nb")).toBe("a%0D%0Ab");
    expect(escapeData("100%")).toBe("100%25");
  });

  it("escapes a property more strictly than a message", () => {
    // `:` and `,` separate the command's own properties, so a path containing
    // either would be parsed as a second property rather than as a filename.
    expect(escapeProperty("a:b,c")).toBe("a%3Ab%2Cc");
    expect(escapeData("a:b,c")).toBe("a:b,c");
  });

  it("escapes the percent FIRST, so an escape is not double-escaped", () => {
    // If `%` were replaced after `\n`, the `%0A` just written would itself
    // become `%250A` and the annotation would render the escape as text.
    expect(escapeData("%\n")).toBe("%25%0A");
  });
});

describe("setOutput", () => {
  it("writes the heredoc form, not key=value", () => {
    const dir = scratch();
    const file = join(dir, "out");
    writeFileSync(file, "");
    process.env.GITHUB_OUTPUT = file;

    setOutput("features", "133");
    const written = readFileSync(file, "utf8");
    expect(written).toMatch(/^features<<ghadelimiter_[0-9a-f-]+\n133\nghadelimiter_[0-9a-f-]+\n$/);
  });

  it("survives a value containing newlines", () => {
    // The reason the heredoc exists. `key=value` would truncate here, and a
    // truncated output is not an error anywhere -- the consumer just sees less.
    const dir = scratch();
    const file = join(dir, "out");
    writeFileSync(file, "");
    process.env.GITHUB_OUTPUT = file;

    setOutput("roots", "apps/**\npackages/**");
    expect(readFileSync(file, "utf8")).toContain("apps/**\npackages/**\n");
  });

  it("uses a fresh delimiter each call", () => {
    const dir = scratch();
    const file = join(dir, "out");
    writeFileSync(file, "");
    process.env.GITHUB_OUTPUT = file;

    setOutput("a", "1");
    setOutput("b", "2");
    const delimiters = [...readFileSync(file, "utf8").matchAll(/ghadelimiter_[0-9a-f-]+/g)].map(
      (m) => m[0],
    );
    expect(new Set(delimiters).size).toBe(2);
  });

  it("does nothing when GITHUB_OUTPUT is unset, rather than throwing", () => {
    // Running the bundle by hand is a normal thing to do while debugging, and
    // crashing on the last line would make every such run look like a failure.
    delete process.env.GITHUB_OUTPUT;
    expect(() => setOutput("x", "y")).not.toThrow();
  });
});

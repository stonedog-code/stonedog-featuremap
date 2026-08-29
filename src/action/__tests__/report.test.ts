/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The comment body, and the upsert that delivers it.
 *
 * The body is what a human actually reads, so the assertions are about whether
 * it can MISLEAD: a pass that hides having checked nothing, a truncated file
 * list presented as complete, a chart that renders as an error block.
 *
 * The upsert's assertions are all about not making things worse. Its worst
 * failure is not "no comment" -- it is failing the gate for a reason unrelated
 * to coverage, on every pull request from a fork.
 */

import { describe, expect, it } from "@jest/globals";

import { upsertComment } from "../comment.js";
import type { CoverageVerdict } from "../coverage.js";
import { buildReport, COMMENT_MARKER } from "../report.js";

const empty: CoverageVerdict = { blocking: [], outOfScope: [], mapped: [], exempt: [] };
const base = {
  mapPath: "feature-map.json",
  groups: 28,
  features: 133,
  claimedPaths: 436,
  governedRoots: ["apps/**", "packages/**"],
};

const report = (verdict: Partial<CoverageVerdict>, extra = {}) =>
  buildReport({ ...base, ...extra, verdict: { ...empty, ...verdict } });

describe("the report always says what it examined", () => {
  it("states the examined count even when everything passed", () => {
    // "0 unmapped" over 0 examined and over 47 are the same headline and
    // different facts. Without the count a reader cannot tell a passing gate
    // from one that looked at nothing.
    const body = report({ mapped: ["a.ts", "b.ts"] });
    expect(body).toContain("Examined **2** changed file(s)");
    expect(body).toContain("133 feature(s) claiming 436 path(s)");
  });

  it("states it when NOTHING was examined", () => {
    expect(report({})).toContain("Examined **0** changed file(s)");
  });

  it("names the governed roots, so an override is visible in the comment", () => {
    expect(report({})).toContain("`apps/**`, `packages/**`");
  });
});

describe("the headline does not overstate a pass", () => {
  it("says 'nothing to check' when every governed file was exempt", () => {
    // The gitlink-bump case. Calling this "mapped to a feature" would claim
    // coverage that was never verified.
    const body = report({ exempt: ["apps/web"] });
    expect(body).toContain("Passed — nothing to check");
    expect(body).not.toContain("mapped to a feature");
  });

  it("says how many were mapped when some were", () => {
    expect(report({ mapped: ["a.ts"] })).toContain("Passed — 1 changed file(s) mapped");
  });

  it("leads with the failure and the count when blocking", () => {
    expect(report({ blocking: ["x.ts", "y.ts"] })).toContain(
      "Failed — 2 changed file(s) belong to no feature",
    );
  });
});

describe("the blocking list is actionable", () => {
  it("names every blocking file", () => {
    const body = report({ blocking: ["apps/web/a.ts", "apps/web/b.ts"] });
    expect(body).toContain("`apps/web/a.ts`");
    expect(body).toContain("`apps/web/b.ts`");
  });

  it("says how many it did NOT list rather than silently truncating", () => {
    // A list cut off with no note reads as the complete set, and the reader
    // fixes 25 files and is surprised by the next run.
    const many = Array.from({ length: 40 }, (_, i) => `apps/web/f${i}.ts`);
    const body = report({ blocking: many });
    expect(body).toContain("…and 15 more");
  });

  it("tells the reader not to widen a glob to silence it", () => {
    expect(report({ blocking: ["x.ts"] })).toContain("rather than widening a glob");
  });
});

describe("exempt is surfaced even on a pass", () => {
  it("is disclosed, because it is the case where nothing was checked", () => {
    const body = report({ exempt: ["apps/web", "packages/db"] });
    expect(body).toContain("2 governed file(s) exempt");
    expect(body).toContain("gitlinks and deletions");
  });

  it("is omitted when there are none, rather than showing an empty block", () => {
    expect(report({ mapped: ["a.ts"] })).not.toContain("exempt —");
  });
});

describe("the mermaid pie", () => {
  it("is omitted entirely when every bucket is zero", () => {
    // An empty pie renders as an error block in GitHub's mermaid, so a PR that
    // changed nothing governed would carry a broken image that reads as a
    // tooling fault rather than as a clean run.
    expect(report({})).not.toContain("```mermaid");
  });

  it("includes only the non-zero slices", () => {
    const body = report({ mapped: ["a.ts"], outOfScope: ["b.md"] });
    expect(body).toContain('"Mapped" : 1');
    expect(body).toContain('"Out of scope" : 1');
    expect(body).not.toContain('"Exempt"');
  });
});

describe("the truncation warning", () => {
  it("is shown when the API ceiling may have hidden files", () => {
    const body = report({ mapped: ["a.ts"] }, { atApiCeiling: true });
    expect(body).toContain("3000-file ceiling");
  });

  it("is absent on an ordinary pull request", () => {
    expect(report({ mapped: ["a.ts"] })).not.toContain("3000-file ceiling");
  });
});

describe("the marker", () => {
  it("is present, so a re-run updates instead of adding another comment", () => {
    expect(report({})).toContain(COMMENT_MARKER);
  });

  it("is the SAME marker the inline gate used", () => {
    // A repository adopting the action mid-stream would otherwise grow a second
    // comment beside the old one, with the stale verdict still readable.
    expect(COMMENT_MARKER).toBe("<!-- feature-mapping-comment -->");
  });
});

/** A `fetch` double that records calls and returns scripted responses. */
function scriptedFetch(responses: Array<{ ok: boolean; status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return { ok: next.ok, status: next.status, json: async () => next.body ?? [] } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const upsertBase = { token: "t", owner: "o", repo: "r", issue: 5, body: "hello" };

describe("upsertComment", () => {
  it("updates the existing comment rather than adding another", () => {
    const { impl, calls } = scriptedFetch([
      { ok: true, status: 200, body: [{ id: 99, body: `old ${COMMENT_MARKER}` }] },
      { ok: true, status: 200 },
    ]);
    return upsertComment({ ...upsertBase, fetchImpl: impl }).then((result) => {
      expect(result).toEqual({ status: "updated", id: 99 });
      expect(calls[1]?.method).toBe("PATCH");
      expect(calls[1]?.url).toContain("/issues/comments/99");
    });
  });

  it("creates one when none carries the marker", async () => {
    const { impl, calls } = scriptedFetch([
      { ok: true, status: 200, body: [{ id: 1, body: "someone else's comment" }] },
      { ok: true, status: 201 },
    ]);
    expect(await upsertComment({ ...upsertBase, fetchImpl: impl })).toEqual({ status: "created" });
    expect(calls[1]?.method).toBe("POST");
  });

  it("pages through comments rather than missing ours on page two", async () => {
    // Missing it would create a SECOND comment — the exact thing the marker
    // exists to prevent, and the failure would look like the upsert not working.
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "unrelated" }));
    const { impl, calls } = scriptedFetch([
      { ok: true, status: 200, body: full },
      { ok: true, status: 200, body: [{ id: 500, body: COMMENT_MARKER }] },
      { ok: true, status: 200 },
    ]);
    expect(await upsertComment({ ...upsertBase, fetchImpl: impl })).toEqual({
      status: "updated",
      id: 500,
    });
    expect(calls[1]?.url).toContain("page=2");
  });

  it("SKIPS on a 403 instead of throwing — a fork's token is read-only", async () => {
    // The single most important behaviour here. Failing would redden every fork
    // pull request for a reason unrelated to coverage, and the fix people reach
    // for is switching the gate off.
    const { impl } = scriptedFetch([{ ok: false, status: 403 }]);
    const result = await upsertComment({ ...upsertBase, fetchImpl: impl });
    expect(result.status).toBe("skipped");
    expect(result).toHaveProperty("reason", expect.stringContaining("403") as unknown as string);
  });

  it("skips on a network fault rather than propagating it", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await upsertComment({ ...upsertBase, fetchImpl: impl });
    expect(result.status).toBe("skipped");
  });

  it("never throws, whatever the API does", async () => {
    const impl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(upsertComment({ ...upsertBase, fetchImpl: impl })).resolves.toHaveProperty(
      "status",
      "skipped",
    );
  });
});

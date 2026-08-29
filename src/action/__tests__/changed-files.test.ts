/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Fetching the changed-file list.
 *
 * Every failure here is a SILENT one, which is why it gets its own suite: a
 * truncated list makes the gate pass over files it never read, and that is
 * indistinguishable from a small pull request. The tests below are mostly about
 * refusing to be quietly incomplete.
 */

import { describe, expect, it } from "@jest/globals";

import { API_FILE_CEILING, fetchChangedFiles, pullNumberFrom } from "../changed-files.js";

/** A `fetch` that serves fixed pages and records the URLs it was asked for. */
function pagedFetch(pages: Array<Array<{ filename: string; status?: string }>>) {
  const urls: string[] = [];
  const impl = (async (url: string | URL) => {
    urls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    return {
      ok: true,
      status: 200,
      json: async () => pages[page - 1] ?? [],
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const base = { token: "t", owner: "o", repo: "r", pull: 7 };

describe("fetchChangedFiles", () => {
  it("follows every page rather than stopping at the first", async () => {
    // The default page size is 30 and the cap is 100. A gate that read one page
    // would pass over everything after it, and the pull request would look
    // clean precisely because it was large.
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }));
    const { impl, urls } = pagedFetch([full, [{ filename: "last.ts" }]]);

    const { files } = await fetchChangedFiles({ ...base, fetchImpl: impl });

    expect(files).toHaveLength(101);
    expect(files.at(-1)?.filename).toBe("last.ts");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("per_page=100");
  });

  it("stops on a short page without asking for another", async () => {
    const { impl, urls } = pagedFetch([[{ filename: "a.ts" }]]);
    const { files } = await fetchChangedFiles({ ...base, fetchImpl: impl });
    expect(files).toHaveLength(1);
    expect(urls).toHaveLength(1);
  });

  it("THROWS on a non-OK response instead of returning what it got", async () => {
    // Returning a partial list would let the gate report "0 unmapped" over a
    // set it failed to read. A failed page has to be loud.
    const impl = (async () => ({ ok: false, status: 502, json: async () => [] }) as Response) as unknown as typeof fetch;
    await expect(fetchChangedFiles({ ...base, fetchImpl: impl })).rejects.toThrow(/502/);
  });

  it("reports when the API's own ceiling may have truncated the list", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }));
    const pages = Array.from({ length: API_FILE_CEILING / 100 }, () => page);
    const { impl } = pagedFetch(pages);

    const result = await fetchChangedFiles({ ...base, fetchImpl: impl });

    expect(result.files).toHaveLength(API_FILE_CEILING);
    // The caller warns on this. Silently treating a capped list as the whole
    // truth is the green-over-an-incomplete-set failure in its purest form.
    expect(result.atApiCeiling).toBe(true);
  });

  it("does not claim the ceiling on an ordinary pull request", async () => {
    const { impl } = pagedFetch([[{ filename: "a.ts" }]]);
    expect((await fetchChangedFiles({ ...base, fetchImpl: impl })).atApiCeiling).toBe(false);
  });

  it("sends the token and honours a custom API base", async () => {
    // GITHUB_API_URL differs on GitHub Enterprise, and a hardcoded host would
    // fail there in a way that reads as a permissions problem.
    let seenUrl = "";
    let seenAuth = "";
    const impl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>).authorization);
      return { ok: true, status: 200, json: async () => [] } as Response;
    }) as unknown as typeof fetch;

    await fetchChangedFiles({ ...base, apiUrl: "https://ghe.example/api/v3", fetchImpl: impl });

    expect(seenUrl.startsWith("https://ghe.example/api/v3/repos/o/r/pulls/7/files")).toBe(true);
    expect(seenAuth).toBe("Bearer t");
  });
});

describe("pullNumberFrom", () => {
  it("reads a pull_request payload", () => {
    expect(pullNumberFrom({ pull_request: { number: 42 } })).toBe(42);
  });

  it("reads an issue-shaped payload", () => {
    expect(pullNumberFrom({ number: 42 })).toBe(42);
  });

  it("returns undefined for a push, which is a real answer and not an error", () => {
    expect(pullNumberFrom({ ref: "refs/heads/main" })).toBeUndefined();
    expect(pullNumberFrom(null)).toBeUndefined();
  });

  it("ignores a non-numeric number rather than coercing it", () => {
    expect(pullNumberFrom({ number: "42" })).toBeUndefined();
  });
});

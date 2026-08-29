/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Which files did this pull request change?
 *
 * Uses `fetch` against the REST API directly rather than `@octokit/*`: the
 * action is a committed bundle, and Octokit would add hundreds of kilobytes to
 * a file every consumer clones, for one paginated GET. Node 24 has `fetch`.
 *
 * ## Paging is not optional
 *
 * `pulls/{n}/files` returns 30 per page by default and caps at 100. A large
 * pull request silently truncates, and a truncated list makes the gate PASS —
 * the files it never saw are the ones it never checked. That is this fleet's
 * standing failure shape: a green over a set smaller than you think. So every
 * page is followed, and the caller is told how many were read.
 *
 * The API also caps the file list at 3000 for very large PRs. That is a real
 * ceiling with no workaround from here, so it is DETECTED and reported rather
 * than silently treated as the whole truth.
 */

/** One changed file, reduced to what the decision needs. */
export interface ApiFile {
  filename: string;
  status?: string;
}

export interface FetchResult {
  files: ApiFile[];
  /** True when the API's own 3000-file ceiling may have truncated the list. */
  atApiCeiling: boolean;
}

/** The API's hard cap on files reported for one pull request. */
export const API_FILE_CEILING = 3000;

export interface FetchOptions {
  token: string;
  owner: string;
  repo: string;
  pull: number;
  apiUrl?: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Every changed file in a pull request, following pagination to the end.
 *
 * Throws on a non-OK response rather than returning what it managed to get.
 * A partial list is indistinguishable from a small pull request, and the gate
 * would pass over the difference — so a failed page has to be loud.
 */
export async function fetchChangedFiles({
  token,
  owner,
  repo,
  pull,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}: FetchOptions): Promise<FetchResult> {
  const files: ApiFile[] = [];
  const perPage = 100;

  for (let page = 1; ; page += 1) {
    const url = `${apiUrl}/repos/${owner}/${repo}/pulls/${pull}/files?per_page=${perPage}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "stonedog-featuremap",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} for ${owner}/${repo}#${pull} files (page ${page}). ` +
          `A partial file list would let the gate pass over what it never read, so this is fatal.`,
      );
    }

    const batch = (await response.json()) as ApiFile[];
    files.push(...batch.map((f) => ({ filename: f.filename, status: f.status })));

    // Stop on a short page. Checking the length rather than parsing the Link
    // header keeps this to one concept, and a short page is the same signal.
    if (batch.length < perPage) break;

    // Defensive: the API stops at 3000 regardless of paging, and without this
    // a bug in the loop would spin against a rate limit rather than end.
    if (files.length >= API_FILE_CEILING) break;
  }

  return { files, atApiCeiling: files.length >= API_FILE_CEILING };
}

/**
 * The pull-request number for this run, or undefined when not on a PR.
 *
 * `GITHUB_EVENT_PATH` is the payload the runner wrote. Undefined is a real
 * answer — a `push` run has no pull request — and the caller decides what that
 * means rather than this guessing.
 */
export function pullNumberFrom(payload: unknown): number | undefined {
  const event = payload as { pull_request?: { number?: unknown }; number?: unknown } | null;
  const candidate = event?.pull_request?.number ?? event?.number;
  return typeof candidate === "number" ? candidate : undefined;
}

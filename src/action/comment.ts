/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Posting the report as a single, updated-in-place pull-request comment.
 *
 * ## Why upsert rather than append
 *
 * A gate that comments on every push buries the pull request under near
 * identical blocks, and the reader has to work out which one is current. Worse,
 * the stale ones stay readable: a comment saying "⛔ Failed" sits above the one
 * saying it passed, and nothing marks it as superseded.
 *
 * So: find the comment carrying our marker and edit it. One comment, always
 * current.
 *
 * ## A comment failure must NEVER fail the gate
 *
 * Commenting needs `pull-requests: write`, which a workflow may legitimately
 * not grant -- and a run from a fork gets a read-only token no matter what the
 * workflow says. If a 403 there turned a passing gate red, every fork PR would
 * fail for a reason that has nothing to do with coverage, and the fix people
 * would reach for is switching the gate off.
 *
 * The verdict is the exit code. This is the explanation, and an explanation
 * that could not be delivered is a warning, not a failure.
 */

import { COMMENT_MARKER } from "./report.js";

export interface UpsertOptions {
  token: string;
  owner: string;
  repo: string;
  issue: number;
  body: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export type UpsertResult =
  | { status: "created" }
  | { status: "updated"; id: number }
  | { status: "skipped"; reason: string };

interface ApiComment {
  id: number;
  body?: string;
}

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "stonedog-featuremap",
  };
}

/**
 * Create or update the gate's comment.
 *
 * Never throws: every failure comes back as `skipped` with a reason the caller
 * can log as a warning. See the header for why that is deliberate.
 */
export async function upsertComment({
  token,
  owner,
  repo,
  issue,
  body,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}: UpsertOptions): Promise<UpsertResult> {
  const base = `${apiUrl}/repos/${owner}/${repo}/issues`;

  try {
    // Paged, because a busy pull request can carry more than one page of
    // comments and ours may be on any of them. Missing it would silently
    // create a SECOND comment, which is the exact thing the marker exists to
    // prevent -- and the failure would look like the upsert simply not working.
    let existing: ApiComment | undefined;
    for (let page = 1; ; page += 1) {
      const response = await fetchImpl(`${base}/${issue}/comments?per_page=100&page=${page}`, {
        headers: headers(token),
      });
      if (!response.ok) {
        return { status: "skipped", reason: `listing comments returned ${response.status}` };
      }
      const batch = (await response.json()) as ApiComment[];
      existing = batch.find((comment) => comment.body?.includes(COMMENT_MARKER));
      if (existing || batch.length < 100) break;
    }

    if (existing) {
      const response = await fetchImpl(`${base}/comments/${existing.id}`, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify({ body }),
      });
      return response.ok
        ? { status: "updated", id: existing.id }
        : { status: "skipped", reason: `updating the comment returned ${response.status}` };
    }

    const response = await fetchImpl(`${base}/${issue}/comments`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ body }),
    });
    return response.ok
      ? { status: "created" }
      : { status: "skipped", reason: `creating the comment returned ${response.status}` };
  } catch (error) {
    // A network fault is the same class of problem as a 403: the gate's verdict
    // stands, only its explanation is missing.
    return { status: "skipped", reason: (error as Error).message };
  }
}

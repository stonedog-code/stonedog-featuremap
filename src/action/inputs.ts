/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Reading and resolving the action's inputs.
 *
 * Split from `main.ts` and given no dependency on `@actions/core` so the rules
 * below are unit-testable without a runner. They are the part most likely to be
 * wrong in a way CI cannot show you: an action that resolves a path oddly fails
 * inside somebody else's repository, where the only evidence is a log line.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where a repository may keep its map, in the order they are tried.
 *
 * Taken from the two live gates rather than invented: hopperguard's workflow
 * tries exactly these three, and rozcards uses the second. An action that
 * accepted only `feature-map.json` would silently not find hopperguard's if it
 * ever moved back to the `feature_map/` directory it once used.
 */
export const DEFAULT_CANDIDATES = [
  "feature_map/feature-map.json",
  "feature-map.json",
  "feature-mapping.json",
] as const;

export interface ResolveResult {
  /** The absolute path to the map, or undefined if none of the candidates exist. */
  found?: string;
  /** Every path that was looked at, for the error message when none matched. */
  tried: string[];
}

/**
 * Resolve the map path against a workspace.
 *
 * An explicit `map` input is taken as the ONLY candidate — if a repository
 * names a file, a fallback to a different one is never what it meant, and
 * silently gating a different document than the one you named is worse than
 * failing. The default list is tried only when nothing was specified.
 *
 * Relative paths resolve against `workspace`, never against the process's
 * working directory: a JavaScript action runs with an unspecified cwd, so
 * anything relative to it is a coin flip.
 */
export function resolveMapPath(
  workspace: string,
  mapInput: string | undefined,
  exists: (p: string) => boolean = existsSync,
): ResolveResult {
  const candidates = mapInput?.trim() ? [mapInput.trim()] : [...DEFAULT_CANDIDATES];
  const tried = candidates.map((c) => (path.isAbsolute(c) ? c : path.resolve(workspace, c)));
  return { found: tried.find((p) => exists(p)), tried };
}

/**
 * Parse a comma-or-newline separated input into a list.
 *
 * Both separators are accepted because YAML makes each natural in a different
 * place — `governed-roots: apps/**,packages/**` on one line, or a block scalar
 * with one per line — and a user who picks the wrong one should not get an
 * input silently read as a single item containing a comma.
 *
 * Empty entries are dropped, so a trailing comma or a blank line is harmless.
 */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The handful of GitHub Actions runtime calls this action needs, written out
 * rather than taken from `@actions/core`.
 *
 * ## Why not the official package
 *
 * `@actions/core` transitively pulls in `@actions/http-client` and `tunnel` for
 * OIDC token exchange, which this action never uses. That cost two things:
 *
 * 1. **1.1 MB of bundle, committed to git.** A JavaScript action's bundle is
 *    checked in and cloned by everyone who reads the repository, and ~1 MB of
 *    it would be an HTTP client for a feature we do not call.
 * 2. **It would not run.** This package is `"type": "module"`, so a CJS bundle
 *    is parsed as ESM and dies with `module is not defined`; built as ESM,
 *    `tunnel` does a dynamic `require("net")` that esbuild's ESM output cannot
 *    satisfy. Both were observed, not predicted.
 *
 * What remains is six functions over `process.env` and two files. The bundle
 * drops to a few KB and the ESM/CJS problem disappears with the dependency.
 *
 * ## The two things that are easy to get wrong, both verified
 *
 * Checked against `@actions/core`'s own source rather than assumed, because
 * both are silent when wrong:
 *
 * - **An input's env var keeps its dashes.** `INPUT_${name.replace(/ /g,
 *   "_").toUpperCase()}` -- spaces become underscores, hyphens do NOT. So
 *   `governed-roots` reads from `INPUT_GOVERNED-ROOTS`. Converting dashes would
 *   make every hyphenated input silently empty.
 * - **Outputs are a heredoc with a random delimiter**, not `key=value`. A value
 *   containing a newline would otherwise truncate or inject.
 */

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Read an action input. Empty and absent are the same thing, as in the official client. */
export function getInput(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/**
 * Escape a workflow-command DATA segment.
 *
 * A literal `%`, CR or LF in the message would otherwise end the command early
 * or be swallowed -- so an annotation containing a multi-line schema error
 * would silently lose everything after its first newline.
 */
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Escape a workflow-command PROPERTY value.
 *
 * Stricter than a data segment: `:` and `,` are the command's own separators,
 * so a path containing either would be parsed as another property.
 */
function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function issue(command: string, message: string, props: Record<string, string> = {}): void {
  const entries = Object.entries(props).filter(([, v]) => v !== "");
  const suffix = entries.length
    ? " " + entries.map(([k, v]) => `${k}=${escapeProperty(v)}`).join(",")
    : "";
  process.stdout.write(`::${command}${suffix}::${escapeData(message)}\n`);
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warning(message: string, props: { file?: string } = {}): void {
  issue("warning", message, props.file ? { file: props.file } : {});
}

export function error(message: string, props: { file?: string } = {}): void {
  issue("error", message, props.file ? { file: props.file } : {});
}

/**
 * Fail the step.
 *
 * Sets `process.exitCode` rather than calling `process.exit()`: exiting
 * immediately can truncate buffered stdout, and an annotation that never
 * flushed is a failure with no explanation attached.
 */
export function setFailed(message: string): void {
  error(message);
  process.exitCode = 1;
}

/**
 * Write an output, in the heredoc form the runner expects.
 *
 * The delimiter is random per call, matching `@actions/core`. A fixed one could
 * be terminated early by a value that happened to contain it -- and a value
 * here is derived from a repository's own map, so it is not fully ours.
 */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  // No GITHUB_OUTPUT means this is not running under a runner -- a local
  // invocation or a test. Silently skipping is right: the alternative is that
  // every direct run of the bundle crashes on its last line.
  if (!file) return;

  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (name.includes(delimiter) || value.includes(delimiter)) {
    throw new Error(`Refusing to write output "${name}": the value contains the delimiter.`);
  }
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

/** Exported for the tests, which assert the escaping rather than trusting it. */
export const __testing = { escapeData, escapeProperty };
